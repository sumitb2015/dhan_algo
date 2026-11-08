import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOX_LOG, boxLogOf, DEFAULT_SETTINGS, MIN_BOX_PCT, MIN_BOX_PTS, MAX_BOX_PCT, REVERSALS, boxText, stepBox, stepBoxBy, BOX_PCT_STEPS, BOX_PTS_STEPS, parseBoxPct, parseBoxPts, parseSmaPeriod, parseStMult, parseStPeriod, readSettings, serializeSettings } from './straddlePnfSettings.ts';

test('defaults are the 1-minute / 0.5% / 3-box chart with an SMA 50 overlay', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { interval: 1, boxMode: 'pct', boxPct: 0.5, boxPts: 10, reversal: 3, smaPeriod: 50, stPeriod: 10, stMult: 3 });
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
  assert.deepEqual(readSettings('{"interval":7,"boxPct":0.5}'), { interval: 1, boxMode: 'pct', boxPct: 0.5, boxPts: 10, reversal: 3, smaPeriod: 50, stPeriod: 10, stMult: 3 });   // 7 is not an offered interval
  assert.deepEqual(readSettings('{"interval":5,"boxPct":99}'), { interval: 5, boxMode: 'pct', boxPct: 0.5, boxPts: 10, reversal: 3, smaPeriod: 50, stPeriod: 10, stMult: 3 });    // out-of-range box falls back per field
  assert.deepEqual(readSettings('{"interval":"5","boxPct":"1"}'), DEFAULT_SETTINGS);                           // wrong types
  assert.deepEqual(readSettings('{"interval":5,"boxPct":1}'), { interval: 5, boxMode: 'pct', boxPct: 1, boxPts: 10, reversal: 3, smaPeriod: 50, stPeriod: 10, stMult: 3 });      // a file saved before reversal existed
});

test('reversal must be one of the offered whole numbers of boxes, else it falls back to 3', () => {
  assert.equal(readSettings('{"reversal":2}').reversal, 2);
  assert.equal(readSettings('{"reversal":5}').reversal, 5);
  for (const bad of ['0', '6', '2.5', '-1', '"3"', 'null']) assert.equal(readSettings(`{"reversal":${bad}}`).reversal, 3, bad);
});

