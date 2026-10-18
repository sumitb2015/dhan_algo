import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_DEFAULTS,
  applyConfigPatch,
  configKey,
  defaultsOf,
  fieldsOf,
  normalizeConfig,
  sanitizePatch,
} from './configSchema.ts';
import { AlgoError, type ConfigField } from './types.ts';

const schema: ConfigField[] = [
  { key: 'slPct', label: 'SL %', group: 'Exit', kind: 'number', min: 5, max: 60 },
  { key: 'recovery', label: 'Recovery exit', group: 'Exit', kind: 'boolean' },
];
const def = { schema, defaults: { slPct: 20, recovery: true } };
const fields = fieldsOf(def);
const defaults = defaultsOf(def);

test('defaultsOf: base defaults + strategy defaults, engine always off', () => {
  assert.equal(defaults.timeframe, BASE_DEFAULTS.timeframe);
  assert.equal(defaults.slPct, 20);
  assert.equal(defaults.engineActive, false);
});

test('sanitizePatch: drops unknown keys, coerces numeric strings and select values', () => {
  const p = sanitizePatch(fields, { slPct: '25', timeframe: '3', bogus: 1 });
  assert.deepEqual(p, { slPct: 25, timeframe: 3 });
});

test('sanitizePatch: an out-of-range or wrongly typed value refuses the whole patch', () => {
  assert.throws(() => sanitizePatch(fields, { slPct: 99 }), AlgoError);
  assert.throws(() => sanitizePatch(fields, { lotsPerTrade: 1.5 }), AlgoError);
  assert.throws(() => sanitizePatch(fields, { recovery: 'yes' }), AlgoError);
  assert.throws(() => sanitizePatch(fields, { entryStart: '9:30' }), AlgoError);
});

test('normalizeConfig: repairs bad stored fields and out-of-order times from defaults', () => {
  const c = normalizeConfig(fields, defaults, { slPct: 'x', lotsPerTrade: 3, entryStart: '15:10', entryEnd: '10:00' });
  assert.equal(c.slPct, 20);
  assert.equal(c.lotsPerTrade, 3);
  assert.equal(c.entryStart, defaults.entryStart);
  assert.equal(c.entryEnd, defaults.entryEnd);
});

test('applyConfigPatch: time order is enforced only when the patch edits a time', () => {
  assert.throws(() => applyConfigPatch(fields, defaults, defaults, { entryEnd: '15:20' }), /entryStart < entryEnd < eodExit/);
  const halted = applyConfigPatch(fields, defaults, { ...defaults, engineActive: true }, { engineActive: false });
  assert.equal(halted.engineActive, false);
});

test('configKey: ignores engineActive, changes with any rule', () => {
  const a = configKey(fields, defaults);
  assert.equal(configKey(fields, { ...defaults, engineActive: true }), a);
  assert.notEqual(configKey(fields, { ...defaults, slPct: 21 }), a);
  assert.notEqual(configKey(fields, { ...defaults, slippagePts: 0.5 }), a);
});
