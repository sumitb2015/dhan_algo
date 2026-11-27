// SENSEX on /index-scalper (added 2026-11-27): BSE index + BSE_FNO future (chart only) + options, on Dhan and Kotak.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dhanSegmentOfSymbol, INSTRUMENTS, pnlMultiplier, qtyLots } from './indexScalperInstrument.ts';
import { bracketKind, legAnchor, legsFromDhanPositions, parseScalperContract, type ScalperLeg } from './indexScalperPositions.ts';
import { kotakOrdersAsDhan, legsFromKotakPositions, type KotakSymbolInfo } from './indexScalperKotak.ts';
import { guardScopeIds } from './indexScalperMtmGuard.ts';
import { resolveSource, sourceLabel, legOnChart, bracketsOnChart } from './indexScalperChartSource.ts';

test('parseScalperContract: SENSEX options are SENSEX legs; NIFTY and SENSEX never read each other; futures are chart only', () => {
  assert.deepEqual(parseScalperContract('SENSEX-Dec2026-85000-CE', 'SENSEX'), { strike: 85000, type: 'CE' });
  assert.deepEqual(parseScalperContract('SENSEX-Jan2027-84500-PE', 'SENSEX'), { strike: 84500, type: 'PE' });
  assert.equal(parseScalperContract('SENSEX-Dec2026-85000-CE', 'NIFTY'), null);
  assert.equal(parseScalperContract('NIFTY-Dec2026-26000-CE', 'SENSEX'), null);
  // The SENSEX future is a chart-only pane, like NIFTY's: a strategy's future never lands in this page's legs.
  assert.equal(parseScalperContract('SENSEX-Dec2026-FUT', 'SENSEX'), null);
});

test('legsFromDhanPositions: BSE_FNO SENSEX rows in units (mult 1), NIFTY rows and the future left out', () => {
  const rows = [
    { tradingSymbol: 'SENSEX-Dec2026-85000-CE', securityId: '1165299', exchangeSegment: 'BSE_FNO', productType: 'INTRADAY', netQty: -40, sellAvg: 310.5 },
    { tradingSymbol: 'SENSEX-Dec2026-FUT', securityId: '1145756', exchangeSegment: 'BSE_FNO', productType: 'MARGIN', netQty: 20, buyAvg: 84800 },
    { tradingSymbol: 'NIFTY-Dec2026-26000-PE', securityId: '58001', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: 65, buyAvg: 120 },
  ];
  const legs = legsFromDhanPositions(rows, new Map([['1165299', 300]]), 'SENSEX');
  assert.equal(legs.length, 1);
  const l = legs[0];
  assert.equal(l.securityId, '1165299');
  assert.equal(l.strike, 85000);
  assert.equal(l.type, 'CE');
  assert.equal(l.netQty, -40);
  assert.equal(l.mult, pnlMultiplier('SENSEX', 'dhan'));
  assert.equal(l.mult, 1);
  assert.equal(l.ltp, 300);
  // 40 units of a 20-unit lot = 2 lots; exits / brackets sized in whole lots only
  assert.equal(qtyLots('SENSEX', l.netQty, l.mult ?? 1, 20), 2);
});

const KSYM: Record<string, KotakSymbolInfo> = {
  SENSEX26DEC85000CE: { expiry: '2026-12-31', strike: 85000, side: 'CE' },
  SENSEX26D0384500PE: { expiry: '2026-12-03', strike: 84500, side: 'PE' },
  SENSEX26DECFUT: { expiry: '2026-12-31', strike: 0, side: 'FUT' },
};

test('legsFromKotakPositions: SENSEX options by trading symbol (units, mult 1); the future skipped', () => {
  const rows = [
    { tradingSymbol: 'SENSEX26DEC85000CE', productType: 'MIS', netQty: -60, sellAvg: 305 },
    { tradingSymbol: 'SENSEX26D0384500PE', productType: 'NRML', netQty: 20, buyAvg: 150 },
    { tradingSymbol: 'SENSEX26DECFUT', productType: 'NRML', netQty: 20, buyAvg: 84800 },
  ];
  const legs = legsFromKotakPositions(rows, KSYM, () => 299, 'SENSEX');
  assert.deepEqual(legs.map(l => [l.securityId, l.type, l.strike, l.netQty, l.mult]), [
    ['SENSEX26DEC85000CE', 'CE', 85000, -60, 1],
    ['SENSEX26D0384500PE', 'PE', 84500, 20, 1],
  ]);
  assert.equal(qtyLots('SENSEX', -60, 1, 20), 3);
  // A NIFTY page never takes SENSEX rows
  assert.equal(legsFromKotakPositions(rows, KSYM, () => 1, 'NIFTY').length, 0);
});

