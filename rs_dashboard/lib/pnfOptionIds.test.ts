import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptionIds } from './pnfTarget.ts';

test('parseOptionIds: only a listed segment with a numeric id', () => {
  assert.deepEqual(parseOptionIds('NSE_FNO:12345'), { segment: 'NSE_FNO', securityId: '12345' });
  assert.deepEqual(parseOptionIds('MCX_COMM:9'), { segment: 'MCX_COMM', securityId: '9' });
  for (const bad of ['BSE_FNO:1', 'NSE_FNO:', 'NSE_FNO:12a', 'NSE_FNO:1234567890', '', null, 5]) assert.equal(parseOptionIds(bad), null);
});
