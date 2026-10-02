// NIFTYBEES Covered Call desk — pure functions, no React import.
//
// Strategy shape: a long NIFTYBEES holding (the underlying, read from the
// broker's holdings + today's CNC position — never ordered from this page)
// with short NIFTY index calls written against it. The call legs are owned by
// this page's own fill ledger (dhan-terminal-position-ownership): the Dhan
// account also carries NIFTY CE shorts from other strategies, so a broker CE
// short is never treated as "a covered call" unless this page sold it or the
// user explicitly adopted it.
//
// Units: every quantity here is in CONTRACT UNITS (e.g. 65 for one NIFTY lot),
// never lots, so the chain-supplied per-unit Greeks sum straight into
// Nifty-unit exposure (dhan-position-greeks: posSign × units, no lot multiply).

import type { ChainOc, ChainLegData } from './optionsStrategy';
import { lookupChainLegData } from './optionsStrategy.ts';
import { estimatePopAndDelta } from './ultimateScannerEngine.ts';

// ── Ledger ─────────────────────────────────────────────────────────────────

export type CallTradeAction = 'SELL_OPEN' | 'BUY_CLOSE' | 'ADOPT';

export interface CallTrade {
  id: string;
  ts: number;
  action: CallTradeAction;
  strike: number;
  expiry: string;
  /** Contract units (lots × lot size). */
  units: number;
  price: number;
  securityId: string;
  tradingSymbol?: string;
  orderId?: string;
  /** BUY_CLOSE only: the SELL_OPEN/ADOPT row this close draws down. */
  openLegId?: string;
  /** BUY_CLOSE only: (open price − close price) × units. */
  realizedPnl?: number | null;
  note?: string;
  /** Where `price` came from: this order's own fill, the matching trade-book
   *  rows (SYNC/ADOPT), or a price the user typed. Never an LTP guess or the
   *  position's pooled average. Absent on rows written before 2026-10-01. */
  priceSource?: 'fill' | 'tradebook' | 'manual';
  /** Trade-book fills this row consumed, so one fill is never booked twice. */
  tradeKeys?: string[];
}

/**
 * An order this desk placed whose fill is not fully booked yet. Written BEFORE
 * the order goes out (orderId null until Dhan answers), so a second tab sees
 * the reservation, and swept until the order is terminal and every filled
 * unit is in the ledger — a LIMIT that fills an hour later is still booked at
 * its own average price.
 */
export interface PendingOrder {
  id: string;
  orderId: string | null;
  side: 'BUY' | 'SELL';
  securityId: string;
  strike: number;
  expiry: string;
  tradingSymbol: string;
  units: number;
  /** BUY only: the ledger leg this buy-back closes. */
  openLegId?: string;
  note?: string;
  bookedUnits: number;
  /** Σ price × units already booked (to price the next increment). */
  bookedValue: number;
  createdAt: number;
}

