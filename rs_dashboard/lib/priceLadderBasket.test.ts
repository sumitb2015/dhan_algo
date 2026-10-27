import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basketTemplates, draftFromTemplate, validateDraft, basketAxis, orientLegs, basketCombined, basketName, basketNowPnl, sumBasketPnl,
  draftToParam, draftFromParam, mixedExpiry, planBaskets, splitBasketLots, applyBasketShare, basketLegQty, basketEntryVerdict, exitLegs, cutBasketLeg, firstPhase, phaseLegs, draftSyn, synAxis, synStrikeFor, synSane, MAX_REAL_SYN_LOTS, MAX_REAL_BASKET_LOTS, type LadderBasket, type BasketLeg, type DraftLeg,
} from './priceLadderBasket.ts';
import { rollDay, type LadderState } from './priceLadder.ts';
import { lotsOnContract, openPositionCount } from './priceLadderPair.ts';
import { STRATEGY_CATEGORIES } from './basketStrategies.ts';

const NOW = new Date('2026-10-27T10:30:00+05:30').getTime();      // a Tuesday, inside the NSE session
const SUN = new Date('2026-10-25T10:30:00+05:30').getTime();
const LOT = 65;
const listed = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700, 22750, 22800, 22850, 22900];
const contract = (strike: number, opt: 'CE' | 'PE') => ({ underlying: 'NIFTY', expiry: '2026-10-27', strike, opt, securityId: `${strike}${opt}`, lotSize: LOT, exchangeSegment: 'NSE_FNO' });

/** An iron condor as defined: short 22700CE / 22500PE, long 22800CE / 22400PE. */
const condorDraft: DraftLeg[] = [
  { side: 'SELL', opt: 'CE', strike: 22700, ratio: 1 }, { side: 'BUY', opt: 'CE', strike: 22800, ratio: 1 },
  { side: 'SELL', opt: 'PE', strike: 22500, ratio: 1 }, { side: 'BUY', opt: 'PE', strike: 22400, ratio: 1 },
];
const PX: Record<string, number> = { '22700CE': 40, '22800CE': 15, '22500PE': 35, '22400PE': 12 };      // credit = 40-15+35-12 = 48

function basket(o: Partial<LadderBasket> = {}, cash: 'BUY' | 'SELL' = 'SELL'): LadderBasket {
  const legs = orientLegs(condorDraft, cash, true).map((l, i) => ({ key: `l${i}`, side: l.side, ratio: l.ratio, contract: contract(l.strike, l.opt) }) as BasketLeg);
  return { id: 'b1', strategy: 'iron-condor', name: 'Iron Condor', broker: 'dhan', mode: 'sim', side: cash, lots: 2, product: 'MIS', state: 'armed', legs, createdAt: 1, updatedAt: 1, entryLevel: 50, entryDir: 'above', seenSafe: true, orderType: 'LIMIT', ...o };
}
const st = (baskets: LadderBasket[], extra: Partial<LadderState> = {}): LadderState => ({ date: '2026-10-27', events: [], slices: [], baskets, ...extra });

test('basketTemplates: single-expiry only; draftFromTemplate puts the iron condor on the listed strikes around ATM', () => {
  const all = basketTemplates();
  const total = Object.values(STRATEGY_CATEGORIES).reduce((a, l) => a + l.length, 0);
  assert.ok(all.length > 20 && all.length <= total);
  assert.ok(all.every(t => !Object.values(STRATEGY_CATEGORIES).flat().find(x => x.key === t.key)!.dte));
  const ic = all.find(t => t.key === 'iron-condor')!;
  const d = draftFromTemplate(ic.legs, 22600, 50, listed);
  assert.deepEqual(d.map(l => [l.side, l.opt, l.strike, l.ratio]), [['SELL', 'CE', 22750, 1], ['BUY', 'CE', 22900, 1], ['SELL', 'PE', 22450, 1], ['BUY', 'PE', 22300, 1]]);
  const bf = draftFromTemplate(all.find(t => t.key === 'call-butterfly')!.legs, 22600, 50, listed);
  assert.deepEqual(bf.map(l => [l.side, l.strike, l.ratio]), [['BUY', 22400, 1], ['SELL', 22600, 2], ['BUY', 22800, 1]]);   // 1:2:1
});

