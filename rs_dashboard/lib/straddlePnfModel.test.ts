import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelModel, boxSmaByBar, unconfirmedBoxes, MAX_UNCONFIRMED_BOXES } from './straddlePnfModel.ts';
import { vwap, type Bar } from './straddlePnf.ts';
import { resample } from './straddlePnfInterval.ts';

const BASE_T = Date.UTC(2026, 9, 23, 3, 45) / 1000;
const A = 100;
const BOX = A * 0.005;
const priceAt = (l: number) => A + l * BOX; // exactly on a box label
const bars = (levels: number[]): Bar[] => levels.map((l, i) => ({ t: BASE_T + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 1 }));
const PATH = [0, 5, 2, 0, 3, 7, 4, -1]; // X, O, X, O with one double top buy and one double bottom sell

test('model carries columns, signals, exit tags and a per-column overlay', () => {
  const b = bars(PATH);
  const m = buildPanelModel(b, 'vwap');
  assert.equal(m.columns.length, 4);
  assert.deepEqual(m.signals.map(s => s.kind), ['DOUBLE_TOP_BUY', 'DOUBLE_BOTTOM_SELL']);
  assert.ok(m.exits.length > 0);
  const v = vwap(b);
  assert.deepEqual(m.overlay, m.columns.map(c => v[c.endBar]));
});

test('the SMA averages P&F boxes, not bar closes: null until the period has enough boxes, and vwap still drives the signals', () => {
  // PATH draws X 1-5 (5 boxes), O 4-0 (5), X 1-7 (7), O 6..-1 (8): 25 boxes in all
  const m = buildPanelModel(bars(PATH), 'sma', { smaPeriod: 11 });
  assert.deepEqual(m.overlay.map(v => v !== null), [false, false, true, true]);   // 5, 10, 17, 25 boxes so far
  assert.equal(m.signals.length, 2);
  assert.deepEqual(buildPanelModel(bars(PATH), 'sma', { smaPeriod: 26 }).overlay, [null, null, null, null]);
});

test('box SMA: box values in drawing order (X bottom-up, O top-down), read at each column\'s last box', () => {
  const m = buildPanelModel(bars(PATH), 'sma', { smaPeriod: 3 });
  // column 1 (X 1-5) ends on boxes 3, 4, 5; column 2 (O 4-0) ends on 2, 1, 0; column 4 (O 6..-1) ends on 1, 0, -1
  assert.ok(Math.abs((m.overlay[0] as number) - priceAt(4)) < 1e-9);
  assert.ok(Math.abs((m.overlay[1] as number) - priceAt(1)) < 1e-9);
  assert.ok(Math.abs((m.overlay[3] as number) - priceAt(0)) < 1e-9);
  assert.equal(m.overlayNow, m.overlay[3]);
});

test('box SMA ignores time: the same boxes reached by more bars give the same line', () => {
  const slow = bars([0, 1, 2, 3, 4, 5, 5, 5, 4, 3, 2]);   // extra and flat bars, same boxes as the fast path
  const fast = bars([0, 5, 2]);
  assert.deepEqual(buildPanelModel(slow, 'sma', { smaPeriod: 4 }).overlay, buildPanelModel(fast, 'sma', { smaPeriod: 4 }).overlay);
});

test('the SMA period defaults to 50 and follows the option; the model reports it for the label', () => {
  const d = buildPanelModel(bars(PATH), 'sma');
  assert.equal(d.smaPeriod, 50);
  assert.equal(d.overlayNow, null);                            // 25 boxes < 50
  assert.equal(buildPanelModel(bars(PATH), 'sma', { smaPeriod: 3 }).smaPeriod, 3);
});

test('the model reports the time of its last closed bar for the alert watermark', () => {
  const b = bars(PATH);
  assert.equal(buildPanelModel(b, 'vwap').lastBarT, b[b.length - 1].t);
  assert.equal(buildPanelModel([], 'vwap').lastBarT, null);
});

test('no bars gives an empty model, not a throw', () => {
  const m = buildPanelModel([], 'vwap');
  assert.deepEqual([m.columns, m.signals, m.exits, m.overlay], [[], [], [], []]);
  assert.equal(m.box, 0);
});

test('sessionOpen is the first close of the most recent session in the bars', () => {
  const DAY = 86_400;
  const d1 = [0, 5].map((l, i) => ({ t: BASE_T + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 10 }));
  const d2 = [3, 4, 6].map((l, i) => ({ t: BASE_T + DAY + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 10 }));
  assert.equal(buildPanelModel([...d1, ...d2], 'vwap').sessionOpen, priceAt(3));
  assert.equal(buildPanelModel(d1, 'vwap').sessionOpen, priceAt(0));
  assert.equal(buildPanelModel([], 'vwap').sessionOpen, null);
});

