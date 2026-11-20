// "How long ago" for the Recently viewed list. The list re-reads current
// scores on every render (no snapshots), so the age tells you how long it has
// been since you last looked at a pair, not how old the score is.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "5m ago", "3h ago", "2d ago", then a date ("Nov 12"). "" for a missing or bad time. */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, now - t);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`;
  const date = new Date(t);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