test('validateDraft: legs, ratios and duplicates', () => {
  assert.equal(validateDraft(condorDraft), null);
  assert.match(validateDraft([])!, /at least one/);
  assert.match(validateDraft(Array.from({ length: 9 }, (_, i) => ({ side: 'BUY' as const, opt: 'CE' as const, strike: 22000 + i * 50, ratio: 1 })))!, /at most 8/);
  assert.match(validateDraft([{ ...condorDraft[0], ratio: 0 }])!, /whole numbers/);
  assert.match(validateDraft([condorDraft[0], condorDraft[0]])!, /twice/);
  assert.match(validateDraft([condorDraft[0], { ...condorDraft[0], side: 'BUY' }])!, /both bought and sold/);   // a template squeezed onto a short strike list
});

test('basketAxis / orientLegs / basketCombined: credit strategy, both directions, A is always the positive magnitude', () => {
  const ax = basketAxis(condorDraft, l => PX[`${l.strike}${l.opt}`])!;
  assert.deepEqual(ax, { a: 48, credit: true });
  assert.equal(basketAxis(condorDraft, () => undefined), null);
  // Sell the condor = receive 48 with the legs as defined; Buy = pay 48 with every leg mirrored.
  assert.deepEqual(orientLegs(condorDraft, 'SELL', true).map(l => l.side), ['SELL', 'BUY', 'SELL', 'BUY']);
  assert.deepEqual(orientLegs(condorDraft, 'BUY', true).map(l => l.side), ['BUY', 'SELL', 'BUY', 'SELL']);
  assert.equal(basketCombined(basket({}, 'SELL'), PX), 48);
  assert.equal(basketCombined(basket({}, 'BUY'), PX), 48);
  assert.equal(basketCombined(basket({}), { ...PX, '22700CE': 0 }), null);
  // a debit strategy as defined (long butterfly): Buy = as defined
  const bf: DraftLeg[] = [{ side: 'BUY', opt: 'CE', strike: 22400, ratio: 1 }, { side: 'SELL', opt: 'CE', strike: 22600, ratio: 2 }, { side: 'BUY', opt: 'CE', strike: 22800, ratio: 1 }];
  const bfPx: Record<string, number> = { 22400: 230, 22600: 100, 22800: 30 };
  const a = basketAxis(bf, l => bfPx[l.strike])!;
  assert.deepEqual(a, { a: 60, credit: false });
  assert.deepEqual(orientLegs(bf, 'BUY', false).map(l => l.side), ['BUY', 'SELL', 'BUY']);
  assert.match(basketName(basket()), /^Iron Condor 22400\/22500\/22700\/22800$/);
});

test('planBaskets: a SELL level fires when the credit rises to it, every leg fills at its live price, the bracket is set from the fill', () => {
  const b = basket({ entryLevel: 50, entryDir: 'above', bracket: { tgtPts: 20, slPts: 15 } });
  const quiet = planBaskets(st([b]), PX, NOW).next;                             // net 48 < 50: nothing yet
  assert.equal(quiet.baskets![0].state, 'armed');
  const hit = planBaskets(st([b]), { ...PX, '22700CE': 43 }, NOW).next.baskets![0];           // net 51 crossed 50 upward
  assert.equal(hit.state, 'open');
  assert.deepEqual(hit.legs.map(l => [l.avg, l.held]), [[43, 130], [15, 130], [35, 130], [12, 130]]);   // 2 lots x 65
  assert.equal(hit.entryY, 51);
  assert.equal(hit.slY, 66);                                                     // SELL: the SL is 15 points ABOVE the entry net
  assert.equal(hit.tgtY, 31);
  // closed market (Sunday): nothing fires
  assert.equal(planBaskets(st([b]), { ...PX, '22700CE': 43 }, SUN).next.baskets![0].state, 'armed');
});

