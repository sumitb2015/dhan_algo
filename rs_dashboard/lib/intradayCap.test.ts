import { test } from 'node:test';
import assert from 'node:assert';
import { capCloseQty } from './intradayCap.ts';

const row = { securityId: '73906', productType: 'INTRADAY', exchangeSegment: 'NSE_FNO', netQty: -260 };
const t = (side: string, q: number, product = 'INTRADAY', id = '73906') =>
  ({ securityId: id, productType: product, transactionType: side, tradedQuantity: q });

test('2026-09-25 case: INTRADAY short 130 reported as 260 is capped to 130', () => {
  const r = capCloseQty(row, [t('SELL', 65), t('SELL', 65), t('SELL', 130, 'MARGIN')], 260);
  assert.deepStrictEqual([r.qty, r.capped, r.mismatch], [130, true, false]);
});

test('consistent book is untouched', () => {
  const r = capCloseQty({ ...row, netQty: -130 }, [t('SELL', 130)], 130);
  assert.deepStrictEqual([r.qty, r.capped], [130, false]);
});

test('partial request below the own net is not raised or capped', () => {
  assert.strictEqual(capCloseQty({ ...row, netQty: -130 }, [t('SELL', 130)], 65).qty, 65);
});

test('MARGIN and non-F&O rows are never capped', () => {
  assert.strictEqual(capCloseQty({ ...row, productType: 'MARGIN' }, [t('SELL', 65, 'MARGIN')], 260).qty, 260);
  assert.strictEqual(capCloseQty({ ...row, exchangeSegment: 'MCX_COMM' }, [t('SELL', 65)], 260).qty, 260);
});

test('contradictory or missing trades report a mismatch but do not change qty', () => {
  const r = capCloseQty(row, [t('BUY', 65)], 260);
  assert.deepStrictEqual([r.qty, r.capped, r.mismatch], [260, false, true]);
  assert.strictEqual(capCloseQty(row, null, 260).qty, 260);
  assert.strictEqual(capCloseQty(row, [], 260).mismatch, true);
});

test('other securities and closed-out books are ignored', () => {
  const r = capCloseQty(row, [t('SELL', 999, 'INTRADAY', '1'), t('SELL', 130), t('BUY', 130)], 260);
  assert.strictEqual(r.mismatch, true);
});
