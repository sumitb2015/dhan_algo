import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenko, brickClose, renkoSignals, renkoSma } from './renko.ts';
import { buildConfirmedModel, withLive } from './straddlePnfModel.ts';
import { boxPriceAt, decideAuto } from './pnfAuto.ts';
import type { Bar } from './straddlePnf.ts';

const BASE_T = Date.UTC(2026, 9, 27, 4, 0) / 1000; // 2026-10-27 09:30 IST (a Tuesday)
const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: BASE_T + i * 60, ce: c, pe: 0, straddle: c, vol: 0 }));
const edges = (closes: number[], box = 10) => buildRenko(bars(closes), box).columns.map(c => `${c.dir}${c.low}-${c.high}`);

test('bricks sit on multiples of the box, starting from the first close rounded to the grid', () => {
  assert.deepEqual(edges([22651, 22662, 22671]), ['X22650-22660', 'X22660-22670']);
  assert.deepEqual(edges([22656, 22669, 22670]), ['X22660-22670']);  // 22656 rounds to 22660; 22670 completes the brick
});

test('a one-box pullback prints nothing; a two-box move reverses', () => {
  assert.deepEqual(edges([22650, 22660, 22670, 22660, 22655]), ['X22650-22660', 'X22660-22670']);
  assert.deepEqual(edges([22650, 22660, 22670, 22650]), ['X22650-22660', 'X22660-22670', 'O22650-22660']);
});

test('one bar can print several bricks, all stamped with that bar', () => {
  const { columns } = buildRenko(bars([22650, 22695]), 10);
  assert.deepEqual(columns.map(c => c.low), [22650, 22660, 22670, 22680]);
  assert.ok(columns.every(c => c.startBar === 1 && c.endBar === 1 && c.boxes === 1));
});

test('a close exactly on the next edge prints the brick (no float drift)', () => {
  assert.deepEqual(edges([0.3, 0.4, 0.5], 0.1).length, 2);
});

test('N-brick confirmation: no signal on the first run, one on the Nth brick after a reversal', () => {
  // up 3, down 3, up 3
  const closes = [22650, 22660, 22670, 22680, 22660, 22650, 22640, 22660, 22670, 22680];
  const b = bars(closes);
  const { columns } = buildRenko(b, 10);
  const none = new Array(b.length).fill(null);
  const n1 = renkoSignals(columns, b, none, 1).map(s => `${s.kind}@${s.col}`);
  assert.deepEqual(n1, ['RENKO_SELL@3', 'RENKO_BUY@6']);
  const n2 = renkoSignals(columns, b, none, 2).map(s => `${s.kind}@${s.col}`);
  assert.deepEqual(n2, ['RENKO_SELL@4', 'RENKO_BUY@7']);
  assert.deepEqual(renkoSignals(columns, b, none, 4), []);
  const sell = renkoSignals(columns, b, none, 2)[0];
  assert.equal(sell.price, brickClose(columns[4]));
  assert.equal(sell.price, 22650);   // down bricks 22660-70, then 22650-60: the second one confirms
});

test('the SMA averages brick closes', () => {
  const { columns } = buildRenko(bars([22650, 22680]), 10);   // closes 22660, 22670, 22680
  assert.deepEqual(renkoSma(columns, 2), [null, 22665, 22675]);
});

test('the model builds bricks in points and draws a forming bar\'s bricks as unconfirmed', () => {
  const closed = bars([22650, 22660, 22670]);
  const c = buildConfirmedModel(closed, 'sma', { chart: 'renko', boxMode: 'pts', boxPts: 10, reversal: 2, volume: false });
  assert.equal(c.chart, 'renko');
  assert.equal(c.box, 10);
  assert.equal(c.columns.length, 2);
  assert.deepEqual(c.exits, []);
  const forming: Bar = { t: BASE_T + 3 * 60, ce: 22691, pe: 0, straddle: 22691, vol: 0 };
  const m = withLive(c, forming);
  assert.equal(m.columns.length, 2);
  assert.equal(m.liveColumns.length, 4);
});

