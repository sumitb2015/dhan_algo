import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsWithEntryInFlight } from './priceLadderReconcile.ts';
import type { LadderSlice, LadderState } from './priceLadder.ts';
import type { LadderPair } from './priceLadderPair.ts';
import type { LadderBasket } from './priceLadderBasket.ts';

const c = (securityId: string) => ({ underlying: 'NIFTY', expiry: '2026-11-04', strike: 24000, opt: 'CE' as const, securityId, lotSize: 65, exchangeSegment: 'NSE_FNO' });
const keyOf = (_b: string, k: { securityId: string }, product: string) => `${k.securityId}|${product}`;
const slice = (over: Partial<LadderSlice>): LadderSlice => ({
  id: 'a', kind: 'plain', broker: 'dhan', mode: 'real', contract: c('1'), side: 'SELL', lots: 1, qty: 65, product: 'MIS',
  state: 'open', createdAt: 0, updatedAt: 0, ...over,
});
const st = (over: Partial<LadderState>): LadderState => ({ date: '2026-11-02', slices: [], events: [], ...over });

test('rowsWithEntryInFlight: a REAL entry placing / working / UNKNOWN marks its row; open, closed and SIM do not', () => {
  const rows = rowsWithEntryInFlight(st({ slices: [
    slice({ id: 'w', state: 'working', contract: c('1') }),
    slice({ id: 'p', state: 'placing', contract: c('2') }),
    slice({ id: 'u', state: 'unknown', contract: c('3') }),
    slice({ id: 'o', state: 'open', contract: c('4') }),
    slice({ id: 'x', state: 'closed', contract: c('5') }),
    slice({ id: 's', state: 'working', mode: 'sim', contract: c('6') }),
  ] }), keyOf);
  assert.deepEqual([...rows].sort(), ['dhan|1|MIS', 'dhan|2|MIS', 'dhan|3|MIS']);
});

test('rowsWithEntryInFlight: a pair leg sent / UNKNOWN / not yet sent while placing, and a roll\'s new strikes', () => {
  const leg = (id: string, entry?: 'sent' | 'filled' | 'unknown') => ({ contract: c(id), ...(entry ? { entry } : {}) });
  const pair = (over: Partial<LadderPair>) => ({ id: 'pp', broker: 'kotak', mode: 'real', structure: 'straddle', side: 'SELL', lots: 1, qty: 65, product: 'NRML',
    state: 'open', createdAt: 0, updatedAt: 0, legs: { ce: leg('a', 'filled'), pe: leg('b', 'filled') }, ...over }) as LadderPair;
  const rows = rowsWithEntryInFlight(st({ pairs: [
    pair({ id: 'p1', legs: { ce: leg('a', 'sent'), pe: leg('b', 'unknown') } }),
    pair({ id: 'p2', state: 'placing', legs: { ce: leg('c'), pe: leg('d', 'filled') } }),
    pair({ id: 'p3', state: 'rolling', rollTo: { ce: c('e'), steps: 1 } }),
    pair({ id: 'p4', mode: 'sim', legs: { ce: leg('f', 'sent'), pe: leg('g', 'sent') } }),
  ] }), keyOf);
  assert.deepEqual([...rows].sort(), ['kotak|a|NRML', 'kotak|b|NRML', 'kotak|c|NRML', 'kotak|e|NRML']);
});

test('rowsWithEntryInFlight: a basket leg in flight marks its row', () => {
  const b = { id: 'b1', strategy: 'x', name: 'X', broker: 'dhan', mode: 'real', side: 'SELL', lots: 1, product: 'MIS', state: 'placing', createdAt: 0, updatedAt: 0,
    legs: [{ key: 'l0', side: 'BUY', ratio: 1, contract: c('h'), entry: 'filled' }, { key: 'l1', side: 'SELL', ratio: 1, contract: c('s') }] } as LadderBasket;
  assert.deepEqual([...rowsWithEntryInFlight(st({ baskets: [b] }), keyOf)], ['dhan|s|MIS']);
});
