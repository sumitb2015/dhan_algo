import { test } from 'node:test';
import assert from 'node:assert';
import {
  positionProduct, positionKey, findLivePosition, closeOrderProduct, isIntradayProduct,
} from './positionProduct.ts';

const row = (tradingSymbol: string, productType: string, netQty = 75) =>
  ({ tradingSymbol, productType, netQty } as Record<string, unknown>);

test('positionProduct reads the normalised field and upper-cases it', () => {
  assert.strictEqual(positionProduct({ productType: 'INTRADAY' }), 'INTRADAY');
  assert.strictEqual(positionProduct({ productType: 'nrml' }), 'NRML');
  assert.strictEqual(positionProduct({ productType: ' MIS ' }), 'MIS');
  // Kite's own key, in case a raw row ever reaches this without shaping.
  assert.strictEqual(positionProduct({ product: 'NRML' }), 'NRML');
  assert.strictEqual(positionProduct({}), '');
  assert.strictEqual(positionProduct({ productType: null }), '');
});

test('positionKey separates the same symbol held under two products', () => {
  const intraday = row('NIFTY25000CE', 'INTRADAY');
  const margin   = row('NIFTY25000CE', 'MARGIN');
  assert.notStrictEqual(positionKey(intraday), positionKey(margin));
  assert.strictEqual(positionKey(intraday), positionKey(row('NIFTY25000CE', 'INTRADAY', 150)));
});

test('findLivePosition matches on symbol AND product', () => {
  const book = [row('NIFTY25000CE', 'INTRADAY', 75), row('NIFTY25000CE', 'MARGIN', 150)];

  const intraday = findLivePosition(book, row('NIFTY25000CE', 'INTRADAY'));
  assert.strictEqual(intraday.kind, 'match');
  assert.strictEqual((intraday as { row: Record<string, unknown> }).row.netQty, 75);

  const margin = findLivePosition(book, row('NIFTY25000CE', 'MARGIN'));
  assert.strictEqual(margin.kind, 'match');
  assert.strictEqual((margin as { row: Record<string, unknown> }).row.netQty, 150);
});

test('findLivePosition reports flat when that product is gone but the symbol remains', () => {
  const book = [row('NIFTY25000CE', 'MARGIN', 150)];
  assert.strictEqual(findLivePosition(book, row('NIFTY25000CE', 'INTRADAY')).kind, 'flat');
});

test('findLivePosition reports flat when the symbol is absent entirely', () => {
  assert.strictEqual(findLivePosition([], row('NIFTY25000CE', 'INTRADAY')).kind, 'flat');
  assert.strictEqual(
    findLivePosition([row('NIFTY25100PE', 'INTRADAY')], row('NIFTY25000CE', 'INTRADAY')).kind,
    'flat',
  );
});

test('a productless row falls back to symbol-only ONLY when unambiguous', () => {
  const one = [row('NIFTY25000CE', 'INTRADAY', 75)];
  const hit = findLivePosition(one, { tradingSymbol: 'NIFTY25000CE' });
  assert.strictEqual(hit.kind, 'match');
  assert.strictEqual((hit as { row: Record<string, unknown> }).row.netQty, 75);

  const two = [row('NIFTY25000CE', 'INTRADAY', 75), row('NIFTY25000CE', 'MARGIN', 150)];
  const ambiguous = findLivePosition(two, { tradingSymbol: 'NIFTY25000CE' });
  assert.strictEqual(ambiguous.kind, 'ambiguous');
  assert.strictEqual((ambiguous as { count: number }).count, 2);
});

test('closeOrderProduct maps Dhan vocabulary to productType', () => {
  assert.deepStrictEqual(closeOrderProduct('dhan', 'INTRADAY'), { fields: { productType: 'INTRADAY' }, assumed: false });
  assert.deepStrictEqual(closeOrderProduct('dhan', 'MARGIN'),   { fields: { productType: 'MARGIN' },   assumed: false });
  assert.deepStrictEqual(closeOrderProduct('dhan', 'CNC'),      { fields: { productType: 'CNC' },      assumed: false });
  assert.deepStrictEqual(closeOrderProduct('dhan', 'margin'),   { fields: { productType: 'MARGIN' },   assumed: false });
});

test('closeOrderProduct maps Kite/Neo vocabulary to product', () => {
  for (const broker of ['zerodha', 'kotak'] as const) {
    assert.deepStrictEqual(closeOrderProduct(broker, 'MIS'),  { fields: { product: 'MIS' },  assumed: false });
    assert.deepStrictEqual(closeOrderProduct(broker, 'NRML'), { fields: { product: 'NRML' }, assumed: false });
    assert.deepStrictEqual(closeOrderProduct(broker, 'CNC'),  { fields: { product: 'CNC' },  assumed: false });
  }
});

test('cross-vocabulary products are refused, not silently defaulted', () => {
  // The bug this module exists to prevent: anything unmappable must return null
  // so the caller refuses, rather than omitting the field and letting the order
  // route default to intraday.
  assert.strictEqual(closeOrderProduct('dhan', 'NRML'), null);
  assert.strictEqual(closeOrderProduct('dhan', 'MIS'), null);
  assert.strictEqual(closeOrderProduct('zerodha', 'MARGIN'), null);
  assert.strictEqual(closeOrderProduct('kotak', 'INTRADAY'), null);
});

test('broker-managed CO/BO legs are refused', () => {
  assert.strictEqual(closeOrderProduct('dhan', 'CO'), null);
  assert.strictEqual(closeOrderProduct('dhan', 'BO'), null);
  assert.strictEqual(closeOrderProduct('zerodha', 'CO'), null);
});

test('an unreported product falls back to the route default, flagged as assumed', () => {
  assert.deepStrictEqual(closeOrderProduct('dhan', ''), { fields: {}, assumed: true });
  assert.deepStrictEqual(closeOrderProduct('zerodha', '   '), { fields: {}, assumed: true });
});

test('isIntradayProduct recognises INTRADAY (Dhan) and MIS (Kite/Neo), case- and whitespace-insensitively', () => {
  assert.strictEqual(isIntradayProduct('INTRADAY'), true);
  assert.strictEqual(isIntradayProduct('intraday'), true);
  assert.strictEqual(isIntradayProduct(' MIS '), true);
  assert.strictEqual(isIntradayProduct('mis'), true);
});

test('isIntradayProduct treats carried-forward and unknown products as NOT intraday', () => {
  assert.strictEqual(isIntradayProduct('MARGIN'), false);
  assert.strictEqual(isIntradayProduct('NRML'), false);
  assert.strictEqual(isIntradayProduct('CNC'), false);
  assert.strictEqual(isIntradayProduct(''), false);
  // @ts-expect-error exercising a broker payload with no product field at all
  assert.strictEqual(isIntradayProduct(undefined), false);
});
