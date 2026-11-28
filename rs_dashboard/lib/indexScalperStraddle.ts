// Straddle book and exit rules for /index-scalper's Straddle pane. Pure: no React, no fetch, no storage access.
// Tested in indexScalperStraddle.test.ts.
//
// A straddle is one CE + PE pair of the same strike and side, sold or bought together from the Straddle pane. It is
// built on Triple Straddle's ledger type (`TsPosition`, lib/tripleStraddle.ts) so its P&L, fill re-pricing
// (`settleLegPrice`) and target / stop / Trail SL / Lock / Lock & trail (`evaluateRisk`) are the same tested code.
// This module adds only what the Index Scalper's straddle has on top: levels in rupees, exit on a CANDLE CLOSE beyond
// the straddle's VWAP, stop to cost, a time exit, and exit sizing off the straddle's own quantity.
//
// Ownership: the straddle owns the quantity IT opened (the ledger), never the broker's net. A Quick Trade leg on the
// same strike is a separate position: an exit here is clamped by the broker book and never closes more than this
// straddle's own legs (skill dhan-terminal-position-ownership).

import { activeFloorPct, evaluateRisk, nextPeakPct, straddlePnl, straddlePnlPct, type TsLeg, type TsPosition, type TsTrail } from './tripleStraddle.ts';
import { istMinuteOfDay } from './istTime.ts';
import { sessionVwap, type Bar } from './indexScalperIndicators.ts';
import { emaSmaSeeded } from './indicators.ts';

export const STRADDLE_STORE_KEY = 'indexScalper.straddles.v1';

export type StraddleExitReason = 'SL' | 'TARGET' | 'TRAIL' | 'LOCK' | 'COST' | 'VWAP' | 'EMA' | 'TIME' | 'MANUAL';

export interface StraddleRules {
  /** % of the entry combined premium (Triple Straddle's basis). 0 / absent = off. */
  targetPct?: number;
  slPct?: number;
  /** Rupees on the whole straddle. With both a % and a rupee level, the nearer one applies. */
  targetRs?: number;
  slRs?: number;
  trail?: TsTrail;
  /** Exit when a FINISHED candle of the pane closes beyond the straddle's session VWAP by `bufferPts` (premium points):
   *  above it for a short straddle, below it for a long one. A live tick past VWAP never fires it. */
  vwap: { on: boolean; bufferPts: number };
  /** Same, against an EMA of the straddle's closes (TradingView ta.ema, `len` bars). VWAP and EMA are switched on
   *  separately: with both on, each is its own exit and the first line a finished candle closes beyond exits. */
  ema: { on: boolean; len: number; bufferPts: number };
  /** Once peak profit reached `triggerPct`, the stop moves to cost: exit if P&L falls back to 0. */
  slToCost: { on: boolean; triggerPct: number };
  /** Square off at this IST time, 'HH:MM'. */
  timeExit: { on: boolean; hhmm: string };
}

export const DEFAULT_STRADDLE_RULES: StraddleRules = {
  targetPct: 30, slPct: 20,
  vwap: { on: true, bufferPts: 0 },
  ema: { on: false, len: 20, bufferPts: 0 },
  slToCost: { on: false, triggerPct: 15 },
  timeExit: { on: true, hhmm: '15:17' },
};

export interface IsxStraddle extends TsPosition {
  /** Rules this straddle runs (copied from the controls at entry, editable while open). */
  rules: StraddleRules;
  /** IST day (YYYY-MM-DD) it was opened: the store keeps today's only. */
  day: string;
  /** An exit was decided / sent: no rule fires again (fire once). Cleared only if the exit was refused. */
  exiting?: boolean;
  /** Last rule exit that was refused, for the panel. */
  lastError?: string;
  /** Why it closed: a rule, a manual exit, or FORGOTTEN (dropped from the ledger with no order, e.g. squared off
   *  elsewhere). */
  closeReason?: StraddleExitReason | 'FORGOTTEN';
}

/** Combined entry premium in rupees (entry x qty over the legs that exist). */
export function entryBasisRs(p: Pick<TsPosition, 'legs'>): number {
  return p.legs.reduce((s, l) => s + l.entry * l.qty, 0);
}

/** The leg state that needs the user: one leg open and the other failed / not confirmed. */
export type StraddleHealth = 'OK' | 'ONE_LEG' | 'PENDING';
export function straddleHealth(p: IsxStraddle): StraddleHealth {
  if (p.status !== 'OPEN') return 'OK';
  const failed = (l: TsLeg) => l.qty === 0;
  if (p.legs.some(l => l.unconfirmed)) return 'PENDING';
  if (p.legs.some(failed) || p.legs.some(l => l.closed) !== p.legs.every(l => l.closed)) return 'ONE_LEG';
  return 'OK';
}