test('MTM guard scope: SENSEX options in, the SENSEX future and NIFTY out', () => {
  const kotak = guardScopeIds([
    { tradingSymbol: 'SENSEX26DEC85000CE' }, { tradingSymbol: 'SENSEX26DECFUT' }, { tradingSymbol: 'NIFTY26D0126000CE' },
  ], 'SENSEX', 'kotak');
  assert.deepEqual([...kotak], ['SENSEX26DEC85000CE']);
  const dhan = guardScopeIds([
    { tradingSymbol: 'SENSEX-Dec2026-85000-CE', securityId: '1165299' },
    { tradingSymbol: 'SENSEX-Dec2026-FUT', securityId: '1145756' },
    { tradingSymbol: 'NIFTY-Dec2026-26000-CE', securityId: '58000' },
  ], 'SENSEX', 'dhan');
  assert.deepEqual([...dhan], ['1165299']);
});

test('Kotak orders in Dhan shape carry BSE_FNO for SENSEX (and keep NSE_FNO / MCX_COMM for the others)', () => {
  const rows = kotakOrdersAsDhan([
    { orderId: '1', tradingSymbol: 'SENSEX26DEC85000CE', orderStatus: 'open', quantity: 20, transactionType: 'BUY' },
    { orderId: '2', tradingSymbol: 'NIFTY26D0126000CE', orderStatus: 'open', quantity: 65, transactionType: 'BUY' },
    { orderId: '3', tradingSymbol: 'CRUDEOILM19DEC26FUT', orderStatus: 'open', quantity: 10, transactionType: 'BUY' },
  ], KSYM, new Set(['1']));
  assert.deepEqual(rows.map(r => r.exchangeSegment), ['BSE_FNO', 'NSE_FNO', 'MCX_COMM']);
  assert.equal(rows[0].correlationId, 'isx-kotak');
  assert.equal(dhanSegmentOfSymbol('SENSEX-Dec2026-85000-CE'), 'BSE_FNO');
  assert.equal(dhanSegmentOfSymbol('SENSEXX-Dec2026-FUT'), 'NSE_FNO'); // exact root only
});

test('chart source: SENSEX index pane, FUT pane (chart only) and option panes with Rs 0.05 ticks', () => {
  const ids = new Map([[84900, { ceId: '1', peId: '2' }], [85000, { ceId: '3', peId: '4' }]]);
  const idx = resolveSource({ kind: 'underlying' }, 'SENSEX', ids, 84960);
  assert.equal(idx.kind, 'underlying');
  assert.equal(idx.tick, INSTRUMENTS.SENSEX.futTick);
  assert.equal(sourceLabel('SENSEX', idx), 'SENSEX IDX');
  const fut = resolveSource({ kind: 'future' }, 'SENSEX', ids, 84960, null, '1145756');
  assert.equal(fut.kind, 'future');
  assert.equal(fut.dhanId, '1145756');
  assert.equal(sourceLabel('SENSEX', fut), 'SENSEX FUT');
  const opt = resolveSource({ kind: 'option', type: 'CE', strike: 0 }, 'SENSEX', ids, 84960);
  assert.equal(opt.strike, 85000); // ATM from the listed strikes (step 100)
  assert.equal(opt.dhanId, '3');
  assert.equal(opt.tick, 0.05);
  const leg: ScalperLeg = { id: '3|INTRADAY', securityId: '3', product: 'INTRADAY', symbol: 'SENSEX-Dec2026-85000-CE', strike: 85000, type: 'CE', netQty: -20, avg: 300, ltp: 290, sim: false, mult: 1 };
  assert.equal(legOnChart(leg, fut), false);
  assert.equal(bracketsOnChart(leg, idx), false); // TP / SL on its own premium chart only
  assert.equal(bracketsOnChart(leg, opt), true);
});

