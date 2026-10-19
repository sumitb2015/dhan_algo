import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { isKotakTokenValid } from '@/lib/kotakToken';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { placeZerodhaOrder } from '@/lib/zerodhaPlaceOrder';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { exchangeSegmentFor, isCrudeUnderlying, type SyntheticFuturesUnderlying } from '@/lib/syntheticFuturesSegments';
import {
  DEFAULT_HEDGE,
  buildHedgeWings,
  sanitizeHedgeConfig,
  MAX_SYNTHETIC_LOTS,
  RATIO_CHOICES,
  uncoveredShortLots,
  wingOffsetsFor,
  type HedgeConfig,
} from '@/lib/syntheticHedge';

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';

interface StrikeIdentifier {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export interface SyntheticLegSpec {
  role: 'MAIN_CE' | 'MAIN_PE' | 'HEDGE' | 'HEDGE_SELL' | 'EXIT' | 'ADD_LEG';
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
  // The contract this leg was (or would have been) placed on, so the client
  // ledger records what the server sent rather than re-deriving it.
  securityId?: string;
  tradingSymbol?: string;
  status: 'FILLED' | 'TRANSIT' | 'FAILED' | 'SKIPPED';
  error?: string;
  /** FAILED as far as this request knows, but the broker never answered cleanly: the order MAY be live (Kotak). */
  unknown?: boolean;
}

function toKotakExchange(segment: string, isSensex: boolean): string {
  if (segment.toLowerCase().includes('mcx')) return 'mcx_fo';
  if (isSensex || segment.toLowerCase().includes('bse')) return 'bse_fo';
  return 'nse_fo';
}

// Zerodha has no MCX crude support — the POST guard below rejects broker
// 'zerodha' for CRUDEOIL/CRUDEOILM before a leg can ever reach this function,
// so it only ever needs to distinguish BSE from NSE.
function toZerodhaExchange(segment: string, isSensex: boolean): string {
  if (isSensex || segment.toUpperCase().includes('BSE')) return 'BFO';
  return 'NFO';
}

async function placeKotakLeg(leg: SyntheticLegSpec): Promise<{ orderId?: string; error?: string; unknown?: boolean }> {
  if (!leg.tradingSymbol) {
    return { error: `Missing Kotak tradingsymbol for ${leg.strike} ${leg.optionType}` };
  }

  const isLimit = leg.orderType === 'LIMIT';
  const tickPrice = isLimit && leg.price ? (Math.round(leg.price / 0.05) * 0.05).toFixed(2) : '0';
  const product = leg.productType === 'MARGIN' ? 'NRML' : 'MIS';
  const es = toKotakExchange(leg.exchangeSegment, leg.exchangeSegment.toLowerCase().includes('bse'));

  const r = await placeKotakOrder({
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
  if (r.status === 'placed') return { orderId: r.orderId };
  // An unknown outcome may be a live order: flagged so the basket stops there and the page says "check", not "failed".
  return { error: r.error, ...(r.status === 'unknown' ? { unknown: true } : {}) };
}

async function placeZerodhaLeg(leg: SyntheticLegSpec): Promise<{ orderId?: string; error?: string; unknown?: boolean }> {
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

    const r = await placeZerodhaOrder(params);
    if (r.status === 'placed') return { orderId: r.orderId };
    return { error: r.error, ...(r.status === 'unknown' ? { unknown: true } : {}) };
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
): Promise<{ orderId?: string; error?: string; unknown?: boolean }> {
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
    action: 'enter' | 'exit' | 'addLeg';
    broker?: 'dhan' | 'zerodha' | 'kotak';
    underlying: 'NIFTY' | 'SENSEX' | 'BANKNIFTY' | 'CRUDEOIL' | 'CRUDEOILM';
    expiry: string;
    direction?: 'LONG' | 'SHORT';
    atmStrike?: number;
    lots?: number;
    lotSize?: number;
    hedge?: Partial<HedgeConfig>;
    // Must be true for a sold wing larger than the synthetic's own long ATM
    // option (sellRatio > 1) — those extra lots are naked short options.
    acknowledgeUncovered?: boolean;
    // Legacy pre-hedge-modes request shape: mapped to PROTECTIVE 1:1.
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
    // A single already-open leg to grow in place — same side, more quantity.
    // Used to top up one leg of an existing position (e.g. just the hedge,
    // or just the lagging leg of a mismatched combo) without touching the
    // others, unlike 'enter' which always places the whole basket.
    legToAdd?: {
      securityId?: string;
      tradingSymbol?: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      productType?: string;
      exchangeSegment?: string;
      // Set for a sold (covered) wing: the leg's qty after this add and the
      // qty of the long ATM option it is written against. Anything above the
      // cover is a naked short and needs acknowledgeUncovered, as on entry.
      role?: string;
      resultingQty?: number;
      coverQty?: number;
    };
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
    acknowledgeUncovered = false,
    productType = 'INTRADAY',
    orderType = 'MARKET',
    strikeMap = {},
    legsToExit = [],
    legToAdd,
  } = body;

  const isCrude = isCrudeUnderlying(underlying);

  // Server-side size limits. Hedge wings can be up to max(RATIO_CHOICES) x the
  // synthetic lots, so an unbounded `lots` would be multiplied again.
  if (!Number.isInteger(lotSize) || lotSize <= 0) {
    return NextResponse.json({ success: false, error: `Invalid lot size: ${String(lotSize)}` }, { status: 400 });
  }
  if (action === 'enter' && (!Number.isInteger(lots) || lots < 1 || lots > MAX_SYNTHETIC_LOTS)) {
    return NextResponse.json({
      success: false,
      error: `Lots must be a whole number from 1 to ${MAX_SYNTHETIC_LOTS} (got ${String(lots)}). Split larger orders.`,
    }, { status: 400 });
  }

  // Zerodha has no MCX crude contracts (confirmed: /api/options/expiries
  // 400s CRUDEOIL/CRUDEOILM for it) — fail loudly instead of routing an
  // order through toZerodhaExchange's NSE/BSE-only fallback.
  if (isCrude && broker === 'zerodha') {
    return NextResponse.json({
      success: false,
      error: `Zerodha does not support ${underlying} — use Dhan or Kotak`,
    }, { status: 400 });
  }

  const defaultExchangeSegment = exchangeSegmentFor(broker, underlying as SyntheticFuturesUnderlying);

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
        // Always the server's own fresh mapping for this request's broker/underlying —
        // never the client-stored value from whenever the leg was opened, which could
        // predate a later fix to the segment mapping and route a real exit order wrong.
        exchangeSegment: defaultExchangeSegment,
      });

