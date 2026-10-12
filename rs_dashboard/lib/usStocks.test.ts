import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCsvLine, parseUsScripMaster, searchUs, validateWatchlist, nextWatchlist, buildUsRow, bridgeHealth, US_WATCHLIST_MAX, type UsInstrument,
} from './usStocks.ts';

const HEAD = 'EXCHANGE,SEGMENT,SCRIP_CODE,ISIN_CODE,SYMBOL,SYMBOL_NAME,EXCH_SYMBOL,CUSTOM_SYMBOL,TRADING_SYMBOL,FRACTION,CUSTOM_EXCH,INSTRUMENT_NAME,TICK_SIZE,LOT_SIZE,UPPER_LIMIT,LOWER_LIMIT,UPDATE_DATE';
const CSV = [
  HEAD,
  'INX,E,10000025,US0378331005,AAPL,APPLE INC,AAPL,Apple Inc,AAPL,true,NASDAQ,EQUITY,0.05,1.0,384.735,207.165,2026-06-18',
  'INX,E,10007290,US67066G1040,NVDA,NVIDIA CORP,NVDA,NVIDIA Corp,NVDA,true,NASDAQ,EQUITY,0.05,1.0,266.0,143.2,2026-06-18',
  'INX,E,10000999,US0000000001,ABC,"ACME, HOLDINGS INC",ABC,"Acme, Holdings ""Global"" Inc",ABC,false,NYSE,EQUITY,0.01,1.0,10,5,2026-06-18',
  'INX,E,notnumeric,US0000000002,BAD,BAD CO,BAD,Bad Co,BAD,false,NYSE,EQUITY,0.01,1.0,10,5,2026-06-18',
  'INX,E,10000777,US0000000003,OPT,SOME OPTION,OPT,Some Option,OPT,false,CBOE,OPTION,0.01,1.0,10,5,2026-06-18',
  '',
].join('\n');

test('splitCsvLine handles quoted commas and doubled quotes', () => {
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('"x ""y"" z",1'), ['x "y" z', '1']);
  assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
  assert.deepEqual(splitCsvLine(''), ['']);
});

test('parseUsScripMaster reads by header name, keeps commas in names, drops bad and non-equity rows', () => {
  const list = parseUsScripMaster(CSV);
  assert.deepEqual(list.map(i => i.symbol), ['AAPL', 'NVDA', 'ABC']);
  const aapl = list[0];
  assert.equal(aapl.id, '10000025');
  assert.equal(aapl.exchange, 'NASDAQ');
  assert.equal(aapl.tick, 0.05);
  assert.equal(aapl.fractional, true);
  assert.equal(list[2].name, 'Acme, Holdings "Global" Inc');
  assert.equal(list[2].fractional, false);
});

test('parseUsScripMaster survives a reordered header and junk input', () => {
  const reordered = 'SYMBOL,SCRIP_CODE,INSTRUMENT_NAME\nAAPL,10000025,EQUITY\n';
  const [a] = parseUsScripMaster(reordered);
  assert.equal(a.id, '10000025');
  assert.equal(a.name, 'AAPL'); // no name column -> falls back to the symbol
  assert.equal(a.tick, 0.01);
  assert.deepEqual(parseUsScripMaster(''), []);
  assert.deepEqual(parseUsScripMaster('only,a,header'), []);
});

const LIST: UsInstrument[] = [
  { id: '1', symbol: 'AAPL', name: 'Apple Inc', exchange: 'NASDAQ', tick: 0.05, fractional: true },
  { id: '2', symbol: 'APLE', name: 'Apple Hospitality REIT', exchange: 'NYSE', tick: 0.01, fractional: false },
  { id: '3', symbol: 'AP', name: 'Ampco-Pittsburgh', exchange: 'NYSE', tick: 0.01, fractional: false },
  { id: '4', symbol: 'MSFT', name: 'Microsoft Corp', exchange: 'NASDAQ', tick: 0.05, fractional: true },
  { id: '5', symbol: 'XYZ', name: 'The Big Apple Co', exchange: 'NYSE', tick: 0.01, fractional: false },
];

test('searchUs ranks exact symbol, then symbol prefix, then name prefix, then name word, then substring', () => {
  assert.deepEqual(searchUs(LIST, 'aapl').map(i => i.symbol), ['AAPL']);
  // symbol prefix (shorter first): AP, APLE; then name prefix: AAPL ("Apple Inc"); then a later name word: XYZ ("The Big Apple Co")
  assert.deepEqual(searchUs(LIST, 'ap').map(i => i.symbol), ['AP', 'APLE', 'AAPL', 'XYZ']);
  const apple = searchUs(LIST, 'apple').map(i => i.symbol);
  assert.deepEqual(apple, ['AAPL', 'APLE', 'XYZ']); // name-prefix x2 (shorter symbol first), then a later name word
  assert.deepEqual(searchUs(LIST, ''), []);
  assert.deepEqual(searchUs(LIST, '   '), []);
  assert.deepEqual(searchUs(LIST, 'zzzz'), []);
  assert.equal(searchUs(LIST, 'a', 2).length, 2);
});

test('validateWatchlist: numeric, known, de-duplicated, capped', () => {
  const known = new Set(['10', '20', '30']);
  assert.deepEqual(validateWatchlist(['10', 20, '10'], known), { ok: true, ids: ['10', '20'] });
  assert.equal(validateWatchlist('10', known).ok, false);
  assert.equal(validateWatchlist(['10', '../x'], known).ok, false);
  assert.equal(validateWatchlist(['99'], known).ok, false);
  assert.equal(validateWatchlist([null], known).ok, false);
  const big = new Set(Array.from({ length: US_WATCHLIST_MAX + 1 }, (_, i) => String(i + 1)));
  assert.equal(validateWatchlist([...big], big).ok, false);
  assert.equal(validateWatchlist([...big].slice(0, US_WATCHLIST_MAX), big).ok, true);
  assert.deepEqual(validateWatchlist([], known), { ok: true, ids: [] });
});

