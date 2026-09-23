// Nifty Futures Covered Call desk — pure functions, no React import.
//
// Strategy shape: short NIFTY futures (the core directional leg) plus one or
// more short OTM calls written against it, premium-financed and sized/rolled
// by cumulative delta. This mirrors the style of lib/positionGreeks.ts and
// lib/strangleMath.ts — synchronous, chain-fetching stays in the caller.

import type { ChainOc, ChainLegData } from './optionsStrategy';
import { estimatePopAndDelta } from './ultimateScannerEngine.ts';
import { computeNetGreeks, type NetGreeks } from './positionGreeks';
import type { PositionLeg } from './positionLegs';

// ── Strike/lot suggestion ───────────────────────────────────────────────────

export interface ShortCallSuggestion {
  strike: number;
  callLots: number;
  /** |delta| of the suggested strike, from the chain or the BS fallback. */
  strikeDelta: number;
  /**
   * Net "hedge-engine" delta at `callLots`, using this desk's own sizing
   * convention (see the note above `suggestShortCallStrike`) — NOT the same
   * sign convention as `computeCoveredCallGreeks()` below, which reports the
   * standard signed per-contract Greek sum. Compare like-for-like: feed this
   * value only into `evaluateRollNeed` calls that were themselves seeded from
   * a `suggestShortCallStrike` result, never mixed with a `computeNetGreeks`
   * delta.
   */
  netDelta: number;
}

/**
 * Suggest the OTM call strike closest to `targetDelta` (a magnitude, e.g.
 * 0.30) and the number of call lots needed to bring net position delta near
 * `opts.targetNetDelta` (default 0 — "fully hedged"; a caller wanting the
 * book to stay net short can pass a negative target instead).
 *
 * Sizing convention (this function and `evaluateRollNeed` only): the futures
 * leg contributes `+1.0 * futuresLots` and each short call leg contributes
 * `-|delta| * callLots` to "net delta" — a desk-specific hedge-ratio score,
 * not the textbook signed option delta. It lets `targetNetDelta = 0` mean
 * "call premium fully offsets the futures leg's notional delta exposure" and
 * a more negative target mean "stay net short by that much." See
 * `computeCoveredCallGreeks` for the standard signed-Greeks readout used
 * elsewhere on the page.
 *
 * Returns null when the chain has no priced OTM call above `futuresLtp`.
 */
export function suggestShortCallStrike(
  oc: ChainOc,
  futuresLtp: number,
  futuresLots: number,
  targetDelta: number,
  opts: { targetNetDelta?: number; dte?: number; ivFallback?: number; maxCallLots?: number } = {},
): ShortCallSuggestion | null {
  const targetNetDelta = opts.targetNetDelta ?? 0;
  const dte = opts.dte ?? 1;
  const ivFallback = opts.ivFallback ?? 12;
  const maxCallLots = opts.maxCallLots ?? Math.max(futuresLots * 4, 20);

  if (!(futuresLtp > 0) || !(futuresLots > 0)) return null;

  const candidates: { strike: number; delta: number }[] = [];
  for (const [strikeKey, row] of Object.entries(oc ?? {})) {
    const strike = parseFloat(strikeKey);
    if (!(strike > futuresLtp)) continue; // OTM call only
    const ce: ChainLegData | undefined = row?.ce;
    if (!ce || typeof ce.last_price !== 'number' || ce.last_price <= 0.05) continue;

    let delta = ce.greeks?.delta;
    if (delta === undefined || delta === null || Math.abs(delta) === 0) {
      const iv = ce.implied_volatility && ce.implied_volatility > 0 ? ce.implied_volatility : ivFallback;
      delta = estimatePopAndDelta(futuresLtp, strike, dte, iv, true).delta;
    }
    candidates.push({ strike, delta: Math.abs(delta) });
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta));
  const best = candidates[0];

  let bestLots = 0;
  let bestErr = Infinity;
  for (let lots = 0; lots <= maxCallLots; lots++) {
    const net = futuresLots * 1.0 - best.delta * lots;
    const err = Math.abs(net - targetNetDelta);
    if (err < bestErr) {
      bestErr = err;
      bestLots = lots;
    }
  }

  return {
    strike: best.strike,
    callLots: bestLots,
    strikeDelta: Math.round(best.delta * 1000) / 1000,
    netDelta: Math.round((futuresLots * 1.0 - best.delta * bestLots) * 1000) / 1000,
  };
}

// ── Roll-need evaluation ────────────────────────────────────────────────────

export interface RollBand {
  targetDelta: number;
  bandWidth: number;
}

export interface RollNeedResult {
  needsRoll: boolean;
  reason?: string;
}

/**
 * Pure drift check: has `currentNetDelta` wandered outside
 * `[targetDelta - bandWidth, targetDelta + bandWidth]`? Caller re-invokes
 * `suggestShortCallStrike` for the replacement strike/lots when this returns
 * `needsRoll: true` — this function never fetches a chain or places an order,
 * and the banner it drives is informational only (no auto-roll).
 */