export const TERMINAL_ORDER_STATUSES = ['TRADED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

/**
 * The not-yet-booked slice of an order fill. Dhan reports the order's
 * cumulative filled qty and average, so the increment's price is
 * (avg × filled − already booked value) / new units. Null when nothing new
 * filled, or Dhan has no average yet (never book a fill at 0).
 */
export function fillIncrement(
  bookedUnits: number,
  bookedValue: number,
  filled: number,
  avg: number,
): { units: number; price: number } | null {
  const units = filled - bookedUnits;
  if (!(units > 0) || !(avg > 0)) return null;
  const price = (avg * filled - bookedValue) / units;
  return price > 0 ? { units, price } : null;
}

/** Units of `legId` already promised to buy-backs still in flight. */
export function reservedBuyUnits(pending: PendingOrder[], legId: string): number {
  return pending
    .filter((p) => p.side === 'BUY' && p.openLegId === legId)
    .reduce((s, p) => s + Math.max(0, p.units - p.bookedUnits), 0);
}

/** Every order id this desk placed or adopted — trade-book rows with these ids are not "outside" trades. */
export function deskOrderIds(trades: CallTrade[], pending: PendingOrder[]): Set<string> {
  const ids = new Set<string>();
  for (const t of trades) if (t.orderId) ids.add(String(t.orderId));
  for (const p of pending) if (p.orderId) ids.add(String(p.orderId));
  return ids;
}

/** Trade-book fill keys already consumed by a SYNC/ADOPT row. */
export function usedTradeKeys(trades: CallTrade[]): Set<string> {
  return new Set(trades.flatMap((t) => t.tradeKeys ?? []));
}

export interface OpenCall {
  id: string;
  ts: number;
  strike: number;
  expiry: string;
  units: number;
  entryPrice: number;
  securityId: string;
  tradingSymbol: string;
}

/**
 * Replay the ledger into open short-call legs + realized P&L. A BUY_CLOSE draws
 * down only the leg named by `openLegId` (partial closes keep the remainder).
 */
export function reconstructCallLedger(trades: CallTrade[]): { open: OpenCall[]; realized: number; premiumSold: number } {
  const open: OpenCall[] = [];
  let realized = 0;
  let premiumSold = 0;
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    if (t.action === 'SELL_OPEN' || t.action === 'ADOPT') {
      open.push({
        id: t.id, ts: t.ts, strike: t.strike, expiry: t.expiry, units: t.units, entryPrice: t.price,
        securityId: t.securityId, tradingSymbol: t.tradingSymbol || `NIFTY-${t.expiry}-${t.strike}-CE`,
      });
      premiumSold += t.price * t.units;
    } else if (t.action === 'BUY_CLOSE') {
      realized += t.realizedPnl ?? 0;
      const idx = open.findIndex((o) => o.id === t.openLegId);
      if (idx < 0) continue;
      const left = open[idx].units - t.units;
      if (left > 0) open[idx] = { ...open[idx], units: left };
      else open.splice(idx, 1);
    }
  }
  return { open, realized, premiumSold };
}

/**
 * Down-only reconcile against the broker (dhan-terminal-position-ownership
 * Invariant 2): per security id, the ledger may claim at most what the broker
 * still shows short. Shrinks the NEWEST legs first; never grows a leg. Legs
 * younger than `graceMs` are exempt — the position book lags a fresh fill.
 * `brokerShortUnits === null` means the positions call failed: unknown, leave
 * the ledger alone.
 */
export function reconcileCallsDown(
  open: OpenCall[],
  brokerShortUnits: Record<string, number> | null,
  now: number,
  graceMs = 20_000,
): { legs: (OpenCall & { ledgerUnits: number })[]; clamped: boolean } {
  const legs = open.map((o) => ({ ...o, ledgerUnits: o.units }));
  if (!brokerShortUnits) return { legs, clamped: false };
  let clamped = false;
  const bySid = new Map<string, typeof legs>();
  for (const l of legs) bySid.set(l.securityId, [...(bySid.get(l.securityId) ?? []), l]);
  for (const [sid, group] of bySid) {
    if (group.some((l) => now - l.ts < graceMs)) continue;
    let budget = Math.max(0, brokerShortUnits[sid] ?? 0);
    // Oldest legs keep their claim first; the newest absorb any shortfall.
    for (const l of [...group].sort((a, b) => a.ts - b.ts)) {
      const keep = Math.min(l.units, budget);
      if (keep < l.units) clamped = true;
      l.units = keep;
      budget -= keep;
    }
  }
  return { legs, clamped };
}

// ── NIFTYBEES ↔ NIFTY equivalence ──────────────────────────────────────────

/**
 * NIFTYBEES is priced at roughly NIFTY/90 (the ratio drifts with tracking and
 * expense), so the holding's Nifty exposure is measured live by value:
 * qty × beesLtp / spot Nifty units. That is its delta in the same units the
 * short calls' chain Greeks sum to.
 */
export function beesNiftyUnits(beesQty: number, beesLtp: number, spot: number): number {
  if (!(beesQty > 0) || !(beesLtp > 0) || !(spot > 0)) return 0;
  return (beesQty * beesLtp) / spot;
}

// ── Book P&L + Greeks ──────────────────────────────────────────────────────

export interface CallMark {
  ltp: number | null;
  chainLeg?: ChainLegData;
  /** Calendar days to the leg's own expiry (for the BS delta fallback). */
  dte: number;
}

export interface BookLegGreeks {
  id: string;
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null;
  /** True when delta came from the Black-Scholes fallback, not Dhan's chain. */
  deltaEstimated: boolean;
  missing: boolean;
}

