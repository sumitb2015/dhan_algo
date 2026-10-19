// Per-underlying constants for the Focus Tool, in one place so adding an
// underlying is a table entry rather than a hunt through FocusTool.tsx.
//
// Pure data and pure functions — no fs, no React — so the page, the hooks and
// the tests can all import it.
//
// MCX UNITS (CRUDEOILM). Dhan takes MCX order quantity in LOTS and reports
// position quantity in LOTS, while its master list says LOT_SIZE=1. The Focus
// Tool's money maths (premium × contracts) wants real units, so for MCX the
// page works in BARRELS internally: `lotSize` is the barrels-per-lot (10) and
// the two boundaries convert — broker position quantities are scaled UP on the
// way in (FocusTool fetchPositionsNow) and order quantities are scaled DOWN on
// the way out (`orderQuantity`). Nothing in between needs to know.

import { NSE_HOLIDAYS } from './nseHolidays.ts';

export type FocusUnderlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX' | 'CRUDEOILM';

export const FOCUS_UNDERLYINGS: readonly FocusUnderlying[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOILM'];

export interface UnderlyingMeta {
  /** Strike interval of the listed options. */
  strikeStep: number;
  /** Header label for the futures strip. */
  futLabel: string;
  /** Dhan exchange segment orders and quotes are routed on. */
  segment: 'NSE_FNO' | 'BSE_FNO' | 'MCX_COMM';
  /** Barrels (or units) per lot when the broker counts MCX in lots; 1 elsewhere. */
  unitsPerLot: number;
  /** Intraday square-off backstop, IST HH:MM. */
  backstopHm: string;
  /** Latest time a row may be given as its entry / exit time (AlgoTest windows for NSE). */
  entryMinHm: string;
  entryMaxHm: string;
  exitMinHm: string;
  exitMaxHm: string;
  /** Trades on the NSE holiday calendar (false: MCX has its own, which this tool does not carry). */
  nseCalendar: boolean;
}

export const UNDERLYING_META: Record<FocusUnderlying, UnderlyingMeta> = {
  NIFTY:     { strikeStep: 50,  futLabel: 'NIFTY FUT',     segment: 'NSE_FNO', unitsPerLot: 1,  backstopHm: '15:17', entryMinHm: '09:16', entryMaxHm: '15:28', exitMinHm: '09:17', exitMaxHm: '15:29', nseCalendar: true },
  BANKNIFTY: { strikeStep: 100, futLabel: 'BANKNIFTY FUT', segment: 'NSE_FNO', unitsPerLot: 1,  backstopHm: '15:17', entryMinHm: '09:16', entryMaxHm: '15:28', exitMinHm: '09:17', exitMaxHm: '15:29', nseCalendar: true },
  SENSEX:    { strikeStep: 100, futLabel: 'SENSEX FUT',    segment: 'BSE_FNO', unitsPerLot: 1,  backstopHm: '15:17', entryMinHm: '09:16', entryMaxHm: '15:28', exitMinHm: '09:17', exitMaxHm: '15:29', nseCalendar: true },
  // MCX evening session runs to 23:30 (23:55 in US-DST months); the backstop sits
  // well inside it so an intraday row is flat before the close either way.
  CRUDEOILM: { strikeStep: 50,  futLabel: 'CRUDEOILM FUT', segment: 'MCX_COMM', unitsPerLot: 10, backstopHm: '23:15', entryMinHm: '09:01', entryMaxHm: '23:10', exitMinHm: '09:02', exitMaxHm: '23:14', nseCalendar: false },
};

export const isMcxUnderlying = (u: FocusUnderlying): boolean => UNDERLYING_META[u].segment === 'MCX_COMM';

/** Broker quantity (lots, for MCX) → the page's internal units (barrels, for MCX). */
export function toInternalQty(u: FocusUnderlying, brokerQty: number): number {
  return brokerQty * UNDERLYING_META[u].unitsPerLot;
}

/**
 * Page units → the quantity a Dhan order carries, in WHOLE lots. A remainder is
 * dropped, never rounded up: rounding a 4-barrel ledger remainder up to one lot
 * would close 10 barrels, i.e. more than this row owns (a sibling row's share on
 * the same security id). A positive request that is under one lot returns 0, and
 * the caller must treat 0 as "refuse", not send it.
 */
export function orderQuantity(u: FocusUnderlying, internalQty: number): number {
  const per = UNDERLYING_META[u].unitsPerLot;
  if (per === 1) return internalQty;
  return internalQty > 0 ? Math.floor(internalQty / per) : 0;
}

/**
 * Underlyings the standalone quote bridge (scripts/tools/focus_tool_ws.py) streams. CRUDEOILM is not on it.
 * The page's stale-feed check only watches the NSE/BSE cash session below, so every entry here must trade on it
 * (a test asserts that): adding an MCX underlying to the bridge needs its own session window first.
 */
export const FEED_BRIDGE_UNDERLYINGS: readonly FocusUnderlying[] = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
export const FEED_SESSION_START_HM = '09:16';
export const FEED_SESSION_END_HM = '15:30';

/**
 * Is `iso` ('YYYY-MM-DD', IST) a day this underlying can trade? Weekends never. NSE / BSE underlyings also skip the NSE holiday
 * list (the repo's single source, lib/nseHolidays.ts). MCX has its own calendar, which this repo does not carry, so it is
 * weekday-only: never blocks a day MCX might be open, at the cost of not knowing its own holidays.
 */
export function isTradingDayFor(u: FocusUnderlying, iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return false;
  return UNDERLYING_META[u].nseCalendar ? !NSE_HOLIDAYS.has(iso) : true;
}

/**
 * Page units → the quantity THIS broker's order carries. Dhan counts MCX in whole lots (orderQuantity). Kotak takes absolute
 * barrels but only in whole lots, so a remainder is dropped, never rounded up, exactly as for Dhan: sending a ledger
 * remainder of 4 barrels as-is would be rejected, and rounding it up to a lot would close more than this row owns. A positive
 * request under one lot returns 0 and the caller must refuse it. NSE/BSE (unitsPerLot 1) pass through unchanged.
 */
export function brokerOrderQuantity(broker: string, u: FocusUnderlying, internalQty: number): number {
  if (broker === 'dhan' || broker === 'zerodha') return orderQuantity(u, internalQty);
  const per = UNDERLYING_META[u].unitsPerLot;
  if (per === 1) return internalQty;
  return internalQty > 0 ? Math.floor(internalQty / per) * per : 0;
}

/** The inverse: a quantity the broker reported → page units. Dhan and Zerodha count MCX in lots (Zerodha's order
 *  quantity verified on its margin calculator; its position / fill read-back follows the same convention, unconfirmed). */
export function brokerToInternalQuantity(broker: string, u: FocusUnderlying, brokerQty: number): number {
  return broker === 'dhan' || broker === 'zerodha' ? toInternalQty(u, brokerQty) : brokerQty;
}

// ── Order size: exchange freeze limit and the Focus Tool's own per-order caps ──
//
// An order above the exchange freeze quantity is rejected outright, so a leg that grew past it through adds, ladder
// fills or re-entries could never be closed by a stop that sends its whole size in one order. Every Focus Tool order
// is therefore sliced to the largest whole-lot quantity under BOTH the freeze limit and the route's per-source cap.

/** Per-order cap on Focus Tool orders at /api/scalper/fast-order (source 'fts'), in Dhan's own quantity units (contracts
 *  for NSE/BSE, lots for MCX). The route rejects anything above it; slices are kept under it. */
export const FTS_DHAN_MAX_ORDER_QTY = 3750;
/** Per-order lot cap on Focus Tool OPENING orders at the Kotak route (SOURCE_LOT_CAPS.fts). Closes carry no source. */
export const FTS_KOTAK_MAX_ORDER_LOTS = 100;

/** Used when the contract lookup carries no freeze quantity (an older cache): page units, at or under the exchange
 *  limits seen in the Dhan master on 2026-10-18 (NIFTY 3511, BANKNIFTY 1441, SENSEX 1001, CRUDEOILM ≥ 494 lots). */
export const FALLBACK_FREEZE_UNITS: Record<FocusUnderlying, number> = {
  NIFTY: 1800, BANKNIFTY: 900, SENSEX: 1000, CRUDEOILM: 4000,
};

/**
 * The largest single order for this row, in page units and whole lots. `freezePageUnits` is the lookup's freeze
 * quantity already in page units; it is read as the first REFUSED quantity (the Dhan master lists NIFTY 3511 and
 * SENSEX 1001), so an order stays one below it. Never under one lot.
 */
export function maxOrderUnits(broker: string, u: FocusUnderlying, lotSize: number, freezePageUnits?: number | null): number {
  if (!(lotSize > 0)) return 0;
  const freeze = Number(freezePageUnits) > 1 ? Number(freezePageUnits) - 1 : FALLBACK_FREEZE_UNITS[u];
  const cap = broker === 'dhan'
    ? toInternalQty(u, FTS_DHAN_MAX_ORDER_QTY)
    : FTS_KOTAK_MAX_ORDER_LOTS * lotSize;   // Kotak and Zerodha: the routes' 'fts' per-source lot cap (opens)
  const lots = Math.floor(Math.min(freeze, cap) / lotSize);
  return Math.max(1, lots) * lotSize;
}

/** `total` page units cut into orders of at most `maxPer` (largest first; the remainder, if any, last). */
export function sliceOrderUnits(total: number, maxPer: number): number[] {
  if (!(total > 0)) return [];
  if (!(maxPer > 0) || total <= maxPer) return [total];
  const out: number[] = [];
  let rest = total;
  while (rest > 0) {
    const s = Math.min(rest, maxPer);
    out.push(s);
    rest -= s;
  }
  return out;
}
