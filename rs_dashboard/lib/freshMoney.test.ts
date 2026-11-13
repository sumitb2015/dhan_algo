import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSnapshotCsv, buildBoardRows, buildupOf, fmtOi, fmtOiAbs, strikeStep, hasCumulativeVolume, oiFlow, fmtOiShort, fmtMinOfDay, flowScale, flowTier, flowStreak, sumFlows, streakVsDay,
} from './freshMoney.ts';

const HEAD = 'timestamp,spot,expiry,strike,CE_LTP,CE_IV,CE_OI,CE_change_OI,CE_volume,PE_LTP,PE_IV,PE_OI,PE_change_OI,PE_volume';
const row = (ts: string, k: number, ceOi: number, ceChg: number | '', ceVol: number, peOi: number, peChg: number | '', peVol: number, spot = 22575, exp = '2026-11-12') =>
  `${ts},${spot},${exp},${k},1,1,${ceOi},${ceChg},${ceVol},1,1,${peOi},${peChg},${peVol}`;

test('parse groups rows by timestamp and filters by expiry', () => {
  const csv = [HEAD,
    row('2026-11-10 09:20:00', 22550, 100, 10, 50, 200, 20, 100),
    row('2026-11-10 09:20:00', 22600, 100, 10, 50, 200, 20, 100),
    row('2026-11-10 09:20:00', 22600, 1, 1, 1, 1, 1, 1, 22575, '2026-11-19'),
    row('2026-11-10 09:20:30', 22550, 100, 10, 50, 200, 20, 100),
  ].join('\n');
  const snaps = parseSnapshotCsv(csv, '2026-11-12');
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].strikes.size, 2);
  assert.equal(snaps[0].min, 9 * 60 + 20);
  assert.equal(snaps[1].min, 9 * 60 + 20.5);
});

test('missing change gives null, not 0', () => {
  const [s] = parseSnapshotCsv([HEAD, row('2026-11-10 09:20:00', 22550, 100, '', 0, 200, 5, 0)].join('\n'));
  const r = buildBoardRows(s).find(x => x.strike === 22550)!;
  assert.equal(r.call!.oiMoved, null);
  assert.equal(r.put!.oiMoved, 5);
});

test('board rows use a fixed ATM±wings grid; uncollected strikes are null', () => {
  const [s] = parseSnapshotCsv([HEAD,
    row('2026-11-10 10:00:00', 22550, 0, 5, 10, 0, 5, 10),
    row('2026-11-10 10:00:00', 22600, 0, 5, 10, 0, 5, 10),
  ].join('\n'));
  const rows = buildBoardRows(s, 2);
  assert.deepEqual(rows.map(r => r.strike), [22700, 22650, 22600, 22550, 22500]);
  assert.equal(rows[0].put, null);
  assert.equal(rows[2].call!.oiMoved, 5);
  assert.equal(strikeStep([22500, 22600, 22550]), 50);
});

test('Indian-style OI formatting matches the board', () => {
  assert.equal(fmtOi(83718), '+83,718');
  assert.equal(fmtOi(-134), '-134');
  assert.equal(fmtOi(190000), '+1.9L');
  assert.equal(fmtOi(12000000), '+1.2Cr');
  assert.equal(fmtOi(0), '0');
  assert.equal(fmtOi(null), '–');
});

test('per-candle (backfilled) volume is detected', () => {
  const lines = [HEAD];
  for (let i = 0; i < 12; i++) {
    const ts = `2026-11-10 09:${String(15 + i).padStart(2, '0')}:00`;
    lines.push(row(ts, 22550, 1000 + i * 500, 0, i % 2 ? 50 : 400, 1000, 0, 100 + i * 10));
  }
  const snaps = parseSnapshotCsv(lines.join('\n'));
  assert.equal(hasCumulativeVolume(snaps), false);
  const cum = parseSnapshotCsv([HEAD, row('2026-11-10 09:15:00', 1, 1, 0, 10, 1, 0, 10), row('2026-11-10 09:16:00', 1, 1, 0, 20, 1, 0, 20)].join('\n'));
  assert.equal(hasCumulativeVolume(cum), true);
});

