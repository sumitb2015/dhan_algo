/**
 * The browser half of the Focus Tool parity suite.
 *
 *     npm test          (node --test lib/*.test.ts)
 *
 * Every case comes from focusToolRules.cases.json, which tests/test_focus_tool_parity.py
 * runs against the Python implementation as well. Cases live in the fixture
 * rather than here precisely so neither side can be "fixed" on its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  evaluateEntry, evaluateEntryMomentum, reRangeWindow, overallSlConfig, nextOverallPeak, evaluateOverallExit, overallExitKind, evaluateOverallReentry, rangeBreakoutOn, rangeBreakoutHit, costStopApplies, runningLazyLeg, legSlMultiplier, legTarget, nextLazyLegId, lazyLegStrike, legHasOwnSl, simpleMomOn, simpleMomLevel, simpleMomHit, evaluateGlobalRisk, evaluateRowExit, legStopReason,
  dteForExpiry, dteMatches, sidePremium, legsOf, legsFlat, rowOwnsLeg,
  stopPremium, legStopPremium, pairStopPremium, legOwnContracts,
  nextOpenedTs, isGhostDropProtected, GHOST_DROP_GRACE_MS,
  isSimRow, simLegPosition,
  legPinnedStrike, slRollStrike, evaluateReentry, costStopReason, legOwnEntry, DEFAULT_SL_ROLL_MAX,
  reentryWindowClosed, pendingReentryLevel, pendingReentryHit, legTargetReason, costReentryBasis, awaitingMomentumQuote, legTargetLevel,
  monitoringStopped, momentumReentryKind, legTrailSteps, legStopLevel, orbStopDistance, legTargetSpotLevel, MAX_LEG_REENTRIES,
  resolveCriteriaStrike, closestPremiumStrike, absDelta100, modelAbsDelta100, legDeltaBasis, legDeltaNow, legTargetDeltaLevel, ownedLegStop, legStopHit, rowQtyMultiplier, multipliedLots,
  tradingDaysBack, tradingDte, dateForDte, rangeWindow, rangeWindowPhase, candleBucket, addMinutesHm,
  type RowLive, type PosRow, type WorkerHold,
  clampHm, ENTRY_TIME_MIN, ENTRY_TIME_MAX, EXIT_TIME_MIN, EXIT_TIME_MAX,
} from './focusToolRules.ts';
import type { FocusRow } from './focusToolRows.ts';

const CASES = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'focusToolRules.cases.json'), 'utf-8'),
);

// ── Fixture → the shapes the rules actually take ─────────────────────────────

/** A broker position row carrying just what the rules read off it. */
function pos(qty: number, entry: number): PosRow | null {
  if (!qty) return null;
  return {
    tradingSymbol: 'X', securityId: '1', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
    netQty: qty,
    // This tool only ever opens with a SELL, so a short's entry is its sellAvg.
    buyAvg: qty > 0 ? entry : 0,
    sellAvg: qty < 0 ? entry : 0,
    realizedProfit: 0, unrealizedProfit: 0,
  };
}

interface LiveCase {
  ceLtp: number; peLtp: number; ceQty: number; peQty: number;
  ceEntry: number; peEntry: number; pnl?: number; vwap?: number | null; vwapClose?: number | null;
  /** Absolute contracts per lot. Fixture qtys are multiples of this. Default 75. */
  lotSize?: number;
}

function live(c: LiveCase): RowLive {
  const cePosition = pos(c.ceQty, c.ceEntry);
  const pePosition = pos(c.peQty, c.peEntry);
  const lot = c.lotSize && c.lotSize > 0 ? c.lotSize : 75;
  return {
    ceStrike: 24000, peStrike: 24000,
    ltpCe: c.ceLtp, ltpPe: c.peLtp,
    cePosition, pePosition,
    pnl: c.pnl ?? 0,
    // Combined entry: Σ (lots × entry) = Σ (contracts × entry) / lotSize.
    entryPremium: (() => {
      const ceQ = Math.abs(c.ceQty);
      const peQ = Math.abs(c.peQty);
      const num = (cePosition ? c.ceEntry * ceQ : 0) + (pePosition ? c.peEntry * peQ : 0);
      return num > 0 ? num / lot : 0;
    })(),
    lotSize: lot,
    vwap: c.vwap ?? null,
    vwapClose: c.vwapClose ?? null,
    vwap1m: null,
    vwapClose1m: null,
    ceBuildup: null, peBuildup: null, ceOiChgPct: null, peOiChgPct: null,
    ceOi: null, peOi: null,
  };
}

function row(partial: Partial<FocusRow>): FocusRow {
  return {
    id: 't', underlying: 'NIFTY', entryTime: '', exitTime: '', dte: 'Any', expiry: '',
    strikeMode: 'ATM', linked: true, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '',
    lots: 1, side: 'BOTH', status: 'draft',
    levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '',
    slRupees: '', slMultiplier: '1',
    ceSlMultiplier: '1', peSlMultiplier: '1',
    createdAt: '', updatedAt: '',
    ...partial,
  } as FocusRow;
}

/**
 * The shared fixture (focusToolRules.cases.json) predates row-ownership
 * gating and has no notion of it — every rowExit/legStop case implicitly
 * assumes the row owns whatever position `live()` constructs for it. Stamp a
 * matching `fill` so `rowOwnsLeg` sees that ownership, exactly as a row's own
 * placeLeg() would once its entry actually filled.
 */
function ownedRow(partial: Partial<FocusRow>, c: LiveCase): FocusRow {
  return row({
    fill: {
      ceStrike: c.ceQty ? 24000 : null,
      peStrike: c.peQty ? 24000 : null,
      ceQty: Math.abs(c.ceQty), peQty: Math.abs(c.peQty),
      ts: '',
    },
    ...partial,
  });
}

// ── Shared fixture ───────────────────────────────────────────────────────────

test('entry rules', async t => {
  for (const c of CASES.entry) {
    await t.test(c.name, () => {
      const got = evaluateEntry(row(c.row), { tradingDay: true, ...c.ctx })   // the fixture is shared with the Python parity test, which has no calendar;
      assert.equal(got.enter, c.expect.enter);
      // The Python reports `None` where JS reports `null`; the fixture is
      // written in Python's spelling since that is what a log line shows.
      assert.equal(got.reason.replace('null', 'None'), c.expect.reason);
    });
  }
});

test('account budget', async t => {
  for (const c of CASES.globalRisk) {
    await t.test(c.name, () => {
      const got = evaluateGlobalRisk(c.cfg, c.ctx);
      assert.equal(got.exitAll, c.expect.exitAll);
      assert.equal(got.reason, c.expect.reason);
      assert.equal(got.lockFloor, c.expect.lockFloor);
      assert.equal(got.trailState, c.expect.trailState);
    });
  }
});

test('row exit ladder', async t => {
  for (const c of CASES.rowExit) {
    await t.test(c.name, () => {
      const lot = c.live.lotSize && c.live.lotSize > 0 ? c.live.lotSize : 75;
      assert.equal(
        evaluateRowExit(ownedRow(c.row, c.live), live(c.live), c.spot, undefined, lot),
        c.expect,
      );
    });
  }
});

test('leg-wise stops', async t => {
  for (const c of CASES.legStop) {
    await t.test(c.name, () => {
      assert.equal(legStopReason(ownedRow(c.row, c.live), c.leg, live(c.live)), c.expect);
    });
  }
});

test('days to expiry', async t => {
  for (const c of CASES.dte) {
    await t.test(`${c.expiry || '(empty)'} from ${c.today}`, () => {
      assert.equal(dteForExpiry(c.expiry, c.today), c.expect);
    });
  }
});

// ── Properties the fixture cannot express ────────────────────────────────────

test('dteMatches: Any admits a lapsed expiry, specific filters do not', () => {
  assert.equal(dteMatches('Any', -1), true);
  assert.equal(dteMatches('Any', null), true);
  assert.equal(dteMatches('0', null), false);
  assert.equal(dteMatches('1', 1), true);
  assert.equal(dteMatches('0+1', 2), false);
});

test('legsOf: Side selects legs, it is not a direction', () => {
  assert.deepEqual(legsOf({ side: 'BOTH' } as FocusRow), ['CE', 'PE']);
  assert.deepEqual(legsOf({ side: 'CE' } as FocusRow), ['CE']);
  assert.deepEqual(legsOf({ side: 'PE' } as FocusRow), ['PE']);
});

test('legsFlat is true only when neither leg carries quantity', () => {
  assert.equal(legsFlat(live({ ceLtp: 1, peLtp: 1, ceQty: 0, peQty: 0, ceEntry: 1, peEntry: 1 })), true);
  assert.equal(legsFlat(live({ ceLtp: 1, peLtp: 1, ceQty: -75, peQty: 0, ceEntry: 1, peEntry: 1 })), false);
});

test('rowOwnsLeg: a coincidental broker PE does not lock a draft row', () => {
  const draft = row({ fill: undefined });
  assert.equal(rowOwnsLeg(draft, 'PE'), false);
  assert.equal(rowOwnsLeg(draft, 'CE'), false);
  assert.equal(rowOwnsLeg(draft, 'PE', { open: false, peStrike: 24150 }), false);
});

test('rowOwnsLeg: this row\'s fill ledger owns the leg', () => {
  const held = row({ fill: { ceStrike: null, peStrike: 24150, ceQty: 0, peQty: 65, ts: '' } });
  assert.equal(rowOwnsLeg(held, 'PE'), true);
  assert.equal(rowOwnsLeg(held, 'CE'), false);
});

test('rowOwnsLeg: the worker ledger owns an open leg even without page fill', () => {
  const draft = row({ fill: undefined });
  assert.equal(rowOwnsLeg(draft, 'PE', { open: true, ceStrike: null, peStrike: 24150 }), true);
  assert.equal(rowOwnsLeg(draft, 'CE', { open: true, ceStrike: null, peStrike: 24150 }), false);
});

test('sidePremium counts only legs that are both traded and open', () => {
  const c = { ceLtp: 100, peLtp: 80, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 80 };
  const l = live(c);
  const owned = ownedRow({}, c);
  // 1 lot each @ 100/80 → combined 180; CE-only → 100.
  assert.equal(sidePremium({ ...owned, side: 'BOTH' } as FocusRow, l, undefined, 75), 180);
  assert.equal(sidePremium({ ...owned, side: 'CE' } as FocusRow, l, undefined, 75), 100);

  const peClosedCase = { ceLtp: 100, peLtp: 80, ceQty: -75, peQty: 0, ceEntry: 100, peEntry: 80 };
  const peClosed = live(peClosedCase);
  const ownedPeClosed = ownedRow({}, peClosedCase);
  assert.equal(sidePremium({ ...ownedPeClosed, side: 'BOTH' } as FocusRow, peClosed, undefined, 75), 100);
});

test('sidePremium weights unequal CE/PE lots as lots×premium sum', () => {
  // Live book: CE 7 lots @ LTP 100, PE 9 lots @ LTP 24.50 (lot=65).
  const c = {
    ceLtp: 100, peLtp: 24.5, ceQty: -455, peQty: -585, ceEntry: 35.6, peEntry: 32.91, lotSize: 65,
  };
  const l = live(c);
  const owned = ownedRow({ slMultiplier: '1.8' }, c);
  const combined = (100 * 455 + 24.5 * 585) / 65;
  assert.ok(Math.abs(sidePremium(owned, l, undefined, 65) - combined) < 1e-9);
  // Entry combined = (35.6*455 + 32.91*585)/65 ≈ 545.39; ×1.8 ≈ 981.7.
  // Live combined ≈ 920.5 — under the stop, must not fire.
  assert.equal(evaluateRowExit(owned, l, 24000, undefined, 65), null);
});

