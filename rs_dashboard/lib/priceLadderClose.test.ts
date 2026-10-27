import test from 'node:test';
import assert from 'node:assert/strict';
import { planClose, isClosePct, CloseGuard, CLOSE_COOLDOWN_MS, synLegOwner } from './priceLadderClose.ts';

test('planClose: a short is closed with a BUY, a long with a SELL, 100% sends |net| verbatim', () => {
  assert.deepEqual(planClose(-195, 65, 100), { side: 'BUY', qty: 195 });
  assert.deepEqual(planClose(325, 65, 100), { side: 'SELL', qty: 325 });
  // a non-lot remainder stays fully closable
  assert.deepEqual(planClose(-100, 65, 100), { side: 'BUY', qty: 100 });
});

test('planClose: a share rounds down to whole lots and never reaches zero lots', () => {
  assert.deepEqual(planClose(-195, 65, 50), { side: 'BUY', qty: 65 });        // 3 lots x 50% = 1.5 -> 1
  assert.deepEqual(planClose(-325, 65, 25), { side: 'BUY', qty: 65 });        // 5 lots x 25% = 1.25 -> 1
  assert.equal(typeof planClose(-65, 65, 25), 'string');                      // 1 lot: 25% is under a lot
});

test('planClose: refuses a flat book, a bad share, and a partial with no lot size', () => {
  assert.match(planClose(0, 65, 100) as string, /flat/);
  assert.match(planClose(-130, 65, 30) as string, /pct must be/);
  assert.match(planClose(-130, null, 50) as string, /Lot size unknown/);
  assert.deepEqual(planClose(-130, null, 100), { side: 'BUY', qty: 130 });    // a full close needs no lot size
  assert.equal(isClosePct(75), true);
  assert.equal(isClosePct(60), false);
});

test('CloseGuard: one close per position at a time, then a cooldown while the book catches up', () => {
  const g = new CloseGuard();
  assert.equal(g.tryStart('k', 1000), true);
  assert.equal(g.tryStart('k', 1001), false);                                 // still running
  g.finish('k', 1500, true);
  assert.equal(g.tryStart('k', 1500 + CLOSE_COOLDOWN_MS - 1), false);         // just sent
  assert.equal(g.tryStart('k', 1500 + CLOSE_COOLDOWN_MS), true);
  g.finish('k', 20_000, false);                                               // nothing sent: no cooldown
  assert.equal(g.tryStart('k', 20_001), true);
  assert.equal(g.tryStart('other', 1000), true);
});

test('ladderExitInFlight: a REAL exit on the wire for the same contract blocks a manual close', async () => {
  const { ladderExitInFlight } = await import('./priceLadderClose.ts');
  const c = { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE' as const, securityId: '111', tradingSymbol: 'NIFTY26OCT23200CE', lotSize: 65, exchangeSegment: 'NSE_FNO' };
  const sl = (o: object) => ({ id: 'a', kind: 'xy', broker: 'dhan', mode: 'real', contract: c, side: 'SELL', lots: 1, qty: 65, product: 'NRML', state: 'open', createdAt: 1, updatedAt: 1, ...o });
  const st = (slices: object[], pairs: object[] = []) => ({ date: 'd', events: [], slices, pairs }) as never;
  assert.equal(ladderExitInFlight(st([sl({})]), 'dhan', '111'), null);                                   // plain open position
  assert.match(ladderExitInFlight(st([sl({ state: 'exiting' })]), 'dhan', '111')!, /already exiting 23200CE/);
  assert.match(ladderExitInFlight(st([sl({ exitWanted: 'Manual exit' })]), 'dhan', '111')!, /already exiting/);
  assert.equal(ladderExitInFlight(st([sl({ state: 'exiting' })]), 'dhan', '999'), null);                 // another contract
  assert.equal(ladderExitInFlight(st([sl({ state: 'exiting', mode: 'sim' })]), 'dhan', '111'), null);   // paper
  assert.equal(ladderExitInFlight(st([sl({ state: 'exiting' })]), 'kotak', 'NIFTY26OCT23200CE'), null); // another broker
  assert.match(ladderExitInFlight(st([sl({ state: 'exiting', broker: 'kotak' })]), 'kotak', 'NIFTY26OCT23200CE')!, /already exiting/);   // Kotak keys by trading symbol
  const leg = { contract: c, held: 65, exitOrderId: '77' };
  const pair = { id: 'p', broker: 'dhan', mode: 'real', state: 'open', legs: { ce: leg, pe: { contract: { ...c, securityId: '222', opt: 'PE' as const } } } };
  assert.match(ladderExitInFlight(st([], [pair]), 'dhan', '111')!, /leg of a pair/);
  assert.equal(ladderExitInFlight(st([], [pair]), 'dhan', '222'), null);
});

test('synLegOwner: a leg of a live REAL synthetic is refused; SIM, closed and other contracts are not', () => {
  const leg = (securityId: string, opt: 'CE' | 'PE', side: 'BUY' | 'SELL') => ({ key: securityId, side, ratio: 1, contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 22500, opt, securityId, lotSize: 65, exchangeSegment: 'NSE_FNO' } });
  const b = (o: object) => ({ id: 's', kind: 'syn', broker: 'dhan', mode: 'real', state: 'open', legs: [leg('111', 'CE', 'BUY'), leg('222', 'PE', 'SELL')], ...o });
  const st = (baskets: object[]) => ({ date: '2026-10-27', events: [], slices: [], baskets }) as never;
  assert.match(synLegOwner(st([b({})]), 'dhan', '222') ?? '', /one leg of a synthetic future/);
  assert.equal(synLegOwner(st([b({})]), 'dhan', '999'), null);
  assert.equal(synLegOwner(st([b({ mode: 'sim' })]), 'dhan', '222'), null);
  assert.equal(synLegOwner(st([b({ state: 'closed' })]), 'dhan', '222'), null);
  // UNKNOWN / BROKEN cannot be exited from the ladder, so the positions window stays usable to flatten what is left.
  assert.equal(synLegOwner(st([b({ state: 'unknown' })]), 'dhan', '222'), null);
  assert.equal(synLegOwner(st([b({ state: 'broken' })]), 'dhan', '222'), null);
  assert.match(synLegOwner(st([b({ state: 'exiting' })]), 'dhan', '222') ?? '', /synthetic/);
  assert.match(synLegOwner(st([b({ state: 'placing' })]), 'dhan', '222') ?? '', /synthetic/);
  assert.equal(synLegOwner(st([b({ kind: undefined })]), 'dhan', '222'), null);      // an ordinary basket is the ladder's exit-in-flight rule's business
  assert.equal(synLegOwner(st([b({})]), 'kotak', '222'), null);
});