/** The % levels actually in force: a rupee level becomes a % of this straddle's entry premium, and the nearer of the
 *  two wins (a smaller number is nearer for both a target and a stop). */
export function effectiveLevels(p: IsxStraddle): { targetPct?: number; slPct?: number } {
  const basis = entryBasisRs(p);
  const pick = (pct: number | undefined, rs: number | undefined): number | undefined => {
    const a = pct != null && pct > 0 ? pct : undefined;
    const b = rs != null && rs > 0 && basis > 0 ? (rs / basis) * 100 : undefined;
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(a, b);
  };
  return { targetPct: pick(p.rules.targetPct, p.rules.targetRs), slPct: pick(p.rules.slPct, p.rules.slRs) };
}

/** Rupee P&L and % of entry premium; null while either open leg has no usable price (never one leg alone). */
export function straddleMtm(p: IsxStraddle, ltp: { CE?: number; PE?: number }): { pnlRs: number; pnlPct: number } | null {
  const rs = straddlePnl(p, ltp);
  const pct = straddlePnlPct(p, ltp);
  return rs == null || pct == null ? null : { pnlRs: rs, pnlPct: pct };
}

/** The stop currently in force as a P&L % (for the panel and the chart's floor line); null when there is none. */
export function currentFloor(p: IsxStraddle): { kind: 'SL' | 'TRAIL' | 'LOCK' | 'COST'; floorPct: number } | null {
  const lv = effectiveLevels(p);
  const peak = p.peakPct ?? 0;
  const f = activeFloorPct({ armed: true, trail: p.rules.trail, slPct: lv.slPct }, peak);
  const cost = p.rules.slToCost.on && p.rules.slToCost.triggerPct > 0 && peak >= p.rules.slToCost.triggerPct;
  if (cost && (!f || f.floor < 0)) return { kind: 'COST', floorPct: 0 };
  return f ? { kind: f.kind, floorPct: f.floor } : null;
}

/** Straddle premium (CE + PE per unit) at which the P&L is `pnlPct` %: for the chart's levels. Short loses as it rises. */
export function premiumAtPct(p: IsxStraddle, pnlPct: number): number | null {
  const qtyCe = p.legs[0].qty, qtyPe = p.legs[1].qty;
  if (!(qtyCe > 0) || qtyCe !== qtyPe) return null; // a lopsided pair has no single premium level
  const entry = p.legs[0].entry + p.legs[1].entry;
  const move = (entry * pnlPct) / 100;
  return p.side === 'S' ? entry - move : entry + move;
}

function hhmmMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

export interface StraddleTickInput {
  ltp: { CE?: number; PE?: number };
  nowMs: number;
  /** Either leg's price is stale, or the market is closed: price rules pause (the time exit still fires). */
  stale: boolean;
  /** The pane's last FINISHED candle (its end time and close) and the straddle VWAP at that candle. */
  closedBar?: { endMs: number; close: number } | null;
  vwapAtClosed?: number | null;
  emaAtClosed?: number | null;
}

export interface StraddleDecision {
  reason: StraddleExitReason | null;
  /** The peak to persist (null while unpriced: keep the old one). */
  peakPct: number | null;
}

/** One look at an open straddle. Fires at most one reason; a straddle already exiting, closed, or with a leg that is
 *  not open and confirmed (ONE_LEG / PENDING) never fires: a half straddle needs the user, not an automatic exit. */
export function evaluateStraddle(p: IsxStraddle, inp: StraddleTickInput): StraddleDecision {
  const none: StraddleDecision = { reason: null, peakPct: null };
  if (p.status !== 'OPEN' || p.exiting || straddleHealth(p) !== 'OK') return none;
  const t = p.rules.timeExit;
  const at = t.on ? hhmmMinutes(t.hhmm) : null;
  if (at !== null && istMinuteOfDay(inp.nowMs) >= at) return { reason: 'TIME', peakPct: null };
  if (inp.stale) return none;
  const peak = nextPeakPct(p, inp.ltp);
  const pct = straddlePnlPct(p, inp.ltp);
  if (peak == null || pct == null) return none;
  const lv = effectiveLevels(p);
  const risk = evaluateRisk({ ...p, risk: { armed: true, trail: p.rules.trail, targetPct: lv.targetPct, slPct: lv.slPct } }, inp.ltp);
  if (risk) return { reason: risk, peakPct: peak };
  const c = p.rules.slToCost;
  if (c.on && c.triggerPct > 0 && peak >= c.triggerPct && pct <= 1e-6) return { reason: 'COST', peakPct: peak };
  // Line rules: only a candle that closed after the straddle was opened (the bar it was entered on may have closed
  // beyond the line before the entry, which is not a signal against this position). Short: close above the line +
  // buffer; long: below it - buffer. VWAP and EMA are independent: whichever is on and crossed exits.
  const bar = inp.closedBar;
  const beyond = (line: number | null | undefined, bufferPts: number) => {
    if (!bar || line == null || !Number.isFinite(line) || !(bar.endMs > p.openedAt)) return false;
    const buf = Math.max(0, bufferPts || 0);
    return p.side === 'S' ? bar.close > line + buf : bar.close < line - buf;
  };
  if (p.rules.vwap.on && beyond(inp.vwapAtClosed, p.rules.vwap.bufferPts)) return { reason: 'VWAP', peakPct: peak };
  const e = p.rules.ema;
  if (e?.on && beyond(inp.emaAtClosed, e.bufferPts)) return { reason: 'EMA', peakPct: peak };
  return { reason: null, peakPct: peak };
}

