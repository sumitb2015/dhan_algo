import path from 'path';
import fs from 'fs';
import { getDhanCredentials } from './dhanToken.ts';
import { istDay, isMcxUnderlying } from './priceLadder.ts';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DHAN_HISTORICAL_URL = 'https://api.dhan.co/v2/charts/historical';

export interface PrevDayLevel {
  high: number;
  low: number;
  close: number;
}

const cache = new Map<string, PrevDayLevel>();

const INDEX_CONFIG: Record<string, { securityId: string; segment: string; instrument: string; csvFile: string }> = {
  NIFTY: {
    securityId: '13',
    segment: 'IDX_I',
    instrument: 'INDEX',
    csvFile: path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_5Y.csv'),
  },
  BANKNIFTY: {
    securityId: '25',
    segment: 'IDX_I',
    instrument: 'INDEX',
    csvFile: path.join(PROJECT_ROOT, 'Historical Data', 'Indices', 'BANKNIFTY.csv'),
  },
  SENSEX: {
    securityId: '51',
    segment: 'IDX_I',
    instrument: 'INDEX',
    csvFile: path.join(PROJECT_ROOT, 'Historical Data', 'Indices', 'SENSEX.csv'),
  },
};

/**
 * Fetch previous day high, low and close for the given underlying.
 * Sourced from Dhan historical daily candles, with CSV fallback.
 * Cached in memory per IST trading day.
 */
export async function getPrevDayLevels(underlying: string, mcxSecurityId?: string | null): Promise<PrevDayLevel | null> {
  const u = underlying.toUpperCase();
  const today = istDay();
  const cacheKey = `${today}:${u}:${mcxSecurityId ?? ''}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  // 1. Try Dhan Historical Daily Candle API
  try {
    const creds = getDhanCredentials();
    if (creds.token && creds.clientId) {
      let securityId = '';
      let segment = '';
      let instrument = '';

      if (isMcxUnderlying(u)) {
        if (mcxSecurityId) {
          securityId = mcxSecurityId;
          segment = 'MCX_COMM';
          instrument = 'FUTCOM';
        }
      } else if (INDEX_CONFIG[u]) {
        securityId = INDEX_CONFIG[u].securityId;
        segment = INDEX_CONFIG[u].segment;
        instrument = INDEX_CONFIG[u].instrument;
      }

      if (securityId && segment && instrument) {
        const to = new Date();
        const from = new Date(to);
        from.setDate(from.getDate() - 10);
        const fmt = (d: Date) => d.toISOString().slice(0, 10);

        const res = await fetch(DHAN_HISTORICAL_URL, {
          method: 'POST',
          headers: {
            'access-token': creds.token,
            'client-id': creds.clientId,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            securityId,
            exchangeSegment: segment,
            instrument,
            oi: false,
            fromDate: fmt(from),
            toDate: fmt(to),
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (res.ok) {
          const json = (await res.json()) as {
            high?: number[];
            low?: number[];
            close?: number[];
            timestamp?: number[];
          };
          const highs = json.high ?? [];
          const lows = json.low ?? [];
          const closes = json.close ?? [];
          const timestamps = json.timestamp ?? [];

          // Find rows strictly before today
          const priorRows: PrevDayLevel[] = [];
          for (let i = 0; i < timestamps.length; i++) {
            const dateStr = new Date(timestamps[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            if (dateStr < today && highs[i] > 0 && lows[i] > 0 && closes[i] > 0) {
              priorRows.push({ high: highs[i], low: lows[i], close: closes[i] });
            }
          }

          if (priorRows.length > 0) {
            const last = priorRows[priorRows.length - 1];
            cache.set(cacheKey, last);
            return last;
          }
        }
      }
    }
  } catch (err) {
    // Non-fatal: continue to CSV fallback
  }

  // 2. CSV fallback
  try {
    const cfg = INDEX_CONFIG[u];
    if (cfg && fs.existsSync(cfg.csvFile)) {
      const content = fs.readFileSync(cfg.csvFile, 'utf8');
      const lines = content.split(/\r?\n/).filter(Boolean);
      let best: PrevDayLevel | null = null;
      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length >= 5) {
          const d = parts[0].trim();
          if (d < today) {
            const h = parseFloat(parts[2]);
            const l = parseFloat(parts[3]);
            const c = parseFloat(parts[4]);
            if (!isNaN(h) && !isNaN(l) && !isNaN(c) && h > 0 && l > 0 && c > 0) {
              best = { high: h, low: l, close: c };
            }
          }
        }
      }
      if (best) {
        cache.set(cacheKey, best);
        return best;
      }
    }
  } catch {
    // Non-fatal
  }

  return null;
}
