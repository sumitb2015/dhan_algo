import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HD_ALGO_KEYS, HD_LAST_PX_MAX_AGE_MS, dayPnl as dayPnlOf, atmStrike, cycleMtm, enterAlgoNow, enterLegNow, exitAllNow, exitLegNow, imbalancePct, isOpen, limitRs, newAlgo,
  pickDeltaStrike, pickExpiryByDte, resolveStrike, sizeShortLots, stepAlgo, vwapOf,
  type HdAlgo, type HdLeg, type HdMarket, type HdOption, type HdQuote,
} from './harvestDesk.ts';
import { controlsFor, defaultControls, HD_KINDS } from './harvestDeskControls.ts';

const EXP = '2026-10-13';
const EXP2 = '2026-10-20';
const MIN = 60_000;
const T0 = Date.parse('2026-10-12T04:00:00Z'); // 09:30 IST

/** A market whose prices come from a mutable table, so a test moves them between ticks. */
type MarketOver = Partial<HdMarket> & { px?: (e: string, k: number, o: HdOption) => HdQuote | null };
function market(over: MarketOver = {}): HdMarket {
  const strikes = Array.from({ length: 41 }, (_, i) => 24000 + i * 50);
  return {
    now: T0, day: '2026-10-12', hm: '09:30', spot: 25000, step: 50, lotSize: 65,
    expiries: [EXP, EXP2], strikes: () => strikes, dte: (e) => (e === EXP ? 1 : 8),
    quote: (e, k, o) => (over.px ? over.px(e, k, o) : null),
    ...over,
  };
}

/** Premium decays 0.1 per point OTM from `atm` price; ITM is deeper. */
const ladder = (cePx: number, pePx: number) => (_e: string, k: number, o: HdOption): HdQuote => {
  const base = o === 'CE' ? cePx : pePx;
  const dist = o === 'CE' ? k - 25000 : 25000 - k;
  return { ltp: Math.max(0.5, base - dist * 0.1), deltaAbs: Math.min(0.95, Math.max(0.02, 0.5 - dist / 1000)) };
};

function armed(kind: Parameters<typeof newAlgo>[0], tweak?: (a: HdAlgo) => void): HdAlgo {
  const a = newAlgo(kind, 'NIFTY', undefined, T0);
  a.armed = true;
  tweak?.(a);
  return a;
}
const leg = (a: HdAlgo, option: HdOption, role: HdLeg['role'] = 'main') => a.legs.find((l) => l.option === option && l.role === role)!;
const ce = (a: HdAlgo) => leg(a, 'CE');
const pe = (a: HdAlgo) => leg(a, 'PE');

test('control catalogue: every kind has controls, defaults come from the readmes', () => {
  for (const k of HD_KINDS) assert.ok(controlsFor(k).length > 5, k);
  const adv = defaultControls('advanced_imbalance');
  assert.equal(adv.thresholdLotPct, 25);
  assert.equal(adv.thresholdStrikePct, 40);
  assert.equal(adv.maxLots, 4);
  assert.equal(adv.trailStartRs, 500);
  assert.equal(adv.trailGapRs, 300);
  assert.equal(adv.legSlPct, 20);
  assert.equal(adv.targetProfit, 25);
  assert.equal(adv.targetUnit, 'pct');
  const vw = defaultControls('vwap_straddle');
  assert.equal(vw.vwapWarmupBars, 10);
  assert.equal(vw.maxLossPerTrade, 1500);
  const dg = defaultControls('diagonal_call');
  assert.equal(dg.shortProfitPct, 65);
  assert.equal(dg.drawdownExitPct, 8);
  assert.equal(defaultControls('imbalance_strangle').entryBalancePct, 25);
});

test('imbalance and ATM helpers', () => {
  assert.equal(imbalancePct(100, 80), 20);
  assert.equal(imbalancePct(0, 0), 0);
  assert.equal(atmStrike(25024, 50), 25000);
  assert.equal(atmStrike(25026, 50), 25050);
});

test('resolveStrike: ATM, offset from spot, delta and premium pick OTM strikes', () => {
  const m = market({ px: ladder(100, 100) });
  const atm = resolveStrike({ option: 'CE', strikeBy: 'ATM', strikeValue: 0 }, m, EXP);
  assert.equal(atm?.strike, 25000);
  assert.equal(resolveStrike({ option: 'CE', strikeBy: 'OFFSET', strikeValue: 200 }, m, EXP)?.strike, 25200);
  assert.equal(resolveStrike({ option: 'PE', strikeBy: 'OFFSET', strikeValue: 200 }, m, EXP)?.strike, 24800);
  const byDelta = resolveStrike({ option: 'CE', strikeBy: 'DELTA', strikeValue: 0.2 }, m, EXP);
  assert.equal(byDelta?.strike, 25300); // delta 0.5 - dist/1000
  const byPrem = resolveStrike({ option: 'PE', strikeBy: 'PREMIUM', strikeValue: 50 }, m, EXP);
  assert.equal(byPrem?.strike, 24500);
  assert.equal(resolveStrike({ option: 'CE', strikeBy: 'ATM', strikeValue: 0 }, market(), EXP), null);
});

// ── value imbalance straddle ──────────────────────────────────────────────

test('imbalance straddle: waits for start time and for the premiums to balance', () => {
  const a = armed('imbalance_straddle');
  const early = stepAlgo(a, market({ px: ladder(100, 100), hm: '09:10' }));
  assert.ok(!early.legs.some(isOpen));
  const skewed = stepAlgo(a, market({ px: ladder(100, 70) }));       // 30% gap >= 15%
  assert.ok(!skewed.legs.some(isOpen));
  const ok = stepAlgo(a, market({ px: ladder(100, 95) }));           // 5%
  assert.equal(ce(ok).openLots, 1);
  assert.equal(pe(ok).strike, 25000);
  assert.equal(ok.tradesToday, 1);
  assert.ok(ok.entry && Math.abs(ok.entry.imbalance - 5) < 1e-9);
});

