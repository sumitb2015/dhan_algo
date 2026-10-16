import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndexCard, buildIndiaDashboard, buildIndiaRow, INDIA_INDICES, parseConstituentRows, resolveMembers } from './indiaMarkets.ts';

const q = (ltp: number | undefined, prev: number | undefined, extra: Record<string, unknown> = {}) => ({ ltp, prev_close: prev, ...extra });

test('buildIndiaRow: change from ltp/prev, nulls not zeros', () => {
  const r = buildIndiaRow('TCS', q(110, 100, { industry: 'Information Technology', volume: 5, turnover_cr: 2, high_52w: 120, low_52w: 100 }), null);
  assert.equal(r.change, 10);
  assert.equal(r.changePct, 10);
  assert.equal(r.industry, 'Information Technology');
  assert.equal(r.wk52Pos, 0.5);
  const empty = buildIndiaRow('X', q(0, 0, { volume: 0 }), 'Power', 'X Ltd');
  assert.deepEqual([empty.ltp, empty.changePct, empty.volume, empty.industry, empty.name], [null, null, null, 'Power', 'X Ltd']);
  assert.equal(buildIndiaRow('Y', undefined, null).changePct, null);
});

test('buildIndexCard: no prev close -> null change', () => {
  const def = INDIA_INDICES[0];
  assert.equal(buildIndexCard(def, { ltp: 100, prev_close: null }).changePct, null);
  assert.equal(buildIndexCard(def, { ltp: 102, prev_close: 100 }).changePct, 2);
});

test('resolveMembers: list, all, derived minus, none', () => {
  const lists = new Map([['niftybank', ['HDFCBANK', 'SBIN', 'ICICIBANK']], ['niftypsubank', ['SBIN', 'PNB']]]);
  const byKey = (s: string) => INDIA_INDICES.find(d => d.symbol === s)!;
  assert.deepEqual(resolveMembers(byKey('BANKNIFTY'), lists, []), ['HDFCBANK', 'SBIN', 'ICICIBANK']);
  assert.deepEqual(resolveMembers(byKey('NIFTY PVT BANK'), lists, []), ['HDFCBANK', 'ICICIBANK']);
  assert.deepEqual(resolveMembers(byKey('NIFTY 500'), lists, ['A', 'B']), ['A', 'B']);
  assert.deepEqual(resolveMembers(byKey('MIDCPNIFTY'), lists, ['A']), []);
  assert.deepEqual(resolveMembers(byKey('NIFTYIT'), lists, ['A']), [], 'a missing list is empty, not the universe');
});

test('buildIndiaDashboard: index benchmark vs member median, industries, breadth, movers', () => {
  const rows = [
    buildIndiaRow('TCS', q(105, 100, { industry: 'Information Technology', turnover_cr: 900 }), null),
    buildIndiaRow('INFY', q(98, 100, { industry: 'Information Technology', turnover_cr: 1200 }), null),
    buildIndiaRow('NTPC', q(100, 100, { industry: 'Power', turnover_cr: 50 }), null),
    buildIndiaRow('NEW', undefined, 'Power'),
  ];
  const lists = new Map([['niftyit', ['TCS', 'INFY']]]);
  const d = buildIndiaDashboard(rows, { NIFTYIT: { ltp: 101, prev_close: 100 }, 'NIFTY 500': { ltp: 50 } }, lists);
  const it = d.sectors.find(g => g.key === 'NIFTYIT')!;
  assert.equal(it.etfPct, 1);
  assert.equal(it.medianPct, 1.5);
  assert.deepEqual([it.adv, it.dec, it.quoted], [1, 1, 2]);
  assert.equal(d.sectors[0].key, 'NIFTYIT', 'sectors sorted by their index move, quoted ones first');
  const n500 = d.broad.find(g => g.key === 'NIFTY 500')!;
  assert.equal(n500.symbols.length, 4);
  assert.equal(n500.etfPct, null);
  assert.deepEqual(d.industries.map(g => g.label), ['Information Technology', 'Power']);
  assert.deepEqual(d.breadth, { total: 4, quoted: 3, adv: 1, dec: 1, unch: 1 });
  assert.deepEqual(d.gainers.map(r => r.symbol), ['TCS']);
  assert.deepEqual(d.losers.map(r => r.symbol), ['INFY']);
  assert.deepEqual(d.active.map(r => r.symbol), ['INFY', 'TCS', 'NTPC']);
});

test('catalogue: unique symbols, every sector has a member source', () => {
  assert.equal(new Set(INDIA_INDICES.map(d => d.symbol)).size, INDIA_INDICES.length);
  for (const d of INDIA_INDICES.filter(x => x.kind === 'sector')) assert.ok(d.members, d.symbol);
});

test('parseConstituentRows: columns read from the end survive a comma in the company name', () => {
  const csv = 'Company Name,Industry,Symbol,Series,ISIN Code\nFoo, Bar Ltd.,Power,FOOBAR,EQ,INE1\nABB India Ltd.,Capital Goods,ABB,EQ,INE2\nDummy,X,DUMMYX,EQ,I\n';
  assert.deepEqual(parseConstituentRows(csv), [
    { symbol: 'FOOBAR', industry: 'Power', company: 'Foo, Bar Ltd.' },
    { symbol: 'ABB', industry: 'Capital Goods', company: 'ABB India Ltd.' },
  ]);
  assert.deepEqual(parseConstituentRows('Symbol\n'), []);
});

test('buildIndiaRow: a source "none" row is no quote, not a flat 0%', () => {
  const r = buildIndiaRow('X', { source: 'none', ltp: 100, prev_close: 100, open: 100, high: 100, low: 100, vwap: 100, volume: 0, industry: 'General' }, 'Power', 'X Ltd');
  assert.deepEqual([r.ltp, r.change, r.changePct, r.open, r.vwap, r.volume, r.prevClose, r.industry], [null, null, null, null, null, null, 100, 'Power']);
  assert.equal(buildIndiaRow('Y', { source: 'eod', ltp: 101, prev_close: 100 }, null).changePct, 1);
});

test('buildIndiaDashboard: a stock symbol equal to an index symbol does not shadow the benchmark', () => {
  const rows = [buildIndiaRow('NIFTYIT', q(90, 100), 'IT'), buildIndiaRow('TCS', q(102, 100), 'IT')];
  const d = buildIndiaDashboard(rows, { NIFTYIT: { ltp: 105, prev_close: 100 } }, new Map([['niftyit', ['TCS']]]));
  assert.equal(d.sectors.find(g => g.key === 'NIFTYIT')?.etfPct, 5);
});

test('buildIndiaDashboard: sectors with an index move sort before those on the member median', () => {
  const rows = [buildIndiaRow('A', q(110, 100), 'X'), buildIndiaRow('B', q(99, 100), 'X')];
  const lists = new Map([['niftyit', ['A']], ['niftyauto', ['B']]]);
  const d = buildIndiaDashboard(rows, { 'NIFTY AUTO': { ltp: 99, prev_close: 100 } }, lists);
  assert.deepEqual(d.sectors.slice(0, 2).map(g => g.key), ['NIFTY AUTO', 'NIFTYIT']);
});
