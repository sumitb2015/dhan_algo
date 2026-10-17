import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateLiveQty, stampOwnEntries, ownEntryFromTrades, legEntryPrice, legEntryIsOwn, legUnrealizedPnl,
  ledgerLegKey, findBrokerRow, reconcileBasket, type LedgerBasket, type LedgerLeg,
} from './liveChartsLedger.ts';

const leg = (over: Partial<LedgerLeg> = {}): LedgerLeg => ({
  securityId: '51321', exchangeSegment: 'NSE_FNO', strike: 22300, optionType: 'PE', action: 'SELL',
  productType: 'INTRADAY', qty: 130, entryOrderIds: ['o1'], exitOrderIds: [], lastOrderAt: 0, ...over,
});
const basket = (id: string, createdAt: number, legs: LedgerLeg[]): LedgerBasket =>
  ({ id, title: id, underlying: 'NIFTY', expiry: '2026-10-27', createdAt, legs });
const row = { securityId: '51321', productType: 'INTRADAY', netQty: -130, sellAvg: 125.13, buyAvg: 0, unrealizedProfit: -1300 };

test('two baskets on one contract share the position instead of both claiming it', () => {
  // One basket's 130 was closed outside; the broker holds 130, both ledgers say 130.
  const a = basket('a', 1, [leg()]);
  const b = basket('b', 2, [leg({ entryOrderIds: ['o2'] })]);
  const alloc = allocateLiveQty([b, a], [row]);
  assert.equal(alloc.get(ledgerLegKey('a', 0)), 130);
  assert.equal(alloc.get(ledgerLegKey('b', 0)), 0);
  // So the P&L shares add up to the broker's figure, not twice it.
  const total = legUnrealizedPnl(row, alloc.get('a:0')!) + legUnrealizedPnl(row, alloc.get('b:0')!);
  assert.equal(total, -1300);
});

test('allocation still clamps to the broker and ignores the opposite direction', () => {
  assert.equal(allocateLiveQty([basket('a', 1, [leg({ qty: 260 })])], [row]).get('a:0'), 130);
  assert.equal(allocateLiveQty([basket('a', 1, [leg({ action: 'BUY' })])], [row]).get('a:0'), 0);
  assert.equal(allocateLiveQty([basket('a', 1, [leg({ qty: 0 })])], [row]).get('a:0'), 0);
});

test('a leg\'s entry is its own fills, the pooled average only as a marked fallback', () => {
  const l = leg({ entryOrderIds: ['o1'] });
  const trades = [
    { orderId: 'o1', securityId: '51321', tradedQuantity: 65, tradedPrice: 60 },
    { orderId: 'o1', securityId: '51321', tradedQuantity: 65, tradedPrice: 64 },
    { orderId: 'other', securityId: '51321', tradedQuantity: 130, tradedPrice: 190 },
  ];
  assert.equal(ownEntryFromTrades(l, trades), 62);
  assert.equal(legEntryPrice(row, l), 125.13);
  assert.equal(legEntryIsOwn(l), false);

  const [b] = stampOwnEntries([basket('a', 1, [l])], trades);
  assert.equal(legEntryPrice(row, b.legs[0]), 62);
  assert.equal(legEntryIsOwn(b.legs[0]), true);
  // Nothing new: same array back.
  const same = [b];
  assert.equal(stampOwnEntries(same, trades), same);
});

test('a leg holding the whole basket\'s order ids only averages its own contract', () => {
  // Legacy leg: entryOrderIds has both legs' orders; CE filled at 100, PE at 80.
  const pe = leg({ entryOrderIds: ['oCE', 'oPE'] });
  const trades = [
    { orderId: 'oCE', securityId: '51320', tradedQuantity: 130, tradedPrice: 100 },
    { orderId: 'oPE', securityId: '51321', tradedQuantity: 130, tradedPrice: 80 },
  ];
  assert.equal(ownEntryFromTrades(pe, trades), 80);
});

