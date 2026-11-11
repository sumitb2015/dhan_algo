import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSnapshotCsv, boardFresh, windowFresh, summarizeDay, percentile, normalAt, bandFromHistory,
  buildBoardRows, buildupOf, intensity, fmtOi, fmtOiAbs, fmtPct, strikeStep, hasCumulativeVolume, type DaySummary,
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

test('zero volume and missing change give null, not 0', () => {
  const [s] = parseSnapshotCsv([HEAD, row('2026-11-10 09:20:00', 22550, 100, '', 0, 200, 5, 0)].join('\n'));
  assert.deepEqual(boardFresh(s), { puts: null, calls: null });
  const r = buildBoardRows(s).find(x => x.strike === 22550)!;
  assert.equal(r.call!.fresh, null);
  assert.equal(r.call!.oiMoved, null);
  assert.equal(r.put!.oiMoved, 5);
});

test('board fresh is Σ|chg| / Σvol per side, unwinding counts as fresh', () => {
  const [s] = parseSnapshotCsv([HEAD,
    row('2026-11-10 10:00:00', 22550, 0, 30, 100, 0, -10, 100),
    row('2026-11-10 10:00:00', 22600, 0, -10, 100, 0, 30, 300),
  ].join('\n'));
  const b = boardFresh(s);
  assert.equal(b.calls, 40 / 200);
  assert.equal(b.puts, 40 / 400);
});

test('window fresh uses only strikes present in both snapshots (ATM window drift)', () => {
  const [a, b] = parseSnapshotCsv([HEAD,
    row('2026-11-10 10:00:00', 22550, 1000, 0, 500, 1000, 0, 500),
    row('2026-11-10 10:00:00', 22500, 1000, 0, 500, 1000, 0, 500),
    row('2026-11-10 10:05:00', 22550, 1050, 0, 700, 990, 0, 600),
    row('2026-11-10 10:05:00', 22650, 9999, 0, 9999, 9999, 0, 9999),
  ].join('\n'));
  const w = windowFresh(a, b);
  assert.equal(w.calls, 50 / 200);
  assert.equal(w.puts, 10 / 100);
});

test('window fresh skips a strike whose cumulative volume went backwards', () => {
  const [a, b] = parseSnapshotCsv([HEAD,
    row('2026-11-10 10:00:00', 22550, 1000, 0, 500, 1000, 0, 500),
    row('2026-11-10 10:05:00', 22550, 1050, 0, 100, 1000, 0, 500),
  ].join('\n'));
  assert.deepEqual(windowFresh(a, b), { puts: null, calls: null });
});

test('summarizeDay builds a rolling series only once 5 minutes of history exist, and not across gaps', () => {
  const lines = [HEAD];
  for (let i = 0; i <= 20; i++) {
    if (i >= 12 && i <= 19) continue; // a 4-minute collector gap
    const m = 15 + i * 0.5;
    const ts = `2026-11-10 09:${String(Math.floor(m)).padStart(2, '0')}:${m % 1 ? '30' : '00'}`;
    lines.push(row(ts, 22550, 1000 + i * 10, 0, 100 + i * 100, 1000, 0, 100 + i * 100));
  }
  const d = summarizeDay(parseSnapshotCsv(lines.join('\n')));
  assert.ok(d.series.every(p => p.m >= 9 * 60 + 20));
  const p = d.series.find(x => x.m === 9 * 60 + 25);
  assert.ok(p, 'point at 09:25');
  assert.equal(p!.calls, 0.1);
  assert.equal(p!.puts, 0);
  assert.equal(d.boardByMinute.size > 0, true);
});

test('percentile interpolates', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([10, 0], 0.1), 1);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test('normal range needs at least 5 history days and compares the same time of day', () => {
  const day = (v: number): DaySummary => ({ series: [], boardByMinute: new Map([[600, { puts: v, calls: v * 2 }], [900, { puts: 0.9, calls: 0.9 }]]) });
  assert.equal(normalAt([day(0.1), day(0.2)], 610).puts, null);
  const hist = [0.1, 0.12, 0.14, 0.16, 0.18].map(day);
  const n = normalAt(hist, 610);
  assert.ok(n.puts && Math.abs(n.puts.lo - 0.108) < 1e-9 && Math.abs(n.puts.hi - 0.172) < 1e-9);
  assert.ok(n.calls && n.calls.hi > n.puts.hi);
});

test('band is per minute across days and hidden with too few days', () => {
  const mk = (v: number): DaySummary => ({ series: [{ m: 600, puts: v, calls: v }], boardByMinute: new Map() });
  assert.equal(bandFromHistory([mk(0.1)], 595, 605).length, 0);
  const band = bandFromHistory([0.1, 0.2, 0.3, 0.4, 0.5].map(mk), 595, 605);
  assert.ok(band.length > 0);
  assert.ok(band.every(b => b.putLo <= b.putHi));
});

test('board rows use a fixed ATM±wings grid; uncollected strikes are null', () => {
  const [s] = parseSnapshotCsv([HEAD,
    row('2026-11-10 10:00:00', 22550, 0, 5, 10, 0, 5, 10),
    row('2026-11-10 10:00:00', 22600, 0, 5, 10, 0, 5, 10),
  ].join('\n'));
  const rows = buildBoardRows(s, 2);
  assert.deepEqual(rows.map(r => r.strike), [22700, 22650, 22600, 22550, 22500]);
  assert.equal(rows[0].put, null);
  assert.equal(rows[2].call!.fresh, 0.5);
  assert.equal(strikeStep([22500, 22600, 22550]), 50);
});

test('intensity buckets against the normal range', () => {
  const r = { lo: 0.09, hi: 0.17 };
  assert.equal(intensity(0.05, r), 'low');
  assert.equal(intensity(0.15, r), 'mid');
  assert.equal(intensity(0.18, r), 'high');
  assert.equal(intensity(0.5, null), 'mid');
});

test('Indian-style OI formatting matches the board', () => {
  assert.equal(fmtOi(83718), '+83,718');
  assert.equal(fmtOi(-134), '-134');
  assert.equal(fmtOi(190000), '+1.9L');
  assert.equal(fmtOi(12000000), '+1.2Cr');
  assert.equal(fmtOi(0), '0');
  assert.equal(fmtOi(null), '–');
  assert.equal(fmtPct(0.174), '17%');
  assert.equal(fmtPct(null), '–');
});

test('per-candle (backfilled) volume is detected and impossible >100% shares are dropped', () => {
  const lines = [HEAD];
  for (let i = 0; i < 12; i++) {
    const ts = `2026-11-10 09:${String(15 + i).padStart(2, '0')}:00`;
    lines.push(row(ts, 22550, 1000 + i * 500, 0, i % 2 ? 50 : 400, 1000, 0, 100 + i * 10));
  }
  const snaps = parseSnapshotCsv(lines.join('\n'));
  assert.equal(hasCumulativeVolume(snaps), false);
  const d = summarizeDay(snaps);
  assert.ok(d.series.every(p => p.calls === null || p.calls <= 1));
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
  const side = (oi: number | null) => ({ oi, oiMoved: 0, vol: 0, fresh: null, buildup: null });
  assert.equal(oiDelta({ call: side(150000), put: side(31251) }), 118749);
  assert.equal(oiDelta({ call: side(49071), put: side(110000) }), -60929);
  assert.equal(oiDelta({ call: side(5), put: side(5) }), 0);
  assert.equal(oiDelta({ call: null, put: side(5) }), null);
  assert.equal(oiDelta({ call: side(5), put: side(null) }), null);
});
