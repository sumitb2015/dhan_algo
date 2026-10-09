/**
 * Trailing Options (Lock, Lock and Trail, Overall Trail SL) replayed tick by
 * tick against the worked examples in AlgoTest's "Overall Strategy Settings"
 * doc, through the same rule functions FocusTool.tsx calls every poll.
 *
 *     node --test lib/focusToolTrailingDoc.test.ts
 *
 * Entry premium is the doc's own: CE 170 + PE 130 = 300 points. Every case
 * runs for NIFTY (75 lot) and CRUDEOILM (10-barrel lot) so a unit bug on
 * either shows up. Ticks are given as P&L (₹) or premium profit (points).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_ROW_LIVE, evaluateRowExit, evaluateOverallExit, nextOverallPeak, overallTrailInvalid, type RowLive,
} from './focusToolRules.ts';
import { UNDERLYING_META } from './focusToolUnderlyings.ts';

const MARKETS = [
  { u: 'NIFTY', lot: 75, ce: 170, pe: 130 },
  { u: 'CRUDEOILM', lot: UNDERLYING_META.CRUDEOILM.unitsPerLot, ce: 170, pe: 130 },
];
const ENTRY = 300;

type Mkt = (typeof MARKETS)[number];

function rowFor(m: Mkt, o: object) {
  return {
    side: 'BOTH', slRupees: '', slMultiplier: '', exitTime: '', noReEntryAfter: '',
    fill: { ceQty: m.lot, peQty: m.lot, ceStrike: 1, peStrike: 1, ceEntry: m.ce, peEntry: m.pe, ts: '' },
    ...o,
  } as never;
}

/** Live state with `pts` premium points of profit on the combined 300 (negative = loss). */
function liveAtPts(m: Mkt, pts: number): RowLive {
  const k = (ENTRY - pts) / ENTRY;
  const ceLtp = m.ce * k, peLtp = m.pe * k;
  return {
    ...EMPTY_ROW_LIVE,
    ceStrike: 1, peStrike: 1, ltpCe: ceLtp, ltpPe: peLtp,
    cePosition: { netQty: -m.lot, sellAvg: m.ce } as never,
    pePosition: { netQty: -m.lot, sellAvg: m.pe } as never,
    pnl: pts * m.lot,
    entryPremium: ENTRY, lotSize: m.lot,
  };
}

/** Peak a hair past the line: the % round-trip through the legs loses ~1e-13. */
const JUST = 1e-7;

/** Replay profit points; returns the tick index of the first overall exit, or null. */
function replay(m: Mkt, row: object, ptsPath: number[]): { tick: number; reason: string } | null {
  const r = rowFor(m, row);
  let peak = { pnl: 0, pts: 0 };
  for (let i = 0; i < ptsPath.length; i++) {
    const live = liveAtPts(m, ptsPath[i]);
    peak = nextOverallPeak(peak, { pnl: live.pnl, pts: ptsPath[i] });
    const plain = evaluateRowExit(r, live, 0, undefined, m.lot);
    if (plain) return { tick: i, reason: plain };
    const ov = evaluateOverallExit(r, live, peak, undefined, m.lot);
    if (ov) return { tick: i, reason: ov.reason };
  }
  return null;
}

