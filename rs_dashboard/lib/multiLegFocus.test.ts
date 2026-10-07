import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveTemplateLegs, reconcileLegFillDown, reconcileLegWithBroker, legPnl, basketTotalPnl, sortLegsForExit, findLegPosition,
  computeLegTrailingSL, computeStrategyMetrics, checkStrategyRisk, classifyBasketStructure, findSiblingLegCollisions,
  formatExpiryLabel, LEG_FILL_GRACE_MS, claimableLegQty, executionBroker, applyOrderOutcomes, normalizeOrderRow, PENDING_ORDER_TTL_MS, legBrokerMismatch, classifyDhanOrder, type NormalizedOrder, legAvgPrice, legExitPrice, legQtyUnits, legPnlPct, legOtmPct, scaleBasketMultiplier,
  legQtyWarningsFor, recordOutsideReduction, findUntrackedPositions, residualBrokerAvg, findContractDrift, legFromUntracked, contractHintFromRow, legCountsToday, closedFillFromRow, mergeImportedLegs, brokerClampSlice,
  normalizeTradeRow, ownOrderIds, matchOutsideTrades, repriceEstimatedCloses, MLF_ORDER_SOURCE,
  type StrategyMetrics, type MultiLegLeg, type MultiLegBasket,
} from './multiLegFocus.ts';
import type { StrategyTemplate } from './basketStrategies.ts';

test('resolveTemplateLegs resolves offsets to nearest listed strikes and seeds DRAFT status', () => {
  const template: StrategyTemplate = {
    key: 'short-strangle', name: 'Short Strangle',
    legs: [{ side: 'S', option: 'CE', offset: 4, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 2 }],
  };
  const strikes = [23600, 23800, 24000, 24200, 24400];
  const legs = resolveTemplateLegs(template, 24000, strikes, 200);
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs[0].strike, 24400);
  assert.strictEqual(legs[0].option, 'CE');
  assert.strictEqual(legs[0].lots, 1);
  assert.strictEqual(legs[1].strike, 23600);
  assert.strictEqual(legs[1].lots, 2);
  assert.ok(legs.every(l => l.status === 'DRAFT' && l.type === 'MARKET' && !l.fill));
  assert.notStrictEqual(legs[0].id, legs[1].id);
});

test('resolveTemplateLegs assigns the far expiry only to legs with expiryRole "far", front expiry otherwise', () => {
  const template: StrategyTemplate = {
    key: 'calendar-call-spread', name: 'Calendar Call Spread',
    legs: [
      { side: 'S', option: 'CE', offset: 0, ratio: 1, expiryRole: 'front' },
      { side: 'B', option: 'CE', offset: 0, ratio: 1, expiryRole: 'far' },
    ],
  };
  const strikes = [23600, 23800, 24000, 24200, 24400];
  const legs = resolveTemplateLegs(template, 24000, strikes, 200, '2026-09-25', '2026-10-30');
  assert.strictEqual(legs[0].expiry, '2026-09-25');
  assert.strictEqual(legs[1].expiry, '2026-10-30');
  // The two legs land on the same strike (both ATM) but different expiries —
  // this is the fix for the bug where both legs collapsed onto the same
  // expiry and looked like a degenerate net-zero combo.
  assert.strictEqual(legs[0].strike, legs[1].strike);
  assert.notStrictEqual(legs[0].expiry, legs[1].expiry);
});

test('resolveTemplateLegs falls back to front expiry for a far leg when no far expiry is available', () => {
  const template: StrategyTemplate = {
    key: 'calendar-call-spread', name: 'Calendar Call Spread',
    legs: [
      { side: 'S', option: 'CE', offset: 0, ratio: 1, expiryRole: 'front' },
      { side: 'B', option: 'CE', offset: 0, ratio: 1, expiryRole: 'far' },
    ],
  };
  const strikes = [23600, 23800, 24000, 24200, 24400];
  const legs = resolveTemplateLegs(template, 24000, strikes, 200, '2026-09-25');
  assert.strictEqual(legs[1].expiry, '2026-09-25');
});

test('reconcileLegFillDown shrinks a leg\'s fill qty to a smaller broker quantity', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 50);
  assert.strictEqual(out.fill?.qty, 50);
  assert.strictEqual(out.status, 'OPEN');
});

test('reconcileLegFillDown never grows a leg\'s fill qty upward from a larger broker quantity', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 150);
  assert.strictEqual(out.fill?.qty, 75);
});

test('reconcileLegFillDown leaves the leg alone when the broker quantity is unknown (null)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, null);
  assert.strictEqual(out.fill?.qty, 75);
});

test('reconcileLegFillDown marks the leg CLOSED once the broker quantity reaches zero', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 0);
  assert.strictEqual(out.fill?.qty, 0);
  assert.strictEqual(out.status, 'CLOSED');
});

test('legPnl: a filled SELL leg profits as LTP falls below the entry average', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  assert.strictEqual(legPnl(leg, 100), 1500); // (120-100) * 75
});

test('legPnl: a filled BUY leg profits as LTP rises above the entry average', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'PE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 80 } };
  assert.strictEqual(legPnl(leg, 100), 1500); // (100-80) * 75
});

test('legPnl returns 0 for a leg with no fill yet', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'PE', strike: 24000, lots: 1, type: 'MARKET', status: 'DRAFT' };
  assert.strictEqual(legPnl(leg, 100), 0);
});

test('basketTotalPnl sums legPnl across every leg using the caller-supplied LTP lookup', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 24400, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 40 } },
    { id: '2', side: 'S', option: 'PE', strike: 23600, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 35 } },
  ];
  const ltpFor = (l: MultiLegLeg) => (l.option === 'CE' ? 30 : 50);
  // CE: (40-30)*75=750, PE: (35-50)*75=-1125
  assert.strictEqual(basketTotalPnl(legs, ltpFor), 750 + -1125);
});

test('sortLegsForExit orders all SELL legs before all BUY legs, preserving relative order within each group', () => {
  const legs = [
    { side: 'B' as const, id: 1 }, { side: 'S' as const, id: 2 },
    { side: 'B' as const, id: 3 }, { side: 'S' as const, id: 4 },
  ];
  assert.deepStrictEqual(sortLegsForExit(legs).map(l => l.id), [2, 4, 1, 3]);
});

test('findLegPosition matches a Dhan leg by securityId, ignoring symbol', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { securityId: '999' } };
  const rows = [{ securityId: '999', tradingSymbol: 'NIFTY24721C24000', productType: 'MARGIN', netQty: -75 }];
  const match = findLegPosition('dhan', leg, rows);
  assert.strictEqual(match.kind, 'match');
});

test('findLegPosition matches a non-Dhan leg by symbol and product', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { symbol: 'NIFTY24721C24000' } };
  const rows = [{ tradingSymbol: 'NIFTY24721C24000', product: 'MIS', netQty: -75 }];
  const match = findLegPosition('zerodha', leg, rows);
  assert.strictEqual(match.kind, 'match');
});

test('findLegPosition reports not_found for a leg with no orderRef yet', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'DRAFT' };
  assert.deepStrictEqual(findLegPosition('dhan', leg, []), { kind: 'not_found' });
});

test('findLegPosition reports not_found when Dhan securityId is not in rows array (placement propagation lag)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { securityId: '47298' } };
  const rows = [{ securityId: '47331', tradingSymbol: 'NIFTY-Sep2026-24300-CE', productType: 'MARGIN', netQty: -65 }];
  const match = findLegPosition('dhan', leg, rows);
  assert.strictEqual(match.kind, 'not_found');
});

test('findLegPosition reports flat when Dhan securityId is present with netQty 0 or positionType CLOSED', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { securityId: '47298' } };
  const rows = [{ securityId: '47298', tradingSymbol: 'NIFTY-Sep2026-23500-PE', productType: 'MARGIN', netQty: 0, positionType: 'CLOSED' }];
  const match = findLegPosition('dhan', leg, rows);
  assert.strictEqual(match.kind, 'flat');
});

test('findLegPosition ignores a CLOSED/zero-qty Dhan row and matches the genuinely live one for the same securityId', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { securityId: '999' } };
  const rows = [
    { securityId: '999', tradingSymbol: 'NIFTY24721C24000', productType: 'MARGIN', netQty: 0, positionType: 'CLOSED' },
    { securityId: '999', tradingSymbol: 'NIFTY24721C24000', productType: 'MARGIN', netQty: -75, positionType: 'SHORT' },
  ];
  const match = findLegPosition('dhan', leg, rows);
  assert.strictEqual(match.kind, 'match');
  if (match.kind === 'match') assert.strictEqual(match.row.positionType, 'SHORT');
});

test('reconcileLegWithBroker never resurrects a CLOSED leg, even when broker still shows the (pooled) position active', () => {
  // Was previously a "self-heal" — but a broker position can now be shared
  // with a sibling basket on the same strike, so "broker still shows it
  // active" no longer proves THIS leg is still open; it may just be the
  // sibling's share. Resurrecting on that evidence would double-claim it.
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'CLOSED', fill: { qty: 0, avgPrice: 70 }, orderRef: { securityId: '47298' } };
  const match = { kind: 'match' as const, row: { securityId: '47298', netQty: -65, sellAvg: 72.05 } };
  const reconciled = reconcileLegWithBroker(leg, match, 65);
  assert.strictEqual(reconciled.status, 'CLOSED');
  assert.strictEqual(reconciled.fill?.qty, 0);
});

test('reconcileLegWithBroker leaves leg untouched when match is not_found', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 72.3 }, orderRef: { securityId: '47298' } };
  const match = { kind: 'not_found' as const };
  const reconciled = reconcileLegWithBroker(leg, match, 65);
  assert.strictEqual(reconciled.status, 'OPEN');
  assert.strictEqual(reconciled.fill?.qty, 65);
});

