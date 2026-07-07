import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const TOKEN_FILE     = path.join(PROJECT_ROOT, 'access_token.json');
const VIX_CSV        = path.join(PROJECT_ROOT, 'Historical Data', 'Indices', 'INDIA_VIX.csv');
const DHAN_OHLC_URL  = 'https://api.dhan.co/v2/marketfeed/ohlc';

// India VIX security ID on Dhan (NSE_IDX segment)
const VIX_SECURITY_ID = 21;

interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

function getToken(): { clientId: string; token: string } | null {
  try {
    if (tokenCache && Date.now() - tokenCache.ts < TOKEN_TTL) {
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
  } catch {
    return null;
  }
}

// CSV fallback — returns last two rows' closes
function csvFallback(): { vix: number; prevClose: number } | null {
  try {
    if (!fs.existsSync(VIX_CSV)) return null;
    const lines = fs.readFileSync(VIX_CSV, 'utf-8').split(/\r?\n/).filter(Boolean).slice(1);
    if (lines.length < 2) return null;
    const parse = (line: string) => parseFloat((line.split(',')[4] ?? '').trim());
    const last = parse(lines[lines.length - 1]);
    const prev = parse(lines[lines.length - 2]);
    return (!isNaN(last) && !isNaN(prev)) ? { vix: last, prevClose: prev } : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const auth = getToken();
  if (auth) {
    try {
      const res = await fetch(DHAN_OHLC_URL, {
        method: 'POST',
        headers: {
          'access-token': auth.token,
          'client-id':    auth.clientId,
          'Content-Type': 'application/json',
          'Accept':       'application/json',
        },
        body: JSON.stringify({ NSE_IDX: [VIX_SECURITY_ID] }),
        signal: AbortSignal.timeout(5000),
      });

      const json = await res.json() as {
        status?: string;
        data?: Record<string, Record<string, {
          last_price?: number;
          ohlc?: { open?: number; high?: number; low?: number; close?: number };
        }>>;
      };

      if (json.status === 'success') {
        const entry = json.data?.NSE_IDX?.[String(VIX_SECURITY_ID)];
        const ltp   = entry?.last_price ?? 0;
        const prevClose = entry?.ohlc?.close ?? 0;

        if (ltp > 0 && prevClose > 0) {
          return NextResponse.json({ success: true, vix: ltp, prevClose });
        }
      }
    } catch {
      // fall through to CSV
    }
  }

  // Fallback: use last two CSV rows
  const fallback = csvFallback();
  if (fallback) {
    return NextResponse.json({ success: true, ...fallback });
  }

  return NextResponse.json({ success: false, error: 'Could not fetch VIX data' }, { status: 500 });
}
