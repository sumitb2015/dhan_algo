import { NextRequest, NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { isDhanTokenValid } from '@/lib/session';
import { dedupePositions } from '@/lib/positionProduct';
import { buildPositionLegs, parseTradingSymbol, type PositionLeg } from '@/lib/positionLegs';
import { calculateDte } from '@/lib/ultimateScannerEngine';
import type { ScalperPosition } from '@/lib/zerodhaShape';

// Dhan-only margin classification: which live option positions are tying up
// margin, grouped into the structure they actually form (straddle, strangle,
// spread, condor, naked), plus what's genuinely idle. Zerodha/Kotak funds are
// surfaced elsewhere (/api/dashboard/portfolio) — Dhan is the only broker with
// a real netted margin calculator, which is what a "how much is truly free"
// answer requires (see dhan_algo CLAUDE.md's multi-broker section).

export interface GroupLeg {
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number;
  securityId: string | null;
}

export interface PositionGroup {
  underlying: string;
  expiry: string | null;
  dte: number | null;
  structure: string;
  riskType: 'defined' | 'undefined';
  legs: GroupLeg[];
  creditCollected: number;
  assignmentExposure: number;
  marginBlocked: number;
  marginSource: 'live' | 'estimate';
}

export interface MarginAllocatorFunds {
  availableBalance: number;
  utilizedMargin: number;
  totalBalance: number;
  collateralAmount: number | null;
}

export interface MarginAllocatorResponse {
  success: boolean;
  connected: boolean;
  updatedAt: string;
  funds: MarginAllocatorFunds | null;
  groups: PositionGroup[];
  unparseable: { tradingSymbol: string; reason: string }[];
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

const CACHE_TTL_MS = 5_000;
let cache: { ts: number; body: MarginAllocatorResponse } | null = null;

export async function GET(req: NextRequest) {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  if (!isDhanTokenValid()) {
    const body: MarginAllocatorResponse = {
      success: true, connected: false, updatedAt: new Date().toISOString(),
      funds: null, groups: [], unparseable: [],
    };
    return NextResponse.json(body);
  }

  const [fundsRes, posRes] = await Promise.allSettled([
    dhanGet('/fundlimit'),
    dhanGet('/positions'),
  ]);

  let funds: MarginAllocatorFunds | null = null;
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
  }

  if (posRes.status !== 'fulfilled') {
    const body: MarginAllocatorResponse = {
      success: true, connected: true, updatedAt: new Date().toISOString(),
      funds, groups: [], unparseable: [],
      error: `positions: ${String(posRes.reason).slice(0, 160)}`,
    };
    return NextResponse.json(body);
  }

  const rows = dedupePositions(Array.isArray(posRes.value) ? (posRes.value as Record<string, unknown>[]) : []);
  const { legs, unparseable } = buildPositionLegs(rows as unknown as ScalperPosition[], { raw: rows });

  const buckets = new Map<string, { underlying: string; expiry: string | null; legs: PositionLeg[] }>();
  for (const leg of legs) {
    const parsed = parseTradingSymbol(leg.display.tradingSymbol);
    const underlying = parsed?.underlying ?? leg.display.tradingSymbol.replace(/[-0-9].*$/, '') ?? 'UNKNOWN';
    const key = `${underlying}::${leg.expiry ?? 'unknown'}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.legs.push(leg);
    else buckets.set(key, { underlying, expiry: leg.expiry, legs: [leg] });
  }

  const origin = req.nextUrl.origin;
  const cookie = req.headers.get('cookie') ?? '';

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

    let marginBlocked = 0;
    let marginSource: 'live' | 'estimate' = 'estimate';
    try {
      const marginRes = await fetch(`${origin}/api/multi-leg-focus/margin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          underlying, expiry: expiry ?? '', broker: 'dhan',
          legs: aggLegs.map((l, i) => ({
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
        marginSource = marginJson.data?.basketMarginSource === 'live' ? 'live' : 'estimate';
      }
    } catch {
      /* fall through to the flat estimate below */
    }

    if (marginBlocked <= 0) {
      marginBlocked = Math.round(Math.max(assignmentExposure * 0.12, creditCollected * 3));
      marginSource = 'estimate';
    }

    groups.push({
      underlying, expiry, dte: expiry ? calculateDte(expiry) : null,
      structure, riskType, legs: aggLegs,
      creditCollected: Math.round(creditCollected),
      assignmentExposure: Math.round(assignmentExposure),
      marginBlocked, marginSource,
    });
  }

  groups.sort((a, b) => b.marginBlocked - a.marginBlocked);

  const body: MarginAllocatorResponse = {
    success: true, connected: true, updatedAt: new Date().toISOString(),
    funds, groups,
    unparseable: unparseable.map((u) => ({ tradingSymbol: u.tradingSymbol, reason: u.reason })),
  };

  if (funds) cache = { ts: Date.now(), body };
  return NextResponse.json(body);
}
