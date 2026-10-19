/**
 * Simulated-market tests for the Focus Tool "Leg Exits & Re-entry" controls —
 * CE SL / PE SL (SL ×, Points, Underlying pts / %, Delta), leg Trail SL, leg
 * target, RE on SL / RE on Tgt (off, ASAP, OTM, Cost, Momentum), the ×N cap and
 * the OTM strike roll.
 *
 *     node --test lib/focusToolSimulatedLegs.test.ts
 *
 * Scripted prices go through the real rule functions, for CRUDEOILM and NIFTY.
 * No broker, network or clock. The orchestration that places the orders after
 * a rule fires lives in FocusTool.tsx (autoExitLeg / reenterLegAfterExit) and
 * needs the page; the decisions it acts on are all here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_ROW_LIVE, legStopReason, legStopLevel, legTargetReason, reentryConfig, evaluateReentry, anchoredReentryLots,
  slRollStrike, reTgtOtmStrike, reentryOtmFromAtm, otmReentryStrike, matchPremiumStrike, legTargetProgress, dueScaleOutStep, scaleOutLots, scaleOutSteps, scaleOutStepsPassed, legLevelOn, levelSide, levelCrossStep, entryLevelFiredToday, levelSig, legFillEntry, legOwnEntry, pendingReentryLevel, pendingReentryHit, costReentryBasis, awaitingMomentumQuote,
  MAX_LEG_REENTRIES, DEFAULT_SL_ROLL_MAX,
  type RowLive,
} from './focusToolRules.ts';
import { readFileSync } from 'node:fs';
import { mtmForQty } from './focusToolPnl.ts';
import path from 'node:path';
import { UNDERLYING_META, FEED_BRIDGE_UNDERLYINGS, FEED_SESSION_START_HM, FEED_SESSION_END_HM, type FocusUnderlying } from './focusToolUnderlyings.ts';

interface Mkt { u: FocusUnderlying; lot: number; spot: number; step: number; ce: number; pe: number; backstop: string }
const MARKETS: Mkt[] = [
  { u: 'CRUDEOILM', lot: UNDERLYING_META.CRUDEOILM.unitsPerLot, spot: 8975, step: UNDERLYING_META.CRUDEOILM.strikeStep, ce: 278, pe: 246.05, backstop: UNDERLYING_META.CRUDEOILM.backstopHm },
  { u: 'NIFTY', lot: 75, spot: 24000, step: UNDERLYING_META.NIFTY.strikeStep, ce: 170, pe: 130, backstop: UNDERLYING_META.NIFTY.backstopHm },
];

type Leg = 'CE' | 'PE';
const entryOf = (m: Mkt, leg: Leg) => (leg === 'CE' ? m.ce : m.pe);

/** A row that sold 1 lot of each leg, with the ledger stamps a real entry writes. */
function rowFor(m: Mkt, o: object = {}, fill: object = {}) {
  return {
    side: 'BOTH', exitTime: '', noReEntryAfter: '', ceSlMultiplier: '1.2', peSlMultiplier: '1.2',
    fill: {
      ceQty: m.lot, peQty: m.lot, ceStrike: 1, peStrike: 1, ceEntry: m.ce, peEntry: m.pe,
      ceSpotEntry: m.spot, peSpotEntry: m.spot, ceDeltaEntry: 25, peDeltaEntry: 25, ceDeltaModel: true, peDeltaModel: true,
      ts: '', ...fill,
    },
    ...o,
  } as never;
}

function liveFor(m: Mkt, ce: number, pe: number, o: Partial<RowLive> = {}): RowLive {
  return {
    ...EMPTY_ROW_LIVE, ceStrike: 1, peStrike: 1, ltpCe: ce, ltpPe: pe, lotSize: m.lot,
    cePosition: { netQty: -m.lot, sellAvg: m.ce } as never, pePosition: { netQty: -m.lot, sellAvg: m.pe } as never, ...o,
  };
}