test('legOwnContracts: a small own qty is used even against a much larger broker position', () => {
  // Two rows share the strike: this row's own ledger recorded 195, but the
  // broker's netQty at that security is the combined 650 (another row's
  // lots too). Must report 195, never the full 650.
  const c = { ceLtp: 0, peLtp: 14.45, ceQty: 0, peQty: -650, ceEntry: 0, peEntry: 31.67 };
  const l = live(c);
  const owned = ownedRow({}, { ...c, peQty: -195 }); // fill ledger records only 195
  assert.equal(legOwnContracts(owned, 'PE', l), 195);
});

test('legOwnContracts: page ledger and worker ledger both holding real lots for one row are summed, not picked', () => {
  const c = { ceLtp: 0, peLtp: 14.45, ceQty: 0, peQty: -455, ceEntry: 0, peEntry: 31.67 };
  const l = live(c);
  const owned = ownedRow({}, { ...c, peQty: -260 }); // page fill: 260
  const workerHold: WorkerHold = { open: true, peStrike: 24000, peQty: 195 }; // worker: 195
  assert.equal(legOwnContracts(owned, 'PE', l, workerHold), 455);
});

test('legOwnContracts: no ledger on either side owns nothing, never the broker net', () => {
  const c = { ceLtp: 0, peLtp: 14.45, ceQty: 0, peQty: -650, ceEntry: 0, peEntry: 31.67 };
  const l = live(c);
  const draft = row({ fill: undefined });
  assert.equal(legOwnContracts(draft, 'PE', l), 0);
});

test('sidePremium excludes a leg the row does not own even if the broker shows it', () => {
  const c = { ceLtp: 100, peLtp: 80, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 80 };
  const l = live(c);
  // No fill at all — a brand-new/draft row that merely resolved onto a strike
  // someone else already holds.
  assert.equal(sidePremium({ ...row({}), side: 'BOTH' } as FocusRow, l, undefined, 75), 0);
});

test('a zero premium never satisfies a premium rule', () => {
  // Two failed quote reads sum to 0. Without the > 0 guards that reads as
  // "collapsed below VWAP" and as an infinite loss multiple.
  const c = { ceLtp: 0, peLtp: 0, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 80, vwap: 195, vwapClose: 0 };
  const dead = live(c);
  assert.equal(
    evaluateRowExit(ownedRow({ levelVw: true, slMultiplier: '2' }, c), dead, 24000, undefined, 75),
    null,
  );
});

test('the trail floor is monotonic across a falling sequence', () => {
  const cfg = {
    riskEnabled: false, targetRupees: '', stopRupees: '',
    trailEnabled: true, triggerRupees: '2000', lockRupees: '500',
  };
  let floor: number | null = null;
  let peak = 0;
  const seen: (number | null)[] = [];
  for (const pnl of [500, 2000, 3500, 5000, 4200, 4800, 3000]) {
    peak = Math.max(peak, pnl);
    const out = evaluateGlobalRisk(cfg, { totalPnl: pnl, peakPnl: peak, lockFloor: floor });
    floor = out.lockFloor;
    seen.push(floor);
    if (out.exitAll) break;
  }
  // Never decreases, and the run stops the moment P&L falls to the floor.
  for (let i = 1; i < seen.length; i++) {
    if (seen[i - 1] === null) continue;
    assert.ok((seen[i] as number) >= (seen[i - 1] as number),
      `floor fell from ${seen[i - 1]} to ${seen[i]}`);
  }
  assert.equal(floor, 4500);
});

test('stopPremium: entry × multiplier, off at 1 or missing entry', () => {
  assert.equal(stopPremium(40, 1.8), 72);
  assert.equal(stopPremium(40, '1.8'), 72);
  assert.equal(stopPremium(40, 1), null);
  assert.equal(stopPremium(40, '1.2'), 48);
  assert.equal(stopPremium(0, 1.8), null);
  assert.equal(stopPremium(40, ''), null);
});

test('legStopPremium uses sellAvg when the row owns a short, else live LTP', () => {
  const c = { ceLtp: 50, peLtp: 30, ceQty: -65, peQty: 0, ceEntry: 40, peEntry: 0 };
  const open = ownedRow({ ceSlMultiplier: '1.8', peSlMultiplier: '1.8' }, c);
  assert.equal(legStopPremium(open, 'CE', live(c)), 72);
  assert.equal(legStopPremium(open, 'PE', live(c)), 54); // PE flat → 30 × 1.8
  const draft = row({ ceSlMultiplier: '1.8', peSlMultiplier: '1.8' });
  assert.equal(legStopPremium(draft, 'CE', live({ ...c, ceQty: 0, ceEntry: 0 })), 90);
});

test('pairStopPremium uses combined entry when open, combined LTP when flat', () => {
  const c = { ceLtp: 50, peLtp: 40, ceQty: -65, peQty: -65, ceEntry: 38, peEntry: 25, lotSize: 65 };
  const open = ownedRow({ slMultiplier: '1.8' }, c);
  // 1 lot each → combined entry 38+25 = 63, ×1.8 = 113.4
  assert.equal(pairStopPremium(open, live(c), undefined, 65), 63 * 1.8);
  const draft = row({ slMultiplier: '1.8', lots: 1 });
  // Flat preview: lots × (ceLtp + peLtp) = 1 × 90 = 90, ×1.8 = 162
  assert.equal(
    pairStopPremium(draft, live({ ...c, ceQty: 0, peQty: 0, ceEntry: 0, peEntry: 0 }), undefined, 65),
    90 * 1.8,
  );
  assert.equal(pairStopPremium(row({ slMultiplier: '1' }), live(c), undefined, 65), null);
});

test('pairStopPremium uses lots×premium sum for unequal sizes', () => {
  const c = {
    ceLtp: 34.7, peLtp: 24.5, ceQty: -455, peQty: -585, ceEntry: 35.6, peEntry: 32.91, lotSize: 65,
  };
  const open = ownedRow({ slMultiplier: '1.8' }, c);
  const entrySum = (35.6 * 455 + 32.91 * 585) / 65;
  assert.ok(Math.abs((pairStopPremium(open, live(c), undefined, 65) as number) - entrySum * 1.8) < 1e-6);
  // Bare 1-lot CE+PE sum must NOT be what we show.
  assert.notEqual(pairStopPremium(open, live(c), undefined, 65), (35.6 + 32.91) * 1.8);
});

test('pairStopPremium: CE 2@40 + PE 4@60 → combined 320, SL ×1.2 = 384', () => {
  const c = {
    ceLtp: 40, peLtp: 60, ceQty: -150, peQty: -300, ceEntry: 40, peEntry: 60, lotSize: 75,
  };
  const open = ownedRow({ slMultiplier: '1.2' }, c);
  assert.equal(pairStopPremium(open, live(c), undefined, 75), 384);
  assert.equal(sidePremium(open, live(c), undefined, 75), 320);
});

// ── Ghost-drop grace window ──────────────────────────────────────────────────
//
// Regression coverage for the race the worker removal (31fadcf) dropped and
// 1ea9d3d restored: Kotak/Zerodha have no fill-confirmation socket, so a
// position poll can still read a leg as flat (netQty===0) for a few seconds
// after a real fill. Without the grace window that poll zeroes the row's own
// fill ledger and marks it exited while the broker position is still open —
// nothing then watches it for SL/target/exit-time again.

test('nextOpenedTs stamps only the flat→held transition, and clears on flat', () => {
  const t0 = 1_000_000;
  // Flat → held: stamps now.
  assert.equal(nextOpenedTs(0, 75, null, t0), t0);
  // Already held, adding more on the same leg: keeps the original stamp.
  assert.equal(nextOpenedTs(75, 150, t0, t0 + 5_000), t0);
  // Held → flat (full reduce): no open time at all.
  assert.equal(nextOpenedTs(75, 0, t0, t0 + 5_000), null);
  // A leg with no prior stamp that's already held (legacy fill) still gets one.
  assert.equal(nextOpenedTs(75, 150, undefined, t0), t0);
});

test('isGhostDropProtected shields a just-opened leg from a stale zero poll, then releases it', () => {
  const openedAt = 1_000_000;
  const pageOwn = 75; // this row's own ledger still shows the leg held

  // A poll landing seconds after the fill, still reading the old (flat) book:
  // must NOT be treated as "actually flat".
  assert.equal(isGhostDropProtected(pageOwn, openedAt, openedAt + 5_000), true);
  assert.equal(isGhostDropProtected(pageOwn, openedAt, openedAt + GHOST_DROP_GRACE_MS - 1), true);

  // The same poll, once the grace window has fully elapsed: now trusted —
  // a leg still reading flat this long after opening really is flat.
  assert.equal(isGhostDropProtected(pageOwn, openedAt, openedAt + GHOST_DROP_GRACE_MS), false);
  assert.equal(isGhostDropProtected(pageOwn, openedAt, openedAt + 60_000), false);
});

test('isGhostDropProtected never shields a leg this row does not own', () => {
  const openedAt = 1_000_000;
  // No fill-ledger qty (pageOwn===0) — nothing to protect, regardless of any
  // stale timestamp still sitting on disk from a prior position.
  assert.equal(isGhostDropProtected(0, openedAt, openedAt + 1_000), false);
  // Owned, but no stamp at all (legacy session, or never opened) — no grace.
  assert.equal(isGhostDropProtected(75, null, openedAt), false);
  assert.equal(isGhostDropProtected(75, undefined, openedAt), false);
});

test('a full exit-then-reentry gets a fresh grace window, not the old one', () => {
  const openedAt = 1_000_000;
  // First fill opens the leg…
  let ts = nextOpenedTs(0, 75, null, openedAt);
  assert.equal(ts, openedAt);
  // …a real exit closes it, clearing the stamp…
  ts = nextOpenedTs(75, 0, ts, openedAt + 60_000);
  assert.equal(ts, null);
  // …well past the original grace window, so if the old stamp had lingered
  // this would already be unprotected. A later re-entry must start its own
  // window from the new open time, not read as protected off the stale one.
  const reenteredAt = openedAt + 120_000;
  ts = nextOpenedTs(0, 75, ts, reenteredAt);
  assert.equal(ts, reenteredAt);
  assert.equal(isGhostDropProtected(75, ts, reenteredAt + 5_000), true);
});

// ── Sim rows ─────────────────────────────────────────────────────────────────

test('only an explicit sim mode is paper — a row saved before the field is real', () => {
  assert.equal(isSimRow({ mode: 'sim' }), true);
  assert.equal(isSimRow({ mode: 'real' }), false);
  // Legacy rows on disk have no mode and have always traded real money.
  assert.equal(isSimRow({}), false);
});

