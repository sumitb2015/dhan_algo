import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTags } from './pnfTagLayout.ts';

test('tags that already have room stay exactly where their levels are', () => {
  const m = layoutTags([{ key: 'a', y: 100 }, { key: 'b', y: 140 }, { key: 'c', y: 200 }], 18);
  assert.deepEqual([m.get('a'), m.get('b'), m.get('c')], [100, 140, 200]);
});

test('a cluster is spread to the gap and centred on its levels, in the same order', () => {
  const m = layoutTags([{ key: 'tgt', y: 100 }, { key: 'pos', y: 108 }, { key: 'sl', y: 116 }], 18);
  const ys = [m.get('tgt')!, m.get('pos')!, m.get('sl')!];
  assert.ok(ys[1] - ys[0] >= 18 - 1e-9 && ys[2] - ys[1] >= 18 - 1e-9, `gaps ok: ${ys}`);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2]);
  assert.ok(Math.abs((ys[0] + ys[1] + ys[2]) / 3 - 108) < 1e-6, 'centred on the levels');
});

test('two clusters apart from each other do not disturb one another; equal levels still separate', () => {
  const m = layoutTags([{ key: 'a', y: 50 }, { key: 'b', y: 50 }, { key: 'c', y: 300 }], 18);
  assert.equal(m.get('c'), 300);
  assert.ok(Math.abs(m.get('a')! - m.get('b')!) >= 18 - 1e-9);
});
