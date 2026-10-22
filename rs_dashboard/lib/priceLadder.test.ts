import test from 'node:test';
import assert from 'node:assert/strict';
import { mcxSession, usDstActive } from './mcxSession.ts';
import {
  bias, limitZone, classifyClick, levelSane, capLots, cleanBracket, entryStep, bracketLevels, bracketStep, spotFresh,
  settleOrder, exitQtyFor, slicePnl, sliceNowPnl, sumSlicePnl, ownNet, ladderRows, snapToStep, rollDay, realArmed, pushEvent, istHhmm,
  MAX_LADDER_LOTS, SPOT_STALE_MS, planTick, stopLimitPrice, cleanBufferPct, sessionFor, spotKey, parseSpotKey, type LadderSlice, type LadderState,
} from './priceLadder.ts';

const contract = { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE' as const, securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' };
const slice = (over: Partial<LadderSlice> = {}): LadderSlice => ({
  id: 'a', kind: 'xy', broker: 'dhan', mode: 'sim', contract, side: 'BUY', lots: 1, qty: 65, product: 'MIS',
  state: 'open', createdAt: 0, updatedAt: 0, ...over,
});

test('bias: CE buy and PE sell gain as the index rises', () => {
  assert.equal(bias('CE', 'BUY'), 1);
  assert.equal(bias('PE', 'SELL'), 1);
  assert.equal(bias('PE', 'BUY'), -1);
  assert.equal(bias('CE', 'SELL'), -1);
});

test('limitZone: the Put ladder is inverted in XY mode, plain mode follows the premium', () => {
  assert.equal(limitZone('xy', 'CE', 'BUY'), 'below');
  assert.equal(limitZone('xy', 'PE', 'BUY'), 'above');
  assert.equal(limitZone('xy', 'CE', 'SELL'), 'above');
  assert.equal(limitZone('xy', 'PE', 'SELL'), 'below');
  assert.equal(limitZone('plain', 'PE', 'BUY'), 'below');
  assert.equal(limitZone('plain', 'CE', 'SELL'), 'above');
});

test('classifyClick: limit zone works with Limit, the other side needs SL', () => {
  const base = { mode: 'xy' as const, opt: 'CE' as const, side: 'BUY' as const, ref: 23200 };
  assert.deepEqual(classifyClick({ ...base, level: 23180, orderType: 'LIMIT' }), { ok: true, kind: 'limit', dir: 'below' });
  const refused = classifyClick({ ...base, level: 23220, orderType: 'LIMIT' });
  assert.equal(refused.ok, false);
  assert.deepEqual(classifyClick({ ...base, level: 23220, orderType: 'SL' }), { ok: true, kind: 'stop', dir: 'above' });
  assert.equal(classifyClick({ ...base, level: 23200, orderType: 'SL' }).ok, false);
  assert.equal(classifyClick({ ...base, level: 23180, ref: 0, orderType: 'LIMIT' }).ok, false);
});

test('levelSane / capLots / cleanBracket refuse bad input', () => {
  assert.equal(levelSane(23180, 23200), true);
  assert.equal(levelSane(26000, 23200), false);
  assert.equal(capLots('3'), 3);
  assert.equal(capLots(0), null);
  assert.equal(capLots(1.5), null);
  assert.equal(capLots(MAX_LADDER_LOTS + 1), null);
  assert.deepEqual(cleanBracket({ tgtPts: 43, slPts: 31 }), { tgtPts: 43, slPts: 31 });
  assert.deepEqual(cleanBracket({ tgtPts: 43, slPts: 31, trailPts: 5 }), { tgtPts: 43, slPts: 31, trailPts: 5 });
  assert.equal(cleanBracket({ tgtPts: -5, slPts: 31 }), null);
  assert.equal(cleanBracket({ tgtPts: 10, slPts: 'x' }), null);
});

test('entryStep: video CE setup fires when Nifty comes down to 23180, not before', () => {
  let s = { entryLevel: 23180, entryDir: 'below' as const, seenSafe: false };
  let r = entryStep(s, 23200);            // safe side seen
  assert.deepEqual(r, { seenSafe: true, fire: false });
  s = { ...s, seenSafe: r.seenSafe };
  r = entryStep(s, 23181);
  assert.equal(r.fire, false);
  r = entryStep(s, 23180);
  assert.equal(r.fire, true);
});

