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
