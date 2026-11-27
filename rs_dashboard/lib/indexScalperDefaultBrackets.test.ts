import test from 'node:test';
import assert from 'node:assert/strict';
import { bracketLabel, clampDefaultBrackets, defaultBracketPlan, parseBracketPoints, pointsLevel, opensPosition, pendingLeg, DEFAULT_BRACKETS, PENDING_TTL_MS, type PendingDefault } from './indexScalperDefaultBrackets.ts';

const none = { tp: false, sl: false };
const pend = (long: boolean, over: Partial<PendingDefault> = {}): PendingDefault => ({ legKey: '302', long, at: 1000, tpPct: 30, slPct: 20, entry: 0, product: '', expectQty: long ? 65 : -65, ...over });

test('defaults: on, target 30 %, stop 20 %; bad saved values fall back', () => {
  const units = { tpUnit: 'pct', slUnit: 'pct', tpPts: 20, slPts: 10 } as const;
  assert.deepEqual(DEFAULT_BRACKETS, { on: true, tpPct: 30, slPct: 20, ...units });
  assert.deepEqual(clampDefaultBrackets(null), DEFAULT_BRACKETS);
  assert.deepEqual(clampDefaultBrackets({ on: false, tpPct: 50, slPct: 10 }), { on: false, tpPct: 50, slPct: 10, ...units });
  // not an offered choice / wrong type -> default
  assert.deepEqual(clampDefaultBrackets({ on: 'yes', tpPct: 33, slPct: 0 }), DEFAULT_BRACKETS);
  assert.deepEqual(clampDefaultBrackets({ tpPct: '40', slPct: '25' }), { on: true, tpPct: 40, slPct: 25, ...units });
});

test('a long: target +30 % and stop -20 % of the entry premium, on the tick, rounded away from entry', () => {
  const plan = defaultBracketPlan(pend(true), { netQty: 65, avg: 100.05, ltp: 101 }, none, 0.05, 2000);
  // 100.05 x 1.3 = 130.065 -> up to 130.10; 100.05 x 0.8 = 80.04 -> down to 80.00
  assert.deepEqual(plan, { kind: 'place', tp: 130.1, sl: 80, skipped: [] });
});

test('a short: target -30 % and stop +20 %', () => {
  const plan = defaultBracketPlan(pend(false, { expectQty: -130 }), { netQty: -130, avg: 200, ltp: 199 }, none, 0.05, 2000);
  assert.deepEqual(plan, { kind: 'place', tp: 140, sl: 240, skipped: [] });
});

test('waits for the leg on the expected side with an average and a live premium; drops after the TTL', () => {
  assert.deepEqual(defaultBracketPlan(pend(true), null, none, 0.05, 2000), { kind: 'wait' });
  assert.deepEqual(defaultBracketPlan(pend(true), { netQty: -65, avg: 100, ltp: 100 }, none, 0.05, 2000), { kind: 'wait' }); // still the old short
  assert.deepEqual(defaultBracketPlan(pend(true), { netQty: 65, avg: 0, ltp: 100 }, none, 0.05, 2000), { kind: 'wait' });
  assert.deepEqual(defaultBracketPlan(pend(true), { netQty: 65, avg: 100, ltp: null }, none, 0.05, 2000), { kind: 'wait' });
  assert.equal(defaultBracketPlan(pend(true), null, none, 0.05, 1000 + PENDING_TTL_MS + 1).kind, 'drop');
});

test('keeps an existing target / stop and places only the missing one; both present = nothing', () => {
  const leg = { netQty: 65, avg: 100, ltp: 100 };
  assert.deepEqual(defaultBracketPlan(pend(true), leg, { tp: true, sl: false }, 0.05, 2000), { kind: 'place', tp: null, sl: 80, skipped: [] });
  assert.equal(defaultBracketPlan(pend(true), leg, { tp: true, sl: true }, 0.05, 2000).kind, 'drop');
});