test('planBaskets: target, SL and a manual exit close every leg at its live price; P&L is per leg side', () => {
  const open = (extra: Partial<LadderBasket> = {}): LadderBasket => {
    const b = basket({ state: 'open', openedAt: 1, entryY: 48, bracket: { tgtPts: 20, slPts: 15 }, tgtY: 28, slY: 63, slY0: 63, peakY: 48, trailFrom: 48, ...extra });
    b.legs = b.legs.map(l => ({ ...l, avg: PX[`${l.contract.strike}${l.contract.opt}`], held: 130, filledQty: 130, entry: 'filled' as const }));
    return b;
  };
  assert.equal(basketNowPnl(open(), PX), 0);
  // the credit decays 48 -> 28: target. Short legs lose value, hedges lose a bit
  const win = { '22700CE': 22, '22800CE': 8, '22500PE': 20, '22400PE': 6 };                      // net = 22-8+20-6 = 28
  const closed = planBaskets(st([open()]), win, NOW).next.baskets![0];
  assert.equal(closed.state, 'closed');
  assert.match(closed.exitReason!, /Target 28/);
  // P&L = shorts (40-22 + 35-20) x 130 - hedges ((15-8) + (12-6)) x 130 = (33 - 13) x 130
  assert.equal(basketNowPnl(closed, {}), (18 + 15 - 7 - 6) * 130);
  const stop = planBaskets(st([open()]), { ...PX, '22700CE': 56, '22500PE': 42 }, NOW).next.baskets![0];     // net 48 + 16 + 7 = 71 >= 63
  assert.equal(stop.state, 'closed');
  assert.match(stop.exitReason!, /SL 63/);
  const manual = planBaskets(st([open({ exitWanted: 'Manual exit', bracket: undefined })]), PX, NOW).next.baskets![0];
  assert.equal(manual.exitReason, 'Manual exit');
  // MIS square-off after the cutoff
  const late = new Date('2026-10-27T15:20:00+05:30').getTime();
  assert.match(planBaskets(st([open({ bracket: undefined })]), PX, late).next.baskets![0].exitReason!, /Auto square-off/);
  // a missing price waits instead of booking a made-up one
  const wait = planBaskets(st([open({ exitWanted: 'Manual exit', bracket: undefined })]), { ...PX, '22800CE': 0 }, NOW).next.baskets![0];
  assert.equal(wait.state, 'open');
  assert.match(wait.note!, /waiting/);
  assert.equal(sumBasketPnl([open(), open({ id: 'b2' })], () => true, PX), 0);
});

test('splitBasketLots / applyBasketShare: whole lots, oldest first, the rest keeps its levels', () => {
  const full = (id: string, lots: number, openedAt: number): LadderBasket => {
    const b = basket({ id, lots, state: 'open', openedAt, bracket: { tgtPts: 20, slPts: 15 }, slY: 63 });
    b.legs = b.legs.map(l => ({ ...l, avg: 10, held: basketLegQty(lots, l.ratio, LOT), filledQty: basketLegQty(lots, l.ratio, LOT), entry: 'filled' as const }));
    return b;
  };
  const sp = splitBasketLots(full('a', 3, 1), 1, 'c1', 5);
  assert.ok(typeof sp !== 'string');
  if (typeof sp !== 'string') {
    assert.equal(sp.parent.lots, 2);
    assert.deepEqual(sp.parent.legs!.map(l => l.held), [130, 130, 130, 130]);
    assert.deepEqual([sp.child!.lots, sp.child!.legs[0].held, sp.child!.exitWanted], [1, 65, 'Manual exit (−1 lot)']);
    assert.equal(sp.child!.slY, 63);
  }
  assert.deepEqual((splitBasketLots(full('a', 1, 1), 1, 'c', 5) as { parent: { exitWanted: string } }).parent, { exitWanted: 'Manual exit' });
  let n = 0; const newId = () => `n${++n}`;
  const all = applyBasketShare(st([full('a', 2, 1), full('b', 1, 2)]), ['a', 'b'], 100, 5, newId) as { next: LadderState; lots: number };
  assert.equal(all.lots, 3);
  assert.deepEqual(all.next.baskets!.map(b => b.exitWanted), ['Manual exit', 'Manual exit']);
  const half = applyBasketShare(st([full('a', 2, 1), full('b', 2, 2)]), ['a', 'b'], 50, 5, newId) as { next: LadderState; lots: number };
  assert.equal(half.lots, 2);                                                   // 50% of 4 lots = 2, all from the oldest
  assert.equal(half.next.baskets!.find(b => b.id === 'a')!.exitWanted, 'Manual exit');
  assert.equal(half.next.baskets!.find(b => b.id === 'b')!.exitWanted, undefined);
  assert.match(applyBasketShare(st([full('a', 1, 1)]), ['a'], 25, 5, newId) as string, /less than one lot/);
  assert.match(applyBasketShare(st([full('a', 1, 1)]), ['zz'], 100, 5, newId) as string, /Nothing is open/);
  assert.match(applyBasketShare(st([full('a', 1, 1)]), ['a'], 30, 5, newId) as string, /pct must be/);
});

