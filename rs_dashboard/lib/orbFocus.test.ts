import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREMIUM, legStopForDisplay, premiumHasStop, premiumTick, sanitizePremiumPatch, type PremiumConfig, type PremiumRowIn } from './orbFocus.ts';

// The Orb's straddle rules, decided by the Focus Tool's own functions. Hand-computed: NIFTY lot 65, 2 lots, CE sold at 100, PE at 90.

const cfg = (o: Partial<PremiumConfig> = {}): PremiumConfig => ({ ...DEFAULT_PREMIUM, legSlX: 1.5, totalSlPct: 0, totalSlRs: 0, targetValue: 0, ...o });
const row = (o: Partial<PremiumRowIn> = {}): PremiumRowIn => ({
  lots: 2, unitsPerLot: 65, lotUnits: 65,
  legs: [{ side: 'CE', entry: 100, units: 130, status: 'open' }, { side: 'PE', entry: 90, units: 130, status: 'open' }],
  ...o,
});
const tick = (c: PremiumConfig, r: PremiumRowIn, CE: number | null, PE: number | null, minute = 600) => premiumTick({ cfg: c, row: r, marks: { CE, PE }, minute, eodMin: 15 * 60 + 17 });

test('leg SL x: fires on the leg whose premium reaches entry x multiple, only that leg', () => {
  const r = tick(cfg(), row(), 150, 80);
  assert.equal(r.actions.length, 1);
  assert.deepEqual([r.actions[0].kind, (r.actions[0] as { index: number }).index, (r.actions[0] as { why: string }).why], ['stopLeg', 0, 'sl']);
  assert.equal(tick(cfg(), row(), 149.9, 134.9).actions.length, 0);     // CE below 150, PE below 135
  assert.equal((tick(cfg(), row(), 120, 135).actions[0] as { index: number }).index, 1);   // PE 90 x 1.5 = 135
});

test('SL to cost: once the other leg stopped, this leg exits when its premium climbs back to its entry', () => {
  const stopped = row({ legs: [{ side: 'CE', entry: 100, units: 130, status: 'closed', exit: 150 }, { side: 'PE', entry: 90, units: 130, status: 'open', costStop: true }] });
  assert.equal(tick(cfg({ slToCost: true }), stopped, null, 89).actions.length, 0);
  const r = tick(cfg({ slToCost: true }), stopped, null, 90);
  assert.equal((r.actions[0] as { why: string }).why, 'cost');
  // not armed (flag off or option off): the PE rides to its own SL x
  assert.equal(tick(cfg({ slToCost: false }), stopped, null, 100).actions.length, 0);
  assert.equal(tick(cfg({ slToCost: true }), row({ legs: [stopped.legs[0], { ...stopped.legs[1], costStop: false }] }), null, 100).actions.length, 0);
});

test('Trail SL: the leg stop moves closer for every step of profit and the steps are kept', () => {
  const c = cfg({ trail: { enabled: true, unit: 'pts', every: 10, by: 5, startAt: 0 } });
  // CE entry 100, now 80: 2 steps, stop 150 - 2 x 5 = 140
  assert.equal(legStopForDisplay(c, row(), 0, 80)?.level, 140);
  assert.equal(tick(c, row(), 80, 80).trailSteps[0], 2);
  assert.equal(tick(c, row(), 141, 80).actions.some(a => a.kind === 'stopLeg' && a.index === 0), false);  // the steps are only as saved: unsaved, 141 < 150
  // a step once earned is kept after the premium rebounds
  const kept = row({ legs: [{ side: 'CE', entry: 100, units: 130, status: 'open', trailSteps: 2 }, { side: 'PE', entry: 90, units: 130, status: 'open' }] });
  assert.equal(tick(c, kept, 141, 90).actions.some(a => a.kind === 'stopLeg'), true);
  assert.equal(tick(cfg(), kept, 141, 90).actions.length, 0);              // trail off: plain 150
});

test('leg target: the leg exits when its premium has decayed by the percentage', () => {
  const c = cfg({ legTgtPct: 40 });
  assert.equal(tick(c, row(), 61, 90).actions.length, 0);                  // 100 x 0.6 = 60
  const r = tick(c, row(), 60, 90);
  assert.deepEqual([(r.actions[0] as { why: string }).why, (r.actions[0] as { index: number }).index], ['tgt', 0]);
});

test('pair SL (total premium %): exits everything when the combined premium is up by the percentage', () => {
  const c = cfg({ legSlX: 0, totalSlPct: 30 });
  assert.equal(tick(c, row(), 130, 116).actions.length, 0);                // 246 < 190 x 1.3 = 247
  const r = tick(c, row(), 130, 117.1);
  assert.deepEqual([r.actions[0].kind, (r.actions[0] as { why: string }).why], ['exitAll', 'sl']);
  // a leg without a quote: the pair rule is not judged on a guess
  assert.equal(tick(c, row(), 500, null).actions.length, 0);
});

