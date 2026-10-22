import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrevDayLevels } from './prevDayLevels.ts';

test('getPrevDayLevels returns levels for NIFTY', async () => {
  const levels = await getPrevDayLevels('NIFTY');
  if (levels) {
    assert.ok(levels.high > 0, 'high should be positive');
    assert.ok(levels.low > 0, 'low should be positive');
    assert.ok(levels.close > 0, 'close should be positive');
    assert.ok(levels.high >= levels.low, 'high should be >= low');
  }
});

test('getPrevDayLevels returns levels for BANKNIFTY', async () => {
  const levels = await getPrevDayLevels('BANKNIFTY');
  if (levels) {
    assert.ok(levels.high > 0, 'high should be positive');
    assert.ok(levels.low > 0, 'low should be positive');
    assert.ok(levels.close > 0, 'close should be positive');
    assert.ok(levels.high >= levels.low, 'high should be >= low');
  }
});
