import test from 'node:test';
import assert from 'node:assert/strict';
import { rollDay, type LadderState } from './priceLadder.ts';
import { planPairs, pairEntryFills, pairCombined, pairNowPnl, sumPairPnl, pairLevelSane, type LadderPair } from './priceLadderPair.ts';

const leg = (opt: 'CE' | 'PE', securityId: string, over: Record<string, unknown> = {}) => ({
  contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt, securityId, lotSize: 65, exchangeSegment: 'NSE_FNO', ...over },
});
const pair = (over: Partial<LadderPair> = {}): LadderPair => ({
  id: 'p1', broker: 'dhan', mode: 'sim', structure: 'straddle', side: 'SELL', lots: 1, qty: 65, product: 'MIS',
  state: 'armed', legs: { ce: leg('CE', '1'), pe: leg('PE', '2') }, createdAt: 0, updatedAt: 0,
  entryLevel: 300, entryDir: 'above', seenSafe: true, ...over,
});
const st = (p: LadderPair): LadderState => ({ date: '2026-10-22', slices: [], events: [], pairs: [p] });
// 2026-10-22 (Thursday) at hh:mm IST.
const at = (hh: number, mm: number) => Date.UTC(2026, 9, 22, hh, mm) - 330 * 60_000;
const one = (s: LadderState) => s.pairs![0];

test('pairCombined: both legs priced, else null', () => {
  assert.equal(pairCombined(pair(), { 1: 150.1, 2: 149.95 }), 300.05);
  assert.equal(pairCombined(pair(), { 1: 150 }), null);
});

test('pairLevelSane: within half the combined premium', () => {
  assert.ok(pairLevelSane(400, 300));
  assert.ok(!pairLevelSane(500, 300));
  assert.ok(!pairLevelSane(300, 0));
});

test('armed sell above (limit-like): fires on the cross and fills at the LEVEL, split by the legs\' prices', () => {
  const p = pair({ bracket: { tgtPts: 20, slPts: 15 } });
  const s1 = planPairs(st(p), { 1: 149, 2: 150 }, at(10, 0));
  assert.equal(one(s1).state, 'armed');
  const s2 = planPairs(s1, { 1: 151, 2: 150 }, at(10, 1));
  const o = one(s2);
  assert.equal(o.state, 'open');
  // Combined jumped to 301 in one tick: a resting limit at 300 books 300, not the better 301.
  assert.equal(o.legs.ce.avg, 150.5);
  assert.equal(o.legs.pe.avg, 149.5);
  assert.equal(o.entryY, 300);
  // Short: target below, SL above the combined fill.
  assert.equal(o.tgtY, 280);
  assert.equal(o.slY, 315);
  // Every stamp is the tick's own clock.
  assert.equal(o.updatedAt, at(10, 1));
  assert.equal(s2.events.at(-1)!.at, at(10, 1));
});

test('armed sell below (breakout): fills at market — the legs\' live prices', () => {
  const p = pair({ entryLevel: 300, entryDir: 'below', orderType: 'SL' });
  const o = one(planPairs(st(p), { 1: 148, 2: 149 }, at(10, 0)));
  assert.equal(o.state, 'open');
  assert.equal(o.legs.ce.avg, 148);
  assert.equal(o.legs.pe.avg, 149);
  assert.equal(o.entryY, 297);
});

test('pairEntryFills: limit-like split keeps both legs positive, else market', () => {
  assert.deepEqual(pairEntryFills({ side: 'BUY', entryLevel: 200, entryDir: 'below' }, 99, 99), { ce: 100, pe: 100 });
  assert.deepEqual(pairEntryFills({ side: 'BUY', entryLevel: 200, entryDir: 'above' }, 101, 101), { ce: 101, pe: 101 });
});

test('armed: a missing leg price never fires', () => {
  const s = planPairs(st(pair()), { 1: 400 }, at(10, 0));
  assert.equal(one(s).state, 'armed');
});

test('armed: before the open the cross is not fired; at auto-exit it is cancelled; REAL is cancelled', () => {
  assert.equal(one(planPairs(st(pair()), { 1: 160, 2: 160 }, at(9, 10))).state, 'armed');
  assert.equal(one(planPairs(st(pair()), { 1: 160, 2: 160 }, at(15, 17))).state, 'cancelled');
  assert.equal(one(planPairs(st(pair({ mode: 'real' })), { 1: 160, 2: 160 }, at(10, 0))).state, 'cancelled');
});

test('armed: learns the safe side first when armed on the wrong side', () => {
  const p = pair({ seenSafe: false });
  const s1 = planPairs(st(p), { 1: 160, 2: 160 }, at(10, 0));      // already above: not a cross
  assert.equal(one(s1).state, 'armed');
  const s2 = planPairs(s1, { 1: 140, 2: 150 }, at(10, 1));         // back below: safe
  assert.equal(one(s2).seenSafe, true);
  assert.equal(one(planPairs(s2, { 1: 155, 2: 150 }, at(10, 2))).state, 'open');
});

const openShort = (over: Partial<LadderPair> = {}) => pair({
  state: 'open', entryY: 300, tgtY: 280, slY: 315, slY0: 315, peakY: 300, trailFrom: 300, openedAt: 1,
  bracket: { tgtPts: 20, slPts: 15 },
  legs: { ce: { ...leg('CE', '1'), avg: 150 }, pe: { ...leg('PE', '2'), avg: 150 } }, ...over,
});

