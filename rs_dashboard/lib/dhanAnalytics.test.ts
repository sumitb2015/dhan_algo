import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNewsRequest, normalizeNews, parseCompanyInfoRequest, normalizeCompanyInfo, metricNumber,
  parseMoversRequest, normalizeMovers, filterMinOi, moverExpiryMonths,
} from './dhanAnalytics.ts';

const q = (s: string) => new URLSearchParams(s);

// ── news ──
test('news request defaults and clamping', () => {
  const r = parseNewsRequest(q(''));
  assert.ok(r.ok);
  assert.deepEqual(r.value.categories, ['ALL']);
  assert.equal(r.value.limit, 30);
  assert.equal(parseNewsRequest(q('limit=999')).ok && (parseNewsRequest(q('limit=999')) as { value: { limit: number } }).value.limit, 50);
  assert.equal((parseNewsRequest(q('limit=0')) as { value: { limit: number } }).value.limit, 1);
  assert.equal((parseNewsRequest(q('limit=abc')) as { value: { limit: number } }).value.limit, 30);
});

test('news request rejects unknown category, universe and non-numeric stock ids', () => {
  assert.equal(parseNewsRequest(q('categories=COMPANIES,NOPE')).ok, false);
  assert.equal(parseNewsRequest(q('universe=EVERYTHING')).ok, false);
  assert.equal(parseNewsRequest(q('stocks=1333,../etc')).ok, false);
  const ok = parseNewsRequest(q('categories=companies,ipo,companies&universe=portfolio&stocks=1333,12489'));
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.categories, ['COMPANIES', 'IPO']);
  assert.equal(ok.value.universe, 'PORTFOLIO');
  assert.deepEqual(ok.value.stockList, ['1333', '12489']);
});

test('normalizeNews flattens a live payload and maps scrip codes to security ids', () => {
  const raw = { data: { latestNews: [
    { newsObject: { overallSentiment: 'neutral', title: 'Sterling & Wilson sets Q2FY27 earnings call for Oct 16', text: 'call' },
      category: 'COMPANIES', subCategory: 'earnings-financial-results', publishDate: '2026-10-12',
      stockName: 'STERLING AND WILSON RENEWABLE', isinCode: 'INE00M201021', smSymbol: 'SWSOLAR', nseScripCode: 12489, bseScripCode: 542760, displaySymbol: 'Sterling & Wilson Renewable Energy' },
    { newsObject: { overallSentiment: 'weird', title: '   ', text: 'dropped: no title' }, category: 'X' },
    { newsObject: { overallSentiment: 'positive', title: 'Macro item', text: '' }, category: 'INDIAN_ECONOMY', nseScripCode: 0, bseScripCode: null },
  ] } };
  const items = normalizeNews(raw);
  assert.equal(items.length, 2);
  assert.equal(items[0].nseSecurityId, '12489');
  assert.equal(items[0].bseSecurityId, '542760');
  assert.equal(items[0].stockName, 'Sterling & Wilson Renewable Energy');
  assert.equal(items[1].nseSecurityId, null); // 0 / null scrip code = non-company news
  assert.equal(items[1].sentiment, 'positive');
  assert.deepEqual(normalizeNews(null), []);
  assert.deepEqual(normalizeNews({ data: {} }), []);
});

test('normalizeNews unknown sentiment collapses to neutral', () => {
  const [a] = normalizeNews({ data: { latestNews: [{ newsObject: { overallSentiment: 'MIXED', title: 't' } }] } });
  assert.equal(a.sentiment, 'neutral');
});

// ── company info ──
test('company info request validation', () => {
  assert.equal(parseCompanyInfoRequest(q('')).ok, false);
  assert.equal(parseCompanyInfoRequest(q('securityId=1333;rm')).ok, false);
  assert.equal(parseCompanyInfoRequest(q('securityId=1333&exchangeSegment=NSE_FNO')).ok, false);
  assert.equal(parseCompanyInfoRequest(q('securityId=1333&metrics=CO,BOGUS')).ok, false);
  const r = parseCompanyInfoRequest(q('securityId=1333'));
  assert.ok(r.ok);
  assert.deepEqual(r.value.metrics, ['CO', 'RATIOS', 'SHP']);
  assert.equal(r.value.exchangeSegment, 'NSE_EQ');
});

