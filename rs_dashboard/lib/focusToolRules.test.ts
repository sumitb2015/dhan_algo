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
  dteForExpiry, dteMatches, sidePremium, legsOf, legsFlat,
  type RowLive, type PosRow,
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
  ceEntry: number; peEntry: number; pnl?: number; vwap?: number | null;
}

function live(c: LiveCase): RowLive {
  const cePosition = pos(c.ceQty, c.ceEntry);
  const pePosition = pos(c.peQty, c.peEntry);
  return {
    ceStrike: 24000, peStrike: 24000,
    ltpCe: c.ceLtp, ltpPe: c.peLtp,
    cePosition, pePosition,
    pnl: c.pnl ?? 0,
    // Entry premium covers only the legs actually held, exactly as rowLive builds it.
    entryPremium: (cePosition ? c.ceEntry : 0) + (pePosition ? c.peEntry : 0),
    vwap: c.vwap ?? null,
  };
}

function row(partial: Partial<FocusRow>): FocusRow {
  return {
    id: 't', underlying: 'NIFTY', entryTime: '', exitTime: '', dte: 'Any', expiry: '',
    strikeMode: 'ATM', linked: true, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '',
    lots: 1, side: 'BOTH', status: 'draft',
    levelHigh: '', levelLow: '', levelVw: false, slRupees: '', slMultiplier: '1',
    ceSlMultiplier: '1', peSlMultiplier: '1',
    createdAt: '', updatedAt: '',
    ...partial,
  } as FocusRow;
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
      assert.equal(evaluateRowExit(row(c.row), live(c.live), c.spot), c.expect);
    });
  }
});

test('leg-wise stops', async t => {
  for (const c of CASES.legStop) {
    await t.test(c.name, () => {
      assert.equal(legStopReason(row(c.row), c.leg, live(c.live)), c.expect);
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

test('sidePremium counts only legs that are both traded and open', () => {
  const l = live({ ceLtp: 100, peLtp: 80, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 80 });
  assert.equal(sidePremium({ side: 'BOTH' } as FocusRow, l), 180);
  assert.equal(sidePremium({ side: 'CE' } as FocusRow, l), 100);

  const peClosed = live({ ceLtp: 100, peLtp: 80, ceQty: -75, peQty: 0, ceEntry: 100, peEntry: 80 });
  assert.equal(sidePremium({ side: 'BOTH' } as FocusRow, peClosed), 100);
});

test('a zero premium never satisfies a premium rule', () => {
  // Two failed quote reads sum to 0. Without the > 0 guards that reads as
  // "collapsed below VWAP" and as an infinite loss multiple.
  const dead = live({ ceLtp: 0, peLtp: 0, ceQty: -75, peQty: -75, ceEntry: 100, peEntry: 80, vwap: 195 });
  assert.equal(evaluateRowExit(row({ levelVw: true, slMultiplier: '2' }), dead, 24000), null);
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