test('reconcileLegWithBroker updates lots to match broker filled qty / lotSize', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24300, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 56.4 }, orderRef: { securityId: '47331' } };
  const match = { kind: 'match' as const, row: { securityId: '47331', netQty: -65, sellAvg: 56.4 } };
  const reconciled = reconcileLegWithBroker(leg, match, 130, 65);
  assert.strictEqual(reconciled.status, 'OPEN');
  assert.strictEqual(reconciled.fill?.qty, 65);
  assert.strictEqual(reconciled.lots, 1);
});

test('reconcileLegWithBroker never inflates qty upward to match a broker position larger than this leg\'s own', () => {
  // Was previously "update upward, broker is source of truth" — but Dhan nets
  // by securityId, so a broker position larger than this leg's own fill can
  // now mean a SIBLING basket added to the same strike, not that this leg's
  // own order grew. Inflating here would silently make this leg claim the
  // sibling's quantity (and P&L) as its own. Stay clamped to this leg's own
  // last-known qty; only ever shrink if the broker shows LESS than that.
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 110 }, orderRef: { securityId: '47298' } };
  const match = { kind: 'match' as const, row: { securityId: '47298', netQty: -130, sellAvg: 108.5 } };
  const reconciled = reconcileLegWithBroker(leg, match, 65 /* ownQtyHint = 1 lot */, 65);
  assert.strictEqual(reconciled.status, 'OPEN');
  assert.strictEqual(reconciled.fill?.qty, 65);   // stays this leg's own qty, not the pooled 130
  assert.strictEqual(reconciled.lots, 1);           // lots stays put too
  // The broker avg is pooled across every leg on the contract too (2026-10-01:
  // two 22300 PE legs both read the pooled 125.13), so the leg's own avg wins.
  assert.strictEqual(reconciled.fill?.avgPrice, 110);
  // ...and the broker's is used only for a leg that has no avg of its own.
  const noAvg = reconcileLegWithBroker({ ...leg, fill: { qty: 65, avgPrice: 0 } }, match, 65, 65);
  assert.strictEqual(noAvg.fill?.avgPrice, 108.5);
});

test('reconcileLegWithBroker clamps this leg\'s own qty DOWN when the shared broker position shrinks below it', () => {
  // A sibling basket's exit (or manual intervention) reduced the pooled
  // position from 130 to 65 — below what THIS leg alone expected (65 is
  // exactly this leg's own share, so nothing changes here; but if the pool
  // dropped below 65, e.g. to 30, this leg must shrink to 30 too, since that's
  // all that's actually left for anyone to claim).
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 110 }, orderRef: { securityId: '47298' } };
  const match = { kind: 'match' as const, row: { securityId: '47298', netQty: -30, sellAvg: 108.5 } };
  const reconciled = reconcileLegWithBroker(leg, match, 65, 65);
  assert.strictEqual(reconciled.status, 'OPEN');
  assert.strictEqual(reconciled.fill?.qty, 30);
});

test('reconcileLegWithBroker uses ownQtyHint (lots × lotSize) for a leg with no recorded fill yet, still clamped by broker', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 2, type: 'MARKET', status: 'PLACING', orderRef: { securityId: '47298' } };
  const match = { kind: 'match' as const, row: { securityId: '47298', netQty: -195, sellAvg: 108.5 } };
  const reconciled = reconcileLegWithBroker(leg, match, 130 /* 2 lots */, 65);
  assert.strictEqual(reconciled.status, 'OPEN');
  assert.strictEqual(reconciled.fill?.qty, 130); // clamped to ownQtyHint, not the pooled 195
});

test('computeLegTrailingSL: Sell leg triggers hard SL and TP correctly', () => {
  const leg: MultiLegLeg = {
    id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN',
    fill: { qty: 65, avgPrice: 70 },
    sl: 10, slType: 'pts', tp: 20, tpType: 'pts',
  };
  // Entry: 70 -> SL price is 80, TP price is 50
  assert.strictEqual(computeLegTrailingSL(leg, 75).triggered, null);
  assert.strictEqual(computeLegTrailingSL(leg, 80).triggered, 'SL');
  assert.strictEqual(computeLegTrailingSL(leg, 81).triggered, 'SL');
  assert.strictEqual(computeLegTrailingSL(leg, 50).triggered, 'TP');
  assert.strictEqual(computeLegTrailingSL(leg, 49).triggered, 'TP');
});

test('computeLegTrailingSL: Sell leg trailing at 1 rupee step tightens SL and triggers TRAIL_SL', () => {
  const leg: MultiLegLeg = {
    id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN',
    fill: { qty: 65, avgPrice: 70 },
    sl: 10, slType: 'pts', trail: true,
  };
  // Entry 70, initial SL is 80 (risk = 10 pts).
  // Price drops favorably to 65 (drop of 5 rupees):
  const eval1 = computeLegTrailingSL(leg, 65);
  assert.strictEqual(eval1.newBestPrice, 65);
  assert.strictEqual(eval1.effectiveSL, 75); // 65 + 10 = 75 (trailed down by exactly 5 rupees)
  assert.strictEqual(eval1.triggered, null);

  // Next tick with bestPrice tracked at 65:
  const trailedLeg = { ...leg, bestPrice: 65 };
  // If price bounces back to 74 (below 75):
  assert.strictEqual(computeLegTrailingSL(trailedLeg, 74).triggered, null);
  // If price rises to 75 (hits trailing SL):
  const eval2 = computeLegTrailingSL(trailedLeg, 75);
  assert.strictEqual(eval2.triggered, 'TRAIL_SL');
  assert.strictEqual(eval2.effectiveSL, 75);
});

test('computeLegTrailingSL: Buy leg trailing at 1 rupee step tightens SL upward', () => {
  const leg: MultiLegLeg = {
    id: '1', side: 'B', option: 'CE', strike: 24300, lots: 1, type: 'MARKET', status: 'OPEN',
    fill: { qty: 65, avgPrice: 50 },
    sl: 10, slType: 'pts', trail: true,
  };
  // Entry 50, initial SL is 40 (risk = 10 pts).
  // Price rises favorably to 58 (gain of 8 rupees):
  const eval1 = computeLegTrailingSL(leg, 58);
  assert.strictEqual(eval1.newBestPrice, 58);
  assert.strictEqual(eval1.effectiveSL, 48); // 58 - 10 = 48 (trailed up by exactly 8 rupees)
  assert.strictEqual(eval1.triggered, null);

  const trailedLeg = { ...leg, bestPrice: 58 };
  // Price drops to 48:
  assert.strictEqual(computeLegTrailingSL(trailedLeg, 48).triggered, 'TRAIL_SL');
});

test('computeStrategyMetrics computes combined points and percentage accurately', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 24300, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 56.40 } },
    { id: '2', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 72.05 } },
  ];
  // Total entry points: 56.40 + 72.05 = 128.45 pts
  const ltpFor = (l: MultiLegLeg) => (l.option === 'CE' ? 50.00 : 60.00);
  // CE gained +6.40 pts, PE gained +12.05 pts -> total points P&L = +18.45 pts
  const metrics = computeStrategyMetrics(legs, ltpFor);
  assert.strictEqual(metrics.combinedEntryPts, 128.45);
  assert.strictEqual(metrics.combinedCurrentPts, 110.00);
  assert.strictEqual(Math.round(metrics.pnlPts * 100) / 100, 18.45);
  assert.strictEqual(Math.round(metrics.pnlPct * 100) / 100, 14.36); // (18.45 / 128.45) * 100
  assert.strictEqual(metrics.totalPnlRupees, 18.45 * 65);
});

test('checkStrategyRisk triggers Target and SL in both points and percentage modes', () => {
  const metrics: StrategyMetrics = {
    combinedEntryPts: 100,
    combinedCurrentPts: 80,
    pnlPts: 20,
    pnlPct: 20,
    totalPnlRupees: 1300,
    hasUnpricedLegs: false, hasFutures: false,
  };

  // Points mode Target
  assert.strictEqual(checkStrategyRisk(metrics, { targetValue: 15, targetUnit: 'pts', armed: true, slUnit: 'pts' }), 'TARGET');
  assert.strictEqual(checkStrategyRisk(metrics, { targetValue: 25, targetUnit: 'pts', armed: true, slUnit: 'pts' }), null);

  // Percentage mode Target
  assert.strictEqual(checkStrategyRisk(metrics, { targetValue: 18, targetUnit: 'pct', armed: true, slUnit: 'pct' }), 'TARGET');
  assert.strictEqual(checkStrategyRisk(metrics, { targetValue: 25, targetUnit: 'pct', armed: true, slUnit: 'pct' }), null);

  // Armed false returns null even if threshold reached
  assert.strictEqual(checkStrategyRisk(metrics, { targetValue: 15, targetUnit: 'pts', armed: false, slUnit: 'pts' }), null);

  // SL test
  const lossMetrics: StrategyMetrics = {
    combinedEntryPts: 100,
    combinedCurrentPts: 125,
    pnlPts: -25,
    pnlPct: -25,
    totalPnlRupees: -1625,
    hasUnpricedLegs: false, hasFutures: false,
  };
  assert.strictEqual(checkStrategyRisk(lossMetrics, { slValue: 20, slUnit: 'pts', armed: true, targetUnit: 'pts' }), 'SL');
  assert.strictEqual(checkStrategyRisk(lossMetrics, { slValue: 20, slUnit: 'pct', armed: true, targetUnit: 'pct' }), 'SL');
  assert.strictEqual(checkStrategyRisk(lossMetrics, { slValue: 30, slUnit: 'pts', armed: true, targetUnit: 'pts' }), null);
});

