import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelModel } from './straddlePnfModel.ts';
import { vwap, sessionOf, type Bar } from './straddlePnf.ts';

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

// A column can open on one day and keep going on the next. Its overlay value is read at its LAST bar, so the line must be split
// by the session of that bar: splitting by the session the column opened in draws the new day's VWAP inside the old day's
// segment, as a vertical streak.
test('overlaySession is the session of the bar each overlay value comes from', () => {
  const DAY = 86_400;
  const day1 = [0, 5].map((l, i) => ({ t: BASE_T + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 10 }));
  const day2 = [6, 7].map((l, i) => ({ t: BASE_T + DAY + i * 60, ce: priceAt(l) / 2, pe: priceAt(l) / 2, straddle: priceAt(l), vol: 10 }));
  const b = [...day1, ...day2];
  const m = buildPanelModel(b, 'vwap');
  assert.equal(m.columns.length, 1);                                  // one X column that spans midnight
  assert.equal(m.columns[0].session, sessionOf(b[1].t));              // it opened on day 1
  assert.equal(m.overlaySession[0], sessionOf(b[3].t));               // but its overlay value is day 2's
  assert.notEqual(m.overlaySession[0], m.columns[0].session);
});

test('overlaySession has one entry per column', () => {
  const m = buildPanelModel(bars(PATH), 'vwap');
  assert.equal(m.overlaySession.length, m.columns.length);
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
