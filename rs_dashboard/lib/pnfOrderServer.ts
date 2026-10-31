import { findEquity } from '@/lib/equityMaster';
import { resolveFuture, resolveOption } from '@/lib/pnfContracts';
import { kotakEquityContract, kotakFutureContract, kotakOptionContract } from '@/lib/kotakContracts';
import { zerodhaOptionContract } from '@/lib/zerodhaContracts';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { derivativeTick } from '@/lib/derivativeTick';
import type { Target } from '@/lib/pnfTarget';
import type { PnfBroker } from '@/lib/pnfOrderLogic';

// Server-side contract resolution for the P&F trade bar. The browser names the chart's target; every security id,
// trading symbol, segment and lot size used for an order is looked up here (Dhan's master_list.csv, then the broker's
// own instrument cache), never taken from the request.

export interface PnfLeg {
  /** e.g. "NIFTY 25000 CALL", "RELIANCE". */
  label: string;
  /** CE / PE for an option leg, FUT / EQ otherwise. */
  side: string;
  segment: 'NSE_EQ' | 'NSE_FNO' | 'MCX_COMM';
  securityId: string;
  /** Exchange lot (shares for equity, 1 for Dhan MCX). */
  lot: number;
  /** Rupees per point per lot: the exchange lot on NSE, barrels per lot on MCX (null when the MCX multiplier is unknown). */
  unitsPerLot: number | null;
  /** The exchange tick in rupees (master_list TICK_SIZE is in paise); null when the master has none. */
  tick: number | null;
}

export interface PnfBrokerLeg extends PnfLeg {
  /** The broker's position / order key: Dhan's security id, else the broker's trading symbol. */
  key: string;
  /** The broker's exchange / segment code for the order. */
  exchange: string;
  /** The broker's quantity for one lot (1 for equity and Dhan MCX). */
  lotUnits: number;
  /** Broker lot size for the per-source lot cap (Kotak), null for equity. */
  capLot: number | null;
}

/** The target's legs from Dhan's master: one for equity / a future / an option, CE then PE for a straddle. */
export function resolvePnfLegs(t: Target): PnfLeg[] | string {
  if (t.kind === 'equity') {
    const e = findEquity(t.symbol);
    if (!e) return `Unknown NSE stock ${t.symbol}`;
    return [{ label: t.symbol, side: 'EQ', segment: 'NSE_EQ', securityId: e.securityId, lot: 1, unitsPerLot: 1, tick: e.tick > 0 ? e.tick : null }];
  }
  if (t.kind === 'futures' && t.expiry) {
    const f = resolveFuture(t.symbol, t.expiry);
    if (!f) return `No ${t.symbol} future expiring ${t.expiry}`;
    return [legOf(f, t.symbol, 'FUT')];
  }
  if (t.kind === 'options' && t.expiry && t.strike && t.side) {
    const sides: ('CE' | 'PE')[] = t.side === 'STRADDLE' ? ['CE', 'PE'] : [t.side];
    const legs: PnfLeg[] = [];
    for (const s of sides) {
      const c = resolveOption(t.symbol, t.expiry, t.strike, s);
      if (!c) return `No ${t.symbol} ${t.strike} ${s} expiring ${t.expiry}`;
      legs.push(legOf(c, t.symbol, s));
    }
    return legs;
  }
  return 'This chart cannot be traded';
}

function legOf(c: { segment: 'NSE_FNO' | 'MCX_COMM'; securityId: string; displayName: string; lot: number }, underlying: string, side: string): PnfLeg {
  const mcx = c.segment === 'MCX_COMM';
  return {
    label: c.displayName, side, segment: c.segment, securityId: c.securityId, lot: mcx ? 1 : c.lot,
    unitsPerLot: mcx ? (MCX_LOT_MULTIPLIER[underlying] ?? null) : c.lot,
    tick: derivativeTick(c.securityId, c.segment),
  };
}

/** The same legs on `broker`, or why that broker cannot trade them from this page. */
export async function brokerLegs(broker: PnfBroker, t: Target, legs: PnfLeg[]): Promise<PnfBrokerLeg[] | string> {
  const mcx = legs.some(l => l.segment === 'MCX_COMM');
  if (broker === 'dhan') {
    // Dhan orders MCX in lots (lot 1 here) and NSE F&O / equity in units.
    return legs.map(l => ({ ...l, key: l.securityId, exchange: l.segment, lotUnits: l.lot, capLot: null }));
  }
  const name = broker === 'kotak' ? 'Kotak' : 'Zerodha';
  // Kotak / Zerodha MCX quantity units are not confirmed against live fills (docs/PRICE_LADDER_GUIDE.md).
  if (mcx) return `${name} MCX orders are not supported from this page - use Dhan`;
  const out: PnfBrokerLeg[] = [];
  for (const l of legs) {
    if (l.segment === 'NSE_EQ') {
      if (broker === 'kotak') {
        const c = await kotakEquityContract(t.symbol);
        if (!c) return `Kotak does not list ${t.symbol}`;
        out.push({ ...l, key: c.tradingsymbol, exchange: 'nse_cm', lotUnits: 1, capLot: null });
      } else {
        out.push({ ...l, key: t.symbol, exchange: 'NSE', lotUnits: 1, capLot: null });
      }
      continue;
    }
    if (t.kind === 'futures' && t.expiry) {
      if (broker === 'zerodha') return 'Zerodha futures are not supported from this page - use Dhan or Kotak';
      const c = await kotakFutureContract(t.symbol, t.expiry);
      if (!c || !(c.lotSize > 0)) return `Kotak does not list the ${t.symbol} future expiring ${t.expiry}`;
      out.push({ ...l, key: c.tradingsymbol, exchange: c.segment, lotUnits: c.lotSize, capLot: c.lotSize });
      continue;
    }
    if (t.kind === 'options' && t.expiry && t.strike && (l.side === 'CE' || l.side === 'PE')) {
      const c = broker === 'kotak'
        ? await kotakOptionContract(t.symbol, t.expiry, t.strike, l.side)
        : await zerodhaOptionContract(t.symbol, t.expiry, t.strike, l.side);
      if (!c || !(c.lotSize > 0)) return `${name} does not list ${t.symbol} ${t.strike} ${l.side} expiring ${t.expiry}`;
      const exchange = 'segment' in c ? c.segment : c.exchange;
      out.push({ ...l, key: c.tradingsymbol, exchange, lotUnits: c.lotSize, capLot: c.lotSize });
      continue;
    }
    return `${name} cannot trade ${l.label} from this page`;
  }
  // A broker whose lot differs from the exchange lot would size the order off a different contract: refuse.
  const off = out.find(l => l.segment !== 'NSE_EQ' && l.lotUnits !== l.lot);
  if (off) return `${name} lot size ${off.lotUnits} differs from the exchange lot ${off.lot} for ${off.label} - not sent`;
  return out;
}