test('entryStep: a level already breached when armed waits for a fresh cross', () => {
  const s = { entryLevel: 23180, entryDir: 'below' as const, seenSafe: false };
  assert.equal(entryStep(s, 23170).fire, false);
  const back = entryStep(s, 23190);
  assert.equal(back.seenSafe, true);
  assert.equal(entryStep({ ...s, seenSafe: true }, 23179).fire, true);
});

test('bracket: video CE bracket 23180 -> target 23223, SL 23149', () => {
  const lv = bracketLevels(1, 23180, { tgtPts: 43, slPts: 31 });
  assert.deepEqual(lv, { tgtY: 23223, slY: 23149 });
  const open = { entryY: 23180, ...lv, slY0: lv.slY, bracket: { tgtPts: 43, slPts: 31 } };
  assert.equal(bracketStep(open, 1, 23200).hit, null);
  assert.equal(bracketStep(open, 1, 23223).hit, 'target');
  assert.equal(bracketStep(open, 1, 23149).hit, 'sl');
});

test('bracket: video PE setup (entry 23405, SL 23425, target 23350) trails towards profit and never loosens', () => {
  const br = { tgtPts: 55, slPts: 20, trailPts: 10 };
  const lv = bracketLevels(-1, 23405, br);
  assert.deepEqual(lv, { tgtY: 23350, slY: 23425 });
  let s = { entryY: 23405, ...lv, slY0: lv.slY, peakY: undefined as number | undefined, bracket: br };
  for (const spot of [23400, 23390, 23380, 23356]) {
    const r = bracketStep(s, -1, spot);
    assert.equal(r.hit, null);
    s = { ...s, slY: r.slY!, peakY: r.peakY };
  }
  // 49 points in favour = 4 full steps of 10 -> SL 23425 - 40 = 23385
  assert.equal(s.slY, 23385);
  // a retrace does not loosen it
  const back = bracketStep(s, -1, 23370);
  assert.equal(back.slY, 23385);
  assert.equal(back.hit, null);
  assert.equal(bracketStep({ ...s, slY: back.slY! }, -1, 23386).hit, 'sl');
});

test('bracket: trailing with the peak a step further gives the video 23375', () => {
  const br = { tgtPts: 55, slPts: 20, trailPts: 10 };
  const s = { entryY: 23405, tgtY: 23350, slY: 23425, slY0: 23425, peakY: 23351, bracket: br };
  assert.equal(bracketStep(s, -1, 23360).slY, 23375);
});

test('bracketStep: target wins over SL on the same tick and no spot means no decision', () => {
  const s = { entryY: 100, tgtY: 110, slY: 110, slY0: 90, bracket: { tgtPts: 10, slPts: 10 } };
  assert.equal(bracketStep(s, 1, 111).hit, 'target');
  assert.equal(bracketStep(s, 1, 0).hit, null);
});

test('spotFresh pauses on an old or missing spot', () => {
  assert.equal(spotFresh(1000, 1000 + SPOT_STALE_MS), true);
  assert.equal(spotFresh(1000, 1001 + SPOT_STALE_MS), false);
  assert.equal(spotFresh(null, 1), false);
});

test('settleOrder: TRADED fills, a cancel after a partial counts what filled, PENDING waits', () => {
  assert.deepEqual(settleOrder({ orderStatus: 'TRADED', filledQty: 65, averageTradedPrice: 12.5, quantity: 65 }), { kind: 'filled', filledQty: 65, avg: 12.5, final: true });
  assert.deepEqual(settleOrder({ orderStatus: 'CANCELLED', filledQty: 0, averageTradedPrice: 0, quantity: 65 }), { kind: 'dead', reason: 'CANCELLED' });
  assert.deepEqual(settleOrder({ orderStatus: 'CANCELLED', filledQty: 30, averageTradedPrice: 9, quantity: 65 }), { kind: 'filled', filledQty: 30, avg: 9, final: true });
  assert.equal(settleOrder({ orderStatus: 'PENDING', filledQty: 0, averageTradedPrice: 0, quantity: 65 }).kind, 'wait');
  assert.equal(settleOrder({ orderStatus: 'TRANSIT', filledQty: 0, averageTradedPrice: 0, quantity: 65 }).kind, 'wait');
});

