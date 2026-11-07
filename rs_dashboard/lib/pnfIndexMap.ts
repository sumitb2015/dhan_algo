// Index chart -> option trade mapping for the Renko page (the Price Ladder XY idea on a Renko index chart): the INDEX chart gives
// the direction and the levels, an option is traded. Each direction is configured on its own:
//
//   bull (Buy button / BUY signal / BUY level)   -> e.g. BUY CE, or SELL PE
//   bear (Sell button / SELL signal / SELL level) -> e.g. BUY PE, or SELL CE
//
// The strike is ATM +/- N at fire time (N > 0 = out of the money for both a CE and a PE), on the nearest or a chosen expiry.
// Pure: no IO. The server resolves the contract (lib/pnfIndexTradeServer.ts); the browser only names the map.

import { bias as ladderBias } from './priceLadder.ts';
import type { PnfAction } from './pnfOrderLogic.ts';
import type { Target } from './pnfTarget.ts';

export type IndexDir = 'bull' | 'bear';
export type IndexMapLeg = { action: PnfAction; opt: 'CE' | 'PE'; offset: number };
export type IndexMap = { bull: IndexMapLeg; bear: IndexMapLeg; expiry: 'NEAREST' | string };

/** Further than this many strikes from ATM is not a mapping anyone means (a mistyped offset). */
export const MAX_STRIKE_OFFSET = 10;

export const DEFAULT_INDEX_MAP: IndexMap = {
  bull: { action: 'BUY', opt: 'CE', offset: 0 },
  bear: { action: 'BUY', opt: 'PE', offset: 0 },
  expiry: 'NEAREST',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseLeg(v: unknown): IndexMapLeg | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.action !== 'BUY' && o.action !== 'SELL') return null;
  if (o.opt !== 'CE' && o.opt !== 'PE') return null;
  const n = o.offset;
  if (typeof n !== 'number' || !Number.isInteger(n) || Math.abs(n) > MAX_STRIKE_OFFSET) return null;
  return { action: o.action, opt: o.opt, offset: n };
}

/** A map from a request / storage -> a valid map, or null. Malformed input is refused, never defaulted (the server must not guess a trade). */
export function parseIndexMap(v: unknown): IndexMap | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const bull = parseLeg(o.bull), bear = parseLeg(o.bear);
  if (!bull || !bear) return null;
  const expiry = o.expiry === 'NEAREST' ? 'NEAREST' : typeof o.expiry === 'string' && DATE_RE.test(o.expiry) ? o.expiry : null;
  if (!expiry) return null;
  return { bull, bear, expiry };
}

/** A stored map (browser): a corrupt or missing one falls back to the default (the user sees it in the controls before trading). */
export function readIndexMap(raw: string | null): IndexMap {
  try { return parseIndexMap(raw ? JSON.parse(raw) : null) ?? DEFAULT_INDEX_MAP; } catch { return DEFAULT_INDEX_MAP; }
}

/** The chart's direction for a chart-side action: BUY = bullish, SELL = bearish. */
export const dirOf = (chartAction: PnfAction): IndexDir => (chartAction === 'BUY' ? 'bull' : 'bear');
export const otherDir = (d: IndexDir): IndexDir => (d === 'bull' ? 'bear' : 'bull');
/** The chart-side action of a direction (the reverse of dirOf). */
export const chartActionOf = (d: IndexDir): PnfAction => (d === 'bull' ? 'BUY' : 'SELL');

/** +1 when the leg gains as the index rises (BUY CE, SELL PE), -1 otherwise: the Price Ladder's own rule. */
export const legBias = (leg: IndexMapLeg): 1 | -1 => ladderBias(leg.opt, leg.action);

/** A map leg that trades AGAINST its direction (a bull leg that loses as the index rises): allowed, but the controls warn. */
export const againstDir = (d: IndexDir, leg: IndexMapLeg) => legBias(leg) !== (d === 'bull' ? 1 : -1);

/** The expiry the map trades: NEAREST = the first live one; a chosen expiry only while it is still listed. */
export function pickExpiry(map: IndexMap, expiries: string[]): string | null {
  if (!expiries.length) return null;
  if (map.expiry === 'NEAREST') return expiries[0];
  return expiries.includes(map.expiry) ? map.expiry : null;
}

/**
 * ATM (the listed strike nearest spot), then `offset` strikes out of the money: a CE steps UP the list, a PE steps DOWN, so +2 is
 * two strikes OTM for either. Null without a usable spot (never the middle strike: an order needs the real ATM) or when the
 * offset runs off the end of the list.
 */
export function pickStrike(strikes: number[], spot: number | null, opt: 'CE' | 'PE', offset: number): number | null {
  if (!strikes.length || spot === null || !(spot > 0)) return null;
  // the nearest listed strike, lower one on a tie (lib/pnfContracts.ts atmStrike's rule; not imported: that module reads the disk)
  const atm = strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), strikes[0]);
  const i = strikes.indexOf(atm) + (opt === 'CE' ? offset : -offset);
  return i >= 0 && i < strikes.length ? strikes[i] : null;
}

/** "BUY CE ATM", "SELL PE +2 OTM", "BUY CE 1 ITM". */
export function legText(leg: IndexMapLeg): string {
  const at = leg.offset === 0 ? 'ATM' : leg.offset > 0 ? `+${leg.offset} OTM` : `${-leg.offset} ITM`;
  return `${leg.action} ${leg.opt} ${at}`;
}

/** The option the map trades for `dir`, as a chart target (the order route resolves its contract like any option chart's). */
export function mappedTarget(index: Pick<Target, 'symbol'>, map: IndexMap, dir: IndexDir, spot: number | null, expiries: string[],
  strikesOf: (expiry: string) => number[]): { target: Target; action: PnfAction } | string {
  const leg = map[dir];
  const expiry = pickExpiry(map, expiries);
  if (!expiry) return map.expiry === 'NEAREST' ? `${index.symbol} has no live options` : `${index.symbol} has no options expiring ${map.expiry} any more - pick another expiry`;
  if (spot === null || !(spot > 0)) return `No fresh ${index.symbol} price - ATM cannot be picked`;
  const strike = pickStrike(strikesOf(expiry), spot, leg.opt, leg.offset);
  if (strike === null) return `${legText(leg)} is outside the listed ${index.symbol} strikes for ${expiry}`;
  return { target: { kind: 'options', symbol: index.symbol, name: index.symbol, expiry, strike, side: leg.opt }, action: leg.action };
}

/** An option target belongs to the index chart: the same underlying, a single CE / PE (never a straddle). */
export const tradedOf = (index: Pick<Target, 'symbol'>, t: Target) =>
  t.kind === 'options' && t.symbol === index.symbol && (t.side === 'CE' || t.side === 'PE') && !!t.expiry && !!t.strike;
