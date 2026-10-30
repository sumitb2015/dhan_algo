import { NextRequest, NextResponse } from 'next/server';
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { placeZerodhaOrderSliced } from '@/lib/zerodhaPlaceOrder';
import { slicesFor } from '@/lib/zerodhaContracts';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import {
  MAX_PNF_LOTS,
  validatePnfOrder,
  calculateLegQty,
  buildPaperFills,
  type PnfOrderBody,
  type PnfLegInput,
} from '@/lib/pnfOrderLogic';

export { MAX_PNF_LOTS, type PnfOrderBody, type PnfLegInput };

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as PnfOrderBody;
    const { broker = 'dhan', mode = 'PAPER', action, productType = 'INTRADAY', legs } = body;

    const validation = validatePnfOrder(body);
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const lotsNum = validation.lotsNum;

    // ── PAPER TRADING ──────────────────────────────────────────────────────────
    if (mode === 'PAPER') {
      const fills = buildPaperFills(legs, action, lotsNum, broker);
      return NextResponse.json({
        success: true,
        mode: 'PAPER',
        message: `Paper ${action} ${lotsNum} lot${lotsNum > 1 ? 's' : ''} executed`,
        fills,
      });
    }

    // ── REAL TRADING: DHAN ─────────────────────────────────────────────────────
    if (broker === 'dhan') {
      const results = [];
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const qty = calculateLegQty(leg, lotsNum, 'dhan');

        const res = await placeDhanOrder({
          securityId: String(leg.securityId),
          quantity: qty,
          side: action,
          orderType: 'MARKET',
          exchangeSegment: leg.segment,
          productType: leg.segment === 'NSE_EQ' && productType === 'CNC' ? 'CNC' : productType === 'MARGIN' ? 'MARGIN' : 'INTRADAY',
          source: 'pnf',
        });

        if (res.status === 'invalid' || res.status === 'rejected') {
          return NextResponse.json({ success: false, error: `${leg.displayName ?? leg.securityId}: ${res.error}` }, { status: 400 });
        }
        results.push({
          securityId: leg.securityId,
          orderId: res.status === 'placed' ? res.orderId : undefined,
          status: res.status,
          error: 'error' in res ? res.error : undefined,
        });
      }
      invalidateBrokerCache('dhan');
      return NextResponse.json({
        success: true,
        mode: 'REAL',
        broker: 'dhan',
        orders: results,
      });
    }

    // ── REAL TRADING: KOTAK ────────────────────────────────────────────────────
    if (broker === 'kotak') {
      const results = [];
      for (const leg of legs) {
        const symbol = leg.tradingSymbol ?? leg.displayName ?? leg.securityId;
        const qty = calculateLegQty(leg, lotsNum, 'kotak');
        const res = await placeKotakOrder({
          ts: symbol,
          qt: String(qty),
          tt: action === 'BUY' ? 'B' : 'S',
          pt: productType === 'MARGIN' ? 'NRML' : 'MIS',
          pc: leg.segment === 'MCX_COMM' ? 'mcx_fo' : leg.segment === 'BSE_FNO' ? 'bse_fo' : 'nse_fo',
        });
        if (res.status === 'rejected') {
          return NextResponse.json({ success: false, error: `${symbol}: ${res.error}` }, { status: 400 });
        }
        results.push({ symbol, orderId: res.status === 'placed' ? res.orderId : undefined, status: res.status });
      }
      invalidateBrokerCache('kotak');
      return NextResponse.json({ success: true, mode: 'REAL', broker: 'kotak', orders: results });
    }

    // ── REAL TRADING: ZERODHA ──────────────────────────────────────────────────
    if (broker === 'zerodha') {
      const results = [];
      for (const leg of legs) {
        const symbol = leg.tradingSymbol ?? leg.displayName ?? leg.securityId;
        const qty = calculateLegQty(leg, lotsNum, 'zerodha');
        const slices = slicesFor(String(symbol), qty);
        const res = await placeZerodhaOrderSliced({
          tradingsymbol: symbol,
          transaction_type: action,
          order_type: 'MARKET',
          quantity: qty,
          exchange: leg.segment === 'MCX_COMM' ? 'MCX' : leg.segment === 'BSE_FNO' ? 'BFO' : 'NFO',
          product: productType === 'MARGIN' ? 'NRML' : 'MIS',
          validity: 'DAY',
          market_protection: -1,
        }, slices);
        if (res.status === 'rejected') {
          return NextResponse.json({ success: false, error: `${symbol}: ${res.error}` }, { status: 400 });
        }
        results.push({ symbol, orderId: res.status === 'placed' ? res.orderId : undefined, status: res.status });
      }
      invalidateBrokerCache('zerodha');
      return NextResponse.json({ success: true, mode: 'REAL', broker: 'zerodha', orders: results });
    }

    return NextResponse.json({ success: false, error: `Unsupported broker: ${broker}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Execution error: ${(err as Error).message}` }, { status: 500 });
  }
}
