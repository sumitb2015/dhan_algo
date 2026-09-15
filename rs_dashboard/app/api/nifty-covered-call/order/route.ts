import { NextRequest, NextResponse } from 'next/server';
import { dhanPost } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

// Dhan-only order placement for the Nifty Futures Covered Call desk — real
// money. Leg shape mirrors SyntheticLegSpec from
// app/api/synthetic-futures/order/route.ts, minus the Kotak/Zerodha branches
// (this desk is Dhan-only by explicit decision).
export interface CoveredCallLegSpec {
  role: 'FUTURE' | 'CALL';
  side: 'BUY' | 'SELL';
  quantity: number;
  securityId?: string;
  tradingSymbol?: string;
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
  productType: 'INTRADAY' | 'MARGIN';
  exchangeSegment: string;
}

interface DhanOrderResult {
  orderId?: string;
  error?: string;
}

async function placeDhanLeg(leg: CoveredCallLegSpec): Promise<DhanOrderResult> {
  if (!leg.securityId) {
    return { error: `Missing securityId for ${leg.role} leg` };
  }

  const payload = {
    transactionType: leg.side,
    exchangeSegment: leg.exchangeSegment,
    productType: leg.productType,
    orderType: leg.orderType,
    validity: 'DAY',
    securityId: String(leg.securityId),
    quantity: leg.quantity,
    disclosedQuantity: 0,
    price: leg.orderType === 'LIMIT' && leg.price ? leg.price : 0,
    afterMarketOrder: false,
    boProfitValue: 0,
    boStopLossValue: 0,
    triggerPrice: 0,
  };

  try {
    const json = (await dhanPost('/orders', payload)) as Record<string, unknown>;
    const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
    if (orderId) return { orderId };
    return { error: String(json.remarks ?? json.message ?? JSON.stringify(json)) };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as { leg?: CoveredCallLegSpec };
  const leg = body.leg;

  if (!leg || !leg.side || !leg.quantity || leg.quantity <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid leg spec' }, { status: 400 });
  }
  if (leg.role !== 'FUTURE' && leg.role !== 'CALL') {
    return NextResponse.json({ success: false, error: `Unsupported leg role: ${leg.role}` }, { status: 400 });
  }
  if (!leg.securityId) {
    return NextResponse.json({ success: false, error: `Missing Dhan securityId for ${leg.role} leg` }, { status: 400 });
  }

  const result = await placeDhanLeg(leg);

  if (result.orderId) {
    invalidateBrokerCache('dhan');
  }

  return NextResponse.json({
    success: Boolean(result.orderId),
    role: leg.role,
    side: leg.side,
    quantity: leg.quantity,
    orderId: result.orderId,
    error: result.error,
  });
}
