import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');
const WATCHLIST_FILE = path.join(PROJECT_ROOT, 'debug', 'csp_watchlist.json');

interface CspOrderRow {
  orderId: string;
  tradingSymbol: string;
  transactionType: string;
  strike: number;
  expiry: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  orderType: string;
  productType: string;
  status: string;
  securityId: string;
  exchangeSegment: string;
  createTime: string;
  updateTime: string;
}

interface CspTradeRow {
  tradingSymbol: string;
  side: string;
  netQty: number;
  strike: number;
  expiry: string;
  costPrice: number;
  unrealizedProfit: number;
  realizedProfit: number;
  productType: string;
  securityId: string;
  exchangeSegment: string;
}

interface CspRow {
  symbol: string;
  ltp: number;
  lotSize: number;
  activeOrders: CspOrderRow[];
  activeTrades: CspTradeRow[];
}

function readWatchlist(): string[] {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return [];
    const raw = fs.readFileSync(WATCHLIST_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeWatchlist(symbols: string[]) {
  const debugDir = path.join(PROJECT_ROOT, 'debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(symbols, null, 2), 'utf-8');
}

export async function GET() {
  const symbols = readWatchlist();
  if (symbols.length === 0) {
    return NextResponse.json({ success: true, rows: [], asOf: new Date().toISOString() });
  }

  try {
    const parsed = await dedupe('csp-watchlist-list', () =>
      runPythonJson<{ success: boolean; rows?: CspRow[]; asOf?: string; error?: string }>(
        SCRIPT,
        ['list', '--symbols', symbols.join(',')],
        20_000
      )
    );
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error ?? 'Unknown error' }, { status: 500 });
    }
    return NextResponse.json({ success: true, rows: parsed.rows ?? [], asOf: parsed.asOf });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body?.symbol ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }
    const symbols = readWatchlist();
    if (!symbols.includes(symbol)) {
      symbols.push(symbol);
      writeWatchlist(symbols);
    }
    return NextResponse.json({ success: true, symbols });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body?.symbol ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }
    const symbols = readWatchlist().filter((s) => s !== symbol);
    writeWatchlist(symbols);
    return NextResponse.json({ success: true, symbols });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
