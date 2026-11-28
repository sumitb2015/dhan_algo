import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STRADDLE_RULES, currentFloor, effectiveLevels, evaluateStraddle, exitQtyFor, parseStraddleStore, premiumAtPct,
  lastClosedVwap, rulesError, serializeStraddleStore, straddleHealth, straddleMtm, type IsxStraddle, type StraddleRules,
} from './indexScalperStraddle.ts';

// 10:00 IST on 2026-11-30 (04:30 UTC)
const T10 = Date.UTC(2026, 10, 30, 4, 30, 0);
const OPEN = T10 - 5 * 60_000;

function book(o: Partial<IsxStraddle> = {}, rules: Partial<StraddleRules> = {}): IsxStraddle {
  return {
    id: 's1', slot: 'center', mode: 'SIM', side: 'S', underlying: 'NIFTY', expiry: '2026-12-01', strike: 25350,
    lots: 1, lotSize: 65, product: 'INTRADAY', status: 'OPEN', openedAt: OPEN, day: '2026-11-30',
    legs: [
      { option: 'CE', securityId: '302', qty: 65, entry: 100, orderIds: [] },
      { option: 'PE', securityId: '402', qty: 65, entry: 100, orderIds: [] },
    ],
    risk: { armed: true },
    rules: { ...DEFAULT_STRADDLE_RULES, vwap: { on: false, bufferPts: 0 }, timeExit: { on: false, hhmm: '15:17' }, ...rules },
    ...o,
  };
}
const look = (b: IsxStraddle, ce: number, pe: number, extra: Partial<Parameters<typeof evaluateStraddle>[1]> = {}) =>
  evaluateStraddle(b, { ltp: { CE: ce, PE: pe }, nowMs: T10, stale: false, ...extra });

test('MTM: rupees and % of entry premium; null with one leg unpriced', () => {
  // short 200 -> 180: +20 x 65 = 1300, 10% of 13000
  assert.deepEqual(straddleMtm(book(), { CE: 90, PE: 90 }), { pnlRs: 1300, pnlPct: 10 });
  assert.equal(straddleMtm(book(), { CE: 90 }), null);
});

test('target / stop in % (Triple Straddle rules)', () => {
  assert.equal(look(book(), 70, 70).reason, 'TARGET'); // +30%
  assert.equal(look(book(), 120, 120).reason, 'SL'); // -20%
  assert.equal(look(book(), 105, 100).reason, null);
  // long: the other way round
  const long = book({ side: 'B' });
  assert.equal(look(long, 130, 130).reason, 'TARGET');
  assert.equal(look(long, 80, 80).reason, 'SL');
});

test('rupee levels: converted on the entry premium, the nearer of % and rupees wins', () => {
  const b = book({}, { targetPct: 30, targetRs: 1300, slPct: 20, slRs: 0 });
  assert.deepEqual(effectiveLevels(b), { targetPct: 10, slPct: 20 });
  assert.equal(look(b, 90, 90).reason, 'TARGET'); // +1300
  assert.deepEqual(effectiveLevels(book({}, { targetPct: 0, slPct: 0, slRs: 2600 })), { targetPct: undefined, slPct: 20 });
});

test('VWAP exit: only on a candle CLOSE beyond VWAP (+ buffer), never a live tick; direction by side', () => {
  const b = book({}, { vwap: { on: true, bufferPts: 2 } });
  // live premium far above VWAP but the closed candle is under it: no exit
  assert.equal(look(b, 108, 100, { closedBar: { endMs: T10, close: 199 }, vwapAtClosed: 200 }).reason, null);
  // closed above VWAP but inside the buffer: no exit
  assert.equal(look(b, 101, 100, { closedBar: { endMs: T10, close: 201.5 }, vwapAtClosed: 200 }).reason, null);
  assert.equal(look(b, 101, 100, { closedBar: { endMs: T10, close: 202.5 }, vwapAtClosed: 200 }).reason, 'VWAP');
  // a candle that closed before the entry is not a signal
  assert.equal(look(b, 101, 100, { closedBar: { endMs: OPEN - 1, close: 210 }, vwapAtClosed: 200 }).reason, null);
  // long: closes below VWAP - buffer
  const l = book({ side: 'B' }, { vwap: { on: true, bufferPts: 0 } });
  assert.equal(look(l, 99, 100, { closedBar: { endMs: T10, close: 195 }, vwapAtClosed: 200 }).reason, 'VWAP');
  assert.equal(look(l, 99, 100, { closedBar: { endMs: T10, close: 205 }, vwapAtClosed: 200 }).reason, null);
  // switched off
  assert.equal(look(book(), 101, 100, { closedBar: { endMs: T10, close: 250 }, vwapAtClosed: 200 }).reason, null);
});

test('trail and lock come from the Triple Straddle rules; peak is returned to persist', () => {
  const lock = book({ peakPct: 12 }, { targetPct: 0, slPct: 20, trail: { kind: 'lock', reach: 10, lock: 4 } });
  const d = look(lock, 98, 98); // +2%: below the 4% lock
  assert.equal(d.reason, 'LOCK');
  assert.equal(d.peakPct, 12);
  const trail = book({ peakPct: 20 }, { targetPct: 0, slPct: 20, trail: { kind: 'trailSl', every: 10, by: 10 } });
  // two steps: floor 0 -> -0.5% is an exit
  assert.equal(look(trail, 100.5, 100).reason, 'TRAIL');
  assert.deepEqual(currentFloor(trail), { kind: 'TRAIL', floorPct: 0 });
});

