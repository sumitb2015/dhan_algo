import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { awesomeOscillator, bbPercentB, bbWidth, bbZones, fourColor, macdPine, williamsFractal } from './tvIndicators.ts';
import { BB_BAR_COLORS, bollinger, catalogEntry, computeIndicator, flipsAtLast, indicatorLabel, newIndicator, pointColor, type Bar } from './indexScalperIndicators.ts';

// Parity with the tradingcharts.co terminal (tvIndicators.parity.json `_source`): its legend values on BHARTIARTL 1-minute
// bars of 27 Nov 2026, against our functions on the same Dhan bars from where its loaded history started.
const vol = JSON.parse(readFileSync(new URL('./volumeIndicators.parity.json', import.meta.url), 'utf8')) as { tf1: { bars: [number, number, number, number, number, number][] } };
const fx = JSON.parse(readFileSync(new URL('./tvIndicators.parity.json', import.meta.url), 'utf8')) as { rows: Record<string, number>[] };
const bars: Bar[] = vol.tf1.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const closes = bars.map(b => b.c);

/** The bar index of each terminal row: matched by OHLC, in order, from the end of the history (the rows are its last bars). */
function align(): number[] {
  const out: number[] = [];
  let i = bars.length - 1;
  for (let k = fx.rows.length - 1; k >= 0; k--) {
    const r = fx.rows[k];
    while (i >= 0 && !(bars[i].o === r.o && bars[i].h === r.h && bars[i].l === r.l && bars[i].c === r.c)) i--;
    assert.ok(i >= 0, `terminal row ${r.sample} not found in the bars`);
    out.unshift(i--);
  }
  return out;
}

test('matches the tradingcharts.co terminal exactly at its 4-decimal precision (AO, MACD, %B, BBW, BB, Bollinger Bars)', () => {
  const idx = align();
  const bb = bollinger(closes, 20, 2);
  const ao = awesomeOscillator(bars), m = macdPine(closes), pb = bbPercentB(closes), bw = bbWidth(closes), z = bbZones(closes);
  const r4 = (x: number | null) => (x === null ? NaN : Number(x.toFixed(4)));
  idx.forEach((i, k) => {
    const t = fx.rows[k];
    const got: Record<string, number> = {
      zone: z[i] as number, bbUpper: r4(bb.up[i]), bbBasis: r4(bb.mid[i]), bbLower: r4(bb.lo[i]), ao: r4(ao[i]),
      macdHist: r4(m.hist[i]), macd: r4(m.macd[i]), macdSignal: r4(m.signal[i]), pctB: r4(pb[i]), bbw: r4(bw[i]),
    };
    for (const key of Object.keys(got)) assert.equal(got[key], t[key], `sample ${t.sample} ${key}: ours ${got[key]}, terminal ${t[key]}`);
  });
});

test('BBW is the SAMPLE-stdev width (the population one misses the terminal on wide bars)', () => {
  const idx = align();
  const k = fx.rows.findIndex(r => r.sample === 0);   // terminal 0.0056; the population stdev gives 0.0054
  const bb = bollinger(closes, 20, 2), i = idx[k];
  const population = ((bb.up[i] as number) - (bb.lo[i] as number)) / (bb.mid[i] as number);
  assert.equal(Number(population.toFixed(4)), 0.0054);
  assert.equal(Number((bbWidth(closes)[i] as number).toFixed(4)), fx.rows[k].bbw);
});

test('Pine MACD seeding: signal starts slow + signal − 2 bars in, histogram = MACD − signal', () => {
  const m = macdPine(closes.slice(0, 60));
  assert.equal(m.macd.findIndex(x => x !== null), 25);
  assert.equal(m.signal.findIndex(x => x !== null), 33);
  for (let i = 33; i < 60; i++) assert.ok(Math.abs((m.hist[i] as number) - ((m.macd[i] as number) - (m.signal[i] as number))) < 1e-12);
});