test('sessionOpen skips a zero-price first bar', () => {
  const zero = { t: BASE_T, ce: 0, pe: 0, straddle: 0, vol: 0 };
  const b = [zero, ...bars([2, 3]).map(x => ({ ...x, t: x.t + 60 }))];
  assert.equal(buildPanelModel(b, 'vwap').sessionOpen, priceAt(2));
});

// ── interval and box size ──────────────────────────────────────────────────
const wander = (n: number) => bars(Array.from({ length: n }, (_, i) => Math.round(8 * Math.sin(i / 3)) + (i > 40 ? -(i - 40) / 2 : 0)));

test('an interval groups the 1-minute bars into that many minutes per chart bar', () => {
  const b = wander(20);
  const m = buildPanelModel(b, 'vwap', { interval: 5 });
  assert.equal(m.lastBarT, b[0].t + 15 * 60);               // the 4th five-minute bar starts at minute 15
  assert.equal(m.anchor, b[0].straddle);                    // the box still comes from the first price
});

test('a coarser interval never draws more columns than the 1-minute chart of the same data', () => {
  const b = wander(120);
  const one = buildPanelModel(b, 'vwap').columns.length;
  const fifteen = buildPanelModel(b, 'vwap', { interval: 15 }).columns.length;
  assert.ok(fifteen <= one, `${fifteen} <= ${one}`);
});

test('VWAP is computed on the 1-minute bars and read at each chart bar\'s last minute, so it does not change with the interval', () => {
  const b = wander(30);
  const m = buildPanelModel(b, 'vwap', { interval: 5 });
  const v1 = vwap(b);
  const { endIdx } = resample(b, 5);
  m.columns.forEach((c, i) => assert.equal(m.overlay[i], v1[endIdx[c.endBar]]));
});

test('the box size follows the percentage: 1% is twice 0.5%, from the same anchor', () => {
  const b = wander(30);
  const half = buildPanelModel(b, 'vwap', { boxPct: 0.5 });
  const one = buildPanelModel(b, 'vwap', { boxPct: 1 });
  assert.ok(Math.abs(one.box - 2 * half.box) < 1e-9);
  assert.equal(one.anchor, half.anchor);
});

test('omitting the options keeps the original 1-minute / 0.5% chart', () => {
  const b = wander(30);
  assert.deepEqual(buildPanelModel(b, 'vwap'), buildPanelModel(b, 'vwap', { interval: 1, boxPct: 0.5 }));
});

test('a history shorter than one interval gives an empty chart, not a throw', () => {
  const m = buildPanelModel(wander(3), 'vwap', { interval: 15 });
  assert.deepEqual([m.columns, m.signals, m.overlay], [[], [], []]);
  assert.equal(m.lastBarT, null);
});

test('the reversal setting sets how many boxes against the column it takes to reverse', () => {
  // X column up to level 5, then back to level 3: a 2-box reversal turns, a 3-box one does not
  const b = bars([0, 5, 3]);
  assert.equal(buildPanelModel(b, 'vwap', { reversal: 2 }).columns.length, 2);
  assert.equal(buildPanelModel(b, 'vwap', { reversal: 3 }).columns.length, 1);
  assert.equal(buildPanelModel(b, 'vwap').columns.length, 1); // default stays 3
  assert.equal(buildPanelModel(bars([0, 5, 4]), 'vwap', { reversal: 1 }).columns.length, 2);
});

test('prevClose is the last close of the session before the most recent one, null with a single session', () => {
  const DAY = 86_400;
  const d1 = [0, 5].map((l, i) => ({ t: BASE_T + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 10 }));
  const d2 = [3, 4, 6].map((l, i) => ({ t: BASE_T + DAY + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 10 }));
  assert.equal(buildPanelModel([...d1, ...d2], 'vwap').prevClose, priceAt(5));
  assert.equal(buildPanelModel(d1, 'vwap').prevClose, null);
  assert.equal(buildPanelModel([], 'vwap').prevClose, null);
});

test('a forming first bar of a new session moves "today": prevClose is yesterday\'s close, not the day before\'s', () => {
  const DAY = 86_400;
  const mk = (l: number, t: number) => ({ t, ce: priceAt(l), pe: 0, straddle: priceAt(l), vol: 10 });
  const d1 = [mk(0, BASE_T), mk(2, BASE_T + 60)];
  const d2 = [mk(3, BASE_T + DAY), mk(4, BASE_T + DAY + 60)];
  const forming = mk(6, BASE_T + 2 * DAY);
  assert.equal(buildPanelModel([...d1, ...d2], 'vwap').prevClose, priceAt(2));
  const m = buildPanelModel([...d1, ...d2], 'vwap', { forming });
  assert.equal(m.prevClose, priceAt(4));
  assert.equal(m.sessionOpen, priceAt(6));
});