test('exitQtyFor never exceeds own qty nor what the broker shows in that direction', () => {
  assert.equal(exitQtyFor(130, 'BUY', { net: 65 }, false), 65);
  assert.equal(exitQtyFor(130, 'BUY', { net: 300 }, false), 130);
  assert.equal(exitQtyFor(130, 'BUY', { net: -65 }, false), 0);
  assert.equal(exitQtyFor(130, 'SELL', { net: -65 }, false), 65);
  assert.equal(exitQtyFor(130, 'BUY', { net: null }, true), 130);
  assert.equal(exitQtyFor(130, 'BUY', { net: null }, false), 0);
  assert.equal(exitQtyFor(130, 'BUY', { failed: true }, false), 130);
});

test('slicePnl / ownNet', () => {
  assert.equal(slicePnl({ side: 'BUY', avg: 10, filledQty: 65 }, 12), 130);
  assert.equal(slicePnl({ side: 'SELL', avg: 10, filledQty: 65 }, 12), -130);
  assert.equal(slicePnl({ side: 'BUY', avg: 10, filledQty: 65 }, 0), null);
  const n = ownNet([
    slice({ filledQty: 65, avg: 10 }),
    slice({ id: 'b', filledQty: 130, avg: 13 }),
    slice({ id: 'c', filledQty: 65, avg: 20, state: 'closed' }),
    slice({ id: 'd', filledQty: 65, avg: 20, contract: { ...contract, securityId: '222' } }),
  ], '111');
  assert.equal(n.qty, 195);
  assert.equal(n.avg, 12);
});

test('ladderRows / snapToStep', () => {
  assert.deepEqual(ladderRows(23213.7, 5, 5), [23225, 23220, 23215, 23210, 23205]);
  assert.deepEqual(ladderRows(0.12, 0.05, 5), [0.2, 0.15, 0.1, 0.05]);
  assert.equal(snapToStep(12.37, 0.05), 12.35);
});

test('rollDay drops finished slices, cancels armed levels, keeps live positions and lapses the arm', () => {
  const s: LadderState = {
    date: '2026-10-21', liveArmedOn: '2026-10-21', events: [{ at: 1, level: 'info', msg: 'x' }],
    slices: [slice({ state: 'closed' }), slice({ id: 'b', state: 'armed' }), slice({ id: 'c', state: 'open' }), slice({ id: 'd', state: 'unknown' })],
  };
  const r = rollDay(s, '2026-10-22', 5);
  assert.deepEqual(r.slices.map(x => x.id), ['c', 'd']);
  assert.equal(realArmed(r, '2026-10-22'), false);
  assert.equal(rollDay(r, '2026-10-22', 6), r);
});

test('pushEvent keeps the log bounded', () => {
  let s: LadderState = { date: 'd', slices: [], events: [] };
  for (let i = 0; i < 5; i++) s = pushEvent(s, { at: i, level: 'info', msg: String(i) }, 3);
  assert.deepEqual(s.events.map(e => e.msg), ['2', '3', '4']);
});

test('istHhmm reads IST', () => {
  assert.equal(istHhmm(Date.parse('2026-10-22T09:47:00Z')), 1517);
});

test('bracketStep: trailing switched on later measures from trailFrom, never from the old entry', () => {
  const s = { entryY: 100, tgtY: 200, slY: 90, slY0: 90, peakY: 140, trailFrom: 140, bracket: { tgtPts: 100, slPts: 10, trailPts: 10 } };
  assert.equal(bracketStep(s, 1, 145).slY, 90);   // 5 pts past trailFrom: no step yet
  assert.equal(bracketStep(s, 1, 150).slY, 100);  // one full step
});

// ── planTick: the watcher's decisions ──
const T = Date.parse('2026-10-22T05:00:00Z');             // 10:30 IST
const AFTER = Date.parse('2026-10-22T09:50:00Z');         // 15:20 IST
const io = { polledAt: () => 0, mayCancel: () => true };
const st = (slices: LadderSlice[], armed = false): LadderState => ({ date: '2026-10-22', slices, events: [], ...(armed ? { liveArmedOn: '2026-10-22' } : {}) });
const px = (spot: number, at = T) => ({ spots: { NIFTY: { spot, at } }, ltps: { '111': 120 } });
const armedXY = (over: Partial<LadderSlice> = {}) => slice({ state: 'armed', entryLevel: 23180, entryDir: 'below', seenSafe: true, bracket: { tgtPts: 43, slPts: 31 }, ...over });

