/**
 * Simulated-market tests for the Focus Tool "Overall Strategy" and "Timing &
 * Square-off" controls — Overall SL / Target / Trailing (Lock, Lock & Trail,
 * Trail SL), No RE after, Stop monitoring after, Trail SL to Break-even.
 *
 *     node --test lib/focusToolSimulated.test.ts
 *
 * Each case replays a scripted combined-premium path tick by tick through the
 * REAL rule functions (the same ones FocusTool.tsx calls each poll) and checks
 * which tick the row exits on and why. No broker, no network, no clock. Every
 * case runs for CRUDEOILM (10-barrel lot, MCX backstop) and NIFTY (75 lot,
 * 15:17 backstop), so a unit or backstop bug on either shows up here.
 *
 * Square Off Complete: the decision (which sibling legs close) is the pure
 * squareOffLegs(); autoExitLeg only executes it. The order placement itself
 * still needs the page (SIM row).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_ROW_LIVE, evaluateRowExit, evaluateOverallExit, nextOverallPeak,
  reentryWindowClosed, monitoringStopped, costStopApplies, costStopReason, squareOffLegs,
  type RowLive,
} from './focusToolRules.ts';
import { UNDERLYING_META, type FocusUnderlying } from './focusToolUnderlyings.ts';

interface Mkt { u: FocusUnderlying; lot: number; ce: number; pe: number }
// Entry premiums are the real shapes seen live: CRUDEOILM 278 / 246.05, NIFTY 170 / 130.
const MARKETS: Mkt[] = [
  { u: 'CRUDEOILM', lot: UNDERLYING_META.CRUDEOILM.unitsPerLot, ce: 278, pe: 246.05 },
  { u: 'NIFTY', lot: 75, ce: 170, pe: 130 },
];

const entryOf = (m: Mkt) => m.ce + m.pe;

/** Row sold 1 lot of each leg. */
function rowFor(m: Mkt, o: object = {}) {
  return {
    side: 'BOTH', slRupees: '', slMultiplier: '', exitTime: '', noReEntryAfter: '',
    fill: { ceQty: m.lot, peQty: m.lot, ceStrike: 1, peStrike: 1, ceEntry: m.ce, peEntry: m.pe, ts: '' },
    ...o,
  } as never;
}

/** Live state when the combined premium has moved to `combined` (legs scale together). */
function liveAt(m: Mkt, combined: number, o: Partial<RowLive> = {}): RowLive {
  const k = combined / entryOf(m);
  const ceLtp = m.ce * k, peLtp = m.pe * k;
  return {
    ...EMPTY_ROW_LIVE,
    ceStrike: 1, peStrike: 1, ltpCe: ceLtp, ltpPe: peLtp,
    cePosition: { netQty: -m.lot, sellAvg: m.ce } as never,
    pePosition: { netQty: -m.lot, sellAvg: m.pe } as never,
    pnl: ((m.ce - ceLtp) + (m.pe - peLtp)) * m.lot,
    entryPremium: entryOf(m), lotSize: m.lot, ...o,
  };
}

interface Exit { tick: number; reason: string; kind: 'sl' | 'target' | 'row' }

/** Replay premiums (as % of entry) and return the first exit the page would take. */
function replay(m: Mkt, row: object, pctPath: number[]): Exit | null {
  const r = rowFor(m, row);
  let peak = { pnl: 0, pts: 0 };
  for (let i = 0; i < pctPath.length; i++) {
    const live = liveAt(m, entryOf(m) * pctPath[i] / 100);
    const pts = entryOf(m) - entryOf(m) * pctPath[i] / 100;
    peak = nextOverallPeak(peak, { pnl: live.pnl, pts });
    const plain = evaluateRowExit(r, live, 0, undefined, m.lot);   // legacy SL ₹ / SL ×
    if (plain) return { tick: i, reason: plain, kind: 'row' };
    const ov = evaluateOverallExit(r, live, peak, undefined, m.lot);
    if (ov) return { tick: i, reason: ov.reason, kind: ov.kind };
  }
  return null;
}

/** ₹ for `pts` index/premium points on one lot of this market. */
const rs = (m: Mkt, pts: number) => pts * m.lot;

