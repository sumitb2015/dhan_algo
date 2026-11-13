import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSnapshotCsv, buildBoardRows, buildupOf, fmtOi, fmtOiAbs, strikeStep, hasCumulativeVolume,
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
