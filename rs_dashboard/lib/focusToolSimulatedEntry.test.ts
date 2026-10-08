/**
 * Simulated-market tests for the Focus Tool's entry side — Strike criteria, Qty ×, Overall Momentum, per-leg Simple
 * Momentum, Range Breakout, Lazy Legs, Overall re-entry, and the entry window — for CRUDEOILM and NIFTY.
 *
 *     node --test lib/focusToolSimulatedEntry.test.ts
 *
 * Scripted prices and a synthetic chain through the real rule functions. The order each rule leads to is placed by
 * FocusTool.tsx (placeLeg) and needs the page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCriteriaStrike, closestPremiumStrike, rowQtyMultiplier, multipliedLots, evaluateOverallExit,
  evaluateEntryMomentum, momentumTrigger, entryMomentumOn, simpleMomOn, simpleMomLevel, simpleMomHit,
  rangeBreakoutOn, rangeBreakoutHit, reRangeWindow, addMinutesHm, clampHm,
  runningLazyLeg, legSlMultiplier, legTarget, nextLazyLegId, lazyLegStrike, MAX_LAZY_LEGS,
  evaluateOverallReentry, MAX_OVERALL_REENTRIES, evaluateEntry, momentumReentryKind,
  EMPTY_ROW_LIVE, type ChainQuote,
} from './focusToolRules.ts';
import { UNDERLYING_META, orderQuantity, type FocusUnderlying } from './focusToolUnderlyings.ts';

interface Mkt { u: FocusUnderlying; lot: number; step: number; atm: number; atmPrem: number }
const MARKETS: Mkt[] = [
  { u: 'CRUDEOILM', lot: UNDERLYING_META.CRUDEOILM.unitsPerLot, step: UNDERLYING_META.CRUDEOILM.strikeStep, atm: 8850, atmPrem: 262 },
  { u: 'NIFTY', lot: 75, step: UNDERLYING_META.NIFTY.strikeStep, atm: 24000, atmPrem: 150 },
];

/** Premiums fall away from the money (CE cheaper above, PE cheaper below); deltas fall with them. */
function chain(m: Mkt): Record<string, ChainQuote> {
  const oc: Record<string, ChainQuote> = {};
  for (let k = -12; k <= 12; k++) {
    const strike = m.atm + k * m.step;
    oc[String(strike)] = {
      ce: Math.max(1, m.atmPrem - k * m.step * 0.4), pe: Math.max(1, m.atmPrem + k * m.step * 0.4),
      ceDelta: Math.min(95, Math.max(2, 50 - k * 4)), peDelta: Math.min(95, Math.max(2, 50 + k * 4)),
    };
  }
  return oc;
}