test('a sim leg reads as this row\'s own short to the P&L and exit rules', () => {
  assert.equal(simLegPosition('CE', 0, 100), null);
  const pos = simLegPosition('CE', 65, 173.5)!;
  assert.equal(pos.netQty, -65);
  assert.equal(pos.sellAvg, 173.5);
  const row = { fill: { ceStrike: 22750, peStrike: null, ceQty: 65, peQty: 0, ts: '' } } as Pick<FocusRow, 'fill'>;
  const live = { cePosition: pos, pePosition: null } as RowLive;
  assert.equal(legOwnContracts(row, 'CE', live), 65);
  assert.equal(legsFlat(live), false);
});

// ── Leg SL follow-ups (TS-only: the retired Python worker never had these) ────

test('legPinnedStrike: a closed leg releases its pin while the other stays open', () => {
  // The straddle incident: CE stopped out at 22750, PE still open.
  const r = row({ fill: { ceStrike: 22750, peStrike: 22750, ceQty: 0, peQty: 75, ts: '' } });
  assert.equal(legPinnedStrike(r, 'CE'), null);
  assert.equal(legPinnedStrike(r, 'PE'), 22750);
  assert.equal(legPinnedStrike(row({}), 'CE'), null);
});

test('slRollStrike: OTM is up for CE, down for PE', () => {
  assert.equal(slRollStrike('CE', 22750, 1, 50), 22800);
  assert.equal(slRollStrike('PE', 22750, 1, 50), 22700);
  assert.equal(slRollStrike('CE', 50000, 2, 100), 50200);
});

test('evaluateReentry gates (SL, legacy OTM roll fields)', () => {
  const ctx = { nowHm: '10:00', product: 'INTRADAY' as const, groupEnabled: true, backstopHm: '15:17', done: 0 };
  assert.equal(evaluateReentry(row({ slRollStrikes: 0 }), 'sl', ctx).enter, false);
  // A row saved before re-entry modes existed: slRollStrikes > 0 means OTM.
  const legacy = evaluateReentry(row({ slRollStrikes: 1 }), 'sl', ctx);
  assert.equal(legacy.enter, true);
  assert.equal(legacy.mode, 'otm');
  assert.equal(evaluateReentry(row({ slRollStrikes: 1 }), 'sl', { ...ctx, done: DEFAULT_SL_ROLL_MAX }).enter, false);
  assert.equal(evaluateReentry(row({ slRollStrikes: 1, slRollMax: 3 }), 'sl', { ...ctx, done: 2 }).enter, true);
  assert.equal(evaluateReentry(row({ slRollStrikes: 1 }), 'sl', { ...ctx, groupEnabled: false }).enter, false);
  assert.equal(evaluateReentry(row({ slRollStrikes: 1, exitTime: '09:59' }), 'sl', ctx).enter, false);
  assert.equal(evaluateReentry(row({ slRollStrikes: 1 }), 'sl', { ...ctx, nowHm: '15:17' }).enter, false);
  assert.equal(evaluateReentry(row({ slRollStrikes: 1 }), 'sl', { ...ctx, nowHm: '15:17', product: 'MARGIN' }).enter, true);
  // An explicit mode wins over the legacy field, and 'off' switches it off.
  assert.equal(evaluateReentry(row({ slRollStrikes: 1, reSlMode: 'off' }), 'sl', ctx).enter, false);
  assert.equal(evaluateReentry(row({ reSlMode: 'cost' }), 'sl', ctx).mode, 'cost');
  // reSlMax wins over slRollMax.
  assert.equal(evaluateReentry(row({ reSlMode: 'asap', reSlMax: 5, slRollMax: 1 }), 'sl', { ...ctx, done: 4 }).enter, true);
});

test('evaluateReentry: target trigger and No re-entry after', () => {
  const ctx = { nowHm: '11:00', product: 'INTRADAY' as const, groupEnabled: true, backstopHm: '15:17', done: 0 };
  assert.equal(evaluateReentry(row({}), 'tgt', ctx).enter, false);           // off by default
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap' }), 'tgt', ctx).enter, true);
  // SL settings don't leak into target.
  assert.equal(evaluateReentry(row({ reSlMode: 'asap' }), 'tgt', ctx).enter, false);
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap', noReEntryAfter: '11:00' }), 'tgt', ctx).enter, false);
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap', noReEntryAfter: '11:01' }), 'tgt', ctx).enter, true);
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap', reTgtMax: 1 }), 'tgt', { ...ctx, done: 1 }).enter, false);
});

test('reentryWindowClosed', () => {
  const ctx = { nowHm: '10:00', product: 'INTRADAY' as const, groupEnabled: true, backstopHm: '15:17' };
  assert.equal(reentryWindowClosed(row({}), ctx), null);
  assert.match(reentryWindowClosed(row({ noReEntryAfter: '09:30' }), ctx) ?? '', /no re-entry after/);
});

test('pendingReentryLevel + pendingReentryHit', () => {
  // Cost after SL: wait for the premium to FALL back to entry.
  const costSl = pendingReentryLevel('cost', 'sl', { entry: 200 });
  assert.deepEqual(costSl, { price: 200, dir: 'down' });
  assert.equal(pendingReentryHit(costSl!, 201), false);
  assert.equal(pendingReentryHit(costSl!, 200), true);
  // Cost after target: wait for it to CLIMB back to entry.
  assert.deepEqual(pendingReentryLevel('cost', 'tgt', { entry: 200 }), { price: 200, dir: 'up' });
  assert.equal(pendingReentryLevel('cost', 'sl', { entry: 0 }), null);
  // Momentum: new strike at 180, 20 pts down → fires at 160; up → 200.
  const sm = (dir: 'up' | 'down', value = '20') => ({ enabled: true, value, src: 'premium' as const, unit: 'pts' as const, dir });
  // RE-Momentum follows the leg's Simple Momentum (AlgoTest: 180 + 20 pts up → 200)
  assert.deepEqual(pendingReentryLevel('momentum', 'sl', { start: 180, simple: sm('down') }), { price: 160, dir: 'down' });
  assert.deepEqual(pendingReentryLevel('momentum', 'sl', { start: 180, simple: sm('up') }), { price: 200, dir: 'up' });
  assert.deepEqual(pendingReentryLevel('momentum', 'sl', { start: 18000, simple: { enabled: true, value: '0.5', src: 'underlying', unit: 'pct', dir: 'up' } }), { price: 18090, dir: 'up' });
  assert.equal(pendingReentryLevel('momentum', 'sl', { start: 180, simple: { ...sm('up'), enabled: false } }), null);
  assert.equal(pendingReentryLevel('momentum', 'sl', { start: 180 }), null);
  assert.equal(pendingReentryLevel('momentum', 'sl', { start: 10, simple: sm('down') }), null);
  // A missing quote (0) never fires.
  assert.equal(pendingReentryHit({ price: 200, dir: 'down' }, 0), false);
});

test('legTargetReason', () => {
  const c = { ceLtp: 50, peLtp: 0, ceQty: -75, peQty: 0, ceEntry: 100, peEntry: 0 };
  const r = (pct: string) => row({ ceTgtPct: pct, fill: { ceStrike: 24000, peStrike: null, ceQty: 75, peQty: 0, ceEntry: 100, ts: '' } });
  // 50% of entry 100 → fires at 50.
  assert.match(legTargetReason(r('50'), 'CE', live(c)) ?? '', /CE target 50% hit/);
  assert.equal(legTargetReason(r('50'), 'CE', live({ ...c, ceLtp: 51 })), null);
  // Off: blank, 0, ≥100.
  assert.equal(legTargetReason(r(''), 'CE', live(c)), null);
  assert.equal(legTargetReason(r('100'), 'CE', live(c)), null);
  // Not owned → nothing.
  assert.equal(legTargetReason(row({ ceTgtPct: '50' }), 'CE', live(c)), null);
});

test('costStopReason: only once armed, and only at/above entry', () => {
  const c = { ceLtp: 0, peLtp: 100, ceQty: 0, peQty: -75, ceEntry: 0, peEntry: 100 };
  const fill = { ceStrike: null, peStrike: 24000, ceQty: 0, peQty: 75, ts: '' };
  // Not armed (sibling SL never fired) → nothing, even at cost.
  assert.equal(costStopReason(row({ slToCost: true, fill }), 'PE', live(c)), null);
  // Armed but the option is off → nothing.
  assert.equal(costStopReason(row({ slToCost: false, fill: { ...fill, peCostStop: true } }), 'PE', live(c)), null);
  const armed = row({ slToCost: true, fill: { ...fill, peCostStop: true } });
  assert.match(costStopReason(armed, 'PE', live(c)) ?? '', /PE SL to cost hit/);
  assert.equal(costStopReason(armed, 'PE', live({ ...c, peLtp: 99.5 })), null);
  // Leg no longer owned → nothing.
  assert.equal(costStopReason(row({ slToCost: true, fill: { ...fill, peQty: 0, peCostStop: true } }), 'PE', live(c)), null);
});

test('legOwnEntry: own stamped entry first, broker avg only as fallback', () => {
  // Broker sellAvg 110 is a day blend (e.g. an earlier trade on this strike).
  const c = { ceLtp: 0, peLtp: 100, ceQty: 0, peQty: -150, ceEntry: 0, peEntry: 110 };
  const stamped = row({ fill: { ceStrike: null, peStrike: 24000, ceQty: 0, peQty: 150, peEntry: 105, ts: '' } });
  assert.equal(legOwnEntry(stamped, 'PE', live(c)), 105);
  const legacy = row({ fill: { ceStrike: null, peStrike: 24000, ceQty: 0, peQty: 150, ts: '' } });
  assert.equal(legOwnEntry(legacy, 'PE', live(c)), 110);
});

test('costStopReason: uses own entry, not a blended broker avg', () => {
  // Broker day-avg 90 (old trade blended in), own entry 100, LTP 95:
  // cost has NOT been reached, even though LTP is above the broker avg.
  const c = { ceLtp: 0, peLtp: 95, ceQty: 0, peQty: -75, ceEntry: 0, peEntry: 90 };
  const r = row({ slToCost: true, fill: { ceStrike: null, peStrike: 24000, ceQty: 0, peQty: 75, peEntry: 100, peCostStop: true, ts: '' } });
  assert.equal(costStopReason(r, 'PE', live(c)), null);
  assert.match(costStopReason(r, 'PE', live({ ...c, peLtp: 100 })) ?? '', /SL to cost hit/);
});

test('legStopReason / legStopPremium: own entry beats a day-blended broker avg', () => {
  // Re-sold the same strike at 120 after an earlier trade at 100: the broker
  // shows a blended sellAvg of 110. SL ×1.2 must be 144 (off 120), not 132.
  const c = { ceLtp: 135, peLtp: 0, ceQty: -75, peQty: 0, ceEntry: 110, peEntry: 0 };
  const r = row({ ceSlMultiplier: '1.2', fill: { ceStrike: 24000, peStrike: null, ceQty: 75, peQty: 0, ceEntry: 120, ts: '' } });
  assert.equal(legStopReason(r, 'CE', live(c)), null);
  assert.ok(Math.abs((legStopPremium(r, 'CE', live(c)) ?? 0) - 144) < 1e-9);
  assert.match(legStopReason(r, 'CE', live({ ...c, ceLtp: 144 })) ?? '', /CE SL ×1.2 hit/);
  // No stamped entry (legacy ledger) → broker avg, as before.
  const legacy = row({ ceSlMultiplier: '1.2', fill: { ceStrike: 24000, peStrike: null, ceQty: 75, peQty: 0, ts: '' } });
  assert.match(legStopReason(legacy, 'CE', live(c)) ?? '', /CE SL ×1.2 hit/);
});

