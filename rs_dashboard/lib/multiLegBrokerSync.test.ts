import test from 'node:test';
import assert from 'node:assert/strict';
import { growLegToBroker, outsidePositionBaskets, brokerOnlyPositions, ltpFromBrokerRow, brokersToPoll } from './multiLegBrokerSync.ts';
import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';
import { withKotakContracts, type KotakSymbolMap } from './kotakPositionContracts.ts';

const leg = (o: Partial<MultiLegLeg> = {}): MultiLegLeg => ({
  id: 'l', side: 'S', option: 'CE', strike: 23800, expiry: '2026-11-23', lots: 2, type: 'MARKET', status: 'OPEN',
  fill: { qty: 130, avgPrice: 100 }, orderRef: { securityId: '64387' }, ...o,
});
const bk = (legs: MultiLegLeg[]): MultiLegBasket => ({ id: 'b', underlying: 'NIFTY', expiry: '2026-11-23', broker: 'dhan', legs, createdAt: '', updatedAt: '' });
const row = (o: Record<string, unknown> = {}) => ({
  securityId: '47169', tradingSymbol: 'NIFTY-Oct2026-23150-CE', netQty: -260, positionType: 'SHORT',
  sellAvg: 37.45, sellQty: 260, drvStrikePrice: 23150, drvOptionType: 'CALL', drvExpiryDate: '2026-10-19 14:30:00', ...o,
});
const adopt = (baskets: MultiLegBasket[], rows: Record<string, unknown>[]) =>
  outsidePositionBaskets(baskets, 'dhan', rows, ['NIFTY'], () => 65, '2026-10-07', 'now');

test('grow: an outside add grows the leg, blending the average', () => {
  const g = growLegToBroker(leg(), 195, 79.4, 65);
  assert.equal(g.fill!.qty, 195);
  assert.equal(g.lots, 3);
  assert.equal(Math.round(g.fill!.avgPrice * 100) / 100, 93.13);
});

test('grow: never shrinks, never touches a closed or unfilled leg', () => {
  const l = leg();
  assert.equal(growLegToBroker(l, 65, 50, 65), l);
  assert.equal(growLegToBroker(leg({ status: 'CLOSED' }), 195, 50, 65).fill!.qty, 130);
  assert.equal(growLegToBroker(leg({ fill: undefined }), 195, 50, 65).fill, undefined);
});

test('adopt: a broker position no leg holds becomes an ungrouped trade', () => {
  const [b] = adopt([bk([leg()])], [row()]);
  assert.equal(b.legs.length, 1);
  assert.equal(b.legs[0].strike, 23150);
  assert.equal(b.legs[0].fill!.qty, 260);
  assert.equal(b.legs[0].lots, 4);
  assert.equal(b.groupName, undefined);
  // deterministic: building twice gives the same id
  assert.equal(adopt([bk([leg()])], [row()])[0].id, b.id);
});

test('adopt: stands down while our own orders may be landing, and skips our unidentified legs', () => {
  assert.equal(adopt([bk([leg({ status: 'PLACING' })])], [row()]).length, 0);
  assert.equal(adopt([bk([leg({ filledAt: Date.now() })])], [row()]).length, 0);
  const ours = leg({ strike: 23150, expiry: '2026-10-19', orderRef: {} });
  assert.equal(adopt([bk([ours])], [row()]).length, 0);
});

test('adopt: a partly tracked contract is not duplicated (growLegToBroker handles it)', () => {
  const held = leg({ strike: 23150, expiry: '2026-10-19', orderRef: { securityId: '47169' } });
  assert.equal(adopt([bk([held])], [row()]).length, 0);
});

test('broker-only: futures on an unknown underlying are listed; held or adoptable ones are not', () => {
  const fut = { securityId: '569901', tradingSymbol: 'RELIANCE-19Oct2026-FUT', netQty: -10, positionType: 'SHORT', sellAvg: 8575.7, unrealizedProfit: -1423, drvOptionType: 'NA', drvStrikePrice: 0, drvExpiryDate: '2026-10-19' };
  const flat = { ...fut, securityId: '1', netQty: 0, positionType: 'CLOSED' };
  const heldOpt = row({ securityId: '64387', tradingSymbol: 'NIFTY-Nov2026-23800-CE' });
  const adoptable = row();
  const list = brokerOnlyPositions([bk([leg()])], 'dhan', [fut, flat, heldOpt, adoptable], ['NIFTY', 'CRUDEOILM']);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].tradingSymbol, list[0].side, list[0].qty, list[0].kind, list[0].pnl], ['RELIANCE-19Oct2026-FUT', 'S', 10, 'FUT', -1423]);
  // the broker's unrealizedProfit is scaled by the row's multiplier
  assert.equal(brokerOnlyPositions([], 'dhan', [{ ...fut, multiplier: 10 }], ['NIFTY'])[0].pnl, -14230);
});