test('imbalance straddle: disarmed algo never enters', () => {
  const a = armed('imbalance_straddle', (x) => { x.armed = false; });
  assert.ok(!stepAlgo(a, market({ px: ladder(100, 100) })).legs.some(isOpen));
});

const noLimits = (x: HdAlgo) => { x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartPct = 0; };

test('imbalance straddle: adds a lot to the winner once imbalance beats baseline + threshold, one per bar', () => {
  let a = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  // CE decays to 70 (30% gap > 0% + 25%)
  a = stepAlgo(a, market({ px: ladder(70, 100), now: T0 + 1000 }));
  assert.equal(ce(a).openLots, 2);
  assert.equal(pe(a).openLots, 1);
  assert.equal(ce(a).avgEntry, 85);
  const baseAfter = a.entry!.imbalance;
  // value-weighted: 2 x 70 = 140 vs 100 -> 28.6%, the new baseline
  assert.ok(Math.abs(baseAfter - imbalancePct(140, 100)) < 1e-9);
  // same bar: no second adjustment
  const same = stepAlgo(a, market({ px: ladder(50, 100), now: T0 + 2000 }));
  assert.equal(ce(same).openLots, 2);
});

test('imbalance straddle: at max lots the loser rolls to the value-matched strike', () => {
  let a = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  ce(a).openLots = 4;                      // winner already at max lots
  // CE 20 x 4 lots = 80 vs PE 100 x 1: CE is the winner (lower value) and already at max lots.
  a = stepAlgo(a, market({ px: ladder(20, 100), now: T0 + 2 * MIN }));
  // atMax -> strike threshold 40 + baseline 0 ; imbalance = 20% -> not enough
  assert.equal(pe(a).strike, 25000);
  a = stepAlgo(a, market({ px: ladder(10, 100), now: T0 + 4 * MIN }));   // 40 vs 100 = 60% > 40
  assert.notEqual(pe(a).strike, 25000, 'PE rolled');
  assert.ok(pe(a).strike! < 25000, 'PE rolled further OTM');
  assert.equal(pe(a).openLots, 1);
  // value matched: target PE price = winner value 40 / 1 lot = 40, ladder gives 100 - 0.1*dist
  const roll = pe(a);
  assert.ok(Math.abs(roll.avgEntry - 40) <= 0.5, `rolled to ~40, got ${roll.avgEntry}`);
  assert.ok(a.events.some((e) => e.k === 'ROLL'));
});

test('imbalance straddle: ATM drift of the entry strike resets the cycle with a pause, then resumes', () => {
  let a = stepAlgo(armed('imbalance_straddle'), market({ px: ladder(100, 100) }));
  const m1 = market({ px: ladder(100, 100), spot: 25100, now: T0 + 1000 });
  a = stepAlgo(a, m1);
  assert.equal(a.phase, 'PAUSED');
  assert.ok(!a.legs.some(isOpen));
  assert.equal(a.pausedUntil, T0 + 1000 + 5 * MIN);
  // still paused 4 min later: no entry
  a = stepAlgo(a, market({ px: ladder(100, 100), spot: 25100, now: T0 + 4 * MIN }));
  assert.ok(!a.legs.some(isOpen));
  // 5 minutes after the exit: fresh cycle
  a = stepAlgo(a, market({ px: ladder(100, 100), spot: 25100, now: T0 + 1000 + 5 * MIN + 1 }));
  assert.equal(a.phase, 'ACTIVE');
  assert.equal(a.cycle, 2);
});

test('daily target and stop (₹) close everything and end the day', () => {
  const base = stepAlgo(armed('imbalance_straddle'), market({ px: ladder(100, 100) }));
  // short 1 lot (65) each: both legs fall 30 -> +3,900
  const hit = stepAlgo(base, market({ px: () => ({ ltp: 70 }), now: T0 + 10_000 }));
  // 2 x 30 x 65 = 3900 < 4000 target: still open
  assert.ok(hit.legs.some(isOpen));
  const hit2 = stepAlgo(base, market({ px: () => ({ ltp: 69 }), now: T0 + 10_000 }));   // 4030
  assert.equal(hit2.phase, 'DONE');
  assert.ok(!hit2.legs.some(isOpen));
  assert.equal(Math.round(hit2.cumRealized), 4030);
  const stop = stepAlgo(base, market({ px: () => ({ ltp: 131 }), now: T0 + 10_000 }));  // -4030
  assert.equal(stop.phase, 'DONE');
  assert.equal(Math.round(stop.cumRealized), -4030);
});

test('square-off closes the cycle at 15:17 and ends the day, armed or not', () => {
  const base = stepAlgo(armed('imbalance_straddle'), market({ px: ladder(100, 100) }));
  base.armed = false;
  const off = stepAlgo(base, market({ px: ladder(100, 100), hm: '15:17', now: T0 + 6 * 3600_000 }));
  assert.equal(off.phase, 'DONE');
  assert.ok(!off.legs.some(isOpen));
});

test('stops still run when the algo is disarmed (exits only reduce risk)', () => {
  const base = stepAlgo(armed('imbalance_straddle'), market({ px: ladder(100, 100) }));
  base.armed = false;
  const stop = stepAlgo(base, market({ px: () => ({ ltp: 131 }), now: T0 + 10_000 }));
  assert.equal(stop.phase, 'DONE');
});

test('premium trail: arms at 5% profit, exits when the combined premium rises 15 above its best', () => {
  let a = stepAlgo(armed('imbalance_straddle', (x) => { x.controls.targetProfit = 0; x.controls.stopLoss = 0; }), market({ px: () => ({ ltp: 100 }) }));
  assert.equal(a.entry!.premiumUnits, 200);
  a = stepAlgo(a, market({ px: () => ({ ltp: 90 }), now: T0 + 1000 }));   // 180 -> 10% profit: armed, best 180
  assert.ok(a.trail.armed);
  assert.equal(a.trail.best, 180);
  a = stepAlgo(a, market({ px: () => ({ ltp: 95 }), now: T0 + 2000 }));   // 190: 10 above best, still in
  assert.ok(a.legs.some(isOpen));
  a = stepAlgo(a, market({ px: () => ({ ltp: 98 }), now: T0 + 3000 }));   // 196 >= 195
  assert.ok(!a.legs.some(isOpen));
  assert.equal(a.phase, 'PAUSED');
});

