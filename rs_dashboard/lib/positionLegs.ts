/**
 * Broker open positions -> payoff-engine legs.
 *
 * `ScalperPosition` (lib/zerodhaShape.ts) is deliberately price-and-quantity
 * only: it carries no strike, option type or expiry, because the scalper never
 * needed them. The payoff engine needs all three for every leg, so this module
 * recovers them.
 *
 * Pure functions — no fetch/DOM — so the resolution rules are unit-testable
 * without a live broker session (see positionLegs.test.ts).
 */

import type { ScalperPosition } from './zerodhaShape';
import type { ResolvedLeg, OptType, ChainOc } from './optionsStrategy';
// Value import needs the explicit extension so `node --test` can resolve it
// under type-stripping (same convention as basketStorage.ts).
import { lookupChainLegData } from './optionsStrategy.ts';
import { contractMultiplier } from './positionPnl.ts';

/** A position row that could not be turned into a leg, and why. */
export interface UnparseableLeg {
  tradingSymbol: string;
  productType: string;
  netQty: number;
  reason: string;
}

export interface PositionLegResult {
  legs: PositionLeg[];
  /**
   * Rows excluded from the payoff. NEVER silently drop these: dropping a naked
   * short leg turns an unlimited-risk book into a bounded-looking one, which is
   * the single most dangerous way this page could be wrong.
   */
  unparseable: UnparseableLeg[];
}

/** Extra per-leg display data the payoff engine itself does not need. */
export interface LegDisplay {
  tradingSymbol: string;
  productType: string;
  netQty: number;          // signed, in contracts
  entryAvg: number;
  ltp: number | null;      // null = unknown (Kotak reports no LTP)
  realizedProfit: number;
  unrealizedProfit: number;
  expiry: string | null;
}

/**
 * A payoff leg backed by a real position. `gamma`/`theta`/`expiry` are optional
 * on ResolvedLeg (older callers never set them) but always present here — as an
 * explicit null when unknown — so consumers never have to distinguish "absent"
 * from "unknown" for the same missing value.
 */
export type PositionLeg = Omit<ResolvedLeg, 'gamma' | 'theta' | 'expiry'> & {
  gamma: number | null;
  theta: number | null;
  expiry: string | null;
  display: LegDisplay;
};

// ── Field normalization ───────────────────────────────────────────────────────

/**
 * Dhan's `drvExpiryDate` -> bare YYYY-MM-DD.
 *
 * Mirrors dhan_expiry() in scripts/tools/copy_trade_reconcile.py: the order-update
 * WS is confirmed to send YYYY-MM-DD, but the positions endpoint's value has not
 * been observed on a live position, so DD-MM-YYYY and a trailing timestamp are
 * both handled.
 */