test('a level already past the live premium (it would fill / trigger at once) is skipped with the reason', () => {
  // long from 100, premium already ran to 135: the 130 target would fill at once
  const plan = defaultBracketPlan(pend(true), { netQty: 65, avg: 100, ltp: 135 }, none, 0.05, 2000);
  assert.equal(plan.kind, 'place');
  if (plan.kind !== 'place') return;
  assert.equal(plan.tp, null);
  assert.equal(plan.sl, 80);
  assert.match(plan.skipped[0], /^TP 130\.00: A long's target must be above the live premium 135\.00/);
});

test('the levels come from the order\'s own entry, not the broker\'s day average', () => {
  // a round trip at 150 / 160 earlier: Dhan's buyAvg now reads 180 for a new buy at 210
  const plan = defaultBracketPlan(pend(true, { entry: 210 }), { netQty: 65, avg: 180, ltp: 210 }, none, 0.05, 2000);
  assert.deepEqual(plan, { kind: 'place', tp: 273, sl: 168, skipped: [] });
});

test('a partly filled order waits for the whole quantity; still partial at the TTL = a loud drop', () => {
  const p = pend(true, { expectQty: 650 });
  assert.deepEqual(defaultBracketPlan(p, { netQty: 260, avg: 100, ltp: 100 }, none, 0.05, 2000), { kind: 'wait' });
  assert.equal(defaultBracketPlan(p, { netQty: 650, avg: 100, ltp: 100 }, none, 0.05, 2000).kind, 'place');
  const late = defaultBracketPlan(p, { netQty: 260, avg: 100, ltp: 100 }, none, 0.05, 1000 + PENDING_TTL_MS + 1);
  assert.deepEqual(late, { kind: 'drop', warn: true, reason: 'the order had not filled in full within 30 s' });
  const never = defaultBracketPlan(p, null, none, 0.05, 1000 + PENDING_TTL_MS + 1);
  assert.deepEqual(never, { kind: 'drop', warn: true, reason: 'the position did not show within 30 s' });
  // already protected: a quiet drop
  assert.deepEqual(defaultBracketPlan(pend(true), { netQty: 65, avg: 100, ltp: 100 }, { tp: true, sl: true }, 0.05, 2000), { kind: 'drop', warn: false, reason: 'it already has a target and a stop' });
});

test('pendingLeg: same key, side and product, never a flat row', () => {
  const legs = [
    { securityId: '402', netQty: 0, avg: 100, ltp: 100, product: 'MARGIN' },
    { securityId: '402', netQty: -65, avg: 100, ltp: 100, product: 'MARGIN' },
    { securityId: '402', netQty: -65, avg: 90, ltp: 100, product: 'INTRADAY' },
  ];
  assert.equal(pendingLeg(pend(false, { legKey: '402', product: 'INTRADAY' }), legs), legs[2]);
  assert.equal(pendingLeg(pend(false, { legKey: '402', product: 'MARGIN' }), legs), legs[1]);
  assert.equal(pendingLeg(pend(true, { legKey: '402' }), legs), null); // no long
  // a paper leg has no product: matched by key and side
  assert.equal(pendingLeg(pend(false, { legKey: '402', product: 'INTRADAY' }), [{ securityId: '402', netQty: -65, avg: 1, ltp: 1, product: '' }])?.netQty, -65);
});

test('opensPosition: from flat or through zero only; adding or reducing is not a new position', () => {
  assert.equal(opensPosition(0, true, 65), true);
  assert.equal(opensPosition(130, true, 65), false);   // adds to a long
  assert.equal(opensPosition(130, false, 65), false);  // only reduces the long
  assert.equal(opensPosition(130, false, 130), false); // closes it exactly
  assert.equal(opensPosition(130, false, 195), true);  // flips to short
  assert.equal(opensPosition(-65, true, 130), true);
});

test('stop loss can be set up to 100 %: a sell\'s stop at 2x entry, a buy gets none (a premium of 0)', () => {
  assert.equal(clampDefaultBrackets({ slPct: 100 }).slPct, 100);
  assert.equal(clampDefaultBrackets({ slPct: 75 }).slPct, 75);
  const short = defaultBracketPlan(pend(false, { slPct: 100 }), { netQty: -65, avg: 100, ltp: 100 }, none, 0.05, 2000);
  assert.deepEqual(short, { kind: 'place', tp: 70, sl: 200, skipped: [] });
  const long = defaultBracketPlan(pend(true, { slPct: 100 }), { netQty: 65, avg: 100, ltp: 100 }, none, 0.05, 2000);
  assert.equal(long.kind, 'place');
  if (long.kind === 'place') { assert.equal(long.tp, 130); assert.equal(long.sl, null); assert.equal(long.skipped.length, 1); }
});

test('points: saved units / distances are kept, bad ones fall back; labels read the chosen unit', () => {
  const s = clampDefaultBrackets({ tpUnit: 'pts', slUnit: 'pct', tpPts: 12.5, slPts: '8' });
  assert.equal(s.tpUnit, 'pts'); assert.equal(s.slUnit, 'pct'); assert.equal(s.tpPts, 12.5); assert.equal(s.slPts, 8);
  const bad = clampDefaultBrackets({ tpUnit: 'rupees', tpPts: -3, slPts: 99999 });
  assert.equal(bad.tpUnit, 'pct'); assert.equal(bad.tpPts, 20); assert.equal(bad.slPts, 10);
  assert.equal(bracketLabel(s, 'TP'), '12.5 pts');
  assert.equal(bracketLabel(s, 'SL'), '20%');
});

test('parseBracketPoints: plain decimals above 0 only', () => {
  assert.deepEqual(parseBracketPoints(' 15 '), { pts: 15, error: null });
  assert.deepEqual(parseBracketPoints('7.5'), { pts: 7.5, error: null });
  for (const t of ['', '0', '-5', '1e3', 'abc', '10%', '6000']) assert.equal(parseBracketPoints(t).pts, null, t);
});

test('a long in points: target entry + pts, stop entry - pts, snapped away from entry', () => {
  const plan = defaultBracketPlan(pend(true, { tpUnit: 'pts', slUnit: 'pts', tpPts: 15, slPts: 10.02 }), { netQty: 65, avg: 100.05, ltp: 101 }, none, 0.05, 2000);
  // 100.05 + 15 = 115.05; 100.05 - 10.02 = 90.03 -> down to 90.00
  assert.deepEqual(plan, { kind: 'place', tp: 115.05, sl: 90, skipped: [] });
});

test('a short in points; mixed units per side', () => {
  const short = defaultBracketPlan(pend(false, { entry: 200, tpUnit: 'pts', tpPts: 30, slUnit: 'pct' }), { netQty: -65, avg: 200, ltp: 200 }, none, 0.05, 2000);
  assert.deepEqual(short, { kind: 'place', tp: 170, sl: 240, skipped: [] });
});

test('a points stop at or past a premium of 0 is skipped with its reason', () => {
  assert.equal(pointsLevel('SL', true, 10, 10, 0.05).price, null);
  assert.equal(pointsLevel('SL', false, 10, 10, 0.05).price, 20); // a sell's stop is above entry
  const plan = defaultBracketPlan(pend(true, { slUnit: 'pts', slPts: 50 }), { netQty: 65, avg: 40, ltp: 40 }, none, 0.05, 2000);
  assert.equal(plan.kind, 'place');
  if (plan.kind === 'place') { assert.equal(plan.sl, null); assert.equal(plan.skipped.length, 1); assert.equal(plan.tp, 52); }
});