test('metricNumber accepts numbers and numeric strings, maps blanks and junk to null (never 0)', () => {
  assert.equal(metricNumber(13.21), 13.21);
  assert.equal(metricNumber('2.01'), 2.01);
  assert.equal(metricNumber(0), 0); // a real zero stays zero
  assert.equal(metricNumber(null), null);
  assert.equal(metricNumber(undefined), null);
  assert.equal(metricNumber(''), null);
  assert.equal(metricNumber('n/a'), null);
  assert.equal(metricNumber(NaN), null);
});

test('normalizeCompanyInfo keeps null EPS/ROE as null (HDFC Bank live payload)', () => {
  const raw = { securityId: '1333', data: {
    CO: { MARKET_CAP: 1086723.19, INDUSTRY: 'Private Bank', SECTOR: 'Banks', DIVIDEND_YIELD: 2.19, EPS: null, EBITDA: 106336.4, BOOK_VALUE: 390.06, FIFTY_TWO_WEEK_HIGH: 1020.5, FIFTY_TWO_WEEK_LOW: 681.9 },
    RATIOS: { PE_RATIO: 13.21, PB_RATIO: 1.8128, DEBT_TO_EQUITY: 0, ROE: null, ROCE: 5.86 },
    SHP: { REPORTING_PERIOD: null, PROMOTER_HOLDING: 0, FII_HOLDING: 39.4, CHANGE_IN_FII_HOLDING: -2.43 },
  } };
  const c = normalizeCompanyInfo(raw, '1333');
  assert.ok(c);
  assert.equal(c.overview?.eps, null);
  assert.equal(c.overview?.sector, 'Banks');
  assert.equal(c.ratios?.roe, null);
  assert.equal(c.ratios?.debtToEquity, 0);
  assert.equal(c.ratios?.industryEps, null); // absent field -> null, not NaN
  assert.equal(c.shareholding?.reportingPeriod, null);
  assert.equal(c.shareholding?.fiiChange, -2.43);
});

test('normalizeCompanyInfo: unrequested section is null; empty payload is null', () => {
  const c = normalizeCompanyInfo({ data: { CO: { INDUSTRY: 'Cement' } } }, '1');
  assert.ok(c);
  assert.equal(c.ratios, null);
  assert.equal(c.shareholding, null);
  assert.equal(normalizeCompanyInfo({ data: {} }, '1'), null);
  assert.equal(normalizeCompanyInfo(null, '1'), null);
});

// ── movers ──
test('movers request: equity defaults', () => {
  const r = parseMoversRequest(q(''));
  assert.ok(r.ok);
  assert.equal(r.value.exchangeSegment, 'NSE_EQ');
  assert.equal(r.value.category, 'PRICE_GAINERS');
  assert.equal(r.value.universe, 'NIFTY_500');
  assert.equal(r.value.limit, 20);
});

test('movers request rejects the category/instrument combos the API 400s on', () => {
  assert.equal(parseMoversRequest(q('mode=equity&category=HIGHEST_OI')).ok, false); // live DH-905
  assert.equal(parseMoversRequest(q('mode=futures&category=HIGHEST_OI&expiry=2026-10-15')).ok, false);
  assert.equal(parseMoversRequest(q('mode=options&category=PRICE_GAINERS&expiry=2026-10-15')).ok, false);
  assert.equal(parseMoversRequest(q('mode=equity&universe=NIFTY_9000')).ok, false);
  assert.equal(parseMoversRequest(q('mode=crypto')).ok, false);
});

