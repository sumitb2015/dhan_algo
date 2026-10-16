// Pure logic for the India Markets dashboard (/india-markets): the Nifty 500 universe from the Daily Market bridge
// (scripts/tools/daily_market_ws.py -> debug/daily_market_quotes.json), broad + sectoral NSE indices from
// scripts/tools/live_indices_ws.py (-> debug/live_indices_quotes.json `indices`), and NSE's official constituent lists
// (index_constituents/). No fetch, no fs, no `@/` imports, so `node --test` can load it. Route: app/api/india-markets/.
import { groupStats, type Breadth, type GroupStat, type StatGroup } from './usDashboard.ts';

/** One Nifty 500 stock, null (never 0) for anything the feed has not sent. */
export interface IndiaRow {
  id: string;
  symbol: string;
  name: string;
  /** NSE's industry classification from ind_nifty500list.csv (20 groups). */
  industry: string | null;
  ltp: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  vwap: number | null;
  volume: number | null;
  turnoverCr: number | null;
  high52: number | null;
  low52: number | null;
  /** 0..1 position of the last price in the 52-week range. */
  wk52Pos: number | null;
}

export interface RawDailyQuote {
  symbol?: string; company?: string; industry?: string;
  /** daily_market_ws.py: 'tick' live, 'eod' today's CSV close, 'none' = no price today (LTP is just the previous close). */
  source?: 'tick' | 'eod' | 'none';
  ltp?: number; prev_close?: number; open?: number; high?: number; low?: number; vwap?: number;
  volume?: number; turnover_cr?: number; high_52w?: number; low_52w?: number;
}

export interface RawIndexQuote {
  label?: string; category?: string; ltp?: number; prev_close?: number | null; change?: number | null; change_pct?: number | null;
  high?: number | null; low?: number | null;
}

/** Symbol + industry + company per row of an NSE constituent CSV ("Company Name,Industry,Symbol,Series,ISIN Code").
 *  Same rule as dataLoader.ts's parseConstituentSymbols (kept here because dataLoader cannot load under `node --test`): columns after the company are read from the END of the row, so an unquoted comma
 *  in a company name cannot shift them; the company is whatever comes before. */
export function parseConstituentRows(content: string): Array<{ symbol: string; industry: string; company: string }> {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(h => h.trim().toUpperCase());
  const iSym = header.indexOf('SYMBOL'), iInd = header.indexOf('INDUSTRY');
  if (iSym < 0) return [];
  const symFromEnd = header.length - iSym;
  const indFromEnd = iInd >= 0 ? header.length - iInd : 0;
  const out: Array<{ symbol: string; industry: string; company: string }> = [];
  for (const line of lines.slice(1)) {
    const vals = line.split(',');
    const sym = (vals[vals.length - symFromEnd] ?? '').trim();
    if (!/^[A-Z0-9][A-Z0-9&-]*$/.test(sym) || sym.startsWith('DUMMY')) continue;
    const industry = indFromEnd ? (vals[vals.length - indFromEnd] ?? '').trim() : '';
    const company = vals.slice(0, vals.length - (indFromEnd || symFromEnd)).join(',').trim();
    out.push({ symbol: sym, industry, company });
  }
  return out;
}

const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Change is recomputed from LTP and the previous close rather than trusting a stored 0. A `source: 'none'` row has no
 *  price for today at all (the bridge copied the previous close into LTP), so it is "no quote", not a 0% move.
 *  `industry` / `company` from NSE's Nifty 500 list win over the bridge's (whose fallback industry is "General"). */
export function buildIndiaRow(symbol: string, q: RawDailyQuote | undefined, industry: string | null, company?: string): IndiaRow {
  const priced = q?.source !== 'none';
  const ltp = priced ? pos(q?.ltp) : null;
  const prev = pos(q?.prev_close), hi = pos(q?.high_52w), lo = pos(q?.low_52w);
  if (!priced) q = { ...q, open: undefined, high: undefined, low: undefined, vwap: undefined };
  return {
    id: symbol, symbol,
    name: (company || q?.company || symbol).trim(),
    industry: industry || q?.industry?.trim() || null,
    ltp, prevClose: prev,
    change: ltp != null && prev != null ? ltp - prev : null,
    changePct: ltp != null && prev != null ? ((ltp - prev) / prev) * 100 : null,
    open: pos(q?.open), high: pos(q?.high), low: pos(q?.low), vwap: pos(q?.vwap),
    volume: typeof q?.volume === 'number' && q.volume >= 0 && ltp != null ? q.volume : null,
    turnoverCr: typeof q?.turnover_cr === 'number' && q.turnover_cr >= 0 && ltp != null ? q.turnover_cr : null,
    high52: hi, low52: lo,
    wk52Pos: ltp != null && hi != null && lo != null && hi > lo ? Math.min(1, Math.max(0, (ltp - lo) / (hi - lo))) : null,
  };
}