for (const m of MARKETS) {
  const tag = `[${m.u}]`;
  const legs: Leg[] = ['CE', 'PE'];

  // ── CE SL / PE SL ─────────────────────────────────────────────────────────
  test(`${tag} leg SL × (Percentage): fires at entry × mult on that leg only`, () => {
    for (const leg of legs) {
      const e = entryOf(m, leg), lvl = e * 1.2;
      const at = (p: number) => (leg === 'CE' ? liveFor(m, p, m.pe) : liveFor(m, m.ce, p));
      assert.equal(legStopReason(rowFor(m), leg, at(lvl - 0.01)), null);
      assert.match(legStopReason(rowFor(m), leg, at(lvl)) ?? '', new RegExp(`^${leg} SL ×1\\.2 hit`));
      // the other leg is untouched by this leg's premium
      const other: Leg = leg === 'CE' ? 'PE' : 'CE';
      assert.equal(legStopReason(rowFor(m), other, at(lvl)), null);
    }
  });

  test(`${tag} leg SL × off (blank / 1) never fires`, () => {
    assert.equal(legStopReason(rowFor(m, { ceSlMultiplier: '1', peSlMultiplier: '' }), 'CE', liveFor(m, m.ce * 5, m.pe)), null);
    assert.equal(legStopReason(rowFor(m, { ceSlMultiplier: '1', peSlMultiplier: '' }), 'PE', liveFor(m, m.ce, m.pe * 5)), null);
  });

  test(`${tag} leg SL basis Points: entry + N pts replaces SL ×`, () => {
    const row = rowFor(m, { ceSlRule: { enabled: true, basis: 'pts', value: '30' } });
    const lvl = m.ce + 30;                       // far inside SL ×1.2 for CRUDEOILM (55.6), beyond it for none
    assert.equal(legStopReason(row, 'CE', liveFor(m, lvl - 0.01, m.pe)), null);
    assert.match(legStopReason(row, 'CE', liveFor(m, lvl, m.pe)) ?? '', /^CE SL 30 pts hit/);
    // disabled rule falls back to SL ×
    const off = rowFor(m, { ceSlRule: { enabled: false, basis: 'pts', value: '30' } });
    assert.equal(legStopReason(off, 'CE', liveFor(m, lvl, m.pe)), null);
  });

  test(`${tag} leg SL basis Underlying pts / %: CE stops as the index rises, PE as it falls`, () => {
    const pts = rowFor(m, { ceSlRule: { enabled: true, basis: 'uPts', value: '100' }, peSlRule: { enabled: true, basis: 'uPts', value: '100' } });
    assert.equal(legStopReason(pts, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot + 99), null);
    assert.match(legStopReason(pts, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot + 100) ?? '', /^CE SL 100 pts on the index hit/);
    assert.equal(legStopReason(pts, 'PE', liveFor(m, m.ce, m.pe), undefined, m.spot - 99), null);
    assert.match(legStopReason(pts, 'PE', liveFor(m, m.ce, m.pe), undefined, m.spot - 100) ?? '', /^PE SL 100 pts on the index hit/);
    // the wrong direction never stops it
    assert.equal(legStopReason(pts, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot - 500), null);
    // %: 1% of spot
    const pct = rowFor(m, { ceSlRule: { enabled: true, basis: 'uPct', value: '1' } });
    const move = m.spot * 0.01;
    assert.equal(legStopReason(pct, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot + move - 0.01), null);
    assert.match(legStopReason(pct, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot + move) ?? '', /^CE SL 1% on the index hit/);
    // a failed spot read (0) must never stop a leg
    assert.equal(legStopReason(pts, 'CE', liveFor(m, m.ce, m.pe), undefined, 0), null);
  });

  test(`${tag} leg SL basis Delta: entry delta + N (a short 25, 15 → exits at 40)`, () => {
    const row = rowFor(m, { ceSlRule: { enabled: true, basis: 'delta', value: '15' } });
    assert.equal(legStopReason(row, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: 39.9 })), null);
    assert.match(legStopReason(row, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: 40 })) ?? '', /^CE SL 15 delta hit/);
    // no delta on the chain → no stop (never a false exit)
    assert.equal(legStopReason(row, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: null })), null);
    // capped at 100
    const capped = rowFor(m, { ceSlRule: { enabled: true, basis: 'delta', value: '90' } });
    assert.equal(legStopLevel(capped, 'CE', liveFor(m, m.ce, m.pe))?.level, 100);
  });

  test(`${tag} a flat or unowned leg has no stop`, () => {
    const flat = rowFor(m, {}, { ceQty: 0 });
    assert.equal(legStopReason(flat, 'CE', liveFor(m, m.ce * 9, m.pe)), null);
    const noPos = liveFor(m, m.ce * 9, m.pe, { cePosition: null });
    assert.equal(legStopReason(rowFor(m), 'CE', noPos), null);
  });

  // ── Trail SL (per leg) ────────────────────────────────────────────────────
  test(`${tag} leg Trail SL (points): the stop drops one step per "every" the premium falls`, () => {
    const row = rowFor(m, { ceTrailSl: { enabled: true, unit: 'pts', every: '20', by: '10' } });
    const base = m.ce * 1.2;
    const level = (ltp: number) => legStopLevel(row, 'CE', liveFor(m, ltp, m.pe), m.pe && ltp);
    assert.equal(level(m.ce)?.level, base);                        // no profit, untrailed
    assert.equal(level(m.ce - 19.9)?.level, base);                 // not a full step yet
    assert.equal(level(m.ce - 20)?.level, base - 10);              // 1 step
    assert.equal(level(m.ce - 40)?.level, base - 20);              // 2 steps
    assert.equal(level(m.ce - 40)?.trailed, 2);
    // Replay as the watcher runs it: each tick persists the steps earned (fill.ceTrailSteps), so the retrace
    // is measured against the trailed stop even though the premium is back above entry.
    let steps = 0, firedAt = -1;
    [m.ce, m.ce - 20, m.ce - 40, m.ce - 10, base - 20 - 0.01, base - 20].forEach((ltp, i) => {
      if (firedAt >= 0) return;
      const r = rowFor(m, { ceTrailSl: { enabled: true, unit: 'pts', every: '20', by: '10' } }, { ceTrailSteps: steps });
      const lvl = legStopLevel(r, 'CE', liveFor(m, ltp, m.pe), ltp);
      steps = Math.max(steps, lvl?.trailed ?? 0);
      if (legStopReason(r, 'CE', liveFor(m, ltp, m.pe))) firedAt = i;
    });
    assert.equal(steps, 2);
    assert.equal(firedAt, 5);       // stop = 1.2·entry − 20; fires exactly there, not one tick earlier
  });

  test(`${tag} leg Trail SL (%): step is a fixed % of the ENTRY, not of the current premium`, () => {
    const row = rowFor(m, { peTrailSl: { enabled: true, unit: 'pct', every: '10', by: '5' } });
    const every = m.pe * 0.10, by = m.pe * 0.05, base = m.pe * 1.2;
    assert.ok(Math.abs((legStopLevel(row, 'PE', liveFor(m, m.ce, m.pe - every), m.pe - every)?.level ?? 0) - (base - by)) < 1e-9);
    assert.ok(Math.abs((legStopLevel(row, 'PE', liveFor(m, m.ce, m.pe - 2 * every), m.pe - 2 * every)?.level ?? 0) - (base - 2 * by)) < 1e-9);
  });

  test(`${tag} leg Trail SL keeps steps already earned (premium bounces back)`, () => {
    const row = rowFor(m, { ceTrailSl: { enabled: true, unit: 'pts', every: '20', by: '10' } }, { ceTrailSteps: 2 });
    // premium back at entry, but 2 steps were banked
    assert.equal(legStopLevel(row, 'CE', liveFor(m, m.ce, m.pe), m.ce)?.level, m.ce * 1.2 - 20);
  });

  test(`${tag} leg Trail SL needs both amounts, and is ignored on an index stop`, () => {
    const half = rowFor(m, { ceTrailSl: { enabled: true, unit: 'pts', every: '20', by: '' } });
    assert.equal(legStopLevel(half, 'CE', liveFor(m, m.ce - 100, m.pe), m.ce - 100)?.trailed, 0);
    const idx = rowFor(m, { ceSlRule: { enabled: true, basis: 'uPts', value: '100' }, ceTrailSl: { enabled: true, unit: 'pts', every: '20', by: '10' } });
    assert.equal(legStopLevel(idx, 'CE', liveFor(m, m.ce - 100, m.pe), m.ce - 100)?.level, m.spot + 100);
  });

  test(`${tag} leg Trail SL (delta): falling delta lowers a delta stop`, () => {
    const row = rowFor(m, { ceSlRule: { enabled: true, basis: 'delta', value: '15' }, ceTrailSl: { enabled: true, unit: 'delta', every: '5', by: '5' } });
    // entry 25 → stop 40. delta 20 = one step of 5 → stop 35
    assert.equal(legStopLevel(row, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: 20 }), m.ce)?.level, 35);
    // steps persisted (as the watcher does): delta bounces back up to 34.9 → still under the trailed 35; 35 fires
    const kept = rowFor(m, { ceSlRule: { enabled: true, basis: 'delta', value: '15' }, ceTrailSl: { enabled: true, unit: 'delta', every: '5', by: '5' } }, { ceTrailSteps: 1 });
    assert.equal(legStopReason(kept, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: 34.9 })), null);
    assert.match(legStopReason(kept, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: 35 })) ?? '', /^CE SL 15 delta trailed 1× hit/);
  });

  // ── Leg target (RE on Tgt's trigger) ──────────────────────────────────────
  test(`${tag} leg target %, points`, () => {
    const pct = rowFor(m, { ceTgtPct: '30', legTgtUnit: 'pct' });
    const lvl = m.ce * 0.7;
    assert.equal(legTargetReason(pct, 'CE', liveFor(m, lvl + 0.01, m.pe)), null);
    assert.match(legTargetReason(pct, 'CE', liveFor(m, lvl, m.pe)) ?? '', /^CE target 30% hit/);
    const pts = rowFor(m, { peTgtPct: '40', legTgtUnit: 'pts' });
    assert.equal(legTargetReason(pts, 'PE', liveFor(m, m.ce, m.pe - 39.9)), null);
    assert.match(legTargetReason(pts, 'PE', liveFor(m, m.ce, m.pe - 40)) ?? '', /^PE target 40 pts hit/);
    // off / blank / a target at or below zero never fires
    assert.equal(legTargetReason(rowFor(m, { ceTgtPct: '' }), 'CE', liveFor(m, 0.5, m.pe)), null);
    assert.equal(legTargetReason(rowFor(m, { ceTgtPct: '100' }), 'CE', liveFor(m, 0.5, m.pe)), null);
  });

  test(`${tag} leg target on the index (pts / %) and on delta`, () => {
    const up = rowFor(m, { ceTgtPct: '100', peTgtPct: '100', legTgtUnit: 'uPts' });
    assert.equal(legTargetReason(up, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot - 99), null);       // short CE profits as the index FALLS
    assert.match(legTargetReason(up, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot - 100) ?? '', /^CE target 100 pts on the index hit/);
    assert.match(legTargetReason(up, 'PE', liveFor(m, m.ce, m.pe), undefined, m.spot + 100) ?? '', /^PE target 100 pts on the index hit/);
    assert.equal(legTargetReason(up, 'CE', liveFor(m, m.ce, m.pe), undefined, 0), null);                 // failed quote
    const pc = rowFor(m, { ceTgtPct: '1', legTgtUnit: 'uPct' });
    assert.match(legTargetReason(pc, 'CE', liveFor(m, m.ce, m.pe), undefined, m.spot * 0.99) ?? '', /^CE target 1% on the index hit/);
    const dl = rowFor(m, { ceTgtPct: '15', legTgtUnit: 'delta' });                                       // entry 25 − 15 = 10
    assert.equal(legTargetReason(dl, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: 10.1 })), null);
    assert.match(legTargetReason(dl, 'CE', liveFor(m, m.ce, m.pe, { ceDelta: 10 })) ?? '', /^CE target 15 delta hit/);
  });

  // ── RE on SL / RE on Tgt ──────────────────────────────────────────────────
  const ctx = (nowHm = '10:00', done = 0) => ({ nowHm, product: 'INTRADAY' as const, groupEnabled: true, backstopHm: m.backstop, done });

  test(`${tag} RE on SL / Tgt: every mode, the ×N cap, and legacy rows`, () => {
    for (const mode of ['asap', 'otm', 'cost', 'momentum', 'lazy'] as const) {
      const row = { reSlMode: mode, reSlMax: 3, reTgtMode: mode, reTgtMax: 2, slRollStrikes: 1, exitTime: '', noReEntryAfter: '' } as never;
      assert.equal(evaluateReentry(row, 'sl', ctx('10:00', 2)).enter, true);
      assert.equal(evaluateReentry(row, 'sl', ctx('10:00', 2)).mode, mode);
      assert.equal(evaluateReentry(row, 'sl', ctx('10:00', 3)).enter, false);   // ×3 used up
      assert.match(evaluateReentry(row, 'sl', ctx('10:00', 3)).reason, /limit 3/);
      assert.equal(evaluateReentry(row, 'tgt', ctx('10:00', 1)).enter, true);
      assert.equal(evaluateReentry(row, 'tgt', ctx('10:00', 2)).enter, false);  // target cap is its own
    }
    const off = { reSlMode: 'off', reTgtMode: 'off', exitTime: '', noReEntryAfter: '' } as never;
    assert.equal(evaluateReentry(off, 'sl', ctx()).enter, false);
    assert.equal(evaluateReentry(off, 'tgt', ctx()).enter, false);
    // "RE on Tgt: Off" is the default for a row that never set it
    assert.equal(evaluateReentry({ reSlMode: 'otm', exitTime: '', noReEntryAfter: '' } as never, 'tgt', ctx()).enter, false);
    // rows saved before modes existed: slRollStrikes > 0 meant OTM, cap 2
    const legacy = { slRollStrikes: 2, exitTime: '', noReEntryAfter: '' } as never;
    assert.deepEqual(reentryConfig(legacy, 'sl'), { mode: 'otm', max: DEFAULT_SL_ROLL_MAX, otmStrikes: 2 });
    assert.equal(reentryConfig({} as never, 'sl').mode, 'off');
  });

  test(`${tag} RE never opens into a closed window (exit time, backstop, No RE after, stopped index)`, () => {
    const row = (o: object = {}) => ({ reSlMode: 'asap', reSlMax: 3, exitTime: '', noReEntryAfter: '', ...o }) as never;
    assert.equal(evaluateReentry(row(), 'sl', ctx(m.backstop)).enter, false);
    assert.match(evaluateReentry(row(), 'sl', ctx(m.backstop)).reason, /intraday cutoff/);
    assert.match(evaluateReentry(row({ exitTime: '10:30' }), 'sl', ctx('10:30')).reason, /exit time/);
    assert.match(evaluateReentry(row({ noReEntryAfter: '10:15' }), 'sl', ctx('10:15')).reason, /no re-entry after/);
    assert.equal(evaluateReentry(row({ noReEntryAfter: '10:15' }), 'sl', ctx('10:14')).enter, true);
    assert.match(evaluateReentry(row(), 'sl', { ...ctx(), groupEnabled: false }).reason, /index not started/);
  });

  test(`${tag} OTM roll: CE re-sold N strikes UP, PE N strikes DOWN, one step = the underlying's strike step`, () => {
    const atm = Math.round(m.spot / m.step) * m.step;
    for (const n of [1, 2, 3]) {
      assert.equal(slRollStrike('CE', atm, n, m.step), atm + n * m.step);
      assert.equal(slRollStrike('PE', atm, n, m.step), atm - n * m.step);
    }
    assert.equal(slRollStrike('CE', atm, 0, m.step), atm);
    assert.equal(slRollStrike('CE', atm, -2, m.step), atm);          // never rolls the wrong way
    assert.equal(slRollStrike('PE', atm, 1.9, m.step), atm - m.step); // truncated, not rounded up
  });

  test(`${tag} RE OTM on target: N strikes OTM of the ATM now, not of the decayed strike`, () => {
    const atm = Math.round(m.spot / m.step) * m.step;
    // spot rallied: the PE that hit target sits far below; the new PE is N below the ATM now
    assert.equal(reTgtOtmStrike('PE', atm, 2, m.step), atm - 2 * m.step);
    assert.equal(reTgtOtmStrike('CE', atm, 2, m.step), atm + 2 * m.step);
    assert.equal(reTgtOtmStrike('CE', atm, 0, m.step), atm + m.step);   // at least one strike OTM
    assert.equal(reTgtOtmStrike('PE', null, 1, m.step), null);           // ATM unknown → no re-entry
    // its own strike count; the SL roll keeps slRollStrikes
    const row = { reSlMode: 'otm', reTgtMode: 'otm', slRollStrikes: 1, reTgtOtmStrikes: 3 } as never;
    assert.equal(reentryConfig(row, 'tgt').otmStrikes, 3);
    assert.equal(reentryConfig(row, 'sl').otmStrikes, 1);
    assert.equal(reentryConfig({ reTgtMode: 'otm' } as never, 'tgt').otmStrikes, 1);    // ATM-based on every target and on a stop that had trailed; a plain SL rolls from the closed strike
    assert.equal(reentryOtmFromAtm('tgt'), true);
    assert.equal(reentryOtmFromAtm('sl'), false);
    assert.equal(reentryOtmFromAtm('sl', 0), false);
    assert.equal(reentryOtmFromAtm('sl', 2), true);
  });

  test(`${tag} RE OTM strike: plain SL rolls, trailed SL never re-sells the stopped strike, ATM unknown`, () => {
    const atm = Math.round(m.spot / m.step) * m.step;
    const st = m.step;
    const pick = (o: Partial<Parameters<typeof otmReentryStrike>[0]>) => otmReentryStrike({
      trigger: 'sl', trailedSteps: 0, leg: 'CE', atm, closedStrike: atm + 4 * st, strikes: 1, step: st, ...o,
    });
    // plain SL: one further out than the closed strike, whatever ATM is
    assert.deepEqual(pick({}), { strike: atm + 5 * st, anchored: false });
    // trailed SL: from the ATM now …
    assert.deepEqual(pick({ trailedSteps: 1 }), { strike: atm + st, anchored: true });
    // … but landing on the strike that just stopped steps one further (CE up, PE down)
    assert.deepEqual(pick({ trailedSteps: 1, closedStrike: atm + st }), { strike: atm + 2 * st, anchored: true });
    assert.deepEqual(pick({ trailedSteps: 1, leg: 'PE', closedStrike: atm - st }), { strike: atm - 2 * st, anchored: true });
    // a target may re-sell the same strike (it made money there)
    assert.deepEqual(pick({ trigger: 'tgt', closedStrike: atm + st }), { strike: atm + st, anchored: true });
    // ATM unknown: a stop falls back to the roll; a target does not re-enter
    assert.deepEqual(pick({ trailedSteps: 2, atm: null }), { strike: atm + 5 * st, anchored: false });
    assert.deepEqual(pick({ trigger: 'tgt', atm: null }), { strike: null, anchored: true });
  });

  test(`${tag} RE OTM from Row: N beyond the strike a fresh entry would take, never closer than it`, () => {
    const atm = Math.round(m.spot / m.step) * m.step;
    const st = m.step;
    // row normally sells PE at ATM − 2; its target re-entry with N = 1 goes to ATM − 3, with N = 0 to ATM − 2
    const rowPe = atm - 2 * st;
    const pick = (o: Partial<Parameters<typeof otmReentryStrike>[0]>) => otmReentryStrike({
      trigger: 'tgt', trailedSteps: 0, leg: 'PE', atm, closedStrike: atm - 6 * st, strikes: 1, step: st,
      from: 'row', rowStrike: rowPe, ...o,
    });
    assert.deepEqual(pick({}), { strike: atm - 3 * st, anchored: true });
    assert.deepEqual(pick({ strikes: 0 }), { strike: rowPe, anchored: true });
    assert.deepEqual(pick({ leg: 'CE', rowStrike: atm + st }), { strike: atm + 2 * st, anchored: true });
    // the ATM is ignored from Row
    assert.deepEqual(pick({ atm: null }), { strike: atm - 3 * st, anchored: true });
    // trailed SL from Row: never the strike that stopped
    assert.deepEqual(pick({ trigger: 'sl', trailedSteps: 1, strikes: 0, closedStrike: rowPe }), { strike: rowPe - st, anchored: true });
    // row strike unknown: a stop rolls from the closed strike, a target does not re-enter
    assert.deepEqual(pick({ trigger: 'sl', trailedSteps: 1, rowStrike: null }), { strike: atm - 7 * st, anchored: false });
    assert.deepEqual(pick({ rowStrike: null }), { strike: null, anchored: true });
    // a plain SL is unaffected by the switch
    assert.deepEqual(pick({ trigger: 'sl', trailedSteps: 0 }), { strike: atm - 7 * st, anchored: false });
  });

  test(`${tag} RE MATCH: closest premium to the other leg, OTM side only, never the strike that closed`, () => {
    const atm = Math.round(m.spot / m.step) * m.step;
    const st = m.step;
    // PE premiums fall as the strike goes down (further OTM); one ITM PE is cheaper-looking noise that must be ignored
    const pe = [
      { strike: atm + st, px: 40 },          // ITM side — never chosen even though it is nearest 40
      { strike: atm, px: 100 },
      { strike: atm - st, px: 80 },
      { strike: atm - 2 * st, px: 62 },
      { strike: atm - 3 * st, px: 45 },
      { strike: atm - 4 * st, px: 30 },
      { strike: atm - 5 * st, px: 0 },       // unquoted — skipped
    ];
    const pick = (o: Partial<Parameters<typeof matchPremiumStrike>[0]>) =>
      matchPremiumStrike({ quotes: pe, leg: 'PE', target: 68, atm, exclude: null, ...o });
    assert.equal(pick({}), atm - 2 * st);                          // 62 is nearest 68
    assert.equal(pick({ target: 41 }), atm - 3 * st);              // 45, not the ITM 40
    assert.equal(pick({ exclude: atm - 2 * st }), atm - 3 * st);   // the closed strike → one further OTM
    assert.equal(pick({ target: 71 }), atm - 2 * st);              // tie 80/62 → the one further OTM
    assert.equal(pick({ target: 20, exclude: atm - 4 * st }), null); // nothing further OTM is quoted
    assert.equal(pick({ target: 0 }), null);
    assert.equal(pick({ atm: null }), null);
    // CE: OTM is at or above ATM
    const ce = [{ strike: atm - st, px: 70 }, { strike: atm, px: 95 }, { strike: atm + st, px: 72 }, { strike: atm + 2 * st, px: 50 }];
    assert.equal(matchPremiumStrike({ quotes: ce, leg: 'CE', target: 68, atm, exclude: null }), atm + st);
    assert.equal(matchPremiumStrike({ quotes: ce, leg: 'CE', target: 68, atm, exclude: atm + st }), atm + 2 * st);
  });

  test(`${tag} scale-out: progress toward the leg's own target, steps in order, reduce only and one lot kept`, () => {
    // premium % target: entry 100, target 40% → level 60; at 80 the leg is half way
    const r = rowFor(m, { ceTgtPct: '40' });
    const entry = m.ce;
    const at = (px: number) => legTargetProgress(r, 'CE', liveFor(m, px, m.pe));
    assert.ok(Math.abs((at(entry) ?? NaN) - 0) < 1e-9);
    assert.ok(Math.abs((at(entry * 0.8) ?? NaN) - 0.5) < 1e-9);
    assert.ok(Math.abs((at(entry * 0.6) ?? NaN) - 1) < 1e-9);
    assert.ok((at(entry * 1.1) ?? 0) < 0);                         // moving against it
    assert.equal(legTargetProgress(rowFor(m, { ceTgtPct: '' }), 'CE', liveFor(m, m.ce, m.pe)), null);   // no target
    // index target: PE gains as spot rises — 100 idx pts target, spot +50 = half way
    const ix = rowFor(m, { peTgtPct: '100', legTgtUnit: 'uPts' });
    assert.ok(Math.abs((legTargetProgress(ix, 'PE', liveFor(m, m.ce, m.pe), m.spot + 50) ?? NaN) - 0.5) < 1e-9);
    assert.ok((legTargetProgress(ix, 'PE', liveFor(m, m.ce, m.pe), m.spot - 50) ?? 0) < 0);

    const cfg = { enabled: true, steps: [{ at: '75', pct: 25 as const }, { at: '50', pct: 50 as const }, { at: '150', pct: 25 as const }] };
    assert.deepEqual(scaleOutSteps(cfg), [{ at: 50, pct: 50 }, { at: 75, pct: 25 }]);   // sorted; 150 dropped
    assert.equal(dueScaleOutStep(cfg, 0, 0.49), null);
    assert.deepEqual(dueScaleOutStep(cfg, 0, 0.5), { at: 50, pct: 50 });
    assert.equal(dueScaleOutStep(cfg, 50, 0.6), null);                 // 50 fired; 75 not reached
    assert.deepEqual(dueScaleOutStep(cfg, 50, 0.8), { at: 75, pct: 25 });
    assert.equal(dueScaleOutStep(cfg, 75, 0.99), null);                // ladder done
    assert.deepEqual(dueScaleOutStep(cfg, 0, 0.9), { at: 50, pct: 50 }); // a jump past both: lowest first
    assert.equal(dueScaleOutStep({ ...cfg, enabled: false }, 0, 0.9), null);
    assert.equal(dueScaleOutStep({ enabled: true, steps: 'junk' } as never, 0, 0.9), null);
    assert.equal(dueScaleOutStep(cfg, 0, null), null);
    // editing mid-trade: a step added BELOW the fired one is passed, never fired late …
    const added = { enabled: true, steps: [{ at: '25', pct: 25 as const }, { at: '50', pct: 50 as const }] };
    assert.equal(dueScaleOutStep(added, 50, 0.6), null);
    assert.equal(scaleOutStepsPassed(added, 50), 2);
    // … and removing a lower step cannot make a higher one skip or re-fire
    const removed = { enabled: true, steps: [{ at: '75', pct: 25 as const }] };
    assert.deepEqual(dueScaleOutStep(removed, 50, 0.8), { at: 75, pct: 25 });
    assert.equal(dueScaleOutStep(removed, 75, 0.9), null);

    const lot = 65;
    assert.equal(scaleOutLots(8 * lot, 8 * lot, lot, 50), 4);
    assert.equal(scaleOutLots(8 * lot, 4 * lot, lot, 25), 2);         // % of the BASE, not of what is left
    assert.equal(scaleOutLots(4 * lot, 4 * lot, lot, 75), 3);
    assert.equal(scaleOutLots(4 * lot, 2 * lot, lot, 75), 1);         // never the last lot
    assert.equal(scaleOutLots(1 * lot, 1 * lot, lot, 75), 0);
    assert.equal(scaleOutLots(3 * lot, 3 * lot, lot, 25), 0);         // 0.75 lot rounds down
    assert.equal(scaleOutLots(8 * lot, 8 * lot, 0, 50), 0);
  });

  test(`${tag} index levels per leg: a level fires only on a REAL cross`, () => {
    const up = { level: String(m.spot + 100), dir: 'above' as const };
    const dn = { level: String(m.spot - 100), dir: 'below' as const };
    assert.equal(legLevelOn(up), true);
    assert.equal(legLevelOn({ level: '', dir: 'above' }), false);
    assert.equal(legLevelOn({ level: '-5', dir: 'above' }), false);
    assert.equal(legLevelOn({ level: '23000', dir: 'sideways' } as never), false);
    assert.equal(legLevelOn(undefined), false);
    assert.equal(levelSide(up, m.spot), 'safe');
    assert.equal(levelSide(up, m.spot + 100), 'trigger');            // exactly at the level counts
    assert.equal(levelSide(dn, m.spot - 100), 'trigger');
    assert.equal(levelSide(up, 0), null);

    // started on the safe side: crossing fires
    let st = levelCrossStep(false, up, m.spot);
    assert.deepEqual(st, { seenSafe: true, hit: false });
    st = levelCrossStep(st.seenSafe, up, m.spot + 120);
    assert.equal(st.hit, true);
    // started already past it: no fire until spot has gone back and crossed again
    let p = levelCrossStep(false, up, m.spot + 150);
    assert.deepEqual(p, { seenSafe: false, hit: false });
    p = levelCrossStep(p.seenSafe, up, m.spot + 200);
    assert.equal(p.hit, false);
    p = levelCrossStep(p.seenSafe, up, m.spot + 50);                  // back below
    p = levelCrossStep(p.seenSafe, up, m.spot + 101);
    assert.equal(p.hit, true);
    // below-levels mirror it; an unknown spot changes nothing
    let d = levelCrossStep(false, dn, m.spot - 150);
    assert.equal(d.hit, false);
    d = levelCrossStep(d.seenSafe, dn, 0);
    assert.deepEqual(d, { seenSafe: false, hit: false });
    d = levelCrossStep(true, dn, m.spot - 100);
    assert.equal(d.hit, true);

    assert.equal(entryLevelFiredToday({ ...up, firedOn: '2026-10-16' }, '2026-10-16'), true);
    assert.equal(entryLevelFiredToday({ ...up, firedOn: '2026-10-15' }, '2026-10-16'), false);
    assert.equal(entryLevelFiredToday(up, '2026-10-16'), false);
    // a "seen" mark belongs to one exact setting: any edit of level or direction is a different signature
    assert.equal(levelSig(up), levelSig({ level: `${m.spot + 100}.0`, dir: 'above' }));
    assert.notEqual(levelSig(up), levelSig({ ...up, dir: 'below' }));
    assert.notEqual(levelSig(up), levelSig({ ...up, level: String(m.spot + 50) }));
  });

  test(`${tag} P&L basis: the actual fill price, separate from the stop reference`, () => {
    // stop reference stamped at the LTP before the order; the broker filled 1.5 better
    const r = rowFor(m, {}, { ceEntry: m.ce, ceFillEntry: m.ce + 1.5 });
    assert.equal(legFillEntry(r, 'CE', liveFor(m, m.ce, m.pe)), m.ce + 1.5);
    assert.equal(legOwnEntry(r, 'CE', liveFor(m, m.ce, m.pe)), m.ce);          // stops / targets unchanged
    // no fill price recorded yet (older row, or the traded price not back yet): the stop reference
    assert.equal(legFillEntry(rowFor(m), 'CE', liveFor(m, m.ce, m.pe)), m.ce);
    // a booked close at the real fills: sold at entry + 1.5, bought back at 10 below
    const exit = m.ce - 10;
    assert.equal(mtmForQty({ netQty: -m.lot, buyAvg: 0, sellAvg: legFillEntry(r, 'CE', liveFor(m, m.ce, m.pe)), ltp: exit, qty: m.lot }),
      (m.ce + 1.5 - exit) * m.lot);
  });

  test(`${tag} Tgt OTM count: missing = 1, 0 allowed only from Row`, () => {
    assert.equal(reentryConfig({ reTgtMode: 'otm' } as never, 'tgt').otmStrikes, 1);
    assert.equal(reentryConfig({ reTgtMode: 'otm', reOtmFrom: 'row' } as never, 'tgt').otmStrikes, 1);
    assert.equal(reentryConfig({ reTgtMode: 'otm', reOtmFrom: 'row', reTgtOtmStrikes: 0 } as never, 'tgt').otmStrikes, 0);
    assert.equal(reentryConfig({ reTgtMode: 'otm', reTgtOtmStrikes: 0 } as never, 'tgt').otmStrikes, 1);
  });

  test(`${tag} ATM-anchored re-entry size: whole lots, never below one`, () => {
    assert.equal(anchoredReentryLots(4, 50), 2);
    assert.equal(anchoredReentryLots(3, 50), 1);
    assert.equal(anchoredReentryLots(1, 50), 1);
    assert.equal(anchoredReentryLots(5, 25), 1);
    assert.equal(anchoredReentryLots(4, undefined), 4);
    assert.equal(anchoredReentryLots(4, 100), 4);
    assert.equal(anchoredReentryLots(4, 0), 4);
    assert.equal(anchoredReentryLots(0, 50), 0);
  });

  test(`${tag} RE Cost / Momentum: what a waiting re-entry waits for`, () => {
    // Cost, after an SL: premium ran UP through the stop, wait for it to fall back to entry
    const afterSl = pendingReentryLevel('cost', 'sl', { entry: m.ce });
    assert.deepEqual(afterSl, { price: m.ce, dir: 'down' });
    assert.equal(pendingReentryHit(afterSl!, m.ce + 0.01), false);
    assert.equal(pendingReentryHit(afterSl!, m.ce), true);
    // after a target: premium decayed, wait for it to climb back to entry
    const afterTgt = pendingReentryLevel('cost', 'tgt', { entry: m.ce });
    assert.deepEqual(afterTgt, { price: m.ce, dir: 'up' });
    assert.equal(pendingReentryHit(afterTgt!, m.ce - 0.01), false);
    assert.equal(pendingReentryHit(afterTgt!, m.ce), true);
    assert.equal(pendingReentryLevel('cost', 'sl', { entry: 0 }), null);            // nothing sane to wait for
    // an unquoted price never "hits"
    assert.equal(pendingReentryHit(afterSl!, 0), false);
    // Momentum: the leg's Simple Momentum from the new strike's premium
    const simple = { enabled: true, value: '10', src: 'premium' as const, unit: 'pts' as const, dir: 'up' as const };
    assert.deepEqual(pendingReentryLevel('momentum', 'sl', { start: 100, simple }), { price: 110, dir: 'up' });
    assert.equal(pendingReentryLevel('momentum', 'sl', { start: 100, simple: null }), null);
    assert.equal(awaitingMomentumQuote({ mode: 'momentum', price: 0 }), true);
    assert.equal(awaitingMomentumQuote({ mode: 'momentum', price: 110 }), false);
    assert.equal(awaitingMomentumQuote({ mode: 'cost', price: 0 }), false);
  });

  test(`${tag} RE Cost basis sticks to the strike it was recorded on`, () => {
    assert.deepEqual(costReentryBasis({ strike: 100, price: 50 }, 100, 60), { strike: 100, price: 50 });
    assert.deepEqual(costReentryBasis({ strike: 100, price: 50 }, 150, 60), { strike: 150, price: 60 });   // new strike: its own entry
    assert.equal(costReentryBasis(null, 150, 0), null);
  });

  // ── A whole RE-on-SL OTM cycle, replayed ──────────────────────────────────
  test(`${tag} replay: CE stopped out over and over rolls OTM and stops after ×3`, () => {
    const atm = Math.round(m.spot / m.step) * m.step;
    const reRow = { reSlMode: 'otm', reSlMax: 3, slRollStrikes: 1, exitTime: '', noReEntryAfter: '' } as never;
    let strike = atm, done = 0;
    const sold: number[] = [strike];
    for (let stop = 0; stop < 6; stop++) {
      // the live leg's stop hits (SL × on its own entry), then the page asks for a re-entry
      const entry = m.ce, row = rowFor(m, {}, { ceEntry: entry });
      assert.ok(legStopReason(row, 'CE', liveFor(m, entry * 1.25, m.pe)));
      const d = evaluateReentry(reRow, 'sl', ctx('10:00', done));
      if (!d.enter) break;
      done++;
      strike = slRollStrike('CE', strike, reentryConfig(reRow as never, 'sl').otmStrikes, m.step);
      sold.push(strike);
    }
    assert.equal(done, 3);
    assert.deepEqual(sold, [atm, atm + m.step, atm + 2 * m.step, atm + 3 * m.step]);
  });
}

