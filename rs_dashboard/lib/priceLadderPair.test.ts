import test from 'node:test';
import assert from 'node:assert/strict';
import { rollDay, type LadderState } from './priceLadder.ts';
import { planPairs as planPairsTick, joinedGroup, legSlReason, blendExitAvg, cleanLegSlPct, legSlPrice, splitOneLot, pairEntryVerdict, settleLegEntry, settleLegExit, cutsNewestFirst, cutPairLeg, lotsOnContract, pairEntryFills, pairCombined, pairNowPnl, sumPairPnl, pairLevelSane, type LadderPair } from './priceLadderPair.ts';

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
const planPairs = (s: LadderState, ltps: Record<string, number>, now: number) => planPairsTick(s, ltps, now).next;

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

// ── REAL pairs (Phase 2) ──
const realSt = (p: LadderPair): LadderState => ({ date: '2026-10-22', slices: [], events: [], pairs: [p], liveArmedOn: '2026-10-22' });
const io = (over: Partial<{ polled: number; busy: boolean }> = {}) => ({ polledAt: () => over.polled ?? 0, busy: () => over.busy ?? false });

test('REAL armed: a cross marks placing (both legs sent by a job), nothing filled here; LIVE arm off cancels', () => {
  const p = pair({ mode: 'real' });
  const r = planPairsTick(realSt(p), { 1: 151, 2: 150 }, at(10, 0), io());
  assert.equal(one(r.next).state, 'placing');
  assert.equal(one(r.next).crossY, 301);
  assert.equal(one(r.next).legs.ce.avg, undefined);
  assert.deepEqual(r.jobs, [{ kind: 'pairOpen', id: 'p1' }]);
  const off = planPairsTick({ ...realSt(p), liveArmedOn: undefined }, { 1: 151, 2: 150 }, at(10, 0), io());
  assert.equal(one(off.next).state, 'cancelled');
  assert.equal(off.jobs.length, 0);
});

const placing = (ce: Partial<LadderPair['legs']['ce']>, pe: Partial<LadderPair['legs']['pe']>, over: Partial<LadderPair> = {}) => pair({
  mode: 'real', state: 'placing', sentAt: at(10, 0), crossY: 300, bracket: { tgtPts: 20, slPts: 15 },
  legs: { ce: { ...leg('CE', '1'), ...ce }, pe: { ...leg('PE', '2'), ...pe } }, ...over,
});

test('pairEntryVerdict: unknown wins, then wait, then open (both in full), else unwind', () => {
  assert.equal(pairEntryVerdict(placing({ entry: 'unknown' }, { entry: 'dead' })), 'unknown');
  assert.equal(pairEntryVerdict(placing({ entry: 'filled', filledQty: 65 }, { entry: 'sent' })), 'wait');
  assert.equal(pairEntryVerdict(placing({ entry: 'filled', filledQty: 65 }, { entry: 'filled', filledQty: 65 })), 'open');
  assert.equal(pairEntryVerdict(placing({ entry: 'filled', filledQty: 65 }, { entry: 'dead' })), 'unwind');
  assert.equal(pairEntryVerdict(placing({ entry: 'filled', filledQty: 65 }, { entry: 'filled', filledQty: 30 })), 'unwind');
});

test('REAL placing: both filled → open at the traded prices, bracket from that combined', () => {
  const r = planPairsTick(realSt(placing({ entry: 'filled', filledQty: 65, avg: 152 }, { entry: 'filled', filledQty: 65, avg: 150.5 })), {}, at(10, 1), io());
  const o = one(r.next);
  assert.equal(o.state, 'open');
  assert.equal(o.entryY, 302.5);
  assert.equal(o.legs.ce.held, 65);
  assert.equal(o.tgtY, 282.5);
  assert.equal(o.slY, 317.5);
});

test('REAL placing: one leg rejected → unwind the filled leg at once (exiting + pairClose); none filled → cancelled', () => {
  const r = planPairsTick(realSt(placing({ entry: 'filled', filledQty: 65, avg: 152 }, { entry: 'dead', note: 'margin' })), {}, at(10, 1), io());
  const o = one(r.next);
  assert.equal(o.state, 'exiting');
  assert.equal(o.exitReason, 'Entry failed — unwinding');
  assert.equal(o.legs.ce.held, 65);
  assert.equal(o.legs.ce.exitSentAt, at(10, 1));
  assert.equal(o.legs.pe.held, 0);
  assert.deepEqual(r.jobs, [{ kind: 'pairClose', id: 'p1' }]);
  const none = planPairsTick(realSt(placing({ entry: 'dead' }, { entry: 'dead' })), {}, at(10, 1), io());
  assert.equal(one(none.next).state, 'cancelled');
  assert.equal(none.jobs.length, 0);
});

