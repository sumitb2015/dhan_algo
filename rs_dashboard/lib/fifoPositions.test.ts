import { test } from 'node:test';
import assert from 'node:assert';
import { matchTradesFifo } from './fifoPositions.ts';

test('matchTradesFifo applies the CRUDEOILM 10x contract multiplier to realized P&L', () => {
  // Reproduces a real report: two CRUDEOILM-FUT round trips displayed
  // +₹199/-₹126 (net +₹73) when the true realized P&L, accounting for the
  // 10 barrels/lot multiplier, is +₹1990.10/-₹1260 (net +₹730.10).
  const trades = [
    { tradingSymbol: 'CRUDEOILM-21Sep2026-FUT', transactionType: 'SELL', tradedQuantity: 7, tradedPrice: 9972.43, createTime: '2026-09-14 17:24:24' },
    { tradingSymbol: 'CRUDEOILM-21Sep2026-FUT', transactionType: 'BUY', tradedQuantity: 7, tradedPrice: 9944.00, createTime: '2026-09-14 19:08:55' },
  ];
  const { exitedList } = matchTradesFifo(trades);
  assert.strictEqual(exitedList.length, 1);
  assert.strictEqual(exitedList[0].side, 'SELL');
  assert.ok(Math.abs(exitedList[0].points - 28.43) < 0.01);
  assert.ok(Math.abs(exitedList[0].pnl - 1990.1) < 0.01, `expected ~1990.1, got ${exitedList[0].pnl}`);
});

test('matchTradesFifo does not multiply P&L for a non-MCX symbol', () => {
  const trades = [
    { tradingSymbol: 'NIFTY15SEP23400CALL', transactionType: 'BUY', tradedQuantity: 65, tradedPrice: 100, createTime: '2026-09-15 10:00:00' },
    { tradingSymbol: 'NIFTY15SEP23400CALL', transactionType: 'SELL', tradedQuantity: 65, tradedPrice: 110, createTime: '2026-09-15 10:05:00' },
  ];
  const { exitedList } = matchTradesFifo(trades);
  assert.strictEqual(exitedList.length, 1);
  assert.strictEqual(exitedList[0].pnl, 650); // 10 pts * 65 qty * 1x
});

test('matchTradesFifo resolves CRUDEOILM (10x), not CRUDEOIL (100x), for a CRUDEOILM symbol', () => {
  // CRUDEOILM is a prefix-superset of CRUDEOIL's own root ("CRUDEOIL" is a
  // literal prefix of "CRUDEOILM") — a naive first-match lookup would find
  // CRUDEOIL's 100x multiplier first and overstate P&L 10x.
  const trades = [
    { tradingSymbol: 'CRUDEOILM21SEP26FUT', transactionType: 'BUY', tradedQuantity: 1, tradedPrice: 100, createTime: '2026-09-14 10:00:00' },
    { tradingSymbol: 'CRUDEOILM21SEP26FUT', transactionType: 'SELL', tradedQuantity: 1, tradedPrice: 101, createTime: '2026-09-14 10:05:00' },
  ];
  const { exitedList } = matchTradesFifo(trades);
  assert.strictEqual(exitedList[0].pnl, 10); // 1 pt * 1 qty * 10x (CRUDEOILM), not 100x
});