test('planTick: an armed level marks the slice placing (entry spot stamped) and asks for one open', () => {
  const r = planTick(st([armedXY()]), px(23179), T, io);
  assert.deepEqual(r.jobs, [{ kind: 'open', id: 'a' }]);
  const x = r.next.slices[0];
  assert.equal(x.state, 'placing');
  assert.equal(x.sentAt, T);
  assert.equal(x.entryY, 23179);
});

test('planTick: no fire above the level, nor on a stale spot', () => {
  assert.deepEqual(planTick(st([armedXY()]), px(23190), T, io).jobs, []);
  const stale = planTick(st([armedXY()]), px(23100, T - SPOT_STALE_MS - 1), T, io);
  assert.deepEqual(stale.jobs, []);
  assert.equal(stale.next.slices[0].state, 'armed');
});

test('planTick: a REAL level does not fire with the live arm off — it is cancelled', () => {
  const r = planTick(st([armedXY({ mode: 'real' })], false), px(23179), T, io);
  assert.deepEqual(r.jobs, []);
  assert.equal(r.next.slices[0].state, 'cancelled');
  assert.deepEqual(planTick(st([armedXY({ mode: 'real' })], true), px(23179), T, io).jobs, [{ kind: 'open', id: 'a' }]);
});

test('planTick: an open bracket exits at target / SL and moves a trailing SL', () => {
  const open = slice({ state: 'open', filledQty: 65, avg: 100, entryY: 23180, tgtY: 23223, slY: 23149, slY0: 23149, bracket: { tgtPts: 43, slPts: 31, trailPts: 10 } });
  const tgt = planTick(st([open]), px(23224), T, io);
  assert.deepEqual(tgt.jobs, [{ kind: 'close', id: 'a' }]);
  assert.equal(tgt.next.slices[0].state, 'exiting');
  assert.match(String(tgt.next.slices[0].exitReason), /^Target/);
  const moved = planTick(st([open]), px(23201), T, io);
  assert.deepEqual(moved.jobs, []);
  assert.equal(moved.next.slices[0].slY, 23169);
  const sl = planTick(st([open]), px(23149), T, io);
  assert.deepEqual(sl.jobs, [{ kind: 'close', id: 'a' }]);
});

test('planTick: a stale spot never exits a bracket; a rejected exit waits for its retry time', () => {
  const open = slice({ state: 'open', filledQty: 65, avg: 100, entryY: 23180, tgtY: 23223, slY: 23149, slY0: 23149, bracket: { tgtPts: 43, slPts: 31 } });
  assert.deepEqual(planTick(st([open]), px(23100, T - SPOT_STALE_MS - 1), T, io).jobs, []);
  assert.deepEqual(planTick(st([{ ...open, exitRetryAt: T + 1000 }]), px(23100), T, io).jobs, []);
});

test('planTick: a manual exit goes out on the next tick even without a spot', () => {
  const open = slice({ state: 'open', filledQty: 65, avg: 100, exitWanted: 'Manual exit' });
  const r = planTick(st([open]), { spots: {}, ltps: {} }, T, io);
  assert.deepEqual(r.jobs, [{ kind: 'close', id: 'a' }]);
  assert.equal(r.next.slices[0].exitWanted, undefined);
});

test('planTick: after 15:17 armed levels are cancelled and open slices square off', () => {
  const r = planTick(st([armedXY(), slice({ id: 'b', state: 'open', filledQty: 65, avg: 100 })]), px(23179, AFTER), AFTER, io);
  assert.equal(r.next.slices[0].state, 'cancelled');
  assert.deepEqual(r.jobs, [{ kind: 'close', id: 'b' }]);
  assert.equal(r.next.slices[1].exitReason, 'Auto square-off 15:17');
});

test('planTick: a REAL order marked placing with no order id for 30s becomes UNKNOWN, never resent', () => {
  const r = planTick(st([slice({ mode: 'real', state: 'placing', sentAt: T - 31_000 })]), px(23200), T, io);
  assert.deepEqual(r.jobs, []);
  assert.equal(r.next.slices[0].state, 'unknown');
});

test('planTick: a SIM plain limit fills when the option trades through it', () => {
  const w = slice({ kind: 'plain', state: 'working', orderType: 'LIMIT', limitPrice: 121 });
  const r = planTick(st([w]), px(23200), T, io);
  assert.equal(r.next.slices[0].state, 'open');
  assert.equal(r.next.slices[0].avg, 121);
  assert.equal(planTick(st([{ ...w, limitPrice: 119 }]), px(23200), T, io).next.slices[0].state, 'working');
});