test('REAL placing: an unknown leg → UNKNOWN, nothing reversed; working orders are polled; an orphan send → UNKNOWN', () => {
  const u = planPairsTick(realSt(placing({ entry: 'filled', filledQty: 65 }, { entry: 'unknown', unknown: 'entry' })), {}, at(10, 1), io());
  assert.equal(one(u.next).state, 'unknown');
  assert.equal(u.jobs.length, 0);
  const w = planPairsTick(realSt(placing({ entry: 'sent', orderId: 'a' }, { entry: 'sent', orderId: 'b' })), {}, at(10, 1), io());
  assert.deepEqual(w.jobs, [{ kind: 'pairSettle', id: 'p1' }]);
  assert.equal(planPairsTick(realSt(placing({ entry: 'sent', orderId: 'a' }, { entry: 'sent', orderId: 'b' })), {}, at(10, 1), io({ polled: Infinity })).jobs.length, 0);
  const orphan = planPairsTick(realSt(placing({}, {})), {}, at(10, 1), io());
  assert.equal(one(orphan.next).state, 'unknown');
  assert.equal(one(planPairsTick(realSt(placing({}, {})), {}, at(10, 1), io({ busy: true })).next).state, 'placing');
});

test('settleLegEntry / settleLegExit: fills, rejections, partial exits, timeouts', () => {
  const l = { ...leg('CE', '1'), orderId: 'a', entry: 'sent' as const };
  assert.deepEqual(settleLegEntry(l, { kind: 'filled', filledQty: 65, avg: 120 }, 0, 1000).entry, 'filled');
  assert.equal(settleLegEntry(l, { kind: 'dead', reason: 'REJECTED' }, 0, 1000).entry, 'dead');
  assert.equal(settleLegEntry(l, null, 0, 61_000).unknown, 'entry');
  assert.equal(settleLegEntry(l, { kind: 'wait', filledQty: 0 }, 0, 1000).entry, 'sent');
  const x = { ...leg('CE', '1'), held: 65, exitOrderId: 'e', exitQty: 65, exitSentAt: 0 };
  const part = settleLegExit(x, { kind: 'filled', filledQty: 30, avg: 100 }, 1000);
  assert.equal(part.held, 35);
  assert.equal(part.exitedQty, 30);
  assert.equal(part.exitAvg, 100);
  assert.equal(part.exitOrderId, undefined);
  assert.equal(part.exitRetryAt, 1000 + 15_000);
  const all = settleLegExit({ ...part, exitOrderId: 'f', exitQty: 35 }, { kind: 'filled', filledQty: 35, avg: 110 }, 2000);
  assert.equal(all.held, 0);
  assert.equal(all.exitAvg, Number(((100 * 30 + 110 * 35) / 65).toFixed(2)));
  const dead = settleLegExit(x, { kind: 'dead', reason: 'REJECTED' }, 1000);
  assert.equal(dead.held, 65);
  assert.equal(dead.exitRetryAt, 16_000);
  assert.equal(settleLegExit(x, null, 61_000).unknown, 'exit');
});

const openReal = (over: Partial<LadderPair> = {}) => openShort({
  mode: 'real', legs: { ce: { ...leg('CE', '1'), avg: 150, held: 65, filledQty: 65, entry: 'filled' }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } }, ...over,
});

test('REAL open: an SL hit marks exiting and both legs for sending; outside the session it is held', () => {
  const r = planPairsTick(realSt(openReal()), { 1: 160, 2: 156 }, at(10, 0), io());
  const o = one(r.next);
  assert.equal(o.state, 'exiting');
  assert.match(o.exitReason!, /^SL 315/);
  assert.ok(o.legs.ce.exitSentAt && o.legs.pe.exitSentAt);
  assert.deepEqual(r.jobs, [{ kind: 'pairClose', id: 'p1' }]);
  const h = planPairsTick(realSt(openReal({ exitWanted: 'Manual exit' })), { 1: 150, 2: 150 }, at(16, 0), io());
  assert.equal(one(h.next).state, 'open');
  assert.equal(h.jobs.length, 0);
});

test('REAL exiting: a rejected leg is sent again after its wait; both flat → closed', () => {
  const ex = (ce: Partial<LadderPair['legs']['ce']>, pe: Partial<LadderPair['legs']['pe']>) => openReal({
    state: 'exiting', exitReason: 'SL 315',
    legs: { ce: { ...leg('CE', '1'), avg: 150, ...ce }, pe: { ...leg('PE', '2'), avg: 150, ...pe } },
  });
  const wait = planPairsTick(realSt(ex({ held: 65, exitRetryAt: at(10, 1) }, { held: 0, exitedQty: 65, exitAvg: 151 })), {}, at(10, 0), io());
  assert.equal(wait.jobs.length, 0);
  const again = planPairsTick(realSt(ex({ held: 65, exitRetryAt: at(10, 0) }, { held: 0, exitedQty: 65, exitAvg: 151 })), {}, at(10, 1), io());
  assert.deepEqual(again.jobs, [{ kind: 'pairClose', id: 'p1' }]);
  assert.ok(one(again.next).legs.ce.exitSentAt);
  const done = planPairsTick(realSt(ex({ held: 0, exitedQty: 65, exitAvg: 149 }, { held: 0, exitedQty: 65, exitAvg: 151 })), {}, at(10, 1), io());
  assert.equal(one(done.next).state, 'closed');
  assert.equal(pairNowPnl(one(done.next), {}), (150 - 149) * 65 + (150 - 151) * 65);
});

