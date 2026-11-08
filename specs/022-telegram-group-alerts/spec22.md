# 022 — Telegram Group Alerts + Member-Gated Terminal

> **Status: Drafted 2026-11-06.** After each daily pipeline run, a bot posts the
> day's ORT print to a private Telegram group. Each post deep-links into the
> BrokerForce terminal, opened on exactly the view the post describes. From
> there, a member can change the window, pair or date range. The terminal is
> gated: you sign in with Telegram, and the server checks that you're a current
> member of the group before it serves any data.
>
> **This changes an approved decision.** `docs/Architecture.md` §5 says
> "local storage only, for now", with no account-based auth. This spec adds an
> **access gate**, not user accounts. See "Change to Architecture.md §5" below.

## Purpose
Let a private group follow the daily ORT read without anyone having to visit
the terminal on their own. The alert brings people in, and the terminal is where
they look closer. Access to the terminal goes with group membership: joining
the group gives you access, and leaving it takes access away.

## User stories
- As a group member, I see the day's print in the group (the top pairs, what
  moved, and one link) without having to open the terminal.
- As a member, I tap the link and the terminal opens on the same window, pair,
  range and run date the post quoted. I then change the settings without losing
  the view I came from.
- As a member, I paste my own view back into the group, and others open exactly
  what I saw.
- As someone who isn't a member, or who has left the group, I can't see the data,
  and I'm told how to get access.
- As the operator, a duplicate pipeline run (the GitHub schedule and the
  Supabase watchdog on the same day) never posts the same print twice.

## What exists
- **No hosting.** The terminal (`apps/web` with `apps/api`) isn't deployed: the
  Vercel team **Timbswap** has no projects (checked 2026-11-06).