test('weighted average entry price recomputes accurately when adding lots to an existing leg', () => {
  const initialQty = 65;
  const initialAvg = 58.60;
  const addedQty = 65;
  const fillPrice = 61.40;

  const newTotalQty = initialQty + addedQty;
  const newAvgPrice = ((initialAvg * initialQty) + (fillPrice * addedQty)) / newTotalQty;

  assert.strictEqual(newTotalQty, 130);
  assert.strictEqual(Math.round(newAvgPrice * 100) / 100, 60.00);

  // When updating leg fill with new average price, points-based SL/TP dynamically re-anchors
  const leg: MultiLegLeg = {
    id: '1',
    side: 'S',
    option: 'CE',
    strike: 24300,
    lots: 2,
    type: 'MARKET',
    status: 'OPEN',
    fill: { qty: newTotalQty, avgPrice: newAvgPrice },
    sl: 15,
    slType: 'pts',
    tp: 30,
    tpType: 'pts',
  };

  const evalResult = computeLegTrailingSL(leg, 55.00);
  // For SELL leg: SL is entry + 15 = 75, TP is entry - 30 = 30
  assert.strictEqual(evalResult.initialSLPrice, 75.00);
  assert.strictEqual(evalResult.tpPrice, 30.00);
});

// ── Closed-leg P&L regression (dashboard showed "+₹0 (+11.5%)" for a
//    fully-closed basket: totalPnlRupees fell to 0 once fill.qty was zeroed
//    on close, while pnlPct kept moving off live LTP against the frozen
//    entry price, producing a nonzero % alongside a zero rupee figure) ────

test('findLegPosition returns the closed row on a flat Dhan leg, not just the kind', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { securityId: '47298' } };
  const rows = [{ securityId: '47298', tradingSymbol: 'NIFTY-Sep2026-23500-PE', productType: 'MARGIN', netQty: 0, positionType: 'CLOSED', buyQty: 65, sellQty: 65, buyAvg: 60.1, sellAvg: 72.05 }];
  const match = findLegPosition('dhan', leg, rows);
  assert.strictEqual(match.kind, 'flat');
  if (match.kind === 'flat') assert.strictEqual(match.row?.buyAvg, 60.1);
});

test('reconcileLegWithBroker captures closedFill from a flat row (SELL leg exits at buyAvg)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 72.05 }, orderRef: { securityId: '47298' } };
  const match = { kind: 'flat' as const, row: { securityId: '47298', buyQty: 65, sellQty: 65, buyAvg: 60.1, sellAvg: 72.05 } };
  const reconciled = reconcileLegWithBroker(leg, match);
  assert.strictEqual(reconciled.status, 'CLOSED');
  assert.strictEqual(reconciled.fill?.qty, 0);
  assert.strictEqual(reconciled.fill?.avgPrice, 72.05); // entry preserved
  assert.deepStrictEqual(reconciled.closedFill, { qty: 65, exitPrice: 60.1, estimated: true }); // bought back to cover (pooled row avg: estimate)
});

test('reconcileLegWithBroker captures closedFill from a match row that just went flat (BUY leg exits at sellAvg)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'CE', strike: 24300, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 50 }, orderRef: { securityId: '47331' } };
  const match = { kind: 'match' as const, row: { securityId: '47331', netQty: 0, buyQty: 65, sellQty: 65, buyAvg: 50, sellAvg: 58 } };
  const reconciled = reconcileLegWithBroker(leg, match);
  assert.strictEqual(reconciled.status, 'CLOSED');
  assert.deepStrictEqual(reconciled.closedFill, { qty: 65, exitPrice: 58, estimated: true }); // sold to close (pooled row avg: estimate)
});

test('reconcileLegWithBroker leaves closedFill undefined when the flat row carries no buy/sell qty (non-Dhan brokers that drop flat rows)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 72.05 }, orderRef: { symbol: 'X' } };
  const reconciled = reconcileLegWithBroker(leg, { kind: 'flat' });
  assert.strictEqual(reconciled.status, 'CLOSED');
  assert.strictEqual(reconciled.closedFill, undefined);
});

test('legPnl: a CLOSED leg uses the frozen closedFill, ignoring the live ltp argument entirely', () => {
  const leg: MultiLegLeg = {
    id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'CLOSED',
    fill: { qty: 0, avgPrice: 72.05 }, closedFill: { qty: 65, exitPrice: 60.1 },
  };
  // Sold at 72.05, bought back at 60.1 -> +11.95/unit * 65 = 776.75, regardless of where ltp is now
  assert.strictEqual(Math.round(legPnl(leg, 999) * 100) / 100, 776.75);
  assert.strictEqual(legPnl(leg, 999), legPnl(leg, 0));
});

test('legPnl: a CLOSED leg with no closedFill yet (transient post-exit state) reads 0, not a stale ltp-based figure', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'CLOSED', fill: { qty: 0, avgPrice: 72.05 } };
  assert.strictEqual(legPnl(leg, 40), 0);
});

test('computeStrategyMetrics: a closed basket reports a rupee total and percentage that agree, not "+0 (+11.5%)"', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 24300, lots: 1, type: 'MARKET', status: 'CLOSED', fill: { qty: 0, avgPrice: 56.40 }, closedFill: { qty: 65, exitPrice: 50.00 } },
    { id: '2', side: 'S', option: 'PE', strike: 23500, lots: 1, type: 'MARKET', status: 'CLOSED', fill: { qty: 0, avgPrice: 72.05 }, closedFill: { qty: 65, exitPrice: 60.00 } },
  ];
  // A live ltpFor that would drift the figures if it were still consulted for closed legs.
  const ltpFor = () => 999;
  const metrics = computeStrategyMetrics(legs, ltpFor);
  assert.strictEqual(Math.round(metrics.pnlPts * 100) / 100, 18.45); // (56.40-50)+(72.05-60)
  assert.strictEqual(metrics.totalPnlRupees, 18.45 * 65);
  // Rupees and percentage must be consistent: totalPnlRupees > 0 implies pnlPct > 0 here.
  assert.ok(metrics.totalPnlRupees > 0 && metrics.pnlPct > 0);
});

test('computeStrategyMetrics: a closed leg with no closedFill freezes at zero movement instead of drifting off live ltp', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 24300, lots: 1, type: 'MARKET', status: 'CLOSED', fill: { qty: 0, avgPrice: 56.40 } },
  ];
  const ltpFor = () => 30; // if this leaked into the calc it would show a large phantom gain
  const metrics = computeStrategyMetrics(legs, ltpFor);
  assert.strictEqual(metrics.pnlPts, 0);
  assert.strictEqual(metrics.pnlPct, 0);
  assert.strictEqual(metrics.totalPnlRupees, 0);
});

test('legPnl scales by multiplier for Dhan commodity contracts where qty is in lots', () => {
  const leg: MultiLegLeg = {
    id: '1', side: 'S', option: 'CE', strike: 8500, lots: 1, type: 'MARKET', status: 'OPEN',
    fill: { qty: 1, avgPrice: 85.0 }, // 1 lot on Dhan
  };
  // (85.0 - 75.0) * 1 lot * 100 barrels/lot = 1000 rupees
  assert.strictEqual(legPnl(leg, 75.0, 100), 1000);
  // CRUDEOILM: 10 barrels/lot -> (85.0 - 75.0) * 1 * 10 = 100 rupees
  assert.strictEqual(legPnl(leg, 75.0, 10), 100);
});

test('computeStrategyMetrics applies commodity multiplier to rupee P&L', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 8500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 1, avgPrice: 80 } },
    { id: '2', side: 'S', option: 'PE', strike: 8500, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 1, avgPrice: 80 } },
  ];
  const ltpFor = () => 70; // both legs gain 10 pts = 20 pts total
  const metrics = computeStrategyMetrics(legs, ltpFor, 100);
  assert.strictEqual(metrics.pnlPts, 20);
  assert.strictEqual(metrics.totalPnlRupees, 2000); // 20 pts * 1 qty * 100 mult
  assert.strictEqual(metrics.hasUnpricedLegs, false);
});

test('computeStrategyMetrics: unpriced open legs (ltp <= 0) freeze at entry and flag hasUnpricedLegs, preventing false 100% gain', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 24700, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 32.7 } },
    { id: '2', side: 'S', option: 'PE', strike: 23300, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 30.95 } },
  ];
  // If LTP lookup returns 0 (e.g. rate-limit or delayed quote feed):
  const ltpFor = () => 0;
  const metrics = computeStrategyMetrics(legs, ltpFor);
  assert.strictEqual(metrics.hasUnpricedLegs, true);
  // PnL points must NOT be +127.3 pts (which would be +100% false decay); it must be 0
  assert.strictEqual(metrics.pnlPts, 0);
  assert.strictEqual(metrics.pnlPct, 0);
  assert.strictEqual(metrics.totalPnlRupees, 0);

  // checkStrategyRisk must refuse to fire Target or SL when hasUnpricedLegs is true
  assert.strictEqual(checkStrategyRisk(metrics, { targetValue: 10, targetUnit: 'pts', armed: true, slUnit: 'pts' }), null);
  assert.strictEqual(checkStrategyRisk(metrics, { slValue: 10, slUnit: 'pts', armed: true, targetUnit: 'pts' }), null);
});

test('computeStrategyMetrics: ratio spreads and combos calculate pnlPct against combinedEntryPts, not tiny netCreditDebit', () => {
  // Put Ratio Backspread (4x Sell @ 129.90, 2x Buy @ 232.225)
  // combinedEntryPts = 519.6 + 464.45 = 984.05 pts
  // netCreditDebit = 519.6 - 464.45 = +55.15 pts (tiny residual net credit)
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'PE', strike: 22500, lots: 4, type: 'MARKET', status: 'OPEN', fill: { qty: 260, avgPrice: 129.90 } },
    { id: '2', side: 'B', option: 'PE', strike: 22900, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 232.225 } },
  ];
  // Suppose current market has PE 22500 @ 120 and PE 22900 @ 227.4
  // Sell leg gain: (129.90 - 120.00) * 4 = +39.6 pts
  // Buy leg loss: (227.40 - 232.225) * 2 = -9.65 pts
  // Net pnlPts = +29.95 pts (totalPnlRupees = 29.95 * 65 = +1,946.75)
  const ltpFor = (l: MultiLegLeg) => (l.strike === 22500 ? 120.00 : 227.40);
  const metrics = computeStrategyMetrics(legs, ltpFor);

  assert.strictEqual(metrics.combinedEntryPts, 984.05);
  assert.strictEqual(Math.round(metrics.pnlPts * 100) / 100, 29.95);
  // Must be ~3.04% (29.95 / 984.05), NOT +54.3% (29.95 / 55.15)!
  assert.strictEqual(Math.round(metrics.pnlPct * 100) / 100, 3.04);
});

