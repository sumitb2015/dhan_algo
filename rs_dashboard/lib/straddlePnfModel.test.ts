import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelModel } from './straddlePnfModel.ts';
import { vwap, type Bar } from './straddlePnf.ts';

const BASE_T = Date.UTC(2026, 9, 23, 3, 45) / 1000;
const A = 100;
const BOX = A * 0.005;
const priceAt = (l: number) => A + (l + (l > 0 ? 0.3 : l < 0 ? -0.3 : 0)) * BOX;
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

test('no bars gives an empty model, not a throw', () => {
  const m = buildPanelModel([], 'vwap');
  assert.deepEqual([m.columns, m.signals, m.exits, m.overlay], [[], [], [], []]);
  assert.equal(m.box, 0);
});
