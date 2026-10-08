/**
 * Simulated-market tests for the Focus Tool row grid — strike selection (ATM ± offsets, ₹ premium, Link legs),
 * ROW STOPS (SL ₹, PAIR ×, SPOT H↑ / L↓), VWAP exit, and the 25 / 50 / 75 % partial-exit chips.
 *
 *     node --test lib/focusToolSimulatedGrid.test.ts
 *
 * Scripted prices through the real rule functions, for CRUDEOILM (10-barrel lot) and NIFTY (75 lot). No broker,
 * network or clock. What this does not reach: the order placement behind each button (placeLeg) and the shift
 * chevrons (close then reopen) — those need the page, see the SIM-row checklist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_ROW_LIVE, atmStrike, resolveRowLegStrike, mirrorLinkedPatch, evaluateRowExit, legOwnContracts, sidePremium,
  type RowLive, type ChainQuote,
} from './focusToolRules.ts';
import { partialCloseChips } from './partialQty.ts';
import { UNDERLYING_META, orderQuantity, type FocusUnderlying } from './focusToolUnderlyings.ts';

interface Mkt { u: FocusUnderlying; lot: number; step: number; spot: number; ce: number; pe: number }
const MARKETS: Mkt[] = [
  { u: 'CRUDEOILM', lot: UNDERLYING_META.CRUDEOILM.unitsPerLot, step: UNDERLYING_META.CRUDEOILM.strikeStep, spot: 8824, ce: 278, pe: 246.05 },
  { u: 'NIFTY', lot: 75, step: UNDERLYING_META.NIFTY.strikeStep, spot: 24024, ce: 170, pe: 130 },
];

/** A chain around `atm`: premiums fall away from the money on each side (CE cheaper above, PE cheaper below). */
function chainAround(m: Mkt, atm: number, atmPrem: number): Record<string, ChainQuote> {
  const oc: Record<string, ChainQuote> = {};
  for (let k = -10; k <= 10; k++) {
    oc[String(atm + k * m.step)] = {
      ce: Math.max(1, atmPrem - k * m.step * 0.4),
      pe: Math.max(1, atmPrem + k * m.step * 0.4),
    };
  }
  return oc;
}

const rowBase = (o: object = {}) => ({
  strikeMode: 'ATM', ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '', ...o,
}) as never;