// ── strangle ──────────────────────────────────────────────────────────────

test('strangle: enters OTM legs at 200 pts, resets when spot breaches a strike', () => {
  let a = stepAlgo(armed('imbalance_strangle', (x) => { x.controls.targetProfit = 0; x.controls.stopLoss = 0; }), market({ px: ladder(100, 100) }));
  assert.equal(ce(a).strike, 25200);
  assert.equal(pe(a).strike, 24800);
  a = stepAlgo(a, market({ px: ladder(100, 100), spot: 25199, now: T0 + 1000 }));
  assert.ok(a.legs.some(isOpen));
  a = stepAlgo(a, market({ px: ladder(100, 100), spot: 25200, now: T0 + 2000 }));
  assert.ok(!a.legs.some(isOpen));
  assert.equal(a.phase, 'PAUSED');
});

test('inversion guard refuses a strangle whose strikes cross', () => {
  const a = armed('imbalance_strangle', (x) => {
    ce(x).strikeValue = -300;   // ITM call 24700 vs OTM put 24800 -> crossed
    x.controls.entryBalancePct = 100;
  });
  const out = stepAlgo(a, market({ px: ladder(100, 100) }));
  assert.ok(!out.legs.some(isOpen));
  const off = armed('imbalance_strangle', (x) => { ce(x).strikeValue = -300; x.controls.inversionGuard = false; x.controls.entryBalancePct = 100; });
  assert.ok(stepAlgo(off, market({ px: ladder(100, 100) })).legs.some(isOpen));
});

// ── advanced modes ────────────────────────────────────────────────────────

test('advanced re-entry straddle: leg SL at +20%, waits, re-sells when price returns to entry', () => {
  let a = armed('advanced_imbalance', (x) => { x.controls.adjustMode = 'reentry_straddle'; x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0; });
  a = stepAlgo(a, market({ px: ladder(100, 100) }));
  assert.equal(ce(a).openLots, 1);
  a = stepAlgo(a, market({ px: (e, k, o) => (o === 'CE' ? { ltp: 121 } : { ltp: 100 }), now: T0 + 1000 }));
  assert.equal(ce(a).openLots, 0);
  assert.ok(ce(a).waitingReentry);
  assert.equal(pe(a).openLots, 1, 'the other leg is independent');
  assert.equal(Math.round(ce(a).realized), -21 * 65);
  // still above entry: no re-entry
  a = stepAlgo(a, market({ px: (e, k, o) => (o === 'CE' ? { ltp: 110 } : { ltp: 100 }), now: T0 + 2000 }));
  assert.equal(ce(a).openLots, 0);
  a = stepAlgo(a, market({ px: (e, k, o) => (o === 'CE' ? { ltp: 99 } : { ltp: 100 }), now: T0 + 3000 }));
  assert.equal(ce(a).openLots, 1);
  assert.equal(ce(a).reentries, 1);
  assert.equal(ce(a).avgEntry, 99);
});

test('advanced rupee trail: arms at ₹500, exits when MTM gives back ₹300', () => {
  let a = armed('advanced_imbalance', (x) => { x.controls.targetProfit = 0; x.controls.stopLoss = 0; });
  a = stepAlgo(a, market({ px: () => ({ ltp: 100 }) }));
  // +6 each leg = 780 > 500 : peak recorded
  a = stepAlgo(a, market({ px: () => ({ ltp: 94 }), now: T0 + 1000 }));
  assert.equal(Math.round(a.peakMtm), 780);
  a = stepAlgo(a, market({ px: () => ({ ltp: 96 }), now: T0 + 2000 }));  // 520: gave back 260
  assert.ok(a.legs.some(isOpen));
  a = stepAlgo(a, market({ px: () => ({ ltp: 97 }), now: T0 + 3000 }));  // 390: gave back 390 > 300
  assert.ok(!a.legs.some(isOpen));
});

test('advanced scalp lock exits at the % of entry premium and ends the day unless multi-cycle', () => {
  const tweak = (multi: boolean) => (x: HdAlgo) => {
    x.controls.scalpFloorPct = 5; x.controls.multiCycle = multi; x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0;
  };
  const a = stepAlgo(armed('advanced_imbalance', tweak(false)), market({ px: () => ({ ltp: 100 }) }));
  const hit = stepAlgo(a, market({ px: () => ({ ltp: 94 }), now: T0 + 1000 }));      // 12/200 = 6% >= 5%
  assert.equal(hit.phase, 'DONE');
  const b = stepAlgo(armed('advanced_imbalance', tweak(true)), market({ px: () => ({ ltp: 100 }) }));
  const multi = stepAlgo(b, market({ px: () => ({ ltp: 94 }), now: T0 + 1000 }));
  assert.equal(multi.phase, 'PAUSED');
  assert.equal(multi.pausedUntil, T0 + 1000 + 300_000);
});

test('advanced winner roll moves the winner toward ATM; a leg with no room is a structural deadlock', () => {
  let a = armed('advanced_imbalance', (x) => { x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0; });
  // strangle-like: CE 25200 / PE 24800 via offsets
  ce(a).strikeBy = 'OFFSET'; ce(a).strikeValue = 200; pe(a).strikeBy = 'OFFSET'; pe(a).strikeValue = 200;
  a = stepAlgo(a, market({ px: ladder(100, 100) }));
  assert.equal(ce(a).strike, 25200);
  // CE decays hard: CE value << PE value
  a = stepAlgo(a, market({ px: (e, k, o) => (o === 'CE' ? { ltp: 30 } : ladder(100, 100)(e, k, o)), now: T0 + 2 * MIN }));
  assert.ok(ce(a).strike! < 25200, 'CE winner rolled closer to ATM');
  // deadlock: 24950 / 25000 leaves no room
  let d = armed('advanced_imbalance', (x) => { x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0; });
  ce(d).strikeBy = 'OFFSET'; ce(d).strikeValue = 50;   // CE 25050 over an ATM put 25000: no room to roll the winner in
  d = stepAlgo(d, market({ px: ladder(100, 100) }));
  d = stepAlgo(d, market({ px: (e, k, o) => (o === 'CE' ? { ltp: 30 } : { ltp: 100 }), now: T0 + 2 * MIN }));
  assert.equal(d.phase, 'PAUSED');
});