test('Bollinger Bars zones and candle colours; histogram colour rules', () => {
  const flat: Bar[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 60, o: 100, h: 101, l: 99, c: i % 2 ? 101 : 99 }));
  const zoneOf = (lastClose: number) => bbZones([...flat.slice(0, 19).map(b => b.c), lastClose]).at(-1);
  assert.equal(zoneOf(105), 2);   // far above the upper band
  assert.equal(zoneOf(100.5), 1);
  assert.equal(zoneOf(99.5), -1);
  assert.equal(zoneOf(95), -2);
  const out = computeIndicator([...flat.slice(0, 19), { ...flat[19], c: 105 }], newIndicator('bbbars', 'z'));
  assert.deepEqual(out.series, []);
  assert.equal(out.barColors?.at(-1), BB_BAR_COLORS[2]);
  // MACD / RVOL: growing above, falling above, growing below, falling below the reference
  assert.deepEqual(fourColor([1, 2, 1, -1, -0.5, null], 0, ['GA', 'FA', 'GB', 'FB']), ['FA', 'GA', 'FA', 'FB', 'GB', null]);
});

test('catalog defaults and colours follow the terminal', () => {
  const colours: Record<string, string> = {
    vwapbands: '#2196f3', vwma: '#2196f3', obv: '#2196f3', mfi: '#7e57c2', cmf: '#43a047', macd: '#2196f3', bbands: '#2196f3',
    bbpctb: '#22ab94', bbw: '#ff6d00', ao: '#089981',
  };
  for (const [k, c] of Object.entries(colours)) assert.equal(catalogEntry(k as never).color, c, k);
  // VWAP shows only band 1 by default, as the terminal
  const vb = computeIndicator(bars, newIndicator('vwapbands', 'v')).series.map(s => [s.axisLabel, s.color]);
  assert.deepEqual(vb, [['VWAP', '#2196f3'], ['+1σ', '#4caf50'], ['−1σ', '#4caf50']]);
  // BB: upper orange, basis and lower in the indicator colour
  assert.deepEqual(computeIndicator(bars, newIndicator('bbands', 'b')).series.map(s => s.color), ['#ff6d00', '#2196f3', '#2196f3']);
  // guides: MACD / AO zero, %B 0 / 1, RVOL 1
  assert.deepEqual(computeIndicator(bars, newIndicator('macd', 'm')).series[0].guides, [0]);
  assert.deepEqual(computeIndicator(bars, newIndicator('ao', 'a')).series[0].guides, [0]);
  assert.deepEqual(computeIndicator(bars, newIndicator('bbpctb', 'p')).series[0].guides, [0, 1]);
  assert.deepEqual(computeIndicator(bars, newIndicator('rvol', 'r')).series[0].guides, [1]);
});

// 6 EMA ribbon + Donchian Channels against the same terminal (tvIndicators.ribbon.parity.json `_source`).
const rib = JSON.parse(readFileSync(new URL('./tvIndicators.ribbon.parity.json', import.meta.url), 'utf8')) as {
  rows: { sample: number; o: number; h: number; l: number; c: number; ema: number[]; slope: string; dcUpper: number; dcBasis: number; dcLower: number }[];
};

