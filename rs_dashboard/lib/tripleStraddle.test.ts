import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeFloorPct, peakTrackable, brokerCapacity, nextPeakPct, entryPremium, evaluateRisk, pnlSummary, exitQtyForLeg, openPositionFor, pruneState, straddlePnl, straddlePnlPct,
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

// pos(): entry 100+80 per unit, qty 130 -> pct = (180 - (ce+pe)) / 180 * 100
const at = (pct: number) => ({ CE: 100 - (pct / 100) * 180, PE: 80 }); // CE moves, PE flat

test('peak is ratcheted, never below 0, null while unpriced', () => {
  assert.equal(nextPeakPct(pos(), at(-10)), 0);
  assert.equal(nextPeakPct(pos({ peakPct: 12 }), at(5)), 12);
  assert.equal(nextPeakPct(pos({ peakPct: 12 }), at(20)), 20);
  assert.equal(nextPeakPct(pos(), {}), null);
});

test('trail SL: stop tightens by `by` for every `every` of peak, and can lock profit', () => {
  const risk = { armed: true, slPct: 30, trail: { kind: 'trailSl' as const, every: 10, by: 10 } };
  assert.deepEqual(activeFloorPct(risk, 5), { kind: 'SL', floor: -30 });
  assert.deepEqual(activeFloorPct(risk, 10), { kind: 'TRAIL', floor: -20 });
  assert.deepEqual(activeFloorPct(risk, 35), { kind: 'TRAIL', floor: 0 });     // 30 - 3*10 = 0 -> breakeven
  assert.deepEqual(activeFloorPct(risk, 45), { kind: 'TRAIL', floor: 10 });    // passes zero -> locked profit
  const p = pos({ risk, peakPct: 35 });
  assert.equal(evaluateRisk(p, at(2)), null);
  assert.equal(evaluateRisk(p, at(0)), 'TRAIL');
  assert.equal(evaluateRisk(p, at(-1)), 'TRAIL');
});

test('trail SL needs an SL: without one it never fires', () => {
  const risk = { armed: true, trail: { kind: 'trailSl' as const, every: 10, by: 10 } };
  assert.equal(activeFloorPct(risk, 50), null);
});

test('lock: dormant until the peak reaches `reach`, then exits at `lock`', () => {
  const risk = { armed: true, trail: { kind: 'lock' as const, reach: 20, lock: 5 } };
  assert.equal(evaluateRisk(pos({ risk, peakPct: 15 }), at(-3)), null);          // never reached 20 -> no lock
  assert.equal(evaluateRisk(pos({ risk, peakPct: 25 }), at(8)), null);           // above the lock
  assert.equal(evaluateRisk(pos({ risk, peakPct: 25 }), at(5)), 'LOCK');
  assert.equal(evaluateRisk(pos({ risk }), at(30)) , null);                       // the peak includes this tick, price still above lock
});

test('lock with lock unset is a breakeven lock', () => {
  const risk = { armed: true, trail: { kind: 'lock' as const, reach: 20 } };
  assert.equal(evaluateRisk(pos({ risk, peakPct: 22 }), at(0)), 'LOCK');
  assert.equal(evaluateRisk(pos({ risk, peakPct: 22 }), at(3)), null);
});

test('lock and trail: floor rises by `by` for every `every` more peak', () => {
  const risk = { armed: true, trail: { kind: 'lockTrail' as const, reach: 20, lock: 5, every: 10, by: 5 } };
  assert.deepEqual(activeFloorPct(risk, 20), { kind: 'LOCK', floor: 5 });
  assert.deepEqual(activeFloorPct(risk, 29), { kind: 'LOCK', floor: 5 });
  assert.deepEqual(activeFloorPct(risk, 30), { kind: 'LOCK', floor: 10 });
  assert.deepEqual(activeFloorPct(risk, 50), { kind: 'LOCK', floor: 20 });
  assert.equal(evaluateRisk(pos({ risk, peakPct: 50 }), at(19)), 'LOCK');
  assert.equal(evaluateRisk(pos({ risk, peakPct: 50 }), at(21)), null);
});

test('an invalid lock (lock >= reach) is ignored rather than firing immediately', () => {
  const risk = { armed: true, slPct: 30, trail: { kind: 'lock' as const, reach: 10, lock: 10 } };
  assert.deepEqual(activeFloorPct(risk, 50), { kind: 'SL', floor: -30 });
});

test('target still wins over trail, plain SL still works with a trail set', () => {
  const risk = { armed: true, slPct: 30, targetPct: 50, trail: { kind: 'trailSl' as const, every: 10, by: 10 } };
  assert.equal(evaluateRisk(pos({ risk, peakPct: 49 }), at(50)), 'TARGET');
  assert.equal(evaluateRisk(pos({ risk }), at(-30)), 'SL');
});

test('by > every is invalid: it can never put the floor above the profit', () => {
  const sl = { armed: true, slPct: 30, trail: { kind: 'trailSl' as const, every: 5, by: 20 } };
  assert.deepEqual(activeFloorPct(sl, 10), { kind: 'SL', floor: -30 });
  assert.equal(evaluateRisk(pos({ risk: sl, peakPct: 10 }), at(10)), null);
  const lt = { armed: true, trail: { kind: 'lockTrail' as const, reach: 20, lock: 5, every: 5, by: 20 } };
  assert.deepEqual(activeFloorPct(lt, 40), { kind: 'LOCK', floor: 5 });
});

test('peak is only tracked for armed, fully confirmed, open positions', () => {
  assert.equal(peakTrackable(pos()), true);
  assert.equal(peakTrackable(pos({ risk: { armed: false } })), false);
  const u = pos(); u.legs[0] = { ...u.legs[0], unconfirmed: true };
  assert.equal(peakTrackable(u), false);
  const h = pos(); h.legs[0] = { ...h.legs[0], closed: true, exit: 50 };
  assert.equal(peakTrackable(h), false);
  const x = pos(); x.legs[1] = { ...x.legs[1], pendingExit: { orderId: 'O', at: 1 } };
  assert.equal(peakTrackable(x), false);
});
