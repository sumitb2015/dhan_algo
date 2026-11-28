import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { awesomeOscillator, bbPercentB, bbWidth, bbZones, fourColor, macdPine } from './tvIndicators.ts';
import { BB_BAR_COLORS, bollinger, catalogEntry, computeIndicator, newIndicator, type Bar } from './indexScalperIndicators.ts';

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
