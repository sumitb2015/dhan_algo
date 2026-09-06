import { NextRequest, NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { isDhanTokenValid } from '@/lib/session';
import { kotakGet, kotakLimits, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { shapeKotakPosition, shapeKotakFunds } from '@/lib/kotakShape';
import { dedupePositions } from '@/lib/positionProduct';
import { buildPositionLegs, parseTradingSymbol, type PositionLeg } from '@/lib/positionLegs';
import { calculateDte } from '@/lib/ultimateScannerEngine';
import { lookupChainLegData, type ChainOc } from '@/lib/optionsStrategy';
import type { ScalperPosition } from '@/lib/zerodhaShape';

// Margin classification across every broker with a real position book: which
// live option positions are tying up margin, grouped into the structure they
// actually form (straddle, strangle, spread, condor, naked), plus what's
// genuinely idle. Dhan and Kotak both hold live option books (per CLAUDE.md's
// multi-broker section); Zerodha is intentionally not wired here yet — its
// trading-symbol shape isn't one parseTradingSymbol() recognises, and it had
// no active session when this page was built. Dhan is the only broker with a
// real netted margin calculator — Kotak's margin-blocked figure is always the
// same flat-estimate fallback /api/multi-leg-focus/margin already uses for
// every non-Dhan broker, never a fabricated "live" number.

type MarginBroker = 'dhan' | 'kotak';
const MARGIN_BROKERS: MarginBroker[] = ['dhan', 'kotak'];

export interface GroupLeg {
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number;
  securityId: string | null;
}

export interface PositionGroup {
  broker: MarginBroker;
  underlying: string;
  expiry: string | null;
  dte: number | null;
  structure: string;
  riskType: 'defined' | 'undefined';
  legs: GroupLeg[];
  creditCollected: number;
  assignmentExposure: number;
  marginBlocked: number;
  /** 'live-cross-broker' = priced via Dhan's calculator against the same NSE
   * contracts, for a broker (Kotak) with no netted margin calculator of its own. */
  marginSource: 'live' | 'live-cross-broker' | 'estimate';
}

export interface MarginAllocatorFunds {
  availableBalance: number;
  utilizedMargin: number;
  totalBalance: number;
  collateralAmount: number | null;
}

export interface MarginAllocatorBrokerStatus {
  broker: MarginBroker;
  connected: boolean;
  funds: MarginAllocatorFunds | null;
  error?: string;
}

export interface MarginAllocatorResponse {
  success: boolean;
  connected: boolean;
  updatedAt: string;
  /** Kept for backward compatibility with the page's "Dhan Idle Margin" tiles. */
  funds: MarginAllocatorFunds | null;
  brokers: MarginAllocatorBrokerStatus[];
  groups: PositionGroup[];
  unparseable: { broker: MarginBroker; tradingSymbol: string; reason: string }[];
  error?: string;
}

/**
 * Classify an aggregated (strike, type) leg set into the structure it forms.
 *
 * Deliberately coarse — this covers every shape the value_imbalance /
 * spread_trend / oi_directional strategies (CLAUDE.md) actually build.
 * Anything more exotic (butterflies, jade lizards, multi-strike scale-ins)
 * falls into 'Custom Combo' rather than being mis-labeled.
 */
function classifyStructure(legs: GroupLeg[]): { structure: string; riskType: 'defined' | 'undefined' } {
  const shortCE = legs.filter((l) => l.type === 'CE' && l.side === 'SELL');
  const shortPE = legs.filter((l) => l.type === 'PE' && l.side === 'SELL');
  const longCE = legs.filter((l) => l.type === 'CE' && l.side === 'BUY');
  const longPE = legs.filter((l) => l.type === 'PE' && l.side === 'BUY');

  if (shortCE.length === 1 && shortPE.length === 1 && longCE.length === 1 && longPE.length === 1) {
    if (longCE[0].strike > shortCE[0].strike && longPE[0].strike < shortPE[0].strike) {
      return { structure: 'Iron Condor', riskType: 'defined' };
    }
  }
  if (shortCE.length === 1 && shortPE.length === 1 && longCE.length === 0 && longPE.length === 0) {
    return shortCE[0].strike === shortPE[0].strike
      ? { structure: 'Short Straddle', riskType: 'undefined' }
      : { structure: 'Short Strangle', riskType: 'undefined' };
  }
  if (shortCE.length === 1 && longCE.length === 1 && shortPE.length === 0 && longPE.length === 0) {
    return longCE[0].strike > shortCE[0].strike
      ? { structure: 'Bear Call Spread', riskType: 'defined' }
      : { structure: 'Custom Call Combo', riskType: 'defined' };
  }
  if (shortPE.length === 1 && longPE.length === 1 && shortCE.length === 0 && longCE.length === 0) {
    return longPE[0].strike < shortPE[0].strike
      ? { structure: 'Bull Put Spread', riskType: 'defined' }
      : { structure: 'Custom Put Combo', riskType: 'defined' };
  }
  if (shortCE.length >= 1 && shortPE.length === 0 && longCE.length === 0 && longPE.length === 0) {
    return { structure: 'Naked Call', riskType: 'undefined' };
  }
  if (shortPE.length >= 1 && shortCE.length === 0 && longCE.length === 0 && longPE.length === 0) {
    return { structure: 'Cash-Secured / Naked Put', riskType: 'undefined' };
  }
  if (longCE.length >= 1 || longPE.length >= 1) {
    return { structure: 'Long Options / Hedge', riskType: 'defined' };
  }
  return {
    structure: 'Custom Combo',
    riskType: shortCE.length + shortPE.length > longCE.length + longPE.length ? 'undefined' : 'defined',
  };
}

function aggregateLegs(bucketLegs: PositionLeg[]): GroupLeg[] {
  const map = new Map<string, GroupLeg & { signedQty: number }>();
  for (const leg of bucketLegs) {
    const key = `${leg.strike}:${leg.type}`;
    const signedQty = (leg.side === 'SELL' ? -1 : 1) * leg.qtyLots;
    const existing = map.get(key);
    if (existing) {
      const newSigned = existing.signedQty + signedQty;
      existing.signedQty = newSigned;
      existing.qty = Math.abs(newSigned);
      existing.side = newSigned < 0 ? 'SELL' : 'BUY';
      existing.avgPrice = (existing.avgPrice + leg.price) / 2;
      if (!existing.securityId) existing.securityId = leg.securityId;
    } else {
      map.set(key, {
        strike: leg.strike, type: leg.type, side: leg.side,
        qty: leg.qtyLots, avgPrice: leg.price, securityId: leg.securityId,
        signedQty,
      });
    }
  }
  return [...map.values()]
    .filter((l) => l.qty > 0)
    .map((l): GroupLeg => ({ strike: l.strike, type: l.type, side: l.side, qty: l.qty, avgPrice: l.avgPrice, securityId: l.securityId }));
}

// MCX quantity semantics differ 100x between Dhan and Kotak (CLAUDE.md's
// multi-broker section) and neither this route's leg-building nor the
// downstream margin call accounts for that scaling — excluded rather than
// silently mis-pricing a commodity position as if it were an index option.
const MCX_UNDERLYINGS = new Set(['CRUDEOIL', 'CRUDEOILM']);

interface RawFundsAndPositions {
  funds: MarginAllocatorFunds | null;
  rows: Record<string, unknown>[] | null;
  error?: string;
}

async function loadDhanRaw(): Promise<RawFundsAndPositions> {
  const [fundsRes, posRes] = await Promise.allSettled([
    dhanGet('/fundlimit'),
    dhanGet('/positions'),
  ]);

  let funds: MarginAllocatorFunds | null = null;
  let error: string | undefined;
  if (fundsRes.status === 'fulfilled') {
    const f = (fundsRes.value ?? {}) as Record<string, unknown>;
    const availableBalance = Number(f.availabelBalance ?? f.availableBalance) || 0;
    const utilizedMargin = Number(f.utilizedAmount) || 0;
    const collateral = Number(f.collateralAmount);
    funds = {
      availableBalance,
      utilizedMargin,
      totalBalance: availableBalance + utilizedMargin,
      collateralAmount: Number.isFinite(collateral) && collateral > 0 ? collateral : null,
    };
  } else {
    error = `funds: ${String(fundsRes.reason).slice(0, 160)}`;
  }

  if (posRes.status !== 'fulfilled') {
    return { funds, rows: null, error: [error, `positions: ${String(posRes.reason).slice(0, 160)}`].filter(Boolean).join(' · ') };
  }
  const rows = dedupePositions(Array.isArray(posRes.value) ? (posRes.value as Record<string, unknown>[]) : []);
  return { funds, rows, error };
}

async function loadKotakRaw(): Promise<RawFundsAndPositions> {
  const [limitsRes, posRes] = await Promise.allSettled([
    kotakLimits(),
    kotakGet(KOTAK_PATHS.positions),
  ]);

  let funds: MarginAllocatorFunds | null = null;
  let error: string | undefined;
  if (limitsRes.status === 'fulfilled') {
    const f = shapeKotakFunds(limitsRes.value);
    funds = {
      availableBalance: f.availableBalance,
      utilizedMargin: f.utilizedAmount,
      totalBalance: f.availableBalance + f.utilizedAmount,
      collateralAmount: f.collateralAmount > 0 ? f.collateralAmount : null,
    };
  } else {
    error = `funds: ${String(limitsRes.reason).slice(0, 160)}`;
  }

  if (posRes.status !== 'fulfilled') {
    return { funds, rows: null, error: [error, `positions: ${String(posRes.reason).slice(0, 160)}`].filter(Boolean).join(' · ') };
  }
  const rows = kotakRows(posRes.value).map(shapeKotakPosition) as unknown as Record<string, unknown>[];
  return { funds, rows, error };
}

/**
 * Look up each leg's real Dhan security ID from the live Dhan option chain
 * for (underlying, expiry) — used to price a non-Dhan broker's position
 * through Dhan's margin calculator as a neutral, exchange-level SPAN model,
 * since a Kotak-issued instrument token is not a Dhan security ID and must
 * never be passed to Dhan's calculator on the assumption the two coincide.
 */
async function resolveDhanSecurityIds(
  underlying: string,
  expiry: string,
  legs: GroupLeg[],
  origin: string,
  cookie: string,
): Promise<{ legs: GroupLeg[]; fullyResolved: boolean }> {
  try {
    const res = await fetch(`${origin}/api/options/chain?underlying=${underlying}&expiry=${expiry}`, {
      headers: { Cookie: cookie },
    });
    const json = await res.json();
    if (!json?.success) return { legs, fullyResolved: false };
    const oc = (json.data?.chain?.oc ?? {}) as ChainOc;

    let fullyResolved = true;
    const resolvedLegs = legs.map((l): GroupLeg => {
      const chainLeg = lookupChainLegData(oc, l.strike, l.type);
      const securityId = chainLeg?.security_id ? String(chainLeg.security_id) : null;
      if (!securityId) fullyResolved = false;
      return { ...l, securityId: securityId ?? l.securityId };
    });
    return { legs: resolvedLegs, fullyResolved };
  } catch {
    return { legs, fullyResolved: false };
  }
}

/**
 * Build classified structure groups for one broker's raw position rows.
 *
 * `raw` (Dhan's own rows, carrying drvOptionType/drvStrikePrice/drvExpiryDate)
 * is only passed for Dhan — Kotak has no such native fields, so its legs
 * resolve strike/type/expiry purely from parseTradingSymbol()'s compact-symbol
 * regex, which is what that function documents as its Kotak support path.
 */
async function classifyBroker(
  broker: MarginBroker,
  rows: Record<string, unknown>[],
  origin: string,
  cookie: string,
): Promise<{ groups: PositionGroup[]; unparseable: { tradingSymbol: string; reason: string }[] }> {
  const { legs, unparseable } = buildPositionLegs(rows as unknown as ScalperPosition[], {
    raw: broker === 'dhan' ? rows : undefined,
  });

  const buckets = new Map<string, { underlying: string; expiry: string | null; legs: PositionLeg[] }>();
  for (const leg of legs) {
    const parsed = parseTradingSymbol(leg.display.tradingSymbol);
    const underlying = parsed?.underlying ?? leg.display.tradingSymbol.replace(/[-0-9].*$/, '') ?? 'UNKNOWN';
    if (MCX_UNDERLYINGS.has(underlying)) continue;
    const key = `${underlying}::${leg.expiry ?? 'unknown'}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.legs.push(leg);
    else buckets.set(key, { underlying, expiry: leg.expiry, legs: [leg] });
  }

  const groups: PositionGroup[] = [];
  for (const { underlying, expiry, legs: bucketLegs } of buckets.values()) {
    const aggLegs = aggregateLegs(bucketLegs);
    if (!aggLegs.length) continue;

    const { structure, riskType } = classifyStructure(aggLegs);

    let creditCollected = 0;
    let assignmentExposure = 0;
    for (const l of aggLegs) {
      if (l.side === 'SELL') {
        creditCollected += l.avgPrice * l.qty;
        assignmentExposure += l.strike * l.qty;
      } else {
        creditCollected -= l.avgPrice * l.qty;
      }
    }

    // Kotak has no netted margin calculator of its own (CLAUDE.md's Kotak
    // quirks) and the flat 12%-of-notional fallback below does not net a
    // strangle's opposite-side legs against each other, so it can overstate
    // margin well past what the exchange actually requires — badly enough to
    // show more margin "blocked" by one structure than the whole account's
    // margin base. SPAN+exposure is an exchange calculation keyed on the
    // contract, not the broker, so for a non-Dhan broker this looks up the
    // SAME contracts' real Dhan security IDs from the live chain and prices
    // them through Dhan's calculator — a real number, just sourced
    // cross-broker, never a fabricated "live" figure for Kotak's own account.
    let marginLegs = aggLegs;
    let pricingBroker = broker;
    if (broker !== 'dhan' && expiry) {
      const resolved = await resolveDhanSecurityIds(underlying, expiry, aggLegs, origin, cookie);
      if (resolved.fullyResolved) {
        marginLegs = resolved.legs;
        pricingBroker = 'dhan';
      }
    }

    let marginBlocked = 0;
    let marginSource: 'live' | 'live-cross-broker' | 'estimate' = 'estimate';
    try {
      const marginRes = await fetch(`${origin}/api/multi-leg-focus/margin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          underlying, expiry: expiry ?? '', broker: pricingBroker,
          legs: marginLegs.map((l, i) => ({
            id: `${underlying}-${l.strike}-${l.type}-${i}`,
            side: l.side === 'SELL' ? 'S' : 'B',
            option: l.type, strike: l.strike, lots: 1, quantity: l.qty,
            price: l.avgPrice, securityId: l.securityId ?? undefined,
          })),
        }),
      });
      const marginJson = await marginRes.json();
      if (marginJson?.success) {
        marginBlocked = Number(marginJson.data?.basketMargin) || 0;
        if (marginJson.data?.basketMarginSource === 'live') {
          marginSource = pricingBroker === broker ? 'live' : 'live-cross-broker';
        }
      }
    } catch {
      /* fall through to the flat estimate below */
    }

    if (marginBlocked <= 0) {
      marginBlocked = Math.round(Math.max(assignmentExposure * 0.12, creditCollected * 3));
      marginSource = 'estimate';
    }

    groups.push({
      broker, underlying, expiry, dte: expiry ? calculateDte(expiry) : null,
      structure, riskType, legs: aggLegs,
      creditCollected: Math.round(creditCollected),
      assignmentExposure: Math.round(assignmentExposure),
      marginBlocked, marginSource,
    });
  }

  return {
    groups,
    unparseable: unparseable.map((u) => ({ tradingSymbol: u.tradingSymbol, reason: u.reason })),
  };
}

