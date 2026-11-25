// Pure rules for the Index Scalper's market-watch windows (Top Indices, Top 10 Stocks).
//
// Both are watch-only and WebSocket-fed: live_indices_ws.py and live_equity_ws.py read the shared market_data_hub
// Dhan WebSocket and rewrite debug/live_indices_quotes.json / debug/live_equity_quotes.json every 2 s; the
// /api/index-scalper/market-watch/stream route pushes those files to the page over SSE when they change. No REST quote
// call is involved anywhere on this path.
//
// Relative imports only: node --test runs this file without the '@/' alias.

import { NIFTY_TOP10_BY_WEIGHT, type NiftyWeight } from './nifty50.ts';

/** A quote as the bridges write it. Every field may be missing on a partial packet. */
export interface RawQuote {
  ltp?: number;
  prev_close?: number;
  change?: number;
  change_pct?: number;
  high?: number;
  low?: number;
}

export interface WatchRow {
  key: string;
  name: string;
  /** null = no live price yet (rendered as a dash, never 0). */
  ltp: number | null;
  change: number | null;
  /** null when there is no genuine previous close: an unknown move is not a flat one. */
  changePct: number | null;
  high: number | null;
  low: number | null;
  /** Index weight (stocks only). */
  weight?: number;
}

/** The headline indices the hub carries (live_indices_ws.py's `quotes` block), in display order. */
export const WATCH_INDICES: { key: string; name: string }[] = [
  { key: 'NIFTY',     name: 'Nifty 50' },
  { key: 'BANKNIFTY', name: 'Bank Nifty' },
  { key: 'FINNIFTY',  name: 'Fin Nifty' },
  { key: 'IT',        name: 'Nifty IT' },
  { key: 'AUTO',      name: 'Nifty Auto' },
  { key: 'PHARMA',    name: 'Nifty Pharma' },
  { key: 'METAL',     name: 'Nifty Metal' },
  { key: 'REALTY',    name: 'Nifty Realty' },
  { key: 'VIX',       name: 'India VIX' },
];

const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

function toRow(key: string, name: string, q: RawQuote | undefined): WatchRow {
  const ltp = pos(q?.ltp);
  const prev = pos(q?.prev_close);
  const live = ltp !== null && prev !== null;
  return {
    key,
    name,
    ltp,
    change: live ? ltp - prev : null,
    changePct: live ? ((ltp - prev) / prev) * 100 : null,
    high: pos(q?.high),
    low: pos(q?.low),
  };
}

/** Index rows from the indices bridge's `quotes` block; an index the hub has not priced yet keeps its row with dashes. */
export function indexRows(quotes: Record<string, RawQuote> | null | undefined): WatchRow[] {
  return WATCH_INDICES.map(({ key, name }) => toRow(key, name, quotes?.[key]));
}

/** The top-10-by-weight stocks from the equity bridge's quotes (all 50 Nifty stocks). */
export function stockRows(
  quotes: Record<string, RawQuote> | null | undefined,
  list: NiftyWeight[] = NIFTY_TOP10_BY_WEIGHT,
): WatchRow[] {
  return list.map(w => ({ ...toRow(w.symbol, w.name, quotes?.[w.symbol]), weight: w.weight }));
}

/** Only the stocks a window shows, so the stream sends 10 quotes rather than 50. */
export function pickStockQuotes(
  quotes: Record<string, RawQuote> | null | undefined,
  list: NiftyWeight[] = NIFTY_TOP10_BY_WEIGHT,
): Record<string, RawQuote> {
  const out: Record<string, RawQuote> = {};
  for (const { symbol } of list) if (quotes?.[symbol]) out[symbol] = quotes[symbol];
  return out;
}

/**
 * The stocks' weighted pull on NIFTY in index points-of-percent: sum(weight% x change%) / 100.
 * null when no stock has a known move. `priced` says how many of the rows went into it.
 */
export function weightedPull(rows: WatchRow[]): { pct: number | null; priced: number } {
  let sum = 0;
  let priced = 0;
  for (const r of rows) {
    if (r.changePct === null || r.weight === undefined) continue;
    sum += (r.weight * r.changePct) / 100;
    priced += 1;
  }
  return { pct: priced ? sum : null, priced };
}

/** Mirrors lib/useLiveTickerPoll.ts STALE_MS: a feed this old is broken, not quiet. */
export const WATCH_STALE_MS = 15_000;

export type FeedState = 'LIVE' | 'STALE' | 'OFF';

/** LIVE while the bridge file is fresh, STALE once it stops moving, OFF before any data. */
export function feedState(updatedAt: string | null | undefined, now: number): { state: FeedState; ageMs: number } {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(t)) return { state: 'OFF', ageMs: Infinity };
  const ageMs = Math.max(0, now - t);
  return { state: ageMs > WATCH_STALE_MS ? 'STALE' : 'LIVE', ageMs };
}

export type WatchSortKey = 'name' | 'ltp' | 'changePct' | 'weight';

/** Sort rows; a row with no value for the column goes last in either direction ("unknown" is not 0). */
export function sortRows(rows: WatchRow[], key: WatchSortKey, dir: 'asc' | 'desc'): WatchRow[] {
  const mul = dir === 'asc' ? 1 : -1;
  const val = (r: WatchRow): number | string | null =>
    key === 'name' ? r.name : key === 'ltp' ? r.ltp : key === 'weight' ? (r.weight ?? null) : r.changePct;
  return [...rows].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string' && typeof bv === 'string') return mul * av.localeCompare(bv);
    return mul * ((av as number) - (bv as number));
  });
}
