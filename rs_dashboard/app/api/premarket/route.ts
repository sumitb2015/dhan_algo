import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PYTHON_EXE } from '@/lib/pyExec';

// ── paths ──────────────────────────────────────────────────────────────
const PROJECT_ROOT    = path.resolve(process.cwd(), '..');
const PREMARKET_PY    = path.join(PROJECT_ROOT, 'scripts', 'tools', 'premarket_data.py');
const TOKEN_FILE      = path.join(PROJECT_ROOT, 'access_token.json');
const DHAN_OHLC_URL   = 'https://api.dhan.co/v2/marketfeed/ohlc';
const NIFTY_SPOT_ID   = 13;
const VIX_ID          = 21;

// ── IST market-open cutoff ─────────────────────────────────────────────
function istHourMinute(): [number, number] {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return [now.getUTCHours(), now.getUTCMinutes()];
}

// ── exported types ─────────────────────────────────────────────────────
export interface NiftyData { spot: number; spotPrevClose: number; futuresLtp: number; futuresPremium: number; futuresExpiry: string }
export interface VixData { vix: number; vixPrevClose: number; vixPctChange: number }
export interface UsdInrData { price: number; prevClose: number; pctChange: number }
export interface OptionsData { expiry: string; atmIV: number; pcr: number; maxCeOiStrike: number; maxPeOiStrike: number; chainFetchedAt: string; error?: string }
export interface CommodityItem { name: string; ltp: number; prevClose: number; pctChange: number }
export interface GlobalMarketItem { name: string; region: 'US' | 'Asia'; prevClose: number; pctChange: number }
export interface BiasFactor { label: string; direction: 'positive' | 'negative' | 'neutral' }
export interface BiasResult { label: string; score: number; factors: BiasFactor[] }
export interface PremarketData {
  fetchedAt: string;
  nifty: NiftyData;
  vix: VixData;
  usdInr: UsdInrData;
  options: OptionsData;
  commodities: CommodityItem[];
  globalMarkets: GlobalMarketItem[] | null;
  bias: BiasResult;
}

// ── token ──────────────────────────────────────────────────────────────
interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
function getToken(): { clientId: string; token: string } | null {
  try {
    if (tokenCache && Date.now() - tokenCache.ts < 5 * 60 * 1000) {
      return { clientId: tokenCache.clientId, token: tokenCache.token };
    }
    
    // Read parent .env file to get client_id
    let envClientId = '';
    const envFile = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8');
      const match = content.match(/^client_id\s*=\s*["']?([^"'\r\n]+)["']?/m);
      if (match) {
        envClientId = match[1].trim();
      }
    }

    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
      dhanClientId?: string;
      clientId?: string;
      accessToken: string;
    };
    const clientId = envClientId || process.env.client_id || raw.dhanClientId || raw.clientId || '';
    tokenCache = { clientId, token: raw.accessToken, ts: Date.now() };
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  } catch { return null; }
}

// ── Python spawn (async) ───────────────────────────────────────────────
function runScript(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(exe, args, { windowsHide: true });
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve('{"error":"timeout"}'); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve(out || '{"error":"no output"}'); });
    child.on('error', (err: Error) => { clearTimeout(timer); resolve(JSON.stringify({ error: err.message })); });
  });
}

