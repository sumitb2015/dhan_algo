import test from 'node:test';
import assert from 'node:assert/strict';
import { paperPosition, realPosition } from './pnfLadderPosition.ts';
import { bookPnl } from './pnfAccount.ts';

test('paper: a short straddle is SHORT with the combined entry premium and a live P&L', () => {
  const p = paperPosition([{ lots: -2, avg: 100, realised: 0 }, { lots: -2, avg: 90, realised: 0 }], [95, 85], [65, 65]);
  assert.equal(p?.side, 'SHORT'); assert.equal(p?.avg, 190); assert.equal(p?.lots, 2);
  assert.equal(p?.pnl, ((95 - 100) * -2 + (85 - 90) * -2) * 65);
});

test('paper: flat has no position, one leg open is MIXED with no entry, a missing price makes P&L unknown', () => {
  assert.equal(paperPosition([{ lots: 0, avg: 0, realised: 500 }], [100], [65]), null);
  assert.deepEqual(paperPosition([{ lots: 1, avg: 100, realised: 0 }, { lots: 0, avg: 0, realised: 0 }], [100, 90], [65, 65])?.side, 'MIXED');
  assert.equal(paperPosition([{ lots: 1, avg: 100, realised: 0 }], [null], [65])?.pnl, null);
});

test('real: entry is the broker buy / sell average of the side the leg is open on; unpriced legs hide the P&L', () => {
  const rows = [
    { securityId: '1', netQty: -130, sellAvg: 100, buyAvg: 0, realizedProfit: 0, unrealizedProfit: 300, lastTradedPrice: 98 },
    { securityId: '2', netQty: -130, sellAvg: 90, buyAvg: 0, realizedProfit: 0, unrealizedProfit: 200, lastTradedPrice: 88 },
  ];
  const p = realPosition(rows, false, ['1', '2'], [-2, -2], bookPnl(rows));
  assert.deepEqual(p, { side: 'SHORT', lots: 2, avg: 190, pnl: 500 });
  const un = [{ ...rows[0], lastTradedPrice: 0 }, rows[1]];
  assert.equal(realPosition(un, false, ['1', '2'], [-2, -2], bookPnl(un))?.pnl, null);
});
