import test from 'node:test';
import assert from 'node:assert/strict';
import { serverBrickDiffers } from './pnfServerBrick.ts';
import type { PnfColumn } from './straddlePnf.ts';

const col = (dir: 'X' | 'O', low: number, high: number): PnfColumn => ({ dir, low, high, boxes: 1, startBar: 0, endBar: 0, session: '2026-11-06', breakBar: null, boxBars: [0] });
const page = { last: col('X', 26000, 26026), n: 120, barT: 1000, box: 26 };

test('the same newest brick matches even when the server holds more bricks (its history started earlier)', () => {
  assert.equal(serverBrickDiffers({ n: 135, dir: 'X', barT: 1000, box: 26, low: 26000, high: 26026 }, page), false);
});

test('a different direction, bar or edge is a mismatch', () => {
  assert.equal(serverBrickDiffers({ n: 120, dir: 'O', barT: 1000, box: 26, low: 26000, high: 26026 }, page), true);
  assert.equal(serverBrickDiffers({ n: 120, dir: 'X', barT: 1060, box: 26, low: 26000, high: 26026 }, page), true);
  assert.equal(serverBrickDiffers({ n: 120, dir: 'X', barT: 1000, box: 26, low: 26026, high: 26052 }, page), true);
});

test('an older server without edges is compared by count and box, as before', () => {
  assert.equal(serverBrickDiffers({ n: 120, dir: 'X', barT: 1000, box: 26 }, page), false);
  assert.equal(serverBrickDiffers({ n: 121, dir: 'X', barT: 1000, box: 26 }, page), true);
  assert.equal(serverBrickDiffers({ n: 120, dir: 'X', barT: 1000, box: 25 }, page), true);
});