// ── Dhan OHLC (spot + VIX in one call) ────────────────────────────────
async function fetchDhanSpotVix(auth: { clientId: string; token: string }): Promise<{ spot: number; spotPrevClose: number; vix: number; vixPrevClose: number }> {
  const fallback = { spot: 0, spotPrevClose: 0, vix: 0, vixPrevClose: 0 };
  try {
    const res = await fetch(DHAN_OHLC_URL, {
      method: 'POST',
      headers: { 'access-token': auth.token, 'client-id': auth.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ IDX_I: [NIFTY_SPOT_ID, VIX_ID] }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json() as { status?: string; data?: Record<string, Record<string, { last_price?: number; ohlc?: { close?: number } }>> };
    if (json.status !== 'success') return fallback;
    const idx = json.data?.IDX_I ?? {};
    const spot = idx[String(NIFTY_SPOT_ID)]?.last_price ?? 0;
    const spotPrev = idx[String(NIFTY_SPOT_ID)]?.ohlc?.close ?? 0;
    const vix = idx[String(VIX_ID)]?.last_price ?? 0;
    const vixPrev = idx[String(VIX_ID)]?.ohlc?.close ?? 0;
    return { spot, spotPrevClose: spotPrev, vix, vixPrevClose: vixPrev };
  } catch { return fallback; }
}

// ── Yahoo Finance ──────────────────────────────────────────────────────
const GLOBAL_SYMBOLS: { symbol: string; name: string; region: 'US' | 'Asia' }[] = [
  { symbol: '^DJI',  name: 'Dow Jones',    region: 'US'   },
  { symbol: '^GSPC', name: 'S&P 500',      region: 'US'   },
  { symbol: '^IXIC', name: 'Nasdaq',       region: 'US'   },
  { symbol: '^N225', name: 'Nikkei 225',   region: 'Asia' },
  { symbol: '^HSI',  name: 'Hang Seng',    region: 'Asia' },
  { symbol: '^NSEI', name: 'Nifty (Yahoo)',region: 'Asia' },
];

async function fetchGlobalMarkets(): Promise<GlobalMarketItem[] | null> {
  try {
    const results = await Promise.all(
      GLOBAL_SYMBOLS.map(async ({ symbol, name, region }) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        const json = await res.json() as { chart: { result: Array<{ meta: { regularMarketPrice: number; chartPreviousClose: number } }> } };
        const meta = json.chart.result[0].meta;
        const prevClose = meta.regularMarketPrice;
        const prevPrev  = meta.chartPreviousClose;
        const pctChange = prevPrev > 0 ? (prevClose - prevPrev) / prevPrev * 100 : 0;
        return { name, region, prevClose, pctChange };
      })
    );
    return results;
  } catch { return null; }
}

async function fetchUsdInr(): Promise<{ price: number; prevClose: number; pctChange: number }> {
  const fallback = { price: 0, prevClose: 0, pctChange: 0 };
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?range=5d&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json() as { chart: { result: Array<{ meta: { regularMarketPrice: number; chartPreviousClose: number } }> } };
    const meta = json.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose;
    const pctChange = prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0;
    return { price, prevClose, pctChange };
  } catch { return fallback; }
}

// ── Bias computation ───────────────────────────────────────────────────
function computeBias(
  vix: number,
  pcr: number,
  spot: number,
  maxCeOiStrike: number,
  maxPeOiStrike: number,
  giftNiftyPct: number | null,
): BiasResult {
  const factors: BiasFactor[] = [];
  let score = 0;

  if (giftNiftyPct !== null) {
    if (giftNiftyPct > 0) {
      score += 1;
      factors.push({ label: `Nifty (Yahoo) ↑ ${giftNiftyPct.toFixed(2)}%`, direction: 'positive' });
    } else if (giftNiftyPct < 0) {
      score -= 1;
      factors.push({ label: `Nifty (Yahoo) ↓ ${Math.abs(giftNiftyPct).toFixed(2)}%`, direction: 'negative' });
    }
  }

  if (vix > 0) {
    if (vix < 14)       { score += 1;  factors.push({ label: `VIX Low (${vix.toFixed(1)})`,      direction: 'positive' }); }
    else if (vix <= 18) {               factors.push({ label: `VIX Moderate (${vix.toFixed(1)})`, direction: 'neutral'  }); }
    else if (vix <= 25) { score -= 1;  factors.push({ label: `VIX Elevated (${vix.toFixed(1)})`, direction: 'negative' }); }
    else                { score -= 2;  factors.push({ label: `VIX Extreme (${vix.toFixed(1)})`,  direction: 'negative' }); }
  }

  if (pcr > 1.2)       { score += 1; factors.push({ label: `PCR Bullish (${pcr.toFixed(2)})`,  direction: 'positive' }); }
  else if (pcr >= 0.8) {              factors.push({ label: `PCR Neutral (${pcr.toFixed(2)})`,  direction: 'neutral'  }); }
  else                 { score -= 1; factors.push({ label: `PCR Bearish (${pcr.toFixed(2)})`,  direction: 'negative' }); }

  if (maxCeOiStrike > 0 && maxPeOiStrike > 0) {
    const distToSupport    = spot - maxPeOiStrike;
    const distToResistance = maxCeOiStrike - spot;
    if (distToSupport >= 0 && distToResistance >= 0) {
      if (distToSupport < distToResistance) {
        score += 1; factors.push({ label: `Near Support (${maxPeOiStrike})`, direction: 'positive' });
      } else {
        score -= 1; factors.push({ label: `Near Resistance (${maxCeOiStrike})`, direction: 'negative' });
      }
    }
  }

  let label: string;
  if      (score >= 3)  label = 'Bullish';
  else if (score >= 1)  label = 'Cautiously Bullish';
  else if (score === 0) label = 'Neutral';
  else if (score >= -2) label = 'Cautiously Bearish';
  else                  label = 'Bearish';

  return { label, score, factors };
}

