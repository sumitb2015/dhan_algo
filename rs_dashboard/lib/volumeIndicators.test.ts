import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cmf, hasVolume, mfi, obv, relativeVolume, vwapWithStdev, vwma } from './volumeIndicators.ts';
import { computeIndicator, newIndicator, sessionVwap, type Bar } from './indexScalperIndicators.ts';

// Real CRUDEOILM 5-minute bars (3 sessions) with values from an independent pandas implementation of each Pine built-in
// (volumeIndicators.fixture.json, `_source`). A null in the reference (no volume yet, warm-up) is skipped.
const fx = JSON.parse(readFileSync(new URL('./volumeIndicators.fixture.json', import.meta.url), 'utf8')) as Record<string, (number | null)[]> & { bars: Bar[] };
const bars = fx.bars;

function close(got: (number | null)[], want: (number | null)[], tol: number, name: string) {
  assert.equal(got.length, want.length, `${name}: length`);
  let checked = 0;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === null) continue;
    assert.ok(got[i] !== null, `${name}[${i}] is null, want ${want[i]}`);
    assert.ok(Math.abs((got[i] as number) - (want[i] as number)) <= tol * Math.max(1, Math.abs(want[i] as number)), `${name}[${i}] ${got[i]} vs ${want[i]}`);
    checked++;
  }
  assert.ok(checked > want.length * 0.8, `${name}: only ${checked} values compared`);
}

test('VWAP and its stdev match the reference; the centre is exactly sessionVwap', () => {
  const { vwap, sd } = vwapWithStdev(bars);
  close(vwap, fx.vwap, 1e-9, 'vwap');
  close(sd, fx.sd, 1e-7, 'sd');
  assert.deepEqual(vwap, sessionVwap(bars));
});

test('OBV, MFI(14), CMF(20), VWMA(20) match the reference', () => {
  close(obv(bars), fx.obv, 1e-12, 'obv');
  close(mfi(bars, 14), fx.mfi14, 1e-9, 'mfi');
  close(cmf(bars, 20), fx.cmf20, 1e-9, 'cmf');
  close(vwma(bars, 20), fx.vwma20, 1e-9, 'vwma');
});

test('relative volume: against the same time of day in the previous sessions', () => {
  const r = relativeVolume(bars, 2);
  const want = fx.rvol2;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === null) continue;
    assert.ok(Math.abs((r[i] as number) - (want[i] as number)) < 1e-9, `rvol[${i}]`);
  }
  // the first session has nothing earlier to compare with
  const day0 = Math.floor((bars[0].t + 19800) / 86400);
  assert.ok(bars.every((b, i) => Math.floor((b.t + 19800) / 86400) !== day0 || r[i] === null));
});

test('relative volume on daily bars is volume vs the previous N bars', () => {
  const daily: Bar[] = [100, 200, 300, 600].map((v, i) => ({ t: 1_700_000_000 + i * 86400, o: 1, h: 1, l: 1, c: 1, v }));
  assert.deepEqual(relativeVolume(daily, 2), [null, 2, 2, 2.4]);   // 200/100, 300/150, 600/250
});

test('hand-checked small cases', () => {
  const mk = (c: number[], v: number[]): Bar[] => c.map((x, i) => ({ t: 1_795_000_000 + i * 300, o: x, h: x + 1, l: x - 1, c: x, v: v[i] }));
  // OBV: +v on an up close, −v on a down close, unchanged on a flat close
  assert.deepEqual(obv(mk([10, 11, 11, 9], [5, 7, 3, 2])), [0, 7, 7, 5]);
  // CMF: a close at the high is +1 × volume, at the low −1 ×
  const b2: Bar[] = [{ t: 1, o: 1, h: 2, l: 1, c: 2, v: 10 }, { t: 301, o: 1, h: 2, l: 1, c: 1, v: 30 }];
  assert.deepEqual(cmf(b2, 2), [null, (10 - 30) / 40]);
  // MFI: nothing but rising flow after the first bar reads 100
  assert.equal(mfi(mk([1, 2, 3, 4], [1, 1, 1, 1]), 2).at(-1), 100);
});