test('REAL broken: the bracket is off, a manual exit sends only what is left', () => {
  const p = openReal({ state: 'broken', legs: { ce: { ...leg('CE', '1'), avg: 150, held: 0, exitedQty: 65, exitAvg: 140, outside: true }, pe: { ...leg('PE', '2'), avg: 150, held: 65 } } });
  assert.equal(one(planPairsTick(realSt(p), { 1: 200, 2: 200 }, at(10, 0), io()).next).state, 'broken');
  const r = planPairsTick(realSt({ ...p, exitWanted: 'Manual exit' }), { 1: 150, 2: 150 }, at(10, 0), io());
  assert.equal(one(r.next).state, 'exiting');
  assert.equal(one(r.next).legs.ce.exitSentAt, undefined);
  assert.ok(one(r.next).legs.pe.exitSentAt);
});

test('cutsNewestFirst / cutPairLeg: down-only, newest first; a cut leg breaks the pair, both gone closes it', () => {
  const cuts = cutsNewestFirst([{ id: 'old', qty: 65, openedAt: 1 }, { id: 'new', qty: 65, openedAt: 2 }], 65);
  assert.deepEqual([...cuts], [['new', 65]]);
  assert.equal(cutsNewestFirst([{ id: 'a', qty: 65, openedAt: 1 }], 130).size, 0);
  const p = openReal();
  const b = cutPairLeg(p, 'ce', 65, 140, 5);
  assert.equal(b.state, 'broken');
  assert.equal(b.legs!.ce.held, 0);
  assert.equal(b.legs!.ce.outside, true);
  const c = cutPairLeg({ ...p, ...b } as LadderPair, 'pe', 65, 160, 6);
  assert.equal(c.state, 'closed');
});

test('lotsOnContract: slices and pair legs share one cap per contract', () => {
  const st: LadderState = { date: '2026-10-22', events: [], pairs: [openReal({ lots: 3 })], slices: [
    { id: 's', kind: 'xy', broker: 'dhan', mode: 'real', contract: leg('CE', '1').contract, side: 'SELL', lots: 2, qty: 130, product: 'MIS', state: 'open', createdAt: 0, updatedAt: 0 },
  ] };
  assert.equal(lotsOnContract(st, '1', 'dhan', 'real', 'SELL'), 5);
  assert.equal(lotsOnContract(st, '2', 'dhan', 'real', 'SELL'), 3);
  assert.equal(lotsOnContract(st, '1', 'dhan', 'sim', 'SELL'), 0);
});

test('rollDay: a REAL pair caught mid-entry becomes UNKNOWN on the next day', () => {
  const s: LadderState = { date: '2026-10-21', slices: [], events: [], pairs: [placing({ entry: 'sent', orderId: 'a' }, { entry: 'filled', filledQty: 65 })] };
  const r = rollDay(s, '2026-10-22', at(9, 0));
  assert.equal(r.pairs![0].state, 'unknown');
  assert.equal(r.pairs![0].legs.ce.unknown, 'entry');
  assert.equal(r.pairs![0].legs.pe.unknown, undefined);
});

// ── review fixes (Phase 2) ──
test('unwind: starts inside the fill grace (openedAt = now) so its exit is not sized off a book without the fill', () => {
  const r = planPairsTick(realSt(placing({ entry: 'filled', filledQty: 65, avg: 152 }, { entry: 'dead' })), {}, at(10, 1), io());
  assert.equal(one(r.next).openedAt, at(10, 1));
});

test('open verdict: a fill with no average takes the live LTP; with neither the pair waits (no NaN bracket)', () => {
  const p = placing({ entry: 'filled', filledQty: 65 }, { entry: 'filled', filledQty: 65, avg: 150 });
  const wait = planPairsTick(realSt(p), {}, at(10, 1), io());
  assert.equal(one(wait.next).state, 'placing');
  assert.match(one(wait.next).note!, /waiting for a price/);
  const o = one(planPairsTick(realSt(p), { 1: 151 }, at(10, 1), io()).next);
  assert.equal(o.state, 'open');
  assert.equal(o.entryY, 301);
  assert.ok(Number.isFinite(o.slY!));
});

test('a filled leg counts in P&L while the other is in doubt (placing / unknown)', () => {
  const p = placing({ entry: 'filled', filledQty: 65, avg: 150 }, { entry: 'unknown', unknown: 'entry' }, { state: 'unknown' });
  assert.equal(pairNowPnl(p, { 1: 160 }), (150 - 160) * 65);
});

test('blendExitAvg: weighted; no price books at the entry average, never blanks P&L', () => {
  assert.equal(blendExitAvg({ ...leg('CE', '1'), avg: 100, exitedQty: 30, exitAvg: 90 }, 30, 110), 100);
  assert.equal(blendExitAvg({ ...leg('CE', '1'), avg: 100 }, 65, undefined), 100);
  const cut = cutPairLeg(openReal(), 'ce', 65, undefined, 5);
  assert.equal(cut.legs!.ce.exitAvg, 150);
  assert.notEqual(pairNowPnl({ ...openReal(), ...cut } as LadderPair, { 2: 150 }), null);
});