test('costReentryBasis: RE-Cost keeps the strike\'s initial entry across re-entries', () => {
  // First cost re-entry on 22600: the closed leg's own entry becomes the basis.
  const first = costReentryBasis(null, 22600, 200);
  assert.deepEqual(first, { strike: 22600, price: 200 });
  // Re-sold at 198 and stopped again on the same strike: still waits for 200.
  assert.deepEqual(costReentryBasis(first, 22600, 198), { strike: 22600, price: 200 });
  // A different strike (e.g. after an ASAP/OTM re-entry) starts its own basis.
  assert.deepEqual(costReentryBasis(first, 22650, 180), { strike: 22650, price: 180 });
  assert.equal(costReentryBasis(null, 22600, 0), null);
  assert.deepEqual(costReentryBasis({ strike: 22600, price: 0 }, 22600, 190), { strike: 22600, price: 190 });
});

test('awaitingMomentumQuote: only a momentum re-entry with no reference premium yet', () => {
  assert.equal(awaitingMomentumQuote({ mode: 'momentum', price: 0 }), true);
  assert.equal(awaitingMomentumQuote({ mode: 'momentum', price: 160 }), false);
  // Cost always has a price (the entry); 0 there is not "awaiting".
  assert.equal(awaitingMomentumQuote({ mode: 'cost', price: 0 }), false);
  // A price-0 pending never fires on its own.
  assert.equal(pendingReentryHit({ price: 0, dir: 'down' }, 150), false);
});

test('legTargetLevel / legTargetReason in points', () => {
  assert.equal(legTargetLevel(100, '30', 'pts'), 70);
  assert.equal(legTargetLevel(100, '30', 'pct'), 70);
  assert.equal(legTargetLevel(100, '30', undefined), 70);       // missing unit = %
  assert.equal(legTargetLevel(200, '30', 'pct'), 140);
  assert.equal(legTargetLevel(200, '30', 'pts'), 170);
  // Off: blank, 0, no entry, or a level at/below zero.
  assert.equal(legTargetLevel(100, '', 'pts'), null);
  assert.equal(legTargetLevel(0, '30', 'pts'), null);
  assert.equal(legTargetLevel(100, '100', 'pts'), null);
  assert.equal(legTargetLevel(100, '100', 'pct'), null);
  const c = { ceLtp: 170, peLtp: 0, ceQty: -75, peQty: 0, ceEntry: 200, peEntry: 0 };
  const r = row({ ceTgtPct: '30', legTgtUnit: 'pts', fill: { ceStrike: 24000, peStrike: null, ceQty: 75, peQty: 0, ceEntry: 200, ts: '' } });
  assert.match(legTargetReason(r, 'CE', live(c)) ?? '', /CE target 30 pts hit/);
  assert.equal(legTargetReason(r, 'CE', live({ ...c, ceLtp: 171 })), null);
});