for (const m of MARKETS) {
  const tag = `[${m.u}]`;
  const rs = (pts: number) => String(pts * m.lot);   // ₹ for `pts` points on one lot

  // ── Lock: "If profit reaches ₹10000, Lock Profit ₹5000" ────────────────────
  test(`${tag} Lock: armed at the reach, exits when profit comes back to the lock`, () => {
    const row = { overallTrail: { enabled: true, kind: 'lock', reach: rs(100), lock: rs(50), every: '', by: '' } };
    // up to 100 pts, then a reversal: 60 holds, 50 (= the lock) exits
    assert.equal(replay(m, row, [0, 40, 100 + JUST, 80, 60]), null);
    assert.equal(replay(m, row, [0, 40, 100 + JUST, 80, 60, 50])?.tick, 5);
  });

  test(`${tag} Lock: a profit that never reaches the trigger is never locked`, () => {
    const row = { overallTrail: { enabled: true, kind: 'lock', reach: rs(100), lock: rs(50), every: '', by: '' } };
    assert.equal(replay(m, row, [0, 99, 20, -30]), null);
  });

  test(`${tag} Lock: the lock does not move however high the profit goes`, () => {
    const row = { overallTrail: { enabled: true, kind: 'lock', reach: rs(100), lock: rs(50), every: '', by: '' } };
    // peak 200 and back to 60 is still above a fixed 50 lock
    assert.equal(replay(m, row, [0, 100 + JUST, 200, 60]), null);
    assert.equal(replay(m, row, [0, 100 + JUST, 200, 60, 49])?.tick, 4);
  });

  // ── Lock and Trail: reach 10000, lock 5000, every 2000, by 1000 ───────────
  const LT = { overallTrail: { enabled: true, kind: 'lockTrail', reach: rs(100), lock: rs(50), every: rs(20), by: rs(10) } };

  test(`${tag} Lock and Trail: reach 100 → floor 50; 120 → 60; 140 → 70 (doc example)`, () => {
    // at the reach the floor is the lock
    assert.equal(replay(m, LT, [0, 100 + JUST, 51]), null);
    assert.equal(replay(m, LT, [0, 100 + JUST, 51, 50])?.tick, 3);
    // peak 120 → floor 60
    assert.equal(replay(m, LT, [0, 120 + JUST, 61]), null);
    assert.equal(replay(m, LT, [0, 120 + JUST, 61, 60])?.tick, 3);
    // peak 140 → floor 70: 70.5 holds, 70 exits
    assert.equal(replay(m, LT, [0, 100 + JUST, 120 + JUST, 140 + JUST, 70.5]), null);
    const hit = replay(m, LT, [0, 100 + JUST, 120 + JUST, 140 + JUST, 70.5, 70]);
    assert.equal(hit?.tick, 5);
    assert.match(hit?.reason ?? '', /^Overall Lock and Trail/);
  });

  test(`${tag} Lock and Trail: the floor steps (no partial step) and never falls back`, () => {
    // 119 pts is still step 0 → floor 50; a retrace from 139 keeps the step-1 floor (60)
    assert.equal(replay(m, LT, [0, 119, 55]), null);
    assert.equal(replay(m, LT, [0, 119, 50])?.tick, 2);
    assert.equal(replay(m, LT, [0, 139, 100, 61])?.tick ?? null, null);
    assert.equal(replay(m, LT, [0, 139, 100, 60])?.tick, 3);
  });

  test(`${tag} Lock and Trail: before the reach nothing is locked`, () => {
    assert.equal(replay(m, LT, [0, 99, -50]), null);
  });

  // ── Overall Trail SL, MTM: SL 5000, trail 3000 - 1500 ─────────────────────
  const TSL_MTM = { slRupees: rs(50), overallTrail: { enabled: true, kind: 'trailSl', reach: '', lock: '', every: rs(30), by: rs(15) } };

  test(`${tag} Overall Trail SL (MTM): SL 5000 → 3500 at +3000 → 2000 at +6000 → 500 at +9000`, () => {
    // peak 30 → loss limit 35 (50 − 15): −34.9 holds, −35 exits
    assert.equal(replay(m, TSL_MTM, [0, 30 + JUST, -34.9]), null);
    assert.equal(replay(m, TSL_MTM, [0, 30 + JUST, -35])?.tick, 2);
    // peak 60 → limit 20
    assert.equal(replay(m, TSL_MTM, [0, 30 + JUST, 60 + JUST, -19.9]), null);
    assert.equal(replay(m, TSL_MTM, [0, 30 + JUST, 60 + JUST, -20])?.tick, 3);
    // peak 90 → limit 5 (₹500 in the doc's numbers): −4.9 holds, −5 exits
    assert.equal(replay(m, TSL_MTM, [0, 30 + JUST, 60 + JUST, 90 + JUST, -4.9]), null);
    const hit = replay(m, TSL_MTM, [0, 30 + JUST, 60 + JUST, 90 + JUST, -5]);
    assert.equal(hit?.tick, 4);
    assert.match(hit?.reason ?? '', /^Overall Trail SL/);
  });

  test(`${tag} Overall Trail SL (MTM): below the first step the plain SL still applies`, () => {
    // peak 29 pts < one step: SL stays at 50 pts of loss, and that is the plain SL ₹ rule
    assert.equal(replay(m, TSL_MTM, [0, 29, -49.9]), null);
    const hit = replay(m, TSL_MTM, [0, 29, -50]);
    assert.equal(hit?.tick, 2);
    assert.match(hit?.reason ?? '', /^SL ₹/);
  });

  test(`${tag} Overall Trail SL (MTM): trails past zero into a locked profit`, () => {
    // SL 10, every 10 by 8: peak 30 → limit 10 − 24 = −14, i.e. exit once profit ≤ 14
    const row = { slRupees: rs(10), overallTrail: { enabled: true, kind: 'trailSl', reach: '', lock: '', every: rs(10), by: rs(8) } };
    assert.equal(replay(m, row, [0, 30 + JUST, 14.5]), null);
    assert.equal(replay(m, row, [0, 30 + JUST, 14.5, 14])?.tick, 3);
  });

  // ── Overall Trail SL, Total Premium %: SL 30% of 300 = 90 pts, trail 5 - 2 ──
  const TSL_PCT = { slMultiplier: '1.3', overallTrail: { enabled: true, kind: 'trailSl', reach: '', lock: '', every: '5', by: '2' } };

  test(`${tag} Overall Trail SL (% of premium): SL 90 → 84 at +15 → 78 at +30 → 72 at +45 pts`, () => {
    // 5% of 300 = 15 pts per step, 2% of 300 = 6 pts tightened per step
    assert.equal(replay(m, TSL_PCT, [0, 15 + JUST, -83.9]), null);
    assert.equal(replay(m, TSL_PCT, [0, 15 + JUST, -84])?.tick, 2);
    assert.equal(replay(m, TSL_PCT, [0, 15 + JUST, 30 + JUST, -77.9]), null);
    assert.equal(replay(m, TSL_PCT, [0, 15 + JUST, 30 + JUST, -78])?.tick, 3);
    assert.equal(replay(m, TSL_PCT, [0, 15 + JUST, 30 + JUST, 45 + JUST, -71.9]), null);
    const hit = replay(m, TSL_PCT, [0, 15 + JUST, 30 + JUST, 45 + JUST, -72]);
    assert.equal(hit?.tick, 4);
    assert.match(hit?.reason ?? '', /^Overall Trail SL/);
  });

  test(`${tag} Overall Trail SL (% of premium): independent of lot size and quantity multiplier`, () => {
    const hit = replay(m, { ...TSL_PCT, qtyMultiplier: 3 }, [0, 15 + JUST, -84]);
    assert.equal(hit?.tick, 2);
  });

  // ── A trail that would exit the moment the row goes green is ignored ───────
  test(`${tag} Overall Trail SL with by > every is ignored (the live case: SL 600, every 50, by 250, +367)`, () => {
    const bad = { slRupees: rs(60), overallTrail: { enabled: true, kind: 'trailSl', reach: '', lock: '', every: rs(5), by: rs(25) } };
    // before the guard: peak 36.7 → 7 steps → stop locked at +115 → exit on the very next tick at +36.7
    assert.equal(replay(m, bad, [0, 36.7, 36.7]), null);
    // the plain SL is still in force
    assert.match(replay(m, bad, [0, 36.7, -60])?.reason ?? '', /^SL ₹/);
  });

  test(`${tag} Lock and Trail with by > every is ignored; by = every is still honoured`, () => {
    const bad = { overallTrail: { enabled: true, kind: 'lockTrail', reach: rs(10), lock: rs(9), every: rs(1), by: rs(5) } };
    assert.equal(replay(m, bad, [0, 10 + JUST, 20, 20]), null);          // floor would be 9 + 10·5 = 59 > the 20 earned
    const eq = { slRupees: rs(60), overallTrail: { enabled: true, kind: 'trailSl', reach: '', lock: '', every: rs(10), by: rs(10) } };
    // peak 10 → one step → SL 50: −49.9 holds, −50 exits
    assert.equal(replay(m, eq, [0, 10 + JUST, -49.9]), null);
    assert.equal(replay(m, eq, [0, 10 + JUST, -50])?.tick, 2);
  });

  // ── Switch off / wrong config ─────────────────────────────────────────────
  test(`${tag} Trailing Options switched off never fires`, () => {
    const row = { overallTrail: { enabled: false, kind: 'lock', reach: rs(10), lock: rs(5), every: '', by: '' } };
    assert.equal(replay(m, row, [0, 50, 1, -50]), null);
  });

  test(`${tag} Lock with a lock at or above the reach is ignored (invalid config)`, () => {
    const row = { overallTrail: { enabled: true, kind: 'lock', reach: rs(10), lock: rs(10), every: '', by: '' } };
    assert.equal(replay(m, row, [0, 50, -50]), null);
  });
}

test('overallTrailInvalid: only by > every on a trailing kind, never Lock, never off or blank', () => {
  const t = (o: object) => overallTrailInvalid({ enabled: true, kind: 'lockTrail', every: '100', by: '50', ...o } as never);
  assert.equal(t({}), null);
  assert.equal(t({ by: '100' }), null);                                  // equal is fine
  assert.match(t({ by: '101' }) ?? '', /must not exceed/);
  assert.match(t({ kind: 'trailSl', every: '50', by: '250' }) ?? '', /must not exceed/);
  assert.equal(t({ kind: 'lock', every: '1', by: '999' }), null);       // Lock has no step
  assert.equal(overallTrailInvalid({ enabled: false, kind: 'lockTrail', every: '1', by: '9' }), null);
  assert.equal(t({ every: '', by: '9' }), null);                         // blank = not set yet, not invalid
  assert.equal(t({ every: '50', by: '' }), null);
  assert.equal(overallTrailInvalid(undefined), null);
});
