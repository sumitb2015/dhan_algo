// Log % Renko (Definedge "Log" brick): bricks on the fixed grid (1 + P/100)^k. The Traditional (points / %) engine has its own tests
// in renko.test.ts, which must keep passing unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLogRenko, continueRenko, gridMove, gridSteps, logIndex, logLevel, logRowEdges, renkoPivots, twoBackSignals, oneBackSignals, type RenkoResume } from './renko.ts';
import { buildConfirmedModel, withLive } from './straddlePnfModel.ts';
import type { Bar } from './straddlePnf.ts';

const BASE_T = Date.UTC(2026, 9, 27, 4, 0) / 1000;
const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: BASE_T + i * 60, ce: c, pe: 0, straddle: c, vol: 0 }));
const round2 = (x: number) => Math.round(x * 100) / 100;

// The screenshot lists 27,055.71 for brick 4: it compounds the rounded 26,787.83 (x 1.01 = 27,055.708). The grid compounds exact
// prices: 26,000 x 1.01^4 = 27,055.7026.
test('the screenshot table: 1 % bricks up from 26,000 close at 26,260 / 26,522.60 / 26,787.83 / 27,055.70', () => {
  const { columns } = buildLogRenko(bars([26000, 27100]), 1, 26000);
  assert.deepEqual(columns.map(c => round2(c.high)), [26260, 26522.6, 26787.83, 27055.7]);
  assert.ok(columns.every(c => c.dir === 'X' && c.startBar === 1 && c.boxes === 1));
  assert.equal(columns[0].low, 26000);
  for (let i = 1; i < columns.length; i++) assert.equal(columns[i].low, columns[i - 1].high);   // bricks join exactly
});

test('a down brick closes at C / (1 + P) and a reversal needs two log steps', () => {
  // up one brick (26,000 -> 26,260), then a one-step pullback prints nothing, two steps print a down brick
  const up = 26000 * 1.01;
  assert.equal(buildLogRenko(bars([26000, up + 1, 26000 / 1.01 + 5]), 1, 26000).columns.length, 1);
  const { columns } = buildLogRenko(bars([26000, up + 1, 26000 / 1.01 - 1]), 1, 26000);
  assert.deepEqual(columns.map(c => c.dir), ['X', 'O']);
  assert.equal(columns[1].high, 26000);
  assert.equal(round2(columns[1].low), round2(26000 / 1.01));                    // 25,742.57, not 26,000 x 0.99
});

test('a close exactly on a level prints the brick (no float drift in the log)', () => {
  const lv = (k: number) => logLevel({ base: 1, r: 1.001 }, k);
  const k0 = Math.round(Math.log(22650) / Math.log(1.001));
  const { columns } = buildLogRenko(bars([lv(k0), lv(k0 + 1), lv(k0 + 2)]), 0.1);
  assert.equal(columns.length, 2);
});

test('no repaint: the grid is fixed, so builds from different history starts put bricks on identical prices', () => {
  const a = buildLogRenko(bars([100, 104, 108, 112]), 1).columns;
  const b = buildLogRenko(bars([105, 108, 112]), 1).columns;
  assert.equal(a[a.length - 1].high, b[b.length - 1].high);
  assert.equal(a[a.length - 1].low, b[b.length - 1].low);
  const levels = new Set(a.flatMap(c => [c.low, c.high]));
  assert.ok(b.every(c => levels.has(c.low) && levels.has(c.high)));
});

test('continueRenko over split bars builds exactly what one buildLogRenko does', () => {
  const closes = [22650, 22700, 22800, 22600, 22500, 22900, 23100, 22950, 22700];
  const whole = buildLogRenko(bars(closes), 0.2);
  for (let cut = 1; cut < closes.length; cut++) {
    const all = bars(closes);
    const head = buildLogRenko(all.slice(0, cut), 0.2);
    const next = continueRenko(head.columns, head.resume as RenkoResume, all.slice(cut));
    assert.deepEqual(next.columns, whole.columns, `cut at ${cut}`);
    assert.deepEqual(next.resume, whole.resume, `resume at ${cut}`);
  }
});

test('grid helpers: steps and moves are log steps on a log grid, box steps on a linear one', () => {
  const log = { base: 1, r: 1.01 };
  assert.ok(Math.abs(gridSteps({ box: 999, log }, 100, 100 * 1.01 ** 3) - 3) < 1e-9);
  assert.ok(Math.abs(gridMove({ box: 999, log }, 100, -2) - 100 / 1.01 ** 2) < 1e-9);
  assert.equal(gridSteps({ box: 10, log: null }, 22650, 22680), 3);
  assert.equal(gridMove({ box: 10, log: null }, 22650, -2), 22630);
});