test('exiting past expiry: closed (settled at the broker), not retried forever', () => {
  const p = openReal({
    state: 'exiting', exitReason: 'SL 315',
    legs: { ce: { ...leg('CE', '1', { expiry: '2026-10-20' }), avg: 150, held: 65, exitRetryAt: 0 }, pe: { ...leg('PE', '2', { expiry: '2026-10-20' }), avg: 150, held: 0 } },
  });
  const r = planPairsTick(realSt(p), {}, at(10, 0), io());
  assert.equal(one(r.next).state, 'closed');
  assert.equal(one(r.next).exitReason, 'Expired');
  assert.equal(r.jobs.length, 0);
});

// ── per-leg SL and +/- lot ──
test('cleanLegSlPct: a short leg may rise 1-1000 %, a long one fall 1-99 %', () => {
  assert.equal(cleanLegSlPct(100, 'SELL'), 100);
  assert.equal(cleanLegSlPct(100, 'BUY'), null);
  assert.equal(cleanLegSlPct(50, 'BUY'), 50);
  assert.equal(cleanLegSlPct(0, 'SELL'), null);
});

test('leg SL (SIM short): a leg reaching its own stop exits BOTH legs, even with the combined inside its bracket', () => {
  const p = openShort({ legSlPct: 50, bracket: { tgtPts: 100, slPts: 100 }, tgtY: 200, slY: 400 });
  assert.equal(legSlPrice(p, p.legs.ce), 225);
  // CE 230 (> 225) while PE fell: combined 330 is inside 200..400.
  const o = one(planPairs(st(p), { 1: 230, 2: 100 }, at(10, 0)));
  assert.equal(o.state, 'closed');
  assert.equal(o.exitReason, 'Leg SL CE 225.00');
  assert.equal(o.legs.pe.exitAvg, 100);
  assert.equal(one(planPairs(st(p), { 1: 220, 2: 100 }, at(10, 0))).state, 'open');
  // A leg with no price is not judged.
  assert.equal(one(planPairs(st(p), { 2: 100 }, at(10, 0))).state, 'open');
});

test('leg SL (REAL long): a leg falling to its stop marks both legs for exit; a broken pair does not use it', () => {
  const p = openReal({ side: 'BUY', legSlPct: 40, bracket: undefined, tgtY: undefined, slY: undefined });
  const r = planPairsTick(realSt(p), { 1: 89, 2: 160 }, at(10, 0), io());
  assert.equal(one(r.next).state, 'exiting');
  assert.equal(one(r.next).exitReason, 'Leg SL CE 90.00');
  assert.deepEqual(r.jobs, [{ kind: 'pairClose', id: 'p1' }]);
  assert.equal(one(planPairsTick(realSt({ ...p, state: 'broken' }), { 1: 50, 2: 160 }, at(10, 0), io()).next).state, 'broken');
});

test('splitOneLot: one lot split off to exit, the rest keeps its levels; a one-lot pair just exits', () => {
  const p = openReal({ lots: 3, qty: 195, legs: { ce: { ...leg('CE', '1'), avg: 150, held: 195, filledQty: 195 }, pe: { ...leg('PE', '2'), avg: 150, held: 195, filledQty: 195 } } });
  const sp = splitOneLot(p, 'c1', 7);
  assert.ok(typeof sp !== 'string');
  if (typeof sp === 'string') return;
  assert.equal(sp.parent.lots, 2);
  assert.equal(sp.parent.legs!.ce.held, 130);
  assert.equal(sp.child!.lots, 1);
  assert.equal(sp.child!.legs.pe.held, 65);
  assert.equal(sp.child!.legs.pe.avg, 150);
  assert.equal(sp.child!.exitWanted, 'Manual exit (−1 lot)');
  assert.equal(sp.child!.slY, p.slY);
  const one1 = splitOneLot(openReal(), 'c2', 7);
  assert.ok(typeof one1 !== 'string' && one1.child === null && one1.parent.exitWanted);
  assert.equal(typeof splitOneLot(openReal({ state: 'broken' }), 'c3', 7), 'string');
});

test('REAL +1 lot: sendWanted is dispatched (marked + pairOpen) in session; on fill it keeps the joined levels', () => {
  const child = placing({}, {}, { sendWanted: true, sentAt: undefined, joinedTo: 'p0', entryY: 300, tgtY: 280, slY: 310, slY0: 315, peakY: 295 });
  const r = planPairsTick(realSt(child), {}, at(10, 0), io());
  assert.deepEqual(r.jobs, [{ kind: 'pairOpen', id: 'p1' }]);
  assert.equal(one(r.next).sendWanted, undefined);
  assert.equal(one(r.next).sentAt, at(10, 0));
  const closed = planPairsTick(realSt(child), {}, at(16, 0), io());
  assert.equal(one(closed.next).state, 'cancelled');
  const filled = placing({ entry: 'filled', filledQty: 65, avg: 160 }, { entry: 'filled', filledQty: 65, avg: 150 }, { joinedTo: 'p0', entryY: 300, tgtY: 280, slY: 310, slY0: 315, peakY: 295 });
  const o = one(planPairsTick(realSt(filled), {}, at(10, 1), io()).next);
  assert.equal(o.state, 'open');
  assert.equal(o.slY, 310);
  assert.equal(o.tgtY, 280);
  assert.equal(o.entryY, 300);
});

