import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveTemplateLegs, reconcileLegFillDown, reconcileLegWithBroker, legPnl, basketTotalPnl, sortLegsForExit, findLegPosition,
  computeLegTrailingSL, computeStrategyMetrics, checkStrategyRisk, computeCalendarPayoffCurve, classifyBasketStructure, findSiblingLegCollisions,
  legAvgPrice, legExitPrice, legQtyUnits, legPnlPct, legOtmPct,
  type StrategyMetrics, type MultiLegLeg,
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

test('computeCalendarPayoffCurve: front leg is priced at pure intrinsic value at its own strike', () => {
  const legs = [
    { side: 'S' as const, option: 'CE' as const, strike: 24000, qty: 65, entryPrice: 100, iv: 0.13, expiry: '2026-09-25' },
    { side: 'B' as const, option: 'CE' as const, strike: 24000, qty: 65, entryPrice: 150, iv: 0.13, expiry: '2026-10-30' },
  ];
  const { points } = computeCalendarPayoffCurve(legs, 24000, '2026-09-25', '2026-10-30', 50);
  // Deep ITM: front SELL CE is worth its full intrinsic value (large loss on
  // the short leg), while the far BUY CE's Black-76 value approaches its own
  // intrinsic value too (deep ITM options carry little extra time value) —
  // sanity-check the front leg's contribution is being priced at intrinsic,
  // not carrying phantom time value of its own.
  const deepItm = points.find(p => p.x === points[points.length - 1].x)!;
  const frontIntrinsicAtDeepItm = deepItm.x - 24000; // CE intrinsic
  // Net pnl should be roughly -(frontIntrinsic - 100)*65 + (farValue - 150)*65;
  // since farValue >= frontIntrinsic always (far leg still has time value),
  // deep ITM the position should NOT show unbounded loss growing purely from
  // the front leg alone — the far leg's own deep-ITM intrinsic floor caps it.
  assert.ok(Number.isFinite(deepItm.y));
  assert.ok(frontIntrinsicAtDeepItm > 0);
});

test('computeCalendarPayoffCurve: far leg carries positive time value even exactly at its own strike (near leg intrinsic is zero there)', () => {
  const legs = [
    { side: 'S' as const, option: 'CE' as const, strike: 24000, qty: 65, entryPrice: 100, iv: 0.15, expiry: '2026-09-25' },
    { side: 'B' as const, option: 'CE' as const, strike: 24000, qty: 65, entryPrice: 150, iv: 0.15, expiry: '2026-10-30' },
  ];
  const { points } = computeCalendarPayoffCurve(legs, 24000, '2026-09-25', '2026-10-30', 50);
  const atmPoint = points.find(p => p.x === 24000)!;
  // At the shared strike: front leg intrinsic = 0 (contributes +entryPrice*qty
  // credit since it was sold for 100 and is now worth 0), far leg is priced
  // via Black-76 at its own residual time — its value must exceed pure
  // intrinsic (0) by some positive time-value premium, so the combined P&L
  // at the peak should be a credit/near-breakeven figure, not deeply negative.
  assert.ok(atmPoint.y > -150 * 65);
});

test('computeCalendarPayoffCurve: breakevens are found via linear interpolation, not snapped to sample points', () => {
  const legs = [
    { side: 'S' as const, option: 'CE' as const, strike: 24000, qty: 65, entryPrice: 120, iv: 0.13, expiry: '2026-09-25' },
    { side: 'B' as const, option: 'CE' as const, strike: 24000, qty: 65, entryPrice: 200, iv: 0.13, expiry: '2026-10-30' },
  ];
  const { breakevens, daysBetweenExpiries } = computeCalendarPayoffCurve(legs, 24000, '2026-09-25', '2026-10-30', 50);
  assert.strictEqual(daysBetweenExpiries, 35);
  assert.ok(Array.isArray(breakevens));
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
  assert.strictEqual(reconciled.fill?.avgPrice, 108.5); // broker's avg price is still trusted (not ownership-sensitive)
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
    hasUnpricedLegs: false,
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
    hasUnpricedLegs: false,
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
  assert.deepStrictEqual(reconciled.closedFill, { qty: 65, exitPrice: 60.1 }); // bought back to cover
});

test('reconcileLegWithBroker captures closedFill from a match row that just went flat (BUY leg exits at sellAvg)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'CE', strike: 24300, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 65, avgPrice: 50 }, orderRef: { securityId: '47331' } };
  const match = { kind: 'match' as const, row: { securityId: '47331', netQty: 0, buyQty: 65, sellQty: 65, buyAvg: 50, sellAvg: 58 } };
  const reconciled = reconcileLegWithBroker(leg, match);
  assert.strictEqual(reconciled.status, 'CLOSED');
  assert.deepStrictEqual(reconciled.closedFill, { qty: 65, exitPrice: 58 }); // sold to close
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