test('computeStrategyMetrics: broken wing butterfly with near-zero net debit does not blow up pnlPct', () => {
  // Call Broken Wing with net debit of ~1.30 pts (Buy 1x @ 117.25, Sell 2x @ 64.65, Buy 1x @ 13.35)
  // combinedEntryPts = 117.25 + 129.30 + 13.35 = 259.90 pts
  // netCreditDebit = 129.30 - 117.25 - 13.35 = -1.30 pts
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'B', option: 'CE', strike: 23300, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 117.25 } },
    { id: '2', side: 'S', option: 'CE', strike: 23450, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 64.65 } },
    { id: '3', side: 'B', option: 'CE', strike: 23800, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 13.35 } },
  ];
  // Suppose strategy is down ~1.1 pts (-71.5 rupees)
  const ltpFor = (l: MultiLegLeg) => {
    if (l.strike === 23300) return 116.50; // -0.75
    if (l.strike === 23450) return 65.00;  // -0.70 (2x = -0.70)
    return 13.70;                          // +0.35
  };
  const metrics = computeStrategyMetrics(legs, ltpFor);
  assert.strictEqual(metrics.combinedEntryPts, 259.90);
  assert.strictEqual(Math.round(metrics.pnlPts * 100) / 100, -1.1);
  // Must be -0.42% (-1.1 / 259.90), NOT -84.6% (-1.1 / 1.30)!
  assert.strictEqual(Math.round(metrics.pnlPct * 100) / 100, -0.42);
});

test('classifyBasketStructure: legs edited from an Iron Condor preset into a Batman shape are relabeled Batman, not the stale preset', () => {
  // Same shape as the real basket that triggered this fix: created from the
  // 'iron-condor' preset, then edited so the long strikes sit INSIDE the
  // short strikes at a 1:2 ratio — a Batman, not a condor — while the
  // basket's own stored presetKey/name are still frozen at "Iron Condor".
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 23750, lots: 4, type: 'MARKET', status: 'OPEN', fill: { qty: 260, avgPrice: 35.6 } },
    { id: '2', side: 'B', option: 'CE', strike: 23700, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 45.5 } },
    { id: '3', side: 'B', option: 'PE', strike: 22950, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 47.65 } },
    { id: '4', side: 'S', option: 'PE', strike: 22900, lots: 4, type: 'MARKET', status: 'OPEN', fill: { qty: 260, avgPrice: 40.7 } },
  ];
  const result = classifyBasketStructure(legs);
  assert.ok(result, 'should recognize a clean Batman shape');
  assert.strictEqual(result!.structure, 'Batman');
  assert.strictEqual(result!.riskType, 'undefined');
});

test('classifyBasketStructure: an actual Iron Condor (long wings outside) is labeled Iron Condor', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 23700, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '2', side: 'B', option: 'CE', strike: 23800, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '3', side: 'S', option: 'PE', strike: 22900, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '4', side: 'B', option: 'PE', strike: 22800, lots: 1, type: 'MARKET', status: 'OPEN' },
  ];
  const result = classifyBasketStructure(legs);
  assert.strictEqual(result?.structure, 'Iron Condor');
  assert.strictEqual(result?.riskType, 'defined');
});

test('classifyBasketStructure: ignores CLOSED/FAILED legs and ties strikes to (strike,type,side) with summed lots', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 23700, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '1b', side: 'S', option: 'CE', strike: 23700, lots: 1, type: 'MARKET', status: 'OPEN' }, // added later, same leg
    { id: '2', side: 'B', option: 'CE', strike: 23800, lots: 2, type: 'MARKET', status: 'OPEN' },
    { id: '3', side: 'S', option: 'PE', strike: 22900, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '4', side: 'B', option: 'PE', strike: 22800, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '5', side: 'S', option: 'CE', strike: 23600, lots: 5, type: 'MARKET', status: 'CLOSED' }, // stale, must be ignored
  ];
  const result = classifyBasketStructure(legs);
  assert.strictEqual(result?.structure, 'Iron Condor');
});

test('classifyBasketStructure: returns null for a shape the classifier only recognizes as Custom Combo', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 23700, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '2', side: 'S', option: 'CE', strike: 23800, lots: 1, type: 'MARKET', status: 'OPEN' },
    { id: '3', side: 'S', option: 'PE', strike: 22900, lots: 1, type: 'MARKET', status: 'OPEN' },
  ];
  assert.strictEqual(classifyBasketStructure(legs), null);
});




test('findSiblingLegCollisions flags live legs in OTHER baskets on the same contract, ignoring own/closed/other-broker', () => {
  const mk = (id: string, broker: string, legs: Partial<MultiLegLeg>[]) => ({
    id, name: id, underlying: 'NIFTY', expiry: '2026-10-27', broker, createdAt: '', updatedAt: '',
    legs: legs.map((l, i) => ({ id: `${id}${i}`, side: 'S', option: 'CE', strike: 23900, lots: 1, type: 'MARKET', status: 'OPEN', ...l })) as MultiLegLeg[],
  });
  const baskets = [
    mk('A', 'dhan', [{ side: 'B', status: 'DRAFT' }]),
    mk('B', 'dhan', [{ side: 'S' }, { strike: 24000 }, { status: 'CLOSED' }]),
    mk('C', 'zerodha', [{ side: 'S' }]),
  ];
  const c = findSiblingLegCollisions(baskets, 'A', [{ side: 'B', option: 'CE', strike: 23900, expiry: '2026-10-27' }]);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].basketId, 'B');
  assert.strictEqual(c[0].opposite, true);
  assert.strictEqual(findSiblingLegCollisions(baskets, 'A', [{ side: 'B', option: 'PE', strike: 23900, expiry: '2026-10-27' }]).length, 0);
  assert.strictEqual(findSiblingLegCollisions(baskets, 'A', [{ side: 'B', option: 'CE', strike: 23900, expiry: '2026-11-24' }]).length, 0);
  assert.strictEqual(findSiblingLegCollisions(baskets, 'B', [{ side: 'S', option: 'CE', strike: 23900, expiry: '2026-10-27' }]).length, 0);
});

// ── legs-table column helpers ─────────────────────────────────────────
const colLeg = (over: Partial<MultiLegLeg>): MultiLegLeg => ({
  id: 'l', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN',
  fill: { qty: 100, avgPrice: 50 }, ...over,
});

test('legAvgPrice / legQtyUnits are null until a fill is recorded', () => {
  const draft = colLeg({ status: 'DRAFT', fill: undefined });
  assert.strictEqual(legAvgPrice(draft), null);
  assert.strictEqual(legQtyUnits(draft), null);
  assert.strictEqual(legAvgPrice(colLeg({})), 50);
  assert.strictEqual(legQtyUnits(colLeg({})), 100);
});

test('legExitPrice exists only for a CLOSED leg; qty then comes from closedFill', () => {
  const open = colLeg({});
  assert.strictEqual(legExitPrice(open), null);
  const closed = colLeg({ status: 'CLOSED', fill: { qty: 0, avgPrice: 50 }, closedFill: { qty: 100, exitPrice: 20 } });
  assert.strictEqual(legExitPrice(closed), 20);
  assert.strictEqual(legQtyUnits(closed), 100);
});

test('legPnlPct: short gains as premium decays, long loses; closed uses the exit price', () => {
  assert.strictEqual(legPnlPct(colLeg({}), 30), 40);                       // sold 50, now 30 => +40%
  assert.strictEqual(legPnlPct(colLeg({ side: 'B' }), 30), -40);            // bought 50, now 30 => -40%
  const closed = colLeg({ status: 'CLOSED', fill: { qty: 0, avgPrice: 50 }, closedFill: { qty: 100, exitPrice: 20 } });
  assert.strictEqual(legPnlPct(closed, 999), 60);                          // LTP ignored once closed
});

test('legPnlPct is null with no entry price or quantity, and scales with the multiplier consistently', () => {
  assert.strictEqual(legPnlPct(colLeg({ status: 'DRAFT', fill: undefined }), 30), null);
  assert.strictEqual(legPnlPct(colLeg({}), 30, 100), 40);                   // multiplier cancels out of the ratio
});

test('legOtmPct: positive OTM, negative ITM, CE and PE mirror each other', () => {
  assert.strictEqual(legOtmPct(colLeg({ option: 'CE', strike: 24240 }), 24000), 1);
  assert.strictEqual(legOtmPct(colLeg({ option: 'PE', strike: 23760 }), 24000), 1);
  assert.strictEqual(legOtmPct(colLeg({ option: 'CE', strike: 23760 }), 24000), -1);
  assert.strictEqual(legOtmPct(colLeg({}), 0), null);
});

test('legPnlPct is null for a live leg with no price yet, but not for a closed one', () => {
  assert.strictEqual(legPnlPct(colLeg({}), 0), null);
  const closed = colLeg({ status: 'CLOSED', fill: { qty: 0, avgPrice: 50 }, closedFill: { qty: 100, exitPrice: 20 } });
  assert.strictEqual(legPnlPct(closed, 0), 60);
});

test('formatExpiryLabel renders an ISO date compactly and leaves anything else alone', () => {
  assert.strictEqual(formatExpiryLabel('2026-10-27'), '27 Oct 26');
  assert.strictEqual(formatExpiryLabel('2026-01-05'), '5 Jan 26');
  assert.strictEqual(formatExpiryLabel('2026-13-05'), '2026-13-05');
  assert.strictEqual(formatExpiryLabel('soon'), 'soon');
  assert.strictEqual(formatExpiryLabel(''), '');
  assert.strictEqual(formatExpiryLabel(undefined), '');
});