test('settings round-trip through storage', () => {
  assert.deepEqual(readSettings(serializeSettings({ interval: 15, boxMode: 'pct', boxPct: 1.25, boxPts: 10, reversal: 2, smaPeriod: 120, stPeriod: 10, stMult: 3 })), { interval: 15, boxMode: 'pct', boxPct: 1.25, boxPts: 10, reversal: 2, smaPeriod: 120, stPeriod: 10, stMult: 3 });
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

test('parseBoxPts takes a positive number of points (decimals, a decimal comma or a "pts" suffix) inside the range', () => {
  assert.equal(parseBoxPts('50'), 50);
  assert.equal(parseBoxPts(' 2.5 '), 2.5);
  assert.equal(parseBoxPts('0,5'), 0.5);
  assert.equal(parseBoxPts('25 pts'), 25);
  for (const bad of ['', '0', '-5', 'abc', '0.001', '100001', '1e3', '5 5']) assert.equal(parseBoxPts(bad), null, bad);
});

test('box mode and points round-trip; an old file without them reads as % mode with 10 points kept ready', () => {
  const s = readSettings('{"interval":1,"boxPct":0.25,"reversal":3,"smaPeriod":50}');
  assert.equal(s.boxMode, 'pct');
  assert.equal(s.boxPts, 10);
  const pts = readSettings(serializeSettings({ ...DEFAULT_SETTINGS, boxMode: 'pts', boxPts: 50 }));
  assert.deepEqual([pts.boxMode, pts.boxPts], ['pts', 50]);
  assert.equal(readSettings('{"boxMode":"pts","boxPts":-1}').boxPts, 10);
  assert.equal(readSettings('{"boxMode":"weird"}').boxMode, 'pct');
  assert.equal(boxText({ boxMode: 'pts', boxPct: 0.5, boxPts: 50 }), '50-pt box');
  assert.equal(boxText({ boxMode: 'pct', boxPct: 0.5, boxPts: 50 }), '0.5% box');
});

test('stepBox moves along a ladder of round sizes, from any typed value, and stops at the ends', () => {
  assert.equal(stepBox('pct', 0.25, 1), 0.3);
  assert.equal(stepBox('pct', 0.25, -1), 0.2);
  assert.equal(stepBox('pct', 0.33, 1), 0.4);                 // a typed value steps onto the ladder
  assert.equal(stepBox('pct', 0.33, -1), 0.3);
  assert.equal(stepBox('pct', 5, 1), 5);
  assert.equal(stepBox('pct', 0.05, -1), 0.05);
  assert.equal(stepBox('pts', 50, 1), 100);
  assert.equal(stepBox('pts', 50, -1), 25);
  assert.equal(stepBox('pts', 37, 1), 50);
  assert.equal(stepBox('pts', 2.5, -1), 2);
  assert.equal(stepBox('pts', 0.01, -1), 0.01);
  assert.equal(stepBox('pts', 100000, 1), 100000);
  assert.ok(BOX_PCT_STEPS.every((v, i) => i === 0 || v > BOX_PCT_STEPS[i - 1]));
  assert.ok(BOX_PTS_STEPS.includes(0.25) && BOX_PTS_STEPS.includes(25) && BOX_PTS_STEPS.includes(50000));
});

test('Supertrend period and multiplier: parsed, range-checked and read back per field', () => {
  assert.equal(parseStPeriod(' 14 '), 14);
  for (const bad of ['0', '101', '7.5', '', 'x']) assert.equal(parseStPeriod(bad), null, bad);
  assert.equal(parseStMult('2.5'), 2.5);
  assert.equal(parseStMult('1,5'), 1.5);
  assert.equal(parseStMult('3.04'), 3);
  for (const bad of ['0.4', '10.5', '-1', 'abc', '']) assert.equal(parseStMult(bad), null, bad);
  assert.deepEqual([readSettings('{"stPeriod":7,"stMult":2}').stPeriod, readSettings('{"stPeriod":7,"stMult":2}').stMult], [7, 2]);
  assert.deepEqual([readSettings('{"stPeriod":0,"stMult":99}').stPeriod, readSettings('{"stPeriod":0,"stMult":99}').stMult], [10, 3]);  // out of range: defaults
  assert.equal(readSettings('{"smaPeriod":20}').stPeriod, 10);   // saved before the Supertrend existed
});

test('stepBoxBy (Renko) steps to the next multiple of 1 point or 0.5 %, with only the minimum below the first step', () => {
  assert.equal(stepBoxBy('pts', 10, 1), 11);
  assert.equal(stepBoxBy('pts', 10, -1), 9);
  assert.equal(stepBoxBy('pts', 2.5, 1), 3);                    // a typed value steps onto the grid
  assert.equal(stepBoxBy('pts', 2.5, -1), 2);
  assert.equal(stepBoxBy('pts', 1, -1), MIN_BOX_PTS);
  assert.equal(stepBoxBy('pts', MIN_BOX_PTS, 1), 1);
  assert.equal(stepBoxBy('pct', 0.5, -1), MIN_BOX_PCT);          // the default 0.5 %: down to the floor, back up to 0.5
  assert.equal(stepBoxBy('pct', MIN_BOX_PCT, 1), 0.5);
  assert.equal(stepBoxBy('pct', 0.1, 1), 0.5);
  assert.equal(stepBoxBy('pct', 0.5, 1), 1);
  assert.equal(stepBoxBy('pct', 1.2, 1), 1.5);
  assert.equal(stepBoxBy('pct', 1.2, -1), 1);
  assert.equal(stepBoxBy('pct', 1.5, -1), 1);
  assert.equal(stepBoxBy('pct', 4.8, 1), MAX_BOX_PCT);
  assert.equal(stepBoxBy('pct', MAX_BOX_PCT, 1), MAX_BOX_PCT);
});

test('Log % box: the mode and its % are stored and read back; a file without boxLog reads unchanged (default when used)', () => {
  const s = readSettings('{"boxMode":"log","boxLog":0.25}');
  assert.equal(s.boxMode, 'log');
  assert.equal(s.boxLog, 0.25);
  assert.deepEqual(readSettings(serializeSettings(s)), s);
  assert.equal(readSettings('{"boxMode":"log"}').boxLog, undefined);
  assert.equal(boxLogOf(readSettings('{"boxMode":"log"}')), DEFAULT_BOX_LOG);
  for (const bad of ['0', '99', '"1"', 'null']) assert.equal(readSettings(`{"boxMode":"log","boxLog":${bad}}`).boxLog, undefined, bad);
  assert.equal(boxText({ boxMode: 'log', boxPct: 0.5, boxPts: 10, boxLog: 1 }), '1% log box');
  assert.equal(stepBoxBy('log', 0.1, 1), 0.15);
  assert.equal(stepBoxBy('log', 0.05, -1), MIN_BOX_PCT);
});
