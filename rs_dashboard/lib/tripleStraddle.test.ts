import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brokerCapacity, entryPremium, evaluateRisk, pnlSummary, exitQtyForLeg, openPositionFor, pruneState, straddlePnl, straddlePnlPct,
  totalPnl, upsertPosition, validateTrade, type TsPosition, type TsState,
} from './tripleStraddle.ts';

function pos(over: Partial<TsPosition> = {}): TsPosition {
  return {
    id: 'a', slot: 'center', mode: 'SIM', side: 'S', underlying: 'NIFTY', expiry: '2026-10-13',
    strike: 25000, lots: 2, lotSize: 65, product: 'INTRADAY', status: 'OPEN',
    legs: [
      { option: 'CE', qty: 130, entry: 100, orderIds: [] },
      { option: 'PE', qty: 130, entry: 80, orderIds: [] },
    ],
    risk: { armed: true, slPct: 30, targetPct: 50 },
    openedAt: 1, ...over,
  };
}

test('short straddle pnl: premium decay is profit', () => {
  assert.equal(straddlePnl(pos(), { CE: 90, PE: 70 }), (10 + 10) * 130);
  assert.equal(entryPremium(pos()), 180);
});

test('long straddle pnl is the mirror', () => {
  assert.equal(straddlePnl(pos({ side: 'B' }), { CE: 90, PE: 70 }), -(20 * 130));
});

test('unknown live price yields null, never 0', () => {
  assert.equal(straddlePnl(pos(), { CE: 90 }), null);
  assert.equal(straddlePnl(pos(), { CE: 90, PE: 0 }), null);
});

test('closed legs use their exit price, not live', () => {
  const p = pos();
  p.legs[0] = { ...p.legs[0], closed: true, exit: 60 };
  assert.equal(straddlePnl(p, { PE: 80 }), 40 * 130);
});

test('risk: target, stop, disarmed, unpriced, half-closed', () => {
  // basis 180*130; target 50% => combined premium falls 90 -> pnl 90/unit
  assert.equal(evaluateRisk(pos(), { CE: 55, PE: 35 }), 'TARGET');
  assert.equal(evaluateRisk(pos(), { CE: 130, PE: 104 }), 'SL'); // +54 against = -30%
  assert.equal(evaluateRisk(pos(), { CE: 100, PE: 80 }), null);
  assert.equal(evaluateRisk(pos({ risk: { armed: false, slPct: 1 } }), { CE: 500, PE: 500 }), null);
  assert.equal(evaluateRisk(pos(), { CE: 500 }), null);
  const half = pos();
  half.legs[0] = { ...half.legs[0], closed: true, exit: 60 };
  assert.equal(evaluateRisk(half, { PE: 500 }), null);
  const unconf = pos();
  unconf.legs[1] = { ...unconf.legs[1], unconfirmed: true };
  assert.equal(evaluateRisk(unconf, { CE: 500, PE: 500 }), null);
});

test('pnl pct basis is entry premium x qty', () => {
  assert.equal(straddlePnlPct(pos(), { CE: 90, PE: 72 }), (18 / 180) * 100);
});

test('validateTrade', () => {
  assert.equal(validateTrade(1, 65), null);
  assert.match(validateTrade(0, 65)!, /positive/);
  assert.match(validateTrade(1.5, 65)!, /positive/);
  assert.match(validateTrade(51, 65)!, /Max 50/);
  assert.match(validateTrade(1, 0)!, /Lot size/);
});

test('exit qty clamps down to the broker, never above own, never negative', () => {
  assert.equal(exitQtyForLeg(130, null), 130);
  assert.equal(exitQtyForLeg(130, 65), 65);
  assert.equal(exitQtyForLeg(130, 500), 130);
  assert.equal(exitQtyForLeg(130, 0), 0);
  assert.equal(exitQtyForLeg(0, 100), 0);
});

test('state helpers', () => {
  let s: TsState = { positions: [] };
  s = upsertPosition(s, pos());
  s = upsertPosition(s, pos({ id: 'b', slot: 'left' }));
  assert.equal(openPositionFor(s, 'left')?.id, 'b');
  s = upsertPosition(s, pos({ status: 'CLOSED', closedAt: 5 }));
  assert.equal(openPositionFor(s, 'center'), undefined);
  assert.equal(s.positions.length, 2);
});

test('prune drops old closed, keeps open and today-closed', () => {
  const now = Date.UTC(2026, 9, 6, 6, 0);
  const s: TsState = {
    positions: [
      pos({ id: 'o', openedAt: 1 }),
      pos({ id: 'old', status: 'CLOSED', closedAt: now - 3 * 86_400_000 }),
      pos({ id: 'today', status: 'CLOSED', closedAt: now - 3_600_000 }),
    ],
  };
  assert.deepEqual(pruneState(s, now).positions.map((p) => p.id), ['o', 'today']);
});

test('total pnl is null if any position is unpriced', () => {
  const a = pos();
  assert.equal(totalPnl([a, pos({ id: 'b' })], () => ({ CE: 90, PE: 70 })), 2 * 20 * 130);
  assert.equal(totalPnl([a], () => ({})), null);
});

test('brokerCapacity matches product and treats an absent row as unknown, not flat', () => {
  const rows = [
    { securityId: '1', productType: 'MARGIN', netQty: -65 },
    { securityId: '2', productType: 'INTRADAY', netQty: 0, positionType: 'CLOSED' },
    { securityId: '3', productType: 'INTRADAY', netQty: 65 },
    { securityId: '4', productType: 'INTRADAY', netQty: -130 },
  ];
  assert.deepEqual(brokerCapacity(rows, '1', 'INTRADAY', 'S'), { kind: 'unknown' }); // other product
  assert.deepEqual(brokerCapacity(rows, '1', 'MARGIN', 'S'), { kind: 'qty', qty: 65 });
  assert.deepEqual(brokerCapacity(rows, '2', 'INTRADAY', 'S'), { kind: 'flat' });
  assert.deepEqual(brokerCapacity(rows, '3', 'INTRADAY', 'S'), { kind: 'opposite' });
  assert.deepEqual(brokerCapacity(rows, '4', 'INTRADAY', 'S'), { kind: 'qty', qty: 130 });
  assert.deepEqual(brokerCapacity(rows, '9', 'INTRADAY', 'S'), { kind: 'unknown' });
  assert.deepEqual(brokerCapacity(null, '4', 'INTRADAY', 'S'), { kind: 'unknown' });
  assert.deepEqual(brokerCapacity([], '4', 'INTRADAY', 'S'), { kind: 'unknown' });
});

test('pnl pct basis survives a rejected (qty 0) first leg', () => {
  const p = pos();
  p.legs[0] = { ...p.legs[0], qty: 0, closed: true, exit: 100 };
  assert.notEqual(straddlePnlPct(p, { PE: 72 }), null);
});

test('pnlSummary counts unpriced separately', () => {
  const r = pnlSummary([pos(), pos({ id: 'b' })], (p) => (p.id === 'a' ? { CE: 90, PE: 70 } : {}));
  assert.deepEqual(r, { total: 20 * 130, priced: 1, unpriced: 1 });
});