test('integration: baskets count in the 20-lot cap, the open count and survive the day roll (armed ones expire)', () => {
  const armed = basket({ id: 'x', lots: 2 });                                    // legs: SELL 22700CE x1, BUY 22800CE, SELL 22500PE, BUY 22400PE
  assert.equal(lotsOnContract(st([armed]), '22700CE', 'dhan', 'sim', 'SELL'), 2);
  assert.equal(lotsOnContract(st([armed]), '22700CE', 'dhan', 'sim', 'BUY'), 0);
  assert.equal(lotsOnContract(st([armed]), '22700CE', 'dhan', 'real', 'SELL'), 0);
  assert.equal(lotsOnContract(st([armed]), '22700CE', 'dhan', 'sim', 'SELL', 'x'), 0);        // the basket itself is excluded
  assert.equal(lotsOnContract(st([{ ...armed, state: 'closed' }]), '22700CE', 'dhan', 'sim', 'SELL'), 0);
  const two: LadderBasket[] = [armed, { ...armed, id: 'y', state: 'open' }];
  assert.equal(openPositionCount([], [], two), 1);                                           // armed is not a position
  const rolled = rollDay(st([armed, { ...armed, id: 'o', state: 'open' }, { ...armed, id: 'c', state: 'closed' }], { date: '2026-10-26' }), '2026-10-27', 5);
  assert.deepEqual(rolled.baskets!.map(b => b.id), ['o']);
});

test('planBaskets: a net that has fallen to nothing still exits on a manual / MIS reason (it needs every leg price, not a positive net)', () => {
  const b = basket({ state: 'open', openedAt: 1, entryY: 48, exitWanted: 'Manual exit' });
  b.legs = b.legs.map(l => ({ ...l, avg: 10, held: 130, filledQty: 130, entry: 'filled' as const }));
  const flat = { '22700CE': 20, '22800CE': 20, '22500PE': 20, '22400PE': 20 };       // net = 0: no axis price
  assert.equal(basketCombined(b, flat), null);
  const out = planBaskets(st([b]), flat, NOW).next.baskets![0];
  assert.equal(out.state, 'closed');
  assert.equal(out.exitReason, 'Manual exit');
});

test('integration: guard, archive and Clear see baskets', async () => {
  const { scopeMtm, applyGuards } = await import('./priceLadderGuard.ts');
  const { partsToArchive } = await import('./priceLadderArchive.ts');
  const open = basket({ state: 'open', openedAt: 1, entryY: 48 });
  open.legs = open.legs.map(l => ({ ...l, avg: PX[`${l.contract.strike}${l.contract.opt}`], held: 130, filledQty: 130, entry: 'filled' as const }));
  const sc = { broker: 'dhan', mode: 'sim', pane: 1 } as const;
  assert.equal(scopeMtm(st([open]), sc, PX), 0);
  assert.equal(scopeMtm(st([open]), sc, { ...PX, '22700CE': 30 }), 10 * 130);          // the short CE decayed 40 -> 30
  assert.equal(scopeMtm(st([open]), { ...sc, mode: 'real' }, PX), null);
  // a tripped guard queues the exit of an open basket and cancels an armed one
  const armed = basket({ id: 'a2' });
  const tripped = { ...st([open, armed]), guards: { 'dhan:sim': { on: true, stop: 100 } } };
  const g = applyGuards(tripped, { ...PX, '22700CE': 120 }, NOW).next;               // MTM far below -100
  assert.equal(g.baskets!.find(b => b.id === 'b1')!.exitWanted?.length ? true : false, true);
  assert.equal(g.baskets!.find(b => b.id === 'a2')!.state, 'cancelled');
  // archive: a roll saves the baskets, Clear saves the ones it removes
  const raw = st([open, basket({ id: 'c1', state: 'closed' })]);
  const rolled = rollDay(raw, '2026-10-28', 5);
  assert.deepEqual(partsToArchive(raw, rolled, rolled)!.part.baskets!.map(b => b.id), ['b1', 'c1']);
  const cleared = { ...raw, baskets: raw.baskets!.filter(b => b.state !== 'closed') };
  assert.deepEqual(partsToArchive(raw, raw, cleared)!.part.baskets!.map(b => b.id), ['c1']);
});

// ── REAL placement ──
const ARMED = (over: Partial<LadderState> = {}): LadderState => ({ ...st([]), liveArmedOn: '2026-10-27', ...over });
const real = (o: Partial<LadderBasket> = {}): LadderBasket => basket({ mode: 'real', ...o });
const filled = (l: BasketLeg, q = 130): BasketLeg => ({ ...l, orderId: `o${l.key}`, entry: 'filled', filledQty: q, avg: PX[`${l.contract.strike}${l.contract.opt}`] });
const sent = (l: BasketLeg): BasketLeg => ({ ...l, orderId: `o${l.key}`, entry: 'sent' });
const NOIO = { polledAt: () => 0, busy: () => false };

