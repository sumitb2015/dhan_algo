import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bias, limitZone, classifyClick, levelSane, capLots, cleanBracket, entryStep, bracketLevels, bracketStep, spotFresh,
  settleOrder, exitQtyFor, slicePnl, ownNet, ladderRows, snapToStep, rollDay, realArmed, pushEvent, istHhmm,
  MAX_LADDER_LOTS, SPOT_STALE_MS, planTick, type LadderSlice, type LadderState,
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