test('6 EMA colored ribbon and Donchian Channels match the terminal exactly (values and rising / falling colours)', () => {
  const out = computeIndicator(bars, newIndicator('ema6', 'e'));
  const dc = computeIndicator(bars, newIndicator('donchian', 'd'));
  assert.deepEqual(out.series.map(s => s.axisLabel), ['EMA 8', 'EMA 13', 'EMA 21', 'EMA 34', 'EMA 55', 'EMA 89']);
  let i = bars.length - 1;
  for (let k = rib.rows.length - 1; k >= 0; k--) {
    const r = rib.rows[k];
    while (i >= 0 && !(bars[i].o === r.o && bars[i].h === r.h && bars[i].l === r.l && bars[i].c === r.c)) i--;
    assert.ok(i >= 0, `row ${r.sample} not found`);
    out.series.forEach((s, n) => {
      assert.equal(Number((s.values[i] as number).toFixed(4)), r.ema[n], `sample ${r.sample} ${s.axisLabel}`);
      const want = r.slope[n] === 'r' ? '#26a69a' : r.slope[n] === 'f' ? '#ef5350' : s.color;
      assert.equal(s.colors?.[i], want, `sample ${r.sample} ${s.axisLabel} colour`);
    });
    assert.deepEqual(dc.series.map(s => Number((s.values[i] as number).toFixed(4))), [r.dcUpper, r.dcBasis, r.dcLower], `sample ${r.sample} Donchian`);
    i--;
  }
});

test('6 EMA ribbon is seeded with the first close and MFI starts at bar 14, as the terminal (BHARTIARTL 15 m)', async () => {
  // Read 2026-11-28 by running the terminal's own indicator worker on these same 288 bars (volumeIndicators.parity.json
  // tf15): every EMA has a value from bar 0, and its last values are these. Pine's SMA seed gave EMA 89 2102.4476.
  const v15 = JSON.parse(readFileSync(new URL('./volumeIndicators.parity.json', import.meta.url), 'utf8')) as { tf15: { bars: number[][] } };
  const b15: Bar[] = v15.tf15.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const s = computeIndicator(b15, newIndicator('ema6', 'e')).series;
  const last = Object.fromEntries(s.map(x => [x.axisLabel, Number((x.values.at(-1) as number).toFixed(4))]));
  assert.deepEqual([last['EMA 8'], last['EMA 21'], last['EMA 55'], last['EMA 89']], [2063.1436, 2071.2041, 2090.939, 2102.5539]);
  for (const x of s) assert.equal(x.values[0], b15[0].c);
  const { mfi } = await import('./volumeIndicators.ts');
  assert.equal(mfi(b15, 14).findIndex(x => x !== null), 14);
});

test('the ribbon stays continuous: no transparent gap where an EMA changes colour, and no forced redraw', () => {
  const s = computeIndicator(bars, newIndicator('ema6', 'e')).series[0];
  const change = s.colors!.findIndex((c, i) => i > 0 && c && s.colors![i - 1] && c !== s.colors![i - 1]);
  assert.ok(change > 0);
  assert.notEqual(pointColor(s, change - 1), 'transparent');
  assert.equal(flipsAtLast({ ...s, colors: [...s.colors!.slice(0, -1), s.colors!.at(-2) === '#26a69a' ? '#ef5350' : '#26a69a'] }), false);
  // a length of 0 hides that EMA
  assert.equal(computeIndicator(bars, { ...newIndicator('ema6', 'e'), params: { l1: 8, l2: 0, l3: 21, l4: 0, l5: 0, l6: 0 } }).series.length, 2);
});