export function evaluateRollNeed(currentNetDelta: number, band: RollBand): RollNeedResult {
  const lo = band.targetDelta - band.bandWidth;
  const hi = band.targetDelta + band.bandWidth;
  if (currentNetDelta < lo) {
    return {
      needsRoll: true,
      reason: `Net delta ${currentNetDelta.toFixed(2)} has drifted below the band floor ${lo.toFixed(2)} — consider rolling the short call closer/adding lots.`,
    };
  }
  if (currentNetDelta > hi) {
    return {
      needsRoll: true,
      reason: `Net delta ${currentNetDelta.toFixed(2)} has drifted above the band ceiling ${hi.toFixed(2)} — consider rolling the short call further/trimming lots.`,
    };
  }
  return { needsRoll: false };
}

// ── Net Greeks (standard signed convention) ─────────────────────────────────

export type { NetGreeks };

/**
 * Synthesize a futures leg into `PositionLeg` shape so it can flow through
 * `computeNetGreeks` alongside the short call leg(s). A future has no option
 * greeks of its own — gamma/theta/vega are 0 and delta is the textbook 1.0
 * per lot, signed by `computeNetGreeks`'s own side convention (SELL flips it
 * negative), which is the standard reading: a short future is -1 delta/lot.
 * `strike`/`type` are placeholders `computeNetGreeks` never reads.
 */
export function buildFuturesLeg(params: {
  side: 'BUY' | 'SELL';
  qtyLots: number;
  price: number;
  securityId: string | null;
  expiry: string | null;
  tradingSymbol?: string;
  ltp?: number | null;
}): PositionLeg {
  return {
    strike: 0,
    type: 'CE',
    side: params.side,
    qtyLots: params.qtyLots,
    price: params.price,
    delta: 1,
    iv: null,
    vega: 0,
    gamma: 0,
    theta: 0,
    securityId: params.securityId,
    expiry: params.expiry,
    display: {
      tradingSymbol: params.tradingSymbol ?? 'NIFTY-FUT',
      productType: 'INTRADAY',
      netQty: params.side === 'SELL' ? -params.qtyLots : params.qtyLots,
      entryAvg: params.price,
      ltp: params.ltp ?? null,
      realizedProfit: 0,
      unrealizedProfit: 0,
      trustBrokerUnrealized: false,
      expiry: params.expiry,
    },
  };
}

/** Synthesize a short (or long) call leg into `PositionLeg` shape from a chain row. */
export function buildCallLeg(params: {
  strike: number;
  side: 'BUY' | 'SELL';
  qtyLots: number;
  price: number;
  chainLeg?: ChainLegData;
  securityId?: string | null;
  expiry: string | null;
  tradingSymbol?: string;
  ltp?: number | null;
  dte?: number;
  spot?: number;
}): PositionLeg {
  const chainLeg = params.chainLeg;
  let delta = chainLeg?.greeks?.delta ?? null;
  if ((delta === null || delta === undefined || Math.abs(delta) === 0) && params.spot) {
    const iv = chainLeg?.implied_volatility && chainLeg.implied_volatility > 0 ? chainLeg.implied_volatility : 12;
    delta = estimatePopAndDelta(params.spot, params.strike, params.dte ?? 1, iv, true).delta;
  }
  return {
    strike: params.strike,
    type: 'CE',
    side: params.side,
    qtyLots: params.qtyLots,
    price: params.price,
    delta: delta ?? null,
    iv: typeof chainLeg?.implied_volatility === 'number' ? chainLeg.implied_volatility / 100 : null,
    vega: chainLeg?.greeks?.vega ?? null,
    gamma: chainLeg?.greeks?.gamma ?? null,
    theta: chainLeg?.greeks?.theta ?? null,
    securityId: params.securityId ?? (chainLeg?.security_id ? String(chainLeg.security_id) : null),
    expiry: params.expiry,
    display: {
      tradingSymbol: params.tradingSymbol ?? `NIFTY-${params.strike}-CE`,
      productType: 'INTRADAY',
      netQty: params.side === 'SELL' ? -params.qtyLots : params.qtyLots,
      entryAvg: params.price,
      ltp: params.ltp ?? (chainLeg && chainLeg.last_price > 0 ? chainLeg.last_price : null),
      realizedProfit: 0,
      unrealizedProfit: 0,
      trustBrokerUnrealized: false,
      expiry: params.expiry,
    },
  };
}

/** Thin re-export wrapper — the live cumulative delta/gamma/theta/vega readout
 *  across the futures + call leg(s), standard signed-Greeks convention. */
export function computeCoveredCallGreeks(legs: PositionLeg[]): NetGreeks {
  return computeNetGreeks(legs);
}
