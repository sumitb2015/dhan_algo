import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelModel } from './straddlePnfModel.ts';
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

test('the sma overlay is null until ten bars exist, and vwap still drives the signals', () => {
  const m = buildPanelModel(bars(PATH), 'sma');
  assert.deepEqual(m.overlay, [null, null, null, null]);
  assert.equal(m.signals.length, 2);
});

test('the sma overlay has values once ten bars exist', () => {
  const m = buildPanelModel(bars([0, 5, 2, 0, 3, 7, 4, -1, -2, -3, -4, -5]), 'sma');
  assert.ok(m.overlay[m.overlay.length - 1] !== null);
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

test('vwapIsAverage is set only when no bar carried volume (an index)', () => {
  assert.equal(buildPanelModel(bars(PATH), 'vwap').vwapIsAverage, false);
  assert.equal(buildPanelModel(bars(PATH).map(x => ({ ...x, vol: 0 })), 'vwap').vwapIsAverage, true);
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
