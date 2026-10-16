import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupStats, median, movers, parseYahooChart, tagRows, universeBreadth } from './usDashboard.ts';
import { US_GROUPS, resolveUniverse, universeSymbols, sectorOf, aiThemesOf, type UsGroup } from './usUniverse.ts';
import { buildUsRow, parseUsScripMaster, US_SUBSCRIBE_MAX, US_WATCHLIST_MAX, type UsInstrument, type UsQuoteRow } from './usStocks.ts';

const inst = (symbol: string, id: string): UsInstrument => ({ id, symbol, name: symbol, exchange: 'NASDAQ', tick: 0.01, fractional: true });
const row = (symbol: string, ltp?: number, prev?: number): UsQuoteRow => buildUsRow(inst(symbol, String(10000000 + symbol.length)), { ltp, prev_close: prev }, 0);

const G: UsGroup[] = [
  { key: 'index', label: 'Idx', kind: 'index', desc: '', symbols: ['SPY'] },
  { key: 'tech', label: 'Tech', kind: 'sector', etf: 'XLK', desc: '', symbols: ['AAA', 'BBB', 'CCC', 'DDD'] },
  { key: 'ai-chips', label: 'Chips', kind: 'ai', desc: '', symbols: ['AAA', 'BBB'] },
];

test('median handles empty, odd and even', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('groupStats: un-quoted members are excluded, not counted as 0', () => {
  const m = new Map([['AAA', row('AAA', 110, 100)], ['BBB', row('BBB', 95, 100)], ['CCC', row('CCC', 100, 100)], ['XLK', row('XLK', 101, 100)]]);
  const [, tech, chips] = groupStats(G, m);
  assert.equal(tech.quoted, 3);
  assert.deepEqual([tech.adv, tech.dec, tech.unch], [1, 1, 1]);
  assert.ok(Math.abs((tech.avgPct as number) - 5 / 3) < 1e-9);
  assert.equal(tech.medianPct, 0);
  assert.equal(tech.best?.symbol, 'AAA');
  assert.equal(tech.worst?.symbol, 'BBB');
  assert.ok(Math.abs((tech.etfPct as number) - 1) < 1e-9);
  assert.equal(chips.etfPct, null);
  const empty = groupStats(G, new Map())[1];
  assert.deepEqual([empty.quoted, empty.avgPct, empty.medianPct, empty.best, empty.etfPct], [0, null, null, null, null]);
});

test('tagRows / movers / breadth: ETFs are not stocks', () => {
  const rows = tagRows(G, [row('SPY', 101, 100), row('XLK', 90, 100), row('AAA', 120, 100), row('BBB', 80, 100), row('CCC'), row('DDD', 100, 100)]);
  const by = new Map(rows.map(r => [r.symbol, r]));
  assert.equal(by.get('SPY')?.isEtf, true);
  assert.equal(by.get('XLK')?.isEtf, true);
  assert.equal(by.get('AAA')?.sector, 'tech');
  assert.deepEqual(by.get('AAA')?.themes, ['ai-chips']);
  const mv = movers(rows);
  assert.deepEqual(mv.gainers.map(r => r.symbol), ['AAA']);
  assert.deepEqual(mv.losers.map(r => r.symbol), ['BBB']);
  assert.deepEqual(universeBreadth(rows), { total: 4, quoted: 3, adv: 1, dec: 1, unch: 1 });
});

// regularMarketTime 2026-10-16 15:54 UTC (11:54 ET): the last bar is the live session, so prev close is the 10-15 bar.
const YAHOO = {
  chart: { result: [{
    meta: { regularMarketPrice: 7707.73, chartPreviousClose: 7811.54, regularMarketTime: 1792166095, regularMarketDayHigh: 7756.84, regularMarketDayLow: 7707.73 },
    timestamp: [1792157400 - 4 * 86400, 1792157400 - 3 * 86400, 1792157400 - 2 * 86400, 1792157400 - 86400, 1792157400],
    indicators: { quote: [{ close: [7807.24, 7805.45, 7718.94, 7744.06, 7707.73] }] },
  }] },
};

test('parseYahooChart: prev close is the previous session bar, not chartPreviousClose', () => {
  const q = parseYahooChart(YAHOO, '^GSPC', 'S&P 500');
  assert.ok(q);
  assert.equal(q.prevClose, 7744.06);
  assert.ok(Math.abs((q.changePct as number) - ((7707.73 - 7744.06) / 7744.06) * 100) < 1e-9);
  assert.equal(q.tradingDate, '2026-10-16');
});

test('parseYahooChart: after the close with no bar for today yet, the last bar is the previous session', () => {
  const j = structuredClone(YAHOO);
  j.chart.result[0].timestamp.pop();
  j.chart.result[0].indicators.quote[0].close.pop();
  assert.equal(parseYahooChart(j, '^GSPC', 'S&P 500')?.prevClose, 7744.06);
});

test('parseYahooChart: null bars are skipped; missing price is null', () => {
  const j = structuredClone(YAHOO);
  (j.chart.result[0].indicators.quote[0].close as Array<number | null>)[3] = null;
  assert.equal(parseYahooChart(j, 'x', 'x')?.prevClose, 7718.94);
  assert.equal(parseYahooChart({ chart: { result: [{ meta: {} }] } }, 'x', 'x'), null);
  assert.equal(parseYahooChart({ chart: { result: null } }, 'x', 'x'), null);
  assert.equal(parseYahooChart(null, 'x', 'x'), null);
});

test('universe: no duplicate member within a group, every sector has an ETF, fits the cap', () => {
  for (const g of US_GROUPS) assert.equal(new Set(g.symbols).size, g.symbols.length, g.key);
  const sectors = US_GROUPS.filter(g => g.kind === 'sector');
  assert.equal(sectors.length, 11);
  for (const g of sectors) assert.ok(g.etf, g.key);
  // A stock sits in at most one GICS sector.
  const seen = new Map<string, string>();
  for (const g of sectors) for (const s of g.symbols) { assert.ok(!seen.has(s), `${s} in ${seen.get(s)} and ${g.key}`); seen.set(s, g.key); }
  assert.ok(universeSymbols().length + US_WATCHLIST_MAX <= US_SUBSCRIBE_MAX, 'a full user watchlist plus the universe must fit');
  assert.equal(sectorOf('V')?.key, 'fin');
  assert.equal(sectorOf('GOOGL')?.key, 'comm');
  assert.deepEqual(aiThemesOf('NVDA').map(g => g.key), ['ai-chips']);
});

test('resolveUniverse reports unknown symbols instead of guessing', () => {
  const r = resolveUniverse(new Map([['SPY', '1'], ['AAA', '2']]), G);
  assert.deepEqual(r.ids, ['1', '2']);
  assert.ok(r.unresolved.includes('XLK') && r.unresolved.includes('BBB'));
});

// Against the real cached master when this machine has one (skipped on a fresh checkout).
const MASTER = path.resolve(import.meta.dirname, '..', '..', 'debug', 'us_stock_scrip_master.csv');
test('every universe symbol is on Dhan\'s US instrument list', { skip: !fs.existsSync(MASTER) }, () => {
  const list = parseUsScripMaster(fs.readFileSync(MASTER, 'utf8'));
  const r = resolveUniverse(new Map(list.map(i => [i.symbol, i.id])));
  assert.deepEqual(r.unresolved, []);
});
