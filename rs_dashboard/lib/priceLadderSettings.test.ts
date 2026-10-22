import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readLadderSettings, writeLadderSettings, timeStringToHhmm, hhmmToTimeString,
  DEFAULT_PRICE_LADDER_SETTINGS,
} from './priceLadderSettings.ts';

test('timeStringToHhmm: converts HH:MM to numeric hhmm', () => {
  assert.equal(timeStringToHhmm('23:15'), 2315);
  assert.equal(timeStringToHhmm('23:00'), 2300);
  assert.equal(timeStringToHhmm('09:15'), 915);
  assert.equal(timeStringToHhmm('9:15'), 915);
  assert.equal(timeStringToHhmm('invalid'), null);
  assert.equal(timeStringToHhmm('24:00'), null);
  assert.equal(timeStringToHhmm('23:60'), null);
});

test('hhmmToTimeString: formats numeric hhmm to HH:MM', () => {
  assert.equal(hhmmToTimeString(2315), '23:15');
  assert.equal(hhmmToTimeString(915), '09:15');
});

test('readLadderSettings: defaults to 23:15 for MCX auto-exit', () => {
  const s = readLadderSettings();
  assert.ok(s.mcxAutoExitTime);
  assert.match(s.mcxAutoExitTime, /^\d{2}:\d{2}$/);
});

test('writeLadderSettings: updates and reads back', () => {
  const orig = readLadderSettings().mcxAutoExitTime;
  try {
    const updated = writeLadderSettings({ mcxAutoExitTime: '23:20' });
    assert.equal(updated.mcxAutoExitTime, '23:20');
    assert.equal(readLadderSettings().mcxAutoExitTime, '23:20');
  } finally {
    writeLadderSettings({ mcxAutoExitTime: orig || DEFAULT_PRICE_LADDER_SETTINGS.mcxAutoExitTime });
  }
});