// ── shift / roll ──
const c9450 = { ...leg('CE', '3').contract, strike: 23300 };
const p9450 = { ...leg('PE', '4').contract, strike: 23300 };

test('SIM shift: closes both old legs, then opens the new strikes, then re-measures the bracket; booked P&L kept', () => {
  const p = openShort({ state: 'rolling', rollTo: { ce: c9450, pe: p9450, steps: 2 },
    legs: { ce: { ...leg('CE', '1'), avg: 150, held: 65, filledQty: 65, entry: 'filled' }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } } });
  const ltps = { 1: 140, 2: 165, 3: 120, 4: 190 };
  const s1 = planPairs(st(p), ltps, at(10, 0));                       // old legs closed
  assert.equal(one(s1).legs.ce.held, 0);
  assert.equal(one(s1).legs.ce.exitAvg, 140);
  const s2 = planPairs(s1, ltps, at(10, 1));                          // new contracts in place, P&L booked
  assert.equal(one(s2).legs.ce.contract.securityId, '3');
  assert.equal(one(s2).bookedPnl, (150 - 140) * 65 + (150 - 165) * 65);
  const s3 = planPairs(s2, ltps, at(10, 2));                          // SIM fill of the new legs
  assert.equal(one(s3).legs.pe.avg, 190);
  const o = one(planPairs(s3, ltps, at(10, 3)));                      // verdict: open on the new combined
  assert.equal(o.state, 'open');
  assert.equal(o.entryY, 310);
  assert.equal(o.slY, 325);
  assert.equal(o.tgtY, 290);
  assert.equal(o.rollTo, undefined);
  assert.equal(pairNowPnl(o, ltps), (150 - 140) * 65 + (150 - 165) * 65);
});

test('REAL roll of one leg: closes it (job), then opens the new strike (job); the kept leg is not touched', () => {
  const base = openReal({ state: 'rolling', rollTo: { ce: c9450, steps: 2 } });
  const r1 = planPairsTick(realSt(base), { 1: 170, 2: 120 }, at(10, 0), io());
  assert.deepEqual(r1.jobs, [{ kind: 'pairClose', id: 'p1' }]);
  assert.ok(one(r1.next).legs.ce.exitSentAt);
  assert.equal(one(r1.next).legs.pe.exitSentAt, undefined);
  // Old CE exited at 170 (a 20-point loss on the short).
  const flat = openReal({ state: 'rolling', rollTo: { ce: c9450, steps: 2 },
    legs: { ce: { ...leg('CE', '1'), avg: 150, held: 0, exitedQty: 65, exitAvg: 170, entry: 'filled', filledQty: 65 }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } } });
  const r2 = planPairsTick(realSt(flat), {}, at(10, 1), io());
  assert.deepEqual(r2.jobs, [{ kind: 'pairOpen', id: 'p1' }]);
  assert.equal(one(r2.next).legs.ce.contract.securityId, '3');
  assert.equal(one(r2.next).legs.ce.entry, undefined);
  assert.equal(one(r2.next).legs.pe.held, 65);
  assert.equal(one(r2.next).bookedPnl, -20 * 65);
  // New CE filled → open, the structure becomes a strangle, bracket from the new combined.
  const filled = { ...one(r2.next), legs: { ...one(r2.next).legs, ce: { ...one(r2.next).legs.ce, orderId: 'n', entry: 'filled' as const, filledQty: 65, avg: 110 } } };
  const o = one(planPairsTick(realSt(filled), {}, at(10, 2), io()).next);
  assert.equal(o.state, 'open');
  assert.equal(o.structure, 'strangle');
  assert.equal(o.entryY, 260);
  assert.equal(o.legs.ce.held, 65);
});

test('REAL roll: the new leg rejected → the kept leg is unwound (never left alone)', () => {
  const p = openReal({ state: 'rolling', rollTo: { ce: c9450, steps: 2 },
    legs: { ce: { contract: c9450, orderId: 'n', entry: 'dead', filledQty: 0, note: 'margin' }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } } });
  const r = planPairsTick(realSt(p), {}, at(10, 0), io());
  const o = one(r.next);
  assert.equal(o.state, 'exiting');
  assert.equal(o.exitReason, 'Roll failed — unwinding');
  assert.ok(o.legs.pe.exitSentAt);
  assert.equal(o.rollTo, undefined);
  assert.deepEqual(r.jobs, [{ kind: 'pairClose', id: 'p1' }]);
});

test('Bug 1: roll complete restarts fill grace (openedAt = now)', () => {
  const filled = openReal({ state: 'rolling', openedAt: 100, rollTo: { ce: c9450, steps: 2 },
    legs: { ce: { ...leg('CE', '3'), orderId: 'n', entry: 'filled', filledQty: 65, avg: 110 }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } } });
  const now = at(10, 5);
  const o = one(planPairsTick(realSt(filled), {}, now, io()).next);
  assert.equal(o.state, 'open');
  assert.equal(o.openedAt, now); // restarted!
});