test('board rows carry total OI next to the change; unsigned OI formatting', () => {
  const [snap] = parseSnapshotCsv([HEAD, row('2026-11-10 10:00:00', 22550, 750000, 5, 10, 120000, -5, 10)].join('\n'));
  const rows = buildBoardRows(snap, 1);
  const r = rows.find(x => x.strike === 22550)!;
  assert.equal(r.call!.oi, 750000);
  assert.equal(r.put!.oi, 120000);
  assert.equal(rows.find(x => x.strike === 22650)!.put, null);   // on the grid, not collected
  assert.equal(fmtOiAbs(750000), '7.5L');
  assert.equal(fmtOiAbs(83718), '83,718');
  assert.equal(fmtOiAbs(-134), '134');
  assert.equal(fmtOiAbs(null), '–');
});

test('buildup: the four quadrants of OI change x option price change', () => {
  assert.equal(buildupOf(500, 120, 100), 'LB');
  assert.equal(buildupOf(500, 80, 100), 'SB');
  assert.equal(buildupOf(-500, 120, 100), 'SC');
  assert.equal(buildupOf(-500, 80, 100), 'LU');
  assert.equal(buildupOf(500, 100, 100), 'LB');      // unchanged price counts as up (OptionsBuildupTab)
  assert.equal(buildupOf(0, 120, 100), null);        // no OI change: no tag
  assert.equal(buildupOf(null, 120, 100), null);
  assert.equal(buildupOf(500, 120, null), null);     // no previous close: no tag, never a guess
  assert.equal(buildupOf(500, null, 100), null);
});

test('board rows get buildup tags only where a previous close is known', () => {
  // HEAD has LTP columns at fixed "1": CE_LTP = PE_LTP = 1
  const [snap] = parseSnapshotCsv([HEAD, row('2026-11-10 10:00:00', 22550, 750000, 5, 10, 120000, -5, 10)].join('\n'));
  const rows = buildBoardRows(snap, 1, { ce: { '22550': 0.5 }, pe: {} });
  const r = rows.find(x => x.strike === 22550)!;
  assert.equal(r.call!.buildup, 'LB');   // OI +5, price 1 vs 0.5
  assert.equal(r.put!.buildup, null);    // no previous close for the put
  assert.equal(buildBoardRows(snap, 1).find(x => x.strike === 22550)!.call!.buildup, null);
});

test('delta OI: call total OI minus put total OI; unknown when either side is missing', async () => {
  const { oiDelta } = await import('./freshMoney.ts');
  const side = (oi: number | null) => ({ oi, oiMoved: 0, vol: 0, buildup: null });
  assert.equal(oiDelta({ call: side(150000), put: side(31251) }), 118749);
  assert.equal(oiDelta({ call: side(49071), put: side(110000) }), -60929);
  assert.equal(oiDelta({ call: side(5), put: side(5) }), 0);
  assert.equal(oiDelta({ call: null, put: side(5) }), null);
  assert.equal(oiDelta({ call: side(5), put: side(null) }), null);
});

// ── oiFlow ──
/** One snapshot every 30 s from `from` to `to` (HH:MM), strike 22550 with CE OI = f(minute) and PE OI = g(minute). */
function series(from: string, to: string, ce: (m: number) => number | '', pe: (m: number) => number | '', skip: (m: number) => boolean = () => false, exp = '2026-11-12', ceChg: (m: number) => number | '' = () => '') {
  const [fh, fm] = from.split(':').map(Number), [th, tm] = to.split(':').map(Number);
  const lines = [HEAD];
  for (let m = fh * 60 + fm; m <= th * 60 + tm + 1e-9; m += 0.5) {
    if (skip(m)) continue;
    const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(Math.floor(m % 60)).padStart(2, '0');
    const ss = m % 1 ? '30' : '00';
    lines.push(`2026-11-13 ${hh}:${mm}:${ss},22575,${exp},22550,1,1,${ce(m)},${ceChg(m)},0,1,1,${pe(m)},,0`);
  }
  return parseSnapshotCsv(lines.join('\n'));
}
const M = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

test('fmtOiShort keeps cells narrow', () => {
  assert.equal(fmtOiShort(null), '–');
  assert.equal(fmtOiShort(0.2), '0');
  assert.equal(fmtOiShort(950), '+950');
  assert.equal(fmtOiShort(-1234), '-1.2k');
  assert.equal(fmtOiShort(83718), '+84k');
  assert.equal(fmtOiShort(-120000), '-1.2L');
  assert.equal(fmtOiShort(1.1e7), '+1.1Cr');
});