test('SENSEX anchors and TP / SL kind follow the index rules', () => {
  const leg: ScalperLeg = { id: '3', securityId: '3', product: '', symbol: 'SENSEX-Dec2026-85000-CE', strike: 85000, type: 'CE', netQty: -20, avg: 300, ltp: 290, sim: true };
  assert.deepEqual(legAnchor(leg, 84960), { level: 84960, kind: 'entry' });
  assert.deepEqual(legAnchor(leg, undefined), { level: 85000, kind: 'strike' });
  assert.deepEqual(legAnchor(leg, 84960, { premium: true }), { level: 300, kind: 'avg' });
  assert.deepEqual(legAnchor(leg, 84960, { atStrike: true }), { level: 85000, kind: 'strike' });
  // Short option: a BUY stop-limit above is the SL, a BUY limit below the TP, wherever they sit
  assert.equal(bracketKind('STOP_LOSS', 330, 300, false), 'SL');
  assert.equal(bracketKind('LIMIT', 250, 300, false), 'TP');
});

test('Dhan rows: a SENSEX option whose trading symbol form is unknown is taken from its own contract fields', async () => {
  const { dhanRowContract } = await import('./indexScalperPositions.ts');
  const rows = [
    // a symbol form the parser does not know (Dhan's trade-book style): from drvOptionType / drvStrikePrice
    { tradingSymbol: 'SENSEX 03 DEC 85000 CALL', securityId: '1165299', exchangeSegment: 'BSE_FNO', productType: 'INTRADAY', netQty: -40, sellAvg: 320, drvOptionType: 'CALL', drvStrikePrice: 85000 },
    { tradingSymbol: 'SENSEX03DEC84900PE', securityId: '1165202', exchangeSegment: 'BSE_FNO', productType: 'MARGIN', netQty: 20, buyAvg: 280, drvOptionType: 'PUT', drvStrikePrice: 84900 },
    // never: a future, another segment, another root, no strike
    { tradingSymbol: 'SENSEX DEC FUT', securityId: '1145756', exchangeSegment: 'BSE_FNO', productType: 'MARGIN', netQty: 20, buyAvg: 84900, drvOptionType: 'XX', drvStrikePrice: -0.01 },
    { tradingSymbol: 'SENSEX 03 DEC 85100 CALL', securityId: '1', exchangeSegment: 'NSE_FNO', netQty: 20, buyAvg: 1, drvOptionType: 'CALL', drvStrikePrice: 85100 },
    { tradingSymbol: 'SENSEXX 03 DEC 85100 CALL', securityId: '2', exchangeSegment: 'BSE_FNO', netQty: 20, buyAvg: 1, drvOptionType: 'CALL', drvStrikePrice: 85100 },
    { tradingSymbol: 'SENSEX 03 DEC CALL', securityId: '3', exchangeSegment: 'BSE_FNO', netQty: 20, buyAvg: 1, drvOptionType: 'CALL' },
  ];
  const legs = legsFromDhanPositions(rows, new Map(), 'SENSEX');
  assert.deepEqual(legs.map(l => [l.securityId, l.type, l.strike, l.netQty]), [['1165299', 'CE', 85000, -40], ['1165202', 'PE', 84900, 20]]);
  assert.deepEqual([...guardScopeIds(rows, 'SENSEX', 'dhan')], ['1165299', '1165202']);
  // the known form still parses from the symbol; NIFTY never takes a SENSEX row
  assert.deepEqual(dhanRowContract({ tradingSymbol: 'SENSEX-Dec2026-85000-CE', exchangeSegment: 'BSE_FNO' }, 'SENSEX'), { strike: 85000, type: 'CE' });
  assert.equal(dhanRowContract(rows[0], 'NIFTY'), null);
  // MCX never falls back
  assert.equal(dhanRowContract({ tradingSymbol: 'CRUDEOILM 17 DEC 6000 CALL', exchangeSegment: 'MCX_COMM', drvOptionType: 'CALL', drvStrikePrice: 6000 }, 'CRUDEOILM'), null);
});
