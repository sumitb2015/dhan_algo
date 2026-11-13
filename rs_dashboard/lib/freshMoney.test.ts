import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSnapshotCsv, buildBoardRows, buildupOf, fmtOi, fmtOiAbs, strikeStep, hasCumulativeVolume, oiFlow, fmtOiShort,
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
function series(from: string, to: string, ce: (m: number) => number | '', pe: (m: number) => number | '', skip: (m: number) => boolean = () => false, exp = '2026-11-12') {
  const [fh, fm] = from.split(':').map(Number), [th, tm] = to.split(':').map(Number);
  const lines = [HEAD];
  for (let m = fh * 60 + fm; m <= th * 60 + tm + 1e-9; m += 0.5) {
    if (skip(m)) continue;
    const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(Math.floor(m % 60)).padStart(2, '0');
    const ss = m % 1 ? '30' : '00';
    lines.push(`2026-11-13 ${hh}:${mm}:${ss},22575,${exp},22550,1,1,${ce(m)},,0,1,1,${pe(m)},,0`);
  }
  return parseSnapshotCsv(lines.join('\n'));
}
const M = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

test('oiFlow: five clean windows add up to the total, oldest first', () => {
  // CE grows 100 per minute; PE falls 20 per minute after 10:10.
  const snaps = series('09:30', '10:25', m => 1000 + 100 * (m - M('09:30')), m => 5000 - 20 * Math.max(0, m - M('10:10')));
  const f = oiFlow(snaps);
  assert.deepEqual(f.marks, ['10:00', '10:05', '10:10', '10:15', '10:20', '10:25']);
  const s = f.byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [500, 500, 500, 500, 500]);
  assert.equal(s.ce.total, 2500);
  assert.deepEqual(s.pe.cells, [0, 0, -100, -100, -100]);
  assert.equal(s.pe.total, -300);
});

test('oiFlow: a collector gap nulls that window; the total still comes from the two ends', () => {
  // No snapshots from 10:12 to 10:15:30 -> boundary 10:15 has no reading within 2 min (latest is 10:11:30).
  const snaps = series('09:30', '10:25', m => 100 * m, () => 7, m => m >= M('10:12') && m <= M('10:15') + 0.5);
  const s = oiFlow(snaps).byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [500, 500, null, null, 500]);
  assert.equal(s.ce.total, 2500);
  assert.deepEqual(oiFlow(snaps).marks, ['10:00', '10:05', '10:10', null, '10:20', '10:25']);
});

test('oiFlow: under 25 minutes of data leaves the older cells null', () => {
  const s = oiFlow(series('09:15', '09:27', m => 10 * m, () => 1)).byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [null, null, null, 50, 50]);
  assert.equal(s.ce.total, null);   // neither end-to-end nor every cell is known
});

test('oiFlow: a missing OI is null, never 0', () => {
  const snaps = series('09:30', '10:25', m => (m < M('10:06') ? '' : 1000), () => 1);
  const s = oiFlow(snaps).byStrike.get(22550)!;
  assert.deepEqual(s.ce.cells, [null, null, 0, 0, 0]);
  assert.equal(s.ce.total, null);
});

test('oiFlow: a boundary on another expiry is refused', () => {
  const older = series('09:55', '10:12', () => 1, () => 1, () => false, '2026-11-05');
  const newer = series('10:12:30'.slice(0, 5), '10:25', () => 9, () => 9);
  const f = oiFlow([...older, ...newer.filter(s => s.min > M('10:12'))]);
  assert.deepEqual(f.marks.slice(0, 3), [null, null, null]);
  assert.deepEqual(f.byStrike.get(22550)!.ce.cells.slice(2), [null, 0, 0]);
});

test('oiFlow: no snapshots', () => {
  const f = oiFlow([]);
  assert.equal(f.byStrike.size, 0);
  assert.equal(f.marks.length, 6);
});

test('fmtOiShort keeps cells narrow', () => {
  assert.equal(fmtOiShort(null), '–');
  assert.equal(fmtOiShort(0.2), '0');
  assert.equal(fmtOiShort(950), '+950');
  assert.equal(fmtOiShort(-1234), '-1.2k');
  assert.equal(fmtOiShort(83718), '+84k');
  assert.equal(fmtOiShort(-120000), '-1.2L');
  assert.equal(fmtOiShort(1.1e7), '+1.1Cr');
});