test('advanced hedged addition adds a winner lot and buys a 200-pt hedge, ending the cycle at max lots', () => {
  let a = armed('advanced_imbalance', (x) => {
    x.controls.adjustMode = 'hedged_addition'; x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0; x.controls.maxLots = 2;
  });
  a = stepAlgo(a, market({ px: ladder(100, 100) }));
  a = stepAlgo(a, market({ px: ladder(60, 100), now: T0 + 2 * MIN }));
  assert.equal(ce(a).openLots, 2);
  const hedge = a.legs.find((l) => l.role === 'hedge')!;
  assert.equal(hedge.strike, ce(a).strike! + 200);
  assert.equal(hedge.side, 'B');
  assert.equal(hedge.openLots, 1);
  // at max lots the next trigger ends the cycle
  a = stepAlgo(a, market({ px: ladder(20, 100), now: T0 + 4 * MIN }));
  assert.ok(!a.legs.some(isOpen));
  assert.ok(!a.legs.some((l) => l.auto), 'hedge rows are cleared with the cycle');
});

test('loser ratio roll rolls the loser further OTM with extra lots', () => {
  let a = armed('advanced_imbalance', (x) => {
    x.controls.adjustMode = 'loser_ratio_roll'; x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0;
  });
  a = stepAlgo(a, market({ px: ladder(100, 100) }));
  a = stepAlgo(a, market({ px: ladder(60, 100), now: T0 + 2 * MIN }));
  assert.equal(pe(a).openLots, 2);
  assert.ok(pe(a).strike! < 25000);
});

// ── manual rows ───────────────────────────────────────────────────────────

test('row actions: enter now, per-leg exit, exiting the last leg ends the cycle and disarms', () => {
  const m = market({ px: ladder(100, 100), hm: '09:00' });
  const base = armed('imbalance_straddle');
  const e = enterAlgoNow(base, m);
  assert.ok(e.changed);
  assert.equal(ce(e.algo).openLots, 1);
  const x1 = exitLegNow(e.algo, ce(e.algo).id, m);
  assert.equal(ce(x1.algo).openLots, 0);
  assert.equal(pe(x1.algo).openLots, 1);
  assert.equal(x1.algo.armed, true);
  const x2 = exitLegNow(x1.algo, pe(x1.algo).id, m);
  assert.ok(!x2.algo.legs.some(isOpen));
  assert.equal(x2.algo.armed, false, 'armed algo must not re-enter on the next tick');
  const again = stepAlgo(x2.algo, m);
  assert.ok(!again.legs.some(isOpen));
});

test('row actions: single-leg entry, part exit by lots, exit all disarms', () => {
  const m = market({ px: ladder(100, 100) });
  const a = armed('imbalance_straddle', (x) => { ce(x).lots = 3; });
  const one = enterLegNow(a, ce(a).id, m);
  assert.equal(ce(one.algo).openLots, 3);
  assert.equal(pe(one.algo).openLots, 0);
  const part = exitLegNow(one.algo, ce(one.algo).id, m, 1);
  assert.equal(ce(part.algo).openLots, 2);
  const all = exitAllNow(part.algo, m);
  assert.ok(!all.algo.legs.some(isOpen));
  assert.equal(all.algo.armed, false);
});

test('a manual exit with no live price is refused once the last price is older than 30 s, and uses a recent one', () => {
  const m = market({ px: ladder(100, 100) });
  const e = enterAlgoNow(armed('imbalance_straddle'), m);
  const seen = stepAlgo(e.algo, market({ px: ladder(100, 100), now: T0 + 1000 }));   // stamps lastPx at T0+1000
  const old = exitLegNow(seen, ce(seen).id, market({ px: () => null, now: T0 + 1000 + 31_000 }));
  assert.equal(old.changed, false);
  assert.equal(ce(old.algo).openLots, 1);
  const recent = exitLegNow(seen, ce(seen).id, market({ px: () => null, now: T0 + 1000 + 20_000 }));
  assert.equal(recent.changed, true);
  assert.equal(ce(recent.algo).openLots, 0);
});

test('cycleMtm is null while an open leg has no price (stops never fire on a blank)', () => {
  const m = market({ px: ladder(100, 100) });
  const e = enterAlgoNow(armed('imbalance_straddle'), m);
  assert.equal(cycleMtm(e.algo, market({ px: () => null })), null);
  const stepped = stepAlgo(e.algo, market({ px: () => null, now: T0 + 1000 }));
  assert.ok(stepped.legs.some(isOpen));
});

test('limitRs converts % of entry premium; % of capital for the diagonal', () => {
  const a = armed('advanced_imbalance');
  a.refPremiumRs = 20_000;
  assert.equal(limitRs(a, 'targetProfit', 'targetUnit'), 5_000);
  const d = armed('diagonal_call');
  d.controls.targetProfit = 2; d.controls.targetUnit = 'pct';
  assert.equal(limitRs(d, 'targetProfit', 'targetUnit'), 20_000);
  assert.equal(limitRs(armed('diagonal_call'), 'targetProfit', 'targetUnit'), 0);
});

// ── VWAP straddle ─────────────────────────────────────────────────────────

