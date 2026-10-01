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
  evaluateEntry, evaluateEntryMomentum, simpleMomOn, simpleMomLevel, simpleMomHit, evaluateGlobalRisk, evaluateRowExit, legStopReason,
  dteForExpiry, dteMatches, sidePremium, legsOf, legsFlat, rowOwnsLeg,
  stopPremium, legStopPremium, pairStopPremium, legOwnContracts,
  nextOpenedTs, isGhostDropProtected, GHOST_DROP_GRACE_MS,
  isSimRow, simLegPosition,
  legPinnedStrike, slRollStrike, evaluateReentry, costStopReason, legOwnEntry, DEFAULT_SL_ROLL_MAX,
  reentryWindowClosed, pendingReentryLevel, pendingReentryHit, legTargetReason, costReentryBasis, awaitingMomentumQuote, legTargetLevel,
  type RowLive, type PosRow, type WorkerHold,
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
      const got = evaluateEntry(row(c.row), c.ctx);
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
  const ctx = { nowHm: '10:00', product: 'INTRADAY' as const, groupEnabled: true, done: 0 };
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
  const ctx = { nowHm: '11:00', product: 'INTRADAY' as const, groupEnabled: true, done: 0 };
  assert.equal(evaluateReentry(row({}), 'tgt', ctx).enter, false);           // off by default
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap' }), 'tgt', ctx).enter, true);
  // SL settings don't leak into target.
  assert.equal(evaluateReentry(row({ reSlMode: 'asap' }), 'tgt', ctx).enter, false);
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap', noReEntryAfter: '11:00' }), 'tgt', ctx).enter, false);
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap', noReEntryAfter: '11:01' }), 'tgt', ctx).enter, true);
  assert.equal(evaluateReentry(row({ reTgtMode: 'asap', reTgtMax: 1 }), 'tgt', { ...ctx, done: 1 }).enter, false);
});

test('reentryWindowClosed', () => {
  const ctx = { nowHm: '10:00', product: 'INTRADAY' as const, groupEnabled: true };
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
  assert.deepEqual(pendingReentryLevel('momentum', 'sl', { quoteNow: 180, momentumPts: '20' }), { price: 160, dir: 'down' });
  assert.deepEqual(pendingReentryLevel('momentum', 'sl', { quoteNow: 180, momentumPts: 20, momentumDir: 'up' }), { price: 200, dir: 'up' });
  assert.equal(pendingReentryLevel('momentum', 'sl', { quoteNow: 180, momentumPts: '' }), null);
  assert.equal(pendingReentryLevel('momentum', 'sl', { quoteNow: 10, momentumPts: 20 }), null);
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