export function normalizeExpiry(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s === 'NA') return null;
  const bare = s.split('T')[0].split(' ')[0];
  const parts = bare.replace(/\//g, '-').split('-');
  if (parts.length === 3 && parts[0].length === 2 && parts[2].length === 4) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`; // DD-MM-YYYY -> YYYY-MM-DD
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(bare) ? bare : null;
}

/** CALL/CE/C -> 'CE', PUT/PE/P -> 'PE'. Anything else (a future) -> null. */
export function normalizeOptType(raw: unknown): OptType | null {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'CALL' || s === 'CE' || s === 'C') return 'CE';
  if (s === 'PUT' || s === 'PE' || s === 'P') return 'PE';
  return null;
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

export interface ParsedSymbol {
  underlying: string;
  strike: number;
  type: OptType;
  expiry: string | null;
}

/**
 * Last-resort parse of a trading symbol. Two shapes are supported, both observed
 * in this repo:
 *
 *   Dhan     "NIFTY-Aug2026-25000-CE"      (debug/live_positions_data.json)
 *   Kotak    "CRUDEOILM17AUG264150CE"      (debug/kotak_*_instruments.json)
 *
 * The Kotak form is genuinely ambiguous — nothing separates the 2-digit year
 * from the strike, so "…17AUG264150CE" could be strike 4150 in year 26 or strike
 * 64150 in year 2. We anchor on the day+month+2-digit-year prefix being exactly
 * 7 characters, which is how the exchange builds it. Returns null rather than
 * guessing when the shape does not match.
 */
export function parseTradingSymbol(symbol: string): ParsedSymbol | null {
  const s = symbol.trim().toUpperCase();
  if (!s) return null;

  // Dhan: SYMBOL-MonYYYY-STRIKE-CE
  const dhan = /^([A-Z]+)-([A-Z]{3})(\d{4})-(\d+(?:\.\d+)?)-(CE|PE)$/.exec(s);
  if (dhan && MONTHS[dhan[2]]) {
    return {
      underlying: dhan[1],
      strike: parseFloat(dhan[4]),
      type: dhan[5] as OptType,
      // This form carries only month precision — a weekly expiry's day is simply
      // not in the string. Left null rather than guessing the monthly expiry,
      // which would misprice every weekly leg. The caller supplies the real date.
      expiry: null,
    };
  }

  // Kotak / NSE compact: SYMBOL + DD + MON + YY + STRIKE + CE|PE
  const compact = /^([A-Z]+?)(\d{2})([A-Z]{3})(\d{2})(\d+)(CE|PE)$/.exec(s);
  if (compact) {
    const mm = MONTHS[compact[3]];
    if (!mm) return null;
    return {
      underlying: compact[1],
      strike: parseFloat(compact[5]),
      type: compact[6] as OptType,
      expiry: `20${compact[4]}-${mm}-${compact[2]}`,
    };
  }

  return null;
}

// ── Instrument cache join (Kotak) ─────────────────────────────────────────────

export interface InstrumentRow {
  tradingsymbol: string;
  strike: number;
  expiry: string;
  instrument_type: OptType;
  lot_size?: number;
}

export function buildInstrumentIndex(rows: InstrumentRow[]): Map<string, InstrumentRow> {
  const idx = new Map<string, InstrumentRow>();
  for (const r of rows) idx.set(String(r.tradingsymbol).toUpperCase(), r);
  return idx;
}

/**
 * Extra trading-symbol root(s) for underlyings whose contracts also appear
 * under a different name for some broker. CRUDEOIL is the only one: Kotak's
 * compact symbol form is for the Mini contract, prefixed `CRUDEOILM`
 * (`CRUDEOILM17AUG264150CE`), not `CRUDEOIL`. Dhan positions carry the bare
 * `CRUDEOIL` root directly. Mirrors SYMBOL_ROOTS in lib/analyticsUnderlyings.ts.
 */
const EXTRA_SYMBOL_ROOTS: Record<string, string[]> = {
  CRUDEOIL: ['CRUDEOILM'],
};

/**
 * Whether a trading symbol belongs to `underlying`, guarding against a prefix
 * collision — a plain `startsWith('NIFTY')` also matches `NIFTYNXT50…`, which
 * would file a completely different instrument's leg into the NIFTY book with
 * no unparseable warning (its strike is evaluated against NIFTY spot). Every
 * real derivative symbol continues immediately with a digit or hyphen after the
 * root name (`NIFTY-Aug2026-…`, `NIFTY18AUG26…`), so a following letter means
 * the match is spurious.
 */
export function symbolMatchesUnderlying(tradingSymbol: string, underlying: string): boolean {
  const s = tradingSymbol.trim().toUpperCase();
  const u = underlying.trim().toUpperCase();
  const roots = [...(EXTRA_SYMBOL_ROOTS[u] ?? []), u].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (!s.startsWith(root)) continue;
    const rest = s.slice(root.length);
    if (rest === '' || /^[-0-9]/.test(rest)) return true;
  }
  return false;
}

// ── Main resolution ───────────────────────────────────────────────────────────

export interface BuildLegsOptions {
  /** Raw broker rows, so Dhan's native drv* fields survive the ScalperPosition shaping. */
  raw?: Record<string, unknown>[];
  /** Kotak instrument cache, keyed by upper-case trading symbol. */
  instruments?: Map<string, InstrumentRow>;
  /** Dhan option chain for the selected expiry — the only source of greeks/IV. */
  oc?: ChainOc;
  /** Restrict to one underlying (e.g. 'SENSEX'); rows for others are ignored, not flagged. */
  underlying?: string;
}

/**
 * Resolve strike/type/expiry for one position, most authoritative source first:
 *   1. Dhan's native drvStrikePrice / drvOptionType / drvExpiryDate
 *   2. the broker's instrument cache, joined on trading symbol
 *   3. parsing the trading symbol
 */
function resolveContract(
  pos: ScalperPosition,
  raw: Record<string, unknown> | undefined,
  instruments: Map<string, InstrumentRow> | undefined,
): { strike: number; type: OptType; expiry: string | null } | { error: string } {
  const drvType = normalizeOptType(raw?.drvOptionType);
  const drvStrike = Number(raw?.drvStrikePrice ?? 0);
  if (drvType && drvStrike > 0) {
    return { strike: drvStrike, type: drvType, expiry: normalizeExpiry(raw?.drvExpiryDate) };
  }

  const inst = instruments?.get(pos.tradingSymbol.toUpperCase());
  if (inst && inst.strike > 0 && (inst.instrument_type === 'CE' || inst.instrument_type === 'PE')) {
    return { strike: inst.strike, type: inst.instrument_type, expiry: normalizeExpiry(inst.expiry) };
  }

  const parsed = parseTradingSymbol(pos.tradingSymbol);
  if (parsed) return { strike: parsed.strike, type: parsed.type, expiry: parsed.expiry };

  // A future, an equity, or a symbol shape we have never seen. Refusing to guess
  // is the point: a wrong strike silently mis-prices the whole book.
  return { error: 'could not resolve strike / option type from broker data or symbol' };
}

/**
 * Build payoff legs from open positions.
 *
 * Two deliberate conventions, both load-bearing:
 *
 *  - **`qtyLots` is the absolute contract quantity and callers pass `lotSize = 1`.**
 *    Dividing netQty by the lot size would round any partially-closed leg (e.g. 15
 *    contracts of a 20-lot SENSEX option) and corrupt the curve. Working in units
 *    keeps the arithmetic exact; `lotSize` is still needed for display and margin.
 *    Dhan's `netQty` is already the absolute unit count for NSE_FNO/BSE_FNO — but
 *    for MCX_COMM (CRUDEOIL) it is a LOT count instead (see contractMultiplier's
 *    header comment in positionPnl.ts), so it is scaled up here to match.
 *
 *  - **`price` is the entry average, not the LTP** — `buyAvg` for a long leg and
 *    `sellAvg` for a short one. The payoff curve is P&L measured from entry, which
 *    is what the AVG column and the "projected profit" callout mean.
 */
export function buildPositionLegs(
  positions: ScalperPosition[],
  opts: BuildLegsOptions = {},
): PositionLegResult {
  const legs: PositionLeg[] = [];
  const unparseable: UnparseableLeg[] = [];
  const rawByIndex = opts.raw ?? [];

  positions.forEach((pos, i) => {
    if (!pos || pos.netQty === 0) return; // flat rows are not legs

    if (opts.underlying && !symbolMatchesUnderlying(pos.tradingSymbol, opts.underlying)) {
      return; // another underlying's position — not this page's concern
    }

    const contract = resolveContract(pos, rawByIndex[i], opts.instruments);
    if ('error' in contract) {
      unparseable.push({ tradingSymbol: pos.tradingSymbol, productType: pos.productType, netQty: pos.netQty, reason: contract.error });
      return;
    }

    const side = pos.netQty > 0 ? 'BUY' : 'SELL';
    const entryAvg = side === 'BUY' ? pos.buyAvg : pos.sellAvg;

    if (!(entryAvg > 0)) {
      unparseable.push({
        tradingSymbol: pos.tradingSymbol,
        productType: pos.productType,
        netQty: pos.netQty,
        reason: `no ${side === 'BUY' ? 'buy' : 'sell'} average price — cannot measure P&L from entry`,
      });
      return;
    }

    const chainLeg = opts.oc ? lookupChainLegData(opts.oc, contract.strike, contract.type) : undefined;
    // Only Dhan's raw row carries exchangeSegment, so this is a no-op (mult=1) for
    // Kotak, whose netQty is already the absolute unit count.
    const mult = rawByIndex[i] ? contractMultiplier(rawByIndex[i]) : 1;

    legs.push({
      strike: contract.strike,
      type: contract.type,
      side,
      qtyLots: Math.abs(pos.netQty) * mult,
      price: entryAvg,
      delta: chainLeg?.greeks?.delta ?? null,
      // Dhan reports implied_volatility as a percent; bsPrice() takes a fraction.
      // Same normalization boundary as resolveLegs() in optionsStrategy.ts.
      iv: typeof chainLeg?.implied_volatility === 'number' ? chainLeg.implied_volatility / 100 : null,
      vega: chainLeg?.greeks?.vega ?? null,
      gamma: chainLeg?.greeks?.gamma ?? null,
      theta: chainLeg?.greeks?.theta ?? null,
      expiry: contract.expiry,
      securityId: pos.securityId || (chainLeg?.security_id ? String(chainLeg.security_id) : null),
      display: {
        tradingSymbol: pos.tradingSymbol,
        productType: pos.productType,
        // Signed, scaled by the same MCX multiplier as qtyLots — legPnl()'s
        // client-side unbooked P&L is netQty * (ltp - entryAvg), which needs
        // real units to price a CRUDEOIL leg correctly.
        netQty: pos.netQty * mult,
        entryAvg,
        // 0 means "unknown", not "worthless" — both for Kotak's omitted field and
        // for a chain entry with no trade yet today (a deep ITM/OTM contract can
        // sit at last_price=0 while still holding real intrinsic value). `> 0`
        // guards must be used here, never `?? null`, which lets a genuine 0
        // through as a real price and would report e.g. a short sold at 300 as
        // fully profitable rather than unpriced.
        ltp: pos.lastTradedPrice > 0 ? pos.lastTradedPrice
          : (chainLeg && chainLeg.last_price > 0 ? chainLeg.last_price : null),
        realizedProfit: pos.realizedProfit,
        unrealizedProfit: pos.unrealizedProfit,
        expiry: contract.expiry,
      },
    });
  });

  return { legs, unparseable };
}

/** Distinct expiries present in a book, ascending. Unknown expiries are omitted. */
export function legExpiries(legs: PositionLeg[]): string[] {
  return [...new Set(legs.map((l) => l.expiry).filter((e): e is string => !!e))].sort();
}

// ── Kelly / exposure sizing ───────────────────────────────────────────────────

export interface ExposureSummary {
  /** Notional that would be assigned if every short leg finished in the money. */
  assignmentExposure: number;
  /** Net credit received, in rupees (negative for a net-debit book). */
  premiumCollected: number;
  /** The conventional exit-at-N×-premium stop, in rupees. */
  managedStopRisk: number;
  exposurePctOfCapital: number | null;
  stopRiskPctOfNav: number | null;
  overAllocated: boolean;
}

/**
 * Sizing exposure for the Kelly card.
 *
 * `assignmentExposure` sums strike × quantity over SHORT legs only — the cash a
 * cash-secured writer must be able to produce. Long legs are excluded: they are
 * a right, not an obligation, and netting them here would understate the
 * requirement on a spread whose long wing is far out of the money.
 */
export function computeExposure(
  legs: PositionLeg[],
  opts: { capital: number | null; nav: number | null; stopMultiple?: number; overAllocationPct?: number },
): ExposureSummary {
  const stopMultiple = opts.stopMultiple ?? 2;
  const overAllocationPct = opts.overAllocationPct ?? 100;

  let assignmentExposure = 0;
  let premiumCollected = 0;

  for (const leg of legs) {
    const qty = leg.qtyLots; // already absolute contracts
    if (leg.side === 'SELL') {
      assignmentExposure += leg.strike * qty;
      premiumCollected += leg.price * qty;
    } else {
      premiumCollected -= leg.price * qty;
    }
  }

  const managedStopRisk = Math.max(0, premiumCollected) * stopMultiple;

  return {
    assignmentExposure,
    premiumCollected,
    managedStopRisk,
    exposurePctOfCapital: opts.capital && opts.capital > 0 ? (assignmentExposure / opts.capital) * 100 : null,
    stopRiskPctOfNav: opts.nav && opts.nav > 0 ? (managedStopRisk / opts.nav) * 100 : null,
    overAllocated: !!(opts.capital && opts.capital > 0 && (assignmentExposure / opts.capital) * 100 > overAllocationPct),
  };
}

/**
 * Kelly fraction f* = W - (1-W)/R.
 *
 * Returns null when the inputs cannot support it (no history, R <= 0). A negative
 * f* is returned as-is and means "this edge does not justify any size" — it must
 * be shown, not clamped to zero, because clamping hides a losing strategy.
 */
export function kellyFraction(winRate: number | null, payoffRatio: number | null): number | null {
  if (winRate === null || payoffRatio === null) return null;
  if (!(winRate >= 0 && winRate <= 1) || !(payoffRatio > 0)) return null;
  return winRate - (1 - winRate) / payoffRatio;
}