for (const m of MARKETS) {
  const tag = `[${m.u}]`;
  const oc = chain(m);
  const ctx = { atm: m.atm, step: m.step, oc };
  const meta = UNDERLYING_META[m.u];
  const listed = (s: number | null) => s != null && String(s) in oc;

  // ── Strike criteria ───────────────────────────────────────────────────────
  test(`${tag} criteria: ROUND picks the nearest round strike, OTM up for a CE and down for a PE`, () => {
    const iv = m.step * 2;                       // a 100-wide round interval on both underlyings
    const c = { ...ctx, roundInterval: iv };
    const nearest = Math.floor(m.atm / iv + 0.5) * iv;
    assert.equal(resolveCriteriaStrike('ROUND', 'CE', { a: '0' } as never, c), listed(nearest) ? nearest : null);
    const ce1 = resolveCriteriaStrike('ROUND', 'CE', { a: '1' } as never, c);
    const pe1 = resolveCriteriaStrike('ROUND', 'PE', { a: '1' } as never, c);
    assert.ok(ce1 != null && ce1 > m.atm && ce1 % iv === 0, 'OTM call above ATM, on the round grid');
    assert.ok(pe1 != null && pe1 < m.atm && pe1 % iv === 0, 'OTM put below ATM, on the round grid');
    assert.ok(listed(ce1) && listed(pe1));
    assert.equal(resolveCriteriaStrike('ROUND', 'CE', { a: '9999' } as never, c), null);   // off the chain: no strike, never a made-up one
  });

  test(`${tag} criteria: premium rules (≥, ≤, range) pick the right side of the target`, () => {
    const gte = resolveCriteriaStrike('PREM_GTE', 'CE', { a: '200' } as never, ctx)!;
    assert.ok(oc[String(gte)].ce >= 200 && oc[String(gte + m.step)].ce < 200 || gte === m.atm + 12 * m.step);   // the cheapest that is still ≥ 200
    const lte = resolveCriteriaStrike('PREM_LTE', 'CE', { a: '100' } as never, ctx)!;
    assert.ok(oc[String(lte)].ce <= 100 && oc[String(lte - m.step)].ce > 100);                                  // the richest that is still ≤ 100
    const range = resolveCriteriaStrike('PREM_RANGE', 'PE', { a: '50', b: '120' } as never, ctx)!;
    assert.ok(oc[String(range)].pe >= 50 && oc[String(range)].pe <= 120);
    assert.equal(resolveCriteriaStrike('PREM_RANGE', 'PE', { a: '120', b: '50' } as never, ctx), null);          // inverted range
    assert.equal(resolveCriteriaStrike('PREM_GTE', 'CE', { a: '' } as never, ctx), null);
    assert.equal(resolveCriteriaStrike('PREM_GTE', 'CE', { a: '99999' } as never, ctx), null);                   // nothing qualifies
  });

  test(`${tag} criteria: Straddle Width, % of ATM, Synthetic Future, ATM premium % always land on a listed strike`, () => {
    for (const [kind, crit] of [
      ['STRADDLE_WIDTH', { a: '0.5' }], ['STRADDLE_WIDTH', { a: '-0.5' }], ['PCT_ATM', { a: '1' }], ['PCT_ATM', { a: '-1' }],
      ['SYNTH_FUT', { a: '0' }], ['SYNTH_FUT', { a: '2' }], ['ATM_PREM_PCT', { a: '40' }],
    ] as const) {
      for (const leg of ['CE', 'PE'] as const) {
        const s = resolveCriteriaStrike(kind, leg, crit as never, ctx);
        assert.ok(s == null || listed(s), `${kind} ${leg} → ${s} is not a listed strike`);
      }
    }
    assert.ok(resolveCriteriaStrike('STRADDLE_WIDTH', 'CE', { a: '0.5' } as never, ctx)! > m.atm);
    assert.ok(resolveCriteriaStrike('PCT_ATM', 'PE', { a: '-1' } as never, ctx)! < m.atm);
    assert.equal(resolveCriteriaStrike('SYNTH_FUT', 'CE', { a: '0' } as never, ctx), m.atm);   // CE = PE at the money
    // no ATM / no chain: null, never a guess
    assert.equal(resolveCriteriaStrike('PCT_ATM', 'CE', { a: '1' } as never, { ...ctx, atm: 0 }), null);
    assert.equal(resolveCriteriaStrike('PCT_ATM', 'CE', { a: '1' } as never, { ...ctx, oc: undefined }), null);
  });

  test(`${tag} criteria: Delta picks the nearest delta, Delta Range the highest inside it, EXACT only a listed strike`, () => {
    const d = resolveCriteriaStrike('DELTA', 'CE', { a: '30' } as never, ctx)!;
    assert.ok(Math.abs(oc[String(d)].ceDelta! - 30) <= 2, 'within one strike of delta 30');
    const dr = resolveCriteriaStrike('DELTA_RANGE', 'CE', { a: '20', b: '40' } as never, ctx)!;
    assert.ok(oc[String(dr)].ceDelta! >= 20 && oc[String(dr)].ceDelta! <= 40);
    assert.equal(oc[String(dr)].ceDelta, 38);                                                    // highest qualifying (sell side)
    assert.equal(resolveCriteriaStrike('DELTA', 'CE', { a: '' } as never, ctx), null);           // blank is "not set", not delta 0
    assert.equal(resolveCriteriaStrike('DELTA_RANGE', 'CE', { a: '40', b: '20' } as never, ctx), null);
    assert.equal(resolveCriteriaStrike('EXACT', 'CE', { a: String(m.atm + 2 * m.step) } as never, ctx), m.atm + 2 * m.step);
    assert.equal(resolveCriteriaStrike('EXACT', 'CE', { a: String(m.atm + 1) } as never, ctx), null);   // between strikes
  });

  test(`${tag} criteria: a dead strike (zero OI) never wins on a stale price`, () => {
    const dead = { ...oc, [String(m.atm + 3 * m.step)]: { ce: 200, pe: 1, ceOi: 0, ceDelta: 30 } };
    const ceDelta = resolveCriteriaStrike('DELTA', 'CE', { a: '30' } as never, { ...ctx, oc: dead });
    assert.notEqual(ceDelta, m.atm + 3 * m.step);
    assert.notEqual(closestPremiumStrike(dead, 'CE', 200), m.atm + 3 * m.step);
  });

  // ── Qty × ─────────────────────────────────────────────────────────────────
  test(`${tag} Qty ×: lots and MTM limits scale, % limits do not, and the order quantity stays in whole lots`, () => {
    assert.equal(rowQtyMultiplier({}), 1);
    assert.equal(rowQtyMultiplier({ qtyMultiplier: 0 }), 1);
    assert.equal(rowQtyMultiplier({ qtyMultiplier: -3 }), 1);
    assert.equal(rowQtyMultiplier({ qtyMultiplier: 2.9 }), 2);
    assert.equal(multipliedLots({ qtyMultiplier: 3 }, 2), 6);
    assert.equal(multipliedLots({ qtyMultiplier: 3 }, 0), 0);
    // 2 lots × 3 → 6 lots → barrels internally → the broker still gets 6 lots on MCX, 6 × lot on NSE
    assert.equal(orderQuantity(m.u, multipliedLots({ qtyMultiplier: 3 }, 2) * m.lot), m.u === 'CRUDEOILM' ? 6 : 6 * m.lot);
    const row = (qm: number, o: object) => ({ side: 'BOTH', qtyMultiplier: qm, fill: { ceQty: m.lot, peQty: m.lot, ceStrike: 1, peStrike: 1, ts: '' }, ...o }) as never;
    const live = (pnl: number) => ({ ...EMPTY_ROW_LIVE, ltpCe: 100, ltpPe: 100, lotSize: m.lot, entryPremium: 300, pnl,
      cePosition: { netQty: -m.lot } as never, pePosition: { netQty: -m.lot } as never });
    const tgt = { overallTarget: { enabled: true, mode: 'mtm', value: '1000' } };
    assert.equal(evaluateOverallExit(row(1, tgt), live(1000), { pnl: 1000, pts: 0 }, undefined, m.lot)?.kind, 'target');
    assert.equal(evaluateOverallExit(row(2, tgt), live(1999), { pnl: 1999, pts: 0 }, undefined, m.lot), null);        // ₹1000 × 2
    assert.equal(evaluateOverallExit(row(2, tgt), live(2000), { pnl: 2000, pts: 0 }, undefined, m.lot)?.kind, 'target');
    const pct = { overallTarget: { enabled: true, mode: 'premiumPct', value: '10' } };
    assert.equal(evaluateOverallExit(row(5, pct), { ...live(0), ltpCe: 135, ltpPe: 135 }, { pnl: 0, pts: 30 }, undefined, m.lot)?.kind, 'target');   // % ignores the multiplier
  });

  // ── Overall Momentum ──────────────────────────────────────────────────────
  test(`${tag} Overall Momentum: releases at start ± points / %, remembers its start, waits without a quote`, () => {
    assert.equal(momentumTrigger(200, 'up', 'pts', 10), 210);
    assert.equal(momentumTrigger(200, 'down', 'pts', 10), 190);
    assert.equal(momentumTrigger(200, 'up', 'pct', 10), 220);
    assert.equal(momentumTrigger(200, 'down', 'pct', 10), 180);
    const row = (o: object = {}) => ({ entryMomEnabled: true, entryMomValue: '10', entryMomDir: 'up', entryMomUnit: 'pts', ...o }) as never;
    assert.equal(entryMomentumOn(row()), true);
    assert.equal(entryMomentumOn(row({ entryMomEnabled: false })), false);
    assert.equal(entryMomentumOn(row({ entryMomValue: '0' })), false);
    // replay: start 250, then 255, 259.9, 260 → releases on the third tick; the start never moves
    let ref: number | null = null, releasedAt = -1;
    [250, 255, 259.9, 260, 280].forEach((p, i) => {
      const d = evaluateEntryMomentum(row(), ref, p);
      ref = d.ref;
      if (d.ready && releasedAt < 0) releasedAt = i;
    });
    assert.equal(ref, 250);
    assert.equal(releasedAt, 3);
    assert.equal(evaluateEntryMomentum(row({ entryMomDir: 'down' }), 250, 240.01).ready, false);
    assert.equal(evaluateEntryMomentum(row({ entryMomDir: 'down' }), 250, 240).ready, true);
    assert.equal(evaluateEntryMomentum(row({ entryMomUnit: 'pct' }), 250, 274.99).ready, false);                      // 10 % of 250 = 25
    assert.equal(evaluateEntryMomentum(row({ entryMomUnit: 'pct' }), 250, 275).ready, true);
    assert.match(evaluateEntryMomentum(row(), null, null).reason, /waiting for a start premium/);
    assert.equal(evaluateEntryMomentum(row({ entryMomEnabled: false }), null, null).ready, true);                      // gate off
  });

  // ── Simple Momentum (per leg) ─────────────────────────────────────────────
  test(`${tag} Simple Momentum: per-leg premium or spot, up / down, points / %`, () => {
    const sm = (o: object = {}) => ({ enabled: true, value: '20', src: 'premium', unit: 'pts', dir: 'up', ...o }) as never;
    assert.equal(simpleMomOn(sm()), true);
    assert.equal(simpleMomOn(sm({ enabled: false })), false);
    assert.equal(simpleMomOn(sm({ value: '' })), false);
    assert.equal(simpleMomLevel(sm(), 100), 120);
    assert.equal(simpleMomLevel(sm({ dir: 'down' }), 100), 80);
    assert.equal(simpleMomLevel(sm({ unit: 'pct', value: '10' }), 200), 220);
    assert.equal(simpleMomLevel(sm({ dir: 'down', value: '150' }), 100), null);       // a fall to zero or below is unreachable
    assert.equal(simpleMomLevel(sm(), 0), null);
    assert.equal(simpleMomHit(sm(), 100, 119.99), false);
    assert.equal(simpleMomHit(sm(), 100, 120), true);
    assert.equal(simpleMomHit(sm({ dir: 'down' }), 100, 80.01), false);
    assert.equal(simpleMomHit(sm({ dir: 'down' }), 100, 80), true);
    assert.equal(simpleMomHit(sm(), 100, 0), false);                                     // no quote never releases
    // on the index: same maths against the spot, at this underlying's price scale
    const spot = sm({ src: 'underlying', unit: 'pts', value: String(m.step * 2), dir: 'down' });
    assert.equal(simpleMomHit(spot, m.atm, m.atm - 2 * m.step), true);
    assert.equal(simpleMomHit(spot, m.atm, m.atm - 2 * m.step + 1), false);
  });

  // ── Range Breakout ────────────────────────────────────────────────────────
  test(`${tag} Range Breakout: the range must end after the entry time, and a breakout is a touch`, () => {
    const rb = (end: string, o: object = {}) => ({ enabled: true, kind: 'intraday', end, side: 'high', on: 'instrument', ...o }) as never;
    const entry = m.u === 'CRUDEOILM' ? '21:30' : '09:20';
    const end = m.u === 'CRUDEOILM' ? '22:00' : '10:00';
    assert.equal(rangeBreakoutOn(rb(end), entry), true);
    assert.equal(rangeBreakoutOn(rb(entry), entry), false);                    // zero-length range
    assert.equal(rangeBreakoutOn(rb('9:5'), entry), false);                    // malformed
    assert.equal(rangeBreakoutOn(rb(end, { enabled: false }), entry), false);
    assert.equal(rangeBreakoutOn(rb('00:30', { kind: 'btst' }), entry), true); // BTST may end "earlier" — next day
    const range = { high: 270, low: 240 };
    assert.equal(rangeBreakoutHit({ side: 'high' }, range, 269.99), false);
    assert.equal(rangeBreakoutHit({ side: 'high' }, range, 270), true);
    assert.equal(rangeBreakoutHit({ side: 'low' }, range, 240.01), false);
    assert.equal(rangeBreakoutHit({ side: 'low' }, range, 240), true);
    assert.equal(rangeBreakoutHit({ side: 'high' }, range, 0), false);
  });

  test(`${tag} RE Momentum on a Range leg: a new range of the same length from now — none if it would pass midnight`, () => {
    if (m.u === 'CRUDEOILM') {
      assert.deepEqual(reRangeWindow('21:30', '22:00', '22:10'), { start: '22:10', end: '22:40' });
      assert.deepEqual(reRangeWindow('21:30', '22:00', '23:00'), { start: '23:00', end: '23:30' });   // MCX evening, still today
      assert.equal(reRangeWindow('21:30', '22:00', '23:45'), null);                                  // 23:45 + 30 min is past midnight
    }
    assert.deepEqual(reRangeWindow('09:20', '10:20', '10:45'), { start: '10:45', end: '11:45' });
    assert.equal(reRangeWindow('09:20', '10:20', '23:30'), null);              // would run past midnight
    assert.equal(reRangeWindow('10:00', '09:00', '10:30'), null);              // invalid original
    assert.equal(addMinutesHm('23:30', 29), '23:59');
    assert.equal(addMinutesHm('23:30', 30), null);
  });

  // ── Lazy Legs ─────────────────────────────────────────────────────────────
  const lazy = (o: object) => ({ id: 'a', leg: 'CE', otmSteps: 2, slPct: '30', slBasis: 'pct', tgtPct: '40', tgtUnit: 'pct', ...o });
  const lrow = (legs: object[], fill: object = {}, o: object = {}) =>
    ({ lazyLegs: legs, ceSlMultiplier: '1.2', peSlMultiplier: '1.2', ceTgtPct: '25', peTgtPct: '25', legTgtUnit: 'pct',
      fill: { ceQty: m.lot, peQty: m.lot, ceLazyId: 'a', ...fill }, ...o }) as never;

  test(`${tag} Lazy Legs: strike is OTM from ATM, its own SL / target replace the row's while it runs`, () => {
    assert.equal(lazyLegStrike({ leg: 'CE', otmSteps: 2 }, m.atm, m.step), m.atm + 2 * m.step);
    assert.equal(lazyLegStrike({ leg: 'PE', otmSteps: 2 }, m.atm, m.step), m.atm - 2 * m.step);
    assert.equal(lazyLegStrike({ leg: 'CE', otmSteps: -1 }, m.atm, m.step), m.atm - m.step);           // ITM
    const r = lrow([lazy({})]);
    assert.equal(runningLazyLeg(r, 'CE')?.id, 'a');
    assert.equal(runningLazyLeg(r, 'PE'), null);                                                        // not marked on the PE
    assert.equal(legSlMultiplier(r, 'CE'), 1.3);                                                        // lazy SL 30 % beats row ×1.2
    assert.equal(legSlMultiplier(r, 'PE'), '1.2');
    assert.deepEqual(legTarget(r, 'CE'), { value: '40', unit: 'pct' });
    assert.deepEqual(legTarget(r, 'PE'), { value: '25', unit: 'pct' });
    // a lazy leg on another SL basis has no SL ×
    assert.equal(legSlMultiplier(lrow([lazy({ slBasis: 'pts' })]), 'CE'), undefined);
    // ownership: a lazy id on a leg the row no longer holds is not running
    assert.equal(runningLazyLeg(lrow([lazy({})], { ceQty: 0 }), 'CE'), null);
    // an id with no matching leg is not running
    assert.equal(runningLazyLeg(lrow([lazy({ id: 'zz' })]), 'CE'), null);
    assert.equal(MAX_LAZY_LEGS, 10);
  });

  test(`${tag} Lazy Legs: chain through onSl / onTgt, root legs use the row's RE pick, a dangling id ends the line`, () => {
    const legs = [lazy({ id: 'a', onSl: 'b', onTgt: '' }), lazy({ id: 'b', onSl: '', onTgt: 'a' })];
    const base0 = { lazyLegs: legs };
    const base = base0 as never;
    assert.equal(nextLazyLegId(base, 'a', 'sl'), 'b');
    assert.equal(nextLazyLegId(base, 'a', 'tgt'), null);                    // no onTgt on a
    assert.equal(nextLazyLegId(base, 'b', 'tgt'), 'a');                     // chains back
    assert.equal(nextLazyLegId({ ...base0, reSlMode: 'lazy', reSlLazyId: 'b' } as never, null, 'sl'), 'b');
    assert.equal(nextLazyLegId({ ...base0, reSlMode: 'asap', reSlLazyId: 'b' } as never, null, 'sl'), null);   // only when the mode is Lazy
    assert.equal(nextLazyLegId({ ...base0, reSlMode: 'lazy', reSlLazyId: 'gone' } as never, null, 'sl'), null);
    assert.equal(nextLazyLegId({ ...base0, reTgtMode: 'lazy', reTgtLazyId: 'a' } as never, null, 'tgt'), 'a');
  });

  // ── Overall re-entry ──────────────────────────────────────────────────────
  test(`${tag} Overall re-entry: needs the rule set, respects the cap (max 5) and this underlying's own backstop`, () => {
    const c = (nowHm: string) => ({ nowHm, product: 'INTRADAY' as const, groupEnabled: true, backstopHm: meta.backstopHm });
    const row = (o: object = {}) => ({ slRupees: '5000', exitTime: '', noReEntryAfter: '', overallReSl: { enabled: true, mode: 'asap', max: 3 }, overallTarget: { enabled: true, mode: 'mtm', value: '9000' },
      overallReTgt: { enabled: true, mode: 'momentum', max: 9 }, ...o }) as never;
    const mid = m.u === 'CRUDEOILM' ? '22:00' : '10:00';
    assert.equal(evaluateOverallReentry(row(), 'sl', c(mid)).enter, true);
    assert.equal(evaluateOverallReentry(row({ overallReSlCount: 3 }), 'sl', c(mid)).enter, false);
    assert.equal(evaluateOverallReentry(row({ overallReTgtCount: MAX_OVERALL_REENTRIES }), 'target', c(mid)).enter, false);   // 9 is clamped to 5
    assert.equal(evaluateOverallReentry(row({ overallReTgtCount: MAX_OVERALL_REENTRIES - 1 }), 'target', c(mid)).enter, true);
    assert.equal(evaluateOverallReentry(row(), 'target', c(mid)).mode, 'momentum');
    assert.equal(evaluateOverallReentry(row({ slRupees: '' }), 'sl', c(mid)).enter, false);                  // no overall SL to re-enter on
    // the window: open just before this underlying's own backstop, closed at it
    const before = m.u === 'CRUDEOILM' ? '23:14' : '15:16';
    assert.equal(evaluateOverallReentry(row(), 'sl', c(before)).enter, true);
    assert.match(evaluateOverallReentry(row(), 'sl', c(meta.backstopHm)).reason, /intraday cutoff/);
  });

  // ── Entry window ──────────────────────────────────────────────────────────
  test(`${tag} entry: opens at the entry time inside this underlying's session, never past its exit time or backstop`, () => {
    const entryTime = m.u === 'CRUDEOILM' ? '21:30' : '09:20';
    const exitTime = m.u === 'CRUDEOILM' ? '23:10' : '15:15';
    const row0 = { status: 'armed', lots: 1, dte: 'Any', entryTime, exitTime };
    const row = row0 as never;
    const c = (nowHm: string, o: object = {}) => ({ nowHm, groupEnabled: true, product: 'INTRADAY' as const, backstopHm: meta.backstopHm, dte: 7, strikesReady: true, flat: true, ...o });
    const hm = (x: string, d: number) => addMinutesHm(x, d)!;
    assert.match(evaluateEntry(row, c(hm(entryTime, -1))).reason, /waiting for/);
    assert.equal(evaluateEntry(row, c(entryTime)).enter, true);
    assert.equal(evaluateEntry(row, c(hm(exitTime, -1))).enter, true);
    assert.match(evaluateEntry(row, c(exitTime)).reason, /exit time/);
    assert.match(evaluateEntry({ ...row0, exitTime: '' } as never, c(meta.backstopHm)).reason, /intraday cutoff/);
    assert.equal(evaluateEntry({ ...row0, exitTime: '' } as never, c(hm(meta.backstopHm, -1))).enter, true);
    assert.equal(evaluateEntry(row, c(entryTime, { flat: false })).enter, false);
    assert.equal(evaluateEntry(row, c(entryTime, { strikesReady: false })).enter, false);
    assert.equal(evaluateEntry({ ...row0, status: 'draft' } as never, c(entryTime)).enter, false);   // a draft never enters
    assert.equal(evaluateEntry({ ...row0, lots: 0 } as never, c(entryTime)).enter, false);
    assert.equal(evaluateEntry(row, c(entryTime, { groupEnabled: false })).enter, false);
  });

  test(`${tag} entry / exit time inputs clamp to THIS underlying's session, not NSE's`, () => {
    assert.equal(clampHm('00:05', meta.entryMinHm, meta.entryMaxHm), meta.entryMinHm);
    assert.equal(clampHm('23:50', meta.entryMinHm, meta.entryMaxHm), meta.entryMaxHm);
    assert.equal(clampHm('23:59', meta.exitMinHm, meta.exitMaxHm), meta.exitMaxHm);
    const mid = m.u === 'CRUDEOILM' ? '21:45' : '10:30';
    assert.equal(clampHm(mid, meta.entryMinHm, meta.entryMaxHm), mid);
    if (m.u === 'CRUDEOILM') assert.equal(clampHm('21:45', '09:16', '15:28'), '15:28', 'the NSE window would have rejected a valid MCX evening entry');
    // the exit window opens after the entry window. NSE lets a time be typed up to 15:29, past its 15:17 backstop, which then
    // is the effective exit (documented: auto-exit is hardcoded); MCX's whole window ends before its 23:15 backstop.
    assert.ok(meta.entryMinHm < meta.exitMinHm && meta.entryMaxHm < meta.exitMaxHm);
    assert.ok(meta.backstopHm > meta.entryMinHm);
    if (m.u === 'CRUDEOILM') assert.ok(meta.exitMaxHm < meta.backstopHm);
  });

  test(`${tag} RE MOMENTUM follows the leg's own momentum, else behaves like RE ASAP`, () => {
    const base = { entryTime: '09:20', entryMomEnabled: false, entryMomValue: '' };
    assert.equal(momentumReentryKind(base as never, 'CE'), 'asap');
    assert.equal(momentumReentryKind({ ...base, ceSimpleMom: { enabled: true, value: '10', src: 'premium', unit: 'pts', dir: 'up' } } as never, 'CE'), 'simple');
    assert.equal(momentumReentryKind({ ...base, ceSimpleMom: { enabled: true, value: '10', src: 'premium', unit: 'pts', dir: 'up' } } as never, 'PE'), 'asap');
    assert.equal(momentumReentryKind({ ...base, entryMomEnabled: true, entryMomValue: '5', ceSimpleMom: { enabled: true, value: '10', src: 'premium', unit: 'pts', dir: 'up' } } as never, 'CE'), 'combined');   // Overall wins
    assert.equal(momentumReentryKind({ ...base, ceRangeBreakout: { enabled: true, kind: 'intraday', end: '10:00', side: 'high', on: 'instrument' } } as never, 'CE'), 'range');
  });
}
