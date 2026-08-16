import { test } from 'node:test';
import assert from 'node:assert';
import {
  resampleBars,
  groupByBucket,
  valueArea,
  buildFootprint,
  markImbalances,
  windowStats,
  chartProfile,
  balance,
  residual,
  priceWindow,
  suggestTickSize,
  type Bar,
  type FootprintCell,
} from './volumeProfile.ts';

/** Build a run of 1-minute bars starting at 09:15 on a fixed day. */
function minuteBars(specs: [number, number, number, number, number][], startMin = 9 * 60 + 15): Bar[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  return specs.map(([o, h, l, c, v], i) => {
    const m = startMin + i;
    return { t: `2026-08-14 ${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`, o, h, l, c, v };
  });
}

const cell = (price: number, buy: number, sell: number): FootprintCell => ({
  price, buy, sell, total: buy + sell, buyImb: false, sellImb: false,
});

// ── resampling ───────────────────────────────────────────────────────────────

test('resampleBars lands on the 09:15 grid and aggregates OHLCV correctly', () => {
  const bars = minuteBars([
    [100, 105, 99, 104, 10],
    [104, 106, 103, 105, 20],
    [105, 107, 101, 102, 30],
    [102, 103, 100, 101, 40],
    [101, 102, 98, 99, 50],
    [99, 100, 97, 98, 60],
  ]);
  const out = resampleBars(bars, 5);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].t, '2026-08-14 09:15:00');
  assert.strictEqual(out[1].t, '2026-08-14 09:20:00');
  assert.deepStrictEqual(
    { o: out[0].o, h: out[0].h, l: out[0].l, c: out[0].c, v: out[0].v },
    { o: 100, h: 107, l: 98, c: 99, v: 150 },
  );
});

test('resampleBars anchors 30m buckets to the session open, not to midnight', () => {
  // 555 is not divisible by 30, so midnight-anchored flooring would emit 09:00 and split
  // the first half-hour in two. The session anchor keeps 09:15–09:44 in one bucket.
  const bars = minuteBars([...Array(30)].map((_, i) => [100 + i, 100 + i, 100 + i, 100 + i, 1] as [number, number, number, number, number]));
  const out = resampleBars(bars, 30);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].t, '2026-08-14 09:15:00');
  assert.strictEqual(out[0].v, 30);
});

test('resampleBars at 1 minute is a passthrough', () => {
  const bars = minuteBars([[1, 2, 0.5, 1.5, 7]]);
  assert.deepStrictEqual(resampleBars(bars, 1), bars);
});

test('groupByBucket keeps every constituent print in session order', () => {
  const bars = minuteBars([
    [100, 101, 99, 100, 1],
    [100, 102, 100, 101, 2],
    [101, 101, 100, 100, 3],
  ]);
  const g = groupByBucket(bars, 15);
  assert.strictEqual(g.size, 1);
  assert.deepStrictEqual(g.get('2026-08-14 09:15:00')!.map((b) => b.v), [1, 2, 3]);
});

// ── volume conservation ──────────────────────────────────────────────────────

test('geometric split conserves total volume exactly (residual reports EXACT)', () => {
  const bars = minuteBars([
    [100, 105, 99, 104, 1000],
    [104, 106, 103, 103, 2500],
    [103, 103.5, 98, 99, 777],
    [99, 102, 99, 102, 1234],
    [102, 102, 102, 102, 500],  // flat bar — no path to model
  ]);
  const { columns } = buildFootprint(bars, {
    tfMinutes: 1, tickSize: 0.05, engine: 'geometric',
    valueAreaPct: 70, imbalancePct: 300, volumeConcentration: 3,
  });
  const res = residual(columns, 1);
  assert.ok(res.exact, `expected EXACT, got ${res.ppm} ppm`);

  for (const col of columns) {
    assert.ok(Math.abs(col.buy + col.sell - col.v) < 1e-6, `column ${col.t} lost volume`);
  }
});