const CACHE_TTL_MS = 5_000;
let cache: { ts: number; body: MarginAllocatorResponse } | null = null;

export async function GET(req: NextRequest) {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const origin = req.nextUrl.origin;
  const cookie = req.headers.get('cookie') ?? '';

  const brokers: MarginAllocatorBrokerStatus[] = [];
  const groups: PositionGroup[] = [];
  const unparseable: MarginAllocatorResponse['unparseable'] = [];

  for (const broker of MARGIN_BROKERS) {
    const isValid = broker === 'dhan' ? isDhanTokenValid() : isKotakTokenValid();
    if (!isValid) {
      brokers.push({ broker, connected: false, funds: null, error: 'No valid session' });
      continue;
    }

    const raw = broker === 'dhan' ? await loadDhanRaw() : await loadKotakRaw();
    brokers.push({ broker, connected: true, funds: raw.funds, error: raw.error });

    if (!raw.rows) continue;
    const classified = await classifyBroker(broker, raw.rows, origin, cookie);
    groups.push(...classified.groups);
    unparseable.push(...classified.unparseable.map((u) => ({ broker, ...u })));
  }

  groups.sort((a, b) => b.marginBlocked - a.marginBlocked);

  const dhanStatus = brokers.find((b) => b.broker === 'dhan') ?? null;

  const body: MarginAllocatorResponse = {
    success: true,
    connected: brokers.some((b) => b.connected),
    updatedAt: new Date().toISOString(),
    funds: dhanStatus?.funds ?? null,
    brokers,
    groups,
    unparseable,
  };

  if (brokers.some((b) => b.connected && !b.error)) cache = { ts: Date.now(), body };
  return NextResponse.json(body);
}