test('vwap straddle: enters only after warm-up, under VWAP, on a decline; exits above VWAP + buffer', () => {
  let a = armed('vwap_straddle', (x) => { x.controls.vwapWarmupBars = 3; x.controls.declineTicks = 2; x.controls.targetProfit = 0; x.controls.stopLoss = 0; });
  let price = 100;
  const px = () => ({ ltp: price });
  let now = T0;
  const tick = (p: number, advanceMin = 0) => { price = p; now += advanceMin * MIN + 1000; a = stepAlgo(a, market({ px, now })); };
  // build 3 completed one-minute bars around combined 200 (price 100 each leg)
  tick(100); tick(100, 1); tick(100, 1); tick(100, 1);
  assert.ok(a.vwap!.bars.length >= 3);
  assert.ok(!a.legs.some(isOpen), 'flat premium: no decline gate');
  // decline: 100 -> 99 -> 98 (combined 198 < 200 two samples ago) and under VWAP
  tick(99); tick(98);
  assert.ok(a.legs.some(isOpen), 'entered on the decline under VWAP');
  assert.equal(a.tradesToday, 1);
  const vw = vwapOf(a.vwap!);
  // price rises above VWAP + 10 pts (combined)
  tick(108);
  assert.ok(vw > 0);
  assert.ok(!a.legs.some(isOpen), 'bought back above VWAP + buffer');
});

test('vwap straddle: hard per-trade loss stop and a cooldown after a losing cycle', () => {
  let a = armed('vwap_straddle', (x) => { x.controls.vwapWarmupBars = 1; x.controls.declineTicks = 1; x.controls.targetProfit = 0; x.controls.stopLoss = 0; });
  let price = 100; let now = T0;
  const px = () => ({ ltp: price });
  const tick = (p: number, minutes = 0) => { price = p; now += minutes * MIN + 1000; a = stepAlgo(a, market({ px, now })); };
  tick(100); tick(100, 1); tick(99);
  assert.ok(a.legs.some(isOpen));
  tick(112);   // loss ≈ 2*13*65 = 1690 > 1500
  assert.ok(!a.legs.some(isOpen));
  assert.equal(a.phase, 'PAUSED');
  assert.equal(a.pausedUntil! - now, 90_000);
});

// ── diagonal ──────────────────────────────────────────────────────────────

const diagPx = (_e: string, k: number, o: HdOption, exp: string): HdQuote | null => {
  if (o !== 'CE') return null;
  // delta falls with strike; far expiry (EXP2 = long) is pricier. 1000 pts of delta range.
  const delta = Math.min(0.95, Math.max(0.02, 0.6 - (k - 25000) / 1000));
  return { ltp: Math.max(1, (exp === 'L' ? 900 : 200) * delta), deltaAbs: delta };
};

function diagMarket(over: MarketOver = {}): HdMarket {
  const expiries = ['2026-11-10', '2026-12-29'];            // DTE 29 (short band) and 78 (long band)
  return market({
    hm: '10:00', expiries,
    dte: (e) => (e === expiries[0] ? 29 : 78),
    px: (e, k, o) => diagPx(e, k, o, e === expiries[1] ? 'L' : 'S'),
    ...over,
  });
}

test('diagonal helpers: expiry by DTE band, delta band, short sizing', () => {
  const m = diagMarket();
  assert.equal(pickExpiryByDte(m, 60, 120), '2026-12-29');
  assert.equal(pickExpiryByDte(m, 25, 45, '2026-12-29'), '2026-11-10');
  assert.equal(pickExpiryByDte(m, 25, 45, '2026-11-10'), null);
  assert.equal(pickDeltaStrike(m, '2026-12-29', 'CE', 0.6, 0.55, 0.65)?.strike, 25000);
  assert.equal(pickDeltaStrike(m, '2026-12-29', 'CE', 0.18, 0.97, 0.99), null, 'nothing outside the band');
  // 3 long lots @0.6 = 117 units; target +13; short 0.18 x 65 = 11.7/lot -> 9 raw, capped at 6 lots
  assert.equal(sizeShortLots({ longLots: 3, longDeltaAbs: 0.6, shortDeltaAbs: 0.18, lotSize: 65, targetNetDelta: 13, maxShortLots: 6, maxShortRatio: 1.25, free: false }), 6);
  // ratio cap: 1.25 x 117 / 11.7 = 12.5, not binding; a tight ratio binds
  assert.equal(sizeShortLots({ longLots: 3, longDeltaAbs: 0.6, shortDeltaAbs: 0.18, lotSize: 65, targetNetDelta: 13, maxShortLots: 20, maxShortRatio: 0.5, free: false }), 5);
  assert.equal(sizeShortLots({ longLots: 3, longDeltaAbs: 0.6, shortDeltaAbs: 0.18, lotSize: 65, targetNetDelta: 13, maxShortLots: 6, maxShortRatio: 1.25, free: true }), 3);
});

test('diagonal: at the first window buys the long, then sells a delta-sized short that ends before it', () => {
  const a = stepAlgo(armed('diagonal_call'), diagMarket());
  const lg = leg(a, 'CE', 'long');
  const sh = leg(a, 'CE', 'short');
  assert.equal(lg.openLots, 3);
  assert.equal(lg.expiryUsed, '2026-12-29');
  assert.equal(lg.strike, 25000);
  assert.ok(sh.openLots > 0 && sh.openLots <= 6);
  assert.equal(sh.expiryUsed, '2026-11-10');
  assert.ok(sh.strike! > 25000);
  const d = sh.entryDelta!;
  assert.ok(d >= 0.15 && d <= 0.22);
  assert.deepEqual(a.windowsDone, ['10:00']);
  // fires once per window
  const next = stepAlgo(a, diagMarket({ now: T0 + 1000 }));
  assert.equal(leg(next, 'CE', 'short').openLots, sh.openLots);
});

test('diagonal: short call rolls once 65% of its premium has decayed; the long stays', () => {
  let a = stepAlgo(armed('diagonal_call'), diagMarket());
  const oldStrike = leg(a, 'CE', 'short').strike;
  const entry = leg(a, 'CE', 'short').avgEntry;
  // short price collapses to 30% of entry (70% captured); delta unchanged so the replacement exists
  const m = diagMarket({
    now: T0 + MIN,
    px: (e, k, o) => {
      const q = diagPx(e, k, o, e === '2026-12-29' ? 'L' : 'S');
      if (q && e === '2026-11-10' && k === oldStrike) return { ...q, ltp: entry * 0.3 };
      return q;
    },
  });
  a = stepAlgo(a, m);
  assert.equal(leg(a, 'CE', 'long').openLots, 3);
  assert.ok(a.events.some((e) => e.k === 'ROLL'));
  assert.ok(leg(a, 'CE', 'short').realized > 0, 'decayed premium banked');
});