test('Williams Fractal matches tradingcharts.co terminal formula exactly (values, marker shapes, and colours)', () => {
  // 1. Synthetic pattern tests: peaks, valleys, strict-inequality ties, edge bounds
  const testBars = [
    { t: 0, o: 10, h: 11, l: 9, c: 10 },
    { t: 1, o: 10, h: 13, l: 8, c: 12 },
    { t: 2, o: 12, h: 16, l: 11, c: 15 }, // peak high 16 > 11, 13, 14, 12 -> Up Fractal
    { t: 3, o: 15, h: 14, l: 10, c: 12 },
    { t: 4, o: 12, h: 12, l: 7, c: 8 },
    { t: 5, o: 8, h: 10, l: 5, c: 6 },   // valley low 5 < 11, 10, 7, 6, 8 -> Down Fractal
    { t: 6, o: 6, h: 9, l: 6, c: 8 },
    { t: 7, o: 8, h: 11, l: 7, c: 10 },
    { t: 8, o: 10, h: 15, l: 9, c: 14 },
    { t: 9, o: 14, h: 15, l: 9, c: 14 }, // tie high 15 == 15 -> neither is fractal (strict >)
    { t: 10, o: 14, h: 12, l: 9, c: 10 },
  ];
  const syn = williamsFractal(testBars, 2);
  assert.equal(syn.up[2], 1);
  assert.equal(syn.down[2], null);
  assert.equal(syn.up[5], null);
  assert.equal(syn.down[5], -1);
  assert.equal(syn.up[8], null); // tie invalidated
  assert.equal(syn.up[9], null);
  // first 2 and last 2 bars must be null (unconfirmed / incomplete window)
  assert.equal(syn.up[0], null);
  assert.equal(syn.up[1], null);
  assert.equal(syn.up[9], null);
  assert.equal(syn.up[10], null);

  // 2. Exact match against the tradingcharts.co chunk-D-tlSZQY.js compute loop across all Dhan bars
  const tcExpectedUp: (number | null)[] = new Array(bars.length).fill(null);
  const tcExpectedDown: (number | null)[] = new Array(bars.length).fill(null);
  const t = 2, r = bars.length;
  for (let n = t; n < r - t; n++) {
    let i = true, d = true;
    for (let m = 1; m <= t; m++) {
      if (bars[n].h <= bars[n - m].h || bars[n].h <= bars[n + m].h) i = false;
      if (bars[n].l >= bars[n - m].l || bars[n].l >= bars[n + m].l) d = false;
    }
    if (i) tcExpectedUp[n] = 1;
    if (d) tcExpectedDown[n] = -1;
  }

  const real = williamsFractal(bars, 2);
  assert.deepEqual(real.up, tcExpectedUp);
  assert.deepEqual(real.down, tcExpectedDown);

  // 3. Catalog entry, label, series, and markers verification
  const cat = catalogEntry('fractals');
  assert.equal(cat.label, 'Williams Fractal');
  assert.equal(cat.pane, 'price');
  assert.equal(cat.color, '#089981');
  assert.equal(cat.fixedStyle, true);
  assert.deepEqual(cat.params, [{ key: 'period', label: 'Periods', def: 2, min: 2, max: 100 }]);

  const ind = newIndicator('fractals', 'f');
  assert.equal(indicatorLabel(ind), 'Fractal (2)');

  const out = computeIndicator(bars, ind);
  assert.equal(out.pane, 'price');
  assert.equal(out.series.length, 2);
  assert.equal(out.series[0].key, 'up');
  assert.equal(out.series[0].axisLabel, 'Up Fractal');
  assert.equal(out.series[0].color, 'transparent');
  assert.equal(out.series[1].key, 'down');
  assert.equal(out.series[1].axisLabel, 'Down Fractal');
  assert.equal(out.series[1].color, 'transparent');

  // Verify markers attach to the exact fractal bars and values carry price coordinates
  const upMarkers = out.series[0].markers!;
  const downMarkers = out.series[1].markers!;
  assert.ok(upMarkers.length > 0);
  assert.ok(downMarkers.length > 0);
  for (const m of upMarkers) {
    assert.equal(real.up[m.i], 1);
    assert.equal(m.shape, 'arrowUp');
    assert.equal(m.position, 'aboveBar');
    assert.equal(m.color, '#089981');
    assert.equal(m.price, bars[m.i].h);
    assert.equal(out.series[0].values[m.i], bars[m.i].h);
  }
  for (const m of downMarkers) {
    assert.equal(real.down[m.i], -1);
    assert.equal(m.shape, 'arrowDown');
    assert.equal(m.position, 'belowBar');
    assert.equal(m.color, '#F23645');
    assert.equal(m.price, bars[m.i].l);
    assert.equal(out.series[1].values[m.i], bars[m.i].l);
  }
});