test('AUTO books a Renko signal at the brick close and exits on the first opposite brick', () => {
  const closes = [22650, 22660, 22670, 22650, 22640, 22630, 22650];
  const c = buildConfirmedModel(bars(closes), 'sma', { chart: 'renko', boxMode: 'pts', boxPts: 10, reversal: 2, volume: false });
  const sig = c.signals[c.signals.length - 1];
  assert.equal(sig.kind, 'RENKO_SELL');
  assert.equal(boxPriceAt(c, sig.col, sig.bar), 22640);
  const pos = { side: 'SELL' as const, entryBarT: sig.t };
  const d = decideAuto({ model: c, position: pos, watermarkT: 0, nowS: BASE_T + 7 * 60, market: 'NSE' });
  assert.equal(d.action, 'exit');
});

// Parity with TradingView's "NIFTY · 1 · NSE · Renko [Traditional, 10]" (the reference chart for this page): the brick sequence
// decoded from its screenshot vs the bricks built here from Dhan's 1-minute closes of the same week. Two minutes close on the
// other side of a brick edge in Dhan's feed than in TradingView's (26 Oct 09:16: 22,509.65 vs >= 22,510; 28 Oct 09:30:
// 22,549.75 vs > 22,550 — Dhan's next minute opens at 22,510.50 / 22,550.30); with those two on TradingView's side, every
// brick matches. A change to the brick rules that breaks this is a change away from TradingView.
test('matches TradingView Renko [Traditional, 10] on NIFTY 1-min, brick for brick', async () => {
  const fs = await import('node:fs');
  const f = JSON.parse(fs.readFileSync(new URL('./renko.tradingview.json', import.meta.url), 'utf8')) as { closes: [number, number][]; tradingview: string[] };
  const ist = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(5, 16).replace('T', ' ');
  const feedDiff: Record<string, number> = { '10-26 09:16': 22510.5, '10-28 09:30': 22550.3 };
  const seq = (patch: boolean) => buildRenko(f.closes.map(([t, c]) => {
    const p = patch ? feedDiff[ist(t)] ?? c : c;
    return { t, ce: p, pe: 0, straddle: p, vol: 0 };
  }), 10).columns.map(c => `${c.dir === 'X' ? 'U' : 'D'}${c.low}`).join(' ');
  const tv = f.tradingview.slice(3).join(' ');           // the first 3 are clipped by the screenshot's left edge
  assert.ok(seq(true).endsWith(tv), 'every TradingView brick, in order, ending on the same brick');
  // On Dhan's own closes the only differences are the two one-brick blips those two minutes cause
  const ours = seq(false);
  assert.ok(ours.endsWith(f.tradingview.slice(f.tradingview.indexOf('D22560', 300)).join(' ')), 'the tail after 28 Oct 09:38 is identical');
  assert.ok(!ours.includes(tv));
});

test('a % box: the brick is that % of the first 1-minute price and the bricks sit on its multiples', () => {
  const closed = bars([20000, 20000, 20025, 20040, 20065]);
  const c = buildConfirmedModel(closed, 'sma', { chart: 'renko', boxMode: 'pct', boxPct: 0.1, boxPts: 10, reversal: 2, volume: false });
  assert.equal(c.boxMode, 'pct');
  assert.ok(Math.abs(c.box - 20) < 1e-9);                                // 0.1 % of 20,000, not the 10 points also stored
  assert.deepEqual(c.columns.map(col => `${col.dir}${col.low}-${col.high}`), ['X20000-20020', 'X20020-20040', 'X20040-20060']);
  const pts = buildConfirmedModel(closed, 'sma', { chart: 'renko', boxMode: 'pts', boxPct: 0.1, boxPts: 10, reversal: 2, volume: false });
  assert.equal(pts.box, 10);
});