test('exitQtyFor: inside the fill grace an earlier flat row for the same strike does not zero the exit', () => {
  assert.equal(exitQtyFor(65, 'BUY', { net: 0 }, true), 65);
  assert.equal(exitQtyFor(65, 'BUY', { net: 0 }, false), 0);
});

test('rollDay: a REAL working order from an earlier session becomes UNKNOWN, a SIM one is cancelled', () => {
  const s: LadderState = { date: '2026-10-21', events: [], slices: [
    slice({ id: 'r', mode: 'real', kind: 'plain', state: 'working', orderId: '9' }),
    slice({ id: 's', mode: 'sim', kind: 'plain', state: 'working' }),
  ] };
  const r = rollDay(s, '2026-10-22', 5);
  assert.deepEqual(r.slices.map(x => `${x.id}:${x.state}`), ['r:unknown']);
});

test('planTick: after 15:17 a REAL working order is cancelled AND still settled, so a late fill is squared off', () => {
  const w = slice({ mode: 'real', kind: 'plain', state: 'working', orderId: '9', orderType: 'LIMIT', limitPrice: 100 });
  const r = planTick(st([w]), px(23200, AFTER), AFTER, io);
  assert.deepEqual(r.jobs, [{ kind: 'cancel', id: 'a' }, { kind: 'settle', id: 'a', which: 'entry' }]);
  assert.equal(r.next.slices[0].state, 'working');
});

test('Cover order: SL only — no target level, the SL still fires and trails', () => {
  assert.deepEqual(cleanBracket({ tgtPts: 0, slPts: 20 }), { tgtPts: 0, slPts: 20 });
  assert.equal(cleanBracket({ tgtPts: 0, slPts: 0 }), null);
  const lv = bracketLevels(1, 23180, { tgtPts: 0, slPts: 20 });
  assert.deepEqual(lv, { slY: 23160 });
  const s = { entryY: 23180, slY: 23160, slY0: 23160, bracket: { tgtPts: 0, slPts: 20, trailPts: 10 } };
  assert.equal(bracketStep(s, 1, 23400).hit, null);           // no target to hit
  assert.equal(bracketStep(s, 1, 23400).slY, 23380);          // trailed 22 steps
  assert.equal(bracketStep(s, 1, 23160).hit, 'sl');
});

test('zerodhaLadderParams: MARKET carries market protection; a stop is SL (stop-limit) with a 5% limit beyond the trigger', async () => {
  const { zerodhaLadderParams } = await import('./priceLadder.ts');
  const c = { lotSize: 65, tick: 0.05 };
  assert.deepEqual(zerodhaLadderParams('NIFTY26OCT22800CE', 'NFO', 'BUY', 65, 'MIS', { type: 'MARKET' }, c), {
    tradingsymbol: 'NIFTY26OCT22800CE', exchange: 'NFO', transaction_type: 'BUY', order_type: 'MARKET', quantity: 65, product: 'MIS', validity: 'DAY', market_protection: -1,
  });
  const lim = zerodhaLadderParams('X', 'NFO', 'SELL', 65, 'NRML', { type: 'LIMIT', price: 136.52 }, c);
  assert.equal(lim.order_type, 'LIMIT');
  assert.equal(lim.price, 136.5);
  assert.equal('market_protection' in lim, false);
  const buyStop = zerodhaLadderParams('X', 'BFO', 'BUY', 20, 'MIS', { type: 'SL', trigger: 100 }, c);
  assert.equal(buyStop.order_type, 'SL');
  assert.equal(buyStop.trigger_price, 100);
  assert.equal(buyStop.price, 105);
  assert.equal(zerodhaLadderParams('X', 'NFO', 'SELL', 65, 'MIS', { type: 'SL', trigger: 100 }, c).price, 95);
});

test('planTick: a placement still on the wire after 30s is not declared UNKNOWN (its order id is still coming)', () => {
  const x = slice({ mode: 'real', state: 'placing', sentAt: T - 31_000 });
  assert.equal(planTick(st([x]), px(23200), T, { ...io, busy: () => true }).next.slices[0].state, 'placing');
  assert.equal(planTick(st([x]), px(23200), T, { ...io, busy: () => false }).next.slices[0].state, 'unknown');
});

