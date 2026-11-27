// Default target / stop loss for a NEW option position opened from /index-scalper (owner's request 2026-11-26: target
// 30 %, stop 20 % of the entry premium, switchable off). Pure: no React. The terminal records a pending default when one
// of its MARKET orders opens an option position from flat (or flips it), then, once the broker / paper book shows that
// leg with an average price and a live premium, places the levels through its normal onSetBracket path (REAL: LIMIT
// target + SL-M stop on that contract; SIM: paper levels). Each pending default is used at most once.

import { parseBracketInput, premiumBracketError, snapAway } from './indexScalperPremiumBrackets.ts';

/** How a default level is measured from the entry premium: a % of it, or premium points (owner's request 2026-11-27:
 *  points like the TSL, chosen per side). */
export type BracketUnit = 'pct' | 'pts';
export interface DefaultBracketSettings {
  on: boolean; tpPct: number; slPct: number;
  tpUnit: BracketUnit; slUnit: BracketUnit; tpPts: number; slPts: number;
}

export const DEFAULT_BRACKETS_KEY = 'indexScalper.defaultBrackets.v1';
export const DEFAULT_BRACKETS: DefaultBracketSettings = { on: true, tpPct: 30, slPct: 20, tpUnit: 'pct', slUnit: 'pct', tpPts: 20, slPts: 10 };
/** Largest premium-point distance accepted (a typo guard: no index option here is priced near 5,000). */
export const MAX_BRACKET_PTS = 5000;
/** Choices offered in the settings (a select, never a free-typed box: dhan-commit-on-blur). */
export const TP_PCT_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100] as const;
// Up to 100 % (owner's request 2026-11-27). A sell's 100 % stop is 2x entry; a buy's would be a premium of 0, which
// parseBracketInput refuses, so that buy gets no stop and the skip is reported.
export const SL_PCT_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90, 100] as const;
/** A pending default waits this long for its leg to show in the book (a market fill shows within a few polls). */
export const PENDING_TTL_MS = 30_000;

const pick = (v: unknown, allowed: readonly number[], d: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && allowed.includes(n) ? n : d;
};

const unit = (v: unknown, d: BracketUnit): BracketUnit => (v === 'pct' || v === 'pts' ? v : d);
const pts = (v: unknown, d: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_BRACKET_PTS ? Number(n.toFixed(2)) : d;
};

const PTS_DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;
/** A typed point distance (committed on blur / Enter only): a plain decimal above 0, up to MAX_BRACKET_PTS. */
export function parseBracketPoints(text: string): { pts: number; error: null } | { pts: null; error: string } {
  const t = text.trim();
  if (!PTS_DECIMAL.test(t)) return { pts: null, error: 'Enter points, like 15 or 7.5' };
  const n = Number(t);
  if (!(n > 0)) return { pts: null, error: 'Points must be above 0' };
  if (n > MAX_BRACKET_PTS) return { pts: null, error: `At most ${MAX_BRACKET_PTS} points` };
  return { pts: Number(n.toFixed(2)), error: null };
}

/** Chip / tooltip text of one side: "30%" or "15 pts". */
export function bracketLabel(s: DefaultBracketSettings, kind: 'TP' | 'SL'): string {
  return kind === 'TP'
    ? (s.tpUnit === 'pts' ? `${s.tpPts} pts` : `${s.tpPct}%`)
    : (s.slUnit === 'pts' ? `${s.slPts} pts` : `${s.slPct}%`);
}

/** Saved settings, or the defaults for anything missing or not one of the offered choices. */
export function clampDefaultBrackets(x: unknown): DefaultBracketSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<Record<keyof DefaultBracketSettings, unknown>>;
  return {
    on: typeof o.on === 'boolean' ? o.on : DEFAULT_BRACKETS.on,
    tpPct: pick(o.tpPct, TP_PCT_OPTIONS, DEFAULT_BRACKETS.tpPct),
    slPct: pick(o.slPct, SL_PCT_OPTIONS, DEFAULT_BRACKETS.slPct),
    tpUnit: unit(o.tpUnit, DEFAULT_BRACKETS.tpUnit),
    slUnit: unit(o.slUnit, DEFAULT_BRACKETS.slUnit),
    tpPts: pts(o.tpPts, DEFAULT_BRACKETS.tpPts),
    slPts: pts(o.slPts, DEFAULT_BRACKETS.slPts),
  };
}

/**
 * Recorded when this page's market order opens an option position: the leg key, the side and product it should end up
 * on, the ENTRY the levels are measured from, and the signed quantity the leg should reach once the order has filled.
 * `entry` is the order's own price (the live premium it was sent at; a paper fill's price), never the broker's day
 * average: Dhan / Kotak `buyAvg` / `sellAvg` blend every fill on the contract today, so after a round trip at 150 / 160
 * a new buy at 210 reads 180 and the levels came out at +11 % / -31 % of the real entry (code review 2026-11-26).
 * `expectQty` is in the leg's own unit (broker netQty; paper units); `product` '' matches any (paper legs have none).
 */