// ── Kotak baskets: matched by trading symbol (Kotak's securityId is its own token), products MIS / NRML ──
const KSYM = 'NIFTY26O2722300PE';
const kLeg = (over: Partial<LedgerLeg> = {}) => leg({ securityId: '', tradingSymbol: KSYM, exchangeSegment: 'nse_fo', productType: 'MARGIN', ...over });
const kBasket = (id: string, createdAt: number, legs: LedgerLeg[]): LedgerBasket => ({ ...basket(id, createdAt, legs), broker: 'kotak' });
// shapeKotakPosition: tradingSymbol, Kotak's own token in securityId, product NRML.
const kRow = { tradingSymbol: KSYM, securityId: '51331', productType: 'NRML', netQty: -130, sellAvg: 101, unrealizedProfit: -650 };

test('Kotak: a leg finds its row by trading symbol, NRML = MARGIN, MIS = INTRADAY; never by Kotak\'s token', () => {
  assert.equal(findBrokerRow([kRow], kLeg(), 'kotak'), kRow);
  assert.equal(findBrokerRow([kRow], kLeg({ productType: 'INTRADAY' }), 'kotak'), null);
  assert.equal(findBrokerRow([{ ...kRow, productType: 'MIS' }], kLeg({ productType: 'INTRADAY' }), 'kotak')?.netQty, -130);
  // Kotak's securityId (its own token) is never used: a leg with only that id finds nothing.
  assert.equal(findBrokerRow([kRow], kLeg({ tradingSymbol: undefined, securityId: '51331' }), 'kotak'), null);
});

test('Kotak: allocation and reconcile read only the basket\'s own broker book', () => {
  const k = kBasket('k', 1, [kLeg({ qty: 195 })]);
  const d = basket('d', 2, [leg()]);
  const alloc = allocateLiveQty([k, d], [kRow], 'kotak');
  assert.equal(alloc.get('k:0'), 130, 'clamped to the Kotak book');
  assert.equal(alloc.get('d:0'), 0, 'a Dhan basket owns nothing in the Kotak book');
  // A Dhan book (here: empty) says nothing about a Kotak basket: it is not clamped to 0.
  assert.equal(reconcileBasket(k, [], 1e15, 'dhan'), k);
  assert.equal(reconcileBasket(k, [kRow], 1e15, 'kotak').legs[0].qty, 130);
  assert.equal(reconcileBasket(d, [kRow], 1e15, 'kotak'), d);
});

test('Kotak: own entry from Kotak trades by symbol; another broker\'s basket is not stamped', () => {
  const k = kBasket('k', 1, [kLeg({ entryOrderIds: ['K1'] })]);
  const d = basket('d', 2, [leg({ entryOrderIds: ['K1'] })]);
  const trades = [{ orderId: 'K1', securityId: '51331', tradingSymbol: KSYM, tradedQuantity: 130, tradedPrice: 99.5 }];
  const out = stampOwnEntries([k, d], trades, 'kotak');
  assert.equal(out[0].legs[0].entryPrice, 99.5);
  assert.equal(out[1], d);
});

test('Kotak rows are priced from the chain; an unpriceable open row is marked unknown, never ₹0', async () => {
  const { priceRowsFromChain, rowPnlUnknown } = await import('./liveChartsLedger.ts');
  const rows = [
    { ...kRow, drvOptionType: 'PUT', drvStrikePrice: 22300, drvExpiryDate: '2026-10-27' },       // short 130 @ 101
    { tradingSymbol: 'NIFTY26O2722400CE', netQty: 65, buyAvg: 50, productType: 'NRML' },           // contract unknown
    { tradingSymbol: 'NIFTY26O2722500CE', netQty: 0 },                                             // flat: untouched
  ];
  const ltp = (u: string, e: string, k: number, o: 'CE' | 'PE') => (u === 'NIFTY' && e === '2026-10-27' && k === 22300 && o === 'PE' ? 96 : null);
  const out = priceRowsFromChain(rows, ltp, s => (s.startsWith('NIFTY') ? 'NIFTY' : null));
  assert.equal(out[0].lastTradedPrice, 96);
  assert.equal(out[0].unrealizedProfit, (96 - 101) * -130);   // +650 on the short
  assert.equal(rowPnlUnknown(out[0]), false);
  assert.equal(rowPnlUnknown(out[1]), true);
  assert.equal(out[2], rows[2]);
});