test('planTick: before 09:15 a crossed level is not fired; after 15:30 a REAL exit is held, not sent', () => {
  const PRE = Date.parse('2026-10-22T03:30:00Z');          // 09:00 IST
  const pre = planTick(st([armedXY()]), px(23179, PRE), PRE, io);
  assert.deepEqual(pre.jobs, []);
  assert.equal(pre.next.slices[0].state, 'armed');
  const LATE = Date.parse('2026-10-22T10:05:00Z');         // 15:35 IST
  const open = slice({ mode: 'real', state: 'open', filledQty: 65, avg: 100 });
  const late = planTick(st([open]), px(23200, LATE), LATE, io);
  assert.deepEqual(late.jobs, []);
  assert.match(String(late.next.slices[0].note), /Market closed/);
  // the note is written once, not every tick
  assert.equal(planTick(late.next, px(23200, LATE), LATE, io).next, late.next);
});

test('planTick: 15:17 squares off MIS only — an NRML position is carried with its bracket', () => {
  const nrml = slice({ id: 'n', state: 'open', product: 'NRML', filledQty: 65, avg: 100 });
  const mis = slice({ id: 'm', state: 'open', product: 'MIS', filledQty: 65, avg: 100 });
  const r = planTick(st([nrml, mis]), px(23200, AFTER), AFTER, io);
  assert.deepEqual(r.jobs, [{ kind: 'close', id: 'm' }]);
  assert.equal(r.next.slices[0].state, 'open');
});

test('planTick: a SIM slice left mid-job by a restart recovers (entry re-armed, exit retried)', () => {
  const placing = slice({ id: 'p', mode: 'sim', state: 'placing', sentAt: T - 31_000 });
  const exiting = slice({ id: 'e', mode: 'sim', state: 'exiting', exitSentAt: T - 31_000, exitReason: 'Manual exit', filledQty: 65, avg: 100 });
  const r = planTick(st([placing, exiting]), px(23200), T, io);
  assert.equal(r.next.slices[0].state, 'armed');
  assert.equal(r.next.slices[1].state, 'open');
  assert.equal(r.next.slices[1].exitWanted, 'Manual exit');
  // still running: left alone
  assert.equal(planTick(st([placing]), px(23200), T, { ...io, busy: () => true }).next.slices[0].state, 'placing');
});

test('planTick: an XY fire is marked as a MARKET order (its settle times out to UNKNOWN)', () => {
  assert.equal(planTick(st([armedXY()]), px(23179), T, io).next.slices[0].market, true);
});

test('sumSlicePnl: closed at exit, open at LTP; an unpriced open slice makes the total unknown', () => {
  const closed = slice({ id: 'c', state: 'closed', avg: 10, filledQty: 65, exitAvg: 12 });
  const open = slice({ id: 'o', avg: 10, filledQty: 65 });
  const armed = slice({ id: 'x', state: 'armed' });
  const all = () => true;
  assert.equal(sliceNowPnl(armed, 50), undefined);
  assert.equal(sumSlicePnl([closed, open, armed], all, () => 11), 130 + 65);
  assert.equal(sumSlicePnl([closed, open], all, () => undefined), null);
  assert.equal(sumSlicePnl([armed], all, () => 11), null);
  assert.equal(sumSlicePnl([closed, open], s => s.id === 'c', () => undefined), 130);
});

// ── MCX (CRUDEOILM on Dhan) ──
const crude = {
  underlying: 'CRUDEOILM', expiry: '2026-11-17', strike: 9200, opt: 'CE' as const, securityId: '900', lotSize: 1,
  exchangeSegment: 'MCX_COMM', mult: 10, ref: { securityId: '573423', segment: 'MCX_COMM', expiry: '2026-11-19' },
};
const EVENING = Date.parse('2026-10-22T14:30:00Z');       // 20:00 IST
const LATE = Date.parse('2026-10-22T17:35:00Z');          // 23:05 IST

test('MCX: session hours and the futures-month axis key', () => {
  assert.deepEqual(sessionFor('CRUDEOILM', '2026-10-22'), { open: 900, close: 2330, autoExit: 2300, autoExitLabel: '23:00' });
  assert.equal(sessionFor('NIFTY', '2026-10-22').autoExitLabel, '15:17');
  assert.equal(spotKey(crude), 'CRUDEOILM@MCX_COMM:573423');
  assert.deepEqual(parseSpotKey(spotKey(crude)), { segment: 'MCX_COMM', securityId: '573423' });
  assert.equal(parseSpotKey('NIFTY'), null);
  assert.equal(spotKey(contract), 'NIFTY');
});

