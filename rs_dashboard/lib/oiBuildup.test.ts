import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOiBuildup } from './oiBuildup.ts';

const base = { oi: 1200, prevOi: 1000, ltp: 110, prevClose: 100 };

test('four quadrants', () => {
  assert.equal(classifyOiBuildup(base), 'Long Buildup');
  assert.equal(classifyOiBuildup({ ...base, ltp: 90 }), 'Short Buildup');
  assert.equal(classifyOiBuildup({ ...base, oi: 800 }), 'Short Covering');
  assert.equal(classifyOiBuildup({ ...base, oi: 800, ltp: 90 }), 'Long Unwinding');
});

test('missing or zero baselines give no signal', () => {
  assert.equal(classifyOiBuildup(undefined), null);
  assert.equal(classifyOiBuildup({ ...base, prevOi: 0 }), null);
  assert.equal(classifyOiBuildup({ ...base, prevClose: 0 }), null);
  assert.equal(classifyOiBuildup({ ...base, ltp: 0 }), null);
  assert.equal(classifyOiBuildup({ ...base, oi: 1000 }), null);
});