test('intrabar split conserves total volume exactly', () => {
  const bars = minuteBars([
    [100, 105, 99, 104, 1000],
    [104, 106, 103, 103, 2500],
    [103, 103, 103, 103, 900],  // flat print, resolved by the uptick rule
  ]);
  const { columns } = buildFootprint(bars, {
    tfMinutes: 15, tickSize: 0.05, engine: 'intrabar',
    valueAreaPct: 70, imbalancePct: 300, volumeConcentration: 3,
  });
  assert.strictEqual(columns.length, 1);
  assert.ok(residual(columns, 1).exact);
  assert.ok(Math.abs(columns[0].buy + columns[0].sell - 4400) < 1e-6);
});

test('an up candle attributes more volume to buying than selling', () => {
  // o=100 l=99.5 h=105 c=104.5: the l→h buy leg (5.5) dominates the two sell legs (1.0).
  const bars = minuteBars([[100, 105, 99.5, 104.5, 1000]]);
  const { columns } = buildFootprint(bars, {
    tfMinutes: 1, tickSize: 0.5, engine: 'geometric',
    valueAreaPct: 70, imbalancePct: 300, volumeConcentration: 3,
  });
  const col = columns[0];
  assert.ok(col.delta > 0, 'up candle should have positive delta');
  assert.ok(Math.abs(col.buy - 1000 * (5.5 / 6.5)) < 1e-6);
});

test('a flat doji splits evenly and sits on one price', () => {
  const bars = minuteBars([[100, 100, 100, 100, 800]]);
  const { columns } = buildFootprint(bars, {
    tfMinutes: 1, tickSize: 0.05, engine: 'geometric',
    valueAreaPct: 70, imbalancePct: 300, volumeConcentration: 3,
  });
  assert.strictEqual(columns[0].cells.length, 1);
  assert.strictEqual(columns[0].buy, 400);
  assert.strictEqual(columns[0].sell, 400);
});

// ── value area ───────────────────────────────────────────────────────────────

test('valueArea finds the POC and expands to the requested coverage', () => {
  // Volumes 10/20/100/20/10 = 160 total, so 70% coverage is 112. The POC row alone gives
  // 100, short of target; expansion picks the side whose next two rows hold more (a tie
  // here, so upward) and stops the moment coverage is met — after ONE row, not the whole
  // pair. So the area is 102–103 and the lower side is never touched.
  const rows = [10, 20, 100, 20, 10].map((v, i) => ({ price: 100 + i, buy: v, sell: 0, total: v }));
  const va = valueArea(rows, 70);
  assert.strictEqual(va.poc, 102);
  assert.strictEqual(va.total, 160);
  assert.strictEqual(va.vah, 103);
  assert.strictEqual(va.val, 102);
});

test('valueArea at 100% spans the whole profile', () => {
  const rows = [5, 9, 3, 7].map((v, i) => ({ price: 50 + i, buy: v, sell: 0, total: v }));
  const va = valueArea(rows, 100);
  assert.strictEqual(va.val, 50);
  assert.strictEqual(va.vah, 53);
});

test('valueArea degenerates safely on an empty or zero-volume profile', () => {
  assert.deepStrictEqual(valueArea([], 70), { poc: 0, vah: 0, val: 0, total: 0 });
  const zero = valueArea([{ price: 10, buy: 0, sell: 0, total: 0 }], 70);
  assert.deepStrictEqual(zero, { poc: 10, vah: 10, val: 10, total: 0 });
});

// ── imbalance ────────────────────────────────────────────────────────────────

test('diagonal imbalance flags at exactly the threshold, not below it', () => {
  // buy@101 = 300 vs sell@100 = 100 is exactly 300%.
  const cells = [cell(100, 50, 100), cell(101, 300, 50), cell(102, 299, 50)];
  markImbalances(cells, 1, 300, 0);
  assert.strictEqual(cells[1].buyImb, true, '300% must flag');

  const justUnder = [cell(100, 50, 100), cell(101, 299.9, 50)];
  markImbalances(justUnder, 1, 300, 0);
  assert.strictEqual(justUnder[1].buyImb, false, '299.9% must not flag');
});