test('diagonal: short rolls on delta expansion past 0.35 even when profit take is suspended', () => {
  let a = stepAlgo(armed('diagonal_call'), diagMarket());
  a.suspendedDay = '2026-10-12';
  const strike = leg(a, 'CE', 'short').strike;
  a = stepAlgo(a, diagMarket({
    now: T0 + MIN,
    px: (e, k, o) => {
      const q = diagPx(e, k, o, e === '2026-12-29' ? 'L' : 'S');
      return q && e === '2026-11-10' && k === strike ? { ...q, deltaAbs: 0.4 } : q;
    },
  }));
  assert.ok(a.events.some((e) => e.k === 'ROLL'));
});

test('diagonal: drawdown exit liquidates and halts, shorts closed before the long', () => {
  let a = stepAlgo(armed('diagonal_call', (x) => { x.controls.capital = 100_000; }), diagMarket());
  // long collapses: 3 lots x 65 x big loss > 8% of 100k
  a = stepAlgo(a, diagMarket({
    now: T0 + MIN,
    px: (e, k, o) => {
      const q = diagPx(e, k, o, e === '2026-12-29' ? 'L' : 'S');
      return q && e === '2026-12-29' ? { ...q, ltp: q.ltp * 0.5 } : q;
    },
  }));
  assert.equal(a.phase, 'DONE');
  assert.equal(a.armed, false);
  assert.ok(!a.legs.some(isOpen));
});

test('diagonal: long call rolls (shorts first) when its DTE drops below 35', () => {
  let a = stepAlgo(armed('diagonal_call'), diagMarket());
  a = stepAlgo(a, diagMarket({ now: T0 + MIN, dte: (e) => (e === '2026-11-10' ? 29 : 30) }));
  assert.ok(!a.legs.some(isOpen));
  assert.ok(a.events.some((e) => e.msg.includes('rolling')));
});

// ── review fixes ──────────────────────────────────────────────────────────

test('one unpriced leg does not switch the stops off: the priced leg still stops out and the daily stop uses the last price', () => {
  let a = stepAlgo(armed('imbalance_straddle', (x) => { noLimits(x); ce(x).slPct = 20; }), market({ px: ladder(100, 100) }));
  // PE quote disappears; CE runs 25% against us
  const blindPe = (e: string, k: number, o: HdOption) => (o === 'PE' ? null : { ltp: 125 });
  a = stepAlgo(a, market({ px: blindPe, now: T0 + 1000 }));
  assert.equal(ce(a).openLots, 0, 'CE stopped despite the PE having no quote');
  assert.equal(cycleMtm(a, market({ px: blindPe })), null, 'display MTM stays strict');
  // daily stop: PE has no quote but its last price (100) is used
  let b = stepAlgo(armed('imbalance_straddle', (x) => { x.controls.targetProfit = 0; x.controls.trailStartPct = 0; x.controls.stopLoss = 1000; }), market({ px: () => ({ ltp: 100 }) }));
  b = stepAlgo(b, market({ px: (e, k, o) => (o === 'PE' ? null : { ltp: 130 }), now: T0 + 1000 }));   // CE -30*65 = -1950
  assert.equal(b.phase, 'DONE');
});

test('VWAP max-loss exit pauses for the cooldown (the pause is enforced, not just recorded)', () => {
  let a = armed('vwap_straddle', (x) => { x.controls.vwapWarmupBars = 1; x.controls.declineTicks = 1; x.controls.exitBuffer = 1000; x.controls.targetProfit = 0; x.controls.stopLoss = 0; });
  let price = 100; let now = T0;
  const tick = (p: number, minutes = 0) => { price = p; now += minutes * MIN + 1000; a = stepAlgo(a, market({ px: () => ({ ltp: price }), now })); };
  tick(100); tick(100, 1); tick(99);
  assert.ok(a.legs.some(isOpen));
  tick(112);   // -1690 > 1500 while the premium is nowhere near VWAP + 1000
  assert.ok(!a.legs.some(isOpen));
  assert.equal(a.phase, 'PAUSED');
  tick(98);    // inside the 90 s cooldown: must not re-enter
  assert.ok(!a.legs.some(isOpen));
});

test('a stuck exit logs its error once a minute, not every tick', () => {
  let a = stepAlgo(armed('imbalance_straddle'), market({ px: ladder(100, 100) }));
  a.legs.forEach((l) => { l.lastPx = undefined; });
  const blind = (t: number) => market({ px: () => null, hm: '15:20', now: t });
  for (let i = 0; i < 5; i++) a = stepAlgo(a, blind(T0 + i * 1000));
  assert.equal(a.events.filter((e) => e.k === 'ERROR').length, 1);
  assert.ok(a.legs.some(isOpen), 'still open, retried');
  a = stepAlgo(a, blind(T0 + 61_000));
  assert.equal(a.events.filter((e) => e.k === 'ERROR').length, 2);
});

test('re-entry log names the trigger price', () => {
  let a = armed('advanced_imbalance', (x) => { x.controls.adjustMode = 'reentry_straddle'; x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0; });
  a = stepAlgo(a, market({ px: ladder(100, 100) }));
  a = stepAlgo(a, market({ px: (e, k, o) => (o === 'CE' ? { ltp: 121 } : { ltp: 100 }), now: T0 + 1000 }));
  a = stepAlgo(a, market({ px: (e, k, o) => (o === 'CE' ? { ltp: 99 } : { ltp: 100 }), now: T0 + 2000 }));
  const msg = a.events.find((e) => e.k === 'REENTRY')!.msg;
  assert.ok(msg.includes('100.00') && !msg.includes('undefined'), msg);
});

