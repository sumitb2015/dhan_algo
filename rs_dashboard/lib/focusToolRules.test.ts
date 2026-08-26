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
  evaluateEntry, evaluateGlobalRisk, evaluateRowExit, legStopReason,
  dteForExpiry, dteMatches, sidePremium, legsOf, legsFlat, rowOwnsLeg,
  stopPremium, legStopPremium, pairStopPremium, legOwnContracts,
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