test('parse skips a row cut short by a write in progress (never reads a truncated OI)', () => {
  const full = row('2026-11-10 09:20:00', 22550, 11265020, 10, 50, 200, 20, 100);
  const cut = full.slice(0, full.indexOf('11265020') + 3);   // "...,112" — the collector is mid-write
  const snaps = parseSnapshotCsv([HEAD, row('2026-11-10 09:20:00', 22600, 5, 1, 1, 5, 1, 1), cut].join('\n'));
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].strikes.has(22550), false);
  assert.equal(snaps[0].strikes.get(22600)!.ce.oi, 5);
});

// ── oiFlow: fixed 3-min slots from the 09:15 open ──
const OPEN = 9 * 60 + 15;
const slotsOf = (snaps: ReturnType<typeof series>) => oiFlow(snaps, { slots: 5, slotMin: 3, anchorMin: OPEN });
const lab = (f: ReturnType<typeof slotsOf>) => f.bounds.map(fmtMinOfDay);

test('oiFlow: slots are fixed offsets from the open; 5 completed + the running one; total adds up', () => {
  // CE +100 per minute from 09:15; last snapshot 10:31:00 -> running slot 10:30-10:33.
  // Previous close OI 1000, so today's change = 100 per minute too.
  const f = slotsOf(series('09:15', '10:31', m => 1000 + 100 * (m - OPEN), () => 7, () => false, '2026-11-12', m => 100 * (m - OPEN)));
  assert.deepEqual(lab(f), ['10:15', '10:18', '10:21', '10:24', '10:27', '10:30']);
  assert.equal(f.lastTs, '10:31:00');
  const s = f.byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [300, 300, 300, 300, 300, 100]);   // last = running 10:30 -> 10:31
  assert.equal(s.ce.day, 7500);                                     // today's change at the 10:30 edge (75 min x 100)
  assert.equal(s.pe.day, null);                                     // no change on record -> unknown, not 0
  assert.deepEqual(s.pe.cells, [0, 0, 0, 0, 0, 0]);
});

test('oiFlow: completed slots are frozen; the running slot freezes when it ends and the row shifts', () => {
  const ce = (m: number) => 1000 + 100 * (m - OPEN) + (m >= M('10:31') ? 50 : 0);   // a jump inside the running slot
  const at1031 = slotsOf(series('09:15', '10:31', ce, () => 1)).byStrike.get(22550)!.ce.cells;
  const at1032 = slotsOf(series('09:15', '10:32', ce, () => 1)).byStrike.get(22550)!.ce.cells;
  assert.deepEqual(at1031.slice(0, 5), at1032.slice(0, 5));           // completed slots did not move
  assert.equal(at1031[5], 150);
  assert.equal(at1032[5], 250);                                       // running slot keeps counting
  const f1033 = slotsOf(series('09:15', '10:33', ce, () => 1));
  assert.deepEqual(lab(f1033), ['10:18', '10:21', '10:24', '10:27', '10:30', '10:33']);
  assert.deepEqual(f1033.byStrike.get(22550)!.ce.cells, [300, 300, 300, 300, 350, 0]);   // 10:30-10:33 now frozen
});

test('oiFlow: the open boundary is the previous close OI (OI - change), so the first slot has a value', () => {
  // Previous close OI 5000; collector starts 09:15:30.
  const snaps = series('09:15', '09:20', m => 5000 + 200 * (m - OPEN), () => 1, m => m < OPEN + 0.5, '2026-11-12', m => 200 * (m - OPEN));
  const f = slotsOf(snaps);
  assert.deepEqual(lab(f), ['09:03', '09:06', '09:09', '09:12', '09:15', '09:18']);
  assert.deepEqual(f.boundOk, [false, false, false, false, true, true]);
  const s = f.byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [null, null, null, null, 600, 400]);   // 09:15-09:18 from 5000, running 09:18-09:20
  assert.equal(s.ce.day, 600);                                      // = the open slot's cell
  // No change on record -> no open value (never assume the change was 0).
  assert.deepEqual(slotsOf(series('09:15', '09:20', m => 5000 + m, () => 1, m => m < OPEN + 0.5)).byStrike.get(22550)!.ce.cells.slice(4, 5), [null]);
});

