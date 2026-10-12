// Pure helpers for Dhan's Market Analytics Data APIs (/data/newsheadline, /data/companyinfo,
// /data/marketmovers): request validation against the documented enums and response normalisation.
// No fetch, no fs, no `@/` imports - so `node --test` can load it. The network side is
// lib/dhanAnalyticsServer.ts.
//
// Facts below were observed against the live API on 2026-10-12, not just read from the docs:
//   - companyinfo returns JSON numbers/null although the docs say String;
//   - futures rows carry strikePrice -0.01 (a sentinel, not a strike);
//   - NSE_FNO `expiry` is month-granular - any date in a month ranks that month's MONTHLY series,
//     weeklies are never returned;
//   - news `nseScripCode` / `bseScripCode` are the NSE / BSE SECURITY_IDs.

export const NEWS_CATEGORIES = [
  'ALL', 'COMPANIES', 'EQUITY_MARKETS', 'DEBT_MARKETS', 'IPO', 'GLOBAL', 'INDIAN_ECONOMY',
  'GLOBAL_ECONOMY', 'CURRENCY', 'COMMODITIES', 'CRYPTOCURRENCIES',
  'GOVERNMENT_POLICY_AND_REGULATION', 'INFRASTRUCTURE', 'INTERNATIONAL_TRADE',
  'INVESTMENT_IDEAS', 'REAL_ESTATE', 'STARTUPS', 'TECHNOLOGY', 'MUTUAL_FUNDS',
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const NEWS_UNIVERSES = ['PORTFOLIO', 'WATCHLIST'] as const;
export type NewsUniverse = (typeof NEWS_UNIVERSES)[number];

export const NEWS_MAX_LIMIT = 50;

export const MOVER_UNIVERSES = [
  'ALL', 'FNO_STOCKS', 'NIFTY_50', 'NIFTY_BANK', 'FINNIFTY', 'INDIA_VIX', 'NIFTY_MIDCAP',
  'NIFTY_NEXT_50', 'NIFTY_SMALLCAP_50', 'NIFTY_MIDCAP_50', 'NIFTY_100', 'NIFTY_200', 'NIFTY_500',
  'NIFTY_MIDCAP_100', 'NIFTY_MIDCAP_150', 'NIFTY_SMALLCAP_100', 'NIFTY_SMALLCAP_250',
  'NIFTY_MICROCAP_250', 'NIFTY_AUTO', 'NIFTY_PRIVATE_BANK', 'NIFTY_FMCG', 'NIFTY_ENERGY',
  'NIFTY_INFRA', 'NIFTY_IT', 'NIFTY_MEDIA', 'NIFTY_METAL', 'NIFTY_MNC', 'NIFTY_PHARMA',
  'NIFTY_PSU_BANK', 'NIFTY_REALTY', 'NIFTY_SERVICES_SECTOR', 'NIFTY_CONSUMPTION', 'GIFT_NIFTY',
] as const;
export type MoverUniverse = (typeof MOVER_UNIVERSES)[number];

export const MOVER_MODES = ['equity', 'options', 'futures'] as const;
export type MoverMode = (typeof MOVER_MODES)[number];

/** Categories the API accepts per mode (annexure "Ranking Category"; EQUITY + HIGHEST_OI was
 *  confirmed to 400 with DH-905). */
export const MOVER_CATEGORIES: Record<MoverMode, readonly string[]> = {
  equity: ['PRICE_GAINERS', 'PRICE_LOSERS'],
  options: ['HIGHEST_OI', 'OI_GAINERS', 'OI_LOSERS', 'TOP_VOLUME'],
  futures: ['OI_GAINERS', 'OI_LOSERS', 'TOP_VOLUME'],
};

/** Instrument types per mode. The API forbids mixing groups inside one request. */
export const MOVER_INSTRUMENTS: Record<MoverMode, readonly string[]> = {
  equity: ['EQUITY'],
  options: ['OPTIDX', 'OPTSTK'],
  futures: ['FUTIDX', 'FUTSTK'],
};

export const MOVER_MAX_LIMIT = 100;

export const COMPANY_METRICS = ['CO', 'RATIOS', 'SHP'] as const;
export type CompanyMetric = (typeof COMPANY_METRICS)[number];

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function includes<T extends string>(list: readonly T[], v: string): v is T {
  return (list as readonly string[]).includes(v);
}

function clampInt(raw: string | null | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ── News ──────────────────────────────────────────────────────────────────────

export interface NewsRequest {
  categories: NewsCategory[];
  limit: number;
  universe?: NewsUniverse;
  stockList: string[];
}

/** `categories` comma list (default ALL), `limit` 1-50 (default 30), `universe`, `stocks` comma list
 *  of numeric security ids. Unknown values are rejected rather than forwarded, because the
 *  upstream error for a bad enum is opaque. */
export function parseNewsRequest(params: URLSearchParams): Result<NewsRequest> {
  const rawCats = (params.get('categories') ?? 'ALL').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const categories: NewsCategory[] = [];
  for (const c of rawCats) {
    if (!includes(NEWS_CATEGORIES, c)) return { ok: false, error: `Unknown news category "${c}"` };
    if (!categories.includes(c)) categories.push(c);
  }
  if (categories.length === 0) categories.push('ALL');

  const rawUniverse = params.get('universe');
  let universe: NewsUniverse | undefined;
  if (rawUniverse) {
    const u = rawUniverse.toUpperCase();
    if (!includes(NEWS_UNIVERSES, u)) return { ok: false, error: `Unknown news universe "${rawUniverse}"` };
    universe = u;
  }

  const stockList = (params.get('stocks') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (stockList.some(s => !/^\d{1,9}$/.test(s))) return { ok: false, error: 'stocks must be numeric security ids' };
  if (stockList.length > 50) return { ok: false, error: 'At most 50 stocks per request' };

  return { ok: true, value: { categories, limit: clampInt(params.get('limit'), 30, 1, NEWS_MAX_LIMIT), universe, stockList } };
}

export interface NewsItem {
  title: string;
  text: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  category: string;
  subCategory: string;
  /** YYYY-MM-DD. Dhan sends a date only - there is no publish time, so ordering within a day is the
   *  upstream order and must not be re-sorted. */
  publishDate: string;
  stockName: string;
  symbol: string;
  isin: string;
  nseSecurityId: string | null;
  bseSecurityId: string | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Dhan sends `0`/missing for "no scrip code" on non-company news. */
function scripId(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number.parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

function sentimentOf(v: unknown): NewsItem['sentiment'] {
  const s = str(v).toLowerCase();
  return s === 'positive' || s === 'negative' ? s : 'neutral';
}

/** Flattens `data.latestNews` (and `nextNews` when present, appended after) into NewsItem[]. Items
 *  without a title are dropped; nothing is re-sorted. */
export function normalizeNews(raw: unknown): NewsItem[] {
  const data = (raw as { data?: { latestNews?: unknown; nextNews?: unknown } } | null)?.data;
  const buckets = [data?.latestNews, data?.nextNews].filter(Array.isArray) as Array<Record<string, unknown>[]>;
  const out: NewsItem[] = [];
  for (const bucket of buckets) {
    for (const item of bucket) {
      const obj = (item.newsObject ?? {}) as Record<string, unknown>;
      const title = str(obj.title).trim();
      if (!title) continue;
      out.push({
        title,
        text: str(obj.text).trim(),
        sentiment: sentimentOf(obj.overallSentiment),
        category: str(item.category),
        subCategory: str(item.subCategory),
        publishDate: str(item.publishDate),
        stockName: str(item.displaySymbol) || str(item.stockName),
        symbol: str(item.smSymbol),
        isin: str(item.isinCode),
        nseSecurityId: scripId(item.nseScripCode),
        bseSecurityId: scripId(item.bseScripCode),
      });
    }
  }
  return out;
}

// ── Company info ──────────────────────────────────────────────────────────────

export interface CompanyInfoRequest {
  securityId: string;
  exchangeSegment: 'NSE_EQ' | 'BSE_EQ';
  metrics: CompanyMetric[];
}

export function parseCompanyInfoRequest(params: URLSearchParams): Result<CompanyInfoRequest> {
  const securityId = (params.get('securityId') ?? '').trim();
  if (!/^\d{1,9}$/.test(securityId)) return { ok: false, error: 'securityId must be a numeric security id' };
  const seg = (params.get('exchangeSegment') ?? 'NSE_EQ').toUpperCase();
  if (seg !== 'NSE_EQ' && seg !== 'BSE_EQ') return { ok: false, error: 'exchangeSegment must be NSE_EQ or BSE_EQ' };
  const rawMetrics = (params.get('metrics') ?? COMPANY_METRICS.join(',')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const metrics: CompanyMetric[] = [];
  for (const m of rawMetrics) {
    if (!includes(COMPANY_METRICS, m)) return { ok: false, error: `Unknown metric "${m}"` };
    if (!metrics.includes(m)) metrics.push(m);
  }
  if (metrics.length === 0) return { ok: false, error: 'metrics must not be empty' };
  return { ok: true, value: { securityId, exchangeSegment: seg, metrics } };
}

/** The docs type every metric as String; the live API sends numbers or null. Accept both, and map
 *  anything non-finite to null so the UI shows "-" rather than NaN or a misleading 0. */
export function metricNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface CompanyInfo {
  securityId: string;
  overview: {
    marketCapCr: number | null; industry: string; sector: string; dividendYield: number | null;
    eps: number | null; ebitdaCr: number | null; bookValue: number | null;
    high52w: number | null; low52w: number | null;
  } | null;
  ratios: {
    pe: number | null; pb: number | null; debtToEquity: number | null; peToSectorPe: number | null;
    roe: number | null; roce: number | null; industryEps: number | null; industryDebtToEquity: number | null;
    industryPb: number | null; industryCurrentRatio: number | null; industryDividendYield: number | null;
    industryOperatingMargin: number | null;
  } | null;
  shareholding: {
    /** YYYYMM or null. */
    reportingPeriod: string | null;
    promoter: number | null; dii: number | null; diiChange: number | null;
    fii: number | null; fiiChange: number | null; publicHolding: number | null;
  } | null;
}

/** `null` for a section means "not requested / not returned" - distinct from a section whose fields
 *  are all null. Returns null when nothing at all came back (unknown security, vendor gap). */
export function normalizeCompanyInfo(raw: unknown, securityId: string): CompanyInfo | null {
  const data = (raw as { data?: Record<string, Record<string, unknown> | undefined> } | null)?.data;
  if (!data || typeof data !== 'object') return null;
  const co = data.CO, ra = data.RATIOS, sh = data.SHP;
  if (!co && !ra && !sh) return null;
  return {
    securityId,
    overview: co ? {
      marketCapCr: metricNumber(co.MARKET_CAP), industry: str(co.INDUSTRY), sector: str(co.SECTOR),
      dividendYield: metricNumber(co.DIVIDEND_YIELD), eps: metricNumber(co.EPS), ebitdaCr: metricNumber(co.EBITDA),
      bookValue: metricNumber(co.BOOK_VALUE), high52w: metricNumber(co.FIFTY_TWO_WEEK_HIGH), low52w: metricNumber(co.FIFTY_TWO_WEEK_LOW),
    } : null,
    ratios: ra ? {
      pe: metricNumber(ra.PE_RATIO), pb: metricNumber(ra.PB_RATIO), debtToEquity: metricNumber(ra.DEBT_TO_EQUITY),
      peToSectorPe: metricNumber(ra.PE_TO_SECTOR_PE), roe: metricNumber(ra.ROE), roce: metricNumber(ra.ROCE),
      industryEps: metricNumber(ra.INDUSTRY_EPS), industryDebtToEquity: metricNumber(ra.INDUSTRY_DEBT_TO_EQUITY),
      industryPb: metricNumber(ra.INDUSTRY_PB_RATIO), industryCurrentRatio: metricNumber(ra.INDUSTRY_CURRENT_RATIO),
      industryDividendYield: metricNumber(ra.INDUSTRY_DIVIDEND_YIELD), industryOperatingMargin: metricNumber(ra.INDUSTRY_OPERATING_MARGIN),
    } : null,
    shareholding: sh ? {
      reportingPeriod: str(sh.REPORTING_PERIOD) || null,
      promoter: metricNumber(sh.PROMOTER_HOLDING), dii: metricNumber(sh.DII_HOLDING), diiChange: metricNumber(sh.CHANGE_IN_DII_HOLDING),
      fii: metricNumber(sh.FII_HOLDING), fiiChange: metricNumber(sh.CHANGE_IN_FII_HOLDING), publicHolding: metricNumber(sh.PUBLIC_HOLDING),
    } : null,
  };
}

// ── Market movers ─────────────────────────────────────────────────────────────

export interface MoversRequest {
  mode: MoverMode;
  exchangeSegment: 'NSE_EQ' | 'NSE_FNO';
  instrument: string[];
  category: string;
  universe?: MoverUniverse;
  /** YYYY-MM-DD, derivatives only. */
  expiry?: string;
  limit: number;
}

export function parseMoversRequest(params: URLSearchParams): Result<MoversRequest> {
  const mode = (params.get('mode') ?? 'equity').toLowerCase();
  if (!includes(MOVER_MODES, mode)) return { ok: false, error: `mode must be one of ${MOVER_MODES.join(', ')}` };

  const category = (params.get('category') ?? MOVER_CATEGORIES[mode][0]).toUpperCase();
  if (!MOVER_CATEGORIES[mode].includes(category)) {
    return { ok: false, error: `category ${category} is not supported for ${mode}; use ${MOVER_CATEGORIES[mode].join(', ')}` };
  }

  const limit = clampInt(params.get('limit'), 20, 1, MOVER_MAX_LIMIT);

  if (mode === 'equity') {
    const rawUniverse = (params.get('universe') ?? 'NIFTY_500').toUpperCase();
    if (!includes(MOVER_UNIVERSES, rawUniverse)) return { ok: false, error: `Unknown universe "${rawUniverse}"` };
    return { ok: true, value: { mode, exchangeSegment: 'NSE_EQ', instrument: [...MOVER_INSTRUMENTS.equity], category, universe: rawUniverse, limit } };
  }

  const expiry = (params.get('expiry') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))) {
    return { ok: false, error: 'expiry (YYYY-MM-DD) is required for options and futures' };
  }
  const only = (params.get('instrument') ?? '').toUpperCase();
  const instrument = only ? [only] : [...MOVER_INSTRUMENTS[mode]];
  if (instrument.some(i => !MOVER_INSTRUMENTS[mode].includes(i))) {
    return { ok: false, error: `instrument must be within ${MOVER_INSTRUMENTS[mode].join(', ')} for ${mode}` };
  }
  return { ok: true, value: { mode, exchangeSegment: 'NSE_FNO', instrument, category, expiry, limit } };
}

export interface MoverRow {
  securityId: string;
  symbol: string;
  name: string;
  instrument: string;
  expiry: string | null;
  /** null for futures and equities (Dhan sends 0 or -0.01 there). */
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  lotSize: number;
  ltp: number;
  change: number;
  changePct: number;
  volume: number;
  tradedValue: number;
  openInterest: number;
  oiChange: number;
  oiChangePct: number;
  /** Underlying's last price - for derivatives. */
  underlyingLtp: number | null;
  /** Series-level PCR Dhan attaches to option rows; null elsewhere. */
  pcr: number | null;
}

function fin(v: unknown, def = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Options trade symbols end in -CE / -PE ("NIFTY-Oct2026-23500-CE"). */
function optionTypeOf(symbol: string, instrument: string): 'CE' | 'PE' | null {
  if (!instrument.startsWith('OPT')) return null;
  const tail = symbol.slice(-2).toUpperCase();
  return tail === 'CE' || tail === 'PE' ? tail : null;
}

export function normalizeMovers(raw: unknown): MoverRow[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map(d => {
    const instrument = str(d.instrument);
    const symbol = str(d.tradingSymbol);
    const strikeRaw = fin(d.strikePrice, 0);
    const isOption = instrument.startsWith('OPT');
    const pcr = d.putCallRatio == null ? null : fin(d.putCallRatio, NaN);
    const underlying = fin(d.underlyingLtp, 0);
    return {
      securityId: str(d.securityId),
      symbol,
      name: str(d.displayName) || symbol,
      instrument,
      expiry: d.expiry ? str(d.expiry) : null,
      strike: isOption && strikeRaw > 0 ? strikeRaw : null,
      optionType: optionTypeOf(symbol, instrument),
      lotSize: fin(d.lotSize, 1),
      ltp: fin(d.ltp),
      change: fin(d.change),
      changePct: fin(d.changePercent),
      volume: fin(d.volume),
      tradedValue: fin(d.tradedValue),
      openInterest: fin(d.openInterest),
      oiChange: fin(d.openInterestChange),
      oiChangePct: fin(d.openInterestChangePercent),
      underlyingLtp: underlying > 0 ? underlying : null,
      pcr: isOption && pcr != null && Number.isFinite(pcr) ? pcr : null,
    };
  });
}

/** Dhan's OI_GAINERS ranks by % change, so a contract that went 200 -> 725 OI tops the list. Lets the
 *  UI drop that noise by an absolute-OI floor without hiding the server's ordering. */
export function filterMinOi(rows: MoverRow[], minOi: number): MoverRow[] {
  return minOi > 0 ? rows.filter(r => r.openInterest >= minOi) : rows;
}

/** Month key (YYYY-MM) for a month-granular NSE_FNO expiry selection. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** The month choices for the F&O movers picker: the current month and the next two, derived from the
 *  IST date, each sent as the 15th (any date in the month selects the monthly series). */
export function moverExpiryMonths(todayIso: string, count = 3): { label: string; expiry: string }[] {
  const [y, m] = todayIso.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const out: { label: string; expiry: string }[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (m - 1) + i;
    const yy = y + Math.floor(idx / 12);
    const mm = (idx % 12) + 1;
    out.push({ label: `${names[mm - 1]} ${yy}`, expiry: `${yy}-${String(mm).padStart(2, '0')}-15` });
  }
  return out;
}
