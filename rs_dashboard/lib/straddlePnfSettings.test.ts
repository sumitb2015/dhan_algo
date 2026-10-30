import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, MIN_BOX_PCT, MAX_BOX_PCT, REVERSALS, parseBoxPct, parseSmaPeriod, readSettings, serializeSettings } from './straddlePnfSettings.ts';

test('defaults are the 1-minute / 0.5% / 3-box chart with an SMA 50 overlay', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { interval: 1, boxPct: 0.5, reversal: 3, smaPeriod: 50 });
  assert.deepEqual([...REVERSALS], [1, 2, 3, 4, 5]);
});

test('parseBoxPct accepts plain numbers, a trailing % and a decimal comma, inside the allowed range', () => {
  assert.equal(parseBoxPct('0.5'), 0.5);
  assert.equal(parseBoxPct(' 1 '), 1);
  assert.equal(parseBoxPct('0.75%'), 0.75);
  assert.equal(parseBoxPct('0,25'), 0.25);
  assert.equal(parseBoxPct(String(MIN_BOX_PCT)), MIN_BOX_PCT);
  assert.equal(parseBoxPct(String(MAX_BOX_PCT)), MAX_BOX_PCT);
});

test('parseBoxPct rejects empty, non-numeric, zero, negative and out-of-range values', () => {
  for (const bad of ['', '  ', 'abc', '0', '-1', '0.01', '5.01', '50', 'NaN', 'Infinity', '1e9', '0.5 0.6']) {
    assert.equal(parseBoxPct(bad), null, bad);
  }
});

test('readSettings falls back to the defaults for anything unusable', () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings('not json'), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings('{"interval":7,"boxPct":0.5}'), { interval: 1, boxPct: 0.5, reversal: 3, smaPeriod: 50 });   // 7 is not an offered interval
  assert.deepEqual(readSettings('{"interval":5,"boxPct":99}'), { interval: 5, boxPct: 0.5, reversal: 3, smaPeriod: 50 });    // out-of-range box falls back per field
  assert.deepEqual(readSettings('{"interval":"5","boxPct":"1"}'), DEFAULT_SETTINGS);                           // wrong types
  assert.deepEqual(readSettings('{"interval":5,"boxPct":1}'), { interval: 5, boxPct: 1, reversal: 3, smaPeriod: 50 });      // a file saved before reversal existed
});

test('reversal must be one of the offered whole numbers of boxes, else it falls back to 3', () => {
  assert.equal(readSettings('{"reversal":2}').reversal, 2);
  assert.equal(readSettings('{"reversal":5}').reversal, 5);
  for (const bad of ['0', '6', '2.5', '-1', '"3"', 'null']) assert.equal(readSettings(`{"reversal":${bad}}`).reversal, 3, bad);
});

test('settings round-trip through storage', () => {
  assert.deepEqual(readSettings(serializeSettings({ interval: 15, boxPct: 1.25, reversal: 2, smaPeriod: 120 })), { interval: 15, boxPct: 1.25, reversal: 2, smaPeriod: 120 });
});

test('parseSmaPeriod takes a whole number of bars inside the allowed range', () => {
  assert.equal(parseSmaPeriod('50'), 50);
  assert.equal(parseSmaPeriod(' 2 '), 2);
  assert.equal(parseSmaPeriod('500'), 500);
  for (const bad of ['', '1', '0', '501', '20.5', '-5', 'abc', '1e2', '5 0']) assert.equal(parseSmaPeriod(bad), null, bad);
});

test('a stored SMA period is kept when valid, else it falls back to 50 (files saved before the setting existed too)', () => {
  assert.equal(readSettings('{"smaPeriod":20}').smaPeriod, 20);
  assert.equal(readSettings('{"interval":5,"boxPct":1,"reversal":3}').smaPeriod, 50);
  for (const bad of ['1', '501', '20.5', '"20"', 'null']) assert.equal(readSettings(`{"smaPeriod":${bad}}`).smaPeriod, 50, bad);
});