test('resolveTemplateLegs preserves ratio and scales lots with multiplier', () => {
  const template: StrategyTemplate = {
    key: 'batman', name: 'Batman',
    legs: [
      { side: 'B', option: 'PE', offset: -4, ratio: 1 },
      { side: 'S', option: 'PE', offset: -2, ratio: 2 },
      { side: 'S', option: 'CE', offset: 2, ratio: 2 },
      { side: 'B', option: 'CE', offset: 4, ratio: 1 },
    ],
  };
  const strikes = [23200, 23400, 23600, 23800, 24000, 24200, 24400, 24600, 24800];
  const legs = resolveTemplateLegs(template, 24000, strikes, 100, '2026-10-01', undefined, 3);
  assert.strictEqual(legs.length, 4);
  assert.strictEqual(legs[0].ratio, 1);
  assert.strictEqual(legs[0].lots, 3);
  assert.strictEqual(legs[1].ratio, 2);
  assert.strictEqual(legs[1].lots, 6);
  assert.strictEqual(legs[2].ratio, 2);
  assert.strictEqual(legs[2].lots, 6);
  assert.strictEqual(legs[3].ratio, 1);
  assert.strictEqual(legs[3].lots, 3);
});

test('scaleBasketMultiplier scales all legs proportionally and clamps 1..50', () => {
  const basket: MultiLegBasket = {
    id: 'b1',
    underlying: 'NIFTY',
    expiry: '2026-10-01',
    broker: 'dhan',
    multiplier: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    legs: [
      { id: 'l1', side: 'B', option: 'CE', strike: 24200, ratio: 1, lots: 1, type: 'MARKET', status: 'DRAFT' },
      { id: 'l2', side: 'S', option: 'CE', strike: 24400, ratio: 2, lots: 2, type: 'MARKET', status: 'DRAFT' },
    ],
  };

  // Scale up to 3x
  const scaled3x = scaleBasketMultiplier(basket, 3);
  assert.strictEqual(scaled3x.multiplier, 3);
  assert.strictEqual(scaled3x.legs[0].lots, 3);
  assert.strictEqual(scaled3x.legs[1].lots, 6);
  assert.strictEqual(scaled3x.legs[0].ratio, 1);
  assert.strictEqual(scaled3x.legs[1].ratio, 2);

  // Clamps to min 1
  const scaledMin = scaleBasketMultiplier(scaled3x, 0);
  assert.strictEqual(scaledMin.multiplier, 1);
  assert.strictEqual(scaledMin.legs[0].lots, 1);
  assert.strictEqual(scaledMin.legs[1].lots, 2);

  // Clamps to max 50
  const scaledMax = scaleBasketMultiplier(scaled3x, 100);
  assert.strictEqual(scaledMax.multiplier, 50);
  assert.strictEqual(scaledMax.legs[0].lots, 50);
  assert.strictEqual(scaledMax.legs[1].lots, 100);
});

test('scaleBasketMultiplier derives base ratio when ratio is missing on legacy legs', () => {
  const basket: MultiLegBasket = {
    id: 'b2',
    underlying: 'NIFTY',
    expiry: '2026-10-01',
    broker: 'dhan',
    multiplier: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    legs: [
      { id: 'l1', side: 'S', option: 'CE', strike: 24000, lots: 2, type: 'MARKET', status: 'DRAFT' },
      { id: 'l2', side: 'S', option: 'PE', strike: 23800, lots: 6, type: 'MARKET', status: 'DRAFT' },
    ],
  };

  // l1 has 2 lots with multiplier 2 -> derived ratio 1
  // l2 has 6 lots with multiplier 2 -> derived ratio 3
  const scaled4x = scaleBasketMultiplier(basket, 4);
  assert.strictEqual(scaled4x.multiplier, 4);
  assert.strictEqual(scaled4x.legs[0].ratio, 1);
  assert.strictEqual(scaled4x.legs[0].lots, 4);
  assert.strictEqual(scaled4x.legs[1].ratio, 3);
  assert.strictEqual(scaled4x.legs[1].lots, 12);
});

test('reconcileLegWithBroker holds a just-grown leg against a stale smaller broker read (fill grace)', () => {
  // 1 lot open, user adds 5 lots from the tool → ledger 390. The next poll can
  // still read the pre-order 65; clamping to it would lose 5 lots for good.
  const now = 1_000_000;
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 23400, lots: 6, type: 'MARKET', status: 'OPEN', fill: { qty: 390, avgPrice: 98 }, orderRef: { securityId: '1' }, filledAt: now - 3_000 };
  const stale = { kind: 'match' as const, row: { securityId: '1', netQty: -65, sellAvg: 98 } };
  const held = reconcileLegWithBroker(leg, stale, 390, 65, now);
  assert.strictEqual(held.fill?.qty, 390);
  assert.strictEqual(held.lots, 6);
  // A flat read inside the window doesn't close it either.
  assert.strictEqual(reconcileLegWithBroker(leg, { kind: 'flat' }, 390, 65, now).status, 'OPEN');
  // After the window a real reduction still lands.
  const later = reconcileLegWithBroker(leg, stale, 390, 65, now + LEG_FILL_GRACE_MS);
  assert.strictEqual(later.fill?.qty, 65);
  assert.strictEqual(later.lots, 1);
});

test('claimableLegQty subtracts every other leg tracking the same contract', () => {
  const mk = (id: string, legs: MultiLegLeg[]): MultiLegBasket => ({ id, underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', legs } as unknown as MultiLegBasket);
  const legA: MultiLegLeg = { id: 'a', side: 'S', option: 'CE', strike: 23400, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 98 } };
  const legB: MultiLegLeg = { id: 'b', side: 'S', option: 'CE', strike: 23400, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 90 } };
  const closed: MultiLegLeg = { ...legB, id: 'c', status: 'CLOSED', fill: { qty: 0, avgPrice: 90 } };
  const baskets = [mk('x', [legA, closed]), mk('y', [legB])];
  assert.deepStrictEqual(claimableLegQty(baskets, 'x', 'a', -390), { claimQty: 260, othersQty: 130 });
  assert.deepStrictEqual(claimableLegQty([mk('x', [legA])], 'x', 'a', -390), { claimQty: 390, othersQty: 0 });
  assert.strictEqual(claimableLegQty(baskets, 'x', 'a', 390), null); // long position, short leg
});

const ob = (rows: Record<string, unknown>[]) => {
  const m = new Map<string, NormalizedOrder>();
  for (const r of rows) { const n = normalizeOrderRow(r); if (n) m.set(n.id, n); }
  return m;
};

test('executionBroker: a basket always trades on its own broker, not the selector', () => {
  assert.strictEqual(executionBroker({ broker: 'dhan' }, 'kotak'), 'dhan');
  assert.strictEqual(executionBroker({ broker: '' } as Pick<MultiLegBasket, 'broker'>, 'kotak'), 'kotak');
});

test('applyOrderOutcomes: rejected add-lots order comes back off the ledger', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 23400, lots: 6, type: 'MARKET', status: 'OPEN', fill: { qty: 390, avgPrice: 98 },
    pendingOrders: [{ id: 'A', kind: 'grow', qty: 325, at: 0 }] };
  const { leg: out, notes } = applyOrderOutcomes(leg, ob([{ orderId: 'A', orderStatus: 'REJECTED' }]), 65, 1000);
  assert.strictEqual(out.fill?.qty, 65);
  assert.strictEqual(out.lots, 1);
  assert.strictEqual(out.pendingOrders, undefined);
  assert.strictEqual(notes[0].unfilled, 325);
});

test('applyOrderOutcomes: rejected entry makes the leg FAILED; filled order is simply dropped', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 23400, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 98 },
    pendingOrders: [{ id: 'A', kind: 'grow', qty: 65, at: 0 }] };
  assert.strictEqual(applyOrderOutcomes(leg, ob([{ order_id: 'A', status: 'REJECTED' }]), 65, 1).leg.status, 'FAILED');
  const ok = applyOrderOutcomes(leg, ob([{ orderId: 'A', orderStatus: 'TRADED' }]), 65, 1);
  assert.strictEqual(ok.leg.fill?.qty, 65);
  assert.strictEqual(ok.leg.pendingOrders, undefined);
  assert.strictEqual(ok.notes.length, 0);
});

test('applyOrderOutcomes: rejected exit reopens the CLOSED leg with its qty', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'PE', strike: 22300, lots: 6, type: 'MARKET', status: 'CLOSED', fill: { qty: 0, avgPrice: 70 },
    closedFill: { qty: 390, exitPrice: 80 }, pendingOrders: [{ id: 'X', kind: 'exit', qty: 390, at: 0 }] };
  const { leg: out } = applyOrderOutcomes(leg, ob([{ orderId: 'X', orderStatus: 'REJECTED' }]), 65, 5);
  assert.strictEqual(out.status, 'OPEN');
  assert.strictEqual(out.fill?.qty, 390);
  assert.strictEqual(out.closedFill, undefined);
  assert.strictEqual(out.filledAt, 5);
});

test('applyOrderOutcomes: cancelled with partial fill undoes only the unfilled part; unknown fill is not guessed', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 23400, lots: 3, type: 'LIMIT', status: 'OPEN', fill: { qty: 195, avgPrice: 98 },
    pendingOrders: [{ id: 'A', kind: 'grow', qty: 195, at: 0 }] };
  assert.strictEqual(applyOrderOutcomes(leg, ob([{ orderId: 'A', orderStatus: 'CANCELLED', filledQty: 65 }]), 65, 1).leg.fill?.qty, 65);
  const unk = applyOrderOutcomes(leg, ob([{ orderId: 'A', orderStatus: 'CANCELLED' }]), 65, 1);
  assert.strictEqual(unk.leg.fill?.qty, 195);
  assert.strictEqual(unk.notes[0].unknownFill, true);
  // Still pending (not in the book yet) stays; expired TTL is dropped.
  assert.strictEqual(applyOrderOutcomes(leg, ob([]), 65, 1).leg.pendingOrders?.length, 1);
  assert.strictEqual(applyOrderOutcomes(leg, ob([]), 65, PENDING_ORDER_TTL_MS + 1).leg.pendingOrders, undefined);
});