test('oiFlow: a collector gap at a slot edge nulls the slots it bounds; the total still comes from the ends', () => {
  // No snapshots 10:22-10:24:00 -> the 10:24 edge would read 10:21:30 (2.5 min early): refused.
  const snaps = series('09:15', '10:31', m => 100 * m, () => 7, m => m >= M('10:22') && m <= M('10:24'), '2026-11-12', m => 100 * (m - OPEN));
  const f = slotsOf(snaps);
  assert.deepEqual(f.boundOk, [true, true, true, false, true, true]);
  const s = f.byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [300, 300, null, null, 300, 100]);
  assert.equal(s.ce.day, 7500);   // the latest completed edge (10:30) has a reading
});

test('oiFlow: a missing OI is null, never 0', () => {
  const s = slotsOf(series('09:15', '10:31', m => (m < M('10:20') ? '' : 1000), () => 1)).byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [null, null, 0, 0, 0, 0]);
  assert.equal(s.ce.day, null);
});

test('oiFlow: an edge on another expiry is refused', () => {
  const older = series('10:10', '10:22', () => 1, () => 1, () => false, '2026-11-05');
  const newer = series('10:22', '10:31', () => 9, () => 9).filter(x => x.min > M('10:22'));
  const f = slotsOf([...older, ...newer]);
  assert.deepEqual(f.boundOk, [false, false, false, true, true, true]);
  assert.deepEqual(f.byStrike.get(22550)!.ce.cells, [null, null, null, 0, 0, 0]);
});

test('oiFlow: MCX slots count from 09:00', () => {
  const f = oiFlow(series('09:00', '09:10', m => m, () => 1), { slots: 5, slotMin: 3, anchorMin: 9 * 60 });
  assert.deepEqual(f.bounds.map(fmtMinOfDay), ['08:54', '08:57', '09:00', '09:03', '09:06', '09:09']);
});

test('oiFlow: a gap at the latest edge falls back to the newest earlier edge for today\'s change, labelled', () => {
  // No snapshots 10:28:00-10:30:00 (e.g. a collector restart): the 10:30 edge would read 10:27:30, 2.5 min early.
  const chg = (m: number) => 100 * (m - OPEN);
  const f = slotsOf(series('09:15', '10:31', m => 1000 + chg(m), () => 1, m => m >= M('10:28') && m <= M('10:30'), '2026-11-12', chg));
  assert.deepEqual(f.boundOk, [true, true, true, true, true, false]);
  assert.equal(fmtMinOfDay(f.dayAt!), '10:27');
  assert.equal(f.byStrike.get(22550)!.ce.day, 7200);                 // change at 10:27, not blank
  // Every shown edge empty -> no day, no label.
  const none = slotsOf(series('10:29', '10:31', m => 1000 + chg(m), () => 1, () => false, '2026-11-12', chg)
    .filter(s => s.min > M('10:30')));
  assert.equal(none.dayAt, null);
  assert.equal(none.byStrike.get(22550)!.ce.day, null);
});

test('oiFlow: no snapshots', () => {
  const f = oiFlow([], { anchorMin: OPEN });
  assert.equal(f.byStrike.size, 0);
  assert.equal(f.bounds.length, 6);
  assert.deepEqual(f.boundOk, [false, false, false, false, false, false]);
  assert.equal(f.dayAt, null);
});

test('oiFlow: each completed slot adds exactly its cell to today\'s change', () => {
  const ce = (m: number) => 4000 + Math.round(37 * Math.sin(m) * 100) + 50 * (m - OPEN);
  const chg = (m: number) => ce(m) - 3000;   // previous close OI 3000
  const a = slotsOf(series('09:15', '10:32', ce, () => 1, () => false, '2026-11-12', chg)).byStrike.get(22550)!.ce;
  const b = slotsOf(series('09:15', '10:33', ce, () => 1, () => false, '2026-11-12', chg)).byStrike.get(22550)!.ce;
  assert.equal(b.day! - a.day!, b.cells[4]);   // the 10:30-10:33 slot that just completed
});