test('day rollover with an unpriced open leg waits for a live price before the day baseline is set', () => {
  // a positional diagonal held overnight; yesterday's last price is far older than the allowed fallback age
  let a = stepAlgo(armed('diagonal_call', (x) => { x.controls.capital = 1_000_000; x.controls.stopLoss = 1000; }), diagMarket());
  const lg = leg(a, 'CE', 'long');
  lg.lastPx = lg.avgEntry + 20_000 / (lg.openLots * 65);
  lg.lastPxAt = T0;
  const blindNextDay = diagMarket({ day: '2026-10-13', now: T0 + 86_400_000, px: () => null });
  a = stepAlgo(a, blindNextDay);
  assert.equal(a.dayStartPending, true);
  assert.ok(a.legs.some(isOpen), 'nothing is booked at a day-old price');
  // first live price of the day: the baseline is set from it, so the carried gain is not "today's"
  const live = diagMarket({ day: '2026-10-13', now: T0 + 86_400_000 + 5000 });
  a = stepAlgo(a, live);
  assert.equal(a.dayStartPending, false);
  assert.ok(Math.abs(dayPnlOf(a, live) ?? NaN) < 1, 'day P&L starts at zero');
});

test('a last known price older than the age limit is not used to close or to mark a leg', () => {
  const base = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  const old = T0 + HD_LAST_PX_MAX_AGE_MS + 1000;
  const blind = market({ px: () => null, hm: '15:17', now: old });
  const off = stepAlgo(base, blind);
  assert.ok(off.legs.some(isOpen), 'stays open and is retried');
  assert.equal(cycleMtm(off, blind, true), null);
  assert.equal(off.events.filter((e) => e.k === 'ERROR').length, 1);
});

test('diagonal "Enter now" sells the missing short when the long is already open', () => {
  let a = stepAlgo(armed('diagonal_call'), diagMarket());
  const sh = leg(a, 'CE', 'short');
  a = exitLegNow(a, sh.id, diagMarket({ now: T0 + 1000 })).algo;
  assert.equal(leg(a, 'CE', 'short').openLots, 0);
  // the long's delta drifts outside the 0.55-0.65 band; a long re-pick would fail
  const drift = diagMarket({ now: T0 + 2000, px: (e, k, o) => { const q = diagPx(e, k, o, e === '2026-12-29' ? 'L' : 'S'); return q && e === '2026-12-29' ? { ...q, deltaAbs: 0.8 } : q; } });
  const r = enterAlgoNow(a, drift);
  assert.ok(r.changed, r.notes.join(' | '));
  assert.ok(leg(r.algo, 'CE', 'short').openLots > 0);
  // and when nothing can be sold it says so and reports no change
  const none = enterAlgoNow(a, diagMarket({ now: T0 + 3000, expiries: ['2026-12-29'], dte: () => 78 }));
  assert.equal(none.changed, false);
  assert.ok(none.notes.some((n) => n.includes('not sold')));
});

// ── second review fixes ───────────────────────────────────────────────────

test('hedge wing left open after the main legs stop out: the cycle still ends and the wing is closed', () => {
  let a = armed('advanced_imbalance', (x) => {
    x.controls.adjustMode = 'hedged_addition'; x.controls.targetProfit = 0; x.controls.stopLoss = 0; x.controls.trailStartRs = 0;
    ce(x).slPct = 30; pe(x).slPct = 30;
  });
  a = stepAlgo(a, market({ px: ladder(100, 100) }));
  a = stepAlgo(a, market({ px: ladder(60, 100), now: T0 + 2 * MIN }));          // winner +1 lot and a hedge wing
  assert.ok(a.legs.some((l) => l.role === 'hedge' && isOpen(l)));
  // both sold legs run 40% against us
  a = stepAlgo(a, market({ px: () => ({ ltp: 150 }), now: T0 + 3 * MIN }));
  assert.ok(!a.legs.some(isOpen), 'wing closed with the cycle');
  assert.equal(a.phase, 'PAUSED');
});

test('manual exit of the last main leg also closes a hedge wing and disarms', () => {
  const m = market({ px: ladder(100, 100) });
  let a = armed('advanced_imbalance', (x) => { x.controls.adjustMode = 'hedged_addition'; noLimits(x); x.controls.trailStartRs = 0; });
  a = stepAlgo(a, m);
  a = stepAlgo(a, market({ px: ladder(60, 100), now: T0 + 2 * MIN }));
  const mm = market({ px: ladder(60, 100), now: T0 + 3 * MIN });
  a = exitLegNow(a, ce(a).id, mm).algo;
  a = exitLegNow(a, pe(a).id, mm).algo;
  assert.ok(!a.legs.some(isOpen));
  assert.equal(a.armed, false);
});

test('a failed long-call roll keeps the free-long-call credit and retries', () => {
  let a = stepAlgo(armed('diagonal_call'), diagMarket());
  const credit = a.shortCredit;
  assert.ok(credit > 0);
  a.legs.forEach((l) => { l.lastPx = undefined; });
  const blind = diagMarket({ now: T0 + MIN, px: () => null, dte: (e) => (e === '2026-11-10' ? 29 : 30) });
  a = stepAlgo(a, blind);
  assert.ok(a.legs.some(isOpen), 'could not close, still open');
  assert.equal(a.shortCredit, credit);
});

test('a persistent SKIP is logged once a minute, not every tick', () => {
  let a = armed('diagonal_call');
  // no expiry in the long DTE band: the window closes, but a manual retry loop would spam
  for (let i = 0; i < 6; i++) {
    a = stepAlgo(a, diagMarket({ now: T0 + i * 1000, dte: () => 5 }));
  }
  assert.ok(a.events.filter((e) => e.k === 'SKIP').length <= 1);
});

test('lot controls above the cap are clamped so the ledger can always save them', () => {
  let a = stepAlgo(armed('imbalance_straddle', (x) => { noLimits(x); x.controls.maxLots = 300; ce(x).lots = 50; }), market({ px: ladder(100, 100) }));
  a = stepAlgo(a, market({ px: ladder(60, 100), now: T0 + 2 * MIN }));   // CE (50 lots) is already at the 50 cap
  assert.ok(ce(a).openLots <= 50);
});

// ── third review fixes ────────────────────────────────────────────────────