test('open short: SL hit when the combined rises to slY, exits both legs at their LTPs', () => {
  const s = planPairs(st(openShort()), { 1: 160, 2: 156 }, at(10, 0));
  const o = one(s);
  assert.equal(o.state, 'closed');
  assert.equal(o.legs.ce.exitAvg, 160);
  assert.equal(o.legs.pe.exitAvg, 156);
  assert.match(o.exitReason!, /^SL 315/);
  assert.equal(pairNowPnl(o, {}), (150 - 160) * 65 + (150 - 156) * 65);
});

test('open short: target hit when the combined falls to tgtY', () => {
  const o = one(planPairs(st(openShort()), { 1: 140, 2: 139 }, at(10, 0)));
  assert.equal(o.state, 'closed');
  assert.match(o.exitReason!, /^Target 280/);
});

test('open short: continuous trail moves the SL down with the best (lowest) combined, never back up', () => {
  const p = openShort({ bracket: { tgtPts: 0, slPts: 15, trailPts: 10, trailMode: 'distance' }, tgtY: undefined });
  const s1 = planPairs(st(p), { 1: 135, 2: 135 }, at(10, 0));      // combined 270 -> SL 280
  assert.equal(one(s1).slY, 280);
  const s2 = planPairs(s1, { 1: 137, 2: 137 }, at(10, 1));         // 274: SL stays
  assert.equal(one(s2).slY, 280);
  assert.equal(one(s2).state, 'open');
  const s3 = planPairs(s2, { 1: 140, 2: 141 }, at(10, 2));         // 281 >= 280: trailing SL hit
  assert.equal(one(s3).state, 'closed');
  assert.match(one(s3).exitReason!, /^Trailing SL 280/);
});

test('open: an exit due with a leg unpriced waits (said once)', () => {
  const s1 = planPairs(st(openShort({ exitWanted: 'Manual exit' })), { 1: 150 }, at(10, 0));
  assert.equal(one(s1).state, 'open');
  assert.equal(s1.events.length, 1);
  const s2 = planPairs(s1, { 1: 150 }, at(10, 1));
  assert.equal(s2.events.length, 1);
  assert.equal(one(planPairs(s2, { 1: 150, 2: 151 }, at(10, 2))).state, 'closed');
});

test('open: outside the session the bracket does not run and an exit waits for the open', () => {
  // A carried NRML pair at 09:05: an SL-level print is not acted on, and the trail does not move.
  const p = openShort({ product: 'NRML', bracket: { tgtPts: 0, slPts: 15, trailPts: 10, trailMode: 'distance' }, tgtY: undefined });
  const pre = planPairs(st(p), { 1: 160, 2: 160 }, at(9, 5));
  assert.equal(one(pre).state, 'open');
  assert.equal(one(pre).slY, 315);
  const low = planPairs(st(p), { 1: 100, 2: 100 }, at(16, 0));
  assert.equal(one(low).slY, 315);
  // A manual exit after the close waits (said once), and goes at the open.
  const w = planPairs(st(openShort({ product: 'NRML', exitWanted: 'Manual exit' })), { 1: 150, 2: 150 }, at(16, 0));
  assert.equal(one(w).state, 'open');
  assert.equal(w.events.length, 1);
  assert.equal(planPairs(w, { 1: 150, 2: 150 }, at(16, 1)).events.length, 1);
  assert.equal(one(planPairs(w, { 1: 150, 2: 150 }, at(9, 16))).state, 'closed');
});

test('open: past its expiry the pair is closed without a price (not counted), never stuck open', () => {
  const p = openShort({ product: 'NRML', legs: { ce: { ...leg('CE', '1', { expiry: '2026-10-20' }), avg: 150 }, pe: { ...leg('PE', '2', { expiry: '2026-10-20' }), avg: 150 } } });
  const o = one(planPairs(st(p), {}, at(10, 0)));
  assert.equal(o.state, 'closed');
  assert.equal(o.exitReason, 'Expired');
  assert.equal(pairNowPnl(o, {}), undefined);
});

test('open: MIS squared off at 15:17, NRML carried', () => {
  assert.equal(one(planPairs(st(openShort()), { 1: 150, 2: 150 }, at(15, 17))).state, 'closed');
  assert.equal(one(planPairs(st(openShort({ product: 'NRML' })), { 1: 150, 2: 150 }, at(15, 17))).state, 'open');
});

test('pairNowPnl: CRUDEOILM multiplies by barrels per lot; an unpriced open leg is null', () => {
  const mcx = { underlying: 'CRUDEOILM', lotSize: 1, mult: 10, exchangeSegment: 'MCX_COMM' };
  const p = openShort({ qty: 2, legs: { ce: { ...leg('CE', '1', mcx), avg: 100 }, pe: { ...leg('PE', '2', mcx), avg: 90 } } });
  assert.equal(pairNowPnl(p, { 1: 95, 2: 85 }), (5 + 5) * 2 * 10);
  assert.equal(pairNowPnl(p, { 1: 95 }), null);
  assert.equal(pairNowPnl(pair(), {}), undefined);
  assert.equal(sumPairPnl([p, pair()], () => true, { 1: 95, 2: 85 }), 200);
});

test('rollDay: armed and finished pairs go, open ones are carried', () => {
  const s: LadderState = { date: '2026-10-21', slices: [], events: [], pairs: [pair({ id: 'a' }), openShort({ id: 'b', product: 'NRML' }), pair({ id: 'c', state: 'closed' })] };
  const r = rollDay(s, '2026-10-22', at(9, 0));
  assert.deepEqual(r.pairs!.map(p => p.id), ['b']);
});