test('MCX: P&L is lots x 10 barrels (Dhan qty is in lots)', () => {
  assert.equal(slicePnl({ side: 'BUY', avg: 100, filledQty: 2, contract: crude }, 110), 200);
  assert.equal(slicePnl({ side: 'SELL', avg: 100, filledQty: 1, contract: crude }, 110), -100);
});

test('MCX: an armed level fires at 20:00 IST on the futures price; a NIFTY one is cancelled then', () => {
  const c = slice({ id: 'c', contract: crude, state: 'armed', entryLevel: 9180, entryDir: 'below', seenSafe: true, lots: 1, qty: 1 });
  const n = armedXY({ id: 'n' });
  const prices = { spots: { [spotKey(crude)]: { spot: 9179, at: EVENING }, NIFTY: { spot: 23179, at: EVENING } }, ltps: {} };
  const r = planTick(st([c, n]), prices, EVENING, io);
  assert.deepEqual(r.jobs, [{ kind: 'open', id: 'c' }]);
  assert.equal(r.next.slices.find(x => x.id === 'c')!.entryY, 9179);
  assert.equal(r.next.slices.find(x => x.id === 'n')!.state, 'cancelled');
});

test('MCX: an index price under the plain underlying name never drives a CRUDEOILM level', () => {
  const c = slice({ id: 'c', contract: crude, state: 'armed', entryLevel: 9180, entryDir: 'below', seenSafe: true, lots: 1, qty: 1 });
  const r = planTick(st([c]), { spots: { CRUDEOILM: { spot: 9100, at: EVENING } }, ltps: {} }, EVENING, io);
  assert.deepEqual(r.jobs, []);
});

test('MCX calendar: US-DST close, holidays, weekends', () => {
  // Summer (US DST): 23:30 close, MIS out at 23:00. Winter from Mon 2 Nov 2026: 23:55 / 23:25.
  assert.equal(mcxSession('2026-10-30').close, 2330);
  assert.deepEqual(mcxSession('2026-11-02'), { open: 900, close: 2355, autoExit: 2325, autoExitLabel: '23:25' });
  assert.equal(mcxSession('2027-03-05').close, 2355);
  assert.equal(mcxSession('2027-03-15').close, 2330);           // DST starts Sun 14 Mar 2027
  assert.equal(usDstActive('2026-03-09'), true);
  assert.equal(usDstActive('2026-03-06'), false);
  // Evening-only holiday, full holiday, weekend.
  assert.equal(mcxSession('2026-11-10').open, 1700);
  const xmas = mcxSession('2026-12-25');
  assert.equal(xmas.open >= xmas.close, true);
  const sat = mcxSession('2026-10-24');
  assert.equal(sat.open >= sat.close, true);
});

test('MCX: nothing fires and REAL exits are held on an MCX holiday', () => {
  const XMAS = Date.parse('2026-12-25T14:30:00Z');           // 20:00 IST
  const c = slice({ id: 'c', contract: crude, state: 'armed', entryLevel: 9180, entryDir: 'below', seenSafe: true, lots: 1, qty: 1 });
  const o = slice({ id: 'o', contract: crude, mode: 'real', product: 'NRML', lots: 1, qty: 1, filledQty: 1, avg: 100, openedAt: 0, exitWanted: 'Manual exit' });
  const day = (slices: LadderSlice[]): LadderState => ({ date: '2026-12-25', slices, events: [], liveArmedOn: '2026-12-25' });
  const r = planTick(day([c, o]), { spots: { [spotKey(crude)]: { spot: 9100, at: XMAS } }, ltps: { '900': 101 } }, XMAS, io);
  assert.deepEqual(r.jobs, []);
  assert.equal(r.next.slices.find(x => x.id === 'c')!.state, 'armed');
  assert.equal(r.next.slices.find(x => x.id === 'o')!.state, 'open');
});

