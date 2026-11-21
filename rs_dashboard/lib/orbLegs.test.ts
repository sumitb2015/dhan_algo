import test from 'node:test';
import assert from 'node:assert/strict';
import { enterLegs, exitLegs, outcomeOf, syntheticLegs, type LegDeps, type LegPlan, type Reply } from './orbLegs.ts';
import type { FnoRow } from './pnfContracts.ts';
import type { Target } from './pnfTarget.ts';

// Orb multi-leg orders with every broker call stubbed.

const U = 'CRUDEOILM';
const TODAY = '2026-11-20';
const NEXT = '2026-12-16';
const row = (expiry: string, strike: number, optType: 'CE' | 'PE' | null, id: string): FnoRow => ({
  exch: 'MCX', segment: 'MCX_COMM', securityId: id, instrument: optType ? 'OPTFUT' : 'FUTCOM', underlying: U,
  displayName: `${U} ${expiry} ${strike} ${optType ?? 'FUT'}`, expiry, strike: optType ? strike : -0.01, optType, lot: 1,
});
const FNO: FnoRow[] = [row('2026-12-17', 0, null, 'F1')];
for (const e of [TODAY, NEXT]) for (const k of [5900, 5950, 6000, 6050, 6100]) for (const s of ['CE', 'PE'] as const) FNO.push(row(e, k, s, `${e}-${k}-${s}`));

const opt = (strike: number, side: 'CE' | 'PE'): Target => ({ kind: 'options', symbol: U, name: U, expiry: NEXT, strike, side });
const placed = (id: string): Reply => ({ status: 200, body: { success: true, outcome: 'placed', legs: [{ status: 'placed', orderId: id }] } });
const refused = (msg = 'RMS: margin'): Reply => ({ status: 400, body: { success: false, outcome: 'rejected', message: msg } });
const unknown: Reply = { status: 504, body: { success: false, outcome: 'unknown', message: 'no reply' } };
const flat: Reply = { status: 200, body: { success: true, outcome: 'flat' } };

const plans: LegPlan[] = [
  { target: opt(6000, 'CE'), action: 'BUY', lots: 2, lotUnits: 1 },
  { target: opt(6000, 'PE'), action: 'SELL', lots: 2, lotUnits: 1 },
];

function stubs(opens: Reply[], closes: Reply[] = [], orders: (string | null)[] = ['TRADED']) {
  const log: string[] = [];
  let o = 0, c = 0, r = 0;
  const deps: LegDeps = {
    open: async p => { log.push(`open ${p.action} ${p.target.side}`); return opens[Math.min(o++, opens.length - 1)]; },
    close: async q => { log.push(`close ${q.action} ${q.target.side} ${q.units}`); return closes[Math.min(c++, closes.length - 1)] ?? placed('C'); },
    readOrder: async () => {
      const s = orders[Math.min(r++, orders.length - 1)];
      return s === null ? null : { orderStatus: s, filledQty: s === 'TRADED' ? 2 : 0, averageTradedPrice: s === 'TRADED' ? 101.5 : 0 };
    },
    sleep: async () => undefined,
  };
  return { deps, log };
}

test('syntheticLegs: LONG = buy CE + sell PE, SHORT = buy PE + sell CE, one strike and expiry, the bought leg first', () => {
  const l = syntheticLegs(U, 'LONG', 6010, TODAY, FNO);
  assert.ok(Array.isArray(l));
  const [a, b] = l as { target: Target; action: string }[];
  assert.deepEqual([a.action, a.target.side, b.action, b.target.side], ['BUY', 'CE', 'SELL', 'PE']);
  assert.equal(a.target.strike, 6000);
  assert.equal(a.target.strike, b.target.strike);
  assert.equal(a.target.expiry, b.target.expiry);
  assert.equal(a.target.expiry, NEXT);                       // never the option expiring today
  const s = syntheticLegs(U, 'SHORT', 6010, TODAY, FNO) as { target: Target; action: string }[];
  assert.deepEqual([s[0].action, s[0].target.side, s[1].action, s[1].target.side], ['BUY', 'PE', 'SELL', 'CE']);
  assert.equal(typeof syntheticLegs(U, 'LONG', 0, TODAY, FNO), 'string');   // no futures price
});

test('outcomeOf: placed / flat / refused / unknown (a 504 is never a refusal)', () => {
  assert.equal(outcomeOf(placed('A')).kind, 'placed');
  assert.equal(outcomeOf(flat).kind, 'flat');
  assert.equal(outcomeOf(refused()).kind, 'rejected');
  assert.equal(outcomeOf(unknown).kind, 'unknown');
  assert.equal(outcomeOf({ status: 504, body: { success: false } }).kind, 'unknown');
});

test('enterLegs: the bought leg goes first and is confirmed before the short', async () => {
  const { deps, log } = stubs([placed('B1'), placed('S1')]);
  const r = await enterLegs(plans, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['open BUY CE', 'open SELL PE']);
  assert.equal(r.legs[0].fillPrice, 101.5);
  assert.deepEqual(r.legs.map(x => x.state), ['open', 'open']);
});

test('enterLegs: a refused bought leg stops everything - the short is never sent', async () => {
  const { deps, log } = stubs([refused()]);
  const r = await enterLegs(plans, deps);
  assert.equal(r.ok, false);
  assert.equal(r.unknown, false);
  assert.deepEqual(log, ['open BUY CE']);
  assert.deepEqual(r.legs.map(x => x.state), ['rejected', 'skipped']);
});