test('overlayNow is the VWAP at the last closed minute, not at the last column\'s extension', () => {
  const b = bars([0, 1.2, 2.2, 2.4, 2.3, 2.2, 2.25, 2.35, 2.2, 2.3, 2.25, 2.4]).map((x, i) => ({ ...x, vol: i < 3 ? 1 : 1000 }));
  const m = buildPanelModel(b, 'vwap');
  const v = vwap(b);
  assert.equal(m.overlayNow, v[v.length - 1]);
  assert.notEqual(m.overlayNow, m.overlay[m.overlay.length - 1]);
});

test('without traded volume (an index, or no bar with volume) there is no VWAP: the box SMA is drawn whatever was asked', () => {
  const withVol = buildPanelModel(bars(PATH), 'vwap');
  assert.equal(withVol.vwapAvailable, true);
  assert.equal(withVol.overlayKind, 'vwap');
  const index = buildPanelModel(bars(PATH), 'vwap', { volume: false, smaPeriod: 3 });
  assert.equal(index.vwapAvailable, false);
  assert.equal(index.overlayKind, 'sma');
  assert.deepEqual(index.overlay, buildPanelModel(bars(PATH), 'sma', { smaPeriod: 3 }).overlay);
  const zeroVol = buildPanelModel(bars(PATH).map(x => ({ ...x, vol: 0 })), 'vwap');
  assert.equal(zeroVol.vwapAvailable, false);
  assert.equal(zeroVol.overlayKind, 'sma');
});

test('without volume the short-entry zone and the cover cue are measured against the box SMA at the break, not VWAP', () => {
  // PATH: X 1-5, O 4-0, X 1-7, O 6..-1. The double bottom breaks at the last bar, at box -1.
  const priceVolume = buildPanelModel(bars(PATH), 'vwap');
  const index3 = buildPanelModel(bars(PATH), 'vwap', { volume: false, smaPeriod: 3 });
  const sell = (m: typeof index3) => m.signals.find(g => g.kind === 'DOUBLE_BOTTOM_SELL')!;
  assert.ok(sell(index3));
  // SMA 3 of the last three boxes drawn by the breaking bar (1, 0, -1) is box 0; the break price is box -1: below it
  assert.equal(sell(index3).belowVwap, true);
  // too few boxes for the SMA at the break (25 < 26): no reference, so not "below"
  assert.equal(sell(buildPanelModel(bars(PATH), 'vwap', { volume: false, smaPeriod: 26 })).belowVwap, false);
  assert.equal(sell(priceVolume).kind, 'DOUBLE_BOTTOM_SELL');
});

test('boxSmaByBar: each bar sees only the boxes drawn by it', () => {
  const m = buildPanelModel(bars([0, 4, 6]), 'sma', { smaPeriod: 2 });   // bar 1 draws boxes 1-4, bar 2 draws 5-6
  const series = boxSmaByBar(m.columns, m.box, 2, 3);
  assert.equal(series[0], null);
  assert.ok(Math.abs((series[1] as number) - priceAt(3.5)) < 1e-9);       // boxes 3 and 4
  assert.ok(Math.abs((series[2] as number) - priceAt(5.5)) < 1e-9);       // boxes 5 and 6
});

test('boxBars records the bar that drew each box, bottom to top', () => {
  const b = bars([0, 2, 4, 1]);                  // X boxes 1-2 at bar 1, 3-4 at bar 2, then an O from 3 down to 1 at bar 3
  const m = buildPanelModel(b, 'vwap');
  assert.deepEqual(m.columns[0].boxBars, [1, 1, 2, 2]);
  assert.deepEqual(m.columns[1].boxBars, [3, 3, 3]);
});

test('sessionMarks: the first box each session drew, even inside a column opened by an earlier session', () => {
  const DAY = 86_400;
  const mk = (l: number, t: number) => ({ t, ce: priceAt(l), pe: 0, straddle: priceAt(l), vol: 10 });
  // day 1 opens an X column to box 3; day 2 only extends it to box 5; day 3 reverses down to box 2
  const b = [mk(0, BASE_T), mk(3, BASE_T + 60), mk(5, BASE_T + DAY), mk(2, BASE_T + 2 * DAY)];
  const m = buildPanelModel(b, 'vwap');
  const days = [BASE_T, BASE_T + DAY, BASE_T + 2 * DAY].map(t => new Date((t + 19800) * 1000).toISOString().slice(0, 10));
  assert.deepEqual(m.sessionMarks, [
    { col: 0, k: 0, session: days[0] },          // box 1, the lowest X
    { col: 0, k: 3, session: days[1] },          // box 4: day 2 drew boxes 4-5 in day 1's column
    { col: 1, k: 2, session: days[2] },          // the O column is drawn top-down: its top box (4) comes first
  ]);
  assert.deepEqual(m.sessions, days);
  assert.deepEqual(m.columnTimes[0], { start: b[1].t, end: b[2].t });
});

