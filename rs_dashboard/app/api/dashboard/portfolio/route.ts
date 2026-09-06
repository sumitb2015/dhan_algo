import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { kiteGet, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { kotakGet, kotakLimits, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { isDhanTokenValid } from '@/lib/session';
import { shapeZerodhaPosition } from '@/lib/zerodhaShape';
import { shapeKotakPosition, shapeKotakFunds } from '@/lib/kotakShape';
import { dedupePositions } from '@/lib/positionProduct';
import { contractMultiplier, scaleBrokerPnl } from '@/lib/positionPnl';
import type { Broker } from '@/hooks/useBrokerSelector';

// Funds + open-position P&L for every connected broker, in one call.
//
// Fans out server-side rather than from the browser: the terminal needs six
// upstream calls (funds + positions x3) and doing them from the client means
// six round-trips plus six separate error states to reason about. Each broker
// is independent — one dead token must not blank the other two — so every leg
// is settled on its own and reported with its own `error`.

export interface BrokerPortfolio {
  broker: Broker;
  connected: boolean;
  /** Cash/margin actually free to deploy. */
  availableBalance: number | null;
  /** Margin currently blocked by open positions and pending orders. */
  utilizedMargin: number | null;
  /** available + utilized — the account's total margin base. */
  totalBalance: number | null;
  /** Pledged-holdings value, when the broker distinguishes it (Kotak). */
  collateralAmount: number | null;
  /** Spendable cash, when the broker distinguishes it from collateral. */
  cashBalance: number | null;
  openPositions: number;
  /**
   * Open legs whose mark could not be established, so they contribute 0 to
   * `unrealizedPnl`. Kotak's positions payload carries no last-traded price and
   * its `stkPrc` is the STRIKE, not a price — marking against it reports lakhs
   * of phantom P&L (dhan-broker-positions, invariant 3). Reported rather than
   * papered over so the panel can say the total is incomplete instead of
   * presenting an understated number as the whole day's P&L.
   */
  unpricedPositions: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  positions: DashboardPosition[];
  error?: string;
}

export interface DashboardPosition {
  broker: Broker;
  tradingSymbol: string;
  exchange: string;
  productType: string;
  netQty: number;
  avgPrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
}

export interface DashboardPortfolioResponse {
  success: boolean;
  updatedAt: string;
  brokers: BrokerPortfolio[];
  totals: {
    availableBalance: number;
    utilizedMargin: number;
    totalBalance: number;
    openPositions: number;
    unpricedPositions: number;
    unrealizedPnl: number;
    realizedPnl: number;
    totalPnl: number;
  };
}

const CACHE_TTL_MS = 3_000;
let cache: { ts: number; body: DashboardPortfolioResponse } | null = null;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function emptyBroker(broker: Broker, connected: boolean, error?: string): BrokerPortfolio {
  return {
    broker,
    connected,
    availableBalance: null,
    utilizedMargin: null,
    totalBalance: null,
    collateralAmount: null,
    cashBalance: null,
    openPositions: 0,
    unpricedPositions: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    totalPnl: 0,
    positions: [],
    ...(error ? { error } : {}),
  };
}

/**
 * Fold normalized broker rows into the panel's per-broker summary.
 *
 * `scaleBrokerPnl` is applied to every row as it enters — it is a no-op for
 * non-MCX rows, and without it a crude position's P&L arrives short by its
 * barrels-per-lot multiplier (100x for CRUDEOIL). See the dhan-broker-positions
 * skill.
 */
function summarize(broker: Broker, rows: Record<string, unknown>[]): {
  positions: DashboardPosition[];
  openPositions: number;
  unpricedPositions: number;
  unrealizedPnl: number;
  realizedPnl: number;
} {
  const positions: DashboardPosition[] = [];
  let unrealizedPnl = 0;
  let realizedPnl = 0;
  let openPositions = 0;
  let unpricedPositions = 0;

  for (const raw of rows) {
    const row = scaleBrokerPnl(raw);
    const netQty = num(row.netQty);
    const unrealized = num(row.unrealizedProfit);
    const realized = num(row.realizedProfit);

    unrealizedPnl += unrealized;
    realizedPnl += realized;
    // A netted-out (flat) row still carries realized P&L for the day, so it
    // belongs in the totals — but it is not an open position.
    if (netQty === 0) continue;
    openPositions++;

    const avgPrice = netQty > 0 ? num(row.buyAvg) : num(row.sellAvg);

    // Dhan's /positions payload carries NO last-traded price at all (confirmed
    // against a live book: buyAvg/sellAvg/costPrice/unrealizedProfit only), so
    // the mark has to be inverted out of the P&L:
    //     unrealized = netQty * mult * (ltp - avg)
    // Done AFTER scaleBrokerPnl, which is what makes it correct for MCX too —
    // inverting the unscaled figure would land the LTP a hundredth of the way
    // back from entry (dhan-broker-positions, invariant 1).
    //
    // Never invented for Kotak: it reports neither an LTP nor a usable
    // unrealized, so `unrealized === 0` leaves the mark at 0 and the UI renders
    // "—" rather than marking an option at its strike.
    const mult = contractMultiplier(row);
    const reported = num(row.lastTradedPrice);
    const lastPrice =
      reported > 0
        ? reported
        : unrealized !== 0 && avgPrice > 0
          ? avgPrice + unrealized / (netQty * mult)
          : 0;
    if (lastPrice <= 0) unpricedPositions++;

    positions.push({
      broker,
      tradingSymbol: String(row.tradingSymbol ?? row.customSymbol ?? ''),
      exchange: String(row.exchangeSegment ?? row.exchange ?? ''),
      productType: String(row.productType ?? ''),
      netQty,
      avgPrice,
      lastPrice,
      unrealizedPnl: unrealized,
      realizedPnl: realized,
      totalPnl: unrealized + realized,
    });
  }

  // Biggest loser first: on a risk screen the position that needs attention
  // should never be below the fold.
  positions.sort((a, b) => a.totalPnl - b.totalPnl);
  return { positions, openPositions, unpricedPositions, unrealizedPnl, realizedPnl };
}

async function loadDhan(): Promise<BrokerPortfolio> {
  if (!isDhanTokenValid()) return emptyBroker('dhan', false, 'No valid Dhan session');
  const out = emptyBroker('dhan', true);

  const [fundsRes, posRes] = await Promise.allSettled([
    dhanGet('/fundlimit'),
    dhanGet('/positions'),
  ]);

  if (fundsRes.status === 'fulfilled') {
    const f = (fundsRes.value ?? {}) as Record<string, unknown>;
    // `availabelBalance` is a genuine Dhan API misspelling — kept verbatim.
    out.availableBalance = num(f.availabelBalance ?? f.availableBalance);
    out.utilizedMargin = num(f.utilizedAmount);
    out.totalBalance = out.availableBalance + out.utilizedMargin;
    const collateral = Number(f.collateralAmount);
    if (Number.isFinite(collateral) && collateral > 0) out.collateralAmount = collateral;
  } else {
    out.error = `funds: ${String(fundsRes.reason).slice(0, 120)}`;
  }

  if (posRes.status === 'fulfilled') {
    const rows = dedupePositions(Array.isArray(posRes.value) ? (posRes.value as Record<string, unknown>[]) : []);
    Object.assign(out, summarize('dhan', rows));
  } else {
    out.error = [out.error, `positions: ${String(posRes.reason).slice(0, 120)}`].filter(Boolean).join(' · ');
  }

  out.totalPnl = out.unrealizedPnl + out.realizedPnl;
  return out;
}

async function loadZerodha(): Promise<BrokerPortfolio> {
  if (!isZerodhaTokenValid()) return emptyBroker('zerodha', false, 'No valid Zerodha session');
  const out = emptyBroker('zerodha', true);

  const [marginsRes, posRes] = await Promise.allSettled([
    kiteGet('/user/margins'),
    kiteGet('/portfolio/positions'),
  ]);

  if (marginsRes.status === 'fulfilled') {
    const m = (marginsRes.value ?? {}) as {
      equity?: {
        net?: number;
        utilised?: { debits?: number };
        available?: { cash?: number; collateral?: number };
      };
    };
    out.availableBalance = num(m.equity?.net);
    out.utilizedMargin = num(m.equity?.utilised?.debits);
    out.totalBalance = out.availableBalance + out.utilizedMargin;
    const cash = Number(m.equity?.available?.cash);
    if (Number.isFinite(cash)) out.cashBalance = cash;
    const collateral = Number(m.equity?.available?.collateral);
    if (Number.isFinite(collateral) && collateral > 0) out.collateralAmount = collateral;
  } else {
    out.error = `funds: ${String(marginsRes.reason).slice(0, 120)}`;
  }

  if (posRes.status === 'fulfilled') {
    const net = ((posRes.value ?? {}) as { net?: Record<string, unknown>[] }).net ?? [];
    Object.assign(out, summarize('zerodha', net.map(shapeZerodhaPosition) as unknown as Record<string, unknown>[]));
  } else {
    out.error = [out.error, `positions: ${String(posRes.reason).slice(0, 120)}`].filter(Boolean).join(' · ');
  }

  out.totalPnl = out.unrealizedPnl + out.realizedPnl;
  return out;
}

async function loadKotak(): Promise<BrokerPortfolio> {
  if (!isKotakTokenValid()) return emptyBroker('kotak', false, 'No valid Kotak session');
  const out = emptyBroker('kotak', true);

  const [limitsRes, posRes] = await Promise.allSettled([
    kotakLimits(),
    kotakGet(KOTAK_PATHS.positions),
  ]);

  if (limitsRes.status === 'fulfilled') {
    const f = shapeKotakFunds(limitsRes.value);
    out.availableBalance = f.availableBalance;
    out.utilizedMargin = f.utilizedAmount;
    out.totalBalance = f.availableBalance + f.utilizedAmount;
    out.cashBalance = f.cashBalance;
    out.collateralAmount = f.collateralAmount > 0 ? f.collateralAmount : null;
  } else {
    out.error = `funds: ${String(limitsRes.reason).slice(0, 120)}`;
  }

  if (posRes.status === 'fulfilled') {
    const rows = kotakRows(posRes.value).map(shapeKotakPosition);
    Object.assign(out, summarize('kotak', rows as unknown as Record<string, unknown>[]));
  } else {
    out.error = [out.error, `positions: ${String(posRes.reason).slice(0, 120)}`].filter(Boolean).join(' · ');
  }

  out.totalPnl = out.unrealizedPnl + out.realizedPnl;
  return out;
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const brokers = await Promise.all([loadDhan(), loadZerodha(), loadKotak()]);

  const totals = brokers.reduce(
    (acc, b) => ({
      availableBalance: acc.availableBalance + (b.availableBalance ?? 0),
      utilizedMargin: acc.utilizedMargin + (b.utilizedMargin ?? 0),
      totalBalance: acc.totalBalance + (b.totalBalance ?? 0),
      openPositions: acc.openPositions + b.openPositions,
      unpricedPositions: acc.unpricedPositions + b.unpricedPositions,
      unrealizedPnl: acc.unrealizedPnl + b.unrealizedPnl,
      realizedPnl: acc.realizedPnl + b.realizedPnl,
      totalPnl: acc.totalPnl + b.totalPnl,
    }),
    { availableBalance: 0, utilizedMargin: 0, totalBalance: 0, openPositions: 0, unpricedPositions: 0, unrealizedPnl: 0, realizedPnl: 0, totalPnl: 0 },
  );

  const body: DashboardPortfolioResponse = {
    success: true,
    updatedAt: new Date().toISOString(),
    brokers,
    totals,
  };

  // Only cache when at least one broker actually answered — caching an
  // all-failed fan-out would serve the blank panel for the full TTL after the
  // token behind it is refreshed.
  if (brokers.some(b => b.connected && !b.error)) cache = { ts: Date.now(), body };
  return NextResponse.json(body);
}