// ── Route handler ──────────────────────────────────────────────────────
export async function GET() {
  const [h] = istHourMinute();
  if (false && h >= 9) { // TEMP: cutoff disabled for testing — restore `if (h >= 9)` before shipping
    return NextResponse.json({
      success: false,
      marketOpen: true,
      error: 'Market is open — premarket data is only available before 9:00 AM IST.',
    });
  }

  const auth = getToken();
  if (!auth) {
    return NextResponse.json({ success: false, error: 'Auth token not found — run login.py' }, { status: 500 });
  }

  // Run all four in parallel
  const [pythonRaw, dhanData, globalMarkets, usdInr] = await Promise.all([
    runScript(PYTHON_EXE, [PREMARKET_PY], 40_000),
    fetchDhanSpotVix(auth),
    fetchGlobalMarkets(),
    fetchUsdInr(),
  ]);

  // Parse Python output
  let pyData: {
    futures?: { ltp: number; prevClose: number; expiry: string } | null;
    commodities?: CommodityItem[];
    options?: { expiry: string; atmIV: number; pcr: number; maxCeOiStrike: number; maxPeOiStrike: number; chainFetchedAt: string } | null;
    error?: string;
  } = {};
  try {
    const lastLine = pythonRaw.trim().split('\n').pop() ?? '{}';
    pyData = JSON.parse(lastLine);
  } catch { /* leave pyData empty */ }

  const nifty: NiftyData = {
    spot:           dhanData.spot,
    spotPrevClose:  dhanData.spotPrevClose,
    futuresLtp:     pyData.futures?.ltp ?? 0,
    futuresPremium: dhanData.spot > 0 ? (pyData.futures?.ltp ?? 0) - dhanData.spot : 0,
    futuresExpiry:  pyData.futures?.expiry ?? '',
  };

  const vixPctChange = dhanData.vixPrevClose > 0
    ? (dhanData.vix - dhanData.vixPrevClose) / dhanData.vixPrevClose * 100
    : 0;
  const vix: VixData = { vix: dhanData.vix, vixPrevClose: dhanData.vixPrevClose, vixPctChange };

  const options: OptionsData = pyData.options
    ? { ...pyData.options }
    : { expiry: '', atmIV: 0, pcr: 1, maxCeOiStrike: 0, maxPeOiStrike: 0, chainFetchedAt: '', error: pyData.error ?? 'Chain unavailable' };

  const commodities: CommodityItem[] = pyData.commodities ?? [];

  // Gift Nifty pct for bias (^NSEI entry)
  const nsei = globalMarkets?.find(m => m.name === 'Nifty (Yahoo)');
  const bias = computeBias(vix.vix, options.pcr, nifty.spot, options.maxCeOiStrike, options.maxPeOiStrike, nsei?.pctChange ?? null);

  const data: PremarketData = {
    fetchedAt: new Date().toISOString(),
    nifty,
    vix,
    usdInr,
    options,
    commodities,
    globalMarkets,
    bias,
  };

  return NextResponse.json({ success: true, data });
}