test('REAL arm: crossing marks the basket placing with the hedges phase first and starts the open job; no live arm = cancelled', () => {
  const b = real({ entryLevel: 50, entryDir: 'above' });
  const hit = planBaskets({ ...ARMED(), baskets: [b] }, { ...PX, '22700CE': 43 }, NOW, NOIO);
  assert.equal(hit.next.baskets![0].state, 'placing');
  assert.equal(hit.next.baskets![0].phase, 'hedges');
  assert.deepEqual(hit.jobs, [{ kind: 'basketOpen', id: 'b1' }]);
  assert.deepEqual(phaseLegs(b, 'hedges').map(l => l.side), ['BUY', 'BUY']);
  const off = planBaskets({ ...st([b]) }, { ...PX, '22700CE': 43 }, NOW, NOIO);                 // liveArmedOn missing
  assert.equal(off.next.baskets![0].state, 'cancelled');
  assert.equal(off.jobs.length, 0);
  // a basket of only SELL legs (a short strangle) starts at the shorts
  assert.equal(firstPhase({ legs: b.legs.filter(l => l.side === 'SELL') }), 'shorts');
});

test('REAL entry: the shorts are sent only after every hedge filled in full; a failed hedge sends no short', () => {
  const b0 = real({ state: 'placing', phase: 'hedges', sentAt: NOW });
  const hedgesSent = { ...b0, legs: b0.legs.map(l => (l.side === 'BUY' ? sent(l) : l)) };
  assert.equal(basketEntryVerdict(hedgesSent), 'wait');
  const hedgesFilled = { ...b0, legs: b0.legs.map(l => (l.side === 'BUY' ? filled(l) : l)) };
  assert.equal(basketEntryVerdict(hedgesFilled), 'advance');
  const adv = planBaskets(st([hedgesFilled]), PX, NOW, NOIO);
  assert.equal(adv.next.baskets![0].phase, 'shorts');
  assert.deepEqual(adv.jobs, [{ kind: 'basketOpen', id: 'b1' }]);
  // a hedge rejected: unwind (nothing short exists) — nothing filled at all is simply cancelled
  const dead = { ...b0, legs: b0.legs.map(l => (l.side === 'BUY' ? { ...l, orderId: 'x', entry: 'dead' as const, filledQty: 0, note: 'RMS reject' } : l)) };
  assert.equal(basketEntryVerdict(dead), 'unwind');
  const none = planBaskets(st([dead]), PX, NOW, NOIO);
  assert.equal(none.next.baskets![0].state, 'cancelled');
  assert.equal(none.jobs.length, 0);
  // one hedge filled, the other rejected: the filled hedge is sold again, no short was ever sent
  const mixed = { ...b0, legs: b0.legs.map((l, i) => (l.side === 'BUY' ? (i === 1 ? filled(l) : { ...l, entry: 'dead' as const, filledQty: 0 }) : l)) };
  const un = planBaskets(st([mixed]), PX, NOW, NOIO);
  assert.equal(un.next.baskets![0].state, 'exiting');
  assert.deepEqual(un.jobs, [{ kind: 'basketClose', id: 'b1' }]);
  assert.equal(un.next.baskets![0].legs.filter(l => l.exitSentAt).length, 1);
  // an UNKNOWN hedge stops everything
  const unk = { ...b0, legs: b0.legs.map(l => (l.side === 'BUY' ? { ...l, orderId: 'u', entry: 'unknown' as const, unknown: 'entry' as const } : l)) };
  assert.equal(planBaskets(st([unk]), PX, NOW, NOIO).next.baskets![0].state, 'unknown');
});

test('REAL entry: all legs filled opens the basket at the traded net; a short that part-fills unwinds shorts first', () => {
  const b0 = real({ state: 'placing', phase: 'shorts', sentAt: NOW, bracket: { tgtPts: 20, slPts: 15 } });
  const all = { ...b0, legs: b0.legs.map(l => filled(l)) };
  assert.equal(basketEntryVerdict(all), 'open');
  const open = planBaskets(st([all]), PX, NOW, NOIO).next.baskets![0];
  assert.equal(open.state, 'open');
  assert.equal(open.entryY, 48);
  assert.equal(open.slY, 63);
  assert.deepEqual(open.legs.map(l => l.held), [130, 130, 130, 130]);
  // one short filled only 65 of 130: unwind every filled unit; the covering order is for the short first
  const part = { ...b0, legs: b0.legs.map((l, i) => (i === 0 ? filled(l, 65) : filled(l))) };
  assert.equal(basketEntryVerdict(part), 'unwind');
  const un = planBaskets(st([part]), PX, NOW, NOIO);
  assert.equal(un.next.baskets![0].state, 'exiting');
  const marked = un.next.baskets![0].legs.filter(l => l.exitSentAt).map(l => l.side);
  assert.deepEqual(marked, ['SELL', 'SELL']);                                      // only the shorts are sent now; hedges wait
});

