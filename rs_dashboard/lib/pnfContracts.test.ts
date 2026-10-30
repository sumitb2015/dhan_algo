import test from 'node:test';
import assert from 'node:assert/strict';
import { atmStrike, expiriesFor, fnoUnderlyings, hasUnderlying, parseFnoRows, resolveFuture, resolveOption, spotSourceKind, strikesFor } from './pnfContracts.ts';

const HEAD = 'EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE';
const row = (ex: string, seg: string, id: string, inst: string, u: string, disp: string, lot: number, exp: string, k: number, ot: string) =>
  [ex, seg, id, 'NA', inst, '', u, '', disp, '', 'NA', lot, exp, k, ot, 5].join(',');
const TEXT = [
  HEAD,
  row('NSE', 'D', '1', 'FUTIDX', 'NIFTY', 'NIFTY NOV FUT', 65, '2026-11-24', -0.01, 'XX'),
  row('NSE', 'D', '2', 'FUTIDX', 'NIFTY', 'NIFTY OCT FUT', 65, '2026-10-27', -0.01, 'XX'),      // expired
  row('NSE', 'D', '3', 'OPTIDX', 'NIFTY', 'NIFTY 03 NOV 23000 CALL', 65, '2026-11-03', 23000, 'CE'),
  row('NSE', 'D', '4', 'OPTIDX', 'NIFTY', 'NIFTY 03 NOV 23000 PUT', 65, '2026-11-03', 23000, 'PE'),
  row('NSE', 'D', '5', 'OPTIDX', 'NIFTY', 'NIFTY 03 NOV 23100 CALL', 65, '2026-11-03', 23100, 'CE'),
  row('NSE', 'D', '6', 'OPTIDX', 'NIFTY', 'NIFTY 03 NOV 23100 PUT', 65, '2026-11-03', 23100, 'PE'),
  row('NSE', 'D', '7', 'OPTIDX', 'NIFTY', 'NIFTY 03 NOV 23200 CALL', 65, '2026-11-03', 23200, 'CE'),  // no PE: not a straddle strike
  row('NSE', 'D', '8', 'FUTSTK', 'RELIANCE', 'RELIANCE NOV FUT', 500, '2026-11-24', -0.01, 'XX'),
  row('NSE', 'D', '9', 'FUTSTK', '011NSETEST', 'TEST FUT', 1, '2026-11-24', -0.01, 'XX'),      // NSE dummy
  row('BSE', 'D', '10', 'FUTSTK', 'RELIANCE', 'RELIANCE NOV FUT', 500, '2026-11-26', 0, ''),    // BSE: out of scope
  row('MCX', 'M', '11', 'FUTCOM', 'CRUDEOILM', 'CRUDEOILM NOV FUT', 1, '2026-11-19', 0, 'XX'),
  row('MCX', 'M', '12', 'OPTFUT', 'CRUDEOILM', 'CRUDEOILM 17 NOV 8500 CALL', 1, '2026-11-17', 8500, 'CE'),
  row('MCX', 'M', '13', 'OPTFUT', 'CRUDEOILM', 'CRUDEOILM 17 NOV 8500 PUT', 1, '2026-11-17', 8500, 'PE'),
  row('MCX', 'M', '14', 'FUTIDX', 'MCXBULLDEX', 'BULLDEX NOV FUT', 1, '2026-11-24', 0, 'XX'),   // MCX index future: out of scope
].join('\n');
const R = parseFnoRows(TEXT, '2026-10-30');

test('parseFnoRows keeps live NSE F&O and MCX commodity contracts only', () => {
  assert.deepEqual(R.map(r => r.securityId), ['1', '3', '4', '5', '6', '7', '8', '11', '12', '13']);
  const opt = R.find(r => r.securityId === '3')!;
  assert.deepEqual(opt, { exch: 'NSE', segment: 'NSE_FNO', securityId: '3', instrument: 'OPTIDX', underlying: 'NIFTY',
    displayName: 'NIFTY 03 NOV 23000 CALL', expiry: '2026-11-03', strike: 23000, optType: 'CE', lot: 65 });
  assert.equal(R.find(r => r.securityId === '11')!.segment, 'MCX_COMM');
  assert.equal(R.find(r => r.securityId === '1')!.optType, null);
});

test('underlyings, expiries and straddle strikes per kind', () => {
  assert.deepEqual(fnoUnderlyings('futures', '', 10, R).map(u => u.symbol), ['NIFTY', 'RELIANCE', 'CRUDEOILM']);
  assert.deepEqual(fnoUnderlyings('options', 'cru', 10, R).map(u => u.symbol), ['CRUDEOILM']);
  assert.deepEqual(fnoUnderlyings('futures', 'L', 10, R).map(u => u.symbol), ['RELIANCE', 'CRUDEOILM']);   // contains, after prefixes
  assert.equal(hasUnderlying('options', 'RELIANCE', R), false);
  assert.deepEqual(expiriesFor('futures', 'NIFTY', R), ['2026-11-24']);
  assert.deepEqual(expiriesFor('options', 'NIFTY', R), ['2026-11-03']);
  assert.deepEqual(strikesFor('NIFTY', '2026-11-03', R), [23000, 23100]);
});

test('resolve a future and an option leg to their server-side contract', () => {
  assert.deepEqual(resolveFuture('CRUDEOILM', '2026-11-19', R), { segment: 'MCX_COMM', securityId: '11', instrument: 'FUTCOM', displayName: 'CRUDEOILM NOV FUT', lot: 1, expiry: '2026-11-19' });
  assert.equal(resolveOption('NIFTY', '2026-11-03', 23100, 'PE', R)?.securityId, '6');
  assert.equal(resolveOption('NIFTY', '2026-11-03', 23150, 'PE', R), null);
  assert.equal(resolveFuture('NIFTY', '2026-10-27', R), null);                       // expired
});

test('ATM is the nearest listed strike, the middle one without a spot', () => {
  assert.equal(atmStrike([23000, 23100, 23200], 23140), 23100);
  assert.equal(atmStrike([23000, 23100, 23200], 23160), 23200);
  assert.equal(atmStrike([23000, 23100, 23200], null), 23100);
  assert.equal(atmStrike([], 23000), null);
});

test('the spot source follows the underlying', () => {
  assert.equal(spotSourceKind('NIFTY', R), 'index');
  assert.equal(spotSourceKind('RELIANCE', R), 'equity');
  assert.equal(spotSourceKind('CRUDEOILM', R), 'mcx');
  assert.equal(spotSourceKind('NOPE', R), null);
});