test('Bug 2: rolling pair honours MIS auto-exit and manual exit', () => {
  // Past 15:17: unwinds the rolling pair
  const p = openReal({ state: 'rolling', product: 'MIS', rollTo: { ce: c9450, steps: 2 },
    legs: { ce: { ...leg('CE', '1'), held: 65 }, pe: { ...leg('PE', '2'), held: 65 } } });
  const rAuto = planPairsTick(realSt(p), {}, at(15, 18), io());
  assert.equal(one(rAuto.next).state, 'exiting');
  assert.ok(one(rAuto.next).exitReason?.includes('Auto square-off'));

  // Manual exit requested while rolling
  const pExit = openReal({ state: 'rolling', exitWanted: 'Manual exit', rollTo: { ce: c9450, steps: 2 },
    legs: { ce: { ...leg('CE', '1'), held: 65 }, pe: { ...leg('PE', '2'), held: 65 } } });
  const rMan = planPairsTick(realSt(pExit), {}, at(11, 0), io());
  assert.equal(one(rMan.next).state, 'exiting');
  assert.equal(one(rMan.next).exitReason, 'Manual exit');

  // Leg SL hit on the unmoved leg (PE) while CE is rolling: cancels roll and unwinds
  const pLegSl = openReal({ state: 'rolling', legSlPct: 50, rollTo: { ce: c9450, steps: 2 },
    legs: { ce: { ...leg('CE', '1'), held: 0, exitedQty: 65, exitAvg: 170 }, pe: { ...leg('PE', '2'), avg: 100, held: 65 } } });
  // PE stop at 150; LTP hits 160
  const rLegSl = planPairsTick(realSt(pLegSl), { 2: 160 }, at(11, 0), io());
  assert.equal(one(rLegSl.next).state, 'exiting');
  assert.equal(one(rLegSl.next).exitReason, 'Leg SL PE 150.00');
  assert.equal(one(rLegSl.next).rollTo, undefined);
});

test('Bug 3: interrupted roll exit turns UNKNOWN after 30s', () => {
  const p = openReal({ state: 'rolling', rollTo: { ce: c9450, steps: 2 },
    legs: { ce: { ...leg('CE', '1'), held: 65, exitSentAt: 1000 }, pe: { ...leg('PE', '2'), held: 65 } } });
  const r = planPairsTick(realSt(p), {}, 1000 + 35_000, io());
  assert.equal(one(r.next).state, 'unknown');
  assert.equal(one(r.next).legs.ce.unknown, 'exit');
});

test('Bug 4: splitOneLot does not copy bookedPnl to child', () => {
  const p: LadderPair = {
    id: 'p0', broker: 'dhan', mode: 'sim', structure: 'straddle', side: 'SELL', lots: 2, qty: 130, product: 'MIS', state: 'open',
    legs: { ce: { ...leg('CE', '1'), held: 130, avg: 100 }, pe: { ...leg('PE', '2'), held: 130, avg: 100 } },
    bookedPnl: 5000, createdAt: 1, updatedAt: 1,
  };
  const sp = splitOneLot(p, 'child1', 2);
  assert.ok(typeof sp !== 'string');
  if (typeof sp !== 'string' && sp.child) {
    assert.equal(sp.child.bookedPnl, undefined);
  }
});

test('Bug 5: +1 lot joinedTo parent skips separate leg-SL check', () => {
  // A joined pair with a low fill should not exit before the parent if parent leg-SL has not triggered
  const parent: LadderPair = {
    id: 'parent', broker: 'dhan', mode: 'sim', structure: 'straddle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'open',
    legs: { ce: { ...leg('CE', '1'), avg: 200, held: 65 }, pe: { ...leg('PE', '2'), avg: 200, held: 65 } },
    legSlPct: 100, createdAt: 1, updatedAt: 1,
  };
  const child: LadderPair = {
    id: 'child', broker: 'dhan', mode: 'sim', structure: 'straddle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'open',
    legs: { ce: { ...leg('CE', '1'), avg: 130, held: 65 }, pe: { ...leg('PE', '2'), avg: 200, held: 65 } },
    legSlPct: 100, joinedTo: 'parent', createdAt: 1, updatedAt: 1,
  };
  // If CE trades at 270:
  // Child's own 100% stop would be 260 -> would trigger if judged independently!
  // Parent's 100% stop is 400 -> not triggered.
  // With Bug 5 fix, child shares parent's stop (400) and remains open.
  const st: LadderState = { date: '2026-10-21', slices: [], events: [], pairs: [parent, child] };
  const r1 = planPairsTick(st, { 1: 270, 2: 200 }, at(10, 0), io());
  const c1 = r1.next.pairs?.find(x => x.id === 'child');
  assert.equal(c1?.state, 'open');

  // If CE trades at 405:
  // Both parent and child hit the shared 400.00 stop and exit together!
  const r2 = planPairsTick(st, { 1: 405, 2: 200 }, at(10, 0), io());
  const p2 = r2.next.pairs?.find(x => x.id === 'parent');
  const c2 = r2.next.pairs?.find(x => x.id === 'child');
  assert.equal(p2?.state, 'closed');
  assert.equal(p2?.exitReason, 'Leg SL CE 400.00');
  assert.equal(c2?.state, 'closed');
  assert.equal(c2?.exitReason, 'Leg SL CE 400.00');
});