test('overall momentum entry gate', () => {
  const m = (o: object) => o as never;
  assert.equal(evaluateEntryMomentum(m({}), null, null).ready, true);
  assert.equal(evaluateEntryMomentum(m({ entryMomValue: '10' }), 200, 200).ready, true);   // switch off
  const d0 = evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10' }), null, 200);
  assert.equal(d0.ready, false); assert.equal(d0.ref, 200); assert.equal(d0.trigger, 210);
  assert.equal(evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10' }), 200, 209.9).ready, false);
  assert.equal(evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10' }), 200, 210).ready, true);
  assert.equal(evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10', entryMomDir: 'down' }), 200, 190).ready, true);
  assert.equal(evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10', entryMomDir: 'down' }), 200, 190.5).ready, false);
  assert.equal(evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10', entryMomUnit: 'pct' }), 200, 219).ready, false);
  assert.equal(evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10', entryMomUnit: 'pct' }), 200, 220).ready, true);
  assert.equal(evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10', entryMomUnit: 'pct', entryMomDir: 'down' }), 200, 180).ready, true);
  const d1 = evaluateEntryMomentum(m({ entryMomEnabled: true, entryMomValue: '10' }), null, null, 200);
  assert.equal(d1.ready, false); assert.equal(d1.ref, 200);
});

test('simple momentum per leg', () => {
  const pts = (dir: 'up' | 'down', value = '15') => ({ enabled: true, value, src: 'premium' as const, unit: 'pts' as const, dir });
  assert.equal(simpleMomOn(undefined), false);
  assert.equal(simpleMomOn({ ...pts('up'), value: '' }), false);
  assert.equal(simpleMomOn({ ...pts('up'), enabled: false }), false);
  // AlgoTest doc: premium 200, +15 pts → 215; 15% → 230 up, 170 down
  assert.equal(simpleMomLevel(pts('up'), 200), 215);
  assert.equal(simpleMomLevel({ ...pts('up'), unit: 'pct' }, 200), 230);
  assert.equal(simpleMomLevel({ ...pts('down'), unit: 'pct' }, 200), 170);
  // underlying: spot 18000, 0.5% up → 18090; 18520 −15 pts → 18505
  assert.equal(simpleMomLevel({ enabled: true, value: '0.5', src: 'underlying', unit: 'pct', dir: 'up' }, 18000), 18090);
  assert.equal(simpleMomLevel({ enabled: true, value: '15', src: 'underlying', unit: 'pts', dir: 'down' }, 18520), 18505);
  assert.equal(simpleMomHit(pts('up'), 200, 214.9), false);
  assert.equal(simpleMomHit(pts('up'), 200, 215), true);
  assert.equal(simpleMomHit(pts('down'), 200, 185), true);
  assert.equal(simpleMomHit(pts('down'), 200, 185.1), false);
  assert.equal(simpleMomHit(pts('up'), 200, 0), false);      // no quote
  assert.equal(simpleMomLevel(pts('down', '250'), 200), null); // would reach ≤ 0
});

test('trail SL to breakeven scope', () => {
  const r = (o: object) => o as never;
  assert.equal(legHasOwnSl(r({ ceSlMultiplier: '1.2', peSlMultiplier: '1' }), 'CE'), true);
  assert.equal(legHasOwnSl(r({ ceSlMultiplier: '1.2', peSlMultiplier: '1' }), 'PE'), false);
  assert.equal(costStopApplies(r({ slToCost: false }), 'PE'), false);
  // default / 'all': any leg, even one with no SL
  assert.equal(costStopApplies(r({ slToCost: true, peSlMultiplier: '1' }), 'PE'), true);
  assert.equal(costStopApplies(r({ slToCost: true, slToCostScope: 'all', peSlMultiplier: '1' }), 'PE'), true);
  // 'sl': only legs that have their own SL
  assert.equal(costStopApplies(r({ slToCost: true, slToCostScope: 'sl', peSlMultiplier: '1' }), 'PE'), false);
  assert.equal(costStopApplies(r({ slToCost: true, slToCostScope: 'sl', peSlMultiplier: '1.5' }), 'PE'), true);
});

const LAZY = (o: object) => ({ id: 'L1', leg: 'CE', otmSteps: 2, lots: 1, slPct: '20', tgtPct: '40', onSl: '', onTgt: '', ...o });
const lazyRow = (o: object = {}) => ({
  ceSlMultiplier: '1.5', peSlMultiplier: '1.5', ceTgtPct: '10', peTgtPct: '10', legTgtUnit: 'pts',
  lazyLegs: [LAZY({}), LAZY({ id: 'L2', slPct: '', tgtPct: '' })],
  fill: { ceQty: 75, ceStrike: 24000, ceLazyId: 'L1', peQty: 75, peStrike: 24000, ts: '' },
  ...o,
}) as never;

test('lazy leg: its own SL / target replace the row\'s while it runs', () => {
  // running lazy leg → 1 + 20% and 40% target
  assert.equal(legSlMultiplier(lazyRow(), 'CE'), 1.2);
  assert.deepEqual(legTarget(lazyRow(), 'CE'), { value: '40', unit: 'pct' });
  // the other (root) slot keeps the row's values
  assert.equal(legSlMultiplier(lazyRow(), 'PE'), '1.5');
  assert.deepEqual(legTarget(lazyRow(), 'PE'), { value: '10', unit: 'pts' });
  // a lazy leg with no SL has none — not the row's
  assert.equal(Number(legSlMultiplier(lazyRow({ fill: { ceQty: 75, ceStrike: 24000, ceLazyId: 'L2', ts: '' } }), 'CE')) > 1, false);
  // no longer owned → no lazy leg
  assert.equal(runningLazyLeg(lazyRow({ fill: { ceQty: 0, ceLazyId: 'L1', ts: '' } }), 'CE'), null);
});

test('lazy leg: chain and strike', () => {
  const cfg = (o: object) => lazyRow({ reSlMode: 'lazy', reSlLazyId: 'L1', reTgtMode: 'off', ...o });
  // root leg uses the row's pick, only when the mode is lazy
  assert.equal(nextLazyLegId(cfg({}), null, 'sl'), 'L1');
  assert.equal(nextLazyLegId(cfg({ reSlMode: 'asap' }), null, 'sl'), null);
  assert.equal(nextLazyLegId(cfg({}), null, 'tgt'), null);
  // a lazy leg chains through its own onSl / onTgt, whatever the row's mode
  const chain = cfg({ reSlMode: 'off', lazyLegs: [LAZY({ onSl: 'L2', onTgt: '' }), LAZY({ id: 'L2' })] });
  assert.equal(nextLazyLegId(chain, 'L1', 'sl'), 'L2');
  assert.equal(nextLazyLegId(chain, 'L1', 'tgt'), null);
  assert.equal(nextLazyLegId(cfg({ reSlLazyId: 'gone' }), null, 'sl'), null);
  // AlgoTest example: spot 18465 → ATM 18450, OTM2 CE = 18550
  assert.equal(lazyLegStrike({ leg: 'CE', otmSteps: 2 }, 18450, 50), 18550);
  assert.equal(lazyLegStrike({ leg: 'PE', otmSteps: 2 }, 18450, 50), 18350);
  assert.equal(lazyLegStrike({ leg: 'CE', otmSteps: -1 }, 18450, 50), 18400);
});

test('range breakout rules', () => {
  const rb = (o: object = {}) => ({ enabled: true, end: '09:30', side: 'high' as const, on: 'instrument' as const, ...o });
  assert.equal(rangeBreakoutOn(rb(), '09:16'), true);
  assert.equal(rangeBreakoutOn(rb({ enabled: false }), '09:16'), false);
  assert.equal(rangeBreakoutOn(rb({ end: '09:16' }), '09:16'), false);   // empty range
  assert.equal(rangeBreakoutOn(rb({ end: '9:30' }), '09:16'), false);
  assert.equal(rangeBreakoutOn(undefined, '09:16'), false);
  const today = { startDate: '2026-10-01', start: '09:16', endDate: '2026-10-01', end: '09:30' };
  assert.equal(rangeWindowPhase(today, '2026-10-01', '09:15'), 'before');
  assert.equal(rangeWindowPhase(today, '2026-10-01', '09:16'), 'tracking');
  assert.equal(rangeWindowPhase(today, '2026-10-01', '09:29'), 'tracking');
  assert.equal(rangeWindowPhase(today, '2026-10-01', '09:30'), 'ended');
  // AlgoTest: after the range, "whenever the strike reaches" the high / low, take it
  const range = { high: 257.95, low: 180 };
  assert.equal(rangeBreakoutHit(rb(), range, 257.9), false);
  assert.equal(rangeBreakoutHit(rb(), range, 257.95), true);    // a touch counts
  assert.equal(rangeBreakoutHit(rb(), range, 260), true);
  assert.equal(rangeBreakoutHit(rb({ side: 'low' }), range, 180.05), false);
  assert.equal(rangeBreakoutHit(rb({ side: 'low' }), range, 180), true);
  assert.equal(rangeBreakoutHit(rb({ side: 'low' }), range, 170), true);
  assert.equal(rangeBreakoutHit(rb(), range, 0), false);                 // no quote
});

// ── Overall Strategy Settings ──
const OV_LIVE = (o: object = {}) => ({
  ceStrike: 24000, peStrike: 24000, ltpCe: 170, ltpPe: 130,
  cePosition: { netQty: -75, sellAvg: 170 }, pePosition: { netQty: -75, sellAvg: 130 },
  pnl: 0, entryPremium: 300, lotSize: 75, vwap: null, vwapClose: null, ...o,
}) as never;
const OV_ROW = (o: object = {}) => ({
  side: 'BOTH', slRupees: '', slMultiplier: '',
  fill: { ceQty: 75, peQty: 75, ceStrike: 24000, peStrike: 24000, ts: '' },
  ...o,
}) as never;
const tgt = (mode: string, value: string) => ({ overallTarget: { enabled: true, mode, value } });
const trail = (o: object) => ({ overallTrail: { enabled: true, kind: 'lock', reach: '', lock: '', every: '', by: '', ...o } });

test('overall SL config reads the row\'s SL ₹ / SL ×', () => {
  assert.deepEqual(overallSlConfig({ slRupees: '5000', slMultiplier: '1.3' } as never), { mode: 'mtm', value: 5000 });
  const pct = overallSlConfig({ slRupees: '', slMultiplier: '1.3' } as never);
  assert.equal(pct?.mode, 'premiumPct'); assert.ok(Math.abs((pct?.value ?? 0) - 30) < 1e-9);
  assert.equal(overallSlConfig({ slRupees: '', slMultiplier: '1' } as never), null);
});

test('overall target: MTM and % of premium', () => {
  assert.equal(evaluateOverallExit(OV_ROW(tgt('mtm', '5000')), OV_LIVE({ pnl: 4999 }), { pnl: 4999, pts: 0 }), null);
  const hit = evaluateOverallExit(OV_ROW(tgt('mtm', '5000')), OV_LIVE({ pnl: 5000 }), { pnl: 5000, pts: 0 });
  assert.equal(hit?.kind, 'target');
  // doc: 30% of combined 300 = 90 points. premium 300 → 210 is a 90-point profit
  const live = (now: number) => OV_LIVE({ ltpCe: now * 170 / 300, ltpPe: now * 130 / 300 });
  assert.equal(evaluateOverallExit(OV_ROW(tgt('premiumPct', '30')), live(211), { pnl: 0, pts: 89 }), null);
  assert.equal(evaluateOverallExit(OV_ROW(tgt('premiumPct', '30')), live(210), { pnl: 0, pts: 90 })?.kind, 'target');
});

test('lock and lock-and-trail (doc numbers)', () => {
  // Lock: reach 10000, lock 5000
  const lock = OV_ROW(trail({ kind: 'lock', reach: '10000', lock: '5000' }));
  assert.equal(evaluateOverallExit(lock, OV_LIVE({ pnl: 4000 }), { pnl: 9000, pts: 0 }), null);          // never reached
  assert.equal(evaluateOverallExit(lock, OV_LIVE({ pnl: 5500 }), { pnl: 10000, pts: 0 }), null);          // above the lock
  assert.equal(evaluateOverallExit(lock, OV_LIVE({ pnl: 5000 }), { pnl: 10000, pts: 0 })?.kind, 'sl');
  // Lock and trail: 10000 → lock 5000, every 2000 trail 1000
  const lt = OV_ROW(trail({ kind: 'lockTrail', reach: '10000', lock: '5000', every: '2000', by: '1000' }));
  assert.equal(evaluateOverallExit(lt, OV_LIVE({ pnl: 6500 }), { pnl: 12000, pts: 0 }), null);            // floor now 6000
  assert.equal(evaluateOverallExit(lt, OV_LIVE({ pnl: 6000 }), { pnl: 12000, pts: 0 })?.kind, 'sl');
  assert.equal(evaluateOverallExit(lt, OV_LIVE({ pnl: 7000 }), { pnl: 14000, pts: 0 })?.kind, 'sl');      // floor 7000
  assert.equal(evaluateOverallExit(lt, OV_LIVE({ pnl: 7100 }), { pnl: 14000, pts: 0 }), null);
});

test('overall trail SL (doc numbers) — MTM and % of premium', () => {
  // SL 5000, trail every 3000 by 1500: profit 3000 → SL 3500; 6000 → 2000; 9000 → 500
  const t = (extra = {}) => OV_ROW({ slRupees: '5000', ...trail({ kind: 'trailSl', every: '3000', by: '1500' }), ...extra });
  assert.equal(evaluateOverallExit(t(), OV_LIVE({ pnl: -3500 }), { pnl: 0, pts: 0 }), null);             // untrailed: legacy SL's job
  assert.equal(evaluateOverallExit(t(), OV_LIVE({ pnl: -3500 }), { pnl: 3000, pts: 0 })?.kind, 'sl');
  assert.equal(evaluateOverallExit(t(), OV_LIVE({ pnl: -3400 }), { pnl: 3000, pts: 0 }), null);
  assert.equal(evaluateOverallExit(t(), OV_LIVE({ pnl: -2000 }), { pnl: 6000, pts: 0 })?.kind, 'sl');
  assert.equal(evaluateOverallExit(t(), OV_LIVE({ pnl: -500 }), { pnl: 9000, pts: 0 })?.kind, 'sl');
  assert.equal(evaluateOverallExit(t(), OV_LIVE({ pnl: -400 }), { pnl: 9000, pts: 0 }), null);
  // no SL → nothing to trail
  assert.equal(evaluateOverallExit(t({ slRupees: '' }), OV_LIVE({ pnl: -9999 }), { pnl: 3000, pts: 0 }), null);
  // %: SL 30% of 300 = 90 pts, trail 5% / 2% = every 15 pts by 6: peak 15 → SL 84; 45 → 72
  const pct = OV_ROW({ slMultiplier: '1.3', ...trail({ kind: 'trailSl', every: '5', by: '2' }) });
  const live = (pts: number) => OV_LIVE({ ltpCe: (300 - pts) * 170 / 300, ltpPe: (300 - pts) * 130 / 300 });
  assert.equal(evaluateOverallExit(pct, live(-84), { pnl: 0, pts: 15 })?.kind, 'sl');
  assert.equal(evaluateOverallExit(pct, live(-83), { pnl: 0, pts: 15 }), null);
  assert.equal(evaluateOverallExit(pct, live(-72), { pnl: 0, pts: 45 })?.kind, 'sl');
  assert.equal(evaluateOverallExit(pct, live(-71), { pnl: 0, pts: 45 }), null);
});

test('overall peak ratchets and never goes below zero', () => {
  assert.deepEqual(nextOverallPeak(undefined, { pnl: -50, pts: null }), { pnl: 0, pts: 0 });
  assert.deepEqual(nextOverallPeak({ pnl: 300, pts: 20 }, { pnl: 100, pts: 30 }), { pnl: 300, pts: 30 });
});

test('overall exit kind and re-entry decision', () => {
  assert.equal(overallExitKind('SL ₹5000 hit (P&L ₹-5001)'), 'sl');
  assert.equal(overallExitKind('SL ×1.3 hit (premium 391 vs entry 300)'), 'sl');
  assert.equal(overallExitKind('Overall Target ₹5000 reached (P&L ₹5000)'), 'target');
  assert.equal(overallExitKind('Overall Lock ₹5000 hit'), 'sl');
  assert.equal(overallExitKind('CE SL ×1.2 hit (premium 1 vs entry 1)'), null);   // a leg's own stop
  assert.equal(overallExitKind('Exit time 15:15 reached'), null);
  const ctx = { nowHm: '10:00', product: 'INTRADAY' as const, groupEnabled: true, backstopHm: '15:17' };
  const re = (o: object) => ({ slRupees: '5000', exitTime: '15:15', overallReSl: { enabled: true, mode: 'asap', max: 2 }, ...o }) as never;
  assert.equal(evaluateOverallReentry(re({}), 'sl', ctx).enter, true);
  assert.equal(evaluateOverallReentry(re({ overallReSl: { enabled: false, mode: 'asap', max: 2 } }), 'sl', ctx).enter, false);
  assert.equal(evaluateOverallReentry(re({ overallReSlCount: 2 }), 'sl', ctx).enter, false);          // max reached
  assert.equal(evaluateOverallReentry(re({ overallReSl: { enabled: true, mode: 'asap', max: 9 }, overallReSlCount: 5 }), 'sl', ctx).enter, false);  // capped at 5
  assert.equal(evaluateOverallReentry(re({ slRupees: '' }), 'sl', ctx).enter, false);                  // no overall SL set
  assert.equal(evaluateOverallReentry(re({ noReEntryAfter: '09:30' }), 'sl', ctx).enter, false);
  // target needs its own switch and target
  assert.equal(evaluateOverallReentry(re({ overallReTgt: { enabled: true, mode: 'momentum', max: 1 }, ...tgt('mtm', '9000') }), 'target', ctx).mode, 'momentum');
  assert.equal(evaluateOverallReentry(re({ overallReTgt: { enabled: true, mode: 'asap', max: 1 } }), 'target', ctx).enter, false);
});

test('re-range window after a stop / target (AlgoTest)', () => {
  // original 09:20–10:20 (1h), closed at 10:45 → 10:45–11:45
  assert.deepEqual(reRangeWindow('09:20', '10:20', '10:45'), { start: '10:45', end: '11:45' });
  assert.deepEqual(reRangeWindow('09:16', '09:30', '09:55'), { start: '09:55', end: '10:09' });
  assert.equal(reRangeWindow('09:30', '09:30', '10:00'), null);     // empty original
  assert.equal(reRangeWindow('09:20', '10:20', '23:30'), null);     // would run past midnight
  assert.equal(reRangeWindow('9:20', '10:20', '10:45'), null);
});

// ── AlgoTest parity review (2026-10-01) ─────────────────────────────────────

test('No Re-entry After: judged when the stop / target hit, not when the re-entry fires (AlgoTest)', () => {
  const r = { exitTime: '15:10', noReEntryAfter: '13:00' } as never;
  const ctx = { nowHm: '13:20', product: 'INTRADAY' as const, groupEnabled: true, backstopHm: '15:17' };
  // A stop at 13:20 (after the cutoff) takes no re-entry …
  assert.match(reentryWindowClosed(r, ctx) ?? '', /no re-entry after 13:00/);
  // … but a RE COST armed at 12:20 still fires when the price returns at 13:20.
  assert.equal(reentryWindowClosed(r, ctx, true), null);
  // The exit time and 15:17 still close a waiting one.
  assert.match(reentryWindowClosed(r, { ...ctx, nowHm: '15:10' }, true) ?? '', /exit time/);
});

test('Stop Monitoring After closes the re-entry window and is off when blank', () => {
  assert.equal(monitoringStopped({ stopMonitoringAfter: '14:00' }, '13:59'), false);
  assert.equal(monitoringStopped({ stopMonitoringAfter: '14:00' }, '14:00'), true);
  assert.equal(monitoringStopped({ stopMonitoringAfter: '' }, '15:00'), false);
  assert.equal(monitoringStopped({ stopMonitoringAfter: '9:5' }, '15:00'), false);
  const ctx = { nowHm: '14:30', product: 'MARGIN' as const, groupEnabled: true, backstopHm: '15:17' };
  assert.match(reentryWindowClosed({ exitTime: '', noReEntryAfter: '', stopMonitoringAfter: '14:00' } as never, ctx, true) ?? '', /monitoring stopped/);
});

test('RE MOMENTUM: combined with Overall Momentum, range, simple — else behaves like RE ASAP (glossary)', () => {
  const sm = { enabled: true, value: '20', src: 'premium', unit: 'pts', dir: 'up' };
  const rb = { enabled: true, end: '09:45', side: 'high', on: 'instrument' };
  const base = { entryTime: '09:20' };
  assert.equal(momentumReentryKind({ ...base } as never, 'CE'), 'asap');
  assert.equal(momentumReentryKind({ ...base, ceSimpleMom: sm } as never, 'CE'), 'simple');
  assert.equal(momentumReentryKind({ ...base, ceSimpleMom: sm } as never, 'PE'), 'asap');
  assert.equal(momentumReentryKind({ ...base, ceRangeBreakout: rb } as never, 'CE'), 'range');
  assert.equal(momentumReentryKind({ ...base, ceSimpleMom: sm, entryMomEnabled: true, entryMomValue: '10' } as never, 'CE'), 'combined');
  assert.equal(MAX_LEG_REENTRIES, 20);
});

const held = (o: object = {}) => ({
  ceSlMultiplier: '1.3', peSlMultiplier: '1.3',
  fill: { ceStrike: 18500, peStrike: 18500, ceQty: 75, peQty: 75, ceEntry: 200, peEntry: 200, ceSpotEntry: 43700, peSpotEntry: 43700, ts: '' },
  ...o,
}) as never;
const liveAt = (ce: number, pe = 200) => live({ ceLtp: ce, peLtp: pe, ceQty: -75, peQty: -75, ceEntry: 200, peEntry: 200 });

test('leg SL types: Points, Underlying Pts and Underlying % (doc numbers, sell side)', () => {
  // Points: entry 200, 30 points → a short stops at 230.
  const pts = held({ ceSlRule: { enabled: true, basis: 'pts', value: '30' } });
  assert.equal(legStopLevel(pts, 'CE', liveAt(229))?.level, 230);
  assert.equal(legStopReason(pts, 'CE', liveAt(229)), null);
  assert.match(legStopReason(pts, 'CE', liveAt(230)) ?? '', /CE SL 30 pts hit/);
  // SL × still in force on the other leg.
  assert.match(legStopReason(pts, 'PE', liveAt(200, 260)) ?? '', /PE SL ×1.3 hit/);
  // Underlying Points: BankNifty 43700, 80 points. Short CE loses as the index rises → 43780; short PE → 43620.
  const up = held({ ceSlRule: { enabled: true, basis: 'uPts', value: '80' }, peSlRule: { enabled: true, basis: 'uPts', value: '80' } });
  assert.equal(legStopReason(up, 'CE', liveAt(500), undefined, 43779), null);   // premium alone never fires it
  assert.match(legStopReason(up, 'CE', liveAt(150), undefined, 43780) ?? '', /CE SL 80 pts on the index hit/);
  assert.match(legStopReason(up, 'PE', liveAt(200, 150), undefined, 43620) ?? '', /PE SL 80 pts on the index hit/);
  assert.equal(legStopReason(up, 'PE', liveAt(200, 150), undefined, 0), null);  // no spot, no stop
  // Underlying %: 1% of 43700 = 437 → 44137 / 43263.
  const upct = held({ ceSlRule: { enabled: true, basis: 'uPct', value: '1' }, peSlRule: { enabled: true, basis: 'uPct', value: '1' } });
  assert.ok(Math.abs((legStopLevel(upct, 'CE', liveAt(200))?.level ?? 0) - 44137) < 1e-9);
  assert.ok(Math.abs((legStopLevel(upct, 'PE', liveAt(200))?.level ?? 0) - 43263) < 1e-9);
  // No spot recorded at entry (opened before it was stamped) → falls back to SL ×.
  const noSpot = held({ ceSlRule: { enabled: true, basis: 'uPts', value: '80' }, fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 200, ts: '' } });
  assert.equal(legStopLevel(noSpot, 'CE', liveAt(200))?.kind, 'mult');
});

test('leg target types: Underlying Pts / % in the short leg\'s favour (doc numbers)', () => {
  // BankNifty 43700, 50 points: short CE profits as the index falls → 43650; short PE as it rises → 43750.
  assert.equal(legTargetSpotLevel('CE', 43700, '50', 'uPts'), 43650);
  assert.equal(legTargetSpotLevel('PE', 43700, '50', 'uPts'), 43750);
  assert.ok(Math.abs((legTargetSpotLevel('PE', 43700, '1', 'uPct') ?? 0) - 44137) < 1e-9);
  assert.equal(legTargetSpotLevel('CE', 43700, '50', 'pts'), null);
  assert.equal(legTargetLevel(200, '50', 'uPts'), null);   // never a premium level
  const r = held({ ceTgtPct: '50', peTgtPct: '50', legTgtUnit: 'uPts' });
  assert.equal(legTargetReason(r, 'CE', liveAt(10), undefined, 43651), null);
  assert.match(legTargetReason(r, 'CE', liveAt(10), undefined, 43650) ?? '', /CE target 50 pts on the index hit/);
  assert.match(legTargetReason(r, 'PE', liveAt(200, 10), undefined, 43750) ?? '', /PE target 50 pts on the index hit/);
});

test('leg Trail SL "X - Y" (points doc example, mirrored for a short)', () => {
  // Doc (buy): entry 200, SL 175, trail 20-10 → 240 moves SL to 195, 280 to 215.
  // Short mirror: entry 200, SL 225 (25 pts), premium 160 → 215, 120 → 205.
  const t = { enabled: true, unit: 'pts' as const, every: '20', by: '10' };
  assert.equal(legTrailSteps(t, 200, 181), 0);
  assert.equal(legTrailSteps(t, 200, 180), 1);
  assert.equal(legTrailSteps(t, 200, 160), 2);
  assert.equal(legTrailSteps(t, 200, 120), 4);
  const r = held({ ceSlRule: { enabled: true, basis: 'pts', value: '25' }, ceTrailSl: t });
  assert.equal(legStopLevel(r, 'CE', liveAt(160), 160)?.level, 205);
  // The saved steps keep the stop down after the premium bounces back.
  const saved = held({ ceSlRule: { enabled: true, basis: 'pts', value: '25' }, ceTrailSl: t,
    fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 200, ceTrailSteps: 2, ts: '' } });
  assert.equal(legStopLevel(saved, 'CE', liveAt(199), 199)?.level, 205);
  assert.match(legStopReason(saved, 'CE', liveAt(205)) ?? '', /SL 25 pts trailed 2× hit/);
  // Percentage: "20% - 10%" of a 200 entry is "40 - 20".
  const pct = { enabled: true, unit: 'pct' as const, every: '20', by: '10' };
  assert.equal(legTrailSteps(pct, 200, 161), 0);
  assert.equal(legTrailSteps(pct, 200, 160), 1);
  // On SL × too: 200 × 1.3 = 260, one 40-point step → 240.
  const mult = held({ ceTrailSl: pct });
  assert.equal(legStopLevel(mult, 'CE', liveAt(160), 160)?.level, 240);
  // A stop on the index is not trailed.
  const idx = held({ ceSlRule: { enabled: true, basis: 'uPts', value: '80' }, ceTrailSl: t });
  assert.equal(legStopLevel(idx, 'CE', liveAt(100), 100)?.trailed, 0);
});

test('ORB Range stop loss (doc numbers)', () => {
  const range = { high: 18760, low: 18710 };
  assert.equal(orbStopDistance(range, { enabled: true, sign: '+', value: '20', unit: 'pts' }), 70);
  assert.equal(orbStopDistance(range, { enabled: true, sign: '-', value: '20', unit: 'pctRange' }), 40);
  assert.equal(orbStopDistance(range, { enabled: false, sign: '+', value: '20', unit: 'pts' }), null);
  assert.equal(orbStopDistance(range, { enabled: true, sign: '-', value: '100', unit: 'pctRange' }), null);
  // On the index, high breakout: short CE stops 70 above the high, short PE 70 below it.
  const orbSl = { enabled: true, sign: '+', value: '20', unit: 'pts' };
  const r = held({ ceOrbSl: orbSl, peOrbSl: orbSl, fill: {
    ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 75, ceEntry: 200, peEntry: 200, ts: '',
    ceOrb: { ...range, side: 'high', on: 'underlying' }, peOrb: { ...range, side: 'high', on: 'underlying' },
  } });
  assert.equal(legStopLevel(r, 'CE', liveAt(200))?.level, 18830);
  assert.equal(legStopLevel(r, 'PE', liveAt(200))?.level, 18690);
  assert.match(legStopReason(r, 'PE', liveAt(200), undefined, 18690) ?? '', /PE ORB SL 70.00 from the range high \(index\) hit/);
  // On the leg's own premium: always above the breakout level for a short.
  const inst = held({ ceOrbSl: orbSl, fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 258, ts: '',
    ceOrb: { high: 257.95, low: 220, side: 'high', on: 'instrument' } } });
  assert.ok(Math.abs((legStopLevel(inst, 'CE', liveAt(258))?.level ?? 0) - (257.95 + 37.95 + 20)) < 1e-9);
});

// ── Remaining AlgoTest gaps (2026-10-01, second pass) ───────────────────────

test('strike criteria — the docs\' worked examples', () => {
  const oc = {
    '19800': { ce: 190, pe: 30, ceDelta: 74, peDelta: 26 },
    '19900': { ce: 120, pe: 52, ceDelta: 62, peDelta: 38 },
    '20000': { ce: 100, pe: 100, ceDelta: 50, peDelta: 50 },
    '20100': { ce: 49, pe: 150, ceDelta: 36, peDelta: 64 },
    '20200': { ce: 40, pe: 210, ceDelta: 28, peDelta: 72 },
    '20300': { ce: 22, pe: 290, ceDelta: 22, peDelta: 78 },
  };
  const ctx = { atm: 20000, step: 100, oc };
  // Closest Premium: target 50 between 49 and 52 → the nearer one; a tie goes to the higher premium.
  assert.equal(closestPremiumStrike({ a: { ce: 49, pe: 0 }, b: { ce: 52, pe: 0 } } as never, 'CE', 50), null); // non-numeric keys skipped
  assert.equal(closestPremiumStrike({ '1': { ce: 49, pe: 0 }, '2': { ce: 52, pe: 0 } }, 'CE', 50), 1);
  assert.equal(closestPremiumStrike({ '1': { ce: 48, pe: 0 }, '2': { ce: 52, pe: 0 } }, 'CE', 50), 2);
  // Premium >= 50 between 49 and 52 → 52 (the 19900 PE).
  assert.equal(resolveCriteriaStrike('PREM_GTE', 'PE', { a: '50', b: '' }, ctx), 19900);
  // Premium Range 40–80: 40 and 49 qualify; a sell takes the highest → 49 (the 20100 CE).
  assert.equal(resolveCriteriaStrike('PREM_RANGE', 'CE', { a: '40', b: '80' }, ctx), 20100);
  // Straddle Width: ATM 20000, straddle 200, +0.5 → 20100; −1 → 19800.
  assert.equal(resolveCriteriaStrike('STRADDLE_WIDTH', 'CE', { a: '0.5', b: '' }, ctx), 20100);
  assert.equal(resolveCriteriaStrike('STRADDLE_WIDTH', 'PE', { a: '-1', b: '' }, ctx), 19800);
  // % of ATM: −1 → 19800, +1 → 20200.
  assert.equal(resolveCriteriaStrike('PCT_ATM', 'PE', { a: '-1', b: '' }, ctx), 19800);
  assert.equal(resolveCriteriaStrike('PCT_ATM', 'CE', { a: '1', b: '' }, ctx), 20200);
  // ATM Straddle Premium %: 20% of 200 = 40 → the 20200 CE.
  assert.equal(resolveCriteriaStrike('ATM_PREM_PCT', 'CE', { a: '20', b: '' }, ctx), 20200);
  // Closest Delta 50 → ATM; Delta Range 20–40 sell → highest inside (36 → 20100 CE); 45–55 with none → skipped.
  assert.equal(resolveCriteriaStrike('DELTA', 'CE', { a: '30', b: '' }, ctx), 20200);
  assert.equal(resolveCriteriaStrike('DELTA_RANGE', 'CE', { a: '20', b: '40' }, ctx), 20100);
  assert.equal(resolveCriteriaStrike('DELTA_RANGE', 'CE', { a: '40', b: '45' }, ctx), null);
  // Closest Delta accepts 0–100 inclusive, but a blank box is "not set", never delta 0.
  assert.equal(resolveCriteriaStrike('DELTA', 'CE', { a: '', b: '' }, ctx), null);
  assert.notEqual(resolveCriteriaStrike('DELTA', 'CE', { a: '0', b: '' }, ctx), null);
  assert.notEqual(resolveCriteriaStrike('DELTA', 'CE', { a: '100', b: '' }, ctx), null);
  assert.equal(resolveCriteriaStrike('DELTA', 'CE', { a: '101', b: '' }, ctx), null);
  assert.equal(resolveCriteriaStrike('DELTA_RANGE', 'CE', { a: '', b: '40' }, ctx), null);
  assert.equal(resolveCriteriaStrike('DELTA_RANGE', 'CE', { a: '20', b: '' }, ctx), null);
  assert.equal(resolveCriteriaStrike('DELTA_RANGE', 'CE', { a: '0', b: '100' }, ctx) != null, true);
  // Synthetic Future = ATM + CE − PE = 20000 at ATM here; +1 step → 20100.
  assert.equal(resolveCriteriaStrike('SYNTH_FUT', 'CE', { a: '1', b: '' }, ctx), 20100);
  assert.equal(resolveCriteriaStrike('EXACT', 'PE', { a: '20100', b: '' }, ctx), 20100);
  // Only strikes the chain lists: an Exact Strike it does not carry, or no chain, resolves to nothing
  // (never a contract that does not exist — that made the entry retry every second).
  assert.equal(resolveCriteriaStrike('EXACT', 'PE', { a: '23450', b: '' }, ctx), null);
  assert.equal(resolveCriteriaStrike('PCT_ATM', 'CE', { a: '1', b: '' }, { ...ctx, oc: undefined }), null);
  // Arithmetic rules snap only to a listed strike within one step: ATM + 5% = 21000 is beyond the
  // chain (it ends at 20300), so nothing — never the edge strike.
  assert.equal(resolveCriteriaStrike('PCT_ATM', 'CE', { a: '5', b: '' }, ctx), null);
  assert.equal(resolveCriteriaStrike('PCT_ATM', 'CE', { a: '1.5', b: '' }, ctx), 20300);   // 20300 itself
  // Round Strikes: NIFTY ATM 24150, interval 100 → OTM1/2/3 CE = 24200 / 24300 / 24400; PE OTM1 = 24100.
  const listed = Object.fromEntries([24000, 24050, 24100, 24150, 24200, 24250, 24300, 24350, 24400].map(k => [String(k), { ce: 1, pe: 1 }]));
  const r = { atm: 24150, step: 50, oc: listed, roundInterval: 100 };
  assert.equal(resolveCriteriaStrike('ROUND', 'CE', { a: '4', b: '' }, r), null);   // 24500 is not listed
  assert.equal(resolveCriteriaStrike('ROUND', 'CE', { a: '1', b: '' }, r), 24200);
  assert.equal(resolveCriteriaStrike('ROUND', 'CE', { a: '3', b: '' }, r), 24400);
  assert.equal(resolveCriteriaStrike('ROUND', 'PE', { a: '1', b: '' }, r), 24100);
  assert.equal(resolveCriteriaStrike('ROUND', 'CE', { a: '-1', b: '' }, r), 24100);
  // ATM reference = the eligible ROUND strike nearest ATM (a tie goes up), not the raw ATM 24150.
  assert.equal(resolveCriteriaStrike('ROUND', 'CE', { a: '0', b: '' }, r), 24200);
  assert.equal(resolveCriteriaStrike('ROUND', 'PE', { a: '0', b: '' }, { ...r, atm: 24100 }), 24100);
  assert.equal(resolveCriteriaStrike('ROUND', 'PE', { a: '0', b: '' }, { ...r, atm: 24050 }), 24100);   // 24050 is a tie → up
  // Premium <= (Focus Tool's old ₹ rule) keeps the target as a ceiling.
  assert.equal(resolveCriteriaStrike('PREM_LTE', 'CE', { a: '50', b: '' }, ctx), 20100);
});

test('chain delta → AlgoTest absolute 0–100', () => {
  assert.equal(absDelta100(0.25), 25);
  assert.equal(absDelta100(-0.4), 40);
  assert.equal(absDelta100(0), null);
  assert.equal(absDelta100(undefined), null);
});

test('delta SL / target / trail (doc numbers, sell side, model-basis fills)', () => {
  const liveD = (d: number) => ({ ...live({ ceLtp: 100, peLtp: 100, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 100 }), ceDelta: d, peDelta: d });
  const t = { enabled: true, unit: 'delta' as const, every: '5', by: '5' };
  const r = held({ ceSlRule: { enabled: true, basis: 'delta', value: '15' }, ceTrailSl: t,
    fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 100, ceDeltaEntry: 25, ceDeltaModel: true, ts: '' } });
  // Entry delta 25, SL 15 → stop at 40; trail 5-5: delta 20 → 35, 15 → 30, 10 → 25.
  assert.equal(legStopLevel(r, 'CE', liveD(25))?.level, 40);
  assert.equal(legStopLevel(r, 'CE', liveD(20))?.level, 35);
  assert.equal(legStopLevel(r, 'CE', liveD(15))?.level, 30);
  assert.equal(legStopLevel(r, 'CE', liveD(10))?.level, 25);
  assert.equal(ownedLegStop(r, 'CE', liveD(10))?.trailed, 3);
  assert.match(legStopReason(r, 'CE', liveD(40)) ?? '', /CE SL 15 delta hit \(delta 40.00/);
  // Target: entry delta 25, 15 → 10.
  assert.equal(legTargetDeltaLevel(25, '15'), 10);
  const tr = held({ ceTgtPct: '15', legTgtUnit: 'delta', fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 100, ceDeltaEntry: 25, ceDeltaModel: true, ts: '' } });
  assert.equal(legTargetReason(tr, 'CE', liveD(11)), null);
  assert.match(legTargetReason(tr, 'CE', liveD(10)) ?? '', /CE target 15 delta hit/);
  // No delta in the chain → no delta stop (falls back to SL ×).
  const nod = held({ ceSlRule: { enabled: true, basis: 'delta', value: '15' }, fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 100, ts: '' } });
  assert.equal(legStopLevel(nod, 'CE', liveD(30))?.kind, 'mult');
});

test('a fill opened before the model delta keeps being measured against Dhan\'s delta (no basis marker)', () => {
  // Entry 25 was Dhan's delta. Live: Dhan says 30, the model says 38 for the same strike. The stop (25 + 15 = 40) must read Dhan's 30.
  const liveBoth = (model: number, dhan: number) => ({ ...live({ ceLtp: 100, peLtp: 100, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 100 }), ceDelta: model, peDelta: model, ceDeltaDhan: dhan, peDeltaDhan: dhan });
  const legacy = held({ ceSlRule: { enabled: true, basis: 'delta', value: '15' },
    fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 100, ceDeltaEntry: 25, ts: '' } });
  assert.equal(legDeltaBasis({ ceDeltaEntry: 25 } as { ceDeltaModel?: boolean }, 'CE'), 'dhan');
  assert.equal(legStopLevel(legacy, 'CE', liveBoth(38, 30))?.deltaBasis, 'dhan');
  assert.equal(legStopReason(legacy, 'CE', liveBoth(41, 30)), null);                       // model would have fired at 41; Dhan's 30 has not
  assert.match(legStopReason(legacy, 'CE', liveBoth(30, 40)) ?? '', /CE SL 15 delta hit \(delta 40.00/);
  assert.equal(legDeltaNow('CE', liveBoth(38, 30), 'dhan'), 30);
  assert.equal(legDeltaNow('CE', liveBoth(38, 30)), 38);
  // The same row marked as model-basis reads the model's delta instead.
  const modelRow = held({ ceSlRule: { enabled: true, basis: 'delta', value: '15' },
    fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 100, ceDeltaEntry: 25, ceDeltaModel: true, ts: '' } });
  assert.equal(legDeltaBasis({ ceDeltaModel: true }, 'CE'), 'model');
  assert.match(legStopReason(modelRow, 'CE', liveBoth(41, 30)) ?? '', /CE SL 15 delta hit \(delta 41.00/);
  // Target uses the same basis rule.
  const legacyTgt = held({ ceTgtPct: '15', legTgtUnit: 'delta', fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 0, ceEntry: 100, ceDeltaEntry: 25, ts: '' } });
  assert.equal(legTargetReason(legacyTgt, 'CE', liveBoth(10, 30)), null);                 // model 10 would hit, Dhan's 30 has not
  assert.match(legTargetReason(legacyTgt, 'CE', liveBoth(30, 10)) ?? '', /CE target 15 delta hit/);
});

test('lazy leg: its own SL type replaces the row\'s', () => {
  const lazyRowPts = lazyRow({ lazyLegs: [LAZY({ slBasis: 'pts', slPct: '30', tgtUnit: 'pts', tgtPct: '20' })],
    fill: { ceQty: 75, ceStrike: 24000, ceLazyId: 'L1', ceEntry: 100, ts: '' } });
  const lv = live({ ceLtp: 129, peLtp: 0, ceQty: -75, peQty: 0, ceEntry: 100, peEntry: 0 });
  assert.equal(legStopLevel(lazyRowPts, 'CE', lv)?.level, 130);
  assert.equal(Number(legSlMultiplier(lazyRowPts, 'CE')) > 1, false);
  assert.match(legTargetReason(lazyRowPts, 'CE', live({ ceLtp: 80, peLtp: 0, ceQty: -75, peQty: 0, ceEntry: 100, peEntry: 0 })) ?? '', /CE target 20 pts hit/);
});

test('quantity multiplier scales lots and MTM limits, not % ones', () => {
  assert.equal(rowQtyMultiplier({}), 1);
  assert.equal(rowQtyMultiplier({ qtyMultiplier: 3 }), 3);
  assert.equal(rowQtyMultiplier({ qtyMultiplier: 0 }), 1);
  assert.equal(multipliedLots({ qtyMultiplier: 3 }, 2), 6);
  const c = { ceLtp: 100, peLtp: 100, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 100 };
  const base = { side: 'BOTH', slRupees: '5000', fill: { ceStrike: 1, peStrike: 1, ceQty: 75, peQty: 75, ts: '' } };
  assert.match(evaluateRowExit(base as never, { ...live(c), pnl: -5000 }, 0) ?? '', /SL ₹5000 hit/);
  assert.equal(evaluateRowExit({ ...base, qtyMultiplier: 2 } as never, { ...live(c), pnl: -5000 }, 0), null);
  assert.match(evaluateRowExit({ ...base, qtyMultiplier: 2 } as never, { ...live(c), pnl: -10000 }, 0) ?? '', /SL ₹10000 hit/);
  // Overall Target MTM 5000 × 2.
  const tgt = { ...base, slRupees: '', overallTarget: { enabled: true, mode: 'mtm', value: '5000' }, qtyMultiplier: 2 };
  assert.equal(evaluateOverallExit(tgt as never, { ...live(c), pnl: 6000 }, { pnl: 6000, pts: 0 }), null);
  assert.equal(evaluateOverallExit(tgt as never, { ...live(c), pnl: 10000 }, { pnl: 10000, pts: 0 })?.kind, 'target');
});

test('broker-level trailing kinds (doc numbers)', () => {
  const cfg = { riskEnabled: false, targetRupees: '', stopRupees: '5000', trailEnabled: true, triggerRupees: '10000', lockRupees: '5000' };
  const ctx = (pnl: number, peak: number) => ({ totalPnl: pnl, peakPnl: peak, lockFloor: null });
  // Trail SL 5000, 500 per 500: profit 1500 → SL 3500; exit at −3500.
  const ts = { ...cfg, trailKind: 'trailSl' as const, trailEvery: '500', trailBy: '500' };
  assert.equal(evaluateGlobalRisk(ts, ctx(-3400, 1500)).exitAll, false);
  assert.equal(evaluateGlobalRisk(ts, ctx(-3500, 1500)).exitAll, true);
  // Lock: reach 10000 lock 5000.
  const lk = { ...cfg, trailKind: 'lock' as const };
  assert.equal(evaluateGlobalRisk(lk, ctx(5000, 9000)).exitAll, false);   // never reached
  assert.equal(evaluateGlobalRisk(lk, ctx(5000, 10000)).exitAll, true);
  // Lock and Trail: +500 per 500 → at 11000 the lock is 6000.
  const lt = { ...cfg, trailKind: 'lockTrail' as const, trailEvery: '500', trailBy: '500' };
  assert.equal(evaluateGlobalRisk(lt, ctx(6100, 11000)).exitAll, false);
  assert.equal(evaluateGlobalRisk(lt, ctx(6000, 11000)).lockFloor, 6000);
  assert.equal(evaluateGlobalRisk(lt, ctx(6000, 11000)).exitAll, true);
});

test('BTST / Positional range windows (trading days, skipping weekends and NSE holidays)', () => {
  // 2026-10-01 is a Thursday; the previous trading day is Wednesday 2026-09-30, Monday's is the Friday before.
  assert.equal(tradingDaysBack('2026-10-01', 1), '2026-09-30');
  // 2026-10-02 (Gandhi Jayanti) is an NSE holiday: Monday's previous trading day is Thursday.
  assert.equal(tradingDaysBack('2026-10-05', 1), '2026-10-01');
  assert.equal(tradingDte('2026-10-01', '2026-10-06'), 2);   // Thu → Tue: Fri is a holiday, so Mon, Tue
  assert.equal(tradingDte('2026-10-19', '2026-10-21'), 1);   // Tue 20th (Dussehra) is a holiday
  assert.equal(dateForDte('2026-10-21', 1), '2026-10-19');
  assert.equal(dateForDte('2026-10-20', 0), '2026-10-19');   // expiry on a holiday moves to the day before
  assert.equal(tradingDte('2026-10-06', '2026-10-06'), 0);
  assert.equal(dateForDte('2026-10-06', 1), '2026-10-05');
  // BTST: start 10:30 yesterday, End "Tomorrow" 09:30 = today.
  const btst = rangeWindow({ enabled: true, end: '09:30', side: 'high', on: 'underlying', kind: 'btst' }, '10:30', '2026-10-01', '2026-10-06');
  assert.deepEqual(btst, { startDate: '2026-09-30', start: '10:30', endDate: '2026-10-01', end: '09:30' });
  assert.equal(rangeWindowPhase(btst!, '2026-10-01', '09:29'), 'tracking');
  assert.equal(rangeWindowPhase(btst!, '2026-10-01', '09:30'), 'ended');
  // Positional: Entry DTE 1 10:35 → End DTE 0 09:35.
  const pos = rangeWindow({ enabled: true, end: '09:35', side: 'high', on: 'underlying', kind: 'positional', startDte: 1, endDte: 0 }, '10:35', '2026-10-05', '2026-10-06');
  assert.deepEqual(pos, { startDate: '2026-10-05', start: '10:35', endDate: '2026-10-06', end: '09:35' });
  assert.equal(rangeWindowPhase(pos!, '2026-10-05', '10:00'), 'before');
  assert.equal(rangeWindowPhase(pos!, '2026-10-05', '11:00'), 'tracking');
  assert.equal(rangeWindowPhase(pos!, '2026-10-07', '11:00'), 'over');
  // Intraday is unchanged; a bad positional order is refused.
  assert.deepEqual(rangeWindow({ enabled: true, end: '09:30', side: 'high', on: 'instrument' }, '09:16', '2026-10-01', ''),
    { startDate: '2026-10-01', start: '09:16', endDate: '2026-10-01', end: '09:30' });
  assert.equal(rangeWindow({ enabled: true, end: '09:35', side: 'high', on: 'underlying', kind: 'positional', startDte: 0, endDte: 1 }, '10:35', '2026-10-05', '2026-10-06'), null);
  assert.equal(rangeBreakoutOn({ enabled: true, end: '09:30', side: 'high', on: 'underlying', kind: 'btst' }, '10:30'), true);
});

test('addMinutesHm', () => {
  assert.equal(addMinutesHm('09:20', 60), '10:20');
  assert.equal(addMinutesHm('23:59', 2), null);
  assert.equal(addMinutesHm('9:5', 1), null);
});

test('candle bucket for Overall Momentum Candle Close', () => {
  assert.equal(candleBucket('09:37', 5), '09:35');
  assert.equal(candleBucket('09:37', 1), '09:37');
  assert.equal(candleBucket('10:59', 15), '10:45');
});

test('review fixes: one stop object per leg; ORB stop comes from the stamp the open wrote', () => {
  // ownedLegStop + legStopHit = legStopReason, computed once.
  const r = held({ ceSlRule: { enabled: true, basis: 'pts', value: '30' } });
  const lv = liveAt(230);
  assert.equal(legStopHit(ownedLegStop(r, 'CE', lv), 'CE', lv), legStopReason(r, 'CE', lv));
  assert.match(legStopHit(ownedLegStop(r, 'CE', lv), 'CE', lv) ?? '', /CE SL 30 pts hit/);
  // Not owned → no stop at all.
  assert.equal(ownedLegStop(held({ fill: { ceStrike: 1, peStrike: 1, ceQty: 0, peQty: 0, ts: '' } }), 'CE', lv), null);
});

test('Entry / Exit Time are clamped to AlgoTest windows', () => {
  assert.equal(clampHm('09:10', ENTRY_TIME_MIN, ENTRY_TIME_MAX), '09:16');
  assert.equal(clampHm('15:40', ENTRY_TIME_MIN, ENTRY_TIME_MAX), '15:28');
  assert.equal(clampHm('09:35', ENTRY_TIME_MIN, ENTRY_TIME_MAX), '09:35');
  assert.equal(clampHm('09:16', EXIT_TIME_MIN, EXIT_TIME_MAX), '09:17');
  assert.equal(clampHm('15:30', EXIT_TIME_MIN, EXIT_TIME_MAX), '15:29');
  assert.equal(clampHm('', EXIT_TIME_MIN, EXIT_TIME_MAX), '');
});

test('modelAbsDelta100: delta comes from the central recipe, Dhan\'s only when the model cannot price the strike', () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const exp = day(7);
  const market = { spot: 22555.75, future: { price: 22640, expiry: day(22) } };
  // A 22900 call a week out, quoted at 28: a sane OTM delta, in AlgoTest's 0-100 scale.
  const d = modelAbsDelta100('CE', 22900, exp, 28, 14, 0.9, market)!;
  assert.ok(d > 10 && d < 40, `got ${d}`);
  // Not Dhan's number: a deliberately wrong chain delta is ignored while the model can price the strike.
  assert.equal(modelAbsDelta100('CE', 22900, exp, 28, 14, 0.99, market), d);
  // Puts report the absolute value.
  assert.ok(modelAbsDelta100('PE', 22200, exp, 28, 14, -0.9, market)! > 5);
  // No spot yet, no premium, no IV: fall back to Dhan's delta; with none of that, null (read as missing).
  assert.equal(modelAbsDelta100('CE', 22900, exp, 0, 0, 0.27, { spot: 0 }), 27);
  assert.equal(modelAbsDelta100('CE', 22900, exp, 0, 0, 0, { spot: 0 }), null);
});