test('MCX: MIS squared off at 23:00 IST, NRML kept', () => {
  const open = (id: string, product: 'MIS' | 'NRML') => slice({ id, contract: crude, product, lots: 1, qty: 1, filledQty: 1, avg: 100, openedAt: EVENING });
  const r = planTick(st([open('m', 'MIS'), open('r', 'NRML')]), { spots: {}, ltps: { '900': 101 } }, LATE, io);
  assert.deepEqual(r.jobs, [{ kind: 'close', id: 'm' }]);
  assert.equal(r.next.slices.find(x => x.id === 'm')!.exitReason, 'Auto square-off 23:00');
});

test('rollDay keeps the state revision (a page holding rev N must accept the new day)', () => {
  const s: LadderState = { date: '2026-10-21', slices: [], events: [], rev: 41 };
  assert.equal(rollDay(s, '2026-10-22', T).rev, 41);
  assert.equal(rollDay({ date: '2026-10-21', slices: [], events: [] }, '2026-10-22', T).rev, undefined);
});

// ── Anywhere zones / SL-limit ──
test('classifyClick Anywhere: the other side is a stop with Limit selected; Classic still refuses it', () => {
  const base = { mode: 'plain' as const, opt: 'CE' as const, side: 'SELL' as const, ref: 120, orderType: 'LIMIT' as const };
  assert.deepEqual(classifyClick({ ...base, level: 115, zones: 'anywhere' }), { ok: true, kind: 'stop', dir: 'below' });
  assert.deepEqual(classifyClick({ ...base, level: 125, zones: 'anywhere' }), { ok: true, kind: 'limit', dir: 'above' });
  assert.equal(classifyClick({ ...base, level: 115 }).ok, false);
  assert.equal(classifyClick({ ...base, level: 120, zones: 'anywhere' }).ok, false);
  // XY CE: a Buy above spot is a breakout in Anywhere.
  assert.deepEqual(classifyClick({ mode: 'xy', opt: 'CE', side: 'BUY', level: 23220, ref: 23200, orderType: 'LIMIT', zones: 'anywhere' }), { ok: true, kind: 'stop', dir: 'above' });
});

test('stopLimitPrice: buffer past the trigger, snapped away from it, at least one tick', () => {
  assert.equal(stopLimitPrice('SELL', 120, 2), 117.6);
  assert.equal(stopLimitPrice('BUY', 120, 2), 122.4);
  assert.equal(stopLimitPrice('SELL', 101.03, 2), 99);       // 99.0094 snapped down
  assert.equal(stopLimitPrice('BUY', 101.03, 2), 103.1);     // 103.0506 snapped up
  assert.equal(stopLimitPrice('SELL', 1, 0.1), 0.95);        // one tick minimum
  assert.equal(stopLimitPrice('BUY', 1, 0.1), 1.05);
  assert.equal(stopLimitPrice('SELL', 0.05, 2), null);
  assert.equal(cleanBufferPct(2), 2);
  assert.equal(cleanBufferPct(0), null);
  assert.equal(cleanBufferPct(11), null);
});

test('zerodhaLadderParams: an explicit SL limit is used instead of the 5% default', async () => {
  const { zerodhaLadderParams } = await import('./priceLadder.ts');
  const p = zerodhaLadderParams('NIFTY26OCT22800CE', 'NFO', 'SELL', 65, 'MIS', { type: 'SL', trigger: 120, limit: 117.6 }, null);
  assert.equal(p.order_type, 'SL');
  assert.equal(p.trigger_price, 120);
  assert.equal(p.price, 117.6);
});

test('planTick SIM SL-limit: triggered past the limit rests as a LIMIT, fills once back inside it', () => {
  const w = slice({ kind: 'plain', side: 'SELL', state: 'working', orderType: 'SL', triggerPrice: 120, stopLimitPrice: 117.6 });
  const at = (ltp: number, x: LadderSlice) => planTick(st([x]), { spots: {}, ltps: { '111': ltp } }, T, io).next.slices[0];
  assert.equal(at(121, w).state, 'working');                          // not triggered
  const gapped = at(116, w);                                           // triggered, below the limit
  assert.equal(gapped.state, 'working');
  assert.equal(gapped.stopTriggered, true);
  const filled = at(118, gapped);                                      // back inside the limit
  assert.equal(filled.state, 'open');
  assert.equal(filled.avg, 118);
  assert.equal(at(119, w).avg, 119);                                   // triggered inside the limit: fills at once
  // Classic SL-M (no stopLimitPrice): fills at the ltp on the trigger, however far.
  assert.equal(at(110, { ...w, stopLimitPrice: undefined }).avg, 110);
});