test('legBrokerMismatch flags a leg whose order identity belongs to another broker', () => {
  assert.strictEqual(legBrokerMismatch({ orderRef: { symbol: 'NIFTY26OCT23400CE' } }, 'dhan'), true);
  assert.strictEqual(legBrokerMismatch({ orderRef: { securityId: '1', symbol: 'X' } }, 'dhan'), false);
  assert.strictEqual(legBrokerMismatch({ orderRef: { securityId: '1' } }, 'kotak'), true);
  assert.strictEqual(legBrokerMismatch({ orderRef: { symbol: 'X' } }, 'zerodha'), false);
  assert.strictEqual(legBrokerMismatch({}, 'dhan'), false);
});

test('classifyDhanOrder: MARKET is placed only once TRADED; LIMIT once resting', () => {
  assert.strictEqual(classifyDhanOrder('TRANSIT', 'MARKET'), 'pending');
  assert.strictEqual(classifyDhanOrder('PENDING', 'MARKET'), 'pending');
  assert.strictEqual(classifyDhanOrder('TRADED', 'MARKET'), 'filled');
  assert.strictEqual(classifyDhanOrder('REJECTED', 'MARKET'), 'dead');
  assert.strictEqual(classifyDhanOrder('PENDING', 'LIMIT'), 'working');
  assert.strictEqual(classifyDhanOrder('PART_TRADED', 'LIMIT'), 'working');
  assert.strictEqual(classifyDhanOrder('CANCELLED', 'LIMIT'), 'dead');
  assert.strictEqual(classifyDhanOrder('', 'LIMIT'), 'pending');
});

// ── Cross-leg allocation (2026-09-29: 23400 CE shared by Short Strangle 390 + naked call 130,
//    then 130 bought back outside the tool — broker 390, tracked 520, no warning) ──
const alloc = (id: string, legs: MultiLegLeg[]): MultiLegBasket =>
  ({ id, underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', legs } as unknown as MultiLegBasket);
const shortCe = (id: string, qty: number, extra: Partial<MultiLegLeg> = {}): MultiLegLeg =>
  ({ id, side: 'S', option: 'CE', strike: 23400, lots: qty / 65, type: 'MARKET', status: 'OPEN', fill: { qty, avgPrice: 96.85 }, orderRef: { securityId: '51368' }, ...extra });

test('legQtyWarningsFor flags sibling legs that together over-track the broker', () => {
  const baskets = [alloc('strangle', [shortCe('s', 390)]), alloc('naked', [shortCe('n', 130)])];
  const net = new Map([['strangle:s', -390], ['naked:n', -390]]);
  const w = legQtyWarningsFor(baskets, net, 0);
  assert.deepStrictEqual(w['naked:n'], { kind: 'over', ownQty: 130, brokerQty: 390, trackedQty: 520, gap: 130 });
  assert.strictEqual(w['strangle:s'].kind, 'over');
});

test('legQtyWarningsFor: under-tracked, balanced, and in-flux groups', () => {
  const two = [alloc('strangle', [shortCe('s', 390)]), alloc('naked', [shortCe('n', 130)])];
  assert.deepStrictEqual(legQtyWarningsFor(two, new Map([['strangle:s', -520]]), 0), {});
  const under = legQtyWarningsFor(two, new Map([['strangle:s', -585]]), 0);
  assert.deepStrictEqual(under['naked:n'], { kind: 'under', ownQty: 130, brokerQty: 585, trackedQty: 520, gap: 65 });
  // A leg inside its fill grace window: the broker can still show the pre-order qty.
  const fresh = [alloc('strangle', [shortCe('s', 390)]), alloc('naked', [shortCe('n', 130, { filledAt: 1_000 })])];
  assert.deepStrictEqual(legQtyWarningsFor(fresh, new Map([['strangle:s', -390]]), 1_000 + LEG_FILL_GRACE_MS - 1), {});
  // Broker row on the other side / unknown: nothing to say.
  assert.deepStrictEqual(legQtyWarningsFor(two, new Map([['strangle:s', 390]]), 0), {});
  assert.deepStrictEqual(legQtyWarningsFor(two, new Map(), 0), {});
});

test('recordOutsideReduction closes fully, or splits off a CLOSED slice on a partial', () => {
  const [closed] = recordOutsideReduction(shortCe('n', 130, { fill: { qty: 130, avgPrice: 92.65 } }), 130, 103.075, 65);
  assert.strictEqual(closed.status, 'CLOSED');
  assert.deepStrictEqual(closed.fill, { qty: 0, avgPrice: 92.65 });
  assert.deepStrictEqual(closed.closedFill, { qty: 130, exitPrice: 103.075 });
  assert.ok(Math.abs(legPnl(closed, 0) - (92.65 - 103.075) * 130) < 1e-9);

  const parts = recordOutsideReduction(shortCe('s', 390, { fill: { qty: 390, avgPrice: 98.25 }, sl: 20 }), 130, 103.075, 65);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0].id, 's');
  assert.strictEqual(parts[0].status, 'OPEN');
  assert.deepStrictEqual(parts[0].fill, { qty: 260, avgPrice: 98.25 });
  assert.strictEqual(parts[0].lots, 4);
  assert.strictEqual(parts[1].status, 'CLOSED');
  assert.deepStrictEqual(parts[1].closedFill, { qty: 130, exitPrice: 103.075 });
  assert.strictEqual(parts[1].lots, 2);
  assert.strictEqual(parts[1].sl, undefined);
  assert.notStrictEqual(parts[1].id, 's');

  const leg = shortCe('x', 65);
  assert.deepStrictEqual(recordOutsideReduction(leg, 0, 100, 65), [leg]);
});

test('findUntrackedPositions reports only the qty no live leg tracks', () => {
  const dhanRow = { securityId: '51368', tradingSymbol: 'NIFTY-Oct2026-23400-CE', netQty: -520, sellAvg: 96.85, buyAvg: 0,
    drvOptionType: 'CALL', drvStrikePrice: 23400, drvExpiryDate: '2026-10-27 14:30:00' };
  const hint = (r: Record<string, unknown>) => contractHintFromRow(r, ['NIFTY', 'BANKNIFTY']);
  const baskets = [alloc('strangle', [shortCe('s', 390), { ...shortCe('old', 130), status: 'CLOSED', fill: { qty: 0, avgPrice: 90 } }])];
  const [u] = findUntrackedPositions('dhan', [dhanRow], baskets, hint);
  assert.strictEqual(u.untrackedQty, 130);
  assert.strictEqual(u.trackedQty, 390);
  assert.strictEqual(u.side, 'S');
  assert.deepStrictEqual(u.hint, { underlying: 'NIFTY', option: 'CE', strike: 23400, expiry: '2026-10-27' });
  // Fully tracked, over-tracked, flat, or another underlying: not importable.
  assert.deepStrictEqual(findUntrackedPositions('dhan', [{ ...dhanRow, netQty: -390 }], baskets, hint), []);
  assert.deepStrictEqual(findUntrackedPositions('dhan', [{ ...dhanRow, netQty: -260 }], baskets, hint), []);
  assert.deepStrictEqual(findUntrackedPositions('dhan', [{ ...dhanRow, netQty: 0 }], [], hint), []);
  assert.deepStrictEqual(findUntrackedPositions('dhan', [{ ...dhanRow, tradingSymbol: 'NIFTYNXT50-Oct2026-700-CE' }], [], hint), []);
  // Another broker's legs never count against this broker's rows.
  assert.strictEqual(findUntrackedPositions('dhan', [dhanRow], [{ ...baskets[0], broker: 'kotak' }], hint)[0].untrackedQty, 520);

  const leg = legFromUntracked(u, { option: 'CE', strike: 23400, expiry: '2026-10-27' }, 130, 92.65, 65);
  assert.strictEqual(leg.status, 'OPEN');
  assert.strictEqual(leg.lots, 2);
  assert.deepStrictEqual(leg.fill, { qty: 130, avgPrice: 92.65 });
  assert.deepStrictEqual(leg.orderRef, { securityId: '51368' });
  // Symbol-keyed brokers match on the trading symbol.
  const z = findUntrackedPositions('zerodha', [{ tradingSymbol: 'NIFTY2692224600CE', netQty: 65, buyAvg: 50 }], [], hint)[0];
  assert.deepStrictEqual(legFromUntracked(z, { option: 'CE', strike: 24600, expiry: '2026-09-22' }, 65, 50, 65).orderRef, { symbol: 'NIFTY2692224600CE' });
});

// 2026-09-29: exits recorded on ACK with LTP-or-entry never learned the real fill
// (22600 PE bought back at 170.675 booked ₹0 because exit == entry).
test('applyOrderOutcomes replaces an ACK-time exit price with the traded average', () => {
  const closed: MultiLegLeg = {
    id: 'x', side: 'S', option: 'PE', strike: 22600, lots: 4, type: 'MARKET', status: 'CLOSED',
    fill: { qty: 0, avgPrice: 31.45 }, closedFill: { qty: 260, exitPrice: 31.45 },
    pendingOrders: [{ id: 'o1', kind: 'exit', qty: 260, at: 0, price: 31.45 }],
  };
  const orders = ob([{ orderId: 'o1', orderStatus: 'TRADED', filledQty: 260, averageTradedPrice: 170.675 }]);
  const { leg } = applyOrderOutcomes(closed, orders, 65, 1);
  assert.strictEqual(leg.closedFill?.exitPrice, 170.675);
  assert.strictEqual(leg.pendingOrders, undefined);
  assert.ok(Math.abs(legPnl(leg, 0) - (31.45 - 170.675) * 260) < 1e-6);
  // Legacy pending entry without a recorded price: still exact when it covers the whole close.
  const legacy = { ...closed, pendingOrders: [{ id: 'o1', kind: 'exit' as const, qty: 260, at: 0 }] };
  assert.strictEqual(applyOrderOutcomes(legacy, orders, 65, 1).leg.closedFill?.exitPrice, 170.675);
  // No traded average in the row: leave the ledger alone.
  const noAvg = ob([{ orderId: 'o1', orderStatus: 'TRADED', filledQty: 260 }]);
  assert.strictEqual(applyOrderOutcomes(closed, noAvg, 65, 1).leg.closedFill?.exitPrice, 31.45);
});

