// Server-side calls to Dhan's Market Analytics Data APIs. Pure parsing/validation lives in
// lib/dhanAnalytics.ts; this file owns the network, pacing and caching.
//
// Guards (dhan-polling-guards): one account-wide lane for these endpoints so several open tabs
// cannot burst past Dhan's Data-API bucket - the movers endpoint 429s (DH-904) on back-to-back
// calls; the 429 grows the shared gap and success relaxes it; only non-empty successes are cached;
// concurrent identical requests share one upstream call; an upstream failure falls back to the last
// good value, flagged stale.
import { dhanPost } from '@/lib/dhanToken';
import {
  normalizeNews, normalizeCompanyInfo, normalizeMovers,
  type NewsRequest, type NewsItem, type CompanyInfoRequest, type CompanyInfo, type MoversRequest, type MoverRow,
} from '@/lib/dhanAnalytics';

const BASE_GAP_MS = 350;
const MAX_GAP_MS = 8_000;
let gapMs = BASE_GAP_MS;
let laneTail: Promise<void> = Promise.resolve();
let lastCallAt = 0;

/** Runs `fn` after the lane's gap. A 429 (status tag from dhanPost) doubles the shared gap; any other
 *  outcome relaxes it back toward baseline. Never retries a 429 itself - the gap protects the next call. */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = laneTail.then(async () => {
    const wait = lastCallAt + gapMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
    try {
      const out = await fn();
      gapMs = Math.max(BASE_GAP_MS, Math.floor(gapMs / 2));
      return out;
    } catch (err) {
      if ((err as { status?: number })?.status === 429) gapMs = Math.min(MAX_GAP_MS, gapMs * 2);
      throw err;
    }
  });
  laneTail = run.then(() => undefined, () => undefined);
  return run;
}

export interface Cached<T> { value: T; fetchedAt: number; stale: boolean }

interface Entry { value: unknown; at: number }
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Cached<unknown>>>();
const MAX_ENTRIES = 300;

async function cachedCall<T>(key: string, ttlMs: number, isCacheable: (v: T) => boolean, fn: () => Promise<T>): Promise<Cached<T>> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { value: hit.value as T, fetchedAt: hit.at, stale: false };

  const pending = inflight.get(key);
  if (pending) return pending as Promise<Cached<T>>;

  const p = (async (): Promise<Cached<T>> => {
    try {
      const value = await fn();
      const at = Date.now();
      if (isCacheable(value)) {
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
        store.set(key, { value, at });
      }
      return { value, fetchedAt: at, stale: false };
    } catch (err) {
      // Prefer showing the last good answer (flagged) over an error banner for a transient failure.
      if (hit) return { value: hit.value as T, fetchedAt: hit.at, stale: true };
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p as Promise<Cached<unknown>>);
  return p;
}

const NEWS_TTL = 30_000;
const COMPANY_TTL = 60 * 60_000;
const MOVERS_TTL = 5_000;

export function fetchNews(req: NewsRequest): Promise<Cached<NewsItem[]>> {
  const key = `news:${req.categories.join(',')}:${req.limit}:${req.universe ?? ''}:${req.stockList.join(',')}`;
  return cachedCall(key, NEWS_TTL, v => v.length > 0, async () => {
    const body: Record<string, unknown> = { categories: req.categories, limit: req.limit, stockList: req.stockList };
    if (req.universe) body.universe = req.universe; // must be omitted, not null/empty, when unscoped
    return normalizeNews(await paced(() => dhanPost('/data/newsheadline', body)));
  });
}

export function fetchCompanyInfo(req: CompanyInfoRequest): Promise<Cached<CompanyInfo | null>> {
  const key = `co:${req.exchangeSegment}:${req.securityId}:${req.metrics.join(',')}`;
  return cachedCall(key, COMPANY_TTL, v => v !== null, async () => {
    const raw = await paced(() => dhanPost('/data/companyinfo', {
      securityId: req.securityId, exchangeSegment: req.exchangeSegment, instrument: 'EQUITY', metrics: req.metrics,
    }));
    return normalizeCompanyInfo(raw, req.securityId);
  });
}

export function fetchMovers(req: MoversRequest): Promise<Cached<MoverRow[]>> {
  const key = `mv:${req.exchangeSegment}:${req.instrument.join(',')}:${req.category}:${req.universe ?? ''}:${req.expiry ?? ''}:${req.limit}`;
  return cachedCall(key, MOVERS_TTL, v => v.length > 0, async () => {
    const body: Record<string, unknown> = {
      exchangeSegment: req.exchangeSegment, instrument: req.instrument, category: req.category, limit: req.limit,
    };
    if (req.universe) body.universe = req.universe;
    if (req.expiry) body.expiry = req.expiry;
    return normalizeMovers(await paced(() => dhanPost('/data/marketmovers', body)));
  });
}

/** Maps a thrown upstream/auth error to an HTTP status + a message safe to show in the UI. */
export function describeUpstreamError(err: unknown): { status: number; message: string } {
  const e = err as { status?: number; message?: string; code?: string };
  const msg = e?.message ?? 'Unknown error';
  if (e?.status === 429) return { status: 429, message: 'Dhan rate limit hit (DH-904) - retrying shortly' };
  if (/access_token\.json|ENOENT/.test(msg)) return { status: 503, message: 'Dhan session missing - run login.py' };
  if (/DH-90[1-3]|DH-807|DH-808|DH-809|DH-810|DH-811|DH-902|DH-906/.test(msg) || e?.status === 401 || e?.status === 403) {
    return { status: 502, message: `Dhan rejected the request (auth or Data API subscription): ${msg}` };
  }
  return { status: 502, message: msg };
}
