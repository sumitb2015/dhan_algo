import test from 'node:test';
import assert from 'node:assert/strict';
import { noteWanted, WANTED_KEEP_MS, WANTED_MAX_PAIRS, type WantedMap } from './pnfWanted.ts';

test('two charts on different instruments are both streamed, not swapped every poll', () => {
  const m: WantedMap = new Map();
  noteWanted(m, 'IDX_I:13', [['IDX_I', '13']], 1000);
  const a = noteWanted(m, 'NSE_EQ:2885', [['NSE_EQ', '2885']], 1500);
  const b = noteWanted(m, 'IDX_I:13', [['IDX_I', '13']], 2000);
  assert.equal(a.signature, 'IDX_I:13,NSE_EQ:2885');
  assert.equal(b.signature, a.signature);                       // unchanged: the bridge file is not rewritten
});

test('a straddle chart wants both legs; a chart that stops polling is dropped after WANTED_KEEP_MS', () => {
  const m: WantedMap = new Map();
  noteWanted(m, 'NSE_FNO:1,NSE_FNO:2', [['NSE_FNO', '1'], ['NSE_FNO', '2']], 0);
  assert.equal(noteWanted(m, 'IDX_I:13', [['IDX_I', '13']], 1).signature, 'IDX_I:13,NSE_FNO:1,NSE_FNO:2');
  assert.equal(noteWanted(m, 'IDX_I:13', [['IDX_I', '13']], WANTED_KEEP_MS + 5).signature, 'IDX_I:13');
});

test('a flood of distinct asks keeps only the newest WANTED_MAX_PAIRS', () => {
  const m: WantedMap = new Map();
  let r = { pairs: [] as [string, string][], signature: '' };
  for (let i = 0; i < WANTED_MAX_PAIRS + 5; i++) r = noteWanted(m, `NSE_EQ:${i}`, [['NSE_EQ', String(i)]], i);
  assert.equal(r.pairs.length, WANTED_MAX_PAIRS);
  assert.ok(!r.signature.split(',').includes('NSE_EQ:0'));
});
