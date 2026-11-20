import test from 'node:test';
import assert from 'node:assert/strict';
import { gbRecordPairs, gbRecordTargets, mcxRecordOpen } from './gearboxAlwaysRecordCore.ts';
import { emptyLedger, type GbLedger, type GbRow, type GbStatus } from './gearboxLedger.ts';
import type { FnoRow } from './pnfContracts.ts';
import type { Target } from './pnfTarget.ts';

const TODAY = '2026-11-20';   // a Friday; winter (US DST ended 2026-11-01): MCX 09:00-23:55 IST
const ist = (iso: string, hh: number, mm: number) => Date.parse(`${iso}T00:00:00Z`) + ((hh * 60 + mm) - 330) * 60_000;

const row = (u: 'CRUDEOIL' | 'CRUDEOILM', expiry: string, optType: 'CE' | 'PE' | null, id: string, strike = 6000): FnoRow => ({
  exch: 'MCX', segment: 'MCX_COMM', securityId: id, instrument: optType ? 'OPTFUT' : 'FUTCOM', underlying: u,
  displayName: `${u} ${expiry} ${optType ?? 'FUT'}`, expiry, strike: optType ? strike : -0.01, optType, lot: 1,
});
const FNO: FnoRow[] = [
  row('CRUDEOILM', TODAY, 'CE', 'O0'), row('CRUDEOILM', '2026-12-16', 'CE', 'O1'), row('CRUDEOILM', '2026-12-16', 'PE', 'O2'),
  row('CRUDEOILM', '2026-11-19', null, 'FM0'), row('CRUDEOILM', '2026-12-17', null, 'FM1'), row('CRUDEOILM', '2027-01-19', null, 'FM2'),
  row('CRUDEOIL', '2026-12-16', 'CE', 'OB1'), row('CRUDEOIL', '2026-12-17', null, 'FB1'),
];

const fut = (u: 'CRUDEOIL' | 'CRUDEOILM', expiry: string): Target => ({ kind: 'futures', symbol: u, name: u, expiry });
const gbRow = (id: string, target: Target, status: GbStatus): GbRow => ({
  id, mode: 'SIM', broker: 'dhan', underlying: target.symbol as 'CRUDEOIL', dir: 'LONG',
  leg: { action: 'BUY', opt: target.kind === 'futures' ? 'FUT' : 'CE', offset: 0, expiry: 'nearest' }, target,
  lots: 1, units: 1, unitsPerLot: 10, entry: 1, entryDecision: 1, entryAt: 0, day: TODAY, status,
});
const ledger = (rows: GbRow[] = [], underlying: 'CRUDEOIL' | 'CRUDEOILM' = 'CRUDEOILM'): GbLedger => {
  const l = emptyLedger();
  return { ...l, config: { ...l.config, underlying }, rows };
};

test('mcxRecordOpen: from the MCX open to the close, not before, not at the close, not at weekends', () => {
  assert.equal(mcxRecordOpen(ist(TODAY, 8, 59)), false);
  assert.equal(mcxRecordOpen(ist(TODAY, 9, 0)), true);
  assert.equal(mcxRecordOpen(ist(TODAY, 23, 54)), true);
  assert.equal(mcxRecordOpen(ist(TODAY, 23, 55)), false, 'winter close 23:55');
  assert.equal(mcxRecordOpen(ist('2026-11-21', 12, 0)), false, 'Saturday');
  // summer (US DST): the close is 23:30
  assert.equal(mcxRecordOpen(ist('2026-06-17', 23, 29)), true);
  assert.equal(mcxRecordOpen(ist('2026-06-17', 23, 30)), false);
});

test('gbRecordTargets: the signal future of the nearest option expiry AFTER today (the page\'s future)', () => {
  // options expiring today are skipped: nearest = 2026-12-16 -> first future on or after it = 2026-12-17
  assert.deepEqual(gbRecordTargets(ledger(), TODAY, FNO), [fut('CRUDEOILM', '2026-12-17')]);
  assert.deepEqual(gbRecordPairs(ledger(), TODAY, FNO), [['MCX_COMM', 'FM1']]);
  assert.deepEqual(gbRecordPairs(ledger([], 'CRUDEOIL'), TODAY, FNO), [['MCX_COMM', 'FB1']]);
});

test('gbRecordPairs: adds every live FUT row\'s future (any underlying / expiry), de-duplicated; closed and option rows are not asked', () => {
  const rows = [
    gbRow('a', fut('CRUDEOILM', '2026-12-17'), 'open'),           // same as the signal future: once
    gbRow('b', fut('CRUDEOILM', '2027-01-19'), 'unknown'),        // live (unknown counts): asked
    gbRow('c', fut('CRUDEOIL', '2026-12-17'), 'closing'),         // another underlying after a config change: asked
    gbRow('d', fut('CRUDEOILM', '2026-11-19'), 'closed'),         // closed: not asked
    gbRow('e', { kind: 'options', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-16', strike: 6000, side: 'CE' }, 'open'),
  ];
  assert.deepEqual(gbRecordPairs(ledger(rows), TODAY, FNO), [['MCX_COMM', 'FM1'], ['MCX_COMM', 'FM2'], ['MCX_COMM', 'FB1']]);
});

test('gbRecordPairs: nothing to ask when the master has no option expiry / future (never throws)', () => {
  assert.deepEqual(gbRecordPairs(ledger(), TODAY, []), []);
  // a live FUT row whose contract left the master: skipped
  assert.deepEqual(gbRecordPairs(ledger([gbRow('x', fut('CRUDEOILM', '2027-05-19'), 'open')]), TODAY, FNO), [['MCX_COMM', 'FM1']]);
});