test('Bug 7: +1 lot takes parent current levels on fill even if parent moved during fill', () => {
  const parent: LadderPair = {
    id: 'parent', broker: 'dhan', mode: 'real', structure: 'straddle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'open',
    legs: { ce: { ...leg('CE', '1'), avg: 150, held: 65, filledQty: 65, entry: 'filled' }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } },
    entryY: 300, slY: 340, tgtY: 260, createdAt: 1, updatedAt: 1,
  };
  // Child was created when parent SL was 320, but parent SL is now 340
  const child: LadderPair = {
    id: 'child', broker: 'dhan', mode: 'real', structure: 'straddle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'placing',
    legs: { ce: { ...leg('CE', '1'), orderId: 'c1', entry: 'filled', filledQty: 65, avg: 152 }, pe: { ...leg('PE', '2'), orderId: 'c2', entry: 'filled', filledQty: 65, avg: 148 } },
    joinedTo: 'parent', slY: 320, tgtY: 270, createdAt: 1, updatedAt: 1,
  };
  const st: LadderState = { date: '2026-10-21', slices: [], events: [], pairs: [parent, child] };
  const r = planPairsTick(st, {}, at(10, 0), io());
  const c = r.next.pairs?.find(x => x.id === 'child');
  assert.equal(c?.state, 'open');
  assert.equal(c?.slY, 340); // Inherited parent's current slY!
});

test('Bug 9: placing +1 lot with sendWanted is cancelled on rollDay, not marked UNKNOWN', () => {
  const unsent: LadderPair = {
    id: 'unsent', broker: 'dhan', mode: 'real', structure: 'straddle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'placing',
    sendWanted: true, legs: { ce: leg('CE', '1'), pe: leg('PE', '2') }, createdAt: 1, updatedAt: 1,
  };
  const st: LadderState = { date: '2026-10-21', slices: [], events: [], pairs: [unsent] };
  const rolled = rollDay(st, '2026-10-22', 1000);
  assert.equal(rolled.pairs?.length ?? 0, 0); // cancelled and filtered out
});

// ── follow-up fixes to 3b744c5a ──
test('joinedGroup: always includes the pair itself (armed / broken / rolling), links only by joinedTo', () => {
  const armed = pair({ id: 'a' });
  const broken = openReal({ id: 'b', state: 'broken' });
  const rolling = openReal({ id: 'r', state: 'rolling' });
  const s0: LadderState = { date: '2026-10-22', slices: [], events: [], pairs: [armed, broken, rolling] };
  assert.deepEqual(joinedGroup(s0, armed).map(p => p.id), ['a']);
  assert.deepEqual(joinedGroup(s0, broken).map(p => p.id), ['b']);
  assert.deepEqual(joinedGroup(s0, rolling).map(p => p.id), ['r']);
  // Two independent open pairs on the same strikes do not share; a +1 lot (joinedTo) does, from either end.
  const p1 = openReal({ id: 'p1' }), p2 = openReal({ id: 'p2' }), kid = openReal({ id: 'k', joinedTo: 'p1' });
  const s1: LadderState = { date: '2026-10-22', slices: [], events: [], pairs: [p1, p2, kid] };
  assert.deepEqual(joinedGroup(s1, p1).map(p => p.id).sort(), ['k', 'p1']);
  assert.deepEqual(joinedGroup(s1, kid).map(p => p.id).sort(), ['k', 'p1']);
  assert.deepEqual(joinedGroup(s1, p2).map(p => p.id), ['p2']);
});

test('rolling: a new-strike entry order still working blocks any abort (no naked leg); it is polled', () => {
  const p = openReal({ state: 'rolling', rollTo: { ce: c9450, steps: 2 }, exitWanted: 'Manual exit',
    legs: { ce: { contract: c9450, orderId: 'n', entry: 'sent' }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } } });
  const r = planPairsTick(realSt(p), {}, at(10, 0), io());
  assert.equal(one(r.next).state, 'rolling');
  assert.deepEqual(r.jobs, [{ kind: 'pairSettle', id: 'p1' }]);
  // Once it has settled (filled), the Exit cancels the roll and exits BOTH held legs.
  const done = { ...p, legs: { ...p.legs, ce: { ...p.legs.ce, entry: 'filled' as const, filledQty: 65, avg: 110 } } };
  const r2 = planPairsTick(realSt(done), {}, at(10, 1), io());
  assert.equal(one(r2.next).state, 'exiting');
});

test('rolling: the combined bracket is not judged once a new strike has replaced an old one', () => {
  // Short pair, target 280 on the OLD strikes; the new CE is far cheaper, so the "combined" would read 230.
  const p = openReal({ state: 'rolling', rollTo: { ce: c9450, steps: 2 }, tgtY: 280, slY: 315,
    legs: { ce: { contract: c9450 }, pe: { ...leg('PE', '2'), avg: 150, held: 65, filledQty: 65, entry: 'filled' } } });
  const r = planPairsTick(realSt(p), { 3: 80, 2: 150 }, at(10, 0), io());
  assert.equal(one(r.next).state, 'rolling');
  assert.ok(!r.jobs.some(j => j.kind === 'pairClose'), 'no exit from a stale combined');
  assert.equal(one(r.next).exitReason, undefined);
});

