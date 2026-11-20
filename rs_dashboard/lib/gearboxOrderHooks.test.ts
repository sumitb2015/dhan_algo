import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_QTY_CAPS, SOURCE_QTY_CAPS_MCX, dhanSourceCapError, dhanSourceQtyCap } from './dhanSourceCaps.ts';
import { optionLegKeys, optionLegReserved, planLegCloseKeeping } from './pnfOrderLogic.ts';
import { emptyLedger, reservedUnits, type GbLedger, type GbRow } from './gearboxLedger.ts';
import { targetKey } from './pnfTarget.ts';

// Task 3 of Gearbox Drive: the 'gbx' per-order cap in the Dhan order layer, and the P&F square-off keeping Gearbox's units.

test('gbx MCX cap is 1 lot', () => {
  assert.equal(SOURCE_QTY_CAPS_MCX.gbx, 1);
  assert.equal(dhanSourceQtyCap('gbx', 'MCX_COMM'), 1);
  assert.equal(dhanSourceQtyCap('gbx', 'mcx_comm'), 1);
});

test('gbx: quantity 2 on MCX_COMM is refused naming the cap, quantity 1 passes', () => {
  const err = dhanSourceCapError(2, 'gbx', 'MCX_COMM');
  assert.ok(err && /gbx/.test(err) && /cap of 1/.test(err), String(err));
  assert.equal(dhanSourceCapError(1, 'gbx', 'MCX_COMM'), null);
});

test('existing caps are unchanged', () => {
  assert.equal(dhanSourceQtyCap('orba', 'MCX_COMM'), 1);
  assert.equal(dhanSourceQtyCap('pl', 'MCX_COMM'), 20);
  assert.equal(dhanSourceQtyCap('pl', 'NSE_FNO'), 1500);
  assert.equal(dhanSourceQtyCap('ts', 'MCX_COMM'), SOURCE_QTY_CAPS.ts);   // falls back to the unit table
  assert.equal(dhanSourceQtyCap(undefined, 'MCX_COMM'), undefined);         // no source: uncapped
  assert.equal(dhanSourceQtyCap('pnf', 'MCX_COMM'), undefined);
  assert.equal(dhanSourceQtyCap('gbx', 'NSE_FNO'), undefined);              // gbx trades MCX only
  assert.equal(dhanSourceCapError(5000, undefined, 'NSE_FNO'), null);
});

const straddle = { kind: 'options' as const, symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-15', strike: 6000, side: 'CE+PE' };
const ce = { ...straddle, side: 'CE' as const };
const gbRow = (x: Partial<GbRow> = {}): GbRow => ({
  id: 'g1', mode: 'REAL', broker: 'dhan', underlying: 'CRUDEOILM', dir: 'LONG', leg: { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' },
  target: ce, lots: 1, units: 10, unitsPerLot: 10, entry: 100, entryDecision: 100, entryAt: 1, day: '2026-11-20', status: 'open', ...x,
});
const gb = (rows: GbRow[]): GbLedger => ({ ...emptyLedger(), mode: 'REAL', rows });

test('option leg keys are per CE / PE leg, null for a non-option chart', () => {
  // cast: the P&F straddle target's side string is wider than the Gearbox row's
  const keys = optionLegKeys(straddle as never, [{ side: 'CE' }, { side: 'PE' }]);
  assert.deepEqual(keys, [targetKey(ce), targetKey({ ...straddle, side: 'PE' } as never)]);
  assert.deepEqual(optionLegKeys({ kind: 'futures', symbol: 'CRUDEOILM' } as never, [{ side: 'FUT' }]), [null]);
});

test('a P&F close keeps Gearbox units on the matching option leg', () => {
  const keys = optionLegKeys(straddle as never, [{ side: 'CE' }, { side: 'PE' }]);
  const ledger = gb([gbRow()]);
  const gearbox = (k: string) => reservedUnits(ledger, 'dhan', k, targetKey);
  const none = () => 0;
  const reserved = optionLegReserved(keys, [none, none, none, gearbox]);
  assert.deepEqual(reserved, [10, 0]);
  // broker holds 3 lots (30 units) long of the CE: the close plans 30 - 10 (Gearbox's 1 lot)
  const plan = planLegCloseKeeping('ce-id', [{ key: 'ce-id', product: 'INTRADAY', net: 30 }], reserved[0], 'dhan');
  assert.deepEqual(plan, [{ side: 'SELL', qty: 20, product: 'INTRADAY' }]);
});

test('Gearbox SIM, closed or other-broker rows keep nothing; non-option legs keep 0', () => {
  const keys = optionLegKeys(straddle as never, [{ side: 'CE' }, { side: 'PE' }]);
  const ledger = gb([gbRow({ mode: 'SIM' }), gbRow({ id: 'g2', broker: 'kotak' as never }), gbRow({ id: 'g3', status: 'closed' })]);
  const gearbox = (k: string) => reservedUnits(ledger, 'dhan', k, targetKey);
  assert.deepEqual(optionLegReserved(keys, [gearbox]), [0, 0]);
  assert.deepEqual(optionLegReserved([null], [() => 99]), [0]);
});

test('reservation sources add up per leg', () => {
  assert.deepEqual(optionLegReserved(['a', 'b'], [k => (k === 'a' ? 5 : 1), k => (k === 'a' ? -2 : 3)]), [3, 4]);
});