test('flowScale is the 95th percentile of |cell|, so one outlier does not set it', () => {
  assert.equal(flowScale([]), 0);
  assert.equal(flowScale([null, null]), 0);
  const v = [...Array.from({ length: 99 }, (_, i) => (i % 2 ? -(i + 1) : i + 1)), 1e6, null];
  assert.ok(Math.abs(flowScale(v) - 95.05) < 1e-9);   // 100 values: 95th pct between 95 and 96, not 1e6
});

test('flowTier boundaries', () => {
  assert.equal(flowTier(null, 100), 'none');
  assert.equal(flowTier(0, 100), 'none');
  assert.equal(flowTier(50, 0), 'none');
  assert.equal(flowTier(9.9, 100), 'none');
  assert.equal(flowTier(-10, 100), 'low');
  assert.equal(flowTier(34.9, 100), 'low');
  assert.equal(flowTier(35, 100), 'mid');
  assert.equal(flowTier(-69.9, 100), 'mid');
  assert.equal(flowTier(70, 100), 'high');
  assert.equal(flowTier(-500, 100), 'high');
});

test('flowStreak counts completed slots only, newest backwards; null / 0 / a flip ends it; under 3 = none', () => {
  // 5 completed + running (last). Running is ignored even when it flips.
  assert.deepEqual(flowStreak([-5, 1, 2, 3, 4, -99], 5, 1), { dir: 1, n: 4 });
  assert.deepEqual(flowStreak([1, -2, -3, -4, -5, 9], 5, 1), { dir: -1, n: 4 });
  assert.equal(flowStreak([1, 2, 3, -4, 5, 6], 5, 1), null);          // run of 1
  assert.deepEqual(flowStreak([9, null, 1, 2, 3, 0], 5, 1), { dir: 1, n: 3 });
  assert.equal(flowStreak([1, 2, 0, 3, 4, 1], 5, 1), null);           // 0 breaks: run of 2
  assert.equal(flowStreak([1, 2, 3, 4, null, 1], 5, 1), null);        // newest completed unknown
  assert.deepEqual(flowStreak([1, 1, 1, 1, 1, 1], 5, 1), { dir: 1, n: 5 });
});

test('flowStreak: a grey (under 10 % of the scale) move ends the run, so badges never sit on noise', () => {
  // Scale 1000: 50 is grey. +2, +1, +3 lots in a row is noise, not a trend.
  assert.equal(flowStreak([500, 2, 1, 3, 0], 4, 1000), null);
  assert.equal(flowStreak([500, 400, 50, 300, 200, 9], 5, 1000), null);            // run of 2 after the grey 50
  assert.deepEqual(flowStreak([500, 400, 150, 300, 200, 9], 5, 1000), { dir: 1, n: 5 });
  assert.equal(flowStreak([500, 400, 300, 200], 4, 0), null);                    // no scale -> every cell is grey
});

test('sumFlows: a slot is summed only when every strike with data has it; counts say how many did', () => {
  const t = sumFlows([
    { cells: [1, null, 3], day: 10 },
    { cells: [2, null, null], day: null },
    null,
    { cells: [-4, null, 5], day: -3 },
    { cells: [null, null, null], day: null },          // never recorded: not counted
  ], 3);
  assert.equal(t.n, 3);
  assert.deepEqual(t.counts, [3, 0, 2]);
  assert.deepEqual(t.cells, [-1, null, null]);         // slot 2: only 2 of 3 strikes -> no partial sum
  assert.equal(t.dayCount, 2);
  assert.equal(t.day, null);                           // one strike has no day -> no total
  const full = sumFlows([{ cells: [1, 2], day: 5 }, { cells: [3, 4], day: 6 }], 2);
  assert.deepEqual([full.cells, full.day, full.n], [[4, 6], 11, 2]);
  assert.deepEqual(sumFlows([], 2), { cells: [null, null], day: null, counts: [0, 0], dayCount: 0, n: 0 });
});

test('streakVsDay: with / against / no day / zero day / no streak', () => {
  assert.equal(streakVsDay({ dir: -1 }, 14052), 'against');
  assert.equal(streakVsDay({ dir: 1 }, -500), 'against');
  assert.equal(streakVsDay({ dir: 1 }, 99999), 'with');
  assert.equal(streakVsDay({ dir: -1 }, -1), 'with');
  assert.equal(streakVsDay({ dir: 1 }, null), null);
  assert.equal(streakVsDay({ dir: 1 }, 0.2), null);
  assert.equal(streakVsDay(null, 500), null);
});