test('REAL exit: shorts are covered first, hedges only once no short is held; flat closes it', () => {
  const held = (b: LadderBasket, patch: (l: BasketLeg) => Partial<BasketLeg>) => ({ ...b, legs: b.legs.map(l => ({ ...l, avg: 10, held: 130, filledQty: 130, entry: 'filled' as const, ...patch(l) })) });
  const open = held(real({ state: 'open', openedAt: 1, entryY: 48, exitWanted: 'Manual exit' }), () => ({}));
  const begin = planBaskets(st([open]), PX, NOW, NOIO);
  assert.equal(begin.next.baskets![0].state, 'exiting');
  assert.deepEqual(begin.next.baskets![0].legs.filter(l => l.exitSentAt).map(l => l.side), ['SELL', 'SELL']);
  assert.deepEqual(begin.jobs, [{ kind: 'basketClose', id: 'b1' }]);
  // shorts' exit orders in flight: the hedges are still held back
  const flight = held({ ...open, state: 'exiting', exitReason: 'Manual exit', exitWanted: undefined }, l => (l.side === 'SELL' ? { exitOrderId: 'x', exitSentAt: NOW } : {}));
  assert.deepEqual(exitLegs(flight, NOW), []);
  // shorts flat: now the hedges go
  const shortsDone = held({ ...open, state: 'exiting', exitReason: 'Manual exit', exitWanted: undefined }, l => (l.side === 'SELL' ? { held: 0, exitedQty: 130, exitAvg: 5 } : {}));
  assert.deepEqual(exitLegs(shortsDone, NOW).map(l => l.side), ['BUY', 'BUY']);
  const next = planBaskets(st([shortsDone]), PX, NOW, NOIO);
  assert.deepEqual(next.jobs, [{ kind: 'basketClose', id: 'b1' }]);
  // everything flat: closed
  const flat = held({ ...open, state: 'exiting', exitReason: 'Manual exit', exitWanted: undefined }, () => ({ held: 0, exitedQty: 130, exitAvg: 5 }));
  assert.equal(planBaskets(st([flat]), PX, NOW, NOIO).next.baskets![0].state, 'closed');
  // a rejected cover waits its retry before it is sent again
  const retry = held({ ...open, state: 'exiting', exitReason: 'Manual exit', exitWanted: undefined }, l => (l.side === 'SELL' ? { exitRetryAt: NOW + 10_000 } : {}));
  assert.deepEqual(exitLegs(retry, NOW), []);
});

test('REAL reconcile: a leg cut outside the ladder breaks the basket (bracket off); every leg gone closes it', () => {
  const open = real({ state: 'open', openedAt: 1, entryY: 48, bracket: { tgtPts: 20, slPts: 15 }, tgtY: 28, slY: 63 });
  open.legs = open.legs.map(l => ({ ...l, avg: 10, held: 130, filledQty: 130, entry: 'filled' as const }));
  const cut = cutBasketLeg(open, 'l0', 130, 20, NOW);
  assert.equal(cut.state, 'broken');
  const broken = { ...open, ...cut } as LadderBasket;
  // a broken basket only exits on a manual / MIS reason, never its bracket
  const stopHit = planBaskets(st([broken]), { ...PX, '22500PE': 90 }, NOW, NOIO);
  assert.equal(stopHit.next.baskets![0].state, 'broken');
  let b = broken;
  for (const k of ['l1', 'l2', 'l3']) b = { ...b, ...cutBasketLeg(b, k, 130, 5, NOW) } as LadderBasket;
  assert.equal(b.state, 'closed');
});

test('REAL entry: an interrupted SHORTS send (hedges already filled) is UNKNOWN for the shorts only; the hedges stay', () => {
  const b = real({ state: 'placing', phase: 'shorts', sentAt: NOW - 60_000 });
  b.legs = b.legs.map(l => (l.side === 'BUY' ? filled(l) : l));
  const out = planBaskets(st([b]), PX, NOW, NOIO).next.baskets![0];
  assert.equal(out.state, 'unknown');
  assert.deepEqual(out.legs.map(l => [l.side, l.unknown ?? null]), [['SELL', 'entry'], ['BUY', null], ['SELL', 'entry'], ['BUY', null]]);
  // while a send is still running it is not orphaned
  assert.equal(planBaskets(st([b]), PX, NOW, { polledAt: () => 0, busy: () => true }).next.baskets![0].state, 'placing');
});

// ── calendars / diagonals: two expiries ──────────────────────────────────────────────────────────