test('imbalance compares diagonally — buy against the sell one tick BELOW', () => {
  // buy@101 is huge but so is sell@100, so no flag; sell@102 dwarfs buy@103, so sell flags.
  const cells = [cell(100, 0, 400), cell(101, 500, 0), cell(102, 0, 900), cell(103, 10, 0)];
  markImbalances(cells, 1, 300, 0);
  assert.strictEqual(cells[1].buyImb, false);
  assert.strictEqual(cells[2].sellImb, true);
});

test('an empty opposing cell is treated as an infinite ratio', () => {
  const cells = [cell(100, 0, 0), cell(101, 250, 0)];
  markImbalances(cells, 1, 300, 0);
  assert.strictEqual(cells[1].buyImb, true);
});

test('volumeConcentration suppresses imbalances in thin rows', () => {
  // The 3-lot row at 101 out-ratios the row below, but is far under 3x the median.
  const cells = [cell(100, 0, 1), cell(101, 3, 0), cell(102, 900, 900), cell(103, 800, 800)];
  markImbalances(cells, 1, 300, 3);
  assert.strictEqual(cells[1].buyImb, false);
});

// ── aggregates ───────────────────────────────────────────────────────────────

test('windowStats merges only the trailing N columns', () => {
  const bars = minuteBars([
    [100, 100, 100, 100, 100],
    [200, 200, 200, 200, 300],
    [300, 300, 300, 300, 500],
  ]);
  const { columns } = buildFootprint(bars, {
    tfMinutes: 1, tickSize: 1, engine: 'geometric',
    valueAreaPct: 70, imbalancePct: 300, volumeConcentration: 3,
  });
  const win = windowStats(columns, 2, 70);
  assert.strictEqual(win.volume, 800);
  assert.deepStrictEqual(win.rows.map((r) => r.price), [200, 300]);
  assert.strictEqual(win.poc, 300);
});

test('columnLimit leaves earlier columns as bars with no cells', () => {
  const bars = minuteBars([
    [100, 101, 99, 100, 10],
    [100, 101, 99, 100, 10],
    [100, 101, 99, 100, 10],
  ]);
  const { columns } = buildFootprint(bars, {
    tfMinutes: 1, tickSize: 0.5, engine: 'geometric',
    valueAreaPct: 70, imbalancePct: 300, volumeConcentration: 3, columnLimit: 1,
  });
  assert.strictEqual(columns.length, 3);
  assert.strictEqual(columns[0].cells.length, 0);
  assert.ok(columns[2].cells.length > 0);
  // The residual check must ignore the columns that were never expanded.
  assert.ok(residual(columns, 1).exact);
});

test('chartProfile bins to the requested resolution and conserves volume', () => {
  const bars = minuteBars([...Array(40)].map((_, i) => {
    const p = 100 + (i % 10);
    return [p, p + 1, p - 1, p + 0.5, 100] as [number, number, number, number, number];
  }));
  const prof = chartProfile(bars, {
    tfMinutes: 5, profilePeriod: 80, resolution: 20, engine: 'intrabar', valueAreaPct: 70,
  });
  assert.ok(prof.rows.length > 1 && prof.rows.length <= 25);
  const total = prof.rows.reduce((s, r) => s + r.total, 0);
  assert.ok(Math.abs(total - 4000) < 1e-6);
  assert.ok(prof.val <= prof.poc && prof.poc <= prof.vah);
});

test('balance reports full overlap when the window sits inside the chart value area', () => {
  const win = {
    poc: 100, vah: 101, val: 99, total: 300, volume: 300, buy: 150, sell: 150, delta: 0,
    rows: [99, 100, 101].map((p) => ({ price: p, buy: 50, sell: 50, total: 100 })),
  };
  const chart = { poc: 100, vah: 110, val: 90, total: 1000, rows: [], binSize: 1 };
  const b = balance(win, chart, 5);
  assert.strictEqual(b.ovl, 1);
  assert.strictEqual(b.balanced, true);
  assert.strictEqual(b.tiltPct, 0);
});