- **No login anywhere.** The API is open (`docs/API.md`: "No authentication
  currently required"), and watchlists live in browser storage (`007`).
- **The rank view exists only as a claude.ai dashboard** (ORT Rank Tracker). It
  can't be the link target because it reads Supabase with each viewer's own
  access, so this spec rebuilds that view inside the terminal.
- **Every past run can be rebuilt.** `ort_score_history` keeps one row per pair
  and window per run, so any day's ranking can be reconstructed. That's what
  makes a link pinned to the post's run date possible.

## Change to Architecture.md §5 (proposed)
Add the following. Nothing else in §5 changes.

> **Access gate (spec 022).** The hosted terminal is visible to members of the
> BrokerForce Telegram group only. Sign-in uses Telegram Login, and membership
> is checked against the group through the bot. This is an access gate, not
> accounts: no user records are stored, watchlists and recently-viewed stay in
> browser storage, and wallet-based auth stays deferred as before.

`docs/API.md`: the opening line about authentication changes to say every
endpoint except `/health` and `/auth/*` needs a member session (see the Auth
API below).

## Design

### Phase 0: Hosting
- **One Vercel project in the Timbswap team.** It serves the `apps/web` static
  build plus `apps/api` as one serverless function, with requests to `/api/*`
  routed to the function. `apps/api/src/index.ts` is split into `app.ts`, which
  exports the Express app, and `server.ts`, which calls `listen` for local dev,
  so the same app runs both ways.
- **Run the function close to the database.** The database is in Supabase's
  `us-west-2`, so the function should run in Vercel's Portland region (`pdx1`).
  The pipeline-timeout investigation in #45 showed what cross-country database
  round trips cost.
- **Use Supabase's transaction pooler (port 6543) for `DATABASE_URL`.** Serverless
  functions open many short-lived connections, and the pooler absorbs them. Set
  the `pg` pool's `max` to 1–3 per function instance.
- **Keep every secret in Vercel's environment settings:** `DATABASE_URL`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `SESSION_SECRET`. None go in the
  repo or a chat.

### Phase 1: The gate
**Sign-in:** the Telegram Login Widget on `/login`.

- The bot's domain is set with BotFather `/setdomain` to the terminal's domain.
  The widget only works on that domain.
- The widget returns `id`, `first_name`, `username?`, `photo_url?`,
  `auth_date` and `hash`. The page posts these to `POST /auth/telegram`.

**Server verification** (pure functions in `apps/api/src/auth/`, unit-tested):

1. **The login data is genuine.**
   - Build the `data_check_string`: every field except `hash`, written as
     `key=value`, sorted by key and joined with `\n`.
   - Compute the expected hash as HMAC-SHA256 of that string, keyed with
     `SHA256(bot_token)`, in hex.
   - Compare it with the received `hash` in constant time.
2. **The login is recent.** Reject it if `auth_date` is more than 1 hour old,
   so a captured login can't be replayed later.
3. **The person is a member.** Call `getChatMember(TELEGRAM_GROUP_ID, id)`.
   - `creator`, `administrator` and `member` are allowed.
   - `restricted` is allowed only if `is_member` is true.
   - `left` and `kicked` are refused.
   - The bot must be in the group (as an admin, so the call always works).
4. **Issue a session cookie** called `bf_session`: `HttpOnly`, `Secure`,
   `SameSite=Lax`, valid for 7 days. Its payload is
   `{tgId, name, iat, memberCheckedAt}`, HMAC-signed with `SESSION_SECRET`.
   Nothing is stored on the server, so no user table is needed.

**`requireMember` middleware.** It runs on every route except `/health` and
`/auth/*`.

- It checks the cookie's signature and expiry.
- If `memberCheckedAt` is more than an hour old, it calls `getChatMember`
  again, then refreshes the cookie or clears it and returns 401.
  - So someone who leaves the group loses access within the hour.
  - This also keeps Bot API calls to about one per member per hour, far
    below Telegram's rate limits.
- An in-memory cache for each function instance cuts repeat calls further.

**Auth API:**

| Route | Behaviour |
|---|---|
| `POST /auth/telegram` | Verify the login and membership, then set the cookie. Returns `{name}`, or 403 `{reason: "not_member"}` / 401 `{reason: "invalid"}`. |
| `GET /auth/me` | Returns `{name}`, or 401. |
| `POST /auth/logout` | Clears the cookie. |

**Web:**

- An `AuthGate` wraps every route except `/login`. When there's no session, it
  sends the visitor to `/login?next=<original path + query>`.
  - `next` must be a path on this site, so the login can't redirect anywhere
    else.
- After sign-in, the visitor goes back to `next`, which is how a deep link
  survives the login.
- If a non-member signs in, `/login` explains that the terminal is for members
  of the group and to ask an admin for an invite.

**Local development:** `AUTH_DEV_BYPASS=1` skips the gate on localhost only. If
it's set while `NODE_ENV=production`, the API refuses to start.

### Phase 2: The `/ranks` view, with every setting in the URL
The ORT Rank Tracker rebuilt in the terminal, with the same features: daily
rank dots, the 7-day average, the 14-day trend and its 7-day extension, the
price overlay (see-through layer, right-hand axis), pair search, and the
30/90/200-day window toggle. The page follows the terminal's existing look.

**URL is the state:**
`/ranks?w=30&pair=CRO-SOL&range=90&asOf=2026-11-06&avg=1&ext=1&price=1`

- `w`: the ORT window, 30, 90 or 200.
- `pair`: `BASE-QUOTE`, or left out for all pairs.
- `range`: 30, 90 or `all`.
- `asOf`: the run date, `YYYY-MM-DD`. Left out means latest.
- `avg`, `ext`, `price`: overlay switches.

Every control rewrites the URL (`replaceState`), so whatever a member is
looking at can be copied as a link. Bad values fall back to the defaults.
Nothing in the URL reaches SQL as text: values are checked against the allowed
sets above and passed as query parameters.

**Pinned to the post's run.** With `asOf` set, everything is rebuilt from
`ort_score_history` up to the last run on or before that date: the top 10, the
ranks, the averages and the trend. A banner says "Showing the Nov 6 print ·
Jump to latest".

**API** (behind `requireMember`): one route, `GET /ranks?window=&asOf=&pair=&range=`,
returns everything the page draws in a single response: the run's top 10 plus
a searched pair (rank, score, 7-day average, 14-day slope), their daily ranks
with the 7-day average, the trend fit and its 7-day extension (points tagged
`phase: fit` or `extension`), and every pair ranked that day for the search
box. *(Built as one route instead of the four sketched earlier: the page
always needs all of it together, and one ranking pass serves every part.)*
`GET /pairs/:a/:b/history` (already existing) supplies the price overlay.

The ranking comes from `ort_score_history`: each pair's last score of each
day, ranked within the day, with `asOf` as the date
limit, `"window"` and `pair` passed as query parameters, and one change. The
dashboard picks "today's top 10" from `ort_scores`, which holds only the latest
scores, so it can't answer for a past date. Here the top 10 is taken from the
`asOf` day's ranking.

### Phase 3: The alert
**New workspace `apps/notifier`**, with `post-alert.ts`. It gets a root
`package.json` delegate and a step in `ingest-pools-daily.yml` after
`compute-ort`. (A missing root delegate is what failed pipeline run #92.)

**Idempotency.** Migration `017_telegram_alerts.sql` adds a table:

```sql
CREATE TABLE IF NOT EXISTS telegram_alerts (
  as_of DATE NOT NULL,
  "window" SMALLINT NOT NULL CHECK ("window" IN (30, 90, 200)),
  chat_id TEXT NOT NULL,
  message_id BIGINT,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (as_of, "window", chat_id)
);
```

The notifier claims a row with `INSERT … ON CONFLICT DO NOTHING RETURNING`
before it sends anything, so a second run on the same day posts nothing. If
`sendMessage` then fails, the claimed row is deleted, so the next run can try
again.

**The post.** HTML formatting, with one inline button, "Open in terminal",
that opens the deep link. The text is descriptive, carries a disclaimer, and
leaves out the trend extension:

```
BrokerForce · ORT print · 30d · Nov 6
1. ETH/XRP  87.3  held #1 (4 days)
2. BNB/ETH  81.8  ↑ from #6 avg
3. BTC/USDT 81.0  ↓
Biggest climber in the top 10: CRO/SOL (+14.2 places/wk)
Historical analytics, not financial advice.
[Open in terminal] → /ranks?w=30&range=90&asOf=2026-11-06
```

The figures come from the same queries as `/ranks/top`, run as of the same
date, so the post and the page it links to always agree.

**Configuration.** GitHub secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`,
`TERMINAL_URL`.

- `TELEGRAM_THREAD_ID` (optional) posts into an "Alerts" topic if the group
  uses topics.
- `ALERT_DRY_RUN=1` writes the post to the run log instead of sending it.
- Pointing `TELEGRAM_GROUP_ID` at a private test group gives a full rehearsal.
- If any secret is missing, the step skips with a warning and the pipeline
  carries on.

**Cadence.** One post per day for the 30-day window by default. Posting for 90
and 200 days is one setting (`ALERT_WINDOWS=30,90`).

## Non-goals
- User accounts, profiles or server-side watchlists. §5 still defers all of
  that.
- Alerts to individuals, or alerts each member configures themselves.
- Trading signals, entry or exit levels, or forecast wording, per
  `Product_Principles.md` §5.
- Wallet sign-in.

## Acceptance criteria
- [ ] **Phase 0:** the terminal is deployed on Vercel (Timbswap) with the web
      app and an API function in `pdx1`, reached through `/api/*`, with
      `DATABASE_URL` going through the Supabase pooler. `/api/health` answers
      200.
- [ ] **Login is verified.** Hash verification is unit-tested with a test
      vector generated from a throwaway bot token, plus a tampered field, a reordered field and a
      stale `auth_date`. The membership check maps every `getChatMember`
      status correctly (`restricted` with `is_member` true or false included).
- [ ] **The gate holds.**
  - With no cookie, every data route returns 401, and `/health` and `/auth/*`
    still answer.
  - A forged or expired cookie is refused.
  - A member who leaves the group loses access within an hour.
  - `AUTH_DEV_BYPASS` is refused when `NODE_ENV=production`.
- [ ] **Deep links survive sign-in.** A deep link opened while signed out goes
      to `/login` and comes back to the same URL afterwards. Login can't
      redirect off-site.
- [ ] **`/ranks` matches the dashboard.** On today's data its numbers match the
      ORT Rank Tracker's. Every control updates the URL, and reopening that URL
      restores the same view. An invalid URL value falls back to the default.
- [ ] **`asOf` reproduces a past print.** `asOf=2026-11-06` returns the top 10,
      ranks and trend as they stood after that day's run. On later dates the
      page shows the "Jump to latest" banner.
- [ ] **The alert is safe to run twice.**
  - Two pipeline runs on the same day post once.
  - A failed send leaves no claimed row behind, so the next run retries.
  - Dry-run mode writes to the log only.
  - A missing secret skips the step without failing the pipeline.
- [ ] **The post and the page agree.** The post's numbers match `/ranks/top`
      for the same `asOf`, and every post carries the disclaimer line.
- [ ] Typecheck, lint, build and the full test suite pass. A scratch-Postgres
      check covers migration 017 and the `asOf` queries.

## Verification
- **Unit tests:**
  - login hash verification, using a vector generated from a throwaway bot
    token;
  - cookie signing and checking, including expiry;
  - the membership status mapping;
  - building and parsing deep links;
  - the alert's claim and release logic.
- **Scratch Postgres:** seed `ort_score_history` across several days, then
  check that `/ranks/*` with and without `asOf` match a hand-computed ranking.
- **Live, in order:**
  1. deploy;
  2. sign in as a member of the private test group;
  3. confirm a non-member is refused;
  4. run the pipeline with `ALERT_DRY_RUN=1`, then once against the test group;
  5. open the posted link and check that it lands on the matching view;
  6. only then switch to the real group.

## Decisions for the person
1. **Bot and group.** Create the bot with BotFather and make it an admin of the
   group. Put its token and the group's ID straight into Vercel and GitHub
   secrets, never into a chat.
2. **Terminal domain.** A Vercel subdomain, or your own. The Login Widget is
   tied to whichever domain is set with `/setdomain`.
3. **Which windows get posted.** 30 days only by default.
4. **Session length.** 7 days by default.

## Future enhancements
- **Telegram Mini App.** A `t.me/<bot>/<app>?startapp=<view>` link would open
  the terminal inside Telegram, already signed in through Telegram's own signed
  launch data. That would remove the browser login step. In groups this has to
  be a plain link: Telegram allows the Mini App button type only in private
  chats.
- **A `/rank <pair>` command in the group** that replies with that pair's
  current print and a deep link.
- **Instant revocation.** Removing a member's access the moment they leave,
  using Telegram's membership-change updates through a webhook, instead of the
  hourly check.