export interface PendingDefault {
  legKey: string; long: boolean; at: number; tpPct: number; slPct: number;
  entry: number; product: string; expectQty: number;
  /** Absent = 'pct' (a pending queued before points existed). */
  tpUnit?: BracketUnit; slUnit?: BracketUnit; tpPts?: number; slPts?: number;
}

export interface LegView { netQty: number; avg: number; ltp: number | null; product?: string }

export type DefaultPlan =
  | { kind: 'wait' }
  /** `warn`: the position was left without the default levels it was promised (say so loudly). */
  | { kind: 'drop'; reason: string; warn: boolean }
  | { kind: 'place'; tp: number | null; sl: number | null; skipped: string[] };

/** The leg a pending default belongs to: same key, product (when the pending names one) and side, never a flat row. */
export function pendingLeg<L extends LegView & { securityId: string }>(p: PendingDefault, legs: readonly L[]): L | null {
  return legs.find(l => l.securityId === p.legKey && l.netQty !== 0 && (l.netQty > 0) === p.long
    && (!p.product || !l.product || l.product === p.product)) ?? null;
}

/**
 * Whether an order should queue a default: a market opening order on an option that opens from flat or flips through
 * zero. `before` and `orderQty` are in the leg's own unit; a same-side order adds lots and a smaller opposite order only
 * reduces, neither gets defaults.
 */
export function opensPosition(before: number, long: boolean, orderQty: number): boolean {
  if (before === 0) return true;
  if ((before > 0) === long) return false;
  return Math.abs(orderQty) > Math.abs(before);
}

/**
 * What to do with one pending default now. `leg` is the leg in the book (null = not there yet); `has` says whether the
 * leg already has a target / stop (any placer's order, or a paper level). Waits for the leg to appear on the expected
 * side with an average and a live premium; gives up after PENDING_TTL_MS. A level already on the wrong side of the
 * live premium (it would fill or trigger at once) is skipped with its reason, as the chip's own editor would refuse it.
 */
export function defaultBracketPlan(p: PendingDefault, leg: LegView | null, has: { tp: boolean; sl: boolean }, tick: number, now: number): DefaultPlan {
  if (now - p.at > PENDING_TTL_MS) {
    return { kind: 'drop', warn: true, reason: leg ? 'the order had not filled in full within 30 s' : 'the position did not show within 30 s' };
  }
  if (!leg || leg.netQty === 0 || (leg.netQty > 0) !== p.long || leg.ltp === null || !(leg.ltp > 0)) return { kind: 'wait' };
  // Partly filled: levels sized now would cover only the filled part, and the rest would never get any.
  if (Math.abs(leg.netQty) < Math.abs(p.expectQty)) return { kind: 'wait' };
  const entry = p.entry > 0 ? p.entry : leg.avg;
  if (!(entry > 0)) return { kind: 'wait' }; // no entry yet (the book's average not in): the TTL warns if it never comes
  if (has.tp && has.sl) return { kind: 'drop', warn: false, reason: 'it already has a target and a stop' };
  const skipped: string[] = [];
  const level = (kind: 'TP' | 'SL', pct: number, u: BracketUnit | undefined, points: number | undefined): number | null => {
    const r = u === 'pts' ? pointsLevel(kind, p.long, entry, points ?? 0, tick) : parseBracketInput(`${pct}%`, kind, p.long, entry, tick);
    if (r.error || r.price === null) { skipped.push(`${kind}: ${r.error ?? 'no level'}`); return null; }
    const err = premiumBracketError(kind, r.price, p.long, leg.ltp, tick);
    if (err) { skipped.push(`${kind} ${r.price.toFixed(2)}: ${err}`); return null; }
    return r.price;
  };
  const tp = has.tp ? null : level('TP', p.tpPct, p.tpUnit, p.tpPts);
  const sl = has.sl ? null : level('SL', p.slPct, p.slUnit, p.slPts);
  return { kind: 'place', tp, sl, skipped };
}

/**
 * A level `pts` premium points from `entry`: a buy's target above / stop below, a sell's the other way, snapped to the
 * tick AWAY from entry (a level never lands closer than asked). A stop at or below a premium of 0 is refused.
 */
export function pointsLevel(kind: 'TP' | 'SL', isLong: boolean, entry: number, pts: number, tick: number): { price: number | null; error: string | null } {
  if (!(pts > 0)) return { price: null, error: 'Points must be above 0' };
  if (!(entry > 0)) return { price: null, error: 'No entry premium' };
  const up = (kind === 'TP') === isLong;
  if (!up && pts >= entry) return { price: null, error: `${pts} pts below an entry of ${entry.toFixed(2)} is a premium of 0 or less` };
  const price = snapAway(entry + (up ? pts : -pts), tick, up);
  if (!(price > 0)) return { price: null, error: 'That distance leaves no premium' };
  return { price, error: null };
}