test('buildUsRow: change is vs the Previous Close packet; missing data is null, not 0', () => {
  const now = 1_790_000_100_000;
  const r = buildUsRow(LIST[0], { ltp: 341.072, prev_close: 336.64, open: 338.215, high: 342.63, low: 337.6, volume: 8413326, lut: 1_790_000_090, wk52_high: 345.34, wk52_low: 243.42 }, now);
  assert.ok(Math.abs((r.change ?? 0) - 4.432) < 1e-9);
  assert.ok(Math.abs((r.changePct ?? 0) - 1.3166) < 1e-3);
  assert.equal(r.tradeAgeMs, 10_000);
  assert.ok(r.wk52Pos! > 0.95 && r.wk52Pos! < 1);
  const empty = buildUsRow(LIST[0], undefined, now);
  assert.equal(empty.ltp, null);
  assert.equal(empty.change, null);
  assert.equal(empty.changePct, null);
  assert.equal(empty.tradeAgeMs, null);
  assert.equal(empty.volume, null);
  // price but no previous close yet: show the price, not a fake 0% move
  const noPrev = buildUsRow(LIST[0], { ltp: 100 }, now);
  assert.equal(noPrev.ltp, 100);
  assert.equal(noPrev.changePct, null);
  // zeros from the feed mean "no data yet"
  const zeros = buildUsRow(LIST[0], { ltp: 0, prev_close: 0, wk52_high: 0, wk52_low: 0, volume: 0 }, now);
  assert.equal(zeros.ltp, null);
  assert.equal(zeros.wk52Pos, null);
  assert.equal(zeros.volume, null);
});

test('buildUsRow clamps the 52-week position and ignores an inverted range', () => {
  const above = buildUsRow(LIST[0], { ltp: 400, wk52_high: 300, wk52_low: 100 }, 0);
  assert.equal(above.wk52Pos, 1);
  const bad = buildUsRow(LIST[0], { ltp: 200, wk52_high: 100, wk52_low: 300 }, 0);
  assert.equal(bad.wk52Pos, null);
});

test('bridgeHealth trusts the heartbeat and pid, not just the status string', () => {
  const now = 1_000_000;
  const running = { status: 'RUNNING', heartbeat: now - 3_000, connected: true };
  assert.equal(bridgeHealth(running, true, now), 'live');
  assert.equal(bridgeHealth(running, false, now), 'stopped');                        // dead pid, stale RUNNING file
  assert.equal(bridgeHealth({ ...running, heartbeat: now - 60_000 }, true, now), 'stale');
  assert.equal(bridgeHealth({ ...running, connected: false, status: 'RECONNECTING' }, true, now), 'reconnecting'); // alive, between attempts
  assert.equal(bridgeHealth({ status: 'CONNECTING', heartbeat: now - 1_000, connected: false }, true, now), 'reconnecting');
  assert.equal(bridgeHealth({ ...running, connected: false }, true, now), 'stale');   // RUNNING but no socket: unexpected
  assert.equal(bridgeHealth({ status: 'RECONNECTING', heartbeat: now - 60_000, connected: false }, true, now), 'stale'); // backoff that stopped heartbeating
  assert.equal(bridgeHealth({ status: 'IDLE', heartbeat: now - 1_000 }, true, now), 'idle');
  assert.equal(bridgeHealth({ status: 'ERROR', error: '808: authentication failure' }, true, now), 'error');
  assert.equal(bridgeHealth({ status: 'STOPPED' }, true, now), 'stopped');
  assert.equal(bridgeHealth(null, false, now), 'stopped');
});

test('nextWatchlist prunes delisted ids so one stale id cannot lock the list', () => {
  const known = new Set(['10', '20', '30']);
  // '99' was delisted: it is still in the saved file but no longer in the master.
  assert.deepEqual(nextWatchlist(['10', '99'], 'add', '20', known), { ok: true, ids: ['10', '20'] });
  assert.deepEqual(nextWatchlist(['10', '99'], 'remove', '10', known), { ok: true, ids: [] });
  assert.deepEqual(nextWatchlist(['99'], 'remove', '99', known), { ok: true, ids: [] }); // removing the unknown id itself works
});

test('nextWatchlist: add moves an existing id to the end, rejects bad ids, respects the cap', () => {
  const known = new Set(['10', '20', '30']);
  assert.deepEqual(nextWatchlist(['10', '20'], 'add', '10', known), { ok: true, ids: ['20', '10'] });
  assert.equal(nextWatchlist(['10'], 'add', '../x', known).ok, false);
  assert.equal(nextWatchlist(['10'], 'add', '77', known).ok, false);     // not in Dhan's list
  assert.deepEqual(nextWatchlist(['10'], 'remove', '20', known), { ok: true, ids: ['10'] }); // removing an absent id is a no-op
  const big = new Set(Array.from({ length: US_WATCHLIST_MAX + 1 }, (_, i) => String(i + 1)));
  const full = Array.from({ length: US_WATCHLIST_MAX }, (_, i) => String(i + 1));
  assert.equal(nextWatchlist(full, 'add', String(US_WATCHLIST_MAX + 1), big).ok, false);
});