test('applyOrderOutcomes corrects a grow order\'s ACK price into the weighted average', () => {
  // 65 @ 100 already held, +65 recorded at LTP 110 (avg 105); actually filled at 120 -> avg 110.
  const leg: MultiLegLeg = {
    id: 'g', side: 'B', option: 'CE', strike: 23000, lots: 2, type: 'MARKET', status: 'OPEN',
    fill: { qty: 130, avgPrice: 105 }, price: 105,
    pendingOrders: [{ id: 'o2', kind: 'grow', qty: 65, at: 0, price: 110 }],
  };
  const out = applyOrderOutcomes(leg, ob([{ order_id: 'o2', status: 'COMPLETE', average_price: 120 }]), 65, 1).leg;
  assert.strictEqual(out.fill?.avgPrice, 110);
  assert.strictEqual(out.price, 110);
  assert.strictEqual(normalizeOrderRow({ nOrdNo: 'k', ordSt: 'complete', avgPrc: '101.5' })?.avgPrice, 101.5);
});

test('legCountsToday: live legs always, closed legs only when closed on the same IST day', () => {
  const now = Date.parse('2026-09-29T15:30:00Z'); // 21:00 IST
  const base: MultiLegLeg = { id: 't', side: 'S', option: 'CE', strike: 23400, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 90 } };
  assert.strictEqual(legCountsToday(base, now), true);
  const closed = (iso?: string): MultiLegLeg => ({ ...base, status: 'CLOSED', closedAt: iso ? Date.parse(iso) : undefined });
  assert.strictEqual(legCountsToday(closed('2026-09-29T03:50:00Z'), now), true);   // 09:20 IST today
  assert.strictEqual(legCountsToday(closed('2026-09-28T18:40:00Z'), now), true);   // 00:10 IST today (UTC date is yesterday)
  assert.strictEqual(legCountsToday(closed('2026-09-28T09:50:00Z'), now), false);  // yesterday
  assert.strictEqual(legCountsToday(closed(), now), false);                         // closed before closedAt existed
});

test('closing paths stamp closedAt; a reopened exit clears it', () => {
  const open: MultiLegLeg = { id: 'c', side: 'S', option: 'PE', strike: 22000, lots: 2, type: 'MARKET', status: 'OPEN', fill: { qty: 130, avgPrice: 81.45 }, orderRef: { securityId: '51309' } };
  const flat = reconcileLegWithBroker(open, { kind: 'flat', row: { securityId: '51309', netQty: 0, buyQty: 130, sellQty: 130, buyAvg: 84.15, sellAvg: 81.45 } }, null, 65, 5_000);
  assert.strictEqual(flat.status, 'CLOSED');
  assert.strictEqual(flat.closedAt, 5_000);
  assert.strictEqual(recordOutsideReduction(open, 130, 84.15, 65, 7_000)[0].closedAt, 7_000);
  const exited: MultiLegLeg = { ...flat, pendingOrders: [{ id: 'e', kind: 'exit', qty: 130, at: 0 }] };
  const reopened = applyOrderOutcomes(exited, ob([{ orderId: 'e', orderStatus: 'REJECTED', filledQty: 0 }]), 65, 9_000).leg;
  assert.strictEqual(reopened.status, 'OPEN');
  assert.strictEqual(reopened.closedAt, undefined);
});

test('closedFillFromRow sizes the close off the leg, not the pooled broker round trip', () => {
  // Two 2-lot legs on one contract closed together: the row shows 260 each way.
  const row = { buyQty: 260, sellQty: 260, buyAvg: 140.95, sellAvg: 165.375, netQty: 0 };
  assert.deepStrictEqual(closedFillFromRow(row, false, 130), { qty: 130, exitPrice: 140.95, estimated: true });
  // No ledger qty (legacy leg) still falls back to the row.
  assert.deepStrictEqual(closedFillFromRow(row, false), { qty: 260, exitPrice: 140.95, estimated: true });
  const leg: MultiLegLeg = {
    id: 'a', side: 'S', option: 'CE', strike: 22900, lots: 2, type: 'MARKET', status: 'OPEN',
    fill: { qty: 130, avgPrice: 165.375 }, orderRef: { securityId: '51348' },
  };
  const closed = reconcileLegWithBroker(leg, { kind: 'flat', row }, null, 65, 1e15);
  assert.strictEqual(closed.closedFill?.qty, 130);
});

test('mergeImportedLegs folds an import into the open leg on the same contract', () => {
  const own: MultiLegLeg = {
    id: 'own', side: 'S', option: 'PE', strike: 22300, expiry: '2026-10-27', lots: 6, type: 'MARKET', status: 'OPEN',
    fill: { qty: 390, avgPrice: 62 }, orderRef: { securityId: '51321' },
  };
  const ce: MultiLegLeg = { ...own, id: 'ce', option: 'CE', orderRef: { securityId: '51320' } };
  const imp: MultiLegLeg = { ...own, id: 'imp', lots: 3, fill: { qty: 195, avgPrice: 251 } };

  const { legs, merged } = mergeImportedLegs([own, ce], [imp], 1234);
  assert.strictEqual(merged, 1);
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs[0].id, 'own');
  assert.strictEqual(legs[0].lots, 9);
  assert.strictEqual(legs[0].fill?.qty, 585);
  assert.ok(Math.abs((legs[0].fill?.avgPrice ?? 0) - (390 * 62 + 195 * 251) / 585) < 1e-9);
  assert.strictEqual(legs[0].filledAt, 1234);
  assert.strictEqual(legs[1], ce);

  // Not merged: opposite side, closed leg, other expiry, or an unsettled order on the leg.
  for (const other of [
    { ...own, side: 'B' as const },
    { ...own, status: 'CLOSED' as const, fill: { qty: 0, avgPrice: 62 } },
    { ...own, expiry: '2026-11-24' },
    { ...own, pendingOrders: [{ id: 'o1', kind: 'grow' as const, qty: 65, at: 1 }] as MultiLegLeg['pendingOrders'] },
  ]) {
    const r = mergeImportedLegs([other], [imp]);
    assert.strictEqual(r.merged, 0);
    assert.deepStrictEqual(r.legs.map(l => l.id), ['own', 'imp']);
  }
});

test('brokerClampSlice keeps the P&L of qty a clamp removed', () => {
  // 2026-10-01: strangle short 390 of 23400 CE; 130 bought back outside the tool @ 64.
  const leg: MultiLegLeg = {
    id: 'a', side: 'S', option: 'CE', strike: 23400, expiry: '2026-10-27', lots: 6, type: 'MARKET', status: 'OPEN',
    fill: { qty: 390, avgPrice: 96.85 }, orderRef: { securityId: '51368' },
  };
  const row = { netQty: -260, buyQty: 130, sellQty: 0, buyAvg: 64, sellAvg: 0 };
  const next = reconcileLegWithBroker(leg, { kind: 'match', row }, null, 65, 1e15);
  assert.strictEqual(next.fill?.qty, 260);
  assert.strictEqual(next.lots, 4);
  const slice = brokerClampSlice(leg, next, row, 65, 1e15);
  assert.ok(slice);
  assert.strictEqual(slice.status, 'CLOSED');
  assert.strictEqual(slice.lots, 2);
  assert.strictEqual(slice.closedAt, 1e15);
  assert.deepStrictEqual(slice.closedFill, { qty: 130, exitPrice: 64, estimated: true });
  assert.strictEqual(slice.fill?.avgPrice, 96.85);
  assert.ok(Math.abs(legPnl(slice, 0) - 4270.5) < 1e-6);

  // No row price: exit at entry (0 P&L), still flagged.
  assert.deepStrictEqual(brokerClampSlice(leg, next, { netQty: -260 }, 65)?.closedFill, { qty: 130, exitPrice: 96.85, estimated: true });
  // Nothing clamped, or a full close (recorded on the leg itself): no slice.
  assert.strictEqual(brokerClampSlice(leg, leg, row, 65), null);
  assert.strictEqual(brokerClampSlice(leg, { ...next, status: 'CLOSED' }, row, 65), null);
});

test('normalizeTradeRow reads Dhan raw and Zerodha/Kotak shaped trade rows', () => {
  const dhan = normalizeTradeRow({
    orderId: '5226', exchangeTradeId: '9001', securityId: '51368', transactionType: 'BUY',
    tradedQuantity: 130, tradedPrice: 64, exchangeTime: '2026-10-01 09:31:12',
  });
  assert.deepStrictEqual(dhan, {
    key: '5226:9001', orderId: '5226', ident: '51368', side: 'B', qty: 130, price: 64,
    at: Date.parse('2026-10-01T09:31:12+05:30'),
  });
  const kotak = normalizeTradeRow({ tradingSymbol: 'NIFTY28AUG24250CE', transactionType: 'SELL', tradedQuantity: 65, tradedPrice: 104.3, createTime: '10:16:05', orderId: '77' });
  assert.strictEqual(kotak?.ident, 'NIFTY28AUG24250CE');
  assert.strictEqual(kotak?.side, 'S');
  assert.ok((kotak?.at ?? 0) > 0);
  assert.strictEqual(normalizeTradeRow({ securityId: '1', transactionType: 'BUY', tradedQuantity: 0, tradedPrice: 5 }), null);
});