test('enterLegs: the bought leg cancelled at the broker is a clean refusal; no fill status in time is UNKNOWN and the short is not sent', async () => {
  const a = stubs([placed('B1')], [], ['REJECTED']);
  const ra = await enterLegs(plans, a.deps);
  assert.equal(ra.ok, false); assert.equal(ra.unknown, false);
  assert.deepEqual(a.log, ['open BUY CE']);
  const b = stubs([placed('B1')], [], [null]);
  const rb = await enterLegs(plans, b.deps);
  assert.equal(rb.ok, false); assert.equal(rb.unknown, true);
  assert.deepEqual(b.log, ['open BUY CE']);                 // never a short against an unconfirmed hedge
  assert.equal(rb.legs[0].state, 'unknown');
});

test('enterLegs: a short refused after the bought leg filled reverses the bought leg', async () => {
  const { deps, log } = stubs([placed('B1'), refused('RMS: margin')]);
  const r = await enterLegs(plans, deps);
  assert.equal(r.ok, false);
  assert.equal(r.unknown, false);
  assert.deepEqual(log, ['open BUY CE', 'open SELL PE', 'close SELL CE 2']);
  assert.deepEqual(r.legs.map(x => x.state), ['reversed', 'rejected']);
});

test('enterLegs: a failed reversal is flagged unknown (a leg is open alone); an UNKNOWN short is never reversed', async () => {
  const bad = stubs([placed('B1'), refused()], [refused('exchange closed')]);
  const r1 = await enterLegs(plans, bad.deps);
  assert.equal(r1.unknown, true);
  assert.match(String(r1.error), /open alone/);
  const unk = stubs([placed('B1'), unknown]);
  const r2 = await enterLegs(plans, unk.deps);
  assert.equal(r2.unknown, true);
  assert.deepEqual(unk.log, ['open BUY CE', 'open SELL PE']);   // no close sent
});

test('enterLegs: two sold legs (no hedge): the second refused buys back the first; a throwing send is unknown', async () => {
  const sells: LegPlan[] = [{ target: opt(6000, 'CE'), action: 'SELL', lots: 1, lotUnits: 1 }, { target: opt(6000, 'PE'), action: 'SELL', lots: 1, lotUnits: 1 }];
  const a = stubs([placed('S1'), refused()]);
  const ra = await enterLegs(sells, a.deps);
  assert.deepEqual(a.log, ['open SELL CE', 'open SELL PE', 'close BUY CE 1']);
  assert.equal(ra.ok, false);
  const t: LegDeps = { ...a.deps, open: async () => { throw new Error('socket hang up'); } };
  const rt = await enterLegs(sells, t);
  assert.equal(rt.unknown, true);
});

test('exitLegs: the short is bought back first, then the long is sold; a long waits while a short is open', async () => {
  const legs = [{ target: opt(6000, 'CE'), action: 'BUY' as const, units: 2 }, { target: opt(6000, 'PE'), action: 'SELL' as const, units: 2 }];
  const a = stubs([], [placed('C1'), placed('C2')]);
  const ra = await exitLegs(legs, a.deps);
  assert.equal(ra.ok, true);
  assert.deepEqual(a.log, ['close BUY PE 2', 'close SELL CE 2']);
  const b = stubs([], [refused('busy')]);
  const rb = await exitLegs(legs, b.deps);
  assert.equal(rb.ok, false); assert.equal(rb.unknown, false);
  assert.deepEqual(b.log, ['close BUY PE 2']);               // the long CE is NOT sold while the short is open
  assert.deepEqual(rb.legs.map(x => [x.index, x.state]), [[1, 'open'], [0, 'open']]);
  const c = stubs([], [unknown]);
  const rc = await exitLegs(legs, c.deps);
  assert.equal(rc.unknown, true);
  assert.deepEqual(c.log, ['close BUY PE 2']);               // an unknown close is never resent, nothing else goes
  const d = stubs([], [flat, placed('C')]);
  const rd = await exitLegs(legs, d.deps);
  assert.equal(rd.ok, true);
  assert.equal(rd.legs[0].flat, true);
});

import { premiumLegs } from './orbLegs.ts';

test('premiumLegs: a straddle sells the ATM CE and PE; a strangle sells each side OTM (CE up, PE down); never today\'s expiry', () => {
  const s = premiumLegs('straddle', U, 0, 6010, TODAY, FNO) as { target: Target; action: string }[];
  assert.deepEqual(s.map(x => [x.action, x.target.side, x.target.strike]), [['SELL', 'CE', 6000], ['SELL', 'PE', 6000]]);
  assert.equal(s[0].target.expiry, NEXT);
  const g = premiumLegs('strangle', U, 1, 6010, TODAY, FNO) as { target: Target; action: string }[];
  assert.deepEqual(g.map(x => [x.target.side, x.target.strike]), [['CE', 6050], ['PE', 5950]]);
  assert.equal(typeof premiumLegs('strangle', U, 0, 6010, TODAY, FNO), 'string');
  assert.equal(typeof premiumLegs('strangle', U, 9, 6010, TODAY, FNO), 'string');     // outside the listed strikes
  assert.equal(typeof premiumLegs('straddle', U, 0, 0, TODAY, FNO), 'string');         // no futures price
});