test('no volume (the index): every volume indicator is empty, the VWAP bands still draw', () => {
  const idx: Bar[] = bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
  assert.equal(hasVolume(idx), false);
  for (const f of [obv(idx), mfi(idx, 14), cmf(idx, 20), vwma(idx, 20), relativeVolume(idx, 10)]) assert.ok(f.every(x => x === null));
  // and on the chart they open no pane (an empty pane would squash the candles)
  for (const k of ['obv', 'mfi', 'cmf', 'vwma', 'rvol'] as const) assert.deepEqual(computeIndicator(idx, newIndicator(k, 'x')), { pane: 'price', series: [] });
  const vb = computeIndicator(idx, newIndicator('vwapbands', 'x'));
  assert.equal(vb.series.length, 5);   // VWAP + band 1 and band 2 (band 3 is off by default)
  assert.ok(vb.series.every(s => s.values.some(x => x !== null)));
});

test('catalog wiring: panes, series and the band switches', () => {
  assert.equal(computeIndicator(bars, newIndicator('obv', 'a')).pane, 'sub');
  assert.equal(computeIndicator(bars, newIndicator('obv', 'a')).series.length, 1);   // SMA off by default
  assert.equal(computeIndicator(bars, { ...newIndicator('obv', 'a'), params: { ma: 20 } }).series.length, 2);
  assert.deepEqual(computeIndicator(bars, newIndicator('mfi', 'a')).series[0].guides, [20, 80]);
  assert.equal(computeIndicator(bars, newIndicator('vwma', 'a')).pane, 'price');
  const rv = computeIndicator(bars, newIndicator('rvol', 'a')).series[0];
  assert.equal(rv.style, 'histogram');
  assert.ok(rv.colors?.some(c => c === '#f59e0b'), 'some bar is highlighted at 2× or more');
  const vb = computeIndicator(bars, { ...newIndicator('vwapbands', 'a'), params: { m1: 1, m2: 0, m3: 3 } });
  assert.deepEqual(vb.series.map(s => s.axisLabel), ['VWAP', '+1σ', '−1σ', '+3σ', '−3σ']);
});

// Parity with a TradingView-style terminal (tradingcharts.co, built-in indicators at their defaults) on BHARTIARTL, read
// off its chart on 2026-11-28 (volumeIndicators.parity.json `_source`). The bars start where the terminal's loaded
// history started, which OBV (a running total) and RVOL (averages the sessions it has, up to 20) depend on. Compared at
// the precision the terminal prints.
const parity = JSON.parse(readFileSync(new URL('./volumeIndicators.parity.json', import.meta.url), 'utf8')) as Record<string, {
  bars: [number, number, number, number, number, number][]; terminal: Record<string, number>;
}>;

for (const tf of ['tf1', 'tf15'] as const) {
  test(`matches the tradingcharts.co terminal on BHARTIARTL ${tf === 'tf1' ? '1' : '15'}-minute bars (27 Nov 2026, last bar)`, () => {
    const bs: Bar[] = parity[tf].bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const want = parity[tf].terminal;
    const last = (kind: Parameters<typeof newIndicator>[0], key = 'v') => {
      const s = computeIndicator(bs, newIndicator(kind, 'p')).series.find(x => x.key === key);
      return s?.values.at(-1) as number;
    };
    const near = (got: number, exp: number, halfUnit: number, name: string) =>
      assert.ok(Math.abs(got - exp) <= halfUnit, `${name}: ours ${got}, terminal ${exp}`);
    near(last('vwapbands'), want.vwap, 0.005, 'VWAP');
    near(last('vwapbands', 'u1'), want.up1, 0.005, 'VWAP +1σ');
    near(last('vwapbands', 'l1'), want.lo1, 0.005, 'VWAP −1σ');
    near(last('vwma'), want.vwma20, 0.005, 'VWMA(20)');
    near(last('mfi'), want.mfi14, 0.005, 'MFI(14)');
    near(last('cmf'), want.cmf20, 0.005, 'CMF(20)');
    near(last('rvol'), want.rvol20, 0.00005, 'RVOL(20)');
    // printed as "-467.3K" / "2.25M"
    near(last('obv'), want.obv, tf === 'tf1' ? 50 : 5000, 'OBV');
  });
}
