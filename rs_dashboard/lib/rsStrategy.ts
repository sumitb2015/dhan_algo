import { readStockCSVAsync, readNifty500List, readNifty50Index } from './dataLoader';
import {
  DEFAULT_PARAMS,
  evaluateStock,
  resampleWeekly,
  type RsStrategyParams,
  type RsStrategyResponse,
  type RsStrategyStock,
} from './rsStrategyCore';

export * from './rsStrategyCore';

const MAX_CACHED = 6; // period/rsiMin are user-driven; keep the cache bounded
const cache = new Map<string, { data: RsStrategyResponse; ts: number }>();
const inflight = new Map<string, Promise<RsStrategyResponse>>();
const TTL_MS = 5 * 60 * 1000;

/** The session date most stocks ended on. Robust to one stock carrying a bad future-dated row. */
function modalDate(stocks: RsStrategyStock[]): string {
  const freq = new Map<string, number>();
  for (const s of stocks) freq.set(s.date, (freq.get(s.date) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [d, n] of freq) if (n > bestN || (n === bestN && d > best)) { best = d; bestN = n; }
  return best;
}

async function compute(params: RsStrategyParams): Promise<RsStrategyResponse> {
  const symbols = readNifty500List();
  const index = readNifty50Index();
  const weeklyIndex = resampleWeekly(index);

  const results = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const rows = await readStockCSVAsync(sym);
        return rows && rows.length ? evaluateStock(sym, rows, index, params, weeklyIndex) : null;
      } catch {
        return null; // one unreadable CSV must not sink the whole scan
      }
    }),
  );
  const stocks = results.filter((r): r is RsStrategyStock => r !== null);
  const dataDate = modalDate(stocks);
  // Drop stocks that did not trade on the latest session (halted, delisted) so they don't show as live signals.
  const fresh = stocks.filter((s) => s.date === dataDate);

  const count = (sig: string) => fresh.filter((s) => s.signal === sig).length;
  return {
    dataDate,
    params,
    totalScanned: fresh.length,
    counts: { buy: count('BUY'), hold: count('HOLD'), sell: count('SELL'), wait: count('WAIT') },
    stocks: fresh,
  };
}

export async function runRsStrategy(
  overrides: Partial<RsStrategyParams> = {},
  forceRefresh = false,
): Promise<RsStrategyResponse> {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const key = JSON.stringify(params);
  const hit = cache.get(key);
  if (!forceRefresh && hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  // Concurrent identical requests (several tabs, a double click) share one scan.
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = compute(params)
    .then((data) => {
      cache.delete(key); // re-insert so Map order is recency order
      cache.set(key, { data, ts: Date.now() });
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
