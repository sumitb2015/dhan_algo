import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basketTemplates, draftFromTemplate, validateDraft, basketAxis, orientLegs, basketCombined, basketName, basketNowPnl, sumBasketPnl,
  planBaskets, splitBasketLots, applyBasketShare, basketLegQty, type LadderBasket, type BasketLeg, type DraftLeg,
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
  assert.equal(validateDraft([condorDraft[0], { ...condorDraft[0], side: 'BUY' }]), null);          // same strike, other side: allowed
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
