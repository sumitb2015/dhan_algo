// Pure helpers for the US Markets page (Dhan Global Stocks live feed): the US scrip-master CSV, symbol
// search, watchlist validation and the quote view-model. No fetch, no fs, no `@/` imports, so
// `node --test` can load it. The bridge is scripts/tools/live_us_ws.py; the route is app/api/live-us/.
//
// Observed against the live feed on 2026-10-12 (mid US session):
//   - the OHLC packet's "Close" equals the PREVIOUS close, so day change is computed from the
//     Previous Close packet, never from OHLC close;
//   - `ltt` runs 19,800 s (5 h 30 m) ahead of `lut` - an IST-shifted epoch. `lut` is a true UTC epoch,
//     so freshness is judged on `lut` and on the bridge's own `updated_at`.

export const US_WATCHLIST_MAX = 100;

export interface UsInstrument {
  /** Dhan SCRIP_CODE - the securityId the feed and the orders API use. */
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  tick: number;
  fractional: boolean;
}

/** RFC-4180 style splitter: quoted fields, doubled quotes and commas inside quotes (8 company names in the
 *  real file contain a comma). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parses Dhan's us-stock-scrip-master.csv. Rows that are not cash equities/ETFs with a numeric id and a
 *  symbol are dropped. Header lookup is by name so a column reorder cannot silently shift the fields. */
export function parseUsScripMaster(csv: string): UsInstrument[] {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = splitCsvLine(lines[0]).map(h => h.trim().toUpperCase());
  const col = (n: string) => head.indexOf(n);
  const iId = col('SCRIP_CODE'), iSym = col('SYMBOL'), iName = col('CUSTOM_SYMBOL'), iLong = col('SYMBOL_NAME');
  const iEx = col('CUSTOM_EXCH'), iTick = col('TICK_SIZE'), iFrac = col('FRACTION'), iInst = col('INSTRUMENT_NAME');
  if (iId < 0 || iSym < 0) return [];
  const out: UsInstrument[] = [];
  for (let n = 1; n < lines.length; n++) {
    if (!lines[n]) continue;
    const f = splitCsvLine(lines[n]);
    const id = (f[iId] ?? '').trim();
    const symbol = (f[iSym] ?? '').trim();
    if (!/^\d{1,9}$/.test(id) || !symbol) continue;
    if (iInst >= 0 && (f[iInst] ?? '').trim().toUpperCase() !== 'EQUITY') continue;
    const tick = Number(f[iTick]);
    out.push({
      id, symbol,
      name: ((iName >= 0 ? f[iName] : '') || (iLong >= 0 ? f[iLong] : '') || symbol).trim(),
      exchange: (f[iEx] ?? '').trim(),
      tick: Number.isFinite(tick) && tick > 0 ? tick : 0.01,
      fractional: (f[iFrac] ?? '').trim().toLowerCase() === 'true',
    });
  }
  return out;
}

/** Ranked search over symbol and name: exact symbol, then symbol prefix, then name prefix, then name word,
 *  then substring. Stable within a rank (list order). Empty query returns nothing. */
export function searchUs(list: readonly UsInstrument[], query: string, limit = 15): UsInstrument[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ r: number; i: UsInstrument }> = [];
  for (const i of list) {
    const s = i.symbol.toLowerCase();
    const nm = i.name.toLowerCase();
    let r = 99;
    if (s === q) r = 0;
    else if (s.startsWith(q)) r = 1;
    else if (nm.startsWith(q)) r = 2;
    else if (nm.split(/[\s.,&-]+/).some(w => w.startsWith(q))) r = 3;
    else if (s.includes(q) || nm.includes(q)) r = 4;
    if (r < 99) scored.push({ r, i });
  }
  scored.sort((a, b) => a.r - b.r || a.i.symbol.length - b.i.symbol.length);
  return scored.slice(0, limit).map(x => x.i);
}

export type WatchlistCheck = { ok: true; ids: string[] } | { ok: false; error: string };

/** Validates a requested watchlist against the instrument master: numeric ids only, known ids only,
 *  de-duplicated in order, at most US_WATCHLIST_MAX. Never trusts the browser's symbol text. */