for (const m of MARKETS) {
  const tag = `[${m.u}]`;
  const atm = atmStrike(m.spot, m.step)!;
  const oc = chainAround(m, atm, 250);

  // ── Strike selection ──────────────────────────────────────────────────────
  test(`${tag} ATM rounds to the strike step, and is null without a price`, () => {
    assert.equal(atmStrike(m.spot, m.step), Math.round(m.spot / m.step) * m.step);
    assert.equal(atmStrike(atm + m.step / 2 - 0.01, m.step), atm);
    assert.equal(atmStrike(atm + m.step / 2, m.step), atm + m.step);
    assert.equal(atmStrike(0, m.step), null);
    assert.equal(atmStrike(-5, m.step), null);
  });

  test(`${tag} ATM ± offset: CE n steps up, PE n steps down for a strangle; ITM with the opposite sign`, () => {
    const ctx = { atm, step: m.step, oc };
    assert.equal(resolveRowLegStrike(rowBase(), 'CE', ctx), atm);
    assert.equal(resolveRowLegStrike(rowBase(), 'PE', ctx), atm);
    const strangle = rowBase({ ceOffset: 3, peOffset: -3 });
    assert.equal(resolveRowLegStrike(strangle, 'CE', ctx), atm + 3 * m.step);
    assert.equal(resolveRowLegStrike(strangle, 'PE', ctx), atm - 3 * m.step);
    assert.equal(resolveRowLegStrike(rowBase({ ceOffset: -2 }), 'CE', ctx), atm - 2 * m.step);   // ITM call
    assert.equal(resolveRowLegStrike(rowBase({ ceOffset: 2 }), 'CE', { ...ctx, atm: atm + m.step }), atm + 3 * m.step);   // follows ATM
    assert.equal(resolveRowLegStrike(rowBase({ ceOffset: 3 }), 'CE', { ...ctx, atm: null }), null);   // no spot, no strike
  });

  test(`${tag} ₹ premium mode: the strike whose premium is nearest the target, either side`, () => {
    const ctx = { atm, step: m.step, oc };
    const ce = resolveRowLegStrike(rowBase({ strikeMode: 'PREMIUM', cePremium: '150', pePremium: '150' }), 'CE', ctx)!;
    const pe = resolveRowLegStrike(rowBase({ strikeMode: 'PREMIUM', cePremium: '150', pePremium: '150' }), 'PE', ctx)!;
    assert.ok(Math.abs(oc[String(ce)].ce - 150) <= Math.abs(oc[String(ce - m.step)]?.ce - 150) + 1e-9);
    assert.ok(Math.abs(oc[String(ce)].ce - 150) <= Math.abs(oc[String(ce + m.step)]?.ce - 150) + 1e-9);
    assert.ok(ce > atm, 'a cheaper CE is OTM, above ATM');
    assert.ok(pe < atm, 'a cheaper PE is OTM, below ATM');
    // a blank / zero target resolves nothing rather than a random strike
    assert.equal(resolveRowLegStrike(rowBase({ strikeMode: 'PREMIUM', cePremium: '' }), 'CE', ctx), null);
    assert.equal(resolveRowLegStrike(rowBase({ strikeMode: 'PREMIUM', cePremium: '0' }), 'CE', ctx), null);
    // no chain yet
    assert.equal(resolveRowLegStrike(rowBase({ strikeMode: 'PREMIUM', cePremium: '150' }), 'CE', { atm, step: m.step, oc: undefined }), null);
  });

  test(`${tag} ₹ premium mode ignores a dead strike (zero OI) with a stale last price`, () => {
    const dead: Record<string, ChainQuote> = { ...oc, [String(atm + 3 * m.step)]: { ce: 150, pe: 1, ceOi: 0 } };
    const ce = resolveRowLegStrike(rowBase({ strikeMode: 'PREMIUM', cePremium: '150' }), 'CE', { atm, step: m.step, oc: dead });
    assert.notEqual(ce, atm + 3 * m.step);
  });

  test(`${tag} Link legs: offsets mirror NEGATED, premiums mirror as is, unlinked leaves the other leg alone`, () => {
    assert.deepEqual(mirrorLinkedPatch(true, 'CE', { ceOffset: 4 }), { ceOffset: 4, peOffset: -4 });
    assert.deepEqual(mirrorLinkedPatch(true, 'PE', { peOffset: 4 }), { peOffset: 4, ceOffset: -4 });
    assert.deepEqual(mirrorLinkedPatch(true, 'CE', { cePremium: '120' }), { cePremium: '120', pePremium: '120' });
    assert.deepEqual(mirrorLinkedPatch(true, 'PE', { pePremium: '90' }), { pePremium: '90', cePremium: '90' });
    assert.deepEqual(mirrorLinkedPatch(false, 'CE', { ceOffset: 4, cePremium: '120' }), { ceOffset: 4, cePremium: '120' });
    // an offset of 0 still mirrors (-0 must read as 0)
    assert.equal(mirrorLinkedPatch(true, 'CE', { ceOffset: 0 }).peOffset === 0, true);
    // an edit that does not touch strikes mirrors nothing
    assert.deepEqual(mirrorLinkedPatch(true, 'CE', { lots: 2 }), { lots: 2 });
  });

  // ── ROW STOPS ─────────────────────────────────────────────────────────────
  const row = (o: object = {}) => ({ side: 'BOTH', qtyMultiplier: 1, levelHigh: '', levelLow: '', levelVw: false, vwapBufferPct: '', slRupees: '', slMultiplier: '',
    fill: { ceQty: m.lot, peQty: m.lot, ceStrike: 1, peStrike: 1, ts: '' }, ...o }) as never;
  const live = (ce: number, pe: number, o: Partial<RowLive> = {}): RowLive => ({
    ...EMPTY_ROW_LIVE, ceStrike: 1, peStrike: 1, ltpCe: ce, ltpPe: pe, lotSize: m.lot,
    cePosition: { netQty: -m.lot, sellAvg: m.ce } as never, pePosition: { netQty: -m.lot, sellAvg: m.pe } as never,
    entryPremium: m.ce + m.pe, pnl: ((m.ce - ce) + (m.pe - pe)) * m.lot, ...o,
  });
  const exit = (r: never, l: RowLive, spot = m.spot) => evaluateRowExit(r, l, spot, undefined, m.lot);

  test(`${tag} SPOT H↑ / L↓: touch counts; a failed spot read (0) never fires`, () => {
    assert.equal(exit(row({ levelHigh: String(m.spot + 50) }), live(m.ce, m.pe), m.spot + 49.99), null);
    assert.match(exit(row({ levelHigh: String(m.spot + 50) }), live(m.ce, m.pe), m.spot + 50) ?? '', /^H↑ breached/);
    assert.equal(exit(row({ levelLow: String(m.spot - 50) }), live(m.ce, m.pe), m.spot - 49.99), null);
    assert.match(exit(row({ levelLow: String(m.spot - 50) }), live(m.ce, m.pe), m.spot - 50) ?? '', /^L↓ breached/);
    assert.equal(exit(row({ levelHigh: String(m.spot + 50), levelLow: String(m.spot - 50) }), live(m.ce, m.pe), 0), null);
    assert.equal(exit(row({ levelHigh: '', levelLow: '' }), live(m.ce, m.pe), m.spot * 3), null);
  });

  test(`${tag} SL ₹: fires at P&L ≤ −SL, scales with the Quantity Multiplier`, () => {
    const sl = 5 * m.lot;                               // 5 premium points on one lot
    const r = row({ slRupees: String(sl) });
    assert.equal(exit(r, live(m.ce + 2.4, m.pe + 2.4)), null);                 // −4.8 pts
    assert.match(exit(r, live(m.ce + 2.5, m.pe + 2.5)) ?? '', /^SL ₹/);        // −5 pts: out
    const x2 = row({ slRupees: String(sl), qtyMultiplier: 2 });
    assert.equal(exit(x2, live(m.ce + 2.5, m.pe + 2.5)), null);                // the ₹ limit doubled
    assert.match(exit(x2, live(m.ce + 5, m.pe + 5)) ?? '', /^SL ₹/);
  });

  test(`${tag} PAIR ×: the combined premium reaches entry × mult`, () => {
    const entry = m.ce + m.pe, r = row({ slMultiplier: '1.2' });
    const at = (comb: number) => live(m.ce * comb / entry, m.pe * comb / entry);
    assert.equal(exit(r, at(entry * 1.2 - 0.01)), null);
    assert.match(exit(r, at(entry * 1.2)) ?? '', /^SL ×1\.2 hit/);
    assert.equal(exit(row({ slMultiplier: '1' }), at(entry * 5)), null);        // 1 / blank = off
  });

  test(`${tag} PAIR × with one leg left measures only the open leg (the closed leg must not count)`, () => {
    const r = row({ slMultiplier: '1.2', fill: { ceQty: 0, peQty: m.lot, ceStrike: 1, peStrike: 1, ts: '' } });
    const l = live(m.ce * 3, m.pe, { cePosition: null, entryPremium: m.pe });    // CE already out, trading far away
    assert.equal(exit(r, l), null);
    assert.match(exit(r, { ...l, ltpPe: m.pe * 1.2 }) ?? '', /^SL ×1\.2 hit/);
    assert.equal(sidePremium(r, l, undefined, m.lot), m.pe);
  });

  test(`${tag} VWAP exit: judged on the last CLOSED candle, past the buffer, never on a live tick`, () => {
    const vw = row({ levelVw: true, vwapBufferPct: '0.1' });
    const lv = (o: Partial<RowLive>) => live(m.ce, m.pe, o);
    assert.equal(exit(vw, lv({ vwap: 500, vwapClose: 500.49 })), null);          // under VWAP + 0.1 %
    assert.match(exit(vw, lv({ vwap: 500, vwapClose: 500.5 })) ?? '', /^VW breached/);
    assert.equal(exit(vw, lv({ vwap: 500, vwapClose: null })), null);            // no closed candle yet
    assert.equal(exit(vw, lv({ vwap: null, vwapClose: 900 })), null);            // no VWAP yet
    assert.equal(exit(row({ levelVw: false }), lv({ vwap: 500, vwapClose: 900 })), null);   // switched off
    assert.match(exit(row({ levelVw: true, vwapBufferPct: '' }), lv({ vwap: 500, vwapClose: 500 })) ?? '', /^VW breached/);   // blank buffer = none
  });

  test(`${tag} ROW STOPS priority: levels, then VWAP, then SL ₹, then PAIR ×`, () => {
    const entry = m.ce + m.pe;
    const all = row({ levelHigh: String(m.spot + 10), levelVw: true, slRupees: String(m.lot), slMultiplier: '1.01' });
    const bad = live(m.ce * 1.5, m.pe * 1.5, { vwap: 100, vwapClose: 900 });      // every rule breached at once
    assert.match(exit(all, bad, m.spot + 10) ?? '', /^H↑/);
    assert.match(exit(all, bad, m.spot) ?? '', /^VW/);
    assert.match(exit(row({ slRupees: String(m.lot), slMultiplier: '1.01' }), bad) ?? '', /^SL ₹/);
    assert.match(exit(row({ slMultiplier: '1.01' }), live(m.ce * 1.5, m.pe * 1.5)) ?? '', /^SL ×1\.01/);
    assert.ok(entry > 0);
  });

  // ── Partial-exit chips ────────────────────────────────────────────────────
  const owned = (lots: number) => {
    const r = { fill: { ceQty: lots * m.lot, peQty: 0, ceStrike: 1, ts: '' } } as never;
    return legOwnContracts(r, 'CE', { ...EMPTY_ROW_LIVE, cePosition: { netQty: -lots * m.lot } as never });
  };

  test(`${tag} chips: whole lots only, rounded down, never a duplicate or a disguised full close`, () => {
    const chips = (lots: number) => partialCloseChips(owned(lots), m.lot, [25, 50, 75]);
    assert.deepEqual(chips(1).map(c => c.enabled), [false, false, false]);                    // one lot: Exit only
    assert.deepEqual(chips(2).map(c => c.enabled), [false, true, false]);                     // 50% = 1; 75% would repeat it
    assert.deepEqual(chips(4).map(c => [c.enabled, c.lots]), [[true, 1], [true, 2], [true, 3]]);
    assert.deepEqual(chips(10).map(c => c.lots), [2, 5, 7]);
    for (const n of [1, 2, 3, 4, 7, 10]) for (const c of chips(n)) assert.ok(c.units < owned(n), 'a chip is never the whole leg');
  });

  test(`${tag} chip units become the broker's order quantity (MCX counts lots, not barrels)`, () => {
    const c = partialCloseChips(owned(4), m.lot, [25, 50, 75]);
    assert.equal(orderQuantity(m.u, c[1].units), m.u === 'CRUDEOILM' ? 2 : 2 * m.lot);       // 50 % of 4 lots
    assert.equal(orderQuantity(m.u, c[0].units), m.u === 'CRUDEOILM' ? 1 : m.lot);
  });

  test(`${tag} chips are sized off this row's own contracts, not a bigger shared broker position`, () => {
    const r = { fill: { ceQty: 2 * m.lot, peQty: 0, ceStrike: 1, ts: '' } } as never;
    const sharedBook = { ...EMPTY_ROW_LIVE, cePosition: { netQty: -8 * m.lot } as never };   // another row holds 6 lots there too
    assert.equal(legOwnContracts(r, 'CE', sharedBook), 2 * m.lot);
    assert.deepEqual(partialCloseChips(legOwnContracts(r, 'CE', sharedBook), m.lot, [25, 50, 75]).map(c => c.lots), [0, 1, 1]);
    // a row that owns nothing offers nothing, whatever the broker shows
    const none = { fill: { ceQty: 0, peQty: 0, ts: '' } } as never;
    assert.equal(legOwnContracts(none, 'CE', sharedBook), 0);
    assert.ok(partialCloseChips(0, m.lot, [25, 50, 75]).every(c => !c.enabled));
  });
}