      results.push({
        role: 'EXIT',
        optionType: '',
        strike: 0,
        side: leg.side,
        quantity: Math.abs(leg.quantity),
        // Which contract this close was for: results come back BUY-first (margin-safe order), not in leg order,
        // so the page matches each exit fill to its leg by this.
        securityId: leg.securityId,
        tradingSymbol: leg.tradingSymbol,
        orderId: res.orderId,
        status: res.orderId ? 'TRANSIT' : 'FAILED',
        error: res.error,
        ...(res.unknown ? { unknown: true } : {}),
      });
    }

    invalidateBrokerCache(broker);
    const allSuccess = results.every(r => r.orderId);
    return NextResponse.json({
      success: allSuccess,
      action: 'exit',
      results,
      error: allSuccess
        ? undefined
        : results.filter(r => r.error).map(r => r.error).join('; ') || 'One or more close orders failed at broker',
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ADD LEG ACTION — grow one already-open leg of an existing position
  // (same side, more quantity), without touching its siblings.
  // ───────────────────────────────────────────────────────────────────────────
  if (action === 'addLeg') {
    if (!legToAdd || !legToAdd.quantity || legToAdd.quantity <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid leg to add' }, { status: 400 });
    }
    const maxAddQty = MAX_SYNTHETIC_LOTS * Math.max(...RATIO_CHOICES) * lotSize;
    if (legToAdd.quantity % lotSize !== 0 || legToAdd.quantity > maxAddQty) {
      return NextResponse.json({
        success: false,
        error: `Add quantity ${legToAdd.quantity} must be whole lots of ${lotSize} and at most ${maxAddQty}`,
      }, { status: 400 });
    }
    if (legToAdd.side === 'SELL' && legToAdd.role === 'HEDGE_SELL') {
      const resulting = Number(legToAdd.resultingQty);
      const cover = Number(legToAdd.coverQty);
      if (!Number.isFinite(resulting) || !Number.isFinite(cover)) {
        return NextResponse.json({ success: false, error: 'Sold wing add needs resultingQty and coverQty' }, { status: 400 });
      }
      if (resulting > cover && !acknowledgeUncovered) {
        return NextResponse.json({
          success: false,
          error: `Sold wing would be ${resulting} qty against ${cover} long — ${resulting - cover} naked. Acknowledge uncovered risk to proceed.`,
        }, { status: 400 });
      }
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

    const exec = await placeBrokerLeg(broker, dhanToken, dhanClientId, {
      role: 'ADD_LEG',
      optionType: '',
      strike: 0,
      side: legToAdd.side,
      quantity: Math.abs(legToAdd.quantity),
      securityId: legToAdd.securityId,
      tradingSymbol: legToAdd.tradingSymbol,
      orderType,
      productType: (legToAdd.productType as 'INTRADAY' | 'MARGIN') || productType,
      // Always the server's own fresh mapping for this request's broker/underlying —
      // same rule as the exit path above, never the client-stored value from
      // whenever the leg was first opened.
      exchangeSegment: defaultExchangeSegment,
    });

    invalidateBrokerCache(broker);

    return NextResponse.json({
      success: Boolean(exec.orderId),
      action: 'addLeg',
      orderId: exec.orderId,
      quantity: Math.abs(legToAdd.quantity),
      error: exec.error,
      ...(exec.unknown ? { unknown: true } : {}),
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

  // Hedge config: validated field by field against this underlying's offsets.
  // A field that fails validation would silently fall back to a default and
  // place a different wing than the user saw, so reject instead of sanitizing.
  const validOffsets = wingOffsetsFor(underlying);
  // Legacy shape: only an enabled hedge carries a meaningful offset; a
  // disabled one places no wing, so its offset is not validated.
  const rawHedge: Partial<HedgeConfig> = body.hedge ?? (body.hedgeEnabled
    ? { ...DEFAULT_HEDGE, enabled: true, buyOffset: body.hedgeOffset ?? DEFAULT_HEDGE.buyOffset }
    : { ...DEFAULT_HEDGE, enabled: false });
  const hedge = sanitizeHedgeConfig(rawHedge, validOffsets);
  const keysToCheck = rawHedge.enabled === false
    ? (['enabled'] as const)
    : (['enabled', 'mode', 'buyOffset', 'sellOffset', 'buyRatio', 'sellRatio'] as const);
  for (const key of keysToCheck) {
    if (rawHedge[key] !== undefined && rawHedge[key] !== hedge[key]) {
      return NextResponse.json({
        success: false,
        error: `Invalid hedge ${key}: ${String(rawHedge[key])}`,
      }, { status: 400 });
    }
  }
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return NextResponse.json({ success: false, error: `Invalid direction: ${String(direction)}` }, { status: 400 });
  }
  const uncovered = uncoveredShortLots(direction, lots, hedge);
  if (uncovered > 0 && !acknowledgeUncovered) {
    return NextResponse.json({
      success: false,
      error: `Sold wing is ${uncovered} lot(s) larger than the synthetic's long ATM ${direction === 'LONG' ? 'CE' : 'PE'} — those lots would be naked. Acknowledge uncovered risk to proceed.`,
    }, { status: 400 });
  }

  for (const wing of buildHedgeWings(direction, atmStrike, lots, hedge)) {
    const ident = strikeMap[String(wing.strike)];
    const securityId = wing.optionType === 'CE' ? ident?.ceId : ident?.peId;
    const tradingSymbol = wing.optionType === 'CE' ? ident?.ceSymbol : ident?.peSymbol;
    if (broker === 'dhan' ? !securityId : !tradingSymbol) {
      return NextResponse.json({
        success: false,
        error: `${wing.side === 'BUY' ? 'Protective' : 'Covered'} hedge strike ${wing.strike} ${wing.optionType} not found in ${broker} strike lookup. Aborting.`,
      }, { status: 400 });
    }
    legsToBuild.push({
      role: wing.role,
      optionType: wing.optionType,
      strike: wing.strike,
      side: wing.side,
      quantity: wing.lots * lotSize,
      securityId,
      tradingSymbol,
      orderType,
      productType,
      exchangeSegment: defaultExchangeSegment,
    });
  }

  if (direction === 'LONG') {
    // Synthetic Long: BUY ATM CE + SELL ATM PE

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

  // Margin safety: BUY legs go first, and within the SELLs the ATM main leg
  // goes before a covered (HEDGE_SELL) wing — the abort-on-first-failure loop
  // below then never leaves a sold wing live without the synthetic it writes against.
  const sortedLegs: SyntheticLegSpec[] = [
    ...legsToBuild.filter(l => l.side === 'BUY'),
    ...legsToBuild.filter(l => l.side === 'SELL' && l.role !== 'HEDGE_SELL'),
    ...legsToBuild.filter(l => l.side === 'SELL' && l.role === 'HEDGE_SELL'),
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
        securityId: leg.securityId,
        tradingSymbol: leg.tradingSymbol,
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
        securityId: leg.securityId,
        tradingSymbol: leg.tradingSymbol,
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
        securityId: leg.securityId,
        tradingSymbol: leg.tradingSymbol,
        status: 'FAILED',
        error: exec.error,
        ...(exec.unknown ? { unknown: true } : {}),
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
