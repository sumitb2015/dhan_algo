import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';
import { getDhanCredentials } from '@/lib/dhanToken';

const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');
const VIX_SECURITY_ID = 21;
const DHAN_OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc';
const MARGIN_CALCULATOR_URL = 'https://api.dhan.co/v2/margincalculator/multi';

export interface VixResult {
  vix: number;
  prevClose: number;
  change: number;
  changePct: number;
  regime: string;
  advice: string;
}

function computeVixRegime(vix: number): { regime: string; advice: string } {
  if (vix <= 12.5) {
    return {
      regime: 'Low Volatility',
      advice: 'Premiums are low. Prioritize tight Bull Put / Bear Call spreads or calendar spreads. Strangles require larger moves for safety.',
    };
  } else if (vix <= 16.5) {
    return {
      regime: 'Normal / Ideal Volatility',
      advice: 'Ideal regime for range-bound credit spreads, Iron Condors, and short strangles. Healthy premium decay with balanced risk.',
    };
  } else if (vix <= 22.0) {
    return {
      regime: 'Elevated Volatility',
      advice: 'High premium collection opportunities. Use wider wings on Iron Condors and seek 2.5%+ OTM distance for credit spreads.',
    };
  } else {
    return {
      regime: 'High Volatility / Panic',
      advice: 'Extreme implied volatility. Strictly trade defined-risk credit spreads with wide safety buffers (3.5%+ OTM). Avoid undefined naked risk.',
    };
  }
}

export async function fetchLiveIndiaVix(): Promise<VixResult> {
  // 1. Direct Dhan REST OHLC API
  try {
    const auth = getDhanCredentials();
    if (auth.token && auth.clientId) {
      const res = await fetch(DHAN_OHLC_URL, {
        method: 'POST',
        headers: {
          'access-token': auth.token,
          'client-id': auth.clientId,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ IDX_I: [VIX_SECURITY_ID] }),
        signal: AbortSignal.timeout(4000),
      });

      const json = await res.json() as {
        status?: string;
        data?: Record<string, Record<string, {
          last_price?: number;
          ohlc?: { close?: number };
        }>>;
      };

      if (json.status === 'success') {
        const entry = json.data?.IDX_I?.[String(VIX_SECURITY_ID)];
        const ltp = entry?.last_price ?? 0;
        const prevClose = entry?.ohlc?.close ?? ltp;

        if (ltp > 0) {
          const change = ltp - prevClose;
          const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
          const { regime, advice } = computeVixRegime(ltp);
          return {
            vix: Math.round(ltp * 100) / 100,
            prevClose: Math.round(prevClose * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePct: Math.round(changePct * 100) / 100,
            regime,
            advice,
          };
        }
      }
    }
  } catch {}

  // 2. Python fallback if direct REST timed out
  try {
    const parsed = await dedupe('vix-direct-python', () =>
      runPythonJson<{ vix?: number }>(
        '-c',
        [
          "from login import get_dhan_client; from lib.dhan_helper import DhanHelper; import json; dhan=get_dhan_client(); helper=DhanHelper(dhan); ltp=helper.get_ltp(21, exchange='NSE', instrument='INDEX') or 0; print(json.dumps({'vix': ltp}))",
        ],
        10_000,
      ),
    );
    if (parsed.vix && parsed.vix > 0) {
      const { regime, advice } = computeVixRegime(parsed.vix);
      return {
        vix: Math.round(parsed.vix * 100) / 100,
        prevClose: Math.round(parsed.vix * 100) / 100,
        change: 0,
        changePct: 0,
        regime,
        advice,
      };
    }
  } catch {}

  // 3. Static fallback
  return {
    vix: 11.34,
    prevClose: 11.34,
    change: 0,
    changePct: 0,
    regime: 'Low Volatility',
    advice: 'Implied volatility is low (11.34). Option premiums are lower than normal. Focus on defined risk credit spreads or strangles with realistic profit expectations.',
  };
}

export async function fetchUnderlyingChain(
  underlying: string,
  expiry: string,
  paceKey?: string,
): Promise<{
  chain: Record<string, unknown>;
  spot: number;
  prevClose: number;
}> {
  // Keyed by paceKey too: two callers with the same underlying/expiry but
  // different pacing lanes must not dedupe onto one another's in-flight
  // request, or the second caller's request runs under the FIRST caller's
  // spaced() lane — silently defeating whichever caller asked for isolation.
  const cacheKey = `scanner-chain:${paceKey ?? 'default'}:${underlying}:${expiry}`;
  const parsed = await dedupe(cacheKey, () =>
    spaced(paceKey ?? `dhan-spawn:${underlying}`, () =>
      runPythonJson<{
        chain?: Record<string, unknown>;
        spot?: number;
        prev_close?: number;
        error?: string;
      }>(FETCH_SCRIPT, ['chain', '--underlying', underlying, '--expiry', expiry], 45_000),
    ),
  );

  return {
    chain: parsed.chain ?? {},
    spot: parsed.spot ?? 0,
    prevClose: parsed.prev_close ?? 0,
  };
}