test('modelAbsDelta100: a stale last print outside the quoted book is not used to solve IV', () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const market = { spot: 22555.75, future: { price: 22623.7, expiry: day(22) } };
  const exp = day(8);
  const stale = modelAbsDelta100('CE', 22900, exp, 5, 14, 0.9, market)!;                         // no book given: the 5.0 print is trusted
  const guarded = modelAbsDelta100('CE', 22900, exp, 5, 14, 0.9, market, { bid: 11, ask: 12 })!;  // market is 11-12: the mid prices it
  assert.ok(guarded > stale * 1.5, `stale ${stale} vs guarded ${guarded}`);
  // One-sided book (no bid): the last price is not trusted at all, so the chain IV (14%) sets the delta.
  const oneSided = modelAbsDelta100('CE', 22900, exp, 5, 14, 0.9, market, { bid: 0, ask: 12 })!;
  const viaIv = modelAbsDelta100('CE', 22900, exp, 0, 14, 0.9, market)!;
  assert.equal(oneSided, viaIv);
  // A print inside the book is kept.
  assert.equal(modelAbsDelta100('CE', 22900, exp, 11.5, 14, 0.9, market, { bid: 11, ask: 12 }), modelAbsDelta100('CE', 22900, exp, 11.5, 14, 0.9, market));
});