// ── index catalogue ───────────────────────────────────────────────────────────────────────────

/** Index symbol (as live_indices_ws.py's INDEX_CATALOGUE) -> constituent list key in index_constituents/manifest.json.
 *  `all` = the whole Nifty 500. NIFTY PVT BANK has no NSE archive CSV (404 on 2026-10-16), so it is derived as
 *  Nifty Bank minus Nifty PSU Bank and labelled as such. MIDCPNIFTY (Midcap Select) has no list: the index shows, no drill-down. */
export interface IndexDef { symbol: string; label: string; kind: 'broad' | 'sector' | 'vix'; members: string | 'all' | { minus: [string, string] } | null; note?: string }

export const INDIA_INDICES: IndexDef[] = [
  { symbol: 'NIFTY', label: 'Nifty 50', kind: 'broad', members: 'nifty50' },
  { symbol: 'NIFTYNXT50', label: 'Nifty Next 50', kind: 'broad', members: 'niftynext50' },
  { symbol: 'NIFTY 100', label: 'Nifty 100', kind: 'broad', members: 'nifty100' },
  { symbol: 'NIFTY 200', label: 'Nifty 200', kind: 'broad', members: 'nifty200' },
  { symbol: 'NIFTY 500', label: 'Nifty 500', kind: 'broad', members: 'all' },
  { symbol: 'NIFTY MIDCAP 150', label: 'Midcap 150', kind: 'broad', members: 'niftymidcap150' },
  { symbol: 'NIFTY SMALLCAP 100', label: 'Smallcap 100', kind: 'broad', members: 'niftysmallcap100' },
  { symbol: 'MIDCPNIFTY', label: 'Midcap Select', kind: 'broad', members: null },
  { symbol: 'INDIA VIX', label: 'India VIX', kind: 'vix', members: null },

  { symbol: 'BANKNIFTY', label: 'Bank', kind: 'sector', members: 'niftybank' },
  { symbol: 'NIFTY PVT BANK', label: 'Private Bank', kind: 'sector', members: { minus: ['niftybank', 'niftypsubank'] }, note: 'Members approximated as Nifty Bank minus PSU Bank (NSE publishes no list file)' },
  { symbol: 'NIFTY PSU BANK', label: 'PSU Bank', kind: 'sector', members: 'niftypsubank' },
  { symbol: 'FINNIFTY', label: 'Financial Services', kind: 'sector', members: 'niftyfinance' },
  { symbol: 'NIFTY FINSRV25 50', label: 'Fin Services 25/50', kind: 'sector', members: 'niftyfinsrv2550' },
  { symbol: 'NIFTYIT', label: 'IT', kind: 'sector', members: 'niftyit' },
  { symbol: 'NIFTY AUTO', label: 'Auto', kind: 'sector', members: 'niftyauto' },
  { symbol: 'NIFTY PHARMA', label: 'Pharma', kind: 'sector', members: 'niftypharma' },
  { symbol: 'NIFTY HEALTHCARE', label: 'Healthcare', kind: 'sector', members: 'niftyhealthcare' },
  { symbol: 'NIFTY FMCG', label: 'FMCG', kind: 'sector', members: 'niftyfmcg' },
  { symbol: 'NIFTY METAL', label: 'Metal', kind: 'sector', members: 'niftymetal' },
  { symbol: 'NIFTY ENERGY', label: 'Energy', kind: 'sector', members: 'niftyenergy' },
  { symbol: 'NIFTY OIL AND GAS', label: 'Oil & Gas', kind: 'sector', members: 'niftyoilgas' },
  { symbol: 'NIFTY REALTY', label: 'Realty', kind: 'sector', members: 'niftyrealty' },
  { symbol: 'NIFTYINFRA', label: 'Infrastructure', kind: 'sector', members: 'niftyinfra' },
  { symbol: 'NIFTY MEDIA', label: 'Media', kind: 'sector', members: 'niftymedia' },
  { symbol: 'NIFTY CONSR DURBL', label: 'Consumer Durables', kind: 'sector', members: 'niftyconsumerdurables' },
];

/** Resolves an index's member list from the constituent lists (each already restricted to the Nifty 500). */
export function resolveMembers(def: IndexDef, lists: ReadonlyMap<string, readonly string[]>, universe: readonly string[]): string[] {
  const m = def.members;
  if (m == null) return [];
  if (m === 'all') return [...universe];
  if (typeof m === 'string') return [...(lists.get(m) ?? [])];
  const drop = new Set(lists.get(m.minus[1]) ?? []);
  return (lists.get(m.minus[0]) ?? []).filter(s => !drop.has(s));
}