export interface MarginLeg {
  side: 'BUY' | 'SELL';
  securityId: string;
  quantity: number; // lots * lotSize
}

/**
 * Real netted margin for an exact multi-leg combo, via Dhan's own
 * /margincalculator/multi (portfolio-netted SPAN + exposure — the same figure
 * Dhan's Strategy Builder and this dashboard's Multi-Leg Focus panel show).
 * Used to replace the scanner engine's flat per-strategy margin estimate
 * (e.g. a fixed ₹120,000 for any 1-lot NIFTY strangle) with the real
 * lot-size-aware figure for the handful of top candidates actually shown to
 * the user — calling this for every combo evaluated during the bulk scan
 * (100s of candidates) would blow both the request's time budget and Dhan's
 * rate limit, so callers must cap how many candidates they enrich.
 *
 * Returns null (never throws) on any failure — callers fall back to the
 * existing estimate rather than losing the candidate.
 */
// Account-wide pacer + 429 backoff for Dhan's margin calculator.
//
// Dhan's rate limit applies per account, not per caller. Every
// fetchNettedMargin() call — regardless of which route or underlying
// triggered it — funnels through this single lane, so independent
// self-paced loops (the ultimate-scanner's top-N enrichment, the
// strangle-matrix background sweep, any future caller) can't each assume
// they own the full ~1 req/s budget and stack on top of one another.
// On a 429 the gap grows (capped) and decays back to baseline on success,
// so a burst of load elsewhere backs this off automatically instead of
// hammering a bucket that's already throttling the account.
const MARGIN_BASE_GAP_MS = 1_100;
const MARGIN_MAX_GAP_MS = 20_000;
let marginPaceChain: Promise<unknown> = Promise.resolve();
let marginGapMs = MARGIN_BASE_GAP_MS;

function paceMarginCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = marginPaceChain.then(fn);
  marginPaceChain = run
    .then(() => new Promise(resolve => setTimeout(resolve, marginGapMs)))
    .catch(() => new Promise(resolve => setTimeout(resolve, marginGapMs)));
  return run;
}

export async function fetchNettedMargin(
  underlying: string,
  legs: MarginLeg[],
): Promise<number | null> {
  if (legs.length === 0) return null;
  return paceMarginCall(async () => {
    try {
      const auth = getDhanCredentials();
      if (!auth.token || !auth.clientId) return null;

      const exchangeSegment = underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';
      const scripList = legs.map(leg => ({
        exchangeSegment,
        transactionType: leg.side,
        quantity: leg.quantity,
        productType: 'MARGIN',
        securityId: leg.securityId,
        price: 0,
      }));

      const res = await fetch(MARGIN_CALCULATOR_URL, {
        method: 'POST',
        headers: {
          'access-token': auth.token,
          'client-id': auth.clientId,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          includePosition: false,
          includeOrders: false,
          scripList,
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (res.status === 429) {
        marginGapMs = Math.min(MARGIN_MAX_GAP_MS, marginGapMs * 2);
        return null;
      }

      const json = await res.json() as {
        status?: string;
        data?: { totalMargin?: number };
      };
      const totalMargin = json.data?.totalMargin;
      // A clean response means the account isn't currently throttled here —
      // relax the gap back toward baseline rather than staying at whatever
      // backoff a prior 429 left it at.
      marginGapMs = Math.max(MARGIN_BASE_GAP_MS, Math.round(marginGapMs * 0.7));
      if (json.status === 'success' && typeof totalMargin === 'number' && totalMargin > 0) {
        return Math.round(totalMargin * 100) / 100;
      }
      return null;
    } catch {
      return null;
    }
  });
}

export async function fetchUnderlyingExpiries(underlying: string, paceKey?: string): Promise<string[]> {
  try {
    const parsed = await dedupe(`scanner-expiries:${paceKey ?? 'default'}:${underlying}`, () =>
      spaced(paceKey ?? `dhan-spawn:${underlying}`, () =>
        runPythonJson<{ expiries?: string[] }>(
          FETCH_SCRIPT,
          ['expiries', '--underlying', underlying],
          30_000,
        ),
      ),
    );
    return parsed.expiries ?? [];
  } catch {
    return [];
  }
}