export function validateWatchlist(raw: unknown, known: ReadonlySet<string>): WatchlistCheck {
  if (!Array.isArray(raw)) return { ok: false, error: 'ids must be an array' };
  const ids: string[] = [];
  for (const v of raw) {
    const s = String(v ?? '').trim();
    if (!/^\d{1,9}$/.test(s)) return { ok: false, error: `Invalid security id "${s.slice(0, 20)}"` };
    if (!known.has(s)) return { ok: false, error: `Security id ${s} is not in Dhan's US instrument list` };
    if (!ids.includes(s)) ids.push(s);
  }
  if (ids.length > US_WATCHLIST_MAX) return { ok: false, error: `At most ${US_WATCHLIST_MAX} symbols` };
  return { ok: true, ids };
}

/** The watchlist after an add/remove. Ids Dhan no longer lists are pruned FIRST: validating the whole list otherwise made one
 *  delisted id fail every later add/remove with a 400, on a row the page cannot even show (so it could not be removed). */
export function nextWatchlist(cur: readonly string[], action: 'add' | 'remove', id: string, known: ReadonlySet<string>): WatchlistCheck {
  const kept = cur.filter(x => known.has(x));
  const target = id.trim();
  const next = action === 'add' ? [...kept.filter(x => x !== target), target] : kept.filter(x => x !== target);
  return validateWatchlist(next, known);
}

// ── quote view-model ─────────────────────────────────────────────────────────

/** Raw per-instrument state as written by live_us_ws.py (only fields the feed actually sent). */
export interface RawUsQuote {
  ltp?: number; volume?: number; ltt?: number; lut?: number;
  prev_close?: number; open?: number; high?: number; low?: number;
  upper_circuit?: number; lower_circuit?: number; wk52_high?: number; wk52_low?: number;
}

export interface UsQuoteRow {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  ltp: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  wk52High: number | null;
  wk52Low: number | null;
  /** 0..1 position of the last price inside the 52-week range, null when either end is missing. */
  wk52Pos: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  /** ms since the last Trade packet for this symbol, from `lut` (true UTC epoch); null when none arrived. */
  tradeAgeMs: number | null;
}

const pos = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** null, not 0, for anything the feed has not sent. Change is vs the Previous Close packet only. */
export function buildUsRow(inst: UsInstrument, q: RawUsQuote | undefined, nowMs: number): UsQuoteRow {
  const ltp = pos(q?.ltp);
  const prev = pos(q?.prev_close);
  const hi = pos(q?.wk52_high), lo = pos(q?.wk52_low);
  const lut = typeof q?.lut === 'number' && q.lut > 0 ? q.lut * 1000 : null;
  return {
    id: inst.id, symbol: inst.symbol, name: inst.name, exchange: inst.exchange,
    ltp, prevClose: prev,
    change: ltp != null && prev != null ? ltp - prev : null,
    changePct: ltp != null && prev != null ? ((ltp - prev) / prev) * 100 : null,
    open: pos(q?.open), high: pos(q?.high), low: pos(q?.low),
    volume: typeof q?.volume === 'number' && q.volume >= 0 && ltp != null ? q.volume : null,
    wk52High: hi, wk52Low: lo,
    wk52Pos: ltp != null && hi != null && lo != null && hi > lo ? Math.min(1, Math.max(0, (ltp - lo) / (hi - lo))) : null,
    upperCircuit: pos(q?.upper_circuit), lowerCircuit: pos(q?.lower_circuit),
    tradeAgeMs: lut != null ? Math.max(0, nowMs - lut) : null,
  };
}

export type BridgeHealth = 'live' | 'reconnecting' | 'stale' | 'stopped' | 'error' | 'idle';

export interface BridgeStatus {
  status?: string; pid?: number; heartbeat?: number; subscribed?: number; connected?: boolean; error?: string | null;
}

/** A dead bridge leaves its last status on disk, so liveness comes from the heartbeat age, not the status
 *  string alone. `pidAlive` is the caller's process check (kept out of here so this stays pure). */
export function bridgeHealth(st: BridgeStatus | null, pidAlive: boolean, nowMs: number, staleMs = 20_000): BridgeHealth {
  if (!st || !st.status) return 'stopped';
  if (st.status === 'ERROR') return 'error';
  if (st.status === 'STOPPED') return 'stopped';
  if (!pidAlive) return 'stopped';
  if (typeof st.heartbeat !== 'number' || nowMs - st.heartbeat > staleMs) return 'stale';
  if (st.status === 'IDLE') return 'idle';
  if (st.connected) return 'live';
  // Fresh heartbeat but no socket: the bridge is alive and between attempts (it keeps its heartbeat going through a backoff),
  // which is a normal, self-healing state - not the same as a bridge that has stopped updating.
  return st.status === 'CONNECTING' || st.status === 'RECONNECTING' ? 'reconnecting' : 'stale';
}