for (const m of MARKETS) {
  const tag = `[${m.u}]`;

  // ── Overall SL ────────────────────────────────────────────────────────────
  test(`${tag} Overall SL, Total Premium %: SL ×1.004 fires on the first tick ≥ +0.4%`, () => {
    // premium % of entry: 100 → 100.2 → 100.39 → 100.4 → 101
    const hit = replay(m, { slMultiplier: '1.004' }, [100, 100.2, 100.39, 100.4, 101]);
    assert.equal(hit?.tick, 3);
    assert.match(hit?.reason ?? '', /^SL ×1\.004 hit/);
  });

  test(`${tag} Overall SL, MTM: fires when P&L ≤ −SL, not before`, () => {
    const sl = String(rs(m, 3));                    // 3 premium points on one lot
    const entry = entryOf(m);
    const path = [100, 100 + 2.9 / entry * 100, 100 + 3 / entry * 100];
    const hit = replay(m, { slRupees: sl }, path);
    assert.equal(hit?.tick, 2);
    assert.match(hit?.reason ?? '', /^SL ₹/);
  });

  test(`${tag} Overall SL does nothing on a profitable path`, () => {
    assert.equal(replay(m, { slMultiplier: '1.3' }, [100, 95, 90, 85, 99, 100]), null);
  });

  // ── Overall Target ────────────────────────────────────────────────────────
  test(`${tag} Overall Target MTM: fires at ₹ target`, () => {
    const entry = entryOf(m);
    const hit = replay(m, { overallTarget: { enabled: true, mode: 'mtm', value: String(rs(m, 2)) } },
      [100, 100 - 1.9 / entry * 100, 100 - 2 / entry * 100]);
    assert.equal(hit?.tick, 2);
    assert.equal(hit?.kind, 'target');
    assert.match(hit?.reason ?? '', /^Overall Target ₹/);
  });

  test(`${tag} Overall Target % of premium: 5% decay`, () => {
    const hit = replay(m, { overallTarget: { enabled: true, mode: 'premiumPct', value: '5' } }, [100, 97, 95.01, 95]);
    assert.equal(hit?.tick, 3);
    assert.equal(hit?.kind, 'target');
  });

  test(`${tag} Overall Target disabled never fires`, () => {
    assert.equal(replay(m, { overallTarget: { enabled: false, mode: 'mtm', value: '1' } }, [100, 50]), null);
  });

  // ── Trailing options ──────────────────────────────────────────────────────
  test(`${tag} Lock: once profit reached Y, exit at X; never armed below Y`, () => {
    const entry = entryOf(m);
    const reach = String(rs(m, 4)), lock = String(rs(m, 2));
    const p = (pts: number) => 100 - pts / entry * 100;
    const pk = (pts: number) => p(pts + 1e-7);          // a peak just past its line: the % round-trip loses ~1e-13
    const lockRow = { overallTrail: { enabled: true, kind: 'lock', reach, lock, every: '', by: '' } };
    // peak only 3 pts (< reach 4) then falls to 0.5: never armed
    assert.equal(replay(m, lockRow, [p(0), p(3), p(0.5), p(-1)]), null);
    // reaches 4 pts, falls to 2.5 (above lock), then 2 (= lock): exits on that tick
    const hit = replay(m, lockRow, [p(0), pk(4), p(2.5), p(2), p(5)]);
    assert.equal(hit?.tick, 3);
    assert.equal(hit?.kind, 'sl');
    assert.match(hit?.reason ?? '', /^Overall Lock/);
  });

  test(`${tag} Lock & Trail: floor rises by "by" for every "every" past reach`, () => {
    const entry = entryOf(m);
    const p = (pts: number) => 100 - pts / entry * 100;
    const pk = (pts: number) => p(pts + 1e-7);
    // reach 10, lock 5, every 2, by 1 (all in premium points × lot)
    const row = { overallTrail: { enabled: true, kind: 'lockTrail',
      reach: String(rs(m, 10)), lock: String(rs(m, 5)), every: String(rs(m, 2)), by: String(rs(m, 1)) } };
    // peak 14 → floor 5 + floor((14−10)/2)·1 = 7; 7.5 survives, 7 exits
    const survive = replay(m, row, [p(0), pk(14), p(7.5)]);
    assert.equal(survive, null);
    const hit = replay(m, row, [p(0), pk(14), p(7.5), p(7)]);
    assert.equal(hit?.tick, 3);
    assert.match(hit?.reason ?? '', /^Overall Lock and Trail/);
  });

  test(`${tag} Trail SL: SL tightens as profit peaks (needs an Overall SL)`, () => {
    const entry = entryOf(m);
    const p = (pts: number) => 100 - pts / entry * 100;
    const pk = (pts: number) => p(pts + 1e-7);
    // SL 6 pts (MTM), trail every 3 by 1.5. peak 3 → SL 4.5 pts: −4.5 exits, −4.4 holds.
    const row = (extra = {}) => ({ slRupees: String(rs(m, 6)),
      overallTrail: { enabled: true, kind: 'trailSl', reach: '', lock: '', every: String(rs(m, 3)), by: String(rs(m, 1.5)) }, ...extra });
    assert.equal(replay(m, row(), [p(0), pk(3), p(-4.4)]), null);
    const hit = replay(m, row(), [p(0), pk(3), p(-4.5)]);
    assert.equal(hit?.tick, 2);
    assert.equal(hit?.kind, 'sl');
    assert.match(hit?.reason ?? '', /^Overall Trail SL/);
    // without an Overall SL there is nothing to trail
    assert.equal(replay(m, row({ slRupees: '' }), [p(0), pk(3), p(-50)]), null);
  });

  // ── Timing & square-off ───────────────────────────────────────────────────
  const BACK = UNDERLYING_META[m.u].backstopHm;
  const ctx = (nowHm: string) => ({ nowHm, product: 'INTRADAY' as const, groupEnabled: true, backstopHm: BACK });
  const hmBefore = (hm: string, min: number) => {
    const [h, mm] = hm.split(':').map(Number); const t = h * 60 + mm - min;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  test(`${tag} No RE after: blocks re-entry at/after the cutoff only`, () => {
    const noRe = hmBefore(BACK, 60);
    const row = { exitTime: '', noReEntryAfter: noRe };
    assert.equal(reentryWindowClosed(row, ctx(hmBefore(noRe, 1))), null);
    assert.match(reentryWindowClosed(row, ctx(noRe)) ?? '', /no re-entry after/);
    // a re-entry already waiting ignores the cutoff (it only looks at when the stop hit)
    assert.equal(reentryWindowClosed(row, ctx(noRe), true), null);
    // the underlying's own backstop still closes the window
    assert.match(reentryWindowClosed({ exitTime: '', noReEntryAfter: '' }, ctx(BACK)) ?? '', /intraday cutoff/);
  });

  test(`${tag} Stop monitoring after: every rule stands down from that minute`, () => {
    const stop = hmBefore(BACK, 30);
    assert.equal(monitoringStopped({ stopMonitoringAfter: stop }, hmBefore(stop, 1)), false);
    assert.equal(monitoringStopped({ stopMonitoringAfter: stop }, stop), true);
    assert.equal(monitoringStopped({ stopMonitoringAfter: '' }, '23:59'), false);
    assert.match(reentryWindowClosed({ exitTime: '', noReEntryAfter: '', stopMonitoringAfter: stop }, ctx(stop), true) ?? '', /monitoring stopped/);
  });

  test(`${tag} Trail SL to Break-even: arms only after a leg SL, exits at the leg's own entry`, () => {
    const base = (o: object = {}) => ({ slToCost: true, slToCostScope: 'all', ceSlMultiplier: '1.2', peSlMultiplier: '1', ...o });
    const survivor = (ltpPe: number, armed: boolean) => {
      const row = rowFor(m, { ...base(), fill: { ceQty: 0, peQty: m.lot, ceStrike: 1, peStrike: 1, peEntry: m.pe, peCostStop: armed, ts: '' } });
      const live = { ...liveAt(m, entryOf(m)), cePosition: null, ltpPe, pePosition: { netQty: -m.lot, sellAvg: m.pe } as never };
      return costStopReason(row, 'PE', live as RowLive);
    };
    assert.equal(survivor(m.pe + 5, false), null);                    // not armed: a fresh straddle is not stopped on an uptick
    assert.equal(survivor(m.pe - 1, true), null);                     // armed, premium below entry: holds
    assert.match(survivor(m.pe, true) ?? '', /^PE SL to cost hit/);   // back at entry: out
    // scope: 'sl' only legs that carry their own SL ×
    assert.equal(costStopApplies(base({ slToCostScope: 'sl' }) as never, 'PE'), false);
    assert.equal(costStopApplies(base({ slToCostScope: 'sl', peSlMultiplier: '1.5' }) as never, 'PE'), true);
    assert.equal(costStopApplies(base({ slToCost: false }) as never, 'PE'), false);
  });

  // ── Square Off ────────────────────────────────────────────────────────────
  test(`${tag} Square Off: Partial closes only the stopped leg, Complete closes the sibling`, () => {
    const both = rowFor(m);
    for (const kind of ['sl', 'tgt'] as const) {
      assert.equal(squareOffLegs({ ...(both as object), squareOff: undefined } as never, 'CE', kind), null);       // missing = partial
      assert.equal(squareOffLegs({ ...(both as object), squareOff: 'partial' } as never, 'CE', kind), null);
      assert.deepEqual(squareOffLegs({ ...(both as object), squareOff: 'complete' } as never, 'CE', kind), ['PE']);
      assert.deepEqual(squareOffLegs({ ...(both as object), squareOff: 'complete' } as never, 'PE', kind), ['CE']);
    }
  });

  test(`${tag} Square Off Complete: skips a sibling the row does not own, and never fires on a cost stop`, () => {
    const ceOnly = { ...(rowFor(m) as object), squareOff: 'complete', fill: { ceQty: m.lot, peQty: 0, ts: '' } } as never;
    assert.deepEqual(squareOffLegs(ceOnly, 'CE', 'sl'), []);          // complete, nothing left to close
    const full = { ...(rowFor(m) as object), squareOff: 'complete' } as never;
    assert.equal(squareOffLegs(full, 'CE', 'cost'), null);            // a break-even exit is not a stop / target
  });
}