test('pair SL in rupees: exits when the P&L falls to minus the amount (2 lots x 65 x points)', () => {
  const c = cfg({ legSlX: 0, totalSlRs: 2000 });
  // CE +10, PE +5 against = -(10 + 5) x 130 = -1950: still inside
  assert.equal(tick(c, row(), 110, 95).actions.length, 0);
  assert.equal(tick(c, row(), 110, 96).actions[0]?.kind, 'exitAll');       // -2080
});

test('overall target: % of the combined entry premium, or rupees', () => {
  const pct = cfg({ legSlX: 0, targetMode: 'premiumPct', targetValue: 50 });
  assert.equal(tick(pct, row(), 52, 44).actions.length, 0);                // profit 94 pts < 95
  const r = tick(pct, row(), 50, 45);
  assert.deepEqual([r.actions[0].kind, (r.actions[0] as { why: string }).why], ['exitAll', 'target']);
  const rs = cfg({ legSlX: 0, targetMode: 'mtm', targetValue: 3000 });
  assert.equal(tick(rs, row(), 90, 80).actions.length, 0);                 // (10 + 10) x 130 = 2600
  assert.equal(tick(rs, row(), 85, 80).actions[0]?.kind, 'exitAll');       // 15 + 10 = 25 x 130 = 3250
  assert.ok(tick(rs, row(), 85, 80).peak.pnl >= 3250);
});

test('cutoff exits everything even with no quote; a closed row does nothing; legs already closed are not judged', () => {
  const r = tick(cfg(), row(), null, null, 15 * 60 + 17);
  assert.deepEqual([r.actions[0].kind, (r.actions[0] as { why: string }).why], ['exitAll', 'eod']);
  const done = row({ legs: row().legs.map(l => ({ ...l, status: 'closed' as const, exit: 80 })) });
  assert.equal(tick(cfg(), done, 500, 500, 15 * 60 + 20).actions.length, 0);
  const half = row({ legs: [{ ...row().legs[0], status: 'closed', exit: 150 }, row().legs[1]] });
  assert.equal(tick(cfg(), half, 999, 100).actions.length, 0);             // the closed CE's mark is ignored; PE 100 < 135
});

test('premium config: bounds, a stop is required for REAL, by must not exceed every', () => {
  assert.equal(premiumHasStop(DEFAULT_PREMIUM), true);
  assert.equal(premiumHasStop({ ...DEFAULT_PREMIUM, legSlX: 0, totalSlPct: 0, totalSlRs: 0 }), false);
  const ok = sanitizePremiumPatch({ legSlX: 2, totalSlPct: 40, targetValue: 60, slToCost: true, entryTime: '09:30' }, DEFAULT_PREMIUM);
  assert.ok(typeof ok !== 'string' && ok.legSlX === 2 && ok.totalSlPct === 40 && ok.slToCost && ok.entryTime === '09:30');
  assert.equal(typeof sanitizePremiumPatch({ legSlX: 1 }, DEFAULT_PREMIUM), 'string');        // must be above 1.05 or off
  assert.equal(typeof sanitizePremiumPatch({ legSlX: 0 }, DEFAULT_PREMIUM), 'object');        // off is allowed
  assert.equal(typeof sanitizePremiumPatch({ totalSlPct: 2 }, DEFAULT_PREMIUM), 'string');
  assert.equal(typeof sanitizePremiumPatch({ entryTime: '9:30' }, DEFAULT_PREMIUM), 'string');
  assert.equal(typeof sanitizePremiumPatch({ trail: { enabled: true, every: 5, by: 10 } }, DEFAULT_PREMIUM), 'string');
  const t = sanitizePremiumPatch({ trail: { enabled: true, unit: 'pct', every: 20, by: 10, startAt: 5 } }, DEFAULT_PREMIUM);
  assert.ok(typeof t !== 'string' && t.trail.enabled && t.trail.unit === 'pct' && t.trail.startAt === 5);
});

import { premiumEntryCheck } from './orbFocus.ts';

test('entry gate is the Focus Tool\'s: auto on, flat, trading day, from the entry time until the cutoff', () => {
  const base = { entryTime: '09:20', cutoffHm: '15:17', nowHm: '09:20', autoOn: true, flat: true, tradingDay: true };
  assert.equal(premiumEntryCheck(base).enter, true);
  assert.equal(premiumEntryCheck({ ...base, nowHm: '09:19' }).enter, false);
  assert.match(premiumEntryCheck({ ...base, nowHm: '09:19' }).reason, /waiting for 09:20/);
  assert.equal(premiumEntryCheck({ ...base, nowHm: '15:17' }).enter, false);
  assert.equal(premiumEntryCheck({ ...base, autoOn: false }).enter, false);
  assert.equal(premiumEntryCheck({ ...base, flat: false }).enter, false);
  assert.equal(premiumEntryCheck({ ...base, tradingDay: false }).enter, false);
});