test('AlgoTest cap on re-entries per leg is 20', () => {
  assert.equal(MAX_LEG_REENTRIES, 20);
});

// The rules default to NSE's 15:17 backstop. A caller that forgets backstopHm silently blocks every
// MCX (CRUDEOILM, trades to 23:15) re-entry after 15:17 IST — found live on 2026-10-08, RE OTM never re-sold.
test('the 15:17 default is NSE-only: a CRUDEOILM re-entry needs the caller to pass its own backstop', () => {
  const row = { reSlMode: 'asap', reSlMax: 3, exitTime: '', noReEntryAfter: '' } as never;
  const base = { nowHm: '22:00', product: 'INTRADAY' as const, groupEnabled: true, done: 0 };
  assert.equal(evaluateReentry(row, 'sl', base as never).enter, false);                                     // the trap (backstopHm is required by tsc now)
  assert.equal(evaluateReentry(row, 'sl', { ...base, backstopHm: UNDERLYING_META.CRUDEOILM.backstopHm }).enter, true);
});

test('every evaluateReentry / reentryWindowClosed / evaluateEntry call in FocusTool.tsx passes backstopHm', () => {
  const src = readFileSync(path.join(import.meta.dirname, '..', 'components', 'FocusTool.tsx'), 'utf-8');
  const re = /\b(evaluateReentry|reentryWindowClosed|evaluateEntry|evaluateOverallReentry)\(/g;
  let m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(src))) {
    // the call's argument text: up to the matching close paren
    let depth = 0, i = m.index + m[0].length - 1, end = i;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) { end = i; break; } }
    const call = src.slice(m.index, end + 1);
    if (/^(?:evaluateEntry|reentryWindowClosed)\(/.test(call) && /import|function /.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    n++;
    assert.match(call, /backstopHm/, `missing backstopHm: ${call.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  assert.ok(n >= 5, `expected to find the page's calls, found ${n}`);
});

test('a saved re-entry cap is clamped to 0..20, whatever the file says', () => {
  const cfg = (o: object) => reentryConfig({ reSlMode: 'asap', reTgtMode: 'asap', ...o } as never, 'sl').max;
  assert.equal(cfg({ reSlMax: 99 }), MAX_LEG_REENTRIES);
  assert.equal(cfg({ reSlMax: -3 }), 0);
  assert.equal(cfg({ reSlMax: 'abc' }), 0);
  assert.equal(cfg({ reSlMax: 3.9 }), 3);
  assert.equal(reentryConfig({ reTgtMode: 'asap', reTgtMax: 500 } as never, 'tgt').max, MAX_LEG_REENTRIES);
  assert.equal(cfg({}), DEFAULT_SL_ROLL_MAX);
});

test('the stale-feed window covers only what the quote bridge streams (NSE/BSE cash session)', () => {
  for (const u of FEED_BRIDGE_UNDERLYINGS) {
    assert.equal(UNDERLYING_META[u].nseCalendar, true, `${u} is on the bridge but not on the NSE session the stale check watches`);
    assert.equal(UNDERLYING_META[u].segment === 'MCX_COMM', false);
  }
  assert.equal(FEED_BRIDGE_UNDERLYINGS.includes('CRUDEOILM'), false);
  assert.ok(FEED_SESSION_START_HM < FEED_SESSION_END_HM);
});

// Square Off Complete closes the sibling leg straight through placeLeg. That sibling must hold its per-leg lock
// (autoExitingLegRef) for the close, or the scheduler's own stop on it starts a second close sized off the 2s polled
// book and the leg flips to the other side. A sibling already closing on its own is left to that exit. Source guard:
// the order path needs the page.
test('Square Off Complete locks the sibling leg for its close and skips one already exiting', () => {
  const src = readFileSync(path.join(import.meta.dirname, '..', 'components', 'FocusTool.tsx'), 'utf-8');
  const at = src.indexOf('squareOffLegs(latest, leg, kind)');
  assert.ok(at > 0, 'Square Off Complete call site not found');
  const block = src.slice(at, at + 2200);
  assert.match(block, /rest\.filter\(l => !autoExitingLegRef\.current\.has\(/);          // already exiting on its own → not closed again
  assert.match(block, /autoExitingLegRef\.current\.add\(k\)/);                              // lock held for the close
  assert.match(block, /finally \{\s*sibKeys\.forEach\(k => autoExitingLegRef\.current\.delete\(k\)\)/);   // and always released
  assert.ok(block.indexOf('.add(k)') < block.indexOf('placeLeg(latest'), 'lock must be taken before the order is sent');
});