/** Quantity to close on one leg: this straddle's own open quantity, clamped by what the broker still shows in the
 *  closing direction (a short leg needs a negative broker net). Never the raw broker net: a sibling position on the
 *  same strike is not this straddle's to close. Broker net and own quantity in the same unit. */
export function exitQtyFor(own: number, side: 'B' | 'S', brokerNet: number): number {
  if (!(own > 0)) return 0;
  const there = side === 'S' ? Math.max(0, -brokerNet) : Math.max(0, brokerNet);
  return Math.min(own, there);
}

/** Today's straddles from storage; another day's and malformed records are dropped. */
/** Rules saved before a field existed get its default (records from before the EMA rule have no `ema`). */
export function withRuleDefaults(r: Partial<StraddleRules>): StraddleRules {
  return { ...DEFAULT_STRADDLE_RULES, ...r, ema: { ...DEFAULT_STRADDLE_RULES.ema, ...(r.ema ?? {}), ...(r.ema ? {} : { on: false }) } };
}

export function parseStraddleStore(raw: string | null, today: string): IsxStraddle[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is IsxStraddle => {
    const s = x as Partial<IsxStraddle> | null;
    return !!s && s.day === today && typeof s.id === 'string' && Array.isArray(s.legs) && s.legs.length === 2
      && (s.side === 'S' || s.side === 'B') && (s.mode === 'SIM' || s.mode === 'REAL') && typeof s.strike === 'number'
      && !!s.rules && typeof s.rules === 'object';
  }).map(b => ({ ...b, rules: withRuleDefaults(b.rules) }));
}

export function serializeStraddleStore(books: IsxStraddle[]): string {
  return JSON.stringify(books);
}

/** Validate the controls' rules before they are saved (a free-typed value commits on blur; a bad one is refused). */
export function rulesError(r: StraddleRules): string | null {
  const neg = (n: number | undefined) => n != null && (!Number.isFinite(n) || n < 0);
  if (neg(r.targetPct) || neg(r.slPct) || neg(r.targetRs) || neg(r.slRs)) return 'Levels must be 0 or more';
  if (r.slPct != null && r.slPct >= 1000) return 'Stop % is too large';
  if (neg(r.vwap.bufferPts)) return 'VWAP buffer must be 0 or more';
  if (r.ema && (neg(r.ema.bufferPts) || !Number.isInteger(r.ema.len) || r.ema.len < 2 || r.ema.len > 200)) return 'EMA length must be a whole number from 2 to 200, buffer 0 or more';
  if (r.slToCost.on && !(r.slToCost.triggerPct > 0)) return 'SL to cost needs a trigger above 0%';
  if (r.timeExit.on && hhmmMinutes(r.timeExit.hhmm) === null) return 'Time exit must be HH:MM';
  const t = r.trail;
  if (t?.kind === 'trailSl' && (!(t.every! > 0) || !(t.by! > 0) || t.by! > t.every!)) return 'Trail SL: "by" must be above 0 and not more than "every"';
  if ((t?.kind === 'lock' || t?.kind === 'lockTrail') && (!(t.reach! > 0) || (t.lock ?? 0) >= t.reach!)) return 'Lock: reach must be above the locked profit';
  return null;
}

/** The last FINISHED candle (its end time and close) with the session VWAP and the EMA (`emaLen` bars of closes,
 *  TradingView ta.ema like the chart's EMA indicator; null before enough bars) at it. `lastClosed`: the newest bar's
 *  interval has ended (lastBarClosed); otherwise the newest bar is still forming and the one before it is used. */
export function lastClosedVwap(bars: Bar[], intervalMin: number, lastClosed: boolean, emaLen = 20): { endMs: number; close: number; vwap: number | null; ema: number | null } | null {
  const i = lastClosed ? bars.length - 1 : bars.length - 2;
  if (i < 0) return null;
  const vw = sessionVwap(bars)[i];
  const em = emaSmaSeeded(bars.slice(0, i + 1).map(b => b.c), emaLen)[i];
  return { endMs: (bars[i].t + intervalMin * 60) * 1000, close: bars[i].c, vwap: vw ?? null, ema: em ?? null };
}