export interface IndexCard {
  symbol: string; label: string; kind: IndexDef['kind'];
  ltp: number | null; prevClose: number | null; change: number | null; changePct: number | null; high: number | null; low: number | null;
}

export function buildIndexCard(def: IndexDef, q: RawIndexQuote | undefined): IndexCard {
  const ltp = pos(q?.ltp), prev = pos(q?.prev_close);
  return {
    symbol: def.symbol, label: def.label, kind: def.kind,
    ltp, prevClose: prev,
    change: ltp != null && prev != null ? ltp - prev : null,
    changePct: ltp != null && prev != null ? ((ltp - prev) / prev) * 100 : null,
    high: pos(q?.high), low: pos(q?.low),
  };
}

/** Sort key for a stat block: its benchmark move, else its member median. */
const headPct = (g: GroupStat) => g.etfPct ?? g.medianPct;

export interface IndiaDashboard {
  indices: IndexCard[];
  broad: GroupStat[];
  sectors: GroupStat[];
  industries: GroupStat[];
  breadth: Breadth;
  gainers: IndiaRow[];
  losers: IndiaRow[];
  /** Turnover leaders (₹ Cr), the "where the money is" list. */
  active: IndiaRow[];
}

/** Everything the page shows. Sector and broad groups carry their index as the benchmark (`etf` = index symbol), so a tile
 *  shows the index's own move next to the median of its constituents. Industries are NSE's own Nifty 500 classification. */
export function buildIndiaDashboard(
  rows: readonly IndiaRow[],
  indexQuotes: Readonly<Record<string, RawIndexQuote>>,
  lists: ReadonlyMap<string, readonly string[]>,
  n = 10,
): IndiaDashboard {
  const universe = rows.map(r => r.symbol);
  const cards = INDIA_INDICES.map(d => buildIndexCard(d, indexQuotes[d.symbol]));
  // Members and benchmarks are looked up in separate maps, so an index symbol can never shadow a stock ticker.
  const pctMap = new Map<string, { changePct: number | null }>(rows.map(r => [r.symbol, r]));
  const benchMap = new Map<string, { changePct: number | null }>(cards.map(c => [c.symbol, c]));

  const groupFor = (d: IndexDef): StatGroup => ({
    key: d.symbol, label: d.label, kind: d.kind, desc: d.note ?? `${d.label} constituents in the Nifty 500`, etf: d.symbol,
    symbols: resolveMembers(d, lists, universe),
  });
  const broad = groupStats(INDIA_INDICES.filter(d => d.kind === 'broad').map(groupFor), pctMap, benchMap);
  // Sorted on the index's own move; a sector whose index has no move yet sorts after every one that has, by its median.
  const sectors = groupStats(INDIA_INDICES.filter(d => d.kind === 'sector').map(groupFor), pctMap, benchMap)
    .sort((a, b) => (a.etfPct == null ? 1 : 0) - (b.etfPct == null ? 1 : 0) || (headPct(b) ?? -Infinity) - (headPct(a) ?? -Infinity));

  const byIndustry = new Map<string, string[]>();
  for (const r of rows) {
    const k = r.industry ?? 'Unclassified';
    (byIndustry.get(k) ?? byIndustry.set(k, []).get(k)!).push(r.symbol);
  }
  const industries = groupStats([...byIndustry.entries()].map(([k, symbols]) => ({
    key: `ind:${k}`, label: k, kind: 'industry', desc: `NSE industry · ${symbols.length} Nifty 500 stocks`, symbols,
  })), pctMap).sort((a, b) => (b.medianPct ?? -Infinity) - (a.medianPct ?? -Infinity));

  const quoted = rows.filter(r => r.changePct != null);
  const pcts = quoted.map(r => r.changePct as number);
  const breadth: Breadth = {
    total: rows.length, quoted: quoted.length,
    adv: pcts.filter(p => p > 0).length, dec: pcts.filter(p => p < 0).length, unch: pcts.filter(p => p === 0).length,
  };
  const gainers = quoted.filter(r => (r.changePct as number) > 0).sort((a, b) => (b.changePct as number) - (a.changePct as number)).slice(0, n);
  const losers = quoted.filter(r => (r.changePct as number) < 0).sort((a, b) => (a.changePct as number) - (b.changePct as number)).slice(0, n);
  const active = rows.filter(r => r.turnoverCr != null).sort((a, b) => (b.turnoverCr as number) - (a.turnoverCr as number)).slice(0, n);
  return { indices: cards, broad, sectors, industries, breadth, gainers, losers, active };
}

