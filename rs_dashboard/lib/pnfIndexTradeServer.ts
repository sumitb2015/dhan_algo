import { fetchLtp } from '@/lib/dhanEquityQuote';
import { expiriesFor, hasUnderlying, indexSpotId, strikesFor } from '@/lib/pnfContracts';
import { askBridge, readBridgeBook, readBack } from '@/lib/pnfLiveBridge';
import type { WantedPair } from '@/lib/pnfWanted';
import { brokerLegs, resolvePnfLegs } from '@/lib/pnfOrderServer';
import { mappedTarget, type IndexDir, type IndexMap } from '@/lib/pnfIndexMap';
import type { PnfAction, PnfBroker } from '@/lib/pnfOrderLogic';
import { parseOptionIds, type Target } from '@/lib/pnfTarget';

// Server side of the Renko index -> option mapping (lib/pnfIndexMap.ts): the index's spot, the ATM +/- N option of the mapped side, and
// that option's legs on the broker. Read-only: no order is placed here. The order then goes through the ordinary order route with the
// resolved OPTION target (which re-resolves its own contract server-side, as for any option chart): the browser never names a security id.

/** A bridge price this old is no longer "now" for an ATM pick; the REST quote is asked instead. */
export const SPOT_BRIDGE_FRESH_MS = 30_000;

/** A price from the WebSocket bridge's book when it ticked recently, else one Dhan REST quote through the shared quote lane. */
async function priceOf(segment: 'IDX_I' | 'NSE_FNO' | 'MCX_COMM', securityId: string, now: number): Promise<{ price: number; source: 'bridge' | 'quote' } | null> {
  const { book } = readBridgeBook(now);
  const q = readBack(book?.[`${segment}:${securityId}`]).quote;
  if (q && q.ltp > 0 && now - q.changedMs <= SPOT_BRIDGE_FRESH_MS) return { price: q.ltp, source: 'bridge' };
  try { return { price: await fetchLtp(segment, securityId), source: 'quote' }; } catch { return null; }
}

export interface IndexTradeLeg {
  label: string; side: string; segment: string; lot: number; unitsPerLot: number | null; tick: number | null;
  key: string | null; lotUnits: number | null;
}

export interface IndexTradeResolved {
  /** The option to trade, as a chart target (what the order route is sent). */
  traded: Target;
  /** The option's own side: BUY or SELL (a bearish SELL CE is a SELL here). */
  action: PnfAction;
  /** `SEG:ID` of the option for the live-price route (a price read, never an order field). */
  ids: string;
  legs: IndexTradeLeg[];
  /** Why the broker cannot trade it (REAL is then refused); null when it can. */
  unsupported: string | null;
  spot: number;
  spotSource: 'bridge' | 'quote';
  /** The option's price now, when asked for (a PAPER fill); null when no price could be read. */
  premium: number | null;
}

/** The mapped option for `dir` on the index chart `index`, or why there is none. */
export async function resolveIndexTrade(broker: PnfBroker, index: Target, map: IndexMap, dir: IndexDir, withPremium: boolean,
  now = Date.now()): Promise<IndexTradeResolved | string> {
  if (index.kind !== 'index') return 'Only an index chart maps its trades to options';
  if (!hasUnderlying('options', index.symbol)) return `${index.symbol} has no listed options to trade`;
  const id = indexSpotId(index.symbol);
  if (!id) return `${index.symbol} has no spot index id in the master list`;
  const spot = await priceOf('IDX_I', id, now);
  if (!spot) return `No fresh ${index.symbol} price - ATM cannot be picked, nothing was sent`;
  const m = mappedTarget(index, map, dir, spot.price, expiriesFor('options', index.symbol), e => strikesFor(index.symbol, e));
  if (typeof m === 'string') return m;
  const legs = resolvePnfLegs(m.target);
  if (typeof legs === 'string') return legs;
  const leg = legs[0];
  const onBroker = await brokerLegs(broker, m.target, legs).catch((e: Error) => `Contract lookup failed: ${e.message}`);
  const premium = withPremium ? (await priceOf(leg.segment === 'MCX_COMM' ? 'MCX_COMM' : 'NSE_FNO', leg.securityId, now))?.price ?? null : null;
  return {
    traded: m.target, action: m.action, ids: `${leg.segment}:${leg.securityId}`,
    legs: legs.map((l, i) => ({
      label: l.label, side: l.side, segment: l.segment, lot: l.lot, unitsPerLot: l.unitsPerLot, tick: l.tick,
      key: typeof onBroker === 'string' ? null : onBroker[i].key,
      lotUnits: typeof onBroker === 'string' ? null : onBroker[i].lotUnits,
    })),
    unsupported: typeof onBroker === 'string' ? onBroker : null,
    spot: spot.price, spotSource: spot.source, premium,
  };
}

/**
 * An option's price now (`SEG:ID`), for an index chart's AUTO row: the bridge's price when it ticked recently, else one Dhan quote through
 * the shared lane. The option is also asked of the bridge (under `asker`), so its price keeps streaming while the row holds it.
 */
export async function premiumOf(ids: string, asker = `premium:${ids}`, now = Date.now()): Promise<number | null> {
  const m = parseOptionIds(ids);
  if (!m) return null;
  try { askBridge(asker, [[m.segment, m.securityId]] as WantedPair[], now); } catch { /* the quote below still answers */ }
  return (await priceOf(m.segment, m.securityId, now))?.price ?? null;
}