const futRow = {
  securityId: '569901', tradingSymbol: 'CRUDEOILM-19Oct2026-FUT', netQty: -10, positionType: 'SHORT', exchangeSegment: 'MCX_COMM',
  costPrice: 8575.7, sellAvg: 8575.7, sellQty: 10, unrealizedProfit: -1573, multiplier: 10, drvOptionType: 'NA', drvStrikePrice: 0, drvExpiryDate: '2026-10-19',
};

test('futures: a broker futures position becomes a FUT leg; nothing is left broker-only', () => {
  const [b] = outsidePositionBaskets([], 'dhan', [futRow], ['CRUDEOIL', 'CRUDEOILM'], () => 1, '2026-10-07', 'now');
  assert.equal(b.underlying, 'CRUDEOILM');   // not CRUDEOIL: longest name matches first
  const l = b.legs[0];
  assert.deepEqual([l.option, l.strike, l.side, l.fill!.qty, l.fill!.avgPrice, l.expiry, l.orderRef?.securityId], ['FUT', 0, 'S', 10, 8575.7, '2026-10-19', '569901']);
  assert.equal(brokerOnlyPositions([], 'dhan', [futRow], ['CRUDEOIL', 'CRUDEOILM']).length, 0);
  // once held, it is not adopted again
  assert.equal(outsidePositionBaskets([b], 'dhan', [futRow], ['CRUDEOIL', 'CRUDEOILM'], () => 1, '2026-10-07', 'now').length, 0);
});

test('futures: live price is recovered from the broker row, and the leg P&L matches the broker', async () => {
  const { legPnl } = await import('./multiLegFocus.ts');
  const ltp = ltpFromBrokerRow(futRow);
  // Real case 2026-10-07: cost 8575.7, unrealized -1453 on -10 lots, quote 8721. Dhan leaves the x10 out.
  assert.equal(Math.round(ltpFromBrokerRow({ ...futRow, unrealizedProfit: -1453 }) * 100) / 100, 8721);
  assert.equal(Math.round(ltp * 100) / 100, 8733);
  const [b] = outsidePositionBaskets([], 'dhan', [futRow], ['CRUDEOILM'], () => 1, '2026-10-07', 'now');
  assert.equal(Math.round(legPnl(b.legs[0], ltp, 10)), -15730);   // the broker's -1573 x multiplier 10
});

test('futures: the synthetic payoff pair prices the open P&L like the broker', async () => {
  const { futuresAsSyntheticPayoffLegs } = await import('./multiLegFocus.ts');
  const { buildPayoffModel } = await import('./optionsPayoff.ts');
  const legs = futuresAsSyntheticPayoffLegs(-100, 8575.7, '2026-10-19', 8733);
  const m = buildPayoffModel({ spot: 8733, legs, fallbackIv: 0.2, strikeStep: 10 })!;
  assert.ok(m.maxLossUnlimited);   // a short future has unlimited risk
  // Open P&L today is -100 x (8733 - 8575.7) = -15730, to within the e^-rT discount (~0.2%).
  assert.ok(Math.abs(m.nowPnl - -15730) < 60, String(m.nowPnl));
});

test('an open leg with no live price has no P&L, and a group with futures never fires a points/% Target or SL', async () => {
  const { legPnl, computeStrategyMetrics, checkStrategyRisk } = await import('./multiLegFocus.ts');
  const fut: MultiLegLeg = { id: 'f', side: 'S', option: 'FUT', strike: 0, expiry: '2026-10-19', lots: 10, type: 'MARKET', status: 'OPEN', fill: { qty: 10, avgPrice: 8575.7 } };
  assert.equal(legPnl(fut, 0, 10), 0);            // was +857,570 (valued against 0)
  const put: MultiLegLeg = { id: 'p', side: 'S', option: 'PE', strike: 8000, expiry: '2026-10-15', lots: 20, type: 'MARKET', status: 'OPEN', fill: { qty: 20, avgPrice: 90.29 } };
  const m = computeStrategyMetrics([put, fut], l => (l.option === 'FUT' ? 8721 : 65), 10);
  assert.equal(m.hasFutures, true);
  assert.equal(Math.round(m.totalPnlRupees), Math.round(20 * (90.29 - 65) * 10 + 10 * (8575.7 - 8721) * 10));
  assert.equal(checkStrategyRisk(m, { targetUnit: 'pts', slUnit: 'pts', armed: true, slValue: 1, targetValue: 1 }), null);
});