test('a stale spot holds entries and spot-based resets, but stops and the square-off still run', () => {
  const stale = (over: MarketOver = {}) => market({ px: ladder(100, 100), spotFresh: false, ...over });
  // no entry on a stale spot
  const none = stepAlgo(armed('imbalance_straddle'), stale());
  assert.ok(!none.legs.some(isOpen));
  // open, then the spot "moves" 150 pts while stale: no ATM-shift reset
  let a = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  a = stepAlgo(a, stale({ spot: 25150, now: T0 + 1000 }));
  assert.ok(a.legs.some(isOpen), 'no reset on a frozen spot');
  // a stop is price based and still fires
  let b = stepAlgo(armed('imbalance_straddle', (x) => { noLimits(x); ce(x).slPct = 20; }), market({ px: ladder(100, 100) }));
  b = stepAlgo(b, stale({ px: () => ({ ltp: 130 }), now: T0 + 1000 }));
  assert.equal(ce(b).openLots, 0);
  // and so does the square-off
  const off = stepAlgo(a, stale({ hm: '15:17', now: T0 + 2000 }));
  assert.equal(off.phase, 'DONE');
});

test('square-off with no live price books at the last known price and says so; manual exit-all follows the 30 s limit', () => {
  const base = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  const seen = stepAlgo(base, market({ px: () => ({ ltp: 90 }), now: T0 + 1000 }));   // last live price 90 at T0+1000
  const off = stepAlgo(seen, market({ px: () => null, hm: '15:17', now: T0 + 60_000 }));
  assert.equal(off.phase, 'DONE');
  const msg = off.events.find((e) => e.k === 'EXIT')!.msg;
  assert.ok(msg.includes('last known') && msg.includes('90.00'), msg);
  // manual exit-all: too old -> nothing closed; recent -> closed
  const tooOld = exitAllNow(seen, market({ px: () => null, now: T0 + 1000 + 60_000 }));
  assert.equal(tooOld.changed, false);
  assert.ok(tooOld.algo.legs.some(isOpen));
  assert.ok(tooOld.notes[0].includes('30 s'));
  const fresh = exitAllNow(seen, market({ px: () => null, now: T0 + 1000 + 10_000 }));
  assert.equal(fresh.changed, true);
  assert.ok(!fresh.algo.legs.some(isOpen));
});

test('a partly failed close still reports the stale-price legs in the EXIT event when it later completes', () => {
  let a = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  a = stepAlgo(a, market({ px: () => ({ ltp: 95 }), now: T0 + 1000 }));
  // CE has a last price; PE's was never stamped, so the first attempt closes CE at the stale price and fails on PE
  pe(a).lastPx = undefined; pe(a).lastPxAt = undefined;
  a = stepAlgo(a, market({ px: () => null, hm: '15:17', now: T0 + 5000 }));
  assert.ok(a.legs.some(isOpen));
  a = stepAlgo(a, market({ px: () => ({ ltp: 95 }), hm: '15:18', now: T0 + 6000 }));
  assert.ok(!a.legs.some(isOpen));
  const msg = a.events.filter((e) => e.k === 'EXIT').pop()!.msg;
  assert.ok(msg.includes('last known'), msg);
});

test('VWAP ticks stay bounded', () => {
  let a = armed('vwap_straddle');
  for (let i = 0; i < 300; i++) a = stepAlgo(a, market({ px: () => ({ ltp: 100 + (i % 3) }), now: T0 + i * 1000 }));
  assert.ok(a.vwap!.ticks.length <= 60);
});

test('the ledger key list covers every field of a new algo', () => {
  const keys = new Set<string>(HD_ALGO_KEYS);
  for (const k of Object.keys(newAlgo('imbalance_straddle', 'NIFTY'))) assert.ok(keys.has(k), `${k} missing from HD_ALGO_KEYS`);
});

// ── sixth review fixes ────────────────────────────────────────────────────

test('a single-leg manual exit at a last known price says so itself and does not leak into the cycle EXIT event', () => {
  let a = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  a = stepAlgo(a, market({ px: () => ({ ltp: 95 }), now: T0 + 1000 }));
  const r = exitLegNow(a, ce(a).id, market({ px: () => null, now: T0 + 1000 + 10_000 }));
  assert.ok(r.algo.events.some((e) => e.k === 'LEG_EXIT' && e.msg.includes('last known')));
  assert.equal(r.algo.staleCloses, undefined);
  // the cycle closes normally later: its EXIT event carries no stale-price note
  const done = stepAlgo(r.algo, market({ px: () => ({ ltp: 95 }), hm: '15:17', now: T0 + 20_000 }));
  assert.ok(!done.events.filter((e) => e.k === 'EXIT').pop()!.msg.includes('last known'));
});

test('the stale-price note list stays bounded', () => {
  let a = stepAlgo(armed('imbalance_straddle', noLimits), market({ px: ladder(100, 100) }));
  a.staleCloses = Array.from({ length: 40 }, (_, i) => `x${i}`);
  a = stepAlgo(a, market({ px: () => null, hm: '15:17', now: T0 + 5000 }));   // a close attempt that falls back
  assert.ok((a.staleCloses?.length ?? 0) <= 20);
});

test('a leg whose expiry has passed is settled and the cycle banked, so it cannot stay open for ever', () => {
  const a = armed('imbalance_straddle');
  a.day = '2026-10-12';
  a.phase = 'ACTIVE';
  const c = ce(a); const p = pe(a);
  Object.assign(c, { status: 'OPEN', strike: 25000, expiryUsed: EXP, openLots: 1, avgEntry: 100, lastPx: 60, lastPxAt: T0 - 5 * 60 * MIN });
  Object.assign(p, { status: 'OPEN', strike: 25000, expiryUsed: EXP, openLots: 1, avgEntry: 100 });
  const m = market({ now: T0 + 24 * 60 * MIN, day: '2026-10-14', hm: '09:30', px: () => null });
  const out = stepAlgo(a, m);
  assert.ok(!out.legs.some(isOpen));
  assert.equal(out.cycle, a.cycle + 1);
  assert.ok(out.events.some((e) => e.k === 'EXPIRY'));
  // CE settled at its last price 60 (+40/unit), PE at intrinsic floor 0.05 (spot 25000 = strike)
  assert.ok(out.cumRealized > 0);
});
