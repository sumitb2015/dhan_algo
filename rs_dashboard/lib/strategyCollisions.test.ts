import { test } from 'node:test';
import assert from 'node:assert';
import { extractLegs, findCollisions } from './strategyCollisions.ts';

test('extractLegs: shape A (flat ce_strike/pe_strike + top-level expiry)', () => {
  const legs = extractLegs('nifty_advanced_imbalance', '', 'NIFTY', {
    status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 24000,
  });
  assert.strictEqual(legs.length, 2);
  assert.deepStrictEqual(legs[0], {
    strategyKey: 'nifty_advanced_imbalance', instanceId: '', legLabel: 'ce',
    underlying: 'NIFTY', expiry: '2026-09-25', strike: 24500, optType: 'CE',
  });
});

test('extractLegs: shape B (single naked leg, sold_strike + position_type)', () => {
  const legs = extractLegs('nifty_oi_directional', '', 'NIFTY', {
    status: 'RUNNING', expiry: '2026-09-25', sold_strike: 24200, position_type: 'PE_SELL',
  });
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].optType, 'PE');
  assert.strictEqual(legs[0].strike, 24200);
});

test('extractLegs: shape C (overnight_fly named leg dicts)', () => {
  const legs = extractLegs('nifty_overnight_fly', '', 'NIFTY', {
    status: 'HOLDING OVERNIGHT', expiry: '2026-09-25',
    ce_short: { strike: 24600, qty: 65 }, pe_short: { strike: 23900, qty: 65 },
    ce_hedge: { strike: 24900, qty: 65 }, pe_hedge: null,
  });
  assert.strictEqual(legs.length, 3);
  assert.ok(legs.some((l) => l.legLabel === 'ce_short' && l.strike === 24600));
  assert.ok(legs.some((l) => l.legLabel === 'ce_hedge' && l.strike === 24900));
});

test('extractLegs: shape D (delta_strangle legs.ce/legs.pe dicts)', () => {
  const legs = extractLegs('nifty_delta_strangle', '', 'NIFTY', {
    status: 'ENTERED', expiry: '2026-09-25',
    legs: { ce: { strike: 24700 }, pe: { strike: 23800 } },
  });
  assert.strictEqual(legs.length, 2);
});

test('extractLegs: shape E (flyagonal generic named legs with own expiry/type)', () => {
  const legs = extractLegs('nifty_flyagonal', '', 'NIFTY', {
    status: 'ENTERED',
    legs: {
      put_short: { strike: 23800, expiry: '2026-10-02', type: 'PE' },
      put_long: { strike: 23600, expiry: '2026-10-02', type: 'PE' },
      call_short: { strike: 24600, expiry: '2026-10-09', type: 'CE' },
    },
  });
  assert.strictEqual(legs.length, 3);
  assert.ok(legs.some((l) => l.legLabel === 'call_short' && l.expiry === '2026-10-09'));
});

test('extractLegs: unrecognized/equity shape returns empty, not an error', () => {
  const legs = extractLegs('nifty50_vwap_rs', '', 'NIFTY', {
    status: 'RUNNING', positions: { RELIANCE: { qty: 10 } },
  });
  assert.deepStrictEqual(legs, []);
});

test('extractLegs: a stopped/idle strategy is filtered out upstream, not here — but a leg-less state returns empty', () => {
  assert.deepStrictEqual(extractLegs('x', '', 'NIFTY', null), []);
  assert.deepStrictEqual(extractLegs('x', '', 'NIFTY', {}), []);
});

test('findCollisions: two different running instances short the same strike/type/expiry collide', () => {
  const strategies = {
    a: {
      meta: { key: 'nifty_advanced_imbalance', name: 'A', underlying: 'NIFTY' },
      instances: { '': { status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 24000 } },
    },
    b: {
      meta: { key: 'nifty_value_imbalance_strangle', name: 'B', underlying: 'NIFTY' },
      instances: { '': { status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 23900 } },
    },
  };
  const collisions = findCollisions(strategies);
  assert.strictEqual(collisions.length, 1);
  assert.strictEqual(collisions[0].strike, 24500);
  assert.strictEqual(collisions[0].optType, 'CE');
  assert.strictEqual(collisions[0].legs.length, 2);
});

test('findCollisions: a single strategy\'s own CE+PE legs never collide with each other', () => {
  const strategies = {
    a: {
      meta: { key: 'nifty_advanced_imbalance', name: 'A', underlying: 'NIFTY' },
      instances: { '': { status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 24000 } },
    },
  };
  assert.deepStrictEqual(findCollisions(strategies), []);
});

test('findCollisions: a stopped instance\'s stale strike is not a collision risk', () => {
  const strategies = {
    a: {
      meta: { key: 'nifty_advanced_imbalance', name: 'A', underlying: 'NIFTY' },
      instances: { '': { status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 24000 } },
    },
    b: {
      meta: { key: 'nifty_value_imbalance_strangle', name: 'B', underlying: 'NIFTY' },
      instances: { '': { status: 'STOPPED', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 23900 } },
    },
  };
  assert.deepStrictEqual(findCollisions(strategies), []);
});

test('findCollisions: different expiries at the same strike do not collide', () => {
  const strategies = {
    a: {
      meta: { key: 'nifty_advanced_imbalance', name: 'A', underlying: 'NIFTY' },
      instances: { '': { status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 24000 } },
    },
    b: {
      meta: { key: 'nifty_value_imbalance_strangle', name: 'B', underlying: 'NIFTY' },
      instances: { '': { status: 'RUNNING', expiry: '2026-10-02', ce_strike: 24500, pe_strike: 23900 } },
    },
  };
  assert.deepStrictEqual(findCollisions(strategies), []);
});

test('findCollisions: two named instances of the same strategy key can still collide', () => {
  const strategies = {
    a: {
      meta: { key: 'nifty_advanced_imbalance', name: 'A', underlying: 'NIFTY' },
      instances: {
        '': { status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24500, pe_strike: 24000 },
        second: { status: 'RUNNING', expiry: '2026-09-25', ce_strike: 24700, pe_strike: 24000 },
      },
    },
  };
  const collisions = findCollisions(strategies);
  assert.strictEqual(collisions.length, 1);
  assert.strictEqual(collisions[0].optType, 'PE');
  assert.strictEqual(collisions[0].strike, 24000);
});
