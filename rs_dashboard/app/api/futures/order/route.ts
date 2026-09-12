import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { runPythonJson, PROJECT_ROOT } from '@/lib/pyExec';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

const FUTURES_API_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'futures_api.py');

export interface FuturesLookupData {
  symbol: string;
  securityId: string;
  displayName: string;
  tradingSymbol: string;
  expiry: string;
  lotSize: number;
  exchange: string;
  instrument: string;
  exchangeSegment: string;
  ltp: number;
  tickSize: number;
}

interface LookupResponse {
  success: boolean;
  data?: FuturesLookupData;
  error?: string;
}

interface OrderResponse {
  success: boolean;
  orderId?: string;
  securityId?: string;
  displayName?: string;
  symbol?: string;
  side?: string;
  lots?: number;
  lotSize?: number;
  quantity?: number;
  orderType?: string;
  productType?: string;
  price?: number;
  error?: string;
}

// ─── GET: Lookup Futures Contract Details ─────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.trim().toUpperCase();
  const expiry = searchParams.get('expiry')?.trim() || '';

  if (!symbol) {
    return NextResponse.json({ success: false, error: 'Missing required symbol param' }, { status: 400 });
  }

  try {
    const args = ['lookup', '--underlying', symbol];
    if (expiry) args.push('--expiry', expiry);

    const res = await runPythonJson<LookupResponse>(FUTURES_API_SCRIPT, args, 10_000);
    return NextResponse.json(res);
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Lookup failed' },
      { status: 500 }
    );
  }
}

// ─── POST: Place Futures Order ────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      symbol,
      expiry,
      side = 'BUY',
      lots = 1,
      orderType = 'MARKET',
      price = 0,
      productType = 'INTRADAY',
    } = body;

    const cleanSymbol = String(symbol ?? '').trim().toUpperCase();
    if (!cleanSymbol) {
      return NextResponse.json({ success: false, error: 'Missing contract symbol' }, { status: 400 });
    }

    const cleanSide = String(side).toUpperCase();
    if (cleanSide !== 'BUY' && cleanSide !== 'SELL') {
      return NextResponse.json({ success: false, error: 'Invalid side. Must be BUY or SELL.' }, { status: 400 });
    }

    const lotsNum = Math.max(1, parseInt(String(lots), 10) || 1);
    const cleanType = String(orderType).toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const cleanProduct = String(productType).toUpperCase() === 'MARGIN' ? 'MARGIN' : 'INTRADAY';
    const priceNum = cleanType === 'LIMIT' ? parseFloat(String(price)) || 0 : 0;

    if (cleanType === 'LIMIT' && priceNum <= 0) {
      return NextResponse.json({ success: false, error: 'Limit orders require a positive price' }, { status: 400 });
    }

    const args = [
      'order',
      '--underlying', cleanSymbol,
      '--side', cleanSide,
      '--lots', String(lotsNum),
      '--type', cleanType,
      '--price', String(priceNum),
      '--product', cleanProduct,
    ];
    if (expiry) args.push('--expiry', String(expiry).trim());

    const result = await runPythonJson<OrderResponse>(FUTURES_API_SCRIPT, args, 25_000);

    if (result.success) {
      // Invalidate position caches so subsequent scalp/position polling sees the new contract
      try {
        invalidateBrokerCache('dhan');
      } catch {}
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Order execution failed' },
      { status: 500 }
    );
  }
}
