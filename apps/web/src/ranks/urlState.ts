// URL state for /ranks (spec 022, Phase 2). Every control writes here, so
// whatever a member is looking at can be copied as a link, and a link from a
// group post opens on exactly that view. Bad values fall back to defaults.
import type { CanonicalWindow } from "@brokerforce/types";

export interface RanksView {
  w: CanonicalWindow;
  /** BASE-QUOTE, or null for all pairs. */
  pair: string | null;
  range: "30" | "90" | "all";
  /** Run date YYYY-MM-DD, or null for latest. */
  asOf: string | null;
  avg: boolean;
  ext: boolean;
  price: boolean;
}

export const DEFAULT_VIEW: RanksView = { w: 30, pair: null, range: "90", asOf: null, avg: true, ext: true, price: true };

function validDate(s: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

export function readView(params: URLSearchParams): RanksView {
  const w = Number(params.get("w"));
  const pairRaw = params.get("pair") ?? "";
  const pairMatch = /^([A-Za-z0-9]{2,10})-([A-Za-z0-9]{2,10})$/.exec(pairRaw);
  const range = params.get("range");
  const flag = (k: string, d: boolean) => (params.get(k) === "0" ? false : params.get(k) === "1" ? true : d);
  return {
    w: w === 90 || w === 200 ? w : 30,
    pair: pairMatch ? `${pairMatch[1]!.toUpperCase()}-${pairMatch[2]!.toUpperCase()}` : null,
    range: range === "30" || range === "all" ? range : "90",
    asOf: validDate(params.get("asOf")),
    avg: flag("avg", DEFAULT_VIEW.avg),
    ext: flag("ext", DEFAULT_VIEW.ext),
    price: flag("price", DEFAULT_VIEW.price),
  };
}

/** Full, explicit query string -- every setting is written, so a copied link
 * reproduces the view even if defaults change later. */
export function writeView(v: RanksView): URLSearchParams {
  const p = new URLSearchParams();
  p.set("w", String(v.w));
  if (v.pair) p.set("pair", v.pair);
  p.set("range", v.range);
  if (v.asOf) p.set("asOf", v.asOf);
  p.set("avg", v.avg ? "1" : "0");
  p.set("ext", v.ext ? "1" : "0");
  p.set("price", v.price ? "1" : "0");
  return p;
}

/** "2026-11-06" -> "Nov 6". */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