export interface BookSnapshot {
  beesUnits: number;          // NIFTY-equivalent units the holding represents
  beesPnl: number | null;     // unrealized on the holding
  callsOpenPnl: number;       // MTM of the open short calls (priced legs only)
  callsRealized: number;
  /** P&L of units the broker no longer shows short but the ledger hasn't
   *  closed yet (closed outside the desk, awaiting SYNC). Estimated at the LTP
   *  (0 when unpriced) so the reconcile clamp never makes P&L vanish. */
  callsUnsyncedPnl: number;
  unsyncedUnits: number;
  totalPnl: number | null;
  shortCallUnits: number;
  coverage: number | null;    // shortCallUnits / beesUnits
  uncoveredUnits: number;     // short call units beyond the holding (naked)
  net: { delta: number; gamma: number; theta: number; vega: number };
  callDelta: number;
  legs: BookLegGreeks[];
  missingCount: number;
  unpricedCount: number;
}

export function computeBook(params: {
  beesQty: number;
  beesAvg: number;
  beesLtp: number;
  spot: number;
  /** `ledgerUnits` (from reconcileCallsDown) > `units` means the broker clamp cut the leg. */
  calls: (OpenCall & { ledgerUnits?: number })[];
  marks: Record<string, CallMark>;
  callsRealized: number;
}): BookSnapshot {
  const { beesQty, beesAvg, beesLtp, spot, calls, marks, callsRealized } = params;
  const beesUnits = beesNiftyUnits(beesQty, beesLtp, spot);
  const beesPnl = beesQty > 0 && beesLtp > 0 && beesAvg > 0 ? (beesLtp - beesAvg) * beesQty : beesQty > 0 ? null : 0;

  let callsOpenPnl = 0;
  let callDelta = 0, gamma = 0, theta = 0, vega = 0;
  let shortCallUnits = 0;
  let missingCount = 0;
  let unpricedCount = 0;
  let callsUnsyncedPnl = 0;
  let unsyncedUnits = 0;
  const legs: BookLegGreeks[] = [];

  for (const c of calls) {
    const gap = (c.ledgerUnits ?? c.units) - c.units;
    if (gap > 0) {
      const ltp = marks[c.id]?.ltp;
      unsyncedUnits += gap;
      callsUnsyncedPnl += ltp != null && ltp > 0 ? (c.entryPrice - ltp) * gap : 0;
    }
    if (c.units <= 0) continue;
    shortCallUnits += c.units;
    const m = marks[c.id];
    if (m?.ltp != null && m.ltp > 0) callsOpenPnl += (c.entryPrice - m.ltp) * c.units;
    else unpricedCount++;

    const g = m?.chainLeg?.greeks;
    const zeroOrNull = (v: number | null | undefined) => v === null || v === undefined || v === 0;
    let d: number | null = g?.delta ?? null;
    let deltaEstimated = false;
    const chainMissing = !g || (zeroOrNull(g.delta) && zeroOrNull(g.gamma) && zeroOrNull(g.theta) && zeroOrNull(g.vega));
    if (chainMissing && spot > 0) {
      // Delta drives the coverage/net-delta readout, so fall back to BS rather
      // than silently dropping the leg. Gamma/theta/vega stay excluded.
      const iv = m?.chainLeg?.implied_volatility && m.chainLeg.implied_volatility > 0 ? m.chainLeg.implied_volatility : 12;
      d = estimatePopAndDelta(spot, c.strike, Math.max(m?.dte ?? 1, 0.25), iv, true).delta;
      deltaEstimated = true;
    }
    const k = -c.units; // short
    if (d != null) callDelta += d * k;
    if (!chainMissing) {
      gamma += (g!.gamma ?? 0) * k;
      theta += (g!.theta ?? 0) * k;
      vega += (g!.vega ?? 0) * k;
    } else {
      missingCount++;
    }
    legs.push({
      id: c.id,
      delta: d != null ? d * k : null,
      gamma: chainMissing ? null : (g!.gamma ?? 0) * k,
      theta: chainMissing ? null : (g!.theta ?? 0) * k,
      vega: chainMissing ? null : (g!.vega ?? 0) * k,
      deltaEstimated,
      missing: chainMissing,
    });
  }

  const coverage = beesUnits > 0 ? shortCallUnits / beesUnits : null;
  return {
    beesUnits,
    beesPnl,
    callsOpenPnl,
    callsRealized,
    callsUnsyncedPnl,
    unsyncedUnits,
    totalPnl: beesPnl == null ? null : beesPnl + callsOpenPnl + callsRealized + callsUnsyncedPnl,
    shortCallUnits,
    coverage,
    uncoveredUnits: Math.max(0, shortCallUnits - beesUnits),
    net: { delta: beesUnits + callDelta, gamma, theta, vega },
    callDelta,
    legs,
    missingCount,
    unpricedCount,
  };
}

