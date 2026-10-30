import { NextRequest, NextResponse } from 'next/server';
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { placeZerodhaOrderSliced } from '@/lib/zerodhaPlaceOrder';
import { slicesFor, zerodhaOptionContract } from '@/lib/zerodhaContracts';
import { kotakOptionContract, kotakFutureContract, kotakEquityContract } from '@/lib/kotakContracts';
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

function parseLegMeta(leg: PnfLegInput) {
  const u = leg.underlying ?? leg.displayName?.split(' ')[0] ?? '';
  const expiry = leg.expiry ?? '';
  let strike = leg.strike;
  let optType = leg.optionType;

  if ((!strike || !optType) && leg.displayName) {
    const m = leg.displayName.match(/(\d{4,6})\s+(CALL|PUT|CE|PE)/i);
    if (m) {
      strike = Number(m[1]);
      optType = /CALL|CE/i.test(m[2]) ? 'CE' : 'PE';
    }
  }

  const isOption = optType === 'CE' || optType === 'PE' || /CALL|PUT|CE|PE/i.test(leg.displayName ?? '');
  const isFuture = leg.instrument?.startsWith('FUT') || /FUT/i.test(leg.displayName ?? '');
  const isEquity = leg.instrument === 'EQUITY' || leg.segment === 'NSE_EQ';

  return { underlying: u, expiry, strike, optType, isOption, isFuture, isEquity };
}

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
        const meta = parseLegMeta(leg);
        let tradingsymbol = leg.tradingSymbol ?? '';
        let exchangeSegment = leg.segment === 'MCX_COMM' ? 'mcx_fo' : leg.segment === 'BSE_FNO' ? 'bse_fo' : 'nse_fo';
        let lotSize = leg.lot ?? 1;

        if (meta.isOption && meta.underlying && meta.expiry && meta.strike && meta.optType) {
          const c = await kotakOptionContract(meta.underlying, meta.expiry, meta.strike, meta.optType);
          if (!c) {
            return NextResponse.json({
              success: false,
              error: `Kotak does not list option ${meta.underlying} ${meta.expiry} ${meta.strike} ${meta.optType}`,
            }, { status: 400 });
          }
          tradingsymbol = c.tradingsymbol;
          exchangeSegment = c.segment;
          lotSize = c.lotSize;
        } else if (meta.isFuture && meta.underlying && meta.expiry) {
          const c = await kotakFutureContract(meta.underlying, meta.expiry);
          if (!c) {
            return NextResponse.json({
              success: false,
              error: `Kotak does not list future ${meta.underlying} ${meta.expiry}`,
            }, { status: 400 });
          }
          tradingsymbol = c.tradingsymbol;
          exchangeSegment = c.segment;
          lotSize = c.lotSize;
        } else if (meta.isEquity) {
          const c = await kotakEquityContract(meta.underlying || leg.displayName || leg.securityId);
          if (!c) {
            return NextResponse.json({
              success: false,
              error: `Kotak does not list equity ${meta.underlying || leg.displayName}`,
            }, { status: 400 });
          }
          tradingsymbol = c.tradingsymbol;
          exchangeSegment = 'nse_cm';
          lotSize = 1;
        }

        if (!tradingsymbol) {
          tradingsymbol = leg.tradingSymbol ?? leg.displayName ?? leg.securityId;
        }

        const qty = calculateLegQty({ ...leg, lot: lotSize }, lotsNum, 'kotak');
        const res = await placeKotakOrder({
          es: exchangeSegment,
          pc: productType === 'MARGIN' ? 'NRML' : productType === 'CNC' ? 'CNC' : 'MIS',
          pr: '0',
          pt: 'MKT',
          qt: String(qty),
          rt: 'DAY',
          ts: tradingsymbol,
          tt: action === 'BUY' ? 'B' : 'S',
          am: 'NO',
          dq: '0',
          mp: '0',
          pf: 'N',
          tp: '0',
        });

        if (res.status === 'rejected') {
          return NextResponse.json({ success: false, error: `${tradingsymbol}: ${res.error}` }, { status: 400 });
        }
        results.push({ symbol: tradingsymbol, orderId: res.status === 'placed' ? res.orderId : undefined, status: res.status });
      }
      invalidateBrokerCache('kotak');
      return NextResponse.json({ success: true, mode: 'REAL', broker: 'kotak', orders: results });
    }

    // ── REAL TRADING: ZERODHA ──────────────────────────────────────────────────
    if (broker === 'zerodha') {
      const results = [];
      for (const leg of legs) {
        const meta = parseLegMeta(leg);
        let tradingsymbol = leg.tradingSymbol ?? '';
        let exchange: 'NFO' | 'BFO' | 'MCX' | 'NSE' = leg.segment === 'MCX_COMM' ? 'MCX' : leg.segment === 'BSE_FNO' ? 'BFO' : 'NFO';
        let lotSize = leg.lot ?? 1;

        if (meta.isOption && meta.underlying && meta.expiry && meta.strike && meta.optType) {
          const c = await zerodhaOptionContract(meta.underlying, meta.expiry, meta.strike, meta.optType);
          if (!c) {
            return NextResponse.json({
              success: false,
              error: `Zerodha does not list option ${meta.underlying} ${meta.expiry} ${meta.strike} ${meta.optType}`,
            }, { status: 400 });
          }
          tradingsymbol = c.tradingsymbol;
          exchange = c.exchange;
          lotSize = c.lotSize;
        } else if (meta.isEquity) {
          tradingsymbol = meta.underlying || leg.displayName || leg.securityId;
          exchange = 'NSE';
          lotSize = 1;
        }

        if (!tradingsymbol) {
          tradingsymbol = leg.tradingSymbol ?? leg.displayName ?? leg.securityId;
        }

        const qty = calculateLegQty({ ...leg, lot: lotSize }, lotsNum, 'zerodha');
        const slices = slicesFor(String(tradingsymbol), qty);
        const res = await placeZerodhaOrderSliced({
          tradingsymbol,
          transaction_type: action,
          order_type: 'MARKET',
          quantity: qty,
          exchange,
          product: productType === 'MARGIN' ? 'NRML' : productType === 'CNC' ? 'CNC' : 'MIS',
          validity: 'DAY',
          market_protection: -1,
        }, slices);

        if (res.status === 'rejected') {
          return NextResponse.json({ success: false, error: `${tradingsymbol}: ${res.error}` }, { status: 400 });
        }
        results.push({ symbol: tradingsymbol, orderId: res.status === 'placed' ? res.orderId : undefined, status: res.status });
      }
      invalidateBrokerCache('zerodha');
      return NextResponse.json({ success: true, mode: 'REAL', broker: 'zerodha', orders: results });
    }

    return NextResponse.json({ success: false, error: `Unsupported broker: ${broker}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Execution error: ${(err as Error).message}` }, { status: 500 });
  }
}