// ── unconfirmed boxes (the forming bar) ───────────────────────────────────────
test('a forming bar that extends the last column adds unconfirmed boxes on top of it; confirmed columns are unchanged', () => {
  const closed = bars([0, 4]);                                  // X 1-4
  const forming = { ...bars([0, 4, 6])[2] };                    // the open minute is at box 6
  const m = buildPanelModel(closed, 'vwap', { forming });
  assert.equal(m.columns[0].boxes, 4);
  assert.equal(m.liveColumns[0].boxes, 6);
  assert.deepEqual(unconfirmedBoxes(m.columns, m.liveColumns, m.box), [{ col: 0, ks: [4, 5] }]);   // boxes 5 and 6
  assert.equal(m.signals.length, 0);
});

test('a forming bar that reverses draws an unconfirmed column; without a forming bar there is nothing unconfirmed', () => {
  const closed = bars([0, 5]);
  const forming = { ...bars([0, 5, 1])[2] };                    // 4 boxes down: a 3-box reversal, not closed yet
  const m = buildPanelModel(closed, 'vwap', { forming });
  assert.equal(m.columns.length, 1);
  assert.equal(m.liveColumns.length, 2);
  assert.deepEqual(unconfirmedBoxes(m.columns, m.liveColumns, m.box), [{ col: 1, ks: [0, 1, 2, 3] }]);   // O 4 down to 1
  const plain = buildPanelModel(closed, 'vwap');
  assert.deepEqual(unconfirmedBoxes(plain.columns, plain.liveColumns, plain.box), []);
});

test('on a 5-minute chart the unfinished 5-minute bar is unconfirmed even with no forming 1-min bar', () => {
  const b = bars([0, 1, 1, 1, 1, 2, 2, 6]);                    // bucket 1 = minutes 0-4, bucket 2 = minutes 5-7 (unfinished)
  const m = buildPanelModel(b, 'vwap', { interval: 5 });
  assert.ok(unconfirmedBoxes(m.columns, m.liveColumns, m.box).length > 0);
});

test('a wild forming price (a bad tick) draws no unconfirmed boxes instead of thousands', () => {
  const closed = bars([0, 4]);
  const ok = buildPanelModel(closed, 'vwap', { forming: { ...bars([0, 4, 4 + MAX_UNCONFIRMED_BOXES])[2] } });
  assert.equal(unconfirmedBoxes(ok.columns, ok.liveColumns, ok.box).reduce((n, u) => n + u.ks.length, 0), MAX_UNCONFIRMED_BOXES);
  const wild = buildPanelModel(closed, 'vwap', { forming: { ...bars([0, 4, 5 + MAX_UNCONFIRMED_BOXES])[2] } });
  assert.deepEqual(unconfirmedBoxes(wild.columns, wild.liveColumns, wild.box), []);
  assert.equal(wild.liveColumns, wild.columns);
});

// ── box in points ─────────────────────────────────────────────────────────────
test('box in points: a fixed box, and the grid anchored on a whole multiple of it (round row prices)', () => {
  const b = [100.3, 102.4, 104.6, 101.2].map((p, i) => ({ t: BASE_T + i * 60, ce: p, pe: 0, straddle: p, vol: 1 }));
  const m = buildPanelModel(b, 'vwap', { boxMode: 'pts', boxPts: 1 });
  assert.equal(m.box, 1);
  assert.equal(m.anchor, 100);                                  // 100.3 rounded to the 1-point grid
  assert.equal(m.boxMode, 'pts');
  assert.equal(m.boxClamped, false);
  assert.equal(m.columns[0].high, 100 + 4.5);                   // X up to the 104 row (top edge 104.5)
});

test('a points box below 0.05% of the price is raised to that floor and reported', () => {
  const b = bars([0, 5, 2]);                                    // around 100
  const m = buildPanelModel(b, 'vwap', { boxMode: 'pts', boxPts: 0.01 });
  assert.ok(Math.abs(m.box - 0.05) < 1e-9);                     // 0.05% of 100
  assert.equal(m.boxClamped, true);
  assert.equal(buildPanelModel(b, 'vwap', { boxMode: 'pct', boxPct: 0.5 }).boxMode, 'pct');
});