test('pivots join a revisited log level (the same k is the same price)', () => {
  const r = 1.01, base = 1;
  const k0 = Math.round(Math.log(100) / Math.log(r));
  const lv = (k: number) => logLevel({ base, r }, k);
  // up 2, down 2, up 2 back to the same top, down 2
  const closes = [lv(k0), lv(k0 + 2), lv(k0 - 1), lv(k0 + 2), lv(k0 - 1)];
  const { columns } = buildLogRenko(bars(closes), 1);
  const highs = renkoPivots(columns, 2).filter(p => p.kind === 'H');
  assert.equal(highs.length, 1);
  assert.equal(highs[0].touches, 2);
});

test('two-back / one-back stops are one log step past the pullback', () => {
  const r = 1.01, k0 = Math.round(Math.log(100) / Math.log(r));
  const lv = (k: number) => logLevel({ base: 1, r }, k);
  // two-back: 3 up, 2 down, 3+ up past the swing
  const tb = [lv(k0), lv(k0 + 3), lv(k0), lv(k0 + 4)];
  const b = bars(tb);
  const { columns, log } = buildLogRenko(b, 1);
  const s = twoBackSignals(columns, b, new Array(b.length).fill(null), 999, 3, 0, log);
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'TWOBACK_BUY');
  assert.ok(Math.abs(s[0].stop! - lv(k0) / r) < 1e-9);                     // pullback low one log step down
  // one-back SELL: 2 down, 1 up, 2 down past the swing
  const ob = [lv(k0), lv(k0 - 2), lv(k0), lv(k0 - 3)];
  const b2 = bars(ob);
  const o = buildLogRenko(b2, 1);
  const s2 = oneBackSignals(o.columns, b2, new Array(b2.length).fill(null), 999, 0, o.log);
  assert.equal(s2.length, 1);
  assert.equal(s2[0].kind, 'ONEBACK_SELL');
  assert.ok(Math.abs(s2[0].stop! - lv(k0) * r) < 1e-9);                    // pullback high one log step up
});

test('the model: a log box builds log bricks, model.box is the brick at the latest close, the incremental build matches', () => {
  const closes = [26000, 26100, 26300, 26500, 26200, 25900, 26400];
  const opts = { chart: 'renko' as const, boxMode: 'log' as const, boxLog: 0.5, boxPct: 0.1, boxPts: 10, reversal: 2 as const, volume: false };
  const c = buildConfirmedModel(bars(closes), 'sma', opts);
  assert.equal(c.boxMode, 'log');
  assert.deepEqual(c.log, { base: 1, r: 1.005 });
  assert.deepEqual(c.columns, buildLogRenko(bars(closes), 0.5).columns);
  // the box is P % of the LTP when the newest brick printed: the 26,400 close that printed the last brick
  assert.ok(Math.abs(c.box - 26400 * 0.005) < 1e-9);
  // incremental (prev) reuse == full rebuild
  const head = buildConfirmedModel(bars(closes).slice(0, 4), 'sma', opts);
  const inc = buildConfirmedModel(bars(closes), 'sma', opts, head);
  assert.deepEqual(inc.columns, c.columns);
  // the forming bar's bricks are built on the same log grid
  const m = withLive(c, { t: BASE_T + closes.length * 60, ce: 26800, pe: 0, straddle: 26800, vol: 0 });
  assert.ok(m.liveColumns.length > c.columns.length);
  assert.deepEqual(m.liveColumns.slice(c.columns.length), buildLogRenko(bars([...closes, 26800]), 0.5).columns.slice(c.columns.length));
});

test('the model: a log box ignores boxBaseT (the grid never moves), and P&F treats log as %', () => {
  const day = 86_400;
  const old = bars([25000, 25100]);
  const today = bars([26000, 26200, 26400]).map(b => ({ ...b, t: b.t + 3 * day }));
  const opts = { chart: 'renko' as const, boxMode: 'log' as const, boxLog: 0.5, reversal: 2 as const, volume: false };
  const a = buildConfirmedModel([...old, ...today], 'sma', opts);
  const b = buildConfirmedModel([...old, ...today], 'sma', { ...opts, boxBaseT: today[2].t });
  assert.deepEqual(a.columns, b.columns);
  const pnf = buildConfirmedModel(today, 'sma', { chart: 'pnf', boxMode: 'log', boxLog: 0.5, boxPct: 0.5, reversal: 3, volume: false });
  assert.equal(pnf.boxMode, 'pct');
  assert.equal(pnf.log, null);
});

// ── AUTO on a Log % chart: the trail and the pyramid count log steps. `box` is set absurdly (999) so any `/ box` left would show.
import { decideAuto, decideAdd, trailLevel, trailOf, type AutoModel } from './pnfAuto.ts';
import type { PnfColumn } from './straddlePnf.ts';

