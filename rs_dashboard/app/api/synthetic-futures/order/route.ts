import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { kotakPost, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { kitePost, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';

interface StrikeIdentifier {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export interface SyntheticLegSpec {
  role: 'MAIN_CE' | 'MAIN_PE' | 'HEDGE' | 'EXIT';
  optionType: 'CE' | 'PE' | '';
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
  status: 'FILLED' | 'TRANSIT' | 'FAILED' | 'SKIPPED';
  error?: string;
}

function toKotakExchange(segment: string, isSensex: boolean): string {
  if (isSensex || segment.toLowerCase().includes('bse')) return 'bse_fo';
  return 'nse_fo';
}

function toZerodhaExchange(segment: string, isSensex: boolean): string {
  if (isSensex || segment.toUpperCase().includes('BSE')) return 'BFO';
  return 'NFO';
}

async function placeKotakLeg(leg: SyntheticLegSpec): Promise<{ orderId?: string; error?: string }> {
  if (!leg.tradingSymbol) {
    return { error: `Missing Kotak tradingsymbol for ${leg.strike} ${leg.optionType}` };
  }

  const isLimit = leg.orderType === 'LIMIT';
  const tickPrice = isLimit && leg.price ? (Math.round(leg.price / 0.05) * 0.05).toFixed(2) : '0';
  const product = leg.productType === 'MARGIN' ? 'NRML' : 'MIS';
  const es = toKotakExchange(leg.exchangeSegment, leg.exchangeSegment.toLowerCase().includes('bse'));

  try {
    const json = await kotakPost(KOTAK_PATHS.placeOrder, {
      es,
      pc: product,
      pr: tickPrice,
      pt: isLimit ? 'L' : 'MKT',
      qt: String(Math.abs(leg.quantity)),
      rt: 'DAY',
      ts: leg.tradingSymbol,
      tt: leg.side === 'BUY' ? 'B' : 'S',
      am: 'NO',
      dq: '0',
      mp: '0',
      pf: 'N',
      tp: '0',
      os: 'NEOTRADEAPI',
    });

    const data = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
    const orderId = json.nOrdNo ?? data.nOrdNo;
    if (json.stat === 'Ok' && orderId) {
      return { orderId: String(orderId) };
    }
    const errMsg = String(json.errMsg ?? json.message ?? JSON.stringify(json));
    return { error: errMsg };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
}

async function placeZerodhaLeg(leg: SyntheticLegSpec): Promise<{ orderId?: string; error?: string }> {
  if (!leg.tradingSymbol) {
    return { error: `Missing Zerodha tradingsymbol for ${leg.strike} ${leg.optionType}` };
  }

  const isLimit = leg.orderType === 'LIMIT';
  const product = leg.productType === 'MARGIN' ? 'NRML' : 'MIS';
  const exchange = toZerodhaExchange(leg.exchangeSegment, leg.exchangeSegment.toUpperCase().includes('BSE'));

  try {
    const params: Record<string, string | number> = {
      tradingsymbol: leg.tradingSymbol,
      exchange,
      transaction_type: leg.side,
      order_type: isLimit ? 'LIMIT' : 'MARKET',
      quantity: Math.abs(leg.quantity),
      product,
      validity: 'DAY',
    };
    if (isLimit && leg.price) {
      params.price = Number(leg.price);
    } else {
      params.market_protection = -1;
    }

    const data = (await kitePost('/orders/regular', params)) as { order_id?: string; orderId?: string };
    const orderId = data?.order_id ?? data?.orderId;
    if (orderId) {
      return { orderId: String(orderId) };
    }
    return { error: 'No order_id returned from Kite' };
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
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

async function placeBrokerLeg(
  broker: 'dhan' | 'zerodha' | 'kotak',
  dhanToken: string,
  dhanClientId: string,
  leg: SyntheticLegSpec,
): Promise<{ orderId?: string; error?: string }> {
  if (broker === 'dhan') {
    return placeDhanLeg(dhanToken, dhanClientId, leg);
  } else if (broker === 'kotak') {
    return placeKotakLeg(leg);
  } else if (broker === 'zerodha') {
    return placeZerodhaLeg(leg);
  }
  return { error: `Unsupported broker: ${broker}` };
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
  const defaultExchangeSegment =
    broker === 'kotak'
      ? isSensex ? 'bse_fo' : 'nse_fo'
      : broker === 'zerodha'
        ? isSensex ? 'BFO' : 'NFO'
        : isSensex ? 'BSE_FNO' : 'NSE_FNO';

  // ───────────────────────────────────────────────────────────────────────────
  // EXIT / FLATTEN ACTION
  // ───────────────────────────────────────────────────────────────────────────
  if (action === 'exit') {
    if (!legsToExit || legsToExit.length === 0) {
      return NextResponse.json({ success: false, error: 'No legs provided for exit' }, { status: 400 });
    }

    let dhanToken = '';
    let dhanClientId = '';
    if (broker === 'dhan') {
      const creds = getDhanCredentials();
      if (!creds.token) {
        return NextResponse.json({ success: false, error: 'No valid Dhan credentials' }, { status: 401 });
      }
      dhanToken = creds.token;
      dhanClientId = creds.clientId;
    } else if (broker === 'kotak') {
      if (!isKotakTokenValid()) {
        return NextResponse.json({
          success: false,
          error: 'Kotak Neo session expired or missing. Please refresh Kotak token via autologin.',
        }, { status: 401 });
      }
    } else if (broker === 'zerodha') {
      if (!isZerodhaTokenValid()) {
        return NextResponse.json({
          success: false,
          error: 'Zerodha session expired or missing. Please refresh Zerodha token via autologin.',
        }, { status: 401 });
      }
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
      const res = await placeBrokerLeg(broker, dhanToken, dhanClientId, {
        role: 'EXIT',
        optionType: '',
        strike: 0,
        side: leg.side,
        quantity: Math.abs(leg.quantity),
        securityId: leg.securityId,
        tradingSymbol: leg.tradingSymbol,
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

    invalidateBrokerCache(broker);
    const allSuccess = results.every(r => r.orderId);
    return NextResponse.json({
      success: allSuccess,
      action: 'exit',
      results,
    });
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
  if (!atmIdent) {
    return NextResponse.json({
      success: false,
      error: `ATM Strike ${atmStrike} not found in strike identifiers lookup for ${broker}`,
    }, { status: 400 });
  }

  if (broker === 'dhan' && (!atmIdent.ceId || !atmIdent.peId)) {
    return NextResponse.json({
      success: false,
      error: `ATM Strike ${atmStrike} CE/PE Dhan security IDs missing in strike lookup`,
    }, { status: 400 });
  }

  if ((broker === 'kotak' || broker === 'zerodha') && (!atmIdent.ceSymbol || !atmIdent.peSymbol)) {
    return NextResponse.json({
      success: false,
      error: `ATM Strike ${atmStrike} CE/PE trading symbols missing for ${broker}. Please ensure option instruments are cached.`,
    }, { status: 400 });
  }

  if (direction === 'LONG') {
    // Synthetic Long: BUY ATM CE + SELL ATM PE
    // If hedge enabled: BUY OTM PE (atmStrike - hedgeOffset)
    if (hedgeEnabled && hedgeOffset > 0) {
      const hedgeStrike = atmStrike - hedgeOffset;
      const hedgeIdent = strikeMap[String(hedgeStrike)];
      const hasHedge = broker === 'dhan' ? Boolean(hedgeIdent?.peId) : Boolean(hedgeIdent?.peSymbol);
      if (!hasHedge) {
        return NextResponse.json({
          success: false,
          error: `Protective hedge strike ${hedgeStrike} PE not found in ${broker} strike lookup. Aborting for margin safety.`,
        }, { status: 400 });
      }
      legsToBuild.push({
        role: 'HEDGE',
        optionType: 'PE',
        strike: hedgeStrike,
        side: 'BUY',
        quantity: totalQty,
        securityId: hedgeIdent?.peId,
        tradingSymbol: hedgeIdent?.peSymbol,
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
      tradingSymbol: atmIdent.ceSymbol,
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
      tradingSymbol: atmIdent.peSymbol,
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
      const hasHedge = broker === 'dhan' ? Boolean(hedgeIdent?.ceId) : Boolean(hedgeIdent?.ceSymbol);
      if (!hasHedge) {
        return NextResponse.json({
          success: false,
          error: `Protective hedge strike ${hedgeStrike} CE not found in ${broker} strike lookup. Aborting for margin safety.`,
        }, { status: 400 });
      }
      legsToBuild.push({
        role: 'HEDGE',
        optionType: 'CE',
        strike: hedgeStrike,
        side: 'BUY',
        quantity: totalQty,
        securityId: hedgeIdent?.ceId,
        tradingSymbol: hedgeIdent?.ceSymbol,
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
      tradingSymbol: atmIdent.peSymbol,
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
      tradingSymbol: atmIdent.ceSymbol,
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

  let dhanToken = '';
  let dhanClientId = '';
  if (broker === 'dhan') {
    const creds = getDhanCredentials();
    if (!creds.token) {
      return NextResponse.json({ success: false, error: 'No valid Dhan credentials' }, { status: 401 });
    }
    dhanToken = creds.token;
    dhanClientId = creds.clientId;
  } else if (broker === 'kotak') {
    if (!isKotakTokenValid()) {
      return NextResponse.json({
        success: false,
        error: 'Kotak Neo session expired or missing. Please refresh Kotak token via autologin.',
      }, { status: 401 });
    }
  } else if (broker === 'zerodha') {
    if (!isZerodhaTokenValid()) {
      return NextResponse.json({
        success: false,
        error: 'Zerodha session expired or missing. Please refresh Zerodha token via autologin.',
      }, { status: 401 });
    }
  }

  const executedResults: ExecutedLegResult[] = [];
  const orderIds: string[] = [];

  // Sequential execution to guarantee BUY fills before SELL leg is submitted for basket margin!
  // Abort remaining legs on the first failure — a failed BUY (e.g. the protective hedge)
  // must never be followed by its dependent SELL leg going out naked.
  let aborted = false;
  for (const leg of sortedLegs) {
    if (aborted) {
      executedResults.push({
        role: leg.role,
        optionType: leg.optionType,
        strike: leg.strike,
        side: leg.side,
        quantity: leg.quantity,
        status: 'SKIPPED',
        error: 'Not submitted — an earlier leg in this basket failed',
      });
      continue;
    }

    const exec = await placeBrokerLeg(broker, dhanToken, dhanClientId, leg);
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
      aborted = true;
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

  invalidateBrokerCache(broker);

  const hasFailure = executedResults.some(r => r.status === 'FAILED' || r.status === 'SKIPPED');

  return NextResponse.json({
    success: !hasFailure,
    direction,
    atmStrike,
    lots,
    lotSize,
    totalQty,
    orderIds,
    legs: executedResults,
    error: hasFailure ? `One or more ${broker} legs failed: ${executedResults.filter(r => r.error).map(r => r.error).join('; ')}` : undefined,
  });
}