// ── Strike suggestion ──────────────────────────────────────────────────────

export interface CoveredCallSuggestion {
  strike: number;
  strikeDelta: number;
  deltaEstimated: boolean;
  premium: number;
  /** Lots the holding fully covers (floor) — 0 when the holding is under one lot. */
  coveredLots: number;
  /** Lots to the nearest whole cover (round) — may slightly over-write. */
  nearestLots: number;
}

/**
 * The OTM call (strike > spot) whose |delta| is closest to `targetDelta`, plus
 * how many lots the holding covers. Returns null with no priced OTM call.
 */
export function suggestCoveredCall(
  oc: ChainOc,
  spot: number,
  beesUnits: number,
  lotSize: number,
  targetDelta: number,
  dte: number,
): CoveredCallSuggestion | null {
  if (!(spot > 0)) return null;
  let best: { strike: number; delta: number; est: boolean; premium: number } | null = null;
  for (const key of Object.keys(oc ?? {})) {
    const strike = parseFloat(key);
    if (!(strike > spot)) continue;
    const ce = lookupChainLegData(oc, strike, 'CE');
    if (!ce || !(ce.last_price > 0.05)) continue;
    let delta = ce.greeks?.delta;
    let est = false;
    if (delta == null || delta === 0) {
      const iv = ce.implied_volatility && ce.implied_volatility > 0 ? ce.implied_volatility : 12;
      delta = estimatePopAndDelta(spot, strike, Math.max(dte, 0.25), iv, true).delta;
      est = true;
    }
    const d = Math.abs(delta);
    if (!best || Math.abs(d - targetDelta) < Math.abs(best.delta - targetDelta)) {
      best = { strike, delta: d, est, premium: ce.last_price };
    }
  }
  if (!best) return null;
  const ratio = lotSize > 0 ? beesUnits / lotSize : 0;
  return {
    strike: best.strike,
    strikeDelta: Math.round(best.delta * 1000) / 1000,
    deltaEstimated: best.est,
    premium: best.premium,
    coveredLots: Math.floor(ratio + 1e-9),
    nearestLots: Math.max(0, Math.round(ratio)),
  };
}

/**
 * Covered-call return metrics for writing `units` of a call at `premium`
 * against `beesUnits` of Nifty exposure worth `holdingValue` rupees.
 * Static = premium only; if-called = premium + the covered portion's upside to
 * the strike; protection = how far Nifty can fall before the premium is used up.
 */
export function coveredCallReturns(params: {
  premium: number; units: number; strike: number; spot: number; beesUnits: number; holdingValue: number; dte: number;
}) {
  const { premium, units, strike, spot, beesUnits, holdingValue, dte } = params;
  if (!(holdingValue > 0) || !(spot > 0) || !(units > 0)) return null;
  const credit = premium * units;
  const coveredUnits = Math.min(units, beesUnits);
  const upside = Math.max(0, strike - spot) * coveredUnits;
  const staticPct = (credit / holdingValue) * 100;
  const ifCalledPct = ((credit + upside) / holdingValue) * 100;
  const days = Math.max(dte, 1);
  return {
    credit,
    staticPct,
    staticAnnualPct: (staticPct * 365) / days,
    ifCalledPct,
    protectionPts: beesUnits > 0 ? credit / beesUnits : 0,
    protectionPct: beesUnits > 0 ? (credit / beesUnits / spot) * 100 : 0,
  };
}

/** Calendar days from today (IST) to an expiry date "YYYY-MM-DD" (fractional is fine). */
export function daysToExpiry(expiry: string, now = Date.now()): number {
  const d = new Date(`${expiry.slice(0, 10)}T15:30:00+05:30`).getTime();
  if (Number.isNaN(d)) return 1;
  return Math.max(0, (d - now) / 86_400_000);
}
