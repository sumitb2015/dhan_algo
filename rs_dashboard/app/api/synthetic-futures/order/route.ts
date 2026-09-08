import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';

interface StrikeIdentifier {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export interface SyntheticLegSpec {
  role: 'MAIN_CE' | 'MAIN_PE' | 'HEDGE';
  optionType: 'CE' | 'PE';
  strike: number;
  side: 'BUY' | 'SELL';
  quantity: number;
  securityId?: string;
  tradingSymbol?: string;
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
  productType: 'INTRADAY' | 'MARGIN';
  exchangeSegment: string;
}

interface ExecutedLegResult {
  role: string;
  optionType: string;
  strike: number;
  side: string;
  quantity: number;
  orderId?: string;
  status: 'FILLED' | 'TRANSIT' | 'FAILED';
  error?: string;
}

async function placeDhanLeg(
  token: string,
  clientId: string,
  leg: SyntheticLegSpec,
): Promise<{ orderId?: string; error?: string }> {
  if (!leg.securityId) {
    return { error: `Missing securityId for ${leg.strike} ${leg.optionType}` };
  }

  const payload = {
    dhanClientId: clientId,
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
    const res = await fetch(DHAN_ORDERS, {
      method: 'POST',
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = (await res.json()) as Record<string, unknown>;
    const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
    if (orderId) {
      return { orderId };
    }
    const errMsg = String(json.remarks ?? json.message ?? JSON.stringify(json));
    return { error: errMsg };
  } catch (err) {
    return { error: String(err) };
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as {
    action: 'enter' | 'exit';
    broker?: 'dhan' | 'zerodha' | 'kotak';
    underlying: 'NIFTY' | 'SENSEX' | 'BANKNIFTY';
    expiry: string;
    direction?: 'LONG' | 'SHORT';
    atmStrike?: number;
    lots?: number;
    lotSize?: number;
    hedgeEnabled?: boolean;
    hedgeOffset?: number;
    productType?: 'INTRADAY' | 'MARGIN';
    orderType?: 'MARKET' | 'LIMIT';
    strikeMap?: Record<string, StrikeIdentifier>;
    legsToExit?: Array<{
      securityId?: string;
      tradingSymbol?: string;
      quantity: number;
      side: 'BUY' | 'SELL'; // exit transaction side
      productType?: string;
      exchangeSegment?: string;
    }>;
  };

  const {
    action = 'enter',
    broker = 'dhan',
    underlying = 'NIFTY',
    expiry,
    direction = 'LONG',
    atmStrike,
    lots = 1,
    lotSize = 75,
    hedgeEnabled = false,
    hedgeOffset = 200,
    productType = 'INTRADAY',
    orderType = 'MARKET',
    strikeMap = {},
    legsToExit = [],
  } = body;

  const isSensex = underlying === 'SENSEX';
  const defaultExchangeSegment = isSensex ? 'BSE_FNO' : 'NSE_FNO';

  // ───────────────────────────────────────────────────────────────────────────
  // EXIT / FLATTEN ACTION
  // ───────────────────────────────────────────────────────────────────────────
  if (action === 'exit') {
    if (!legsToExit || legsToExit.length === 0) {
      return NextResponse.json({ success: false, error: 'No legs provided for exit' }, { status: 400 });
    }

    if (broker === 'dhan') {
      const { clientId, token } = getDhanCredentials();
      if (!token) {
        return NextResponse.json({ success: false, error: 'No valid Dhan credentials' }, { status: 401 });
      }

      const results: ExecutedLegResult[] = [];

      // Margin-safe exit ordering:
      // Execute BUY orders first (covering short option legs) so margin requirement drops to zero,
      // before executing SELL orders (liquidating long option/hedge legs).
      const sortedExitLegs = [
        ...legsToExit.filter(l => l.side === 'BUY'),
        ...legsToExit.filter(l => l.side === 'SELL'),
      ];

      for (const leg of sortedExitLegs) {
        if (!leg.securityId) continue;
        const res = await placeDhanLeg(token, clientId, {
          role: 'MAIN_CE',
          optionType: 'CE',
          strike: 0,
          side: leg.side,
          quantity: Math.abs(leg.quantity),
          securityId: leg.securityId,
          orderType: 'MARKET',
          productType: (leg.productType as 'INTRADAY' | 'MARGIN') || 'INTRADAY',
          exchangeSegment: leg.exchangeSegment || defaultExchangeSegment,
        });

        results.push({
          role: 'EXIT',
          optionType: '',
          strike: 0,
          side: leg.side,
          quantity: Math.abs(leg.quantity),
          orderId: res.orderId,
          status: res.orderId ? 'TRANSIT' : 'FAILED',
          error: res.error,
        });
      }

      invalidateBrokerCache('dhan');
      const allSuccess = results.every(r => r.orderId);
      return NextResponse.json({
        success: allSuccess,
        action: 'exit',
        results,
      });
    }

    return NextResponse.json({ success: false, error: `Direct exit for broker ${broker} is not implemented` }, { status: 400 });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ENTER SYNTHETIC POSITION ACTION
  // ───────────────────────────────────────────────────────────────────────────
  if (!atmStrike || atmStrike <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid ATM strike' }, { status: 400 });
  }

  const totalQty = lots * lotSize;
  const legsToBuild: SyntheticLegSpec[] = [];

  const atmIdent = strikeMap[String(atmStrike)];
  if (!atmIdent || !atmIdent.ceId || !atmIdent.peId) {
    return NextResponse.json({
      success: false,
      error: `ATM Strike ${atmStrike} CE/PE identifiers missing in strike lookup`,
    }, { status: 400 });
  }

  if (direction === 'LONG') {
    // Synthetic Long: BUY ATM CE + SELL ATM PE
    // If hedge enabled: BUY OTM PE (atmStrike - hedgeOffset)
    if (hedgeEnabled && hedgeOffset > 0) {
      const hedgeStrike = atmStrike - hedgeOffset;
      const hedgeIdent = strikeMap[String(hedgeStrike)];
      if (!hedgeIdent?.peId) {
        return NextResponse.json({
          success: false,
          error: `Protective hedge strike ${hedgeStrike} PE not found in strike lookup. Aborting for margin safety.`,
        }, { status: 400 });
      }
      legsToBuild.push({
        role: 'HEDGE',
        optionType: 'PE',
        strike: hedgeStrike,
        side: 'BUY',
        quantity: totalQty,
        securityId: hedgeIdent.peId,
        orderType,
        productType,
        exchangeSegment: defaultExchangeSegment,
      });
    }

    // Main CE Leg: BUY ATM CE
    legsToBuild.push({
      role: 'MAIN_CE',
      optionType: 'CE',
      strike: atmStrike,
      side: 'BUY',
      quantity: totalQty,
      securityId: atmIdent.ceId,
      orderType,
      productType,
      exchangeSegment: defaultExchangeSegment,
    });

    // Main PE Leg: SELL ATM PE
    legsToBuild.push({
      role: 'MAIN_PE',
      optionType: 'PE',
      strike: atmStrike,
      side: 'SELL',
      quantity: totalQty,
      securityId: atmIdent.peId,
      orderType,
      productType,
      exchangeSegment: defaultExchangeSegment,
    });
  } else {
    // Synthetic Short: SELL ATM CE + BUY ATM PE
    // If hedge enabled: BUY OTM CE (atmStrike + hedgeOffset)
    if (hedgeEnabled && hedgeOffset > 0) {
      const hedgeStrike = atmStrike + hedgeOffset;
      const hedgeIdent = strikeMap[String(hedgeStrike)];
      if (!hedgeIdent?.ceId) {
        return NextResponse.json({
          success: false,
          error: `Protective hedge strike ${hedgeStrike} CE not found in strike lookup. Aborting for margin safety.`,
        }, { status: 400 });
      }
      legsToBuild.push({
        role: 'HEDGE',
        optionType: 'CE',
        strike: hedgeStrike,
        side: 'BUY',
        quantity: totalQty,
        securityId: hedgeIdent.ceId,
        orderType,
        productType,
        exchangeSegment: defaultExchangeSegment,
      });
    }

    // Main PE Leg: BUY ATM PE
    legsToBuild.push({
      role: 'MAIN_PE',
      optionType: 'PE',
      strike: atmStrike,
      side: 'BUY',
      quantity: totalQty,
      securityId: atmIdent.peId,
      orderType,
      productType,
      exchangeSegment: defaultExchangeSegment,
    });

    // Main CE Leg: SELL ATM CE
    legsToBuild.push({
      role: 'MAIN_CE',
      optionType: 'CE',
      strike: atmStrike,
      side: 'SELL',
      quantity: totalQty,
      securityId: atmIdent.ceId,
      orderType,
      productType,
      exchangeSegment: defaultExchangeSegment,
    });
  }

  // Margin safety: Sort legs so BUY legs are submitted first!
  const sortedLegs: SyntheticLegSpec[] = [
    ...legsToBuild.filter(l => l.side === 'BUY'),
    ...legsToBuild.filter(l => l.side === 'SELL'),
  ];

  if (broker === 'dhan') {
    const { clientId, token } = getDhanCredentials();
    if (!token) {
      return NextResponse.json({ success: false, error: 'No valid Dhan credentials' }, { status: 401 });
    }

    const executedResults: ExecutedLegResult[] = [];
    const orderIds: string[] = [];

    // Sequential execution to guarantee BUY fills before SELL leg is submitted for basket margin!
    for (const leg of sortedLegs) {
      const exec = await placeDhanLeg(token, clientId, leg);
      if (exec.orderId) {
        orderIds.push(exec.orderId);
        executedResults.push({
          role: leg.role,
          optionType: leg.optionType,
          strike: leg.strike,
          side: leg.side,
          quantity: leg.quantity,
          orderId: exec.orderId,
          status: 'TRANSIT',
        });
      } else {
        executedResults.push({
          role: leg.role,
          optionType: leg.optionType,
          strike: leg.strike,
          side: leg.side,
          quantity: leg.quantity,
          status: 'FAILED',
          error: exec.error,
        });
      }
    }

    invalidateBrokerCache('dhan');

    const hasFailure = executedResults.some(r => r.status === 'FAILED');

    return NextResponse.json({
      success: !hasFailure,
      direction,
      atmStrike,
      lots,
      lotSize,
      totalQty,
      orderIds,
      legs: executedResults,
      error: hasFailure ? 'One or more legs failed to execute' : undefined,
    });
  }

  return NextResponse.json({
    success: false,
    error: `Broker ${broker} not yet supported in direct multi-leg execution`,
  }, { status: 400 });
}