test('leg SL of a +1 lot uses its parent\'s level only on the same strike', () => {
  const parent = openReal({ id: 'p0', legSlPct: 100, legs: { ce: { ...leg('CE', '1'), avg: 100, held: 65 }, pe: { ...leg('PE', '2'), avg: 100, held: 65 } } });
  const kid = openReal({ id: 'k', joinedTo: 'p0', legSlPct: 100, legs: { ce: { ...leg('CE', '1'), avg: 130, held: 65 }, pe: { ...leg('PE', '2'), avg: 100, held: 65 } } });
  assert.equal(legSlReason(kid, { 1: 205, 2: 100 }, parent), 'Leg SL CE 200.00');
  // The parent rolled its CE to another strike: the kid falls back to its own fill (130 → 260).
  const rolled = { ...parent, legs: { ...parent.legs, ce: { ...parent.legs.ce, contract: c9450 } } };
  assert.equal(legSlReason(kid, { 1: 205, 2: 100 }, rolled), null);
  assert.equal(legSlReason(kid, { 1: 261, 2: 100 }, rolled), 'Leg SL CE 260.00');
});

test('pairStrikes: a strangle takes independent CE-above / PE-below offsets from the centre', async () => {
  const { pairStrikes, pairCentreOffsets } = await import('./priceLadderPair.ts');
  assert.deepEqual(pairStrikes('straddle', 22600, 50, 3, 5), { ce: 22600, pe: 22600 });
  assert.deepEqual(pairStrikes('strangle', 22600, 50, 2, 2), { ce: 22700, pe: 22500 });
  assert.deepEqual(pairStrikes('strangle', 22600, 50, 1, 4), { ce: 22650, pe: 22400 });     // asymmetric
  assert.deepEqual(pairStrikes('strangle', 22600, 50, 0, 3), { ce: 22600, pe: 22450 });     // CE on the ATM
  assert.equal(pairStrikes('strangle', 22600, 50, 0, 0), null);                              // CE must be above PE
  assert.equal(pairStrikes('strangle', 22600, 50, -1, 2), null);
  assert.equal(pairStrikes('strangle', 22600, 50, 1.5, 2), null);
  assert.equal(pairStrikes('strangle', 0, 50, 1, 1), null);
  // showing an existing pair again
  assert.deepEqual(pairCentreOffsets(22700, 22500, 50), { centre: 22600, ceOff: 2, peOff: 2 });
  assert.deepEqual(pairCentreOffsets(22650, 22400, 50), { centre: 22400, ceOff: 5, peOff: 0 });  // odd gap: centred on the PE
  const o = pairCentreOffsets(22650, 22400, 50);
  assert.deepEqual(pairStrikes('strangle', o.centre, 50, o.ceOff, o.peOff), { ce: 22650, pe: 22400 });
});

test('openPositionCount and scopeMtm: XY and Plain slices and Pair pairs are counted and priced together', async () => {
  const { openPositionCount } = await import('./priceLadderPair.ts');
  const { scopeMtm } = await import('./priceLadderGuard.ts');
  const c = (id: string, opt: 'CE' | 'PE') => ({ underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt, securityId: id, lotSize: 65, exchangeSegment: 'NSE_FNO' });
  const sl = (o: object) => ({ id: 'x', kind: 'xy', broker: 'dhan', mode: 'sim', contract: c('111', 'CE'), side: 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'open', createdAt: 1, updatedAt: 1, filledQty: 65, avg: 110, ...o });
  const leg = (id: string, opt: 'CE' | 'PE', avg: number) => ({ contract: c(id, opt), avg, held: 65, entry: 'filled' });
  const pair = { id: 'p', broker: 'dhan', mode: 'sim', structure: 'strangle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'open', legs: { ce: leg('111', 'CE', 100), pe: leg('222', 'PE', 90) }, createdAt: 1, updatedAt: 1 };
  const xy = sl({ id: 'a' }), plain = sl({ id: 'b', kind: 'plain', contract: c('222', 'PE'), avg: 85 });
  const ltps = { '111': 120, '222': 100 };
  const st = (slices: object[], pairs: object[]) => ({ date: 'd', events: [], slices, pairs }) as never;
  assert.equal(openPositionCount([xy] as never, []), 1);                                   // XY
  assert.equal(openPositionCount([plain] as never, []), 1);                                // Plain
  assert.equal(openPositionCount([], [pair] as never), 1);                                       // Pair
  assert.equal(openPositionCount([xy, plain, sl({ id: 'c' })] as never, [pair] as never), 3);    // '+1 lot' on the XY contract is the same position
  assert.equal(openPositionCount([sl({ id: 'd', state: 'armed', filledQty: undefined })] as never, []), 0);   // armed: not a position
  assert.equal(openPositionCount([sl({ id: 'e', state: 'closed' })] as never, [{ ...pair, state: 'closed' }] as never), 0);
  // P&L: xy +650 (110->120), plain +975 (85->100), short pair -(20+10)*65 = -1950
  const sc = { broker: 'dhan', mode: 'sim', pane: 1 } as const;
  assert.equal(scopeMtm(st([xy, plain], [pair]), sc, ltps), 650 + 975 - 1950);
  assert.equal(scopeMtm(st([xy], []), sc, ltps), 650);
  assert.equal(scopeMtm(st([], [pair]), sc, ltps), -1950);
});
