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
  EMPTY_ROW_LIVE, legStopReason, legStopLevel, legTargetReason, reentryConfig, evaluateReentry,
  slRollStrike, pendingReentryLevel, pendingReentryHit, costReentryBasis, awaitingMomentumQuote,
  MAX_LEG_REENTRIES, DEFAULT_SL_ROLL_MAX,
  type RowLive,
} from './focusToolRules.ts';
import { readFileSync } from 'node:fs';
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