test('movers request: derivatives need a real YYYY-MM-DD expiry', () => {
  assert.equal(parseMoversRequest(q('mode=options&category=HIGHEST_OI')).ok, false); // upstream 400s without it
  assert.equal(parseMoversRequest(q('mode=options&category=HIGHEST_OI&expiry=2026-13-45')).ok, false);
  assert.equal(parseMoversRequest(q('mode=options&category=HIGHEST_OI&expiry=27-10-2026')).ok, false);
  const r = parseMoversRequest(q('mode=options&category=HIGHEST_OI&expiry=2026-10-15&limit=500'));
  assert.ok(r.ok);
  assert.deepEqual(r.value.instrument, ['OPTIDX', 'OPTSTK']);
  assert.equal(r.value.exchangeSegment, 'NSE_FNO');
  assert.equal(r.value.limit, 100);
  assert.equal(parseMoversRequest(q('mode=options&category=TOP_VOLUME&expiry=2026-10-15&instrument=FUTIDX')).ok, false); // no group mixing
});

test('normalizeMovers: option row from live payload', () => {
  const rows = normalizeMovers({ data: [{
    securityId: '55555', exchangeSegment: 'NSE_FNO', tradingSymbol: 'NIFTY-Oct2026-23500-CE', displayName: 'NIFTY 27 OCT 23500 CALL', instrument: 'OPTIDX',
    expiry: '2026-10-27', strikePrice: 23500.0, lotSize: 65, ltp: 14.3, change: -1, changePercent: -6.5, volume: 5842200, tradedValue: 1e9,
    underlyingLtp: 23100.5, openInterest: 8842730, openInterestChange: -158000, openInterestChangePercent: -1.76, putCallRatio: 0.5875758956792755,
  }] });
  assert.equal(rows[0].strike, 23500);
  assert.equal(rows[0].optionType, 'CE');
  assert.equal(rows[0].pcr, 0.5875758956792755);
  assert.equal(rows[0].oiChangePct, -1.76);
});

test('normalizeMovers: future strike -0.01 sentinel and equity 0 strike become null', () => {
  const [fut] = normalizeMovers({ data: [{ tradingSymbol: 'HDFCBANK-Oct2026-FUT', instrument: 'FUTSTK', strikePrice: -0.01, expiry: '2026-10-27', putCallRatio: 0.0, ltp: 704.85 }] });
  assert.equal(fut.strike, null);
  assert.equal(fut.optionType, null);
  assert.equal(fut.pcr, null);
  const [eq] = normalizeMovers({ data: [{ tradingSymbol: 'DRREDDY', instrument: 'EQUITY', strikePrice: 0.0, expiry: null, underlyingLtp: 1229.4, underlyingSecurityId: '0' }] });
  assert.equal(eq.strike, null);
  assert.equal(eq.expiry, null);
  assert.equal(normalizeMovers(null).length, 0);
  assert.equal(normalizeMovers({ data: 'oops' }).length, 0);
});

test('filterMinOi drops the thin-OI noise OI_GAINERS surfaces, preserving order', () => {
  const rows = normalizeMovers({ data: [
    { tradingSymbol: 'A-CE', instrument: 'OPTIDX', openInterest: 725 },
    { tradingSymbol: 'B-PE', instrument: 'OPTIDX', openInterest: 9360 },
    { tradingSymbol: 'C-PE', instrument: 'OPTIDX', openInterest: 13260 },
  ] });
  assert.deepEqual(filterMinOi(rows, 5000).map(r => r.symbol), ['B-PE', 'C-PE']);
  assert.equal(filterMinOi(rows, 0).length, 3);
});

test('moverExpiryMonths rolls over the year', () => {
  assert.deepEqual(moverExpiryMonths('2026-11-20'), [
    { label: 'Nov 2026', expiry: '2026-11-15' }, { label: 'Dec 2026', expiry: '2026-12-15' }, { label: 'Jan 2027', expiry: '2027-01-15' },
  ]);
});