test('ownOrderIds covers settled, pending, last fill and mlf-tagged order-book rows', () => {
  const leg: MultiLegLeg = {
    id: 'a', side: 'S', option: 'CE', strike: 23400, lots: 1, type: 'MARKET', status: 'OPEN',
    fill: { qty: 65, avgPrice: 90, orderId: 'f1' }, orderIds: ['s1'],
    pendingOrders: [{ id: 'p1', kind: 'grow', qty: 65, at: 1 }],
  };
  const basket = { id: 'b', broker: 'dhan', legs: [leg] } as unknown as MultiLegBasket;
  const ids = ownOrderIds([basket], [
    { orderId: 'c1', correlationId: `${MLF_ORDER_SOURCE}abc123` },
    { orderId: 'w1', correlationId: 'wrabc123' },
  ]);
  assert.deepStrictEqual([...ids].sort(), ['c1', 'f1', 'p1', 's1']);
});

test('applyOrderOutcomes keeps a settled order id on the leg', () => {
  const leg: MultiLegLeg = {
    id: 'a', side: 'S', option: 'CE', strike: 23400, lots: 1, type: 'MARKET', status: 'OPEN',
    fill: { qty: 65, avgPrice: 90 }, pendingOrders: [{ id: 'o9', kind: 'grow', qty: 65, at: 1, price: 90 }],
  };
  const orders = new Map([['o9', { id: 'o9', status: 'TRADED', filled: 65, avgPrice: 91 }]]);
  const { leg: out } = applyOrderOutcomes(leg, orders, 65, 2);
  assert.strictEqual(out.pendingOrders, undefined);
  assert.deepStrictEqual(out.orderIds, ['o9']);
});

test('matchOutsideTrades takes the newest exact run of outside trades', () => {
  const t = (key: string, orderId: string, qty: number, price: number, at: number, side: 'B' | 'S' = 'B') =>
    ({ key, orderId, ident: '51368', side, qty, price, at });
  const trades = [
    t('k1', 'x1', 65, 60, 1000),
    t('k2', 'x2', 65, 68, 2000),
    t('k3', 'own', 130, 50, 3000),        // this tool's own order
    t('k4', 'x4', 65, 99, 4000, 'S'),     // wrong side
    t('k5', 'x5', 65, 70, 9_000_000),     // after the close (+60s)
  ];
  const own = new Set(['own']);
  assert.deepStrictEqual(matchOutsideTrades(trades, '51368', 'B', 130, 5000, own, new Set()), { exitPrice: 64, keys: ['k2', 'k1'] });
  assert.deepStrictEqual(matchOutsideTrades(trades, '51368', 'B', 65, 5000, own, new Set(['k2'])), { exitPrice: 60, keys: ['k1'] });
  assert.strictEqual(matchOutsideTrades(trades, '51368', 'B', 100, 5000, own, new Set()), null);
});

test('repriceEstimatedCloses swaps a pooled estimate for the actual outside trade', () => {
  // 2026-10-01: 130 of the strangle's 23400 CE bought back outside the tool @ 64.
  const slice: MultiLegLeg = {
    id: 's', side: 'S', option: 'CE', strike: 23400, lots: 2, type: 'MARKET', status: 'CLOSED',
    closedAt: Date.parse('2026-10-01T09:31:15+05:30'), orderRef: { securityId: '51368' },
    fill: { qty: 0, avgPrice: 96.85 }, closedFill: { qty: 130, exitPrice: 61.2, estimated: true },
  };
  const basket = { id: 'b', broker: 'dhan', legs: [slice] } as unknown as MultiLegBasket;
  const trades = [normalizeTradeRow({
    orderId: 'x', exchangeTradeId: '1', securityId: '51368', transactionType: 'BUY',
    tradedQuantity: 130, tradedPrice: 64, exchangeTime: '2026-10-01 09:31:12',
  })!];
  const out = repriceEstimatedCloses([basket], { dhan: trades }, new Set());
  assert.notStrictEqual(out, [basket]);
  assert.deepStrictEqual(out[0].legs[0].closedFill, { qty: 130, exitPrice: 64 });
  assert.deepStrictEqual(out[0].legs[0].outsideTradeKeys, ['x:1']);
  assert.ok(Math.abs(legPnl(out[0].legs[0], 0) - 4270.5) < 1e-6);
  // Already priced, or no trade book this tick: unchanged (same array).
  assert.strictEqual(repriceEstimatedCloses(out, { dhan: trades }, new Set()), out);
  assert.strictEqual(repriceEstimatedCloses([basket], {}, new Set()).length, 1);
  const none = [basket];
  assert.strictEqual(repriceEstimatedCloses(none, {}, new Set()), none);
});

test('matchOutsideTrades ignores trades from before the position opened', () => {
  const t = (key: string, at: number) => ({ key, orderId: key, ident: '51321', side: 'B' as const, qty: 130, price: 50, at });
  const trades = [t('old', 1_000_000), t('new', 9_000_000)];
  assert.deepStrictEqual(matchOutsideTrades(trades, '51321', 'B', 130, 10_000_000, new Set(), new Set(), 5_000_000)?.keys, ['new']);
  assert.strictEqual(matchOutsideTrades([t('old', 1_000_000)], '51321', 'B', 130, 10_000_000, new Set(), new Set(), 5_000_000), null);
});

// 2026-10-01: the pooled broker average (180.23 over 1105 sold) was imported for the 520
// still open, double-counting the 585 already closed at an own-lot entry of 125.13.
test('residualBrokerAvg strips slices closed today out of the broker pooled average', () => {
  const now = Date.UTC(2026, 9, 1, 8, 0, 0);
  const row = { securityId: '51321', tradingSymbol: 'NIFTY-Oct2026-22300-PE', netQty: -520, sellQty: 1105, sellAvg: 180.22647, buyQty: 585, buyAvg: 241.45555,
    drvOptionType: 'PUT', drvStrikePrice: 22300, drvExpiryDate: '2026-10-27 14:30:00' };
  const closed: MultiLegLeg = { ...shortCe('c', 585), option: 'PE', strike: 22300, status: 'CLOSED', fill: { qty: 0, avgPrice: 125.12778 },
    closedFill: { qty: 585, exitPrice: 241.45555 }, closedAt: now - 3_600_000, orderRef: { securityId: '51321' } };
  const baskets = [alloc('strangle', [closed])];
  assert.ok(Math.abs(residualBrokerAvg('dhan', row, 'S', baskets, true, now) - 242.21) < 0.05);
  // A slice closed on an earlier day is not in today's pooled row — ignored.
  const old = [alloc('strangle', [{ ...closed, closedAt: now - 2 * 86_400_000 }])];
  assert.strictEqual(residualBrokerAvg('dhan', row, 'S', old, true, now), 180.22647);
  // No closed slices, or no pooled qty on the row: the broker average is returned unchanged.
  assert.strictEqual(residualBrokerAvg('dhan', row, 'S', [], true, now), 180.22647);
  assert.strictEqual(residualBrokerAvg('dhan', { ...row, sellQty: undefined }, 'S', baskets, true, now), 180.22647);
  const [u] = findUntrackedPositions('dhan', [row], baskets, r => contractHintFromRow(r, ['NIFTY']), now);
  assert.ok(Math.abs(u.brokerAvg - 242.21) < 0.05);
});

// Audit of the basket store against Dhan's own pooled day totals (22300 PE, 2026-10-01).
test('findContractDrift flags a wrong open avg, an unrecorded close and an estimated exit, and passes a consistent contract', () => {
  const now = Date.UTC(2026, 9, 1, 8, 0, 0);
  const row = { securityId: '51321', tradingSymbol: 'NIFTY-Oct2026-22300-PE', netQty: -520, buyQty: 585, buyAvg: 241.45555, sellQty: 1105, sellAvg: 180.22647 };
  const closed: MultiLegLeg = { ...shortCe('c', 585), option: 'PE', strike: 22300, status: 'CLOSED', fill: { qty: 0, avgPrice: 125.12778 },
    closedFill: { qty: 585, exitPrice: 241.45555 }, closedAt: now - 3_600_000, orderRef: { securityId: '51321' } };
  const open = (avgPrice: number): MultiLegLeg => ({ ...shortCe('o', 520), option: 'PE', strike: 22300, fill: { qty: 520, avgPrice }, orderRef: { securityId: '51321' } });
  // Consistent: closed slice at its own lots + open leg at the residual average.
  assert.deepStrictEqual(findContractDrift('dhan', [row], [alloc('b', [closed, open(242.21)])], now), []);
  // The pooled-average import bug: open leg carrying 180.23 under-states the sell side by ~32k.
  const bad = findContractDrift('dhan', [row], [alloc('b', [closed, open(180.22647)])], now);
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].side, 'S');
  assert.ok(Math.abs(bad[0].basketValue - bad[0].brokerValue + 32_233) < 5);
  // A close the baskets never recorded: quantity short on both sides.
  const missing = findContractDrift('dhan', [row], [alloc('b', [{ ...closed, closedFill: { qty: 520, exitPrice: 241.45555 } }, open(242.21)])], now);
  assert.deepStrictEqual(missing.map(d => [d.side, d.brokerQty - d.basketQty]), [['B', 65], ['S', 65]]);
  // An estimated exit price off the real fill shows up on the buy side only.
  const est = findContractDrift('dhan', [row], [alloc('b', [{ ...closed, closedFill: { qty: 585, exitPrice: 250, estimated: true } }, open(242.21)])], now);
  assert.deepStrictEqual(est.map(d => d.side), ['B']);
  // Slices closed on an earlier day are not in today's row; untracked contracts and rows with no qty fields are skipped.
  assert.strictEqual(findContractDrift('dhan', [row], [alloc('b', [{ ...closed, closedAt: now - 2 * 86_400_000 }, open(242.21)])], now).length, 2);
  assert.deepStrictEqual(findContractDrift('dhan', [{ ...row, securityId: '999' }], [alloc('b', [closed])], now), []);
  assert.deepStrictEqual(findContractDrift('dhan', [{ ...row, buyQty: undefined, sellQty: undefined }], [alloc('b', [closed])], now), []);
  assert.deepStrictEqual(findContractDrift('kotak', [row], [alloc('b', [closed])], now), []);
});