test('kotak: a book stamped from the instrument cache is adopted (options and futures), nothing left BROKER ONLY', () => {
  // The 2026-10-17 Kotak book that showed three "BROKER ONLY · FUT" rows: monthly NIFTY symbols carry no expiry day.
  const map: KotakSymbolMap = {
    NIFTY26OCT22500PE: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 22500, side: 'PE' },
    NIFTY27MAR24000PE: { underlying: 'NIFTY', expiry: '2027-03-30', strike: 24000, side: 'PE' },
    CRUDEOILM19NOV26FUT: { underlying: 'CRUDEOILM', expiry: '2026-11-19', strike: 0, side: 'FUT' },
  };
  const kRow = (tradingSymbol: string, netQty: number, avg: number) => ({
    tradingSymbol, securityId: '1', exchange: 'nse_fo', productType: 'NRML', netQty,
    buyQty: netQty > 0 ? netQty : 0, sellQty: netQty < 0 ? -netQty : 0, buyAvg: netQty > 0 ? avg : 0, sellAvg: netQty < 0 ? avg : 0,
  });
  const raw = [kRow('NIFTY26OCT22500PE', -390, 36.75), kRow('NIFTY27MAR24000PE', 130, 868.2), kRow('CRUDEOILM19NOV26FUT', -150, 9393)];
  const U = ['NIFTY', 'CRUDEOILM'];

  // Before: nothing identifiable, and the NIFTY options were labelled futures.
  assert.deepEqual(brokerOnlyPositions([], 'kotak', raw, U).map(p => `${p.tradingSymbol}:${p.kind}`),
    ['NIFTY26OCT22500PE:OPT', 'NIFTY27MAR24000PE:OPT', 'CRUDEOILM19NOV26FUT:FUT']);

  const rows = withKotakContracts(raw, map);
  assert.deepEqual(brokerOnlyPositions([], 'kotak', rows, U), []);
  const adopted = outsidePositionBaskets([], 'kotak', rows, U, () => 65, '2026-10-17', 'now');
  assert.deepEqual(adopted.map(b => { const l = b.legs[0]; return `${b.underlying} ${l.side} ${l.strike} ${l.option} ${l.expiry} ${l.fill!.qty} ${l.orderRef!.symbol}`; }), [
    'NIFTY S 22500 PE 2026-10-27 390 NIFTY26OCT22500PE',
    'NIFTY B 24000 PE 2027-03-30 130 NIFTY27MAR24000PE',
    'CRUDEOILM S 0 FUT 2026-11-19 150 CRUDEOILM19NOV26FUT',
  ]);
});

test('brokersToPoll: the selected broker, plus brokers that still have live, waiting, pending or closed-today work', () => {
  const today = '2026-10-17';
  const at = (day: string) => Date.parse(`${day}T06:00:00Z`);
  const b = (broker: string, legs: MultiLegLeg[], extra: Partial<MultiLegBasket> = {}): MultiLegBasket => ({ ...bk(legs), id: broker, broker, ...extra });
  assert.deepEqual(brokersToPoll([], 'kotak', today), ['kotak']);
  // Dhan holds only drafts, failures and yesterday's closes: not polled from a Kotak page.
  assert.deepEqual(brokersToPoll([
    b('dhan', [leg({ status: 'DRAFT' }), leg({ status: 'FAILED' }), leg({ status: 'CLOSED', closedAt: at('2026-10-16') })]),
  ], 'kotak', today), ['kotak']);
  assert.deepEqual(brokersToPoll([b('dhan', [leg()])], 'kotak', today), ['kotak', 'dhan']);
  assert.deepEqual(brokersToPoll([b('dhan', [leg({ status: 'CLOSED', closedAt: at(today) })])], 'kotak', today), ['kotak', 'dhan']);
  assert.deepEqual(brokersToPoll([b('dhan', [leg({ status: 'CLOSED', closedAt: at('2026-10-16'), pendingOrders: [{ id: '1', kind: 'exit', qty: 65, at: 0 }] })])], 'kotak', today), ['kotak', 'dhan']);
  assert.deepEqual(brokersToPoll([b('zerodha', [], { waitingEntries: [{ orderId: '9' } as never] })], 'dhan', today), ['dhan', 'zerodha']);
});
