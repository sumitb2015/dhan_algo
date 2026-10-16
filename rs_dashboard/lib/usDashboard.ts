// Pure aggregation for the US Markets dashboard (group breadth, movers) and the Yahoo index-level parser. No fetch, no fs,
// no `@/` imports, so `node --test` can load it. Routes: app/api/live-us/dashboard/ and app/api/live-us/indices/.
import type { UsQuoteRow } from './usStocks.ts';
import type { UsGroup } from './usUniverse.ts';

export interface DashRow extends UsQuoteRow {
  /** GICS sector group key, null for ETFs and index/macro proxies. */
  sector: string | null;
  /** AI theme group keys. */
  themes: string[];
  isEtf: boolean;
}

export interface MemberMove { symbol: string; pct: number }

/** A group of symbols with an optional benchmark (an ETF, or an index for the India page) - the input to groupStats. */
export interface StatGroup { key: string; label: string; kind: string; desc: string; etf?: string; symbols: readonly string[] }

export interface GroupStat {
  key: string; label: string; kind: string; desc: string;
  etf: string | null;
  /** The ETF's own % change, null when it has not quoted. */
  etfPct: number | null;
  symbols: readonly string[];
  /** Members with a computable % change. */
  quoted: number;
  adv: number; dec: number; unch: number;
  /** Equal-weight mean and median of member % change; null when no member has quoted. */
  avgPct: number | null;
  medianPct: number | null;
  best: MemberMove | null;
  worst: MemberMove | null;
}

export interface Breadth { total: number; quoted: number; adv: number; dec: number; unch: number }

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function countMoves(pcts: readonly number[]): { adv: number; dec: number; unch: number } {
  let adv = 0, dec = 0, unch = 0;
  for (const p of pcts) { if (p > 0) adv++; else if (p < 0) dec++; else unch++; }
  return { adv, dec, unch };
}

/** One stat block per group. A member that has not quoted is left out of every figure (counted in `symbols`, not in `quoted`). */
/** `benchBySymbol` resolves each group's benchmark (`etf`); it defaults to the member map, which holds the US ETFs too. */
export function groupStats(
  groups: readonly StatGroup[],
  rowBySymbol: ReadonlyMap<string, { changePct: number | null }>,
  benchBySymbol: ReadonlyMap<string, { changePct: number | null }> = rowBySymbol,
): GroupStat[] {
  return groups.map(g => {
    const moves: MemberMove[] = [];
    for (const s of g.symbols) {
      const p = rowBySymbol.get(s)?.changePct;
      if (p != null && Number.isFinite(p)) moves.push({ symbol: s, pct: p });
    }
    const pcts = moves.map(m => m.pct);
    const sorted = [...moves].sort((a, b) => b.pct - a.pct);
    return {
      key: g.key, label: g.label, kind: g.kind, desc: g.desc,
      etf: g.etf ?? null,
      etfPct: g.etf ? benchBySymbol.get(g.etf)?.changePct ?? null : null,
      symbols: g.symbols,
      quoted: moves.length,
      ...countMoves(pcts),
      avgPct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
      medianPct: median(pcts),
      best: sorted[0] ?? null,
      worst: sorted.length ? sorted[sorted.length - 1] : null,
    };
  });
}

/** Tags each row with its sector / themes / ETF flag. Rows are those the master resolved, in catalog order. */
export function tagRows(groups: readonly UsGroup[], rows: readonly UsQuoteRow[]): DashRow[] {
  const etfs = new Set<string>();
  for (const g of groups) { if (g.etf) etfs.add(g.etf); if (g.kind === 'index' || g.kind === 'macro') g.symbols.forEach(s => etfs.add(s)); }
  for (const g of groups) if (g.key === 'ai-etf') g.symbols.forEach(s => etfs.add(s));
  return rows.map(r => ({
    ...r,
    sector: groups.find(g => g.kind === 'sector' && g.symbols.includes(r.symbol))?.key ?? null,
    themes: groups.filter(g => g.kind === 'ai' && g.symbols.includes(r.symbol)).map(g => g.key),
    isEtf: etfs.has(r.symbol),
  }));
}

/** Top gainers / losers among single stocks (ETFs excluded). Only rows with a % change; a flat stock is in neither list. */
export function movers(rows: readonly DashRow[], n = 10): { gainers: DashRow[]; losers: DashRow[] } {
  const stocks = rows.filter(r => !r.isEtf && r.changePct != null);
  const gainers = stocks.filter(r => (r.changePct as number) > 0).sort((a, b) => (b.changePct as number) - (a.changePct as number)).slice(0, n);
  const losers = stocks.filter(r => (r.changePct as number) < 0).sort((a, b) => (a.changePct as number) - (b.changePct as number)).slice(0, n);
  return { gainers, losers };
}

/** Advance/decline over single stocks only, so a stock and the ETF holding it are not double-counted. */
export function universeBreadth(rows: readonly DashRow[]): Breadth {
  const stocks = rows.filter(r => !r.isEtf);
  const pcts = stocks.flatMap(r => (r.changePct != null ? [r.changePct] : []));
  return { total: stocks.length, quoted: pcts.length, ...countMoves(pcts) };
}

// ── Yahoo index levels ────────────────────────────────────────────────────────────────────────

export interface IndexLevel {
  symbol: string;
  name: string;
  price: number;
  /** The previous session's close, from the daily bars - NOT meta.chartPreviousClose, which is the close before the whole range. */
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  /** ms epoch of the last price. */
  marketTime: number | null;
  /** New York date (YYYY-MM-DD) of the last price. */
  tradingDate: string | null;
}

const nyDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const finitePos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

interface YahooChart {
  chart?: { result?: Array<{
    meta?: { regularMarketPrice?: number; regularMarketTime?: number; regularMarketDayHigh?: number; regularMarketDayLow?: number };
    timestamp?: number[];
    indicators?: { quote?: Array<{ close?: Array<number | null> }> };
  }> | null };
}

/** Parses a `v8/finance/chart?range=5d&interval=1d` response. The previous close is the last daily bar dated BEFORE the
 *  last price's New York date (today's bar, when present, is the live session). Returns null if there is no price. */
export function parseYahooChart(json: unknown, symbol: string, name: string): IndexLevel | null {
  const res = (json as YahooChart)?.chart?.result?.[0];
  const meta = res?.meta;
  const price = finitePos(meta?.regularMarketPrice);
  if (!res || price == null) return null;
  const t = typeof meta?.regularMarketTime === 'number' && meta.regularMarketTime > 0 ? meta.regularMarketTime * 1000 : null;
  const today = t != null ? nyDate(t) : null;
  const ts = res.timestamp ?? [];
  const closes = res.indicators?.quote?.[0]?.close ?? [];
  let prevClose: number | null = null;
  for (let i = Math.min(ts.length, closes.length) - 1; i >= 0; i--) {
    const c = finitePos(closes[i]);
    if (c == null) continue;
    if (today != null && nyDate(ts[i] * 1000) >= today) continue;   // the live session's own bar
    prevClose = c;
    break;
  }
  return {
    symbol, name, price, prevClose,
    change: prevClose != null ? price - prevClose : null,
    changePct: prevClose != null ? ((price - prevClose) / prevClose) * 100 : null,
    dayHigh: finitePos(meta?.regularMarketDayHigh), dayLow: finitePos(meta?.regularMarketDayLow),
    marketTime: t, tradingDate: today,
  };
}