test('calendar templates are offered, with their far legs flagged', () => {
  const t = basketTemplates().find(x => x.key === 'calendar-call-spread');
  assert.ok(t, 'calendar call spread offered');
  assert.ok(basketTemplates().some(x => x.key === 'double-calendar'));
  assert.ok(!basketTemplates().some(x => x.key === 'low-gamma-diagonal-call'), 'DTE-window templates stay out');
  const d = draftFromTemplate(t!.legs, 22500, 50, listed);
  assert.deepEqual(d.map(l => [l.side, l.strike, l.far ?? false]), [['SELL', 22500, false], ['BUY', 22500, true]]);
});

test('a near and a far leg on one strike are a calendar, not a contradiction', () => {
  const cal: DraftLeg[] = [{ side: 'SELL', opt: 'CE', strike: 22500, ratio: 1 }, { side: 'BUY', opt: 'CE', strike: 22500, ratio: 1, far: true }];
  assert.equal(validateDraft(cal), null);
  assert.match(validateDraft([...cal, { side: 'BUY', opt: 'CE', strike: 22500, ratio: 1 }]) ?? '', /both bought and sold/);
  assert.match(validateDraft([cal[1], { ...cal[1] }]) ?? '', /twice/);
});

test('a calendar sell-near / buy-far is a debit', () => {
  const cal: DraftLeg[] = [{ side: 'SELL', opt: 'CE', strike: 22500, ratio: 1 }, { side: 'BUY', opt: 'CE', strike: 22500, ratio: 1, far: true }];
  const px = [30, 55];
  const ax = basketAxis(cal, l => px[cal.indexOf(l)]);
  assert.deepEqual(ax, { a: 25, credit: false });
});

test('the price-request form round-trips and carries the far expiry on the far legs', () => {
  const cal: DraftLeg[] = [{ side: 'SELL', opt: 'PE', strike: 22300, ratio: 1 }, { side: 'BUY', opt: 'PE', strike: 22300, ratio: 2, far: true }];
  const param = draftToParam(cal, '2026-11-24');
  assert.equal(param, '22300:PE:S:1,22300:PE:B:2:F:2026-11-24');
  assert.deepEqual(draftFromParam(param), { legs: cal, farExpiry: '2026-11-24' });
  assert.equal(draftFromParam('22300:PE:S:1').farExpiry, null);
  assert.equal(draftFromParam('22300:PE:B:1:F:garbage').farExpiry, null);
});

test('mixedExpiry tells a calendar from a single-expiry basket', () => {
  const leg = (expiry: string) => ({ contract: { ...contract(22500, 'CE'), expiry } }) as BasketLeg;
  assert.equal(mixedExpiry({ legs: [leg('2026-10-27'), leg('2026-11-24')] }), true);
  assert.equal(mixedExpiry({ legs: [leg('2026-10-27'), leg('2026-10-27')] }), false);
});

// ── Synthetic future ─────────────────────────────────────────────────────────────────────────────────────────────────
const SYN_K = 22500;
const SYN_PX: Record<string, number> = { '22500CE': 160, '22500PE': 140 };      // synthetic = 22500 + 160 - 140 = 22520
function synBasket(side: 'BUY' | 'SELL', o: Partial<LadderBasket> = {}): LadderBasket {
  const legs = draftSyn(SYN_K, side).map((l, i) => ({ key: `l${i}`, side: l.side, ratio: 1, contract: contract(l.strike, l.opt) }) as BasketLeg);
  return { id: 's1', strategy: 'synthetic-future', name: 'Synthetic Future', broker: 'dhan', mode: 'sim', side, kind: 'syn', synStrike: SYN_K, lots: 1, product: 'MIS', state: 'armed', legs, createdAt: 1, updatedAt: 1, entryLevel: 22510, entryDir: 'above', seenSafe: true, orderType: 'LIMIT', ...o };
}

test('draftSyn: long = BUY CE + SELL PE, short = SELL CE + BUY PE, both at one strike', () => {
  assert.deepEqual(draftSyn(SYN_K, 'BUY').map(l => [l.side, l.opt, l.strike]), [['BUY', 'CE', SYN_K], ['SELL', 'PE', SYN_K]]);
  assert.deepEqual(draftSyn(SYN_K, 'SELL').map(l => [l.side, l.opt, l.strike]), [['SELL', 'CE', SYN_K], ['BUY', 'PE', SYN_K]]);
  assert.equal(validateDraft(draftSyn(SYN_K, 'BUY')), null);
  assert.equal(validateDraft(draftSyn(SYN_K, 'SELL')), null);
});

