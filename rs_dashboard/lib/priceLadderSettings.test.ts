import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A temp settings file, set BEFORE the module loads: these tests must never touch the live
// debug/price_ladder_settings.json (a running dashboard would square off MCX MIS at whatever they write).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-settings-'));
process.env.PRICE_LADDER_SETTINGS_FILE = path.join(TMP_DIR, 'price_ladder_settings.json');
const {
  readLadderSettings, writeLadderSettings, timeStringToHhmm, hhmmToTimeString,
  DEFAULT_PRICE_LADDER_SETTINGS,
} = await import('./priceLadderSettings.ts');
test.after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

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
