import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPrevDay } from './prevDayLevels.ts';

// Offline: no Dhan call from a unit test. 2026-10-20 / 21 / 22 at 09:15 IST.
const t = (d: string) => Date.parse(`${d}T03:45:00Z`) / 1000;

test('pickPrevDay: the last complete day before today', () => {
  const json = {
    timestamp: [t('2026-10-20'), t('2026-10-21'), t('2026-10-22')],
    high: [100, 110, 120], low: [90, 95, 99], close: [95, 105, 115],
  };
  assert.deepEqual(pickPrevDay(json, '2026-10-22'), { high: 110, low: 95, close: 105 });
  // Before the open, today's row is not there yet: yesterday is still the answer.
  assert.deepEqual(pickPrevDay({ ...json, timestamp: json.timestamp.slice(0, 2) }, '2026-10-22'), { high: 110, low: 95, close: 105 });
});

test('pickPrevDay: holiday placeholder rows (0 prices) are skipped; nothing usable → null', () => {
  const json = { timestamp: [t('2026-10-20'), t('2026-10-21')], high: [100, 0], low: [90, 0], close: [95, 0] };
  assert.deepEqual(pickPrevDay(json, '2026-10-22'), { high: 100, low: 90, close: 95 });
  assert.equal(pickPrevDay({}, '2026-10-22'), null);
  assert.equal(pickPrevDay({ timestamp: [t('2026-10-22')], high: [1], low: [1], close: [1] }, '2026-10-22'), null);
});
