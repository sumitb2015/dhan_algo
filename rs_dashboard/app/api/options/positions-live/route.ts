import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, execSync } from 'child_process';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const TOKEN_FILE     = path.join(PROJECT_ROOT, 'access_token.json');
const DATA_FILE      = path.join(DEBUG_DIR, 'live_positions_data.json');
const STATUS_FILE    = path.join(DEBUG_DIR, 'live_positions_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'live_positions_stop.trigger');
const PYTHON_EXE      = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const PYTHON_SYNC     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const BRIDGE_SCRIPT   = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_positions_ws.py');
const HISTORY_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'positions_history.py');

const POSITIONS_URL = 'https://api.dhan.co/v2/positions';
const OHLC_URL      = 'https://api.dhan.co/v2/marketfeed/ohlc';
const VIX_ID        = 21;

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
    
    // Resolve client ID: check .env client_id, process.env.client_id, fallback to keys in access_token.json
    const clientId = envClientId || process.env.client_id || raw.dhanClientId || raw.clientId || '';
    tokenCache = { clientId, token: raw.accessToken, ts: Date.now() };
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}"`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      return out.includes(String(pid));
    }
    execSync(`ps -p ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getBridgeStatus() {
  let bridge_status = { status: 'STOPPED', subscribed: 0, pid: 0 };
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) as { status?: string; pid?: number; subscribed?: number };
      if (status && status.pid && (status.status === 'RUNNING' || status.status === 'STARTING' || status.status === 'ERROR')) {
        if (isPidRunning(status.pid)) {
          bridge_status = {
            status: status.status,
            subscribed: status.subscribed || 0,
            pid: status.pid
          };
        }
      }
    }
  } catch {}
  return bridge_status;
}

function ensureBridgeRunning() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }
    
    const status = getBridgeStatus();
    if (status.status !== 'RUNNING' && status.status !== 'STARTING') {
      console.log('[positions-live API] Spawning live_positions_ws.py WebSocket bridge...');
      if (fs.existsSync(STOP_TRIGGER)) {
        fs.unlinkSync(STOP_TRIGGER);
      }
      
      const child = spawn(
        PYTHON_EXE,
        [BRIDGE_SCRIPT],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    }
  } catch (err) {
    console.error('[positions-live API] Failed to start/verify positions WebSocket bridge:', err);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode        = searchParams.get('mode') || 'rest';
  const wantHistory = searchParams.get('history') === 'true';

  // ── History seed mode: spawn Python script for full intraday candle history ──
  if (wantHistory) {
    const result = spawnSync(PYTHON_SYNC, [HISTORY_SCRIPT], {
      timeout: 45000,
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
    });
    if (result.status !== 0 || result.error) {
      return NextResponse.json({ history: [], error: 'script_error' });
    }
    const lastLine = (result.stdout || '').trim().split('\n').pop() ?? '{}';
    try {
      const parsed = JSON.parse(lastLine) as { history?: unknown[]; error?: string };
      return NextResponse.json({ history: parsed.history ?? [], error: parsed.error });
    } catch {
      return NextResponse.json({ history: [], error: 'parse_error' });
    }
  }

  const bridge_status = getBridgeStatus();

  if (mode === 'live') {
    // 1. Ensure the WebSocket bridge is active in the background
    ensureBridgeRunning();

    // 2. Try to read from the WebSocket output JSON file
    try {
      if (fs.existsSync(DATA_FILE)) {
        const mtime = fs.statSync(DATA_FILE).mtimeMs;
        // If the file is fresh (less than 6 seconds old), serve it!
        if (Date.now() - mtime < 6000) {
          const payload = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Record<string, unknown>;
          const HISTORY_FILE = path.join(DEBUG_DIR, 'live_positions_history.json');
          if (fs.existsSync(HISTORY_FILE)) {
            try {
              const hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as { history: unknown[] };
              payload.history = hist.history || [];
            } catch {}
          }
          payload.bridge_status = bridge_status;
          return NextResponse.json(payload);
        }
      }
    } catch (err) {
      console.warn('[positions-live API] Failed to read live_positions_data.json, falling back to REST:', err);
    }
  }

  // 3. Fallback or REST mode: REST API calls if WebSocket output is stale, missing, or mode=rest
  const auth = getToken();
  if (!auth) {
    const payload = { has_positions: false, net_premium: 0, vix: 0, legs: [], timestamp: new Date().toISOString(), error: 'auth', bridge_status };
    return NextResponse.json(payload);
  }

  const headers = {
    'access-token': auth.token,
    'client-id':    auth.clientId,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };

  // ── Step A: fetch open positions ──────────────────────────────────
  let rawPositions: DhanPosition[] = [];
  try {
    const res = await fetch(POSITIONS_URL, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json() as DhanPosition[] | { data?: DhanPosition[] };
    rawPositions = Array.isArray(json) ? json : (json as { data?: DhanPosition[] }).data ?? [];
  } catch {
    const payload = { has_positions: false, net_premium: 0, vix: 0, legs: [], timestamp: new Date().toISOString(), error: 'api', bridge_status };
    return NextResponse.json(payload);
  }

  // filter to options legs only (NSE_FNO segment and containing CE/PE option tags)
  const optLegs = rawPositions.filter(p => {
    const isOptSegment = p.exchangeSegment === 'NSE_FNO';
    const hasOptType = p.drvOptionType === 'CALL' || p.drvOptionType === 'PUT';
    const symMatch = /-(CE|PE)/i.test(p.tradingSymbol ?? '');
    return isOptSegment && (hasOptType || symMatch) && (p.netQty ?? 0) !== 0;
  });

  // ── Step B: fetch LTPs for option legs + VIX in one OHLC call ────
  const secIds: number[] = optLegs.map(p => Number(p.securityId)).filter(Boolean);

  const ohlcBody: Record<string, number[]> = { NSE_IDX: [VIX_ID] };
  if (secIds.length > 0) ohlcBody['NSE_FNO'] = secIds;

  let ltpMap: Record<string, number> = {};
  let vix = 0;
  try {
    const res = await fetch(OHLC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(ohlcBody),
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json() as {
      status?: string;
      data?: Record<string, Record<string, { last_price?: number }>>;
    };
    if (json.status === 'success' && json.data) {
      vix = json.data?.NSE_IDX?.[String(VIX_ID)]?.last_price ?? 0;
      const fnoData = json.data?.NSE_FNO ?? {};
      for (const [id, entry] of Object.entries(fnoData)) {
        ltpMap[id] = entry.last_price ?? 0;
      }
    }
  } catch {
    // VIX and LTPs will be 0; proceed with what we have
  }

  // ── Step C: build legs + compute net premium ──────────────────────
  type Leg = {
    symbol: string; strike: number; type: 'CE' | 'PE';
    side: 'SELL' | 'BUY'; ltp: number; netQty: number;
  };

  let netPremium = 0;
  const legs: Leg[] = optLegs.map(p => {
    const ltp  = ltpMap[String(p.securityId)] ?? (p.lastPrice ?? 0);
    const qty  = p.netQty ?? 0;
    const side: 'SELL' | 'BUY' = qty < 0 ? 'SELL' : 'BUY';
    const sym  = p.tradingSymbol ?? '';
    
    let cepe: 'CE' | 'PE' = 'CE';
    if (p.drvOptionType === 'CALL') {
      cepe = 'CE';
    } else if (p.drvOptionType === 'PUT') {
      cepe = 'PE';
    } else {
      cepe = /-(CE)/i.test(sym) ? 'CE' : 'PE';
    }

    let strike = 0;
    if (p.drvStrikePrice && Number(p.drvStrikePrice) > 0) {
      strike = Number(p.drvStrikePrice);
    } else {
      const match1 = sym.match(/-(CE|PE)-(\d+)/i);
      const match2 = sym.match(/(\d+)-(CE|PE)/i);
      if (match1) {
        strike = Number(match1[2]);
      } else if (match2) {
        strike = Number(match2[1]);
      }
    }

    const absQty = Math.abs(qty);
    if (side === 'SELL') {
      netPremium += ltp * absQty;
    } else {
      netPremium -= ltp * absQty;
    }

    return { symbol: sym, strike, type: cepe, side, ltp, netQty: qty };
  });

  const payload = {
    has_positions: legs.length > 0,
    net_premium: Math.round(netPremium * 100) / 100,
    vix: Math.round(vix * 100) / 100,
    legs,
    timestamp: new Date().toISOString(),
    bridge_status
  };

  return NextResponse.json(payload);
}

// ── POST — start or stop the WebSocket bridge manually ────────────
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);
    const child = spawn(
      PYTHON_EXE,
      [BRIDGE_SCRIPT],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return NextResponse.json({ success: true, message: 'Positions bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}

interface DhanPosition {
  tradingSymbol?: string;
  securityId?: string | number;
  netQty?: number;
  lastPrice?: number;
  exchangeSegment?: string;
  drvOptionType?: string;
  drvStrikePrice?: number | string;
}