test('synAxis is K + CE - PE and needs both prices; synStrikeFor snaps to the grid', () => {
  assert.equal(synAxis(SYN_K, 160, 140), 22520);
  assert.equal(synAxis(SYN_K, 140, 160), 22480);          // sign flips freely: it is an index level, not a premium
  assert.equal(synAxis(SYN_K, undefined, 140), null);
  assert.equal(synAxis(SYN_K, 160, 0), null);
  assert.equal(synStrikeFor(22537, 50), 22550);
  assert.equal(synStrikeFor(0, 50), null);
});

test('basketCombined: a synthetic is K + CE - PE in BOTH directions', () => {
  assert.equal(basketCombined(synBasket('BUY'), SYN_PX), 22520);
  assert.equal(basketCombined(synBasket('SELL'), SYN_PX), 22520);
  assert.equal(basketCombined(synBasket('BUY'), { '22500CE': 160 }), null);
  // CE == PE: a premium basket would have no axis; the synthetic is just the strike.
  assert.equal(basketCombined(synBasket('BUY'), { '22500CE': 150, '22500PE': 150 }), 22500);
});

test('synSane bounds the synthetic against the spot; an unknown spot does not block', () => {
  assert.equal(synSane(22520, 22510), true);
  assert.equal(synSane(22900, 22510), false);             // one stale leg shifted it by ~380 pts (1.7%)
  assert.equal(synSane(22520, undefined), true);
});

test('SIM synthetic: a long fires on the crossing synthetic price and its bracket is in synthetic points', () => {
  const b = synBasket('BUY', { bracket: { tgtPts: 30, slPts: 20 } as LadderBasket['bracket'] });
  const { next } = planBaskets(st([b]), SYN_PX, NOW);
  const o = next.baskets![0];
  assert.equal(o.state, 'open');
  assert.equal(o.entryY, 22520);
  assert.equal(o.tgtY, 22550);                            // a long gains as the synthetic rises
  assert.equal(o.slY, 22500);
  assert.deepEqual(o.legs.map(l => [l.side, l.avg]), [['BUY', 160], ['SELL', 140]]);
});

test('SIM synthetic short: gains as the synthetic falls', () => {
  const b = synBasket('SELL', { entryDir: 'below', entryLevel: 22530, bracket: { tgtPts: 30, slPts: 20 } as LadderBasket['bracket'] });
  const { next } = planBaskets(st([b]), SYN_PX, NOW);
  const o = next.baskets![0];
  assert.equal(o.state, 'open');
  assert.equal(o.tgtY, 22490);
  assert.equal(o.slY, 22540);
});

test('a synthetic far from the spot (a stale leg) pauses its entry; an unknown spot does not', () => {
  const b = synBasket('BUY');
  const io = { polledAt: () => 0, busy: () => false, spotOf: () => 22000 as number | undefined };
  assert.equal(planBaskets(st([b]), SYN_PX, NOW, io).next.baskets![0].state, 'armed');
  assert.equal(planBaskets(st([b]), SYN_PX, NOW, { ...io, spotOf: () => 22510 }).next.baskets![0].state, 'open');
});

test('a synthetic exit still runs while the basis check pauses its bracket', () => {
  const open = synBasket('BUY', { state: 'open', entryY: 22520, exitWanted: 'Manual exit', legs: synBasket('BUY').legs.map(l => ({ ...l, avg: SYN_PX[l.contract.securityId], held: LOT, filledQty: LOT, entry: 'filled' as const })) });
  const io = { polledAt: () => 0, busy: () => false, spotOf: () => 22000 as number | undefined };
  const r = planBaskets(st([open]), SYN_PX, NOW, io).next.baskets![0];
  assert.equal(r.state, 'closed');
  assert.equal(r.exitReason, 'Manual exit');
});

test('REAL synthetic entry: the bought leg goes first (CE for a long, PE for a short); exit covers the short leg first', () => {
  assert.deepEqual(phaseLegs(synBasket('BUY'), 'hedges').map(l => l.contract.opt), ['CE']);
  assert.deepEqual(phaseLegs(synBasket('SELL'), 'hedges').map(l => l.contract.opt), ['PE']);
  const held = synBasket('BUY', { state: 'open', mode: 'real', legs: synBasket('BUY').legs.map(l => ({ ...l, held: LOT, filledQty: LOT, entry: 'filled' as const })) });
  assert.deepEqual(exitLegs(held, NOW).map(l => l.contract.opt), ['PE']);      // the short put is covered before the long call is sold
});

test('the REAL synthetic cap is tighter than the REAL basket cap', () => {
  assert.ok(MAX_REAL_SYN_LOTS < MAX_REAL_BASKET_LOTS);
});
