import {
  findUntrackedPositions, contractHintFromRow, legFromUntracked, isLegInFillGrace, residualBrokerAvg,
  type MultiLegBasket, type MultiLegLeg,
} from './multiLegFocus.ts';
import { normalizeOptType, symbolMatchesUnderlying } from './positionLegs.ts';

/** A futures row on a known underlying with its expiry, or null (options and anything unidentified). */
export function futuresContractOf(row: Record<string, unknown>, underlyings: string[]): { underlying: string; expiry: string } | null {
  if (normalizeOptType(row.drvOptionType)) return null;
  const sym = String(row.tradingSymbol ?? '');
  if (!/FUT/i.test(sym)) return null;
  const underlying = [...underlyings].sort((a, b) => b.length - a.length).find(u => symbolMatchesUnderlying(sym, u));
  const expiry = String(row.drvExpiryDate ?? '').slice(0, 10);
  if (!underlying || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  return { underlying, expiry };
}

/**
 * Live price of a broker row. An explicit LTP field wins; else Dhan's row is inverted:
 * unrealizedProfit = (ltp - costPrice) x netQty. Dhan does NOT apply the row's `multiplier`
 * to it (MCX P&L comes back per lot-unit; see the dhan-crudeoil-trading skill) — dividing by it
 * put a CRUDEOILM future at 8590 while it traded at 8721 (2026-10-07). 0 when unknown.
 */
export function ltpFromBrokerRow(row: Record<string, unknown>): number {
  const direct = Number(row.ltp ?? row.lastPrice ?? row.last_price ?? 0);
  if (direct > 0) return direct;
  const net = Number(row.netQty) || 0;
  const cost = Number(row.costPrice) || 0;
  if (net === 0 || !(cost > 0) || row.unrealizedProfit == null) return 0;
  const ltp = cost + (Number(row.unrealizedProfit) || 0) / net;
  return ltp > 0 ? ltp : 0;
}

/**
 * Broker -> ledger sync for trades taken outside the tool. Each contract lives in ONE leg
 * (one group), so the broker's quantity on a contract is that leg's quantity:
 * - growLegToBroker:        broker holds more than the leg -> the leg grows to it.
 * - outsidePositionBaskets: a broker position no leg holds -> a new ungrouped trade.
 * Shrinking (closed outside) stays with reconcileLegWithBroker + brokerClampSlice.
 *
 * Every rule stands down while this tool's own orders may still be landing (PLACING /
 * CLOSING legs, unsettled pendingOrders, fill grace), so its own fill is never counted twice.
 */

/** Grows an OPEN leg to the broker qty. `addedAvg` prices the extra qty (residualBrokerAvg). */
export function growLegToBroker(leg: MultiLegLeg, brokerQty: number, addedAvg: number, lotSize: number): MultiLegLeg {
  const own = leg.fill?.qty ?? 0;
  if (leg.status !== 'OPEN' || own <= 0 || brokerQty <= own) return leg;
  const ownAvg = leg.fill!.avgPrice;
  const added = brokerQty - own;
  const avgPrice = addedAvg > 0 ? (own * ownAvg + added * addedAvg) / brokerQty : ownAvg;
  return {
    ...leg,
    lots: lotSize > 0 ? Math.max(1, Math.round(brokerQty / lotSize)) : leg.lots,
    price: avgPrice,
    fill: { ...leg.fill!, qty: brokerQty, avgPrice },
  };
}

/** True while any of this tool's orders may still be landing at the broker. */
export function ordersSettling(baskets: MultiLegBasket[], now: number = Date.now()): boolean {
  return baskets.some(b => b.legs.some(l =>
    l.status === 'PLACING' || l.status === 'CLOSING' || (l.pendingOrders?.length ?? 0) > 0 || isLegInFillGrace(l, now)));
}

/**
 * New ungrouped-trade baskets for broker option positions that no leg holds. Ids are
 * derived from the contract and day, so building them twice (React may run an updater
 * twice) yields the same baskets, never duplicates.
 */
export function outsidePositionBaskets(
  baskets: MultiLegBasket[],
  broker: string,
  rows: Record<string, unknown>[],
  underlyings: string[],
  lotSizeFor: (underlying: string) => number,
  day: string,
  nowIso: string,
): MultiLegBasket[] {
  if (ordersSettling(baskets)) return [];
  const live = (l: MultiLegLeg) => l.status !== 'CLOSED' && l.status !== 'DRAFT' && l.status !== 'FAILED';
  const ids = new Set(baskets.map(b => b.id));
  const out: MultiLegBasket[] = [];
  for (const u of findUntrackedPositions(broker, rows, baskets, row => contractHintFromRow(row, underlyings))) {
    const h = u.hint;
    if (u.trackedQty !== 0 || !h?.expiry) continue;
    // A live leg on the same contract without a broker id yet: it is ours, not an outside trade.
    const sameContract = baskets.some(b => b.broker === broker && b.underlying === h.underlying
      && b.legs.some(l => live(l) && l.option === h.option && l.strike === h.strike && (l.expiry || b.expiry) === h.expiry));
    if (sameContract) continue;
    let id = `mlf_out_${broker}_${u.ident}_${day}`.replace(/[^A-Za-z0-9_-]/g, '');
    for (let n = 2; ids.has(id); n++) id = `${id.replace(/_\d+$/, '')}_${n}`;
    ids.add(id);
    const leg = { ...legFromUntracked(u, { option: h.option, strike: h.strike, expiry: h.expiry }, u.untrackedQty, u.brokerAvg, lotSizeFor(h.underlying)), id: `${id}_leg` };
    out.push({
      id, underlying: h.underlying, expiry: h.expiry, broker, legs: [leg],
      riskConfig: { targetUnit: 'pts', slUnit: 'pts', armed: false },
      createdAt: nowIso, updatedAt: nowIso, rev: 1,
    });
  }
  // Futures on a known underlying become FUT legs (strike 0).
  const heldIds = new Set(baskets.filter(b => b.broker === broker)
    .flatMap(b => b.legs.filter(live).map(l => (broker === 'dhan' ? l.orderRef?.securityId : l.orderRef?.symbol))));
  for (const row of rows) {
    const net = Number(row.netQty) || 0;
    if (net === 0 || String(row.positionType ?? '').toUpperCase() === 'CLOSED') continue;
    const fut = futuresContractOf(row, underlyings);
    if (!fut) continue;
    const symbol = String(row.tradingSymbol ?? '');
    const ident = broker === 'dhan' ? String(row.securityId ?? '') : symbol;
    if (!ident || heldIds.has(ident)) continue;
    const sameContract = baskets.some(b => b.broker === broker && b.underlying === fut.underlying
      && b.legs.some(l => live(l) && l.option === 'FUT' && (l.expiry || b.expiry) === fut.expiry));
    if (sameContract) continue;
    let id = `mlf_out_${broker}_${ident}_${day}`.replace(/[^A-Za-z0-9_-]/g, '');
    for (let n = 2; ids.has(id); n++) id = `${id.replace(/_\d+$/, '')}_${n}`;
    ids.add(id);
    const side: 'B' | 'S' = net > 0 ? 'B' : 'S';
    const qty = Math.abs(net);
    const avgPrice = residualBrokerAvg(broker, row, side, baskets, false);
    const lotSize = lotSizeFor(fut.underlying);
    const leg: MultiLegLeg = {
      id: `${id}_leg`, side, option: 'FUT', strike: 0, expiry: fut.expiry,
      lots: lotSize > 0 ? Math.max(1, Math.round(qty / lotSize)) : 1,
      type: 'MARKET', price: avgPrice, status: 'OPEN', fill: { qty, avgPrice },
      orderRef: broker === 'dhan' ? { securityId: ident } : { symbol: ident },
    };
    out.push({
      id, underlying: fut.underlying, expiry: fut.expiry, broker, legs: [leg],
      riskConfig: { targetUnit: 'pts', slUnit: 'pts', armed: false },
      createdAt: nowIso, updatedAt: nowIso, rev: 1,
    });
  }
  return out;
}

/** A broker position the ledger cannot hold (futures, or an option it cannot identify). Read-only. */
export interface BrokerOnlyPosition {
  broker: string;
  ident: string;
  tradingSymbol: string;
  side: 'B' | 'S';
  qty: number;
  avgPrice: number;
  /** The broker's own unrealized P&L for the row, in rupees. */
  pnl: number;
  expiry: string | null;
  kind: 'FUT' | 'OPT';
}

/**
 * Every open broker position no live leg holds and outsidePositionBaskets will not adopt
 * (it adopts options with a known underlying, strike and expiry). The page lists these in
 * the Ungrouped trades table so nothing open at the broker is invisible.
 */
export function brokerOnlyPositions(
  baskets: MultiLegBasket[], broker: string, rows: Record<string, unknown>[], underlyings: string[],
): BrokerOnlyPosition[] {
  const held = new Set<string>();
  for (const b of baskets) {
    if (b.broker !== broker) continue;
    for (const l of b.legs) {
      if (l.status === 'CLOSED' || l.status === 'DRAFT' || l.status === 'FAILED') continue;
      const id = broker === 'dhan' ? l.orderRef?.securityId : l.orderRef?.symbol;
      if (id) held.add(id);
    }
  }
  const out: BrokerOnlyPosition[] = [];
  for (const row of rows) {
    const net = Number(row.netQty) || 0;
    if (net === 0 || String(row.positionType ?? '').toUpperCase() === 'CLOSED') continue;
    const tradingSymbol = String(row.tradingSymbol ?? row.tradingsymbol ?? '');
    const ident = broker === 'dhan' ? String(row.securityId ?? '') : tradingSymbol;
    if (!ident || held.has(ident)) continue;
    const hint = contractHintFromRow(row, underlyings);
    if (hint?.expiry || futuresContractOf(row, underlyings)) continue;   // the poll adopts these as ungrouped trades
    const side: 'B' | 'S' = net > 0 ? 'B' : 'S';
    const isOpt = /\b(CE|PE|CALL|PUT)\b/i.test(String(row.drvOptionType ?? '')) || /-(CE|PE)$/i.test(tradingSymbol);
    const expiry = String(row.drvExpiryDate ?? '').slice(0, 10) || null;
    out.push({
      broker, ident, tradingSymbol, side, qty: Math.abs(net),
      avgPrice: Number((side === 'B' ? row.buyAvg : row.sellAvg) || row.costPrice || 0),
      // Dhan leaves the contract multiplier out of unrealizedProfit (MCX x10 / x100).
      pnl: (Number(row.unrealizedProfit ?? 0) || 0) * (Number(row.multiplier) || 1),
      expiry: expiry && expiry !== '0001-01-01' ? expiry : null,
      kind: isOpt ? 'OPT' : 'FUT',
    });
  }
  return out;
}