test('balance reports partial overlap and an imbalanced tilt when the window breaks out', () => {
  const win = {
    poc: 120, vah: 121, val: 105, total: 200, volume: 200, buy: 200, sell: 0, delta: 200,
    rows: [
      { price: 105, buy: 100, sell: 0, total: 100 },   // inside the chart VA
      { price: 120, buy: 100, sell: 0, total: 100 },   // above it
    ],
  };
  const chart = { poc: 100, vah: 110, val: 90, total: 1000, rows: [], binSize: 1 };
  const b = balance(win, chart, 5);
  assert.strictEqual(b.ovl, 0.5);
  assert.strictEqual(b.balanced, false);
  assert.strictEqual(b.tiltPct, 200);
});

test('residual flags a split that loses volume', () => {
  const fake = [{
    t: 'x', o: 1, h: 1, l: 1, c: 1, v: 1000,
    cells: [cell(1, 400, 400)], poc: 1, vah: 1, val: 1, buy: 400, sell: 400, delta: 0,
  }];
  const res = residual(fake, 1);
  assert.strictEqual(res.exact, false);
  assert.ok(Math.abs(res.ppm - 200_000) < 1e-6);
});

// ── tick suggestion ──────────────────────────────────────────────────────────

test('suggestTickSize snaps up to the ladder so a typical bar spans ~targetRows', () => {
  // Every 1m bar spans 1.0, so a 5m bar spans ~1.0 too; 1.0/20 = 0.05 exactly.
  const flat = minuteBars([...Array(20)].map(() => [100, 100.5, 99.5, 100, 10] as [number, number, number, number, number]));
  assert.strictEqual(suggestTickSize(flat, 5, 20), 0.05);

  // A ₹3000 stock ranging ~10 per 15m bar needs 10/20 = 0.5, not the exchange's 0.05.
  const wide = minuteBars([...Array(30)].map((_, i) => {
    const p = 3000 + (i % 2) * 10;
    return [p, p + 5, p - 5, p, 100] as [number, number, number, number, number];
  }));
  assert.ok(suggestTickSize(wide, 15, 20) >= 0.5);
});

test('suggestTickSize ignores zero-range bars and degenerates to the finest tick', () => {
  const frozen = minuteBars([[100, 100, 100, 100, 5], [100, 100, 100, 100, 5]]);
  assert.strictEqual(suggestTickSize(frozen, 5, 20), 0.05);
  assert.strictEqual(suggestTickSize([], 5, 20), 0.05);
});

test('suggestTickSize is driven by the median, not by one climax bar', () => {
  const specs: [number, number, number, number, number][] = [...Array(20)].map(
    () => [100, 100.5, 99.5, 100, 10],
  );
  const calm = suggestTickSize(minuteBars(specs), 1, 20);
  specs[0] = [100, 500, 100, 400, 10];  // one enormous outlier
  assert.strictEqual(suggestTickSize(minuteBars(specs), 1, 20), calm);
});

// ── display window ───────────────────────────────────────────────────────────

test('priceWindow returns 2N+1 gap-free rows descending from the top', () => {
  const cols = [{
    t: 'x', o: 1, h: 1, l: 1, c: 1, v: 1,
    cells: [cell(24366, 1, 1)], poc: 24366, vah: 24366, val: 24366, buy: 1, sell: 1, delta: 0,
  }];
  const rows = priceWindow(cols, 24366, 0.05, 8);
  assert.strictEqual(rows.length, 17);
  assert.ok(Math.abs(rows[0] - 24366.4) < 1e-9);
  assert.ok(Math.abs(rows[rows.length - 1] - 24365.6) < 1e-9);
});