test('SL to cost: once the peak reached the trigger, a fall back to 0 exits', () => {
  const b = book({ peakPct: 16 }, { targetPct: 0, slPct: 20, slToCost: { on: true, triggerPct: 15 } });
  assert.deepEqual(currentFloor(b), { kind: 'COST', floorPct: 0 });
  assert.equal(look(b, 100, 100.5).reason, 'COST');
  assert.equal(look(b, 99, 99).reason, null);
  assert.equal(look(book({ peakPct: 10 }, { targetPct: 0, slPct: 20, slToCost: { on: true, triggerPct: 15 } }), 100, 100.5).reason, null);
});

test('time exit fires at the set IST time even on stale prices; stale prices pause every price rule', () => {
  const b = book({}, { timeExit: { on: true, hhmm: '10:00' } });
  assert.equal(look(b, 0, 0, { stale: true }).reason, 'TIME');
  assert.equal(look(book({}, { timeExit: { on: true, hhmm: '10:01' } }), 100, 100).reason, null);
  assert.equal(look(book(), 70, 70, { stale: true }).reason, null);
});

test('fires once and never on a half straddle', () => {
  assert.equal(look(book({ exiting: true }), 70, 70).reason, null);
  assert.equal(look(book({ status: 'CLOSED' }), 70, 70).reason, null);
  const oneLeg = book();
  oneLeg.legs = [oneLeg.legs[0], { ...oneLeg.legs[1], qty: 0 }];
  assert.equal(straddleHealth(oneLeg), 'ONE_LEG');
  assert.equal(look(oneLeg, 70, 70).reason, null);
  const pending = book();
  pending.legs = [pending.legs[0], { ...pending.legs[1], unconfirmed: true }];
  assert.equal(straddleHealth(pending), 'PENDING');
  const halfClosed = book();
  halfClosed.legs = [{ ...halfClosed.legs[0], closed: true, exit: 90 }, halfClosed.legs[1]];
  assert.equal(straddleHealth(halfClosed), 'ONE_LEG');
  assert.equal(straddleHealth(book()), 'OK');
});

test('exit size: own quantity clamped by the broker in the closing direction, never the raw net', () => {
  // a sibling Quick short of 65 on the same strike: broker -130, the straddle closes its own 65
  assert.equal(exitQtyFor(65, 'S', -130), 65);
  // the broker already shows less (a partial manual close): only what is there
  assert.equal(exitQtyFor(65, 'S', -40), 40);
  // flat or the other way: nothing to close
  assert.equal(exitQtyFor(65, 'S', 0), 0);
  assert.equal(exitQtyFor(65, 'S', 65), 0);
  assert.equal(exitQtyFor(65, 'B', 130), 65);
  assert.equal(exitQtyFor(0, 'B', 130), 0);
});

test('chart level: premium at a P&L %', () => {
  assert.equal(premiumAtPct(book(), -20), 240); // short stop
  assert.equal(premiumAtPct(book(), 30), 140); // short target
  assert.equal(premiumAtPct(book({ side: 'B' }), 30), 260);
});

test('store: today only, malformed dropped, round trip', () => {
  const today = book();
  const old = book({ id: 'old', day: '2026-11-27' });
  const raw = serializeStraddleStore([today, old, { id: 'x' } as unknown as IsxStraddle]);
  assert.deepEqual(parseStraddleStore(raw, '2026-11-30').map(b => b.id), ['s1']);
  assert.deepEqual(parseStraddleStore('not json', '2026-11-30'), []);
  assert.deepEqual(parseStraddleStore(null, '2026-11-30'), []);
});

test('rules validation', () => {
  assert.equal(rulesError(DEFAULT_STRADDLE_RULES), null);
  assert.match(rulesError({ ...DEFAULT_STRADDLE_RULES, timeExit: { on: true, hhmm: '25:00' } })!, /HH:MM/);
  assert.match(rulesError({ ...DEFAULT_STRADDLE_RULES, slRs: -5 })!, /0 or more/);
  assert.match(rulesError({ ...DEFAULT_STRADDLE_RULES, trail: { kind: 'trailSl', every: 5, by: 10 } })!, /Trail SL/);
  assert.match(rulesError({ ...DEFAULT_STRADDLE_RULES, trail: { kind: 'lock', reach: 5, lock: 5 } })!, /Lock/);
});

test('last finished candle and its VWAP: the forming bar is skipped', () => {
  const bars = [
    { t: 1000, o: 10, h: 12, l: 8, c: 11, v: 100 },
    { t: 1300, o: 11, h: 14, l: 10, c: 13, v: 300 },
    { t: 1600, o: 13, h: 13, l: 13, c: 13, v: 1 },
  ];
  const forming = lastClosedVwap(bars, 5, false)!;
  assert.equal(forming.endMs, 1600_000);
  assert.equal(forming.close, 13);
  // (10.333 x 100 + 12.333 x 300) / 400
  assert.ok(Math.abs(forming.vwap! - 11.8333) < 1e-3);
  assert.equal(lastClosedVwap(bars, 5, true)!.close, 13);
  assert.equal(lastClosedVwap(bars.slice(0, 1), 5, false), null);
});