const ist = (hh: number, mm: number) => Date.UTC(2026, 9, 30, hh, mm) / 1000 - 5.5 * 3600;   // Fri 2026-10-30
const LG = { base: 1, r: 1.01 };
const K0 = Math.round(Math.log(100) / Math.log(LG.r));
const lv = (k: number) => logLevel(LG, k);
/** Bricks [bar time, dir, close level k] after a first down brick closing at K0 (10:00). */
function logAutoModel(bricks: [number, 'X' | 'O', number][], lastBarT: number): AutoModel {
  const mk = (dir: 'X' | 'O', k: number): PnfColumn => ({ dir, low: dir === 'O' ? lv(k) : lv(k - 1), high: dir === 'O' ? lv(k + 1) : lv(k), boxes: 1, startBar: 0, endBar: 0, session: '2026-10-30', breakBar: null, boxBars: [0] });
  const cols = [mk('O', K0)];
  const times = [{ start: ist(10, 0), end: ist(10, 0) }];
  for (const [t, dir, k] of bricks) { cols.push(mk(dir, k)); times.push({ start: t, end: t }); }
  return { chart: 'renko', box: 999, log: LG, columns: cols, columnTimes: times, signals: [], lastBarT };
}

test('AUTO trail on a Log % chart: N log steps back from the best brick close exits; the level is best x r^N', () => {
  const base: [number, 'X' | 'O', number][] = [[ist(10, 1), 'O', K0 - 1], [ist(10, 2), 'O', K0 - 2], [ist(10, 3), 'O', K0 - 3]];
  const pos = { side: 'SELL' as const, entryBarT: ist(10, 0), exitBy: 'supertrend' as const, trail: trailOf({ entryPrice: lv(K0), entryBox: lv(K0), trailBoxes: 2, adds: [{ barT: ist(10, 2) }] }) };
  const dec = (bricks: [number, 'X' | 'O', number][]) => decideAuto({ model: logAutoModel(bricks, bricks[bricks.length - 1][0]), position: pos, watermarkT: 0, nowS: ist(10, 9), market: 'NSE' });
  assert.equal(dec([...base, [ist(10, 4), 'X', K0 - 2]]).action, 'none');                     // one step back holds
  const d = dec([...base, [ist(10, 4), 'X', K0 - 2], [ist(10, 5), 'X', K0 - 1]]);           // two steps back exits
  assert.equal(d.action, 'exit');
  assert.equal(d.action === 'exit' && d.reason, 'trail');
  const level = trailLevel(logAutoModel(base, ist(10, 3)), pos)!;
  assert.ok(Math.abs(level - lv(K0 - 3) * LG.r ** 2) < 1e-9);
});

test('AUTO pyramid every N on a Log % chart waits N log steps past the entry brick', () => {
  const row = { side: 'SELL' as const, entryBarT: ist(10, 0), entryPrice: lv(K0), entryBox: lv(K0), lots: 2, pyramidEvery: 2 };
  const one = logAutoModel([[ist(10, 5), 'O', K0 - 1]], ist(10, 5));
  assert.equal(decideAdd({ model: one, row, nowS: ist(10, 6), market: 'NSE', maxLots: 10 }).add, false);
  const two = logAutoModel([[ist(10, 5), 'O', K0 - 1], [ist(10, 6), 'O', K0 - 2]], ist(10, 6));
  assert.deepEqual(decideAdd({ model: two, row, nowS: ist(10, 7), market: 'NSE', maxLots: 10 }), { add: true, barT: ist(10, 6), box: lv(K0 - 2) });
});

test('logIndex inverts logLevel', () => {
  const g = { base: 1, r: 1.001 };
  for (const k of [-5, 0, 7, 10_234]) assert.ok(Math.abs(logIndex(g, logLevel(g, k)) - k) < 1e-6);
});

test('order-ladder rows on a Log % chart tile the axis: each row ends exactly where the next starts, and holds its level', () => {
  const g = { base: 1, r: 1.0005 };
  for (let k = 20_000; k < 20_050; k++) {
    const [lo, hi] = logRowEdges(g, k);
    assert.equal(hi, logRowEdges(g, k + 1)[0]);
    assert.ok(lo < logLevel(g, k) && logLevel(g, k) < hi);
  }
});

test('Log % box = P % of the LTP when the newest brick printed: it changes on each new brick, not on bars that print none', () => {
  const closes = [26000, 26100, 26300, 26500, 26200, 25900, 26400];
  const b = bars(closes);
  const opts = { chart: 'renko' as const, boxMode: 'log' as const, boxLog: 0.5, reversal: 2 as const, volume: false, boxBaseT: b[4].t };
  const c = buildConfirmedModel(b, 'sma', opts);
  assert.ok(Math.abs(c.box - 26400 * 0.005) < 1e-9);
  assert.equal(c.boxBase, 26400);
  assert.equal(c.boxBaseT, b[6].t);
  // a bar that prints no brick leaves it alone
  const quiet = bars([...closes, 26420]);
  assert.equal(buildConfirmedModel(quiet, 'sma', opts, c).box, c.box);
  // a new brick moves it, incrementally or rebuilt, and the bricks are untouched by it
  const more = bars([...closes, 26420, 27000]);
  const inc = buildConfirmedModel(more, 'sma', opts, c);
  assert.ok(Math.abs(inc.box - 27000 * 0.005) < 1e-9);
  assert.equal(buildConfirmedModel(more, 'sma', opts).box, inc.box);
  assert.deepEqual(inc.columns, buildLogRenko(more, 0.5).columns);
});
