'use client';

import React, {
  useState, useEffect, useCallback, useMemo, useRef, memo, createContext, useContext,
} from 'react';
import NavBar from './NavBar';
import {
  TrendingUp, Zap, ShieldOff, Shield, Activity,
  Clock, Plus, Layers, Target, Lock, RefreshCw, X, Trash2,
  ChevronUp, ChevronDown, Grid3x3, Calendar, Minus, Ellipsis, ArrowRight, LayoutList, Sigma,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TabTable, type SortState, BUILDUP_STYLES } from './Scalper';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { closeOrderProduct, positionProduct } from '@/lib/positionProduct';
import { scaleBrokerPnl } from '@/lib/positionPnl';
import { useCopyTrade, CopyTradeControls, type CopyTradeApi } from './CopyTrade';
import { useFocusToolWS, focusWsBookForExpiry } from '@/lib/useFocusToolWS';
import FocusOptionChainModal from './FocusOptionChainModal';
import { partialCloseChips } from '@/lib/partialQty';
import { cn } from '@/lib/utils';
import type {
  FocusToolConfig, FocusRow, FocusRowFill, FocusIndexGroup,
  FocusReentryMode, FocusReentryTrigger, FocusPendingReentry, FocusLegSimpleMom, FocusLazyLeg, FocusLegRangeBreakout, FocusOverallMode,
  FocusUnderlying, FocusDte, FocusSide, FocusRowStatus, FocusStrikeMode,
  FocusLegSlRule, FocusLegTrailSl, FocusLegOrbSl, FocusOrbStamp, FocusLadderOrder,
} from '@/lib/focusToolRows';
// The pure rule engine for entry and exit decisions.
import {
  EMPTY_ROW_LIVE,
  legsOf, rowFlat, rowOwnsLeg, sidePremium, legOwnContracts,
  dteMatches, dteForExpiry, evaluateRowExit, evaluateEntry, evaluateGlobalRisk,
  legStopPremium, pairStopPremium, nextOpenedTs, isGhostDropProtected,
  isSimRow, simLegPosition,
  legPinnedStrike, costStopReason, legOwnEntry, slRollStrike, DEFAULT_SL_ROLL_MAX,
  reentryConfig, evaluateReentry, reentryWindowClosed, monitoringStopped, momentumReentryKind, momentumTrigger,
  addMinutesHm, resolveCriteriaStrike, closestPremiumStrike, ownedLegStop, legStopHit, legDeltaNow, legDeltaBasis, legTargetDeltaLevel,
  multipliedLots, clampHm, rangeWindow, rangeWindowPhase, rowHasMultiDayRange, candleBucket, tradingDte,
  legSlRuleOn, legStopLevel, legTargetSpotLevel, legTgtUnitLabel, MAX_LEG_REENTRIES, pendingReentryLevel, pendingReentryHit, legTargetReason, costReentryBasis,
  awaitingMomentumQuote, MOMENTUM_QUOTE_WAIT_MS, legTargetLevel,
  evaluateEntryMomentum, reRangeWindow, entryMomentumOn, overallSlConfig, overallProgress, nextOverallPeak, evaluateOverallExit, overallExitKind, evaluateOverallReentry, MAX_OVERALL_REENTRIES, rangeBreakoutOn, rangeBreakoutHit, costStopApplies, MAX_LAZY_LEGS, legSlMultiplier, legTarget, nextLazyLegId, lazyLegStrike, runningLazyLeg, simpleMomOn, simpleMomLevel, simpleMomHit,
  type PosRow, type RowLive,
} from '@/lib/focusToolRules';
import { postFocusEvent } from '@/lib/focusToolEvents';
import { buildPayoffModel } from '@/lib/optionsPayoff';
import { computeBasketGreeks, type GreekLeg } from '@/lib/multiLegGreeks';
import { useFocusMarketData, expKey, strikeKey, type FutQuote, type StrikeRef } from '@/lib/useFocusMarketData';
import { computeRowPnl, mtmForQty, shiftMayReopen, canMarkMtm, shiftCloseConfirmed, rowDisplayBookedPnl, putCallRatio, valuePutCallRatio, pickOpenInterest, closeRebaseDelta, closedSliceBooked, FTS_ORDER_SOURCE } from '@/lib/focusToolPnl';
import { normalizeTradeRow, matchOutsideTrades, type NormalizedTrade } from '@/lib/multiLegFocus';
import { stampItems, noteItems, adoptItems, canon, type RevBook } from '@/lib/revMerge';
import { useTabLeader } from '@/hooks/useTabLeader';
import { FOCUS_UNDERLYINGS, UNDERLYING_META, isMcxUnderlying, toInternalQty, orderQuantity } from '@/lib/focusToolUnderlyings';
import type { FocusConfigWrite } from '@/lib/focusToolRowsMerge';

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const UNDERLYINGS: FocusUnderlying[] = [...FOCUS_UNDERLYINGS];
/** Limit-ladder levels: % above the leg's price at click. */
const LADDER_PCTS = [5, 10, 15, 20, 25, 30] as const;
/** Listed option tick; ladder prices round to it. */
const OPTION_TICK = 0.05;
function ladderPrice(ltp: number, pct: number): number {
  return Math.round((ltp * (1 + pct / 100)) / OPTION_TICK) * OPTION_TICK;
}
const STRIKE_STEP = Object.fromEntries(FOCUS_UNDERLYINGS.map(u => [u, UNDERLYING_META[u].strikeStep])) as Record<FocusUnderlying, number>;

/** Row layout: Pro (legs grid), Table (5-column) or Cards. */
type FocusViewMode = 'pro' | 'table' | 'cards';
const VIEW_MODE_KEY = 'focusTool.viewMode';

// ATM-offset dropdown range for the strike editor: +-30 steps either side (AlgoTest offers 30 OTM).
const OFFSET_OPTIONS: number[] = Array.from({ length: 61 }, (_, i) => i - 30);

function offsetLabel(n: number, step: number): string {
  if (n === 0) return 'ATM';
  const rupees = n * step;
  return `ATM${n > 0 ? '+' : ''}${n} (${rupees > 0 ? '+' : ''}${rupees})`;
}

const FUT_LABELS = Object.fromEntries(FOCUS_UNDERLYINGS.map(u => [u, UNDERLYING_META[u].futLabel])) as Record<FocusUnderlying, string>;

/** MCX (CRUDEOILM) is Dhan-only for now: Kotak counts MCX quantity in absolute units (100x off Dhan's lots)
 *  and Zerodha has no MCX instrument cache here, so a non-Dhan MCX order would be mis-sized or unroutable. */
function brokerTradesUnderlying(broker: Broker, u: FocusUnderlying): boolean {
  return !isMcxUnderlying(u) || broker === 'dhan';
}

// Order-routing vocabulary. SENSEX is the only BSE underlying here, and each
// broker spells the same exchange differently — Dhan takes a segment, Kite an
// exchange code, Neo a lower-case one.
const UNDERLYING_SEGMENT = Object.fromEntries(FOCUS_UNDERLYINGS.map(u => [u, UNDERLYING_META[u].segment])) as Record<FocusUnderlying, string>;

function orderExchange(broker: Broker, u: FocusUnderlying): string {
  const bse = u === 'SENSEX';
  if (broker === 'dhan')  return UNDERLYING_SEGMENT[u];
  if (broker === 'kotak') return bse ? 'bse_fo' : 'nse_fo';
  return bse ? 'BFO' : 'NFO';
}

// A group's product in each broker's own vocabulary. Sent on every order: an
// order route that receives no product defaults to intraday, and an intraday
// order against an NRML position does not reduce it — the broker opens a fresh
// intraday position on the other side instead (see the dhan-broker-positions
// skill). Reducing orders re-resolve this from the live position's own product.
const PRODUCT_ALIAS: Record<'INTRADAY' | 'MARGIN', Record<Broker, string>> = {
  INTRADAY: { dhan: 'INTRADAY', zerodha: 'MIS',  kotak: 'MIS'  },
  MARGIN:   { dhan: 'MARGIN',   zerodha: 'NRML', kotak: 'NRML' },
};

/**
 * Pick the one position that matches `wantProduct` out of a same-symbol/id
 * candidate list, or the single unambiguous candidate if none carries a
 * recognised product.
 *
 * Same strike can be open under two products at once (this row plus a
 * running strategy, or the other product tab) — matching by id/symbol alone
 * resolves both to whichever the broker lists first, so one book gets closed
 * twice and the other never (see lib/positionProduct.ts).
 */
function pickPositionByProduct(candidates: PosRow[], wantProduct: string): PosRow | null {
  if (candidates.length === 0) return null;
  const matched = candidates.find(
    p => positionProduct(p as unknown as Record<string, unknown>) === wantProduct);
  if (matched) return matched;
  return candidates.length === 1
    && !positionProduct(candidates[0] as unknown as Record<string, unknown>)
    ? candidates[0] : null;
}

/**
 * The broker position for one leg's contract, as named by `ref` (a strike's
 * lookup entry) — NOT by a row's resolved/pinned strike. Callers that need
 * "whatever this row currently holds" go through `rowLive.cePosition`/
 * `pePosition` instead; this is for callers (like a strike-shift reopen) that
 * must resolve a position for a SPECIFIC contract that may differ from the
 * row's current pin.
 */
function findPositionForRef(
  positions: PosRow[],
  broker: Broker,
  ref: StrikeRef | undefined,
  leg: 'CE' | 'PE',
  wantProduct: string,
): PosRow | null {
  // Dhan is the only broker with a numeric security id; the rest join by
  // trading symbol.
  if (broker === 'dhan') {
    const id = leg === 'CE' ? ref?.ceId : ref?.peId;
    if (!id) return null;
    return pickPositionByProduct(positions.filter(p => String(p.securityId) === String(id)), wantProduct);
  }
  const sym = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
  if (!sym) return null;
  return pickPositionByProduct(positions.filter(p => String(p.tradingSymbol) === sym), wantProduct);
}

// Per-underlying accent colours for group cards
const UNDERLYING_DOT: Record<FocusUnderlying, string> = {
  NIFTY: 'bg-violet-500',
  BANKNIFTY: 'bg-sky-500',
  SENSEX: 'bg-amber-500',
  CRUDEOILM: 'bg-emerald-500',
};
const UNDERLYING_TXT: Record<FocusUnderlying, string> = {
  NIFTY: 'text-violet-400',
  BANKNIFTY: 'text-sky-400',
  SENSEX: 'text-amber-400',
  CRUDEOILM: 'text-emerald-400',
};
const UNDERLYING_CHIP: Record<FocusUnderlying, string> = {
  NIFTY: 'bg-violet-500/10 text-violet-400 border-violet-500/25',
  BANKNIFTY: 'bg-sky-500/10 text-sky-400 border-sky-500/25',
  SENSEX: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
  CRUDEOILM: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
};

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function fmtInr(n: number, signed = false): string {
  if (!Number.isFinite(n)) return '\u2014';
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '\u2212' : signed && n > 0 ? '+' : '';
  return `${sign}\u20B9${str}`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '\u2014';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Wall-clock 'HH:MM' in IST, regardless of the browser's own timezone. */
function istHm(): string {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Today's calendar date in IST, 'YYYY-MM-DD'. */
function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Whole days from today (IST) to `expiry`. The clock is read here so the pure
 *  rule (dteForExpiry) stays testable at any date. */
function dteFor(expiry: string): number | null {
  return dteForExpiry(expiry, istToday());
}


/** Whether Focus WS buildup applies to this row, plus an expiry-mismatch hint.
 *
 *  The bridge subscribes to the union of expiries Focus Tool rows need
 *  (comma-separated in status/quotes). A row whose date is not in that set
 *  still gets polled-chain LTP, so without this the strike column looks
 *  "live" with no LB/SB chip and no explanation.
 *
 *  Prefer live quote book keys; fall back to the status-file fingerprint so a
 *  RUNNING bridge with a momentarily empty quotes object still arms the slot. */
function rowBuildupWsFlags(
  row: FocusRow,
  wsLive: boolean,
  subscribedExpiries: string | undefined,
): { buildupWsActive: boolean; buildupExpiryHint: string | null } {
  if (!wsLive || !subscribedExpiries) {
    return { buildupWsActive: false, buildupExpiryHint: null };
  }
  const set = subscribedExpiries.split(',').map(s => s.trim()).filter(Boolean);
  if (set.length === 0) {
    return { buildupWsActive: false, buildupExpiryHint: null };
  }
  const matches = !row.expiry || set.includes(row.expiry);
  return {
    buildupWsActive: matches,
    buildupExpiryHint: matches
      ? null
      : `OI buildup is only available on Focus WS expiries (${set.join(', ')}). This row is on ${row.expiry}.`,
  };
}

/** Comma-joined expiries the Focus WS should subscribe for one underlying:
 *  always nearest, plus every explicit (or blank→nearest) row expiry. */
function bridgeExpiriesForUnderlying(
  u: FocusUnderlying,
  rows: FocusRow[],
  listed: string[],
): string {
  const nearest = listed[0];
  if (!nearest) return '';
  const needed = new Set<string>([nearest]);
  for (const r of rows) {
    if (r.underlying !== u) continue;
    needed.add(r.expiry || nearest);
  }
  const rest = [...needed].filter(e => e !== nearest).sort();
  return [nearest, ...rest].join(',');
}

function newId(): string {
  return `ft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** A rupee leg value, or an em dash while the lot size is still unresolved. */
function fmtValue(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function pnlClass(n: number | null | undefined): string {
  if (n == null || n === 0) return 'text-zinc-400';
  return n > 0 ? 'text-emerald-400' : 'text-rose-400';
}

/**
 * Which of this page's underlyings a broker trading symbol belongs to, or null.
 *
 * A bare `startsWith` is wrong: NIFTYNXT50 and BANKNIFTY both start with
 * "NIFTY", so a prefix test alone files their P&L under NIFTY. Every broker's
 * option symbol continues into the expiry immediately after the underlying, so
 * the next character is a digit or separator — a letter there means this is a
 * different instrument. Longest name first, so BANKNIFTY is tested before the
 * NIFTY prefix it contains.
 */
function underlyingOfSymbol(tradingSymbol: string | undefined): FocusUnderlying | null {
  const sym = String(tradingSymbol ?? '').toUpperCase();
  for (const u of ['CRUDEOILM', 'BANKNIFTY', 'SENSEX', 'NIFTY'] as FocusUnderlying[]) {
    if (!sym.startsWith(u)) continue;
    const next = sym.charAt(u.length);
    if (next && next >= 'A' && next <= 'Z') return null;
    return u;
  }
  return null;
}

/**
 * Per-leg rupee value and the PE/CE ratios between them, for the row's LTP
 * display.
 *
 * Value is premium × CONTRACTS, not premium × lots: one NIFTY lot at a premium
 * of 100 is worth 100 × 65 = ₹6,500, and the old `× row.lots` form printed
 * "₹100" — a number in no unit at all. Contracts come from what the row
 * actually holds once it is open, and from its configured size before that.
 * Null when the lot size has not resolved yet, so the cell shows — rather than
 * a confident zero.
 *
 * `pcr` is premium-value PCR (PE ₹ ÷ CE ₹). `pcrOi` is open-interest PCR at
 * the same strikes (PE OI ÷ CE OI), off the live WS ticks.
 */
function legValues(row: FocusRow, live: RowLive, lotSize: number | null): {
  ceValue: number | null; peValue: number | null; totalValue: number | null;
  pcr: number | null; pcrOi: number | null;
} {
  const lot = lotSize && lotSize > 0 ? lotSize : 0;
  const units = (leg: 'CE' | 'PE'): number => {
    const held = Math.abs(Number((leg === 'CE' ? live.cePosition : live.pePosition)?.netQty) || 0);
    return held > 0 ? held : row.lots * lot;
  };
  const value = (ltp: number | null, leg: 'CE' | 'PE'): number | null => {
    const n = units(leg);
    return n > 0 ? (ltp ?? 0) * n : null;
  };
  const ceValue = value(live.ltpCe, 'CE');
  const peValue = value(live.ltpPe, 'PE');
  // Combined rupee value across every lot this row holds (or is sized for)
  // on both legs — ceValue/peValue are per-leg; a straddle's actual notional
  // is the two added together, not either one alone.
  const totalValue = ceValue == null && peValue == null ? null : (ceValue ?? 0) + (peValue ?? 0);
  return {
    ceValue, peValue, totalValue,
    pcr: valuePutCallRatio(peValue, ceValue, live.ltpPe, live.ltpCe),
    pcrOi: putCallRatio(live.peOi, live.ceOi),
  };
}

/** Computes the live mark-to-market P&L for a single owned leg of a row. */
function computeLegPnl(row: FocusRow, leg: 'CE' | 'PE', live: RowLive): number | null {
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  if (!pos || !rowOwnsLeg(row, leg)) return null;
  const brokerQty = Math.abs(Number(pos.netQty) || 0);
  if (brokerQty <= 0) return null;
  const owned = legOwnContracts(row, leg, live);
  const qty = Math.min(owned > 0 ? owned : 0, brokerQty);
  if (qty <= 0) return null;
  const ltp = leg === 'CE' ? live.ltpCe : live.ltpPe;
  if (ltp != null && ltp > 0) {
    return mtmForQty({
      netQty: Number(pos.netQty) || 0,
      buyAvg: Number(pos.buyAvg) || 0,
      sellAvg: Number(pos.sellAvg) || 0,
      ltp,
      qty,
    });
  }
  return (Number(pos.unrealizedProfit) || 0) * (qty / brokerQty);
}

/** Compact LTP column: combined premium → VWAP 1m → CE/PE → ₹ values → total ₹ → PnL → Val/OI PCR strip. */
function LtpStack({
  combinedLtp, live, ceValue, peValue, totalValue, pcr, pcrOi, compact = false,
}: {
  combinedLtp: number;
  live: RowLive;
  ceValue: number | null;
  peValue: number | null;
  totalValue: number | null;
  pcr: number | null;
  pcrOi: number | null;
  compact?: boolean;
}) {
  const oiTitle = live.peOi != null && live.ceOi != null
    ? `OI PCR = PE OI ÷ CE OI at this row's strikes (${live.peOi.toLocaleString('en-IN')} / ${live.ceOi.toLocaleString('en-IN')})`
    : "OI PCR = PE OI ÷ CE OI at this row's strikes";
  return (
    <div className={cn('flex flex-col min-w-[9.75rem]', compact ? 'gap-1' : 'gap-1.5')}>
      <div>
        <div className="text-[11px] font-black uppercase tracking-[0.14em] text-zinc-500 leading-none mb-1">Prem</div>
        <div
          title="Combined CE + PE premium right now"
          className={cn(
            'font-mono font-black text-zinc-100 tabular-nums leading-none',
            compact ? 'text-sm' : 'text-base',
          )}
        >
          {combinedLtp > 0 ? combinedLtp.toFixed(2) : '\u2014'}
        </div>
        <div
          title="Session VWAP of the combined CE+PE premium, fixed 1-minute interval \u2014 independent of this row's own VW exit-rule setting"
          className="text-[10px] font-mono font-semibold text-violet-400 tabular-nums leading-none mt-1"
        >
          VWAP 1m {live.vwap1m != null ? live.vwap1m.toFixed(2) : '\u2014'}
        </div>
      </div>
      <div className={cn(
        'font-mono font-bold flex items-baseline gap-1 tabular-nums leading-none',
        compact ? 'text-[11px]' : 'text-xs',
      )}>
        <span className="text-emerald-400">CE {live.ltpCe != null ? live.ltpCe.toFixed(2) : '\u2014'}</span>
        <span className="text-zinc-600" aria-hidden>/</span>
        <span className="text-rose-400">PE {live.ltpPe != null ? live.ltpPe.toFixed(2) : '\u2014'}</span>
      </div>
      <div
        className="text-[10px] font-mono font-semibold flex items-baseline gap-1 whitespace-nowrap tabular-nums leading-none"
        title="Value = premium × contracts held (or contracts this row is sized for, before it opens)"
      >
        <span className="text-emerald-500">₹{fmtValue(ceValue)}</span>
        <span className="text-zinc-700" aria-hidden>/</span>
        <span className="text-rose-500">₹{fmtValue(peValue)}</span>
      </div>
      <div
        className={cn(
          'font-mono font-black text-zinc-100 tabular-nums leading-none whitespace-nowrap',
          compact ? 'text-[11px]' : 'text-xs',
        )}
        title="Total rupee value across every lot this row holds — CE + PE combined"
      >
        Total ₹{fmtValue(totalValue)}
      </div>
      <div className="flex items-center justify-between text-[11px] font-mono leading-none py-1 border-t border-zinc-800/60">
        <span className="text-[11px] font-black uppercase tracking-wider text-zinc-400">P&amp;L</span>
        <span className={cn(
          'font-black tabular-nums',
          live.pnl > 0 ? 'text-emerald-400' : live.pnl < 0 ? 'text-rose-400' : 'text-zinc-400'
        )} title="Row current total P&L (realized + open mark-to-market)">
          {live.pnl > 0 ? '+' : ''}₹{live.pnl.toFixed(0)}
        </span>
      </div>
      <div className="flex rounded-md border border-zinc-800 divide-x divide-zinc-800 overflow-hidden">
        <span
          className="flex-1 min-w-0 px-1.5 py-1 flex flex-col gap-0.5"
          title="Val PCR = PE ₹ value ÷ CE ₹ value at this row's strikes (falls back to PE premium ÷ CE premium if ₹ values are unresolved)"
        >
          <span className="text-[11px] font-black tracking-widest text-amber-500 leading-none">VAL</span>
          <span className={cn(
            'font-mono font-bold text-amber-400 tabular-nums leading-none',
            compact ? 'text-[11px]' : 'text-xs',
          )}>
            {pcr != null ? pcr.toFixed(2) : '\u2014'}
          </span>
        </span>
        <span
          className="flex-1 min-w-0 px-1.5 py-1 flex flex-col gap-0.5"
          title={oiTitle}
        >
          <span className="text-[11px] font-black tracking-widest text-zinc-400 leading-none">OI</span>
          <span className={cn(
            'font-mono font-bold text-sky-400 tabular-nums leading-none',
            compact ? 'text-[11px]' : 'text-xs',
          )}>
            {pcrOi != null ? pcrOi.toFixed(2) : '\u2014'}
          </span>
        </span>
      </div>
    </div>
  );
}

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


/**
 * An order this page sent that its fill check could not confirm in full (a
 * rejection, or — Kotak/Zerodha have no fill socket — a book that lagged past
 * the check window).
 *
 *  - close: the ledger keeps the unconfirmed remainder, so the row keeps
 *    watching the leg; this record stops a retry from sending a SECOND close
 *    while the first may still be landing, which on a stale book would flip
 *    the short into a long.
 *  - open (re-entry, shift reopen, pending re-entry): a late fill of THIS
 *    order is credited to the ledger once confirmed, so it can't become a
 *    live short nothing watches. Clamped to this order's own size — never
 *    another row's or a manual position on the same contract.
 */
interface UnconfirmedOrder {
  kind: 'close' | 'open';
  rowId: string;
  leg: 'CE' | 'PE';
  /** Contract strike (opens stamp it into the ledger pin). */
  strike: number;
  /** Entry-price estimate for an open's late-credited qty. */
  entryPx: number;
  /** A Range Breakout open's range, stamped if the qty is credited late. */
  orb?: FocusOrbStamp | null;
  orderId: string | null;
  securityId: string | null;
  symbol: string | null;
  product: string;
  /** Broker net before the close went out. */
  netBefore: number;
  requested: number;
  /** Qty already credited to the ledger (confirmed at send time or since). */
  filled: number;
  side: 'BUY' | 'SELL';
  /** For banking P&L on a late-credited slice. */
  snap: { netQty: number; buyAvg: number; sellAvg: number; ltp: number };
  ts: number;
  lastCheck: number;
  lastToast: number;
}

/** How long a close with no broker verdict blocks a resend (book-based brokers). */
const UNCONFIRMED_ORDER_HOLD_MS = 15_000;
/** Live WS quotes older than this (market hours) are treated as a stalled feed. */
const WS_STALE_MS = 8_000;

/**
 * The legs a row's VWAP series should cover, and the strikes to key it on.
 *
 * A BOTH row with only one leg still open is judged on that leg alone — the
 * same rule sidePremium/entryPremium follow. Before per-leg pins, a closed
 * leg's old strike kept feeding the combined series; with them, the closed
 * leg re-resolves to the live ATM, so the series would even change as spot
 * moved. The unused strike is set to the used one so the fetch key (and
 * cache) stays put while the phantom leg's strike wanders.
 */
function vwapSeriesFor(
  row: FocusRow, ceStrike: number, peStrike: number,
): { side: FocusSide; ce: number; pe: number } {
  let side: FocusSide = row.side;
  if (side === 'BOTH') {
    const ce = rowOwnsLeg(row, 'CE');
    const pe = rowOwnsLeg(row, 'PE');
    if (ce && !pe) side = 'CE';
    else if (pe && !ce) side = 'PE';
  }
  if (side === 'CE') return { side, ce: ceStrike, pe: ceStrike };
  if (side === 'PE') return { side, ce: peStrike, pe: peStrike };
  return { side, ce: ceStrike, pe: peStrike };
}

/** Cache/lookup key for a strike pair's VWAP — shared across every row that
 *  happens to trade the same underlying/expiry/CE-strike/PE-strike/side/interval,
 *  so two rows on the same strangle at the same interval share one fetch
 *  instead of doubling it. Side is part of the key because a CE-only row
 *  needs a CE-only VWAP: comparing it against a combined CE+PE VWAP would
 *  exit at the wrong premium. Interval is part of the key so two rows on the
 *  same strangle at different intervals don't clobber each other's cached
 *  value. */
function vwapKey(
  underlying: FocusUnderlying, expiry: string, ceStrike: number, peStrike: number, side: FocusSide,
  interval: string,
): string {
  return `${underlying}:${expiry}:${ceStrike}:${peStrike}:${side}:${interval}`;
}

interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
  detail?: string;
}

// â”€â”€ Defaults â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const makeRow = (underlying: FocusUnderlying): FocusRow => ({
  id: newId(),
  underlying,
  // MCX runs to 23:30, so the NSE 09:20 / 15:15 pair would flatten it mid-session.
  entryTime: isMcxUnderlying(underlying) ? '09:30' : '09:20',
  exitTime: isMcxUnderlying(underlying) ? '23:10' : '15:15',
  dte: 'Any',
  expiry: '',
  strikeMode: 'ATM',
  linked: true,
  ceOffset: 0,
  peOffset: 0,
  cePremium: '',
  pePremium: '',
  lots: 1,
  side: 'BOTH',
  status: 'draft',
  // New rows paper-trade until the user deliberately flips them to REAL.
  mode: 'sim',
  levelHigh: '',
  levelLow: '',
  levelVw: false,
  vwapInterval: '1',
  vwapBufferPct: '0.1',
  slRupees: '',
  // Pair SL × starts off (blank); the per-leg SL × below stay at 1.2.
  slMultiplier: '',
  ceSlMultiplier: '1.2',
  peSlMultiplier: '1.2',
  slRollStrikes: 0,
  slRollMax: DEFAULT_SL_ROLL_MAX,
  slToCost: false,
  reSlMode: 'off',
  reTgtMode: 'off',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const makeGroup = (underlying: FocusUnderlying): FocusIndexGroup => ({
  underlying,
  enabled: false,
  atmBy: 'Spot',
  product: 'INTRADAY',
  strikesOffset: 0,
  bookExit: false,
  spotHigh: '',
  spotLow: '',
});

const DEFAULT_CONFIG: FocusToolConfig = {
  groups: UNDERLYINGS.map(makeGroup),
  rows: [],
  riskEnabled: false,
  targetRupees: '',
  stopRupees: '',
  trailEnabled: false,
  triggerRupees: '',
  lockRupees: '',
  liveRealMoney: false,
  liveArmedOn: '',
  updatedAt: new Date().toISOString(),
};

// â”€â”€ Primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Visible keyboard-only focus ring for every clickable control on this page.
 *  Inputs already get their own `focus:ring-violet-500/40` via RuleNumInput;
 *  Arm/Exit/Delete/EXIT ALL had no visual confirmation of where focus was —
 *  a real hazard on a page that fires live orders. `focus-visible` (not
 *  `focus`) keeps mouse clicks silent, matching the inputs' own behaviour. */
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

/** Type scale for dense control/label text, named once so new UI picks one
 *  of four instead of a fifth arbitrary value. Raised one step (2026-09-30)
 *  after 8–9px labels proved unreadable: nothing new should go below 10px. */
const TXT_MICRO   = 'text-[10px]'; // stat labels (SPOT/ATM/LOT/DTE), column footnotes
const TXT_LABEL   = 'text-[11px]'; // field labels, badges, uppercase tags — default micro size
const TXT_VALUE   = 'text-xs';     // secondary readouts: VWAP, PCR, timing text
const TXT_CAPTION = 'text-[13px]'; // switch labels, primary compact inputs

function LivePulse({ active }: { active: boolean }) {
  return (
    <span title={active ? 'Live tick feed connected' : 'Live tick feed not running'} className={cn(
      'inline-flex items-center gap-1.5 text-[11px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider border',
      active
        ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
        : 'bg-zinc-800 text-zinc-500 border-zinc-700',
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-rose-400 animate-pulse' : 'bg-zinc-600')} />
      LIVE
    </span>
  );
}

function SwitchToggle({
  checked, onChange, label, title,
}: { checked: boolean; onChange: (v: boolean) => void; label?: string; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!checked)}
      className={cn('inline-flex items-center gap-1.5', TXT_CAPTION, 'font-bold text-zinc-300 cursor-pointer select-none rounded', FOCUS_RING)}
    >
      <span className={cn(
        'h-4 w-7 rounded-full border transition-all flex items-center px-0.5',
        checked ? 'bg-violet-600 border-violet-600' : 'bg-zinc-800 border-zinc-700',
      )}>
        <span className={cn(
          'h-3 w-3 rounded-full bg-oncolor shadow-sm transition-transform',
          checked ? 'translate-x-3' : 'translate-x-0',
        )} />
      </span>
      {label}
    </button>
  );
}

/**
 * A number box that commits on blur or Enter, never per keystroke.
 *
 * Every value this wraps is read by an executor that places real orders — the
 * scheduler and the level-exit watcher both read component state directly.
 * Committing per keystroke means typing a Stop of "5000" transiently commits
 * 5, and a tick landing in that window flattens the book. Same for an H↑ of
 * "25600": the first keystroke is 2, and spot is always >= 2.
 *
 * Discrete controls (selects, toggles, +/- steppers) still commit immediately —
 * each click is a complete choice, not a partial edit.
 */
function RuleNumInput({ value, onCommit, placeholder, className, title, disabled }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; className?: string;
  title?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // Re-sync when the value changes underneath us (a config load, a clear
  // button) — but never while this field has focus, or the user's own typing
  // would be reverted mid-edit.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      title={title}
      disabled={disabled}
      value={draft}
      placeholder={placeholder}
      onFocus={() => { focusedRef.current = true; }}
      onChange={e => setDraft(e.target.value)}
      onBlur={e => { focusedRef.current = false; commit(e.currentTarget.value); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); }
      }}
      className={cn(
        'h-7 text-[11px] font-mono font-bold px-2 border border-zinc-700 rounded-md',
        'bg-zinc-900 text-zinc-100 placeholder-zinc-600',
        'focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/40',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
    />
  );
}

/** RuleNumInput flanked by -/+ steppers, step size 1 — for level-exit H/L price fields. */
function RuleNumStepper({ value, onCommit, className, title, disabled, wrapperClassName }: {
  value: string; onCommit: (v: string) => void; className?: string; title?: string; disabled?: boolean;
  wrapperClassName?: string;
}) {
  const step = (delta: number) => onCommit(String((Number(value) || 0) + delta));
  return (
    <div className={cn('inline-flex items-center gap-0.5', wrapperClassName)}>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={disabled}
        title="Decrease by 1"
        aria-label="Decrease by 1"
        className={cn('h-5 w-4 shrink-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}
      >
        -
      </button>
      <RuleNumInput value={value} onCommit={onCommit} className={className} title={title} disabled={disabled} />
      <button
        type="button"
        onClick={() => step(1)}
        disabled={disabled}
        title="Increase by 1"
        aria-label="Increase by 1"
        className={cn('h-5 w-4 shrink-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}
      >
        +
      </button>
    </div>
  );
}

/** Lots-per-leg config field: a number box flanked by -/+ steppers, clamped at 1. */
function LotStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        title="Reduce lots by one"
        aria-label="Reduce lots by one"
        className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors', FOCUS_RING)}
      >
        -
      </button>
      <RuleNumInput
        value={String(value)}
        onCommit={v => onChange(Math.max(1, Number(v) || 1))}
        className="w-10 text-center px-1"
        title="Lots to trade per leg — applied on Enter or when you click away"
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        title="Add one lot"
        aria-label="Add one lot"
        className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors', FOCUS_RING)}
      >
        +
      </button>
    </div>
  );
}

/** Lots the CE/PE +/- buttons act on — a select, not a free-typed box.
 *
 * The old NumInput forced `Math.max(1, Number(v) || 1)` on every keystroke, so
 * clearing the default "1" to type "2" snapped straight back to 1. A dropdown
 * is a single click and cannot get stuck mid-edit.
 */
const LEG_LOT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20] as const;

/**
 * A compact shadcn Select for this page's small fixed-choice pickers (lots,
 * re-entry mode/max, OTM steps, momentum direction). Each pick is a complete
 * choice, so it commits at once — free-typed values still go through
 * RuleNumInput's commit-on-blur.
 */
function MiniSelect({ value, options, onChange, ariaLabel, title, className, disabled }: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
  ariaLabel: string;
  title?: string;
  className?: string;
  disabled?: boolean;
}) {
  const labelOf = (v: string) => options.find(o => o.value === v)?.label ?? v;
  return (
    <Select value={value} disabled={disabled} onValueChange={v => { if (v != null) onChange(String(v)); }}>
      <SelectTrigger size="sm" aria-label={ariaLabel} title={title}
        className={cn('h-6 min-w-0 gap-1 px-1.5 text-[11px] font-bold bg-zinc-950/60 border-zinc-700 text-zinc-200', className)}>
        <SelectValue>{(v: string) => labelOf(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function LegLotSelect({ value, onChange, className, title }: {
  value: number;
  onChange: (v: number) => void;
  className?: string;
  title?: string;
}) {
  const opts = (LEG_LOT_OPTIONS as readonly number[]).includes(value)
    ? LEG_LOT_OPTIONS
    : [...LEG_LOT_OPTIONS, value].sort((a, b) => a - b);
  return (
    <MiniSelect value={String(value)} options={opts.map(n => ({ value: String(n), label: String(n) }))}
      onChange={v => onChange(Math.max(1, Number(v) || 1))}
      ariaLabel={title ?? 'Lots'} title={title} className={className} />
  );
}

/** Whether-this-leg-is-actually-open badge, read straight off the broker
 *  position (never the row's own Draft/Armed/Entered status, which nothing
 *  here sets automatically). Shows the broker's own average price (sellAvg
 *  for a short, buyAvg for a long — the only place this tool's entry price
 *  comes from, it never stamps its own). Renders nothing when flat. */
function LegOpenBadge({ pos }: { pos: PosRow | null }) {
  const qty = Number(pos?.netQty ?? 0);
  if (!qty) return null;
  const avg = qty < 0 ? Number(pos?.sellAvg) || 0 : Number(pos?.buyAvg) || 0;
  return (
    <span
      title={`${pos?.productType === 'SIM' ? 'Paper position' : 'Broker position'}: ${qty > 0 ? 'long' : 'short'} ${Math.abs(qty)} @ avg ${avg.toFixed(2)}`}
      className={cn(
        'text-[11px] font-black px-1 py-0.5 rounded border uppercase tracking-wide whitespace-nowrap',
        qty < 0
          ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
          : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      )}
    >
      {qty < 0 ? 'S' : 'L'} {Math.abs(qty)} @ {avg.toFixed(2)}
    </span>
  );
}

/**
 * The row's REAL / SIM switch, plus a warning when a REAL row is armed but
 * cannot enter because LIVE · REAL MONEY is off for today — the silent
 * "armed but nothing happened" case. Locked while the row holds a position or
 * is armed; updateRow enforces the same rule on the state side.
 */
function RowModeToggle({ row, flat, liveRealMoney, onUpdate }: {
  row: FocusRow; flat: boolean; liveRealMoney: boolean;
  onUpdate: (patch: Partial<FocusRow>) => void;
}) {
  const sim = isSimRow(row);
  const locked = !flat || row.status === 'armed';
  const title = locked
    ? `${sim ? 'SIM' : 'REAL'} row — ${!flat ? 'exit its legs' : 'disarm it'} to switch modes`
    : sim
      ? 'SIM: paper fills at LTP, no broker orders. Click to make this row trade REAL money.'
      : 'REAL: places broker orders while LIVE · REAL MONEY is on. Click to forward-test on paper instead.';
  return (
    <>
      <button
        type="button"
        onClick={() => onUpdate({ mode: sim ? 'real' : 'sim' })}
        disabled={locked}
        title={title}
        aria-label={sim ? 'Row mode: simulated. Switch to real money' : 'Row mode: real money. Switch to simulated'}
        className={cn(
          'px-1.5 py-0.5 rounded border font-black uppercase tracking-wider cursor-pointer disabled:cursor-not-allowed',
          TXT_LABEL, FOCUS_RING,
          sim
            ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
            : 'bg-rose-500/15 text-rose-300 border-rose-500/40 hover:bg-rose-500/25',
          locked && 'opacity-70 hover:bg-transparent',
        )}
      >
        {sim ? 'SIM' : 'REAL'}
      </button>
      {!sim && row.status === 'armed' && !liveRealMoney && (
        <span
          title="This REAL row is armed but will not enter: LIVE · REAL MONEY is off for today. Turn it on, or disarm and switch the row to SIM."
          className={cn(TXT_LABEL, 'font-black px-1.5 py-0.5 rounded border uppercase tracking-wide whitespace-nowrap bg-rose-500/10 text-rose-400 border-rose-500/30')}
        >
          LIVE off
        </span>
      )}
    </>
  );
}

function slTone(now: number | null, stop: number | null, idle: string): string {
  if (now == null || stop == null || !(now > 0) || !(stop > 0)) return idle;
  if (now >= stop) return 'text-rose-400';
  if (now >= stop * 0.9) return 'text-amber-300';
  return idle;
}

const REENTRY_LABEL: Record<FocusReentryMode, string> = {
  off: 'Off', asap: 'RE ASAP', otm: 'RE OTM', cost: 'RE COST', momentum: 'RE MOMENTUM', lazy: 'Lazy Leg',
};
const REENTRY_HELP: Record<FocusReentryMode, string> = {
  off: 'Leg stays closed',
  asap: 'Re-sell at once at the strike the row resolves to now (ATM ± offset / ₹ target)',
  otm: 'Re-sell at once, N strikes further OTM than the strike that closed',
  cost: 'Wait on the same strike until its premium returns to that strike\'s initial entry this cycle, then re-sell',
  momentum: 'Pick the strike the row resolves to when the leg closes, then re-sell once it has moved as far as this '
    + 'leg\'s Simple Momentum says (premium or underlying, points or %). With no Simple Momentum it behaves exactly like RE ASAP. '
    + 'If that strike has no premium yet it waits up to 15s for one, then cancels. On a leg with Range Breakout it instead '
    + 'tracks a NEW range of the same length, starting when the leg closed, and re-sells when its high / low is reached. '
    + 'With Overall Momentum on it waits for the combined premium (this leg at the new strike) to move by the Overall Momentum',
  lazy: 'Open a Lazy Leg (defined below) in the place of the leg that closed. The leg slot must be free when it fires',
};
const REENTRY_MAX_OPTIONS = Array.from({ length: MAX_LEG_REENTRIES }, (_, i) => i + 1);

/** AlgoTest leg target types, as the row-wide unit of CE / PE Tgt. */
const LEG_TGT_UNIT_OPTIONS = [
  { value: 'pct', label: '%' }, { value: 'pts', label: 'pts' },
  { value: 'uPts', label: 'Underlying Pts' }, { value: 'uPct', label: 'Underlying %' },
  { value: 'delta', label: 'Delta' },
];
type LegTgtUnit = NonNullable<FocusRow['legTgtUnit']>;
function legTgtUnitWords(unit: FocusRow['legTgtUnit']): string {
  return unit === 'pts' ? 'premium points below its own entry'
    : unit === 'uPts' ? 'index points in its favour from the spot at entry (CE: down, PE: up)'
    : unit === 'uPct' ? '% index move in its favour from the spot at entry (CE: down, PE: up)'
    : unit === 'delta' ? 'delta (0–100) below its delta at entry'
    : '% below its own entry';
}

/** Is this leg's SL × replaced by another stop (another SL type, or an ORB Range stop)? */
function legSlOverridden(row: FocusRow, leg: 'CE' | 'PE'): string | null {
  const orb = leg === 'CE' ? row.ceOrbSl : row.peOrbSl;
  const rb = leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout;
  if (orb?.enabled && rb?.enabled) return 'ORB Range stop';
  const rule = leg === 'CE' ? row.ceSlRule : row.peSlRule;
  if (legSlRuleOn(rule)) {
    return rule.basis === 'pts' ? `SL ${rule.value} pts` : rule.basis === 'delta' ? `SL ${rule.value} delta`
      : `SL ${rule.value}${rule.basis === 'uPct' ? '%' : ' pts'} on the index`;
  }
  return null;
}

const LEG_SL_BASIS_OPTIONS = [
  { value: 'mult', label: 'SL × (Percentage)' },
  { value: 'pts', label: 'Points' },
  { value: 'uPts', label: 'Underlying Pts' },
  { value: 'uPct', label: 'Underlying %' },
  { value: 'delta', label: 'Delta' },
];

const STRIKE_CRITERIA_OPTIONS: { value: string; label: string; a: string; b?: string; help: string }[] = [
  { value: '', label: 'ATM ± / ₹ premium (row)', a: '', help: 'The strike editor: ATM ± steps, or the ₹ premium target as AlgoTest Closest Premium' },
  { value: 'ROUND', label: 'Round Strikes', a: 'OTM n', help: 'Count OTM (+) / ITM (−) strikes on round multiples of the interval; ATM itself is never counted' },
  { value: 'PREM_GTE', label: 'Premium >=', a: '₹', help: 'The cheapest strike with premium at or above this' },
  { value: 'PREM_LTE', label: 'Premium <= (Focus Tool)', a: '₹', help: 'Not AlgoTest: the richest strike at or below this — the ₹ target as a ceiling' },
  { value: 'PREM_RANGE', label: 'Premium Range', a: 'from ₹', b: 'to ₹', help: 'A strike with premium inside the range; a sell takes the highest' },
  { value: 'STRADDLE_WIDTH', label: 'Straddle Width', a: '± × straddle', help: 'ATM + this × the ATM straddle premium (e.g. 0.5 or -1), rounded to a strike' },
  { value: 'PCT_ATM', label: '% of ATM', a: '± %', help: 'ATM + this % of the ATM strike (e.g. -1 or 1), rounded to a strike' },
  { value: 'SYNTH_FUT', label: 'Synthetic Future', a: '± steps', help: 'Steps from the ATM of the synthetic future (ATM strike + ATM CE − ATM PE); same sign as ATM ±' },
  { value: 'ATM_PREM_PCT', label: 'ATM Straddle Premium %', a: '%', help: 'The strike whose premium is closest to this % of the ATM straddle premium' },
  { value: 'DELTA', label: 'Closest Delta', a: 'Δ 0–100', help: 'The strike whose |delta| × 100 is closest to this (chain delta)' },
  { value: 'DELTA_RANGE', label: 'Delta Range', a: 'from Δ', b: 'to Δ', help: 'A strike with |delta| inside the range; a sell takes the highest; none inside = the leg is skipped' },
  { value: 'EXACT', label: 'Exact Strike', a: 'strike', help: 'Trade exactly this strike (on the row\'s expiry)' },
];

/**
 * AlgoTest "Select Strike Criteria" for the row's legs, plus the row's
 * execution settings (Quantity Multiplier, Tgt/SL Ref Price) and a margin
 * estimate. Values are free-typed → RuleNumInput (commit on blur/Enter).
 */
function StrikeCriteriaControl({ row, onUpdate }: { row: FocusRow; onUpdate: (patch: Partial<FocusRow>) => void }) {
  const lbl = 'inline-flex items-center gap-1.5 font-bold text-zinc-400';
  const num = 'w-14 h-6 text-center text-[11px]';
  const opt = STRIKE_CRITERIA_OPTIONS.find(o => o.value === (row.strikeCriteria ?? '')) ?? STRIKE_CRITERIA_OPTIONS[0];
  const pinned = !!row.fill && (Number(row.fill.ceQty) > 0 || Number(row.fill.peQty) > 0);
  const [margin, setMargin] = useState<{ busy: boolean; text: string }>({ busy: false, text: '' });
  const estimateMargin = useContext(MarginEstimateContext);
  const estimate = useCallback(async () => {
    setMargin({ busy: true, text: '' });
    setMargin({ busy: false, text: await estimateMargin(row.id) });
  }, [row.id, estimateMargin]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <div className={lbl} title={`Select Strike Criteria (AlgoTest): ${opt.help}. Picked when the leg enters (and again for a re-entry). Open legs keep their strike.`}>
          Strike criteria
          <MiniSelect value={row.strikeCriteria ?? ''} ariaLabel="Strike criteria" disabled={pinned}
            options={STRIKE_CRITERIA_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
            onChange={v => onUpdate({ strikeCriteria: (v || undefined) as FocusRow['strikeCriteria'] })} className="w-52" />
        </div>
        {row.strikeCriteria && legsOf(row).map(leg => {
          const c = (leg === 'CE' ? row.ceCrit : row.peCrit) ?? { a: '', b: '' };
          const set = (patch: Partial<typeof c>) => onUpdate(leg === 'CE' ? { ceCrit: { ...c, ...patch } } : { peCrit: { ...c, ...patch } });
          return (
            <span key={leg} className={lbl}>
              {leg}
              <RuleNumInput value={c.a} onCommit={v => set({ a: v })} placeholder={opt.a} className={num} disabled={pinned} />
              {opt.b && <RuleNumInput value={c.b} onCommit={v => set({ b: v })} placeholder={opt.b} className={num} disabled={pinned} />}
            </span>
          );
        })}
        {row.strikeCriteria === 'ROUND' && (
          <div className={lbl} title="Strike interval the Round Strikes count on">Interval
            <MiniSelect value={String(row.roundInterval ?? 100)} ariaLabel="Round strike interval"
              options={[100, 200, 500, 1000].map(n => ({ value: String(n), label: String(n) }))}
              onChange={v => onUpdate({ roundInterval: Number(v) })} className="w-20" />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className={lbl} title="Quantity Multiplier (AlgoTest execution setting): every automatic entry's lots × this (entries, re-entries, lazy legs); MTM-based Overall SL / Target / trails scale with it, % ones do not">
          Qty ×
          <MiniSelect value={String(row.qtyMultiplier ?? 1)} ariaLabel="Quantity multiplier"
            options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `×${i + 1}` }))}
            onChange={v => onUpdate({ qtyMultiplier: Number(v) })} className="w-16" />
        </div>
        <div className={lbl} title="Tgt/SL Ref Price (AlgoTest): measure leg stops and targets from the LTP when the order went out (Trigger), or from the broker's average traded price (Traded — Dhan only; other brokers keep the trigger price)">
          Tgt/SL ref
          <MiniSelect value={row.refPrice ?? 'trigger'} ariaLabel="Target and stop reference price"
            options={[{ value: 'trigger', label: 'Trigger Price' }, { value: 'traded', label: 'Traded Price' }]}
            onChange={v => onUpdate({ refPrice: v as 'trigger' | 'traded' })} className="w-32" />
        </div>
        <button type="button" onClick={estimate} disabled={margin.busy}
          title="Estimate Margin: the broker's (Dhan) required margin for selling this row's legs at the strikes it resolves to now, lots × multiplier"
          className={cn('text-[11px] font-bold text-sky-300 hover:text-sky-200 disabled:text-zinc-600 cursor-pointer rounded', FOCUS_RING)}>
          {margin.busy ? 'Estimating…' : 'Estimate margin'}
        </button>
        {margin.text && <span className="text-[11px] font-mono font-semibold text-zinc-300">{margin.text}</span>}
      </div>
    </div>
  );
}

/**
 * AlgoTest per-leg stop loss types, Trail SL and the ORB Range stop, for each
 * leg the row trades. "SL × (Percentage)" keeps the row's own SL × input (×1.3
 * = 30%); any other type replaces it for that leg. Amounts are free-typed →
 * RuleNumInput (commit on blur/Enter).
 */
function LegStopRulesControl({ row, onUpdate }: { row: FocusRow; onUpdate: (patch: Partial<FocusRow>) => void }) {
  const lbl = 'inline-flex items-center gap-1.5 font-bold text-zinc-400';
  const num = 'w-12 h-6 text-center text-[11px]';
  return (
    <div className="flex flex-col gap-1">
      {legsOf(row).map(leg => {
        const rule: FocusLegSlRule = (leg === 'CE' ? row.ceSlRule : row.peSlRule) ?? { enabled: false, basis: 'pts', value: '' };
        const setRule = (patch: Partial<FocusLegSlRule>) => onUpdate(leg === 'CE' ? { ceSlRule: { ...rule, ...patch } } : { peSlRule: { ...rule, ...patch } });
        const trail: FocusLegTrailSl = (leg === 'CE' ? row.ceTrailSl : row.peTrailSl) ?? { enabled: false, unit: 'pts', every: '', by: '' };
        const setTrail = (patch: Partial<FocusLegTrailSl>) => onUpdate(leg === 'CE' ? { ceTrailSl: { ...trail, ...patch } } : { peTrailSl: { ...trail, ...patch } });
        const orb: FocusLegOrbSl = (leg === 'CE' ? row.ceOrbSl : row.peOrbSl) ?? { enabled: false, sign: '+', value: '', unit: 'pts' };
        const setOrb = (patch: Partial<FocusLegOrbSl>) => onUpdate(leg === 'CE' ? { ceOrbSl: { ...orb, ...patch } } : { peOrbSl: { ...orb, ...patch } });
        const rbOn = !!(leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout)?.enabled;
        const basis = rule.enabled ? rule.basis : 'mult';
        const onSpot = basis === 'uPts' || basis === 'uPct';
        return (
          <div key={leg} className="flex flex-wrap items-center gap-2">
            <div className={lbl} title={`${leg} stop loss type. SL × (Percentage) uses the ${leg} × box (×1.3 = 30% above entry). Points: premium points above entry. Underlying Pts / %: the index moving that far against the short from the spot at entry (CE: up, PE: down). Delta: |delta| (0–100) rising this far above its value at entry — read from Dhan's option chain, which the server caches for 30 s, so a delta stop can react up to ~30 s late. With no delta at entry it falls back to SL ×`}>
              {leg} SL
              <MiniSelect value={basis} ariaLabel={`${leg} stop loss type`} options={LEG_SL_BASIS_OPTIONS}
                onChange={v => {
                  const nextRule = v === 'mult' ? { ...rule, enabled: false } : { ...rule, enabled: true, basis: v as FocusLegSlRule['basis'] };
                  // A Delta stop trails in delta; a premium stop in points / %.
                  const unit: FocusLegTrailSl['unit'] = v === 'delta' ? 'delta' : (trail.unit === 'delta' ? 'pts' : trail.unit);
                  const nextTrail = { ...trail, unit };
                  onUpdate(leg === 'CE' ? { ceSlRule: nextRule, ceTrailSl: nextTrail } : { peSlRule: nextRule, peTrailSl: nextTrail });
                }}
                className="w-40" />
              {basis !== 'mult' && (
                <RuleNumInput value={rule.value} onCommit={v => setRule({ value: v })} placeholder="0" className={num} />
              )}
            </div>
            <label className={cn(lbl, 'cursor-pointer text-zinc-300', onSpot && 'opacity-50')}
              title={onSpot ? 'Trail SL moves a premium or delta stop; a stop on the underlying is not trailed'
                : basis === 'delta' ? `${leg} Trail SL "X - Y" in delta: every time the delta falls X, lower the stop by Y`
                : `${leg} Trail SL "X - Y": every time the premium falls X (points, or % of the entry price), lower the stop by Y`}>
              <Switch size="sm" checked={trail.enabled} disabled={onSpot} onCheckedChange={c => setTrail({ enabled: !!c })} aria-label={`${leg} Trail SL`} />
              Trail SL
            </label>
            {trail.enabled && !onSpot && (<>
              <MiniSelect value={trail.unit} ariaLabel={`${leg} Trail SL unit`}
                options={basis === 'delta' ? [{ value: 'delta', label: 'Delta' }] : [{ value: 'pts', label: 'Points' }, { value: 'pct', label: 'Percentage' }]}
                onChange={v => setTrail({ unit: v as FocusLegTrailSl['unit'] })} className="w-28" />
              <RuleNumInput value={trail.every} onCommit={v => setTrail({ every: v })} placeholder="X" className={num} title="X: the move in your favour" />
              <span className="text-zinc-500">−</span>
              <RuleNumInput value={trail.by} onCommit={v => setTrail({ by: v })} placeholder="Y" className={num} title="Y: how far the stop moves" />
            </>)}
            {rbOn && (<>
              <label className={cn(lbl, 'cursor-pointer text-zinc-300')}
                title={`${leg} stop loss based on the Range Breakout range: (range high − low) ± points or % of the range, measured from the level the leg broke out at, against the position. Replaces the other ${leg} stop`}>
                <Switch size="sm" checked={orb.enabled} onCheckedChange={c => setOrb({ enabled: !!c })} aria-label={`${leg} ORB Range stop loss`} />
                ORB Range SL
              </label>
              {orb.enabled && (<>
                <MiniSelect value={orb.sign} ariaLabel={`${leg} ORB stop sign`}
                  options={[{ value: '+', label: '+' }, { value: '-', label: '−' }]}
                  onChange={v => setOrb({ sign: v as '+' | '-' })} className="w-12" />
                <RuleNumInput value={orb.value} onCommit={v => setOrb({ value: v })} placeholder="0" className={num} />
                <MiniSelect value={orb.unit} ariaLabel={`${leg} ORB stop unit`}
                  options={[{ value: 'pts', label: 'Points' }, { value: 'pctRange', label: '% of Range' }]}
                  onChange={v => setOrb({ unit: v as 'pts' | 'pctRange' })} className="w-28" />
              </>)}
            </>)}
          </div>
        );
      })}
    </div>
  );
}

/** rowId → one-line "waiting on entry momentum" status, written by the scheduler. */
const EntryMomContext = createContext<Record<string, string>>({});
/** Per-row margin estimate (AlgoTest "Estimate Margin"), supplied by the page: it knows the resolved strikes. */
const MarginEstimateContext = createContext<(rowId: string) => Promise<string>>(async () => 'unavailable');

/** AlgoTest's momentum select labels. */
const MOM_TYPE_LABEL: Record<string, string> = {
  'pts:up': 'Points (Pts) ↑', 'pts:down': 'Points (Pts) ↓',
  'pct:up': 'Percentage (%) ↑', 'pct:down': 'Percentage (%) ↓',
};
const OVERALL_MOM_OPTIONS = Object.entries(MOM_TYPE_LABEL).map(([value, label]) => ({ value, label }));

/**
 * Overall Momentum (AlgoTest): enter only when the combined premium of the legs
 * moves by the set points / % up or down from its start premium, judged on the
 * live LTP or at the candle close. Switch off = enter at the entry time.
 * Free-typed amount → RuleNumInput (commit on blur/Enter).
 */
function EntryMomentumControl({ row, onUpdate }: { row: FocusRow; onUpdate: (patch: Partial<FocusRow>) => void }) {
  const status = useContext(EntryMomContext)[row.id];
  const enabled = !!row.entryMomEnabled;
  const lbl = 'inline-flex items-center gap-1.5 font-bold text-zinc-400';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label className={cn(lbl, 'cursor-pointer text-zinc-300')}
          title="Overall Momentum: enter the trade only when the combined premium of the legs (1 lot each) moves by this much, up or down, from its start premium">
          <Switch size="sm" checked={enabled} onCheckedChange={c => onUpdate({ entryMomEnabled: !!c })} aria-label="Overall Momentum" />
          Overall Momentum
        </label>
        <MiniSelect value={`${row.entryMomUnit ?? 'pts'}:${row.entryMomDir ?? 'up'}`} ariaLabel="Overall momentum type"
          options={OVERALL_MOM_OPTIONS} disabled={!enabled}
          onChange={v => { const [unit, dir] = v.split(':'); onUpdate({ entryMomUnit: unit as 'pts' | 'pct', entryMomDir: dir as 'up' | 'down' }); }}
          className="w-36" />
        <RuleNumInput value={row.entryMomValue ?? ''} onCommit={v => onUpdate({ entryMomValue: v })} placeholder="0"
          disabled={!enabled} className="w-12 h-6 text-center text-[11px]" />
        <MiniSelect value={row.entryMomEval ?? 'ltp'} ariaLabel="Overall momentum evaluation"
          title="Live LTP checks every tick; Candle Close checks the last closed 1-minute candle's combined premium"
          options={[{ value: 'ltp', label: 'Live LTP' }, { value: 'candle', label: 'Candle Close' }]} disabled={!enabled}
          onChange={v => onUpdate({ entryMomEval: v as 'ltp' | 'candle' })} className="w-28" />
        {row.entryMomEval === 'candle' && (
          <MiniSelect value={String(row.entryMomCandleMin ?? 1)} ariaLabel="Overall momentum candle interval" disabled={!enabled}
            title="Candle interval for Candle Close (AlgoTest does not name its own)"
            options={[1, 3, 5, 15].map(n => ({ value: String(n), label: `${n} min` }))}
            onChange={v => onUpdate({ entryMomCandleMin: Number(v) })} className="w-20" />
        )}
        {enabled && status && <span className="text-[11px] font-semibold text-amber-400" title={status}>{status}</span>}
      </div>
      {legsOf(row).map(leg => (
        <React.Fragment key={leg}>
          <LegSimpleMomControl row={row} leg={leg} onUpdate={onUpdate}
            disabled={enabled} exclusiveNote={(leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout)?.enabled ? 'Range Breakout' : undefined} />
          <LegRangeBreakoutControl row={row} leg={leg} onUpdate={onUpdate}
            disabled={enabled} exclusiveNote={(leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom)?.enabled ? 'Simple Momentum' : undefined} />
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * AlgoTest "Range Breakout" switch on one leg: track the high / low between the
 * row's entry time and the range End, on the leg's strike or (Underlying) on
 * the index, and open the leg when the price reaches the High (or Low). The
 * strike is picked at the entry time. Does not work with Simple Momentum, and is
 * disabled while Overall Momentum is on.
 */
function LegRangeBreakoutControl({ row, leg, onUpdate, disabled, exclusiveNote }: {
  row: FocusRow; leg: 'CE' | 'PE'; onUpdate: (patch: Partial<FocusRow>) => void; disabled: boolean; exclusiveNote?: string;
}) {
  const status = useContext(EntryMomContext)[`${row.id}:${leg}`];
  const cur: FocusLegRangeBreakout = (leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout)
    ?? { enabled: false, end: '', side: 'high', on: 'instrument' };
  const set = (patch: Partial<FocusLegRangeBreakout>) => {
    const next = { ...cur, ...patch };
    onUpdate(leg === 'CE' ? { ceRangeBreakout: next } : { peRangeBreakout: next });
  };
  const blocked = disabled || !!exclusiveNote;
  const off = blocked || !cur.enabled;
  const invalid = cur.enabled && !rangeBreakoutOn(cur, row.entryTime);
  return (
    <div className={cn('flex flex-wrap items-center gap-2 font-bold text-zinc-400', blocked && 'opacity-50')}
      title={exclusiveNote ? `Range Breakout does not work with ${exclusiveNote}`
        : disabled ? 'Range Breakout is disabled while Overall Momentum is on'
        : `${leg} Range Breakout: track the high / low from the entry time (${row.entryTime || '—'}) to the range End, then open this leg when the price reaches that high / low. If it never does, there is no entry. The strike is picked at the entry time`}>
      <label className="inline-flex items-center gap-1.5 cursor-pointer text-zinc-300">
        <Switch size="sm" checked={cur.enabled} disabled={blocked} onCheckedChange={c => set({ enabled: !!c })}
          aria-label={`${leg} Range Breakout`} />
        {leg} Range Breakout
      </label>
      <MiniSelect value={cur.kind ?? 'intraday'} ariaLabel={`${leg} Range Breakout type`} disabled={off}
        title="Intraday: entry time → End today. BTST: entry time on the previous trading day → End today (AlgoTest End 'Tomorrow'). Positional: entry time on the Entry DTE day → End on the End DTE day (trading days before expiry; exchange holidays are not known)"
        options={[{ value: 'intraday', label: 'Intraday' }, { value: 'btst', label: 'BTST' }, { value: 'positional', label: 'Positional' }]}
        onChange={v => set({ kind: v as FocusLegRangeBreakout['kind'], ...(v === 'positional' && cur.startDte == null ? { startDte: 1, endDte: 0 } : {}) })}
        className="w-28" />
      {cur.kind === 'positional' && (<>
        <MiniSelect value={String(cur.startDte ?? 1)} ariaLabel={`${leg} range entry DTE`} disabled={off}
          title="Entry DTE: the day tracking starts (trading days before expiry; weekly 0–4, monthly 0–24)"
          options={Array.from({ length: 25 }, (_, i) => ({ value: String(i), label: `Entry DTE ${i}` }))}
          onChange={v => set({ startDte: Number(v) })} className="w-28" />
        <MiniSelect value={String(cur.endDte ?? 0)} ariaLabel={`${leg} range end DTE`} disabled={off}
          title="End DTE: the day tracking stops; the leg can enter that day after End"
          options={Array.from({ length: 25 }, (_, i) => ({ value: String(i), label: `End DTE ${i}` }))}
          onChange={v => set({ endDte: Number(v) })} className="w-28" />
      </>)}
      <label className="inline-flex items-center gap-1.5" title={`Range start = the row's entry time (shared by every leg of this row; edit here or in Window). ${cur.kind === 'btst' ? 'BTST: this time on the previous trading day.' : cur.kind === 'positional' ? 'Positional: this time on the Entry DTE day.' : ''}`}>
        Start
        <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: clampHm(v, UNDERLYING_META[row.underlying].entryMinHm, UNDERLYING_META[row.underlying].entryMaxHm) })} className="w-[5.5rem]" />
      </label>
      <label className="inline-flex items-center gap-1.5" title="Range end — the last tracked second is one second before it">
        {cur.kind === 'btst' ? 'End (next day)' : 'End'}
        <TimeInput value={cur.end} onChange={v => set({ end: v })} className="w-[5.5rem]" />
      </label>
      <MiniSelect value={cur.side} ariaLabel={`${leg} Range Breakout side`} disabled={off}
        options={[{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }]}
        onChange={v => set({ side: v as 'high' | 'low' })} className="w-20" />
      <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer"
        title="On: the range is the index's high / low. Off: the range is this leg's own strike (picked at the entry time)">
        <Switch size="sm" checked={cur.on === 'underlying'} disabled={off}
          onCheckedChange={c => set({ on: c ? 'underlying' : 'instrument' })} aria-label={`${leg} Range Breakout on underlying`} />
        Underlying
      </label>
      {invalid && !blocked && <span className="text-[11px] font-semibold text-rose-400">{(cur as FocusLegRangeBreakout).kind === 'positional' ? 'End DTE must not be after Entry DTE (and on one day, End after the entry time)' : `End must be after the entry time ${row.entryTime}`}</span>}
      {!off && !invalid && status && <span className="text-[11px] font-semibold text-amber-400">{status}</span>}
    </div>
  );
}

const SIMPLE_MOM_OPTIONS = (['premium', 'underlying'] as const).flatMap(src =>
  (['pts', 'pct'] as const).flatMap(unit => (['up', 'down'] as const).map(dir => ({
    value: `${src}:${unit}:${dir}`,
    label: src === 'underlying'
      ? `Underlying ${unit === 'pts' ? 'Pts' : '%'} ${dir === 'up' ? '↑' : '↓'}`
      : MOM_TYPE_LABEL[`${unit}:${dir}`],
  }))));

/**
 * AlgoTest "Simple Momentum" switch on one leg: after the entry time, open the
 * leg only once its premium (or the underlying) has moved by the chosen amount
 * from where it stood at the entry time; the strike is picked at the entry time.
 * Disabled while Overall Momentum is on, as on AlgoTest.
 */
function LegSimpleMomControl({ row, leg, onUpdate, disabled, exclusiveNote }: {
  row: FocusRow; leg: 'CE' | 'PE'; onUpdate: (patch: Partial<FocusRow>) => void; disabled: boolean;
  /** The other entry gate that is on for this leg (they don't combine). */
  exclusiveNote?: string;
}) {
  const status = useContext(EntryMomContext)[`${row.id}:${leg}`];
  const cur: FocusLegSimpleMom = (leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom)
    ?? { enabled: false, value: '', src: 'premium', unit: 'pts', dir: 'up' };
  const set = (patch: Partial<FocusLegSimpleMom>) => {
    const next = { ...cur, ...patch };
    onUpdate(leg === 'CE' ? { ceSimpleMom: next } : { peSimpleMom: next });
  };
  const blocked = disabled || !!exclusiveNote;
  const off = blocked || !cur.enabled;
  return (
    <div className={cn('flex flex-wrap items-center gap-2 font-bold text-zinc-400', blocked && 'opacity-50')}
      title={exclusiveNote ? `Simple Momentum does not work with ${exclusiveNote}` : disabled ? 'Simple Momentum is disabled while Overall Momentum is on'
        : `${leg} Simple Momentum: after the entry time, open this leg only once its premium (or the underlying) has moved this much from where it was at the entry time. The strike is picked at the entry time`}>
      <label className="inline-flex items-center gap-1.5 cursor-pointer text-zinc-300">
        <Switch size="sm" checked={cur.enabled} disabled={blocked} onCheckedChange={c => set({ enabled: !!c })}
          aria-label={`${leg} Simple Momentum`} />
        {leg} Simple Momentum
      </label>
      <MiniSelect value={`${cur.src}:${cur.unit}:${cur.dir}`} ariaLabel={`${leg} Simple Momentum type`}
        options={SIMPLE_MOM_OPTIONS} disabled={off}
        onChange={v => { const [src, unit, dir] = v.split(':'); set({ src: src as FocusLegSimpleMom['src'], unit: unit as FocusLegSimpleMom['unit'], dir: dir as FocusLegSimpleMom['dir'] }); }}
        className="w-40" />
      <RuleNumInput value={cur.value} onCommit={v => set({ value: v })} placeholder="0" disabled={off}
        className="w-12 h-6 text-center text-[11px]" />
      <label className="inline-flex items-center gap-1.5"
        title="Momentum is measured from the premium (or spot) at the row's entry time. Shared by every leg of this row; edit here or in Window.">
        From
        <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: clampHm(v, UNDERLYING_META[row.underlying].entryMinHm, UNDERLYING_META[row.underlying].entryMaxHm) })} className="w-[5.5rem]" />
      </label>
      {!off && simpleMomOn(cur) && status && <span className="text-[11px] font-semibold text-amber-400">{status}</span>}
    </div>
  );
}

const LAZY_STRIKE_OPTIONS = [
  ...Array.from({ length: 30 }, (_, i) => 30 - i).map(n => ({ value: String(-n), label: `ITM${n}` })),
  { value: '0', label: 'ATM' },
  ...Array.from({ length: 30 }, (_, i) => i + 1).map(n => ({ value: String(n), label: `OTM${n}` })),
];

/**
 * AlgoTest Lazy Legs: legs that stay dormant until a leg's SL / target closes
 * it, then open in its place with their own strike, lots, SL % and target %.
 * A lazy leg's own SL / target can open the next one (up to 10 in all). Sell
 * side only. Lots / SL / target are free-typed → RuleNumInput (commit on blur).
 */
function LazyLegsEditor({ row, onUpdate }: { row: FocusRow; onUpdate: (patch: Partial<FocusRow>) => void }) {
  const [open, setOpen] = useState(false);
  const legs = row.lazyLegs ?? [];
  const lbl = 'inline-flex items-center gap-1.5 font-bold text-zinc-400';
  const setLeg = (id: string, patch: Partial<FocusLazyLeg>) =>
    onUpdate({ lazyLegs: legs.map(l => l.id === id ? { ...l, ...patch } : l) });
  const add = () => {
    if (legs.length >= MAX_LAZY_LEGS) return;
    const n = legs.reduce((m, l) => Math.max(m, Number(l.id.slice(1)) || 0), 0) + 1;
    onUpdate({
      lazyLegs: [...legs, { id: `L${n}`, leg: 'CE', otmSteps: 0, lots: row.lots || 1, slPct: '', tgtPct: '', onSl: '', onTgt: '' }],
    });
    setOpen(true);
  };
  const remove = (id: string) => onUpdate({
    lazyLegs: legs.filter(l => l.id !== id).map(l => ({ ...l, onSl: l.onSl === id ? '' : l.onSl, onTgt: l.onTgt === id ? '' : l.onTgt })),
    reSlLazyId: row.reSlLazyId === id ? '' : row.reSlLazyId,
    reTgtLazyId: row.reTgtLazyId === id ? '' : row.reTgtLazyId,
  });
  const nameOf = (id: string) => `Lazy ${legs.findIndex(l => l.id === id) + 1}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className={cn(lbl, 'cursor-pointer hover:text-zinc-200 rounded', FOCUS_RING)}
          title="Lazy Legs: legs opened when another leg's SL / target closes it, each with its own SL and target (up to 10)">
          Lazy Legs ({legs.length}) {open ? '▾' : '▸'}
        </button>
        <button type="button" onClick={add} disabled={legs.length >= MAX_LAZY_LEGS}
          className={cn('text-[11px] font-bold text-sky-300 hover:text-sky-200 disabled:text-zinc-600 cursor-pointer rounded', FOCUS_RING)}>
          + Add Lazy Leg
        </button>
      </div>
      {open && legs.map((l, i) => (
        <div key={l.id} className="flex flex-wrap items-center gap-2 pl-3 border-l border-zinc-700 text-[11px]">
          <span className="font-black text-zinc-300 w-12">Lazy {i + 1}</span>
          <MiniSelect value={l.leg} ariaLabel={`Lazy ${i + 1} option type`}
            options={[{ value: 'CE', label: 'CE' }, { value: 'PE', label: 'PE' }]}
            onChange={v => setLeg(l.id, { leg: v as 'CE' | 'PE' })} className="w-16" />
          <MiniSelect value={String(l.otmSteps)} ariaLabel={`Lazy ${i + 1} strike`}
            options={LAZY_STRIKE_OPTIONS} onChange={v => setLeg(l.id, { otmSteps: Number(v) })} className="w-20" />
          <label className={lbl}>Lots
            <RuleNumInput value={String(l.lots)} onCommit={v => setLeg(l.id, { lots: Math.max(1, Math.trunc(Number(v)) || 1) })}
              className="w-12 h-6 text-center text-[11px]" />
          </label>
          <label className={lbl} title="This lazy leg's own stop loss: type and amount. Blank = none">SL
            <MiniSelect value={l.slBasis ?? 'pct'} ariaLabel={`Lazy ${i + 1} stop loss type`}
              // The leg SL types; a lazy leg's Percentage is its own % box, not the row's SL ×.
              options={LEG_SL_BASIS_OPTIONS.map(o => (o.value === 'mult' ? { value: 'pct', label: 'Percentage' } : o))}
              onChange={v => setLeg(l.id, { slBasis: v as FocusLazyLeg['slBasis'] })} className="w-28" />
            <RuleNumInput value={l.slPct} onCommit={v => setLeg(l.id, { slPct: v })} placeholder="off" className="w-12 h-6 text-center text-[11px]" />
          </label>
          <label className={lbl} title="This lazy leg's own target: type and amount. Blank = none">Tgt
            <MiniSelect value={l.tgtUnit ?? 'pct'} ariaLabel={`Lazy ${i + 1} target type`} options={LEG_TGT_UNIT_OPTIONS}
              onChange={v => setLeg(l.id, { tgtUnit: v as FocusLazyLeg['tgtUnit'] })} className="w-28" />
            <RuleNumInput value={l.tgtPct} onCommit={v => setLeg(l.id, { tgtPct: v })} placeholder="off" className="w-12 h-6 text-center text-[11px]" />
          </label>
          <label className={lbl} title="This lazy leg's own Simple Momentum, measured from when it activates (off = it opens at once)">Momentum
            <MiniSelect value={l.simpleMom?.enabled ? `${l.simpleMom.src}:${l.simpleMom.unit}:${l.simpleMom.dir}` : 'off'}
              ariaLabel={`Lazy ${i + 1} simple momentum`}
              options={[{ value: 'off', label: 'Off' }, ...SIMPLE_MOM_OPTIONS]}
              onChange={v => {
                if (v === 'off') { setLeg(l.id, { simpleMom: l.simpleMom ? { ...l.simpleMom, enabled: false } : undefined }); return; }
                const [src, unit, dir] = v.split(':');
                setLeg(l.id, { simpleMom: { enabled: true, value: l.simpleMom?.value ?? '', src: src as FocusLegSimpleMom['src'], unit: unit as FocusLegSimpleMom['unit'], dir: dir as FocusLegSimpleMom['dir'] }, rangeBreakout: l.rangeBreakout ? { ...l.rangeBreakout, enabled: false } : undefined });
              }} className="w-40" />
            {l.simpleMom?.enabled && (
              <RuleNumInput value={l.simpleMom.value} onCommit={v => setLeg(l.id, { simpleMom: { ...l.simpleMom!, value: v } })} placeholder="0" className="w-12 h-6 text-center text-[11px]" />
            )}
          </label>
          <label className={lbl} title="This lazy leg's own Range Breakout: a range of this many minutes from when it activates; it opens when the high / low is reached">ORB min
            <RuleNumInput value={l.rangeBreakout?.minutes ?? ''} placeholder="off" className="w-12 h-6 text-center text-[11px]"
              onCommit={v => setLeg(l.id, {
                rangeBreakout: { enabled: Number(v) > 0, minutes: v, side: l.rangeBreakout?.side ?? 'high', on: l.rangeBreakout?.on ?? 'instrument' },
                ...(Number(v) > 0 && l.simpleMom ? { simpleMom: { ...l.simpleMom, enabled: false } } : {}),
              })} />
            {l.rangeBreakout?.enabled && (<>
              <MiniSelect value={l.rangeBreakout.side} ariaLabel={`Lazy ${i + 1} range side`}
                options={[{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }]}
                onChange={v => setLeg(l.id, { rangeBreakout: { ...l.rangeBreakout!, side: v as 'high' | 'low' } })} className="w-20" />
              <MiniSelect value={l.rangeBreakout.on} ariaLabel={`Lazy ${i + 1} range on`}
                options={[{ value: 'instrument', label: 'Option' }, { value: 'underlying', label: 'Index' }]}
                onChange={v => setLeg(l.id, { rangeBreakout: { ...l.rangeBreakout!, on: v as 'instrument' | 'underlying' } })} className="w-24" />
            </>)}
          </label>
          <label className={lbl} title="Lazy Leg to open when this one's SL closes it">On SL
            <MiniSelect value={l.onSl} ariaLabel={`Lazy ${i + 1} on stop loss`}
              options={[{ value: '', label: 'None' }, ...legs.filter(x => x.id !== l.id).map(x => ({ value: x.id, label: nameOf(x.id) }))]}
              onChange={v => setLeg(l.id, { onSl: v })} className="w-20" />
          </label>
          <label className={lbl} title="Lazy Leg to open when this one's target closes it">On Tgt
            <MiniSelect value={l.onTgt} ariaLabel={`Lazy ${i + 1} on target`}
              options={[{ value: '', label: 'None' }, ...legs.filter(x => x.id !== l.id).map(x => ({ value: x.id, label: nameOf(x.id) }))]}
              onChange={v => setLeg(l.id, { onTgt: v })} className="w-20" />
          </label>
          <button type="button" onClick={() => remove(l.id)} aria-label={`Remove Lazy ${i + 1}`}
            className={cn('text-zinc-500 hover:text-rose-400 cursor-pointer rounded', FOCUS_RING)}>&times;</button>
        </div>
      ))}
    </div>
  );
}

const OVERALL_MODE_OPTIONS = [
  { value: 'mtm', label: 'MTM' },
  { value: 'premiumPct', label: 'Total Premium %' },
];
const OVERALL_TRAIL_OPTIONS = [
  { value: 'lock', label: 'Lock' },
  { value: 'lockTrail', label: 'Lock and Trail' },
  { value: 'trailSl', label: 'Overall Trail SL' },
];
const OVERALL_RE_OPTIONS = [
  { value: 'asap', label: 'RE ASAP' },
  { value: 'momentum', label: 'RE MOMENTUM' },
];

/**
 * AlgoTest "Overall Strategy Settings" for one row: Overall SL, Overall Target,
 * Trailing Options and Re-entry on both. Overall SL is the row's own SL ₹ (MTM)
 * and SL × (Total Premium % — ×1.3 is 30%), so the two editors share one value.
 * Amounts are free-typed → RuleNumInput (commit on blur/Enter). Re-entry is sell
 * side only: AlgoTest's ↩ reverse variants are not offered.
 */
function OverallSettingsControls({ row, onUpdate }: { row: FocusRow; onUpdate: (patch: Partial<FocusRow>) => void }) {
  const lbl = 'inline-flex items-center gap-1.5 font-bold text-zinc-400';
  const num = 'w-16 h-6 text-center text-[11px]';
  const sw = (checked: boolean, onChange: (c: boolean) => void, label: string) => (
    <label className={cn(lbl, 'cursor-pointer text-zinc-300')}>
      <Switch size="sm" checked={checked} onCheckedChange={c => onChange(!!c)} aria-label={label} />
      {label}
    </label>
  );

  // ── Overall SL: the row's SL ₹ / SL × ──
  const sl = overallSlConfig(row);
  const slMode: FocusOverallMode = sl?.mode ?? 'premiumPct';
  const slValue = sl ? String(Math.round(sl.value * 1e6) / 1e6) : '';
  const setSl = (mode: FocusOverallMode, v: string) => {
    const n = Number(v);
    onUpdate(mode === 'mtm'
      ? { slRupees: n > 0 ? v : '', slMultiplier: '' }
      : { slRupees: '', slMultiplier: n > 0 ? String(Math.round((1 + n / 100) * 1e6) / 1e6) : '' });
  };

  // ── Overall Target ──
  const tgt = row.overallTarget ?? { enabled: false, mode: 'mtm' as const, value: '' };
  const setTgt = (patch: Partial<typeof tgt>) => onUpdate({ overallTarget: { ...tgt, ...patch } });

  // ── Trailing Options ──
  const tr = row.overallTrail ?? { enabled: false, kind: 'lock' as const, reach: '', lock: '', every: '', by: '' };
  const setTr = (patch: Partial<typeof tr>) => onUpdate({ overallTrail: { ...tr, ...patch } });
  const trUnit = tr.kind === 'trailSl' ? (slMode === 'mtm' ? '₹' : '% prem') : '₹';

  // ── Re-entry ──
  const reRow = (kind: 'sl' | 'tgt') => {
    const cur = (kind === 'sl' ? row.overallReSl : row.overallReTgt) ?? { enabled: false, mode: 'asap' as const, max: 1 };
    const set = (patch: Partial<typeof cur>) => onUpdate(kind === 'sl' ? { overallReSl: { ...cur, ...patch } } : { overallReTgt: { ...cur, ...patch } });
    const used = (kind === 'sl' ? row.overallReSlCount : row.overallReTgtCount) ?? 0;
    return (
      <div className="flex flex-wrap items-center gap-2">
        {sw(cur.enabled, c => set({ enabled: c }), `Re-entry on Overall ${kind === 'sl' ? 'SL' : 'Target'}`)}
        <MiniSelect value={cur.mode} ariaLabel={`Overall ${kind === 'sl' ? 'SL' : 'target'} re-entry type`} disabled={!cur.enabled}
          options={OVERALL_RE_OPTIONS} onChange={v => set({ mode: v as 'asap' | 'momentum' })} className="w-32"
          title="RE ASAP: reopen every leg at once at the current ATM. RE MOMENTUM: reopen through each leg's Simple Momentum (legs without it open at once)" />
        <MiniSelect value={String(Math.min(MAX_OVERALL_REENTRIES, Math.max(1, cur.max)))} ariaLabel="Overall re-entries" disabled={!cur.enabled}
          title={`Most re-entries (AlgoTest allows ${MAX_OVERALL_REENTRIES}). Used: ${used}`}
          options={Array.from({ length: MAX_OVERALL_REENTRIES }, (_, i) => ({ value: String(i + 1), label: `×${i + 1}` }))}
          onChange={v => set({ max: Number(v) })} className="w-14" />
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {sw(!!sl, c => (c ? onUpdate({ slMultiplier: '1.2', slRupees: '' }) : onUpdate({ slRupees: '', slMultiplier: '' })), 'Overall SL')}
        <MiniSelect value={slMode} ariaLabel="Overall SL type" disabled={!sl} options={OVERALL_MODE_OPTIONS}
          onChange={v => setSl(v as FocusOverallMode, slValue)} className="w-36" />
        <RuleNumInput value={slValue} onCommit={v => setSl(slMode, v)} placeholder="0" disabled={!sl} className={num} />
      </div>
      {sl && reRow('sl')}
      <div className="flex flex-wrap items-center gap-2">
        {sw(tgt.enabled, c => setTgt({ enabled: c }), 'Overall Target')}
        <MiniSelect value={tgt.mode} ariaLabel="Overall target type" disabled={!tgt.enabled} options={OVERALL_MODE_OPTIONS}
          onChange={v => setTgt({ mode: v as FocusOverallMode })} className="w-36" />
        <RuleNumInput value={tgt.value} onCommit={v => setTgt({ value: v })} placeholder="0" disabled={!tgt.enabled} className={num} />
      </div>
      {tgt.enabled && reRow('tgt')}
      <div className="flex flex-wrap items-center gap-2">
        {sw(tr.enabled, c => setTr({ enabled: c }), 'Trailing Options')}
        <MiniSelect value={tr.kind} ariaLabel="Trailing option" disabled={!tr.enabled} options={OVERALL_TRAIL_OPTIONS}
          onChange={v => setTr({ kind: v as typeof tr.kind })} className="w-40" />
        {tr.kind !== 'trailSl' && (<>
          <label className={lbl} title="When the overall profit reaches this …">If profit reaches {trUnit}
            <RuleNumInput value={tr.reach} onCommit={v => setTr({ reach: v })} placeholder="0" disabled={!tr.enabled} className={num} />
          </label>
          <label className={lbl} title="… lock this much profit: the row exits if profit falls back to it">Lock {trUnit}
            <RuleNumInput value={tr.lock} onCommit={v => setTr({ lock: v })} placeholder="0" disabled={!tr.enabled} className={num} />
          </label>
        </>)}
        {tr.kind !== 'lock' && (<>
          <label className={lbl} title={tr.kind === 'trailSl' ? 'For every this much overall profit …' : 'For every increase in profit by this much …'}>
            {tr.kind === 'trailSl' ? 'For every profit' : 'For every increase'} {trUnit}
            <RuleNumInput value={tr.every} onCommit={v => setTr({ every: v })} placeholder="0" disabled={!tr.enabled} className={num} />
          </label>
          <label className={lbl} title={tr.kind === 'trailSl' ? '… tighten the Overall SL by this much (needs an Overall SL, same unit as it)' : '… raise the locked profit by this much'}>
            {tr.kind === 'trailSl' ? 'Trail SL by' : 'Trail profit by'} {trUnit}
            <RuleNumInput value={tr.by} onCommit={v => setTr({ by: v })} placeholder="0" disabled={!tr.enabled} className={num} />
          </label>
        </>)}
        {tr.enabled && tr.kind === 'trailSl' && !sl && <span className="text-[11px] font-semibold text-rose-400">Overall Trail SL needs an Overall SL</span>}
      </div>
    </div>
  );
}

/** A recessed, titled group for the row's settings (see dhan-terminal-polish). */
function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-2">
      <h4 className="text-[10px] font-black uppercase tracking-wider text-zinc-500">{title}</h4>
      {children}
    </section>
  );
}

/**
 * Leg exits and what follows them — AlgoTest-style "Re-Entry on SL / Tgt"
 * (sell side only), No re-entry after, leg target (% or points), and SL → cost.
 *
 * Mode/max/direction are selects and toggles: each click is a complete
 * choice and commits at once. Target % and momentum points are free-typed,
 * so they go through RuleNumInput (commit on blur/Enter — a half-typed "5"
 * on the way to "50" must never reach the rule engine).
 */
function LegReentryControls({ row, onUpdate, onCancelPending, legTargetsElsewhere = false }: {
  row: FocusRow;
  onUpdate: (patch: Partial<FocusRow>) => void;
  onCancelPending: (leg: 'CE' | 'PE') => void;
  /** The CE/PE target inputs are rendered with each leg (table view) — don't repeat them here. */
  legTargetsElsewhere?: boolean;
}) {
  const sl = reentryConfig(row, 'sl');
  const tgt = reentryConfig(row, 'tgt');
  const txt = 'text-[11px]';
  const lbl = 'inline-flex items-center gap-1.5 font-bold text-zinc-400';
  const f = row.fill;
  const used = (t: 'sl' | 'tgt') => t === 'sl'
    ? `CE ${f?.ceRolls ?? 0} · PE ${f?.peRolls ?? 0}`
    : `CE ${f?.ceTgtReentries ?? 0} · PE ${f?.peTgtReentries ?? 0}`;
  const anyOtm = sl.mode === 'otm';
  const anyOn = sl.mode !== 'off' || tgt.mode !== 'off';
  const tgtUnitWord = legTgtUnitWords(row.legTgtUnit);

  const modeSelect = (t: 'sl' | 'tgt') => {
    const c = t === 'sl' ? sl : tgt;
    const modes: FocusReentryMode[] = t === 'sl'
      ? ['off', 'asap', 'otm', 'cost', 'momentum', 'lazy']
      : ['off', 'asap', 'cost', 'momentum', 'lazy'];
    return (
      <div className={lbl} title={`${t === 'sl' ? 'After a leg SL × (CE × / PE ×)' : 'After a leg target (CE Tgt / PE Tgt)'}: ${REENTRY_HELP[c.mode]}`}>
        {t === 'sl' ? 'RE on SL' : 'RE on Tgt'}
        <MiniSelect value={c.mode} ariaLabel={`Re-entry on ${t === 'sl' ? 'stop loss' : 'target'}`}
          options={modes.map(m => ({ value: m, label: REENTRY_LABEL[m] }))}
          onChange={v => {
            const mode = v as FocusReentryMode;
            const patch: Partial<FocusRow> = t === 'sl' ? { reSlMode: mode } : { reTgtMode: mode };
            // OTM needs a strike count; default to 1 when first chosen.
            if (mode === 'otm' && !(Number(row.slRollStrikes) > 0)) patch.slRollStrikes = 1;
            onUpdate(patch);
          }} className="w-24" />
        {c.mode !== 'off' && c.mode !== 'lazy' && (
          <MiniSelect value={String(c.max)} ariaLabel={`Maximum re-entries on ${t === 'sl' ? 'stop loss' : 'target'}`}
            title={`Most re-entries per leg until the row exits or is re-armed. Used: ${used(t)}`}
            options={REENTRY_MAX_OPTIONS.map(n => ({ value: String(n), label: `×${n}` }))}
            onChange={v => onUpdate(t === 'sl' ? { reSlMax: Number(v) } : { reTgtMax: Number(v) })}
            className="w-14" />
        )}
        {c.mode === 'lazy' && (
          <MiniSelect value={(t === 'sl' ? row.reSlLazyId : row.reTgtLazyId) ?? ''} ariaLabel={`Lazy leg on ${t === 'sl' ? 'stop loss' : 'target'}`}
            title="Which Lazy Leg opens when the leg's SL / target closes it"
            options={[{ value: '', label: 'Pick…' }, ...(row.lazyLegs ?? []).map((l, i) => ({ value: l.id, label: `Lazy ${i + 1}` }))]}
            onChange={v => onUpdate(t === 'sl' ? { reSlLazyId: v } : { reTgtLazyId: v })} className="w-20" />
        )}
      </div>
    );
  };

  return (
    <div className={cn('flex flex-col gap-2', txt)}>
     <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2 items-start">
      <SettingsCard title="Entry · Strike & sizing">
        <StrikeCriteriaControl row={row} onUpdate={onUpdate} />
      </SettingsCard>
      <SettingsCard title="Entry · Momentum & range gates">
        <EntryMomentumControl row={row} onUpdate={onUpdate} />
      </SettingsCard>
      <SettingsCard title="Leg exits & re-entry">
      <div className="flex flex-wrap items-center gap-2">
        {modeSelect('sl')}
        {modeSelect('tgt')}
      </div>
      <LegStopRulesControl row={row} onUpdate={onUpdate} />
      <div className="flex flex-wrap items-center gap-2">
        {!legTargetsElsewhere && (<>
        <label className={lbl} title={`CE leg target: exit CE alone once it has moved this many ${tgtUnitWord}. Blank = off`}>
          CE Tgt
          <RuleNumInput value={row.ceTgtPct ?? ''} onCommit={v => onUpdate({ ceTgtPct: v })} placeholder="off"
            className={cn('w-12 h-6 text-center', txt)} />
        </label>
        <label className={lbl} title={`PE leg target: exit PE alone once it has moved this many ${tgtUnitWord}. Blank = off`}>
          PE Tgt
          <RuleNumInput value={row.peTgtPct ?? ''} onCommit={v => onUpdate({ peTgtPct: v })} placeholder="off"
            className={cn('w-12 h-6 text-center', txt)} />
        </label>
        <MiniSelect value={row.legTgtUnit ?? 'pct'} ariaLabel="Leg target unit"
          title="Leg target type (both legs): % of the leg's own entry, premium points below it, or the index moving that far in the leg's favour from the spot at entry"
          options={LEG_TGT_UNIT_OPTIONS}
          onChange={v => onUpdate({ legTgtUnit: v as LegTgtUnit })} className="w-32" />
        </>)}
        {anyOtm && (
          <div className={lbl} title="RE-OTM: strikes further OTM than the strike that closed (CE up, PE down)">
            OTM
            <MiniSelect value={String(Math.max(1, Math.trunc(Number(row.slRollStrikes) || 1)))} ariaLabel="Strikes OTM for RE-OTM"
              options={[1, 2, 3].map(n => ({ value: String(n), label: String(n) }))}
              onChange={v => onUpdate({ slRollStrikes: Number(v) })} className="w-12" />
          </div>
        )}
      </div>
      </SettingsCard>
      <SettingsCard title="Lazy legs">
        <LazyLegsEditor row={row} onUpdate={onUpdate} />
      </SettingsCard>
      <SettingsCard title="Overall strategy (SL · target · trail)">
        <OverallSettingsControls row={row} onUpdate={onUpdate} />
      </SettingsCard>
      <SettingsCard title="Timing & square-off">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {anyOn && (
          <span className={lbl} title="A stop / target hit at or after this time takes no re-entry. A cost / momentum re-entry armed before it still fires after it (AlgoTest counts when the stop / target hit)">
            No RE after
            <TimeInput value={row.noReEntryAfter ?? ''} onChange={v => onUpdate({ noReEntryAfter: v })} className="w-16" />
            {row.noReEntryAfter && (
              <button type="button" onClick={() => onUpdate({ noReEntryAfter: '' })} aria-label="Clear no re-entry after time"
                className={cn('text-zinc-500 hover:text-zinc-300 cursor-pointer rounded', FOCUS_RING)}>&times;</button>
            )}
          </span>
        )}
        <span className={lbl} title="Stop Monitoring After: from this time no rule runs — no entry, re-entry, stop, target or trail. An open position is left to the exit time">
          Stop monitoring after
          <TimeInput value={row.stopMonitoringAfter ?? ''} onChange={v => onUpdate({ stopMonitoringAfter: v })} className="w-16" />
          {row.stopMonitoringAfter && (
            <button type="button" onClick={() => onUpdate({ stopMonitoringAfter: '' })} aria-label="Clear stop monitoring after time"
              className={cn('text-zinc-500 hover:text-zinc-300 cursor-pointer rounded', FOCUS_RING)}>&times;</button>
          )}
        </span>
        <div className={lbl} title="Square Off: Partial — a leg's SL / target closes only that leg. Complete — it closes every leg of the row">
          Square Off
          <MiniSelect value={row.squareOff ?? 'partial'} ariaLabel="Square off"
            options={[{ value: 'partial', label: 'Partial' }, { value: 'complete', label: 'Complete' }]}
            onChange={v => onUpdate({ squareOff: v as 'partial' | 'complete' })} className="w-24" />
        </div>
        <label className={cn(lbl, 'cursor-pointer text-zinc-300')}
          title="Trail SL to Break-even price: when one leg's own SL hits, move the other leg's stop to its entry premium (exit it if it returns to cost). An exit at cost never re-enters">
          <Switch size="sm" checked={!!row.slToCost} onCheckedChange={c => onUpdate({ slToCost: !!c })} aria-label="Trail SL to Break-even price" />
          Trail SL to Break-even price
        </label>
        {row.slToCost && (
          <MiniSelect value={row.slToCostScope ?? 'all'} ariaLabel="Trail SL to break-even scope"
            title="SL Legs: only legs that have a stop loss of their own. All Legs: every open leg, even one with no SL"
            options={[{ value: 'sl', label: 'SL Legs' }, { value: 'all', label: 'All Legs' }]}
            onChange={v => onUpdate({ slToCostScope: v as 'sl' | 'all' })} className="w-24" />
        )}
      </div>
      </SettingsCard>
     </div>
      <LegReentryPendingChips row={row} onCancelPending={onCancelPending} />
    </div>
  );
}

/** Waiting cost / momentum / range re-entries and Lazy Leg gates as cancellable chips. Null when none. */
function LegReentryPendingChips({ row, onCancelPending }: {
  row: FocusRow;
  onCancelPending: (leg: 'CE' | 'PE') => void;
}) {
  const f = row.fill;
  if (!f?.cePending && !f?.pePending) return null;
  const chip = (leg: 'CE' | 'PE') => {
    const p = leg === 'CE' ? f.cePending : f.pePending;
    if (!p) return null;
    // What it is (a re-entry, or a Lazy Leg's own gate) and what it watches.
    const lazyNo = p.lazyId ? (row.lazyLegs ?? []).findIndex(l => l.id === p.lazyId) + 1 : 0;
    const kind = lazyNo > 0 ? `Lazy ${lazyNo}` : `RE-${p.mode === 'cost' ? 'Cost' : p.mode === 'range' ? 'Range' : 'Mom'}`;
    const watched = p.src === 'combined' ? `combined premium (${leg} at ${p.strike})`
      : p.src === 'underlying' ? 'index spot' : `${p.strike} ${leg} premium`;
    const what = p.mode === 'range' && p.range
      ? `once the ${p.range.on === 'underlying' ? 'index' : `${p.strike} ${leg}`} reaches the ${p.range.side} of ${p.range.start}–${p.range.end}`
      : awaitingMomentumQuote(p) ? `once the ${watched} has a value to measure the move from`
      : `when the ${watched} ${p.dir === 'down' ? 'falls to' : 'rises to'} ${p.price.toFixed(2)}`;
    return (
      <span key={leg} className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-violet-300 bg-violet-500/10 border border-violet-500/30 rounded px-1.5 py-0.5"
        title={`Waiting since ${new Date(p.since).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} — sells ${p.lots} lot(s) ${p.strike} ${leg} ${what}`}>
        {leg} {kind} {p.strike} {p.mode === 'range' && p.range ? `range ${p.range.start}–${p.range.end} ${p.range.side}` : awaitingMomentumQuote(p) ? 'awaiting quote' : `${p.src === 'combined' ? 'comb ' : p.src === 'underlying' ? 'spot ' : ''}${p.dir === 'down' ? '≤' : '≥'} ${p.price.toFixed(2)}`}
        <button type="button" onClick={() => onCancelPending(leg)} aria-label={`Cancel ${leg} re-entry`}
          className={cn('text-zinc-400 hover:text-rose-400 cursor-pointer rounded', FOCUS_RING)}>&times;</button>
      </span>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chip('CE')}
      {chip('PE')}
    </div>
  );
}

/** Calculated SL × premiums under a CE/PE position cell. */
function LegSlLevels({
  row, live, leg, lotSize, align = 'center', inline = false,
}: {
  row: FocusRow;
  live: RowLive;
  leg: 'CE' | 'PE';
  lotSize: number | null;
  align?: 'center' | 'start';
  inline?: boolean;
}) {
  const legLevel = legStopPremium(row, leg, live);
  const pairLevel = pairStopPremium(row, live, undefined, lotSize);
  const costArmed = !!row.slToCost && !!(leg === 'CE' ? row.fill?.ceCostStop : row.fill?.peCostStop)
    && rowOwnsLeg(row, leg);
  const costLevel = costArmed ? legOwnEntry(row, leg, live) : 0;
  // Leg target level (display-only; legTargetReason is the authority).
  const lazyTgt = legTarget(row, leg);
  const tgtValue = Number(lazyTgt.value);
  const tgtEntry = legOwnContracts(row, leg, live) > 0 ? legOwnEntry(row, leg, live) : 0;
  const tgtLevel = legTargetLevel(tgtEntry, tgtValue, lazyTgt.unit) ?? 0;
  const tgtWhat = lazyTgt.unit === 'pts' ? `${tgtValue} pts` : `${tgtValue}%`;
  // Stops / targets on the index (Underlying Pts / %, an ORB stop on the index).
  const held = legOwnContracts(row, leg, live) > 0;
  const stop = held ? legStopLevel(row, leg, live, (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0) : null;
  const spotStop = stop?.on === 'spot' || stop?.on === 'delta' ? stop : null;
  const tgtDelta = held && lazyTgt.unit === 'delta'
    ? legTargetDeltaLevel(leg === 'CE' ? row.fill?.ceDeltaEntry : row.fill?.peDeltaEntry, lazyTgt.value)
    : null;
  const deltaNow = legDeltaNow(leg, live, legDeltaBasis(row.fill, leg));
  // The stop type asked for could not be built (no delta / spot recorded at
  // entry): the leg is on its SL × fallback — or, with SL × off, on NO stop.
  // Never silent: say which.
  const wantRule = leg === 'CE' ? row.ceSlRule : row.peSlRule;
  const orbWanted = !!(leg === 'CE' ? row.ceOrbSl : row.peOrbSl)?.enabled && !!(leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout)?.enabled;
  const wantedKind = orbWanted ? 'orb' : legSlRuleOn(wantRule) ? wantRule.basis : null;
  const stopFallback = held && !runningLazyLeg(row, leg) && wantedKind != null && stop?.kind !== wantedKind;
  const fallbackWhat = wantedKind === 'delta' ? 'Delta' : wantedKind === 'orb' ? 'ORB' : wantedKind === 'pts' ? 'Points' : 'Underlying';
  const tgtSpot = held
    ? legTargetSpotLevel(leg, leg === 'CE' ? row.fill?.ceSpotEntry : row.fill?.peSpotEntry, lazyTgt.value, lazyTgt.unit)
    : null;
  if (legLevel == null && pairLevel == null && !(costLevel > 0) && !(tgtLevel > 0) && !spotStop && tgtSpot == null && tgtDelta == null && !stopFallback) return null;
  const nowLeg = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? null;
  const nowPair = live.entryPremium > 0
    ? sidePremium(row, live, undefined, lotSize)
    : (() => {
        const legs = legsOf(row);
        if (!legs.length) return 0;
        const lots = Number(row.lots) || 0;
        if (!(lots > 0)) return 0;
        return lots * legs.reduce((s, l) => s + ((l === 'CE' ? live.ltpCe : live.ltpPe) ?? 0), 0);
      })();
  return (
    <div className={cn(
      inline ? 'inline-flex items-center gap-2 flex-wrap' : 'flex flex-col gap-0.5 leading-none',
      !inline && (align === 'start' ? 'items-start' : 'items-center'),
    )}>
      {legLevel != null && (
        <span
          className={cn('text-[11px] font-mono font-bold tabular-nums', slTone(nowLeg, legLevel, leg === 'CE' ? 'text-emerald-400' : 'text-rose-400'))}
          title={stop && stop.on === 'premium'
            ? `${leg} ${stop.label} fires when this leg's premium reaches ${legLevel.toFixed(2)} (entry ${stop.entry.toFixed(2)})`
            : `${leg} SL × fires when this leg's premium reaches ${legLevel.toFixed(2)} (entry × ${legSlMultiplier(row, leg)})`}
        >
          {leg} {stop && stop.kind !== 'mult' && stop.kind !== 'lazy' ? 'SL' : '×'} {legLevel.toFixed(2)}{stop?.trailed ? ' ↓' : ''}
        </span>
      )}
      {spotStop && (
        <span className="text-[11px] font-mono font-bold tabular-nums text-amber-300"
          title={spotStop.on === 'delta'
            ? `${leg} ${spotStop.label}: exits when its delta rises to ${spotStop.level.toFixed(2)} (now ${deltaNow?.toFixed(2) ?? '—'}, from the option chain)`
            : `${leg} ${spotStop.label}: exits when the index spot ${spotStop.dir === 'up' ? 'rises to' : 'falls to'} ${spotStop.level.toFixed(2)}`}>
          {leg} SL {spotStop.on === 'delta' ? 'Δ' : 'idx'} {spotStop.dir === 'up' ? '≥' : '≤'} {spotStop.level.toFixed(2)}
        </span>
      )}
      {stopFallback && (
        <span className={cn('text-[11px] font-bold', stop ? 'text-amber-400' : 'text-rose-400')}
          title={`${leg}'s ${fallbackWhat} stop cannot be measured (nothing recorded for it when the leg opened)${stop ? ` — its SL × ${legSlMultiplier(row, leg)} applies instead` : ' and its SL × is off: this leg has NO stop loss'}`}>
          {leg} {fallbackWhat} SL n/a → {stop ? 'SL ×' : 'NO STOP'}
        </span>
      )}
      {tgtDelta != null && (
        <span className="text-[11px] font-mono font-bold tabular-nums text-sky-300"
          title={`${leg} delta target: exits when its delta falls to ${tgtDelta.toFixed(2)} (now ${deltaNow?.toFixed(2) ?? '—'})`}>
          {leg} tgt Δ ≤ {tgtDelta.toFixed(2)}
        </span>
      )}
      {tgtSpot != null && (
        <span className="text-[11px] font-mono font-bold tabular-nums text-sky-300"
          title={`${leg} target on the index: exits when the spot ${leg === 'CE' ? 'falls to' : 'rises to'} ${tgtSpot.toFixed(2)}`}>
          {leg} tgt idx {leg === 'CE' ? '≤' : '≥'} {tgtSpot.toFixed(2)}
        </span>
      )}
      {costLevel > 0 && (
        <span
          className={cn('text-[11px] font-mono font-bold tabular-nums', slTone(nowLeg, costLevel, 'text-violet-300'))}
          title={`SL moved to cost: the other leg stopped out, so ${leg} exits if its premium returns to its entry ${costLevel.toFixed(2)}`}
        >
          {leg} cost {costLevel.toFixed(2)}
        </span>
      )}
      {tgtLevel > 0 && (
        <span
          className="text-[11px] font-mono font-bold tabular-nums text-sky-300"
          title={`${leg} target: exits when this leg's premium decays to ${tgtLevel.toFixed(2)} (entry ${tgtEntry.toFixed(2)} − ${tgtWhat})`}
        >
          {leg} tgt {tgtLevel.toFixed(2)}
        </span>
      )}
      {pairLevel != null && (
        <span
          className={cn('text-[11px] font-mono font-bold tabular-nums', slTone(nowPair, pairLevel, 'text-amber-500'))}
          title={`Pair SL × fires when combined lots×premium of this row's open legs reaches ${pairLevel.toFixed(2)} (combined entry × ${row.slMultiplier})`}
        >
          SL × {pairLevel.toFixed(2)}
        </span>
      )}
    </div>
  );
}

/** Entry/exit clock — commits on blur or Enter, same as RuleNumInput.
 *
 * The scheduler reads these times from React state every second. A per-keystroke
 * commit while typing "09:20" could briefly land on "09:00" / "09:02" and fire
 * an entry or exit a user was still editing.
 */
function TimeInput({
  value, onChange, title, className, disabled,
}: {
  disabled?: boolean;
  value: string;
  onChange: (v: string) => void;
  title?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next && next !== value) onChange(next);
  };

  return (
    <div className={cn('relative flex items-center', className)}>
      <input
        type="time"
        disabled={disabled}
        title={title}
        value={draft}
        onFocus={() => { focusedRef.current = true; }}
        onChange={e => setDraft(e.target.value)}
        onBlur={e => { focusedRef.current = false; commit(e.currentTarget.value); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); }
        }}
        className="h-6 text-[11px] font-mono font-bold px-1.5 border border-zinc-700/80 rounded bg-zinc-900 text-zinc-100 focus:outline-none focus:border-violet-500 w-full text-center [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-inner-spin-button]:hidden"
      />
    </div>
  );
}

function SegPill<T extends string>({
  options, value, onChange, title, className,
}: { options: readonly T[]; value: T; onChange: (v: T) => void; title?: string; className?: string }) {
  return (
    <div title={title} className={cn('inline-flex items-center gap-0.5 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg', className)}>
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            'text-[11px] font-bold px-2.5 py-0.5 rounded-md cursor-pointer transition-colors',
            value === o ? 'bg-violet-600 text-oncolor' : 'text-zinc-400 hover:text-zinc-200',
            FOCUS_RING,
          )}
        >{o}</button>
      ))}
    </div>
  );
}

/** One leg's strike selector: an ATM-offset dropdown or a target-premium
 *  input, with the currently resolved strike shown alongside. */
function StrikeLegSelector({
  leg, mode, offset, premium, resolvedStrike, step, ltp, buildup, oiChgPct,
  buildupWsActive, buildupExpiryHint, onOffsetChange, onPremiumChange, onShift, shiftDisabled, locked,
}: {
  leg: 'CE' | 'PE';
  mode: FocusStrikeMode;
  offset: number;
  premium: string;
  resolvedStrike: number | null;
  step: number;
  /** Live premium of `resolvedStrike` — shown next to the strike itself so a
   *  trader can see what price they'd be entering at without scanning over
   *  to the row's separate LTP column. */
  ltp?: number | null;
  /** 4-way OI-buildup label at this strike ('LB'|'SB'|'SC'|'LU'), same source
   *  and thresholds as AdvancedScalper — null/'' with buildupWsActive shows a
   *  muted placeholder so dead-band is not mistaken for a missing feature. */
  buildup?: string | null;
  /** OI change vs prev day (%), shown alongside the buildup chip. */
  oiChgPct?: number | null;
  /** Focus WS is live and this row's expiry matches the bridge — buildup
   *  (or a placeholder) should render for a resolved strike. */
  buildupWsActive?: boolean;
  /** When set, this row's expiry is off the Focus WS book — show a visible
   *  muted note instead of a blank (tooltip alone was too easy to miss). */
  buildupExpiryHint?: string | null;
  onOffsetChange: (n: number) => void;
  onPremiumChange: (v: string) => void;
  onShift?: (direction: 'UP' | 'DOWN') => void;
  shiftDisabled?: boolean;
  /** This leg holds an open position — its strike config is frozen so the
   *  position cannot be orphaned. See StrikeEditor's doc comment. */
  locked?: boolean;
}) {
  const buildupStyle = buildup ? BUILDUP_STYLES[buildup] : undefined;
  const lockedTitle = `${leg} holds an open position — use the chevrons to roll it, or exit the leg first`;
  const showBuildupSlot = resolvedStrike != null && (
    buildupStyle != null || !!buildupWsActive || !!buildupExpiryHint
  );
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className={cn('text-[11px] font-black w-5', leg === 'CE' ? 'text-emerald-400' : 'text-rose-400')}>{leg}</span>
        {mode === 'ATM' ? (
          <select
            value={offset}
            disabled={locked}
            title={locked ? lockedTitle : `${leg} strike as a step offset from ATM`}
            onChange={e => onOffsetChange(Number(e.target.value))}
            className="text-[11px] font-bold h-6 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500 w-28 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {OFFSET_OPTIONS.map(n => (
              <option key={n} value={n}>{offsetLabel(n, step)}</option>
            ))}
          </select>
        ) : (
          <RuleNumInput value={premium} onCommit={onPremiumChange} className="w-16 h-6" disabled={locked}
            placeholder="₹" title={locked ? lockedTitle : `Target premium for the ${leg} leg — resolves to the closest listed strike priced at or below this value`} />
        )}
        <span className="text-[11px] font-mono font-bold text-zinc-300 min-w-[42px] text-right">
          {resolvedStrike ?? '—'}
        </span>
        <span
          className="text-[11px] font-mono font-semibold text-zinc-500 min-w-[38px] text-right"
          title={`Live ${leg} premium at this strike — the reference entry price`}
        >
          {resolvedStrike != null && ltp != null && ltp > 0 ? `@${ltp.toFixed(2)}` : '—'}
        </span>
        {onShift && (
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => onShift('UP')}
              disabled={shiftDisabled || resolvedStrike == null}
              title={`Shift ${leg} strike up one step — closes and reopens any live position at the new strike`}
              aria-label={`Shift ${leg} strike up one step`}
              className={cn(
                'h-5 w-6 flex items-center justify-center rounded-t border border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
                'hover:bg-emerald-500 hover:text-oncolor hover:border-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed',
                'transition-all active:scale-95', FOCUS_RING,
              )}
            >
              <ChevronUp size={13} strokeWidth={3} />
            </button>
            <button
              type="button"
              onClick={() => onShift('DOWN')}
              disabled={shiftDisabled || resolvedStrike == null}
              title={`Shift ${leg} strike down one step — closes and reopens any live position at the new strike`}
              aria-label={`Shift ${leg} strike down one step`}
              className={cn(
                'h-5 w-6 flex items-center justify-center rounded-b border border-rose-500/20 bg-rose-500/10 text-rose-400',
                'hover:bg-rose-500 hover:text-oncolor hover:border-rose-500 disabled:opacity-30 disabled:cursor-not-allowed',
                'transition-all active:scale-95', FOCUS_RING,
              )}
            >
              <ChevronDown size={13} strokeWidth={3} />
            </button>
          </div>
        )}
      </div>
      {showBuildupSlot && (
        <div className="flex items-center gap-1 pl-6">
          {buildupStyle ? (
            <span
              className={cn('text-[10px] font-black px-1 py-0.5 rounded border leading-none', buildupStyle.cls)}
              title={`${buildupStyle.text}${oiChgPct != null && oiChgPct !== 0 ? ` — OI ${oiChgPct > 0 ? '+' : ''}${oiChgPct.toFixed(1)}%` : ''}`}
            >
              {buildup}
            </span>
          ) : buildupExpiryHint ? (
            <span
              className="text-[10px] font-bold text-zinc-500 leading-none px-1 py-0.5 rounded border border-zinc-700"
              title={buildupExpiryHint}
            >
              OI n/a
            </span>
          ) : (
            <span
              className="text-[10px] font-bold text-zinc-600 leading-none"
              title="OI buildup not classified yet (inside dead-band or waiting for prev-day baseline)"
            >
              —
            </span>
          )}
          {buildupStyle && oiChgPct != null && oiChgPct !== 0 && (
            <span
              className={cn(
                'text-[10px] font-mono font-semibold tabular-nums leading-none',
                oiChgPct > 0 ? 'text-emerald-500' : 'text-rose-500',
              )}
              title={`OI change vs previous day: ${oiChgPct > 0 ? '+' : ''}${oiChgPct.toFixed(1)}%`}
            >
              OI {oiChgPct > 0 ? '+' : ''}{oiChgPct.toFixed(1)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The strike-config edit rules every strike editor shares (table/cards
 * StrikeEditor and the Pro view's legs grid): owned-leg locks, the link
 * mirror, mode switch and reset. One copy, so a new layout can't quietly
 * drop the lock that keeps an open position from being orphaned.
 */
function useStrikeEditing(
  row: FocusRow, live: RowLive,
  onUpdate: (patch: Partial<FocusRow>) => void,
  onBlocked?: (message: string) => void,
) {
  /**
   * A leg THIS ROW opened is LOCKED against strike-config edits.
   *
   * This row finds broker positions by looking up whatever strike its config
   * currently resolves to (see rowLive's findPos). Move the config off a
   * position it opened and that position stops being found: its badge
   * vanishes, the row reports itself flat, Exit All disappears and Delete Row
   * unlocks — while the position is still very much open at the broker, now
   * with nothing on this page tracking it. So editing an owned leg's strike
   * is refused, and the shift chevrons — which close and reopen the position
   * at the new strike — are the sanctioned way to move it.
   *
   * A coincidental book at the same strike (another strategy, a leftover PE)
   * is not ownership. Locking that would freeze a brand-new ATM row onto
   * someone else's 24150 PE and refuse every offset change.
   */
  const legOpen = {
    CE: rowOwnsLeg(row, 'CE'),
    PE: rowOwnsLeg(row, 'PE'),
  };
  const anyOpen = legOpen.CE || legOpen.PE;
  const blockedNote = (leg: 'CE' | 'PE') =>
    `${leg} holds an open position at ${leg === 'CE' ? live.ceStrike : live.peStrike} — use the shift chevrons to roll it, or exit the leg first`;

  /**
   * Editing one leg mirrors onto the other leg when linked.
   *
   * Offsets mirror as the negation, not the same value: CE+7/PE+7 both land on
   * the strike 7 steps *above* ATM, which is a synthetic future, not a
   * strangle. A symmetric strangle is CE `n` steps above ATM and PE `n` steps
   * below it, so linked offset edits keep CE and PE opposite in sign.
   * Premium targets mirror as-is — a rupee target is not signed relative to
   * ATM, so the same value on both legs is the intended "same premium either
   * side" shape.
   */
  function setLeg(leg: 'CE' | 'PE', patch: Partial<FocusRow>) {
    if (legOpen[leg]) { onBlocked?.(blockedNote(leg)); return; }
    const merged = { ...patch };
    const other = leg === 'CE' ? 'PE' : 'CE';
    // The mirror is suppressed when the OTHER leg is open — mirroring would
    // move a leg that has a live position, orphaning it exactly as above.
    if ((row.linked ?? true) && !legOpen[other]) {
      if (leg === 'CE') {
        if (patch.ceOffset !== undefined) merged.peOffset = -patch.ceOffset;
        if ('cePremium' in patch) merged.pePremium = patch.cePremium;
      } else {
        if (patch.peOffset !== undefined) merged.ceOffset = -patch.peOffset;
        if ('pePremium' in patch) merged.cePremium = patch.pePremium;
      }
    } else if (row.linked ?? true) {
      onBlocked?.(`${other} is open, so it kept its strike — only ${leg} moved`);
    }
    onUpdate(merged);
  }

  const mode = row.strikeMode ?? 'ATM';

  /** Switching mode re-resolves BOTH legs from a different rule, so an open
   *  leg would move — same orphaning as a direct edit. */
  function setMode(next: FocusStrikeMode) {
    if (anyOpen) { onBlocked?.(blockedNote(legOpen.CE ? 'CE' : 'PE')); return; }
    onUpdate({ strikeMode: next });
  }

  function resetStrikes() {
    if (anyOpen) { onBlocked?.(blockedNote(legOpen.CE ? 'CE' : 'PE')); return; }
    onUpdate({
      strikeMode: 'ATM', linked: true, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '',
    });
  }

  return { legOpen, anyOpen, mode, setLeg, setMode, resetStrikes };
}

/** The full CE/PE strike editor for one row: ATM±/₹ mode toggle, independent
 *  CE and PE selectors, a link checkbox to keep them mirrored, and reset to ATM. */
function StrikeEditor({
  row, live, step, onUpdate, onShift, shiftDisabled, onBlocked,
  buildupWsActive, buildupExpiryHint,
}: {
  row: FocusRow;
  live: RowLive;
  step: number;
  onUpdate: (patch: Partial<FocusRow>) => void;
  onShift?: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  shiftDisabled?: boolean;
  onBlocked?: (message: string) => void;
  /** Focus WS running and this row's expiry matches — show buildup / placeholder. */
  buildupWsActive?: boolean;
  /** When set, title explains why buildup is unavailable (usually far expiry). */
  buildupExpiryHint?: string | null;
}) {
  const { legOpen, anyOpen, mode, setLeg, setMode, resetStrikes } = useStrikeEditing(row, live, onUpdate, onBlocked);

  return (
    <div
      className="flex flex-col gap-1 min-w-[280px] w-full max-w-full"
      title={buildupExpiryHint || undefined}
    >
      <div className="flex items-center justify-between">
        <SegPill options={['ATM±', '₹'] as const}
          value={mode === 'ATM' ? 'ATM±' : '₹'}
          onChange={v => setMode(v === 'ATM±' ? 'ATM' : 'PREMIUM')}
          title={anyOpen
            ? 'Locked while a leg is open — exit it first'
            : 'ATM± picks a strike by steps from ATM; ₹ picks the closest strike priced at or below a target premium'}
        />
        <div className="flex items-center gap-2">
          <label title="Keep CE and PE moving together" className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-400 hover:text-zinc-200 cursor-pointer select-none">
            <input type="checkbox" checked={row.linked ?? true}
              onChange={e => onUpdate({ linked: e.target.checked })}
              className="h-3 w-3 rounded-sm border-zinc-700 bg-zinc-900 accent-violet-500 cursor-pointer" />
            Link
          </label>
          <button
            type="button"
            onClick={resetStrikes}
            title={anyOpen ? 'Locked while a leg is open — exit it first' : "Reset this row's strike settings to ATM"}
            className={cn('text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer', FOCUS_RING)}
          >
            &times; reset
          </button>
        </div>
      </div>
      <StrikeLegSelector leg="CE" mode={mode} offset={row.ceOffset ?? 0} premium={row.cePremium ?? ''}
        resolvedStrike={live.ceStrike} step={step} ltp={live.ltpCe} locked={legOpen.CE}
        buildup={live.ceBuildup} oiChgPct={live.ceOiChgPct} buildupWsActive={buildupWsActive}
        buildupExpiryHint={buildupExpiryHint}
        onOffsetChange={n => setLeg('CE', { ceOffset: n })}
        onPremiumChange={v => setLeg('CE', { cePremium: v })}
        onShift={onShift ? dir => onShift('CE', dir) : undefined} shiftDisabled={shiftDisabled} />
      <StrikeLegSelector leg="PE" mode={mode} offset={row.peOffset ?? 0} premium={row.pePremium ?? ''}
        resolvedStrike={live.peStrike} step={step} ltp={live.ltpPe} locked={legOpen.PE}
        buildup={live.peBuildup} oiChgPct={live.peOiChgPct} buildupWsActive={buildupWsActive}
        buildupExpiryHint={buildupExpiryHint}
        onOffsetChange={n => setLeg('PE', { peOffset: n })}
        onPremiumChange={v => setLeg('PE', { pePremium: v })}
        onShift={onShift ? dir => onShift('PE', dir) : undefined} shiftDisabled={shiftDisabled} />
    </div>
  );
}

function GhostBtn({ onClick, children, title }: { onClick?: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn('flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 cursor-pointer transition-colors', FOCUS_RING)}
    >
      {children}
    </button>
  );
}

// â”€â”€ Sticky Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function FocusHeader({
  futQuotes, shown, realised, unrealised, total, marginAvailable, marginUtilized,
  wsLive, broker, setBroker, authenticatedBrokers,
}: {
  futQuotes: Record<FocusUnderlying, FutQuote | null>;
  /** Indices the futures strip lists (all three; one batched quote call regardless). */
  shown: readonly FocusUnderlying[];
  realised: number; unrealised: number; total: number;
  marginAvailable: number | null; marginUtilized: number | null;
  wsLive: boolean;
  broker: Broker;
  setBroker: (b: Broker) => void;
  authenticatedBrokers: Broker[];
}) {
  return (
    <div className="sticky top-0 z-40 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/25 shrink-0">
          <TrendingUp className="h-4 w-4 text-violet-400" />
        </div>
        <div>
          <p className="text-[11px] font-bold text-violet-400 uppercase tracking-[0.18em] mb-0.5">
            Options &middot; Straddles &amp; Strangles
          </p>
          <h1 className="text-sm font-bold text-white tracking-tight leading-none">Ultimate Scalper Terminal</h1>
          <p className="text-[10px] text-zinc-500 font-medium mt-0.5">
            Multi-index straddle / strangle scheduler with level exits
          </p>
        </div>
      </div>

      {/* Centre: Futures */}
      <div className="flex items-center gap-6">
        {shown.map(u => {
          const q = futQuotes[u];
          const chg = q?.change_pct;
          return (
            <div key={u} className="flex flex-col items-center"
              title={`${FUT_LABELS[u]} last price and % change since previous close`}>
              <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">{FUT_LABELS[u]}</span>
              <span className="text-sm font-mono font-black text-zinc-100 tabular-nums">
                {q ? q.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '\u2014'}
              </span>
              {chg != null && (
                <span className={cn('text-[11px] font-mono font-bold', chg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                  {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                </span>
              )}
            </div>
          );
        })}
        <LivePulse active={wsLive} />
      </div>

      {/* Right: Broker Selector + P&L tiles */}
      <div className="flex items-center gap-3">
        {authenticatedBrokers.length > 1 && (
          <select
            value={broker}
            title="Broker this terminal trades and reads positions from"
            onChange={e => setBroker(e.target.value as Broker)}
            className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-violet-500 w-[90px] shrink-0"
          >
            {authenticatedBrokers.map(b => (
              <option key={b} value={b}>{BROKER_LABELS[b]}</option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-1 bg-zinc-900/80 border border-zinc-800 rounded-xl px-3 py-2">
          {([
            { label: 'MARGIN AVAIL', value: marginAvailable, hint: 'Withdrawable/available balance for this broker' },
            { label: 'MARGIN USED', value: marginUtilized, hint: 'Margin blocked against open positions and pending orders' },
          ] as const).map(({ label, value, hint }, i) => (
            <React.Fragment key={label}>
              {i > 0 && <div className="h-6 w-px bg-zinc-800 mx-2" />}
              <div className="flex flex-col items-end min-w-[72px]" title={hint}>
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{label}</span>
                <span className="text-xs font-mono font-bold tabular-nums text-zinc-200">
                  {value != null ? fmtInr(value) : '—'}
                </span>
              </div>
            </React.Fragment>
          ))}
        </div>

        <div className="flex items-center gap-1 bg-zinc-900/80 border border-zinc-800 rounded-xl px-3 py-2">
          {([
            { label: 'REALISED', value: realised, hint: 'Booked P&L from legs already closed today' },
            { label: 'UNREALISED', value: unrealised, hint: 'Mark-to-market P&L on legs still open' },
            { label: 'TOTAL', value: total, hint: 'Realised + unrealised for the session' },
          ] as const).map(({ label, value, hint }, i) => (
            <React.Fragment key={label}>
              {i > 0 && <div className="h-6 w-px bg-zinc-800 mx-2" />}
              <div className="flex flex-col items-end min-w-[72px]" title={hint}>
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{label}</span>
                <span className={cn('text-xs font-mono font-bold tabular-nums', pnlClass(value))}>
                  {fmtInr(value, true)}
                </span>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// â”€â”€ Control Strip (Positions + Risk merged) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Turns Target / Stop / Peak / Lock — four numbers with no visual relation
 * today — into one bar: rose from -Stop to 0, emerald from 0 to +Target, a
 * marker at the current total, and (once the trail has woken up) a thin
 * amber tick at the lock floor. The exact numbers stay as text next to it —
 * on a real-money page the figure matters more than the bar, so the bar is
 * supplementary, never a replacement.
 */
function RiskRail({ totalPnl, target, stop, lockFloor, peakMtm }: {
  totalPnl: number; target: number | null; stop: number | null;
  lockFloor: number | null; peakMtm: number;
}) {
  const hasTarget = target != null && target > 0;
  const hasStop = stop != null && stop > 0;

  let bar: React.ReactNode = (
    <div className="h-1.5 w-32 rounded-full bg-zinc-800" title="Set a Target or Stop to see it plotted here" />
  );
  if (hasTarget || hasStop) {
    const lo = hasStop ? -(stop as number) : Math.min(totalPnl, 0) * 1.2 || -1;
    const hi = hasTarget ? (target as number) : Math.max(totalPnl, 0) * 1.2 || 1;
    if (hi > lo) {
      const pct = (v: number) => ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100;
      const zero = pct(0);
      bar = (
        <div
          className="relative h-1.5 w-32 rounded-full bg-zinc-800 overflow-hidden"
          title={`Stop ${hasStop ? fmtInr(-(stop as number)) : '—'} · Target ${hasTarget ? fmtInr(target as number) : '—'} · Total ${fmtInr(totalPnl, true)}`}
        >
          <div className="absolute inset-y-0 bg-rose-500/25" style={{ left: 0, width: `${zero}%` }} />
          <div className="absolute inset-y-0 bg-emerald-500/25" style={{ left: `${zero}%`, width: `${100 - zero}%` }} />
          <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: `${zero}%` }} />
          {lockFloor != null && (
            <div className="absolute inset-y-0 w-px bg-amber-400" style={{ left: `${pct(lockFloor)}%` }} />
          )}
          <div
            className={cn('absolute -top-0.5 h-2.5 w-0.5 rounded-full', totalPnl >= 0 ? 'bg-emerald-400' : 'bg-rose-400')}
            style={{ left: `${pct(totalPnl)}%` }}
          />
        </div>
      );
    }
  }

  return (
    <div className="flex items-center gap-2">
      {bar}
      <span className={cn(TXT_VALUE, 'font-mono text-zinc-500 whitespace-nowrap')}
        title="Peak: best total P&L so far today. Lock: the floor the trail is currently holding.">
        Peak <strong className="text-zinc-300">{fmtInr(peakMtm, true)}</strong>
        <span className="mx-1.5 text-zinc-700">&middot;</span>
        Lock <strong className="text-zinc-300">{lockFloor != null ? fmtInr(lockFloor, true) : '—'}</strong>
      </span>
    </div>
  );
}

type TrailX = { kind: 'peakGap' | 'lock' | 'lockTrail' | 'trailSl'; every: string; by: string };
const ACCOUNT_TRAIL_OPTIONS = [
  { value: 'peakGap', label: 'Peak − gap' },
  { value: 'lock', label: 'Lock' },
  { value: 'lockTrail', label: 'Lock and Trail' },
  { value: 'trailSl', label: 'Trail SL' },
];

function ControlStrip({
  liveRealMoney, onToggleLive, broker,
  riskEnabled, onToggleRisk,
  targetRupees, setTargetRupees,
  stopRupees, setStopRupees,
  trailEnabled, onToggleTrail,
  triggerRupees, setTriggerRupees,
  lockRupees, setLockRupees, trailX, setTrailX,
  totalPnl, peakMtm, lockMtm, simPnl, simRows,
  copyTrade,
  onOpenRisk, onOpenOrders, onOpenOptionChain, onOpenGreeks, onSetViewMode, viewMode,
  onExitAll, confirmExitAll, exitingAll,
}: {
  liveRealMoney: boolean; onToggleLive: () => void; broker: Broker;
  riskEnabled: boolean; onToggleRisk: () => void;
  targetRupees: string; setTargetRupees: (v: string) => void;
  stopRupees: string; setStopRupees: (v: string) => void;
  trailEnabled: boolean; onToggleTrail: () => void;
  triggerRupees: string; setTriggerRupees: (v: string) => void;
  lockRupees: string; setLockRupees: (v: string) => void;
  trailX: TrailX; setTrailX: (patch: Partial<TrailX>) => void;
  totalPnl: number; peakMtm: number; lockMtm: number | null;
  /** Paper P&L across SIM rows, and how many SIM rows exist. */
  simPnl: number; simRows: number;
  copyTrade: CopyTradeApi;
  onOpenRisk: () => void;
  onOpenOrders: () => void;
  onOpenOptionChain: () => void;
  onOpenGreeks: () => void;
  onSetViewMode: (mode: FocusViewMode) => void;
  viewMode: FocusViewMode;
  onExitAll: () => void;
  confirmExitAll: boolean;
  exitingAll: boolean;
}) {
  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-2.5 flex items-center gap-3 flex-nowrap overflow-x-auto">
      {/* Positions section */}
      <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5">
        <span className={cn(TXT_LABEL, 'font-black text-zinc-600 uppercase tracking-widest whitespace-nowrap')}>Positions</span>
        <button
          onClick={onToggleLive}
          title={liveRealMoney
            ? 'Live: rows set to REAL place real orders. Click to disarm them — SIM rows keep paper trading.'
            : 'REAL rows are idle: no broker orders are sent. Click to arm them for today. SIM rows paper trade either way.'}
          className={cn(
            'flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full text-oncolor transition-colors cursor-pointer',
            liveRealMoney ? 'bg-rose-600 hover:bg-rose-500' : 'bg-zinc-700 hover:bg-zinc-600',
            FOCUS_RING,
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-oncolor animate-pulse" />
          LIVE &middot; REAL MONEY
        </button>
        <span
          title={liveRealMoney
            ? 'In-tab engine active for REAL and SIM rows — scheduled entries, level exits, stop losses'
            : 'In-tab engine active for SIM rows only — REAL rows wait for LIVE · REAL MONEY'}
          className={cn(
            'flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border transition-colors select-none',
            liveRealMoney
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-zinc-700 bg-zinc-900 text-zinc-400',
          )}
        >
          <Activity className={cn('h-3.5 w-3.5', liveRealMoney && 'animate-pulse text-emerald-400')} />
          {liveRealMoney ? 'Real + Sim Rules' : 'Sim Rules Only'}
        </span>
        {simRows > 0 && (
          <span
            title="Paper P&L across SIM rows (open legs marked at LTP + closed legs booked). Kept out of the real-money budget; every paper fill is logged to debug/focus_tool_sim_trades.jsonl."
            className="flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 whitespace-nowrap"
          >
            SIM <span className={cn('font-mono tabular-nums', pnlClass(simPnl))}>{fmtInr(simPnl, true)}</span>
          </span>
        )}
        <button
          onClick={onExitAll}
          disabled={exitingAll}
          title="Immediately liquidate ALL open F&O positions at broker level for the active broker — not scoped to this terminal's own rows. On Dhan this also stops every running strategy process account-wide."
          className={cn(
            'flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border cursor-pointer transition-colors disabled:opacity-50',
            confirmExitAll
              ? 'border-rose-500 bg-rose-600 text-oncolor animate-pulse shadow-lg shadow-rose-500/20'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20',
            FOCUS_RING,
          )}
        >
          {exitingAll ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
          {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
        </button>
        <GhostBtn onClick={onOpenRisk} title="Account-level P&L, target, stop and trail state">
          <Shield className="h-3.5 w-3.5 text-violet-400" />
          Risk / MTM
        </GhostBtn>
        <GhostBtn onClick={onOpenGreeks} title="Net Delta / Gamma / Theta / Vega of every open leg across the rows, from each leg's live price">
          <Sigma className="h-3.5 w-3.5 text-violet-400" />
          Greeks
        </GhostBtn>
        <GhostBtn onClick={onOpenOrders} title="Today's broker order book and tradebook for this account">
          <Activity className="h-3.5 w-3.5 text-zinc-400" />
          Orders
        </GhostBtn>
        <GhostBtn onClick={onOpenOptionChain} title="Live NIFTY option chain — price/OI/volume by strike, with Buy/Sell">
          <Grid3x3 className="h-3.5 w-3.5 text-cyan-400" />
          Option Chain
        </GhostBtn>
        <div className="flex items-center bg-zinc-900 border border-zinc-700/80 rounded-lg p-0.5" title="Switch view: Pro, Table or Cards">
          {([
            ['pro', LayoutList, 'Pro'],
            ['table', Grid3x3, 'Table'],
            ['cards', Layers, 'Cards'],
          ] as const).map(([mode, Icon, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => onSetViewMode(mode)}
              aria-pressed={viewMode === mode}
              className={cn(
                'flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-md transition-all cursor-pointer',
                viewMode === mode ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200',
                FOCUS_RING,
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Risk section */}
      <div className="flex items-center gap-3 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5">
        <span className={cn(TXT_LABEL, 'font-black text-zinc-600 uppercase tracking-widest whitespace-nowrap')}>Risk</span>
        <SwitchToggle checked={riskEnabled} onChange={onToggleRisk}
          title="Enable the account-wide target and stop below" />

        <div className="flex items-center gap-1.5">
          <Target className="h-3 w-3 text-emerald-500" />
          <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>Target</span>
          <RuleNumInput value={targetRupees} onCommit={setTargetRupees} className="w-16" placeholder="0"
            title="Close every open row once total P&L reaches this profit (₹). Applies when you leave the field, not while typing." />
        </div>

        <div className="flex items-center gap-1.5">
          <ShieldOff className="h-3 w-3 text-rose-500" />
          <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>Stop</span>
          <RuleNumInput value={stopRupees} onCommit={setStopRupees} className="w-16" placeholder="0"
            title="Close every open row once total P&L falls to this loss (₹). Applies when you leave the field, not while typing." />
        </div>

        <div className="h-4 w-px bg-zinc-800" />

        <SwitchToggle checked={trailEnabled} onChange={onToggleTrail} label="Trail"
          title="Account-wide trailing (AlgoTest broker-level): Peak − gap, Lock, Lock and Trail, or Trail SL" />
        <MiniSelect value={trailX.kind} ariaLabel="Account trailing kind" options={ACCOUNT_TRAIL_OPTIONS}
          title="Peak − gap: a floor that follows the peak by LOCK once P&L reaches TRIGGER. Lock: reach → lock. Lock and Trail: as Lock, then +by per every. Trail SL: for every 'every' of profit, tighten STOP by 'by'"
          onChange={v => setTrailX({ kind: v as TrailX['kind'] })} className="w-32" />

        {trailX.kind !== 'trailSl' && (<>
        <div className="flex items-center gap-1.5">
          <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>{trailX.kind === 'peakGap' ? 'Trigger' : 'Reach'}</span>
          <RuleNumInput value={triggerRupees} onCommit={setTriggerRupees} className="w-16" placeholder="0"
            title={trailX.kind === 'peakGap' ? 'Profit (₹) at which the trail wakes up and starts locking' : 'When total profit first reaches this (₹) …'} />
        </div>

        <div className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-amber-500" />
          <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>{trailX.kind === 'peakGap' ? 'Gap' : 'Lock'}</span>
          <RuleNumInput value={lockRupees} onCommit={setLockRupees} className="w-16" placeholder="0"
            title={trailX.kind === 'peakGap' ? 'Profit (₹) kept back from each new peak — the floor that never falls' : '… lock this profit (₹): exit everything if total P&L falls back to it'} />
        </div>
        </>)}
        {(trailX.kind === 'lockTrail' || trailX.kind === 'trailSl') && (<>
          <div className="flex items-center gap-1.5">
            <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>Every</span>
            <RuleNumInput value={trailX.every} onCommit={v => setTrailX({ every: v })} className="w-16" placeholder="0"
              title={trailX.kind === 'trailSl' ? 'For every this much profit (₹) …' : 'For every this much more profit (₹) …'} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>By</span>
            <RuleNumInput value={trailX.by} onCommit={v => setTrailX({ by: v })} className="w-16" placeholder="0"
              title={trailX.kind === 'trailSl' ? '… tighten STOP by this much (₹)' : '… raise the locked profit by this much (₹)'} />
          </div>
        </>)}

        <RiskRail totalPnl={totalPnl} target={Number(targetRupees) || null} stop={Number(stopRupees) || null}
          lockFloor={lockMtm} peakMtm={peakMtm} />
      </div>

      {/* Copy Trade Controls — wrapped so its fragment's items (label, per-
          broker checkboxes, the ARM button) form one flex group that can't be
          split across a wrap point; the strip itself no longer wraps at all
          (flex-nowrap + overflow-x-auto above), but this keeps the group
          intact if that ever changes. The leading divider CopyTradeControls
          renders as its own first child is redundant now that this cluster is
          its own card below — hidden rather than removed, since the
          component is shared with AdvancedScalper/Scalper/Baskets. */}
      <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5 [&>span:first-child]:hidden">
        <CopyTradeControls copyTrade={copyTrade} />
      </div>
    </div>
  );
}

// â”€â”€ Index Group Bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function IndexGroupBar({
  group, onChange, spot, liveAtm, lot, dte, wsLive,
}: {
  group: FocusIndexGroup;
  onChange: (patch: Partial<FocusIndexGroup>) => void;
  spot: number; liveAtm: number; lot: number | null; dte: number | null; wsLive: boolean;
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Symbol */}
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', UNDERLYING_DOT[group.underlying])} />
          <span className={cn('text-base font-black', UNDERLYING_TXT[group.underlying])}>{group.underlying}</span>
        </div>

        {/* Start/Stop */}
        <button
          onClick={() => onChange({ enabled: !group.enabled })}
          title={group.enabled
            ? `Stop watching ${group.underlying} - armed rows stop entering`
            : `Start watching ${group.underlying} so armed rows can enter`}
          className={cn(
            'flex items-center gap-1 text-xs font-black px-3 py-1 rounded-lg text-oncolor transition-colors cursor-pointer',
            group.enabled ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500',
            FOCUS_RING,
          )}
        >
          <Zap className="h-3 w-3" />
          {group.enabled ? 'Stop' : 'Start'}
        </button>

        {group.enabled && (
          <span className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Running
          </span>
        )}

        <div className="h-4 w-px bg-zinc-800" />

        {/* ATM BY */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">ATM BY</span>
          <SegPill options={['Spot', 'Fut'] as const} value={group.atmBy} onChange={v => onChange({ atmBy: v })}
            title="Pick the ATM strike off the index spot or off the future" />
        </div>

        {/* PRODUCT */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">PRODUCT</span>
          <select
            value={group.product}
            title="MIS is intraday and auto-squares off; NRML carries overnight"
            onChange={e => onChange({ product: e.target.value as 'INTRADAY' | 'MARGIN' })}
            className="text-xs font-bold h-7 px-2 border border-zinc-700 rounded-lg bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500"
          >
            <option value="INTRADAY">MIS</option>
            <option value="MARGIN">NRML</option>
          </select>
        </div>

        {/* STRIKES Â± */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">STRIKES &plusmn;</span>
          <select
            value={group.strikesOffset}
            title="Strikes away from ATM: 0 is a straddle, plus/minus n a strangle n steps wide"
            onChange={e => onChange({ strikesOffset: Number(e.target.value) })}
            className="text-xs font-bold h-7 px-2 border border-zinc-700 rounded-lg bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500"
          >
            {[-2, -1, 0, 1, 2].map(o => (
              <option key={o} value={o}>{o > 0 ? `+${o}` : o}</option>
            ))}
          </select>
        </div>

        {/* BOOK EXIT */}
        <SwitchToggle checked={group.bookExit} onChange={v => onChange({ bookExit: v })} label="Book Exit"
          title="Close every row in this index when spot hits the levels below" />

        {group.bookExit && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-black text-rose-400 uppercase">Spot H&uarr;</span>
              <RuleNumInput value={group.spotHigh} onCommit={v => onChange({ spotHigh: v })} className="w-16"
                title="Book out when spot trades at or above this level. Applies when you leave the field, not while typing." />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-black text-emerald-400 uppercase">Spot L&darr;</span>
              <RuleNumInput value={group.spotLow} onCommit={v => onChange({ spotLow: v })} className="w-16"
                title="Book out when spot trades at or below this level. Applies when you leave the field, not while typing." />
            </div>
          </div>
        )}
      </div>

      {/* Right stats */}
      <div className="flex items-center gap-6">
        {([
          { label: 'SPOT', hint: 'Current index level', val: spot > 0 ? spot.toFixed(2) : '\u2014' },
          { label: 'ATM', hint: `Nearest strike to ${group.atmBy === 'Fut' ? 'the futures LTP' : 'spot'} right now, per ATM BY`, val: liveAtm > 0 ? liveAtm : '\u2014' },
          { label: 'LOT', hint: 'Contracts in one lot of this index', val: lot ?? '\u2014' },
          { label: 'DTE', hint: 'Days to the nearest expiry', val: dte ?? '\u2014' },
        ] as const).map(({ label, val, hint }) => (
          <div key={label} className="flex flex-col items-center" title={hint}>
            <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
            <span className="text-lg font-mono font-black text-zinc-100 tabular-nums leading-tight">{val}</span>
          </div>
        ))}
        {wsLive && (
          <span className="text-[11px] font-black px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/25 uppercase tracking-wider">
            LIVE
          </span>
        )}
      </div>
    </div>
  );
}

// ── Table Row ─────────────────────────────────────────────────────────────────

/**
 * The status to SHOW (and to offer Arm on). A row still saved as 'entered'
 * whose own ledger holds nothing was closed by a path that doesn't retire the
 * row — a single-leg Exit, − lots, or a leg the broker already shows flat —
 * and without this it sat at 'entered' with no Arm button, re-armable only
 * by editing the JSON. Display-only: the scheduler never enters an 'entered'
 * row, and Arm itself resets it through armRow as usual.
 */
/** The strike a Range Breakout leg picked at the entry time, kept across a reload (per row-leg and day). */
// One record per range START day: a BTST leg picks tomorrow's range strike
// today while today's range (picked yesterday) is still waiting to break.
function loadRangeStrike(key: string, day: string): number | null {
  try {
    for (const k of [`focus-range-strike:${key}:${day}`, `focus-range-strike:${key}`]) {
      const v = JSON.parse(localStorage.getItem(k) ?? 'null') as { day?: string; strike?: number } | null;
      if (v && v.day === day && Number(v.strike) > 0) return Number(v.strike);
    }
    return null;
  } catch { return null; }
}
function saveRangeStrike(key: string, day: string, strike: number) {
  try {
    localStorage.setItem(`focus-range-strike:${key}:${day}`, JSON.stringify({ day, strike }));
    // Drop records older than a week so the store doesn't grow forever.
    const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      const m = k?.match(/^focus-range-strike:.+:(\d{4}-\d{2}-\d{2})$/);
      if (k && m && m[1] < cutoff) localStorage.removeItem(k);
    }
  } catch { /* private mode */ }
}

function lazyLotsOf(l: Pick<FocusLazyLeg, 'lots'>): number {
  return Math.max(0, Math.trunc(Number(l.lots)) || 0);
}

function shownStatus(row: FocusRow, flat: boolean): FocusRowStatus {
  // A flat row still waiting on a cost / momentum re-entry is live, not done.
  const waiting = !!(row.fill?.cePending || row.fill?.pePending);
  return row.status === 'entered' && flat && !waiting ? 'exited' : row.status;
}

const STATUS_PILL: Record<FocusRowStatus, string> = {
  draft:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  armed:   'bg-violet-500/15 text-violet-300 border-violet-500/30',
  entered: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  exited:  'bg-zinc-700/50 text-zinc-500 border-zinc-600',
};

/**
 * Shared row-props comparator for FocusTableRow/FocusRowCard's React.memo.
 *
 * Deliberately ignores the on* callback props: they are recreated as fresh
 * closures on every parent render (they close over `row`), which would
 * defeat memoization if compared, but they're otherwise harmless to
 * recreate — each one only ever reads `row`/`row.id`. `live` is the object
 * rowLive's own value-diffing keeps referentially stable across ticks that
 * don't change this row's numbers (see the rowLive useMemo) — that's what
 * actually makes this comparator useful rather than a no-op.
 */
function rowDataPropsEqual(
  prev: { row: FocusRow; live: RowLive; lotSize: number | null; spot: number;
    liveRealMoney: boolean; broker: Broker; busy: boolean;
    rowIndex?: number;
    expiries?: string[];
    buildupWsActive?: boolean; buildupExpiryHint?: string | null },
  next: typeof prev,
): boolean {
  return prev.row === next.row && prev.live === next.live
    && prev.lotSize === next.lotSize && prev.spot === next.spot
    && prev.liveRealMoney === next.liveRealMoney && prev.broker === next.broker
    && prev.busy === next.busy && prev.rowIndex === next.rowIndex
    && prev.expiries === next.expiries
    && prev.buildupWsActive === next.buildupWsActive
    && prev.buildupExpiryHint === next.buildupExpiryHint;
}

function FocusTableRowImpl({
  row, rowIndex, live, lotSize, spot, liveRealMoney, broker, busy,
  expiries, buildupWsActive, buildupExpiryHint,
  onUpdate, onDelete, onArm, onDisarm, onExit, onExitPartial, onAddLot, onReduceLot, onShift, onBlocked,
  onCancelPending,
}: {
  row: FocusRow;
  rowIndex: number;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  /** This row's underlying's available expiries, nearest first. */
  expiries: string[];
  buildupWsActive?: boolean;
  buildupExpiryHint?: string | null;
  onUpdate: (patch: Partial<FocusRow>) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onExitPartial: (leg: 'CE' | 'PE', pct: 25 | 50 | 75) => void;
  onAddLot: (leg: 'CE' | 'PE', lots: number) => void;
  /** Add N lots to every open leg of the row in one action (pro view). */
  onAddAllLegs?: (lots: number) => void;
  /** Limit ladder (pro view): place a SELL limit at +pct% of the leg's price, or cancel one. */
  onLadderPlace?: (leg: 'CE' | 'PE', pct: number, lots: number) => void;
  onLadderCancel?: (leg: 'CE' | 'PE', orderId: string) => void;
  onReduceLot: (leg: 'CE' | 'PE', lots: number) => void;
  onCancelPending: (leg: 'CE' | 'PE') => void;
  onShift: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  onBlocked: (message: string) => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const { ceValue, peValue, totalValue, pcr, pcrOi } = legValues(row, live, lotSize);
  // Orders are only sendable once at least one leg's contract and the lot size
  // are known — placeLeg re-checks the specific leg it is about to trade.
  const canTrade = (isSimRow(row) || liveRealMoney) && !busy && (live.ceStrike != null || live.peStrike != null) && (lotSize ?? 0) > 0;
  // Ownership, not raw broker qty: checked against this row's own fill ledger.
  const flat = rowFlat(row);
  const ceFlat = !rowOwnsLeg(row, 'CE');
  const peFlat = !rowOwnsLeg(row, 'PE');
  // Quick partial-exit chips, same lot-aware rounding as Scalper/AdvancedScalper.
  // Sized off THIS row's own contracts, not the broker net: a closed leg
  // re-resolves to the live strike, where the book may hold another row's
  // (or a manual) position — chips must not offer to close that.
  const ceChips = partialCloseChips(legOwnContracts(row, 'CE', live), lotSize ?? 0, [25, 50, 75]);
  const peChips = partialCloseChips(legOwnContracts(row, 'PE', live), lotSize ?? 0, [25, 50, 75]);
  // Why the leg buttons are greyed out.
  const tradeBlockedWhy = !isSimRow(row) && !liveRealMoney
    ? 'REAL row — turn on LIVE · REAL MONEY to place orders, or switch the row to SIM'
    : busy
      ? 'An order for this row is already in flight'
      : (lotSize ?? 0) <= 0
        ? 'Lot size for this index has not resolved yet'
        : 'Strike not resolved yet';
  const step = STRIKE_STEP[row.underlying];
  // How many lots the +/- buttons act on, independently per leg
  const [ceQty, setCeQty] = useState(1);
  const [peQty, setPeQty] = useState(1);
  const cePnl = computeLegPnl(row, 'CE', live);
  const pePnl = computeLegPnl(row, 'PE', live);
  // Expiry is locked once this row owns an active leg.
  const expiryLocked = rowOwnsLeg(row, 'CE') || rowOwnsLeg(row, 'PE');
  // DTE (0/1/0+1) only means something relative to the NEAREST expiry — a row
  // that picked a further-out expiry has its own fixed DTE that never changes
  // day to day, so the filter is disabled rather than silently inert.
  const onNearestExpiry = !row.expiry || row.expiry === expiries[0];

  /**
   * One leg's pod: live premium, position and P&L with its order buttons on
   * top; its OWN rules (leg SL ×, target) and their levels underneath, next
   * to the partial-exit chips. Leg rules sit with the leg they act on.
   */
  const legPod = (leg: 'CE' | 'PE') => {
    const isCe = leg === 'CE';
    const ltp = isCe ? live.ltpCe : live.ltpPe;
    const pos = isCe ? live.cePosition : live.pePosition;
    const legFlat = isCe ? ceFlat : peFlat;
    const pnl = isCe ? cePnl : pePnl;
    const qty = isCe ? ceQty : peQty;
    const setQty = isCe ? setCeQty : setPeQty;
    const chips = isCe ? ceChips : peChips;
    const tone = isCe ? 'text-emerald-400' : 'text-rose-400';
    const btn = 'h-7 w-7 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 font-bold flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer text-sm';
    return (
      <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-2.5 py-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn('text-[11px] font-black px-1.5 py-0.5 rounded border',
              isCe ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/15 text-rose-400 border-rose-500/30')}>{leg}</span>
            <span className={cn('text-base font-mono font-black tabular-nums', tone)}>
              {ltp != null ? `₹${ltp.toFixed(2)}` : '—'}
            </span>
            {rowOwnsLeg(row, leg) && pos && Number(pos.netQty) !== 0 ? (
              <LegOpenBadge pos={pos} />
            ) : (
              <span className="text-[11px] font-mono font-bold text-zinc-500 uppercase tracking-widest px-1">Flat</span>
            )}
            {pnl != null && (
              <span className={cn(
                'text-xs font-mono font-black px-1.5 py-0.5 rounded border tabular-nums',
                pnl > 0 ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 shadow-sm'
                  : pnl < 0 ? 'bg-rose-500/15 text-rose-400 border-rose-500/40 shadow-sm'
                  : 'bg-zinc-800 text-zinc-400 border-zinc-700'
              )} title={`${leg} leg mark-to-market P&L`}>
                {pnl > 0 ? '+' : ''}₹{pnl.toFixed(0)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <LegLotSelect value={qty} onChange={setQty} className="w-10 h-7 text-xs" title={`Lots the ${leg} +/- buttons act on`} />
            <button onClick={() => onAddLot(leg, qty)} disabled={!canTrade} title={canTrade ? `Add ${qty} lot(s) to ${leg}` : tradeBlockedWhy} aria-label={`Add ${qty} ${leg} lots`}
              className={cn(btn, isCe ? 'hover:bg-emerald-600 hover:border-emerald-600 hover:text-oncolor' : 'hover:bg-rose-600 hover:border-rose-600 hover:text-oncolor', FOCUS_RING)}>+</button>
            <button onClick={() => onReduceLot(leg, qty)} disabled={!canTrade || legFlat} title={legFlat ? 'Nothing open' : canTrade ? `Reduce ${leg} by ${qty} lot(s)` : tradeBlockedWhy} aria-label={`Reduce ${leg} by ${qty} lots`}
              className={cn(btn, 'hover:bg-zinc-700', FOCUS_RING)}>-</button>
            <button onClick={() => onExit(leg)} disabled={!canTrade || legFlat} title={legFlat ? 'Nothing open' : canTrade ? `Exit ${leg} leg` : tradeBlockedWhy}
              className={cn('text-xs font-black uppercase tracking-wider px-2.5 h-7 rounded bg-rose-600 text-oncolor hover:bg-rose-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>Exit</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 flex-wrap pt-1.5 border-t border-zinc-800/40">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="inline-flex items-center gap-1 text-[11px] font-black text-zinc-400"
              title={legSlOverridden(row, leg) ? `${leg} uses its ${legSlOverridden(row, leg)} (set under the row's rules); this × is the fallback when that cannot be measured (no delta / spot at entry)` : `Exit ${leg} alone when its premium reaches its own entry × this — independent of the other leg and of the pair stop`}>
              SL ×
              <RuleNumInput value={(isCe ? row.ceSlMultiplier : row.peSlMultiplier) ?? '1.2'}
                onCommit={v => onUpdate(isCe ? { ceSlMultiplier: v } : { peSlMultiplier: v })}
                className="w-12 h-6 text-center text-[11px]" />
            </label>
            <label className="inline-flex items-center gap-1 text-[11px] font-black text-zinc-400"
              title={`${leg} target: exit ${leg} alone once it has moved this many ${legTgtUnitWords(row.legTgtUnit)}. Blank = off`}>
              Tgt
              <RuleNumInput value={(isCe ? row.ceTgtPct : row.peTgtPct) ?? ''}
                onCommit={v => onUpdate(isCe ? { ceTgtPct: v } : { peTgtPct: v })}
                placeholder="off" className="w-12 h-6 text-center text-[11px]" />
              <select value={row.legTgtUnit ?? 'pct'} aria-label="Leg target unit (both legs)"
                title="Leg target type (both legs): % of the leg's own entry, premium points below it, or the index moving that far in the leg's favour from the spot at entry"
                onChange={e => onUpdate({ legTgtUnit: e.target.value as LegTgtUnit })}
                className="text-[11px] font-bold h-6 px-0.5 border border-zinc-700 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500 cursor-pointer">
                {LEG_TGT_UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{legTgtUnitLabel(o.value as LegTgtUnit)}</option>)}
              </select>
            </label>
            <LegSlLevels row={row} live={live} leg={leg} lotSize={lotSize} inline />
          </div>
          {!legFlat && (
            <div className="flex items-center gap-1 font-mono text-[11px]">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider mr-0.5">Partial</span>
              {chips.map(c => (
                <button key={c.pct} type="button" onClick={() => onExitPartial(leg, c.pct as 25 | 50 | 75)}
                  disabled={!canTrade || !c.enabled} title={canTrade ? c.title : tradeBlockedWhy}
                  className={cn('px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-800/50 text-rose-300 hover:bg-rose-800 hover:text-oncolor transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>
                  {c.pct}%
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <tr className={cn(
      'border-b border-zinc-800/80 transition-colors',
      !flat ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : cn(
        rowIndex % 2 === 1 && 'bg-zinc-900/25',
        'hover:bg-zinc-800/35',
      ),
    )}>

      {/* 1. STRATEGY & SETUP */}
      <td className={cn(
        'p-3 align-top min-w-[240px] border-r border-zinc-700/60',
        !flat && 'border-l-4 border-l-emerald-500 bg-emerald-500/5',
        flat && row.status === 'armed' && 'border-l-4 border-l-violet-500/80 bg-violet-500/5',
        flat && row.status !== 'armed' && 'border-l-4 border-l-transparent',
      )}>
        <div className="flex flex-col gap-2">
          {/* Top Line: Underlying chip + Side Selector + Lots + Delete */}
          <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-zinc-800/60">
            <div className="flex items-center gap-1.5">
              <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-black border', UNDERLYING_CHIP[row.underlying])}>
                <span className={cn('h-1.5 w-1.5 rounded-full', UNDERLYING_DOT[row.underlying])} />
                {row.underlying}
              </span>
              <RowModeToggle row={row} flat={flat} liveRealMoney={liveRealMoney} onUpdate={onUpdate} />
              <SegPill
                options={['CE', 'BOTH', 'PE'] as const}
                value={row.side as 'CE' | 'BOTH' | 'PE'}
                title="Trade Call, Put, or Both"
                onChange={s => onUpdate({ side: s })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold text-zinc-500 uppercase">Lots</span>
                <LotStepper value={row.lots} onChange={v => onUpdate({ lots: v })} />
              </div>
              <button
                type="button"
                onClick={flat ? onDelete : undefined}
                disabled={!flat}
                title={flat ? 'Delete this row' : 'Position open — exit position first to delete row'}
                aria-label="Delete row"
                className={cn(
                  'p-1 rounded text-zinc-500 transition-colors',
                  flat
                    ? 'hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer'
                    : 'opacity-30 cursor-not-allowed hover:text-zinc-500',
                  FOCUS_RING,
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Middle: Entry & Exit Timing */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center justify-between gap-1 bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-2 py-1">
              <span className="text-[10px] font-black text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                <Clock className="h-2.5 w-2.5 text-zinc-500" /> ENTRY
              </span>
              <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: clampHm(v, UNDERLYING_META[row.underlying].entryMinHm, UNDERLYING_META[row.underlying].entryMaxHm) })} />
            </div>
            <div className="flex items-center justify-between gap-1 bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-2 py-1">
              <span className="text-[10px] font-black text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                <Clock className="h-2.5 w-2.5 text-zinc-500" /> EXIT
              </span>
              <TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: clampHm(v, UNDERLYING_META[row.underlying].exitMinHm, UNDERLYING_META[row.underlying].exitMaxHm) })} />
            </div>
          </div>

          {/* Bottom: Expiry + DTE */}
          <div className="flex items-center justify-between gap-1 pt-1 border-t border-zinc-800/60">
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <span className="text-[10px] font-black text-zinc-500 uppercase shrink-0 flex items-center gap-0.5">
                <Calendar className="h-2.5 w-2.5 text-zinc-500" /> EXPY
              </span>
              <select
                value={row.expiry || expiries[0] || ''}
                disabled={expiryLocked || expiries.length === 0}
                onChange={e => onUpdate({ expiry: e.target.value })}
                title={expiryLocked ? 'Locked while leg open' : 'Contract Expiry'}
                className="text-[11px] font-mono font-bold h-6 px-1.5 border border-zinc-700/80 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500 disabled:opacity-50 disabled:cursor-not-allowed w-full cursor-pointer"
              >
                {expiries.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-0.5 shrink-0 bg-zinc-900 border border-zinc-800 p-0.5 rounded">
              {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onUpdate({ dte: d })}
                  disabled={!onNearestExpiry}
                  className={cn(
                    'text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
                    row.dte === d ? 'bg-violet-600 text-oncolor' : 'text-zinc-400 hover:text-zinc-200',
                    FOCUS_RING,
                  )}
                >{d}</button>
              ))}
            </div>
          </div>
        </div>
      </td>

      {/* 2. STRIKES & SELECTION */}
      <td className="p-3 align-top min-w-[280px] border-r border-zinc-700/60">
        <StrikeEditor row={row} live={live} step={step} onUpdate={onUpdate} onShift={onShift} shiftDisabled={busy} onBlocked={onBlocked}
          buildupWsActive={buildupWsActive} buildupExpiryHint={buildupExpiryHint} />
      </td>

      {/* 3. MARKET TELEMETRY */}
      <td className="p-3 align-top min-w-[180px] border-r border-zinc-700/60">
        <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-2.5">
          <LtpStack
            combinedLtp={combinedLtp}
            live={live}
            ceValue={ceValue}
            peValue={peValue}
            totalValue={totalValue}
            pcr={pcr}
            pcrOi={pcrOi}
            compact={true}
          />
        </div>
      </td>

      {/* 4. CE / PE LEGS — each leg's orders, own SL × / target and levels, then re-entry */}
      <td className="p-3 align-top min-w-[480px] border-r border-zinc-700/60">
        <div className="flex flex-col gap-2">
          {legPod('CE')}
          {legPod('PE')}
          <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-2.5 py-2 flex flex-col gap-1">
            <span className="text-[11px] font-black uppercase tracking-wider text-zinc-500">Re-entry after a leg SL × / target</span>
            <LegReentryControls row={row} onUpdate={onUpdate} onCancelPending={onCancelPending} legTargetsElsewhere />
          </div>
        </div>
      </td>

      {/* 5. SAFEGUARDS & COMMAND DESK — row-wide rules only */}
      <td className="p-3 align-top min-w-[300px]">
        <div className="flex flex-col gap-2.5 bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-2.5">
          {/* Header: Status Pill + row P&L */}
          <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
            <div className="flex items-center gap-2">
              <span className={cn('text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border', STATUS_PILL[shownStatus(row, flat)])}>
                {shownStatus(row, flat)}
              </span>
              <span className={cn(
                'text-sm font-mono font-black px-2 py-0.5 rounded border tabular-nums',
                live.pnl > 0 ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 shadow-sm shadow-emerald-500/10'
                  : live.pnl < 0 ? 'bg-rose-500/15 text-rose-400 border-rose-500/40 shadow-sm shadow-rose-500/10'
                  : 'bg-zinc-900 border-zinc-700/60 text-zinc-400'
              )} title="Row total P&L (realized + open mark-to-market)">
                {live.pnl > 0 ? '+' : ''}₹{live.pnl.toFixed(0)}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onUpdate({
                  levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1',
                  slRupees: '', slMultiplier: '', ceSlMultiplier: '1.2', peSlMultiplier: '1.2',
                  slRollStrikes: 0, slToCost: false, slToCostScope: undefined, squareOff: undefined, reSlMode: 'off', reTgtMode: 'off',
                  ceTgtPct: '', peTgtPct: '', noReEntryAfter: '', entryMomEnabled: false, entryMomValue: '', ceSimpleMom: undefined, peSimpleMom: undefined, ceRangeBreakout: undefined, peRangeBreakout: undefined, lazyLegs: undefined, reSlLazyId: undefined, reTgtLazyId: undefined, overallTarget: undefined, overallTrail: undefined, overallReSl: undefined, overallReTgt: undefined,
                })}
                title="Clear rules"
                className={cn('text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer', FOCUS_RING)}
              >
                &times; clear
              </button>
              <button
                type="button"
                onClick={flat ? onDelete : undefined}
                disabled={!flat}
                title={flat ? 'Delete this row' : 'Position open — exit position first to delete row'}
                aria-label="Delete row"
                className={cn(
                  'p-1 rounded text-zinc-500 transition-colors',
                  flat
                    ? 'hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer'
                    : 'opacity-30 cursor-not-allowed hover:text-zinc-500',
                  FOCUS_RING,
                )}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Row-wide rules: ₹ stop, pair premium multiple, spot levels */}
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-2 py-1" title="Row stop loss in ₹ (both legs together)">
              <span className="text-amber-400 text-[11px] font-black w-12 shrink-0">SL ₹</span>
              <RuleNumInput value={row.slRupees} onCommit={v => onUpdate({ slRupees: v })} placeholder="off" className="w-full flex-1 min-w-0 h-7 text-center text-xs" />
            </label>
            <label className="flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-2 py-1" title="Pair stop: exit both legs when their combined premium reaches entry × this">
              <span className="text-amber-400 text-[11px] font-black w-12 shrink-0">Pair ×</span>
              <RuleNumInput value={row.slMultiplier} placeholder="off" onCommit={v => onUpdate({ slMultiplier: v })} className="w-full flex-1 min-w-0 h-7 text-center text-xs" />
            </label>
            <div className="flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-2 py-1">
              <span className="text-rose-400 text-[11px] font-black w-12 shrink-0">Spot H&uarr;</span>
              <RuleNumStepper value={row.levelHigh} onCommit={v => onUpdate({ levelHigh: v })} wrapperClassName="w-full flex-1 flex items-center gap-0.5" className="w-full flex-1 min-w-0 h-7 text-center text-xs" title="Exit the row when spot reaches this high" />
            </div>
            <div className="flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-2 py-1">
              <span className="text-emerald-400 text-[11px] font-black w-12 shrink-0">Spot L&darr;</span>
              <RuleNumStepper value={row.levelLow} onCommit={v => onUpdate({ levelLow: v })} wrapperClassName="w-full flex-1 flex items-center gap-0.5" className="w-full flex-1 min-w-0 h-7 text-center text-xs" title="Exit the row when spot falls to this low" />
            </div>
          </div>

          {/* VWAP exit */}
          <div className="flex items-center justify-between gap-1.5 text-[11px]">
            <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VWAP exit" title="Exit when the combined premium crosses its session-open VWAP against you" />
            {row.levelVw && (
              <div className="flex items-center gap-1.5">
                <select value={row.vwapInterval || '1'} onChange={e => onUpdate({ vwapInterval: e.target.value })} aria-label="VWAP candle interval" className="text-[11px] font-bold h-6 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-300">
                  <option value="1">1m</option><option value="5">5m</option>
                </select>
                <RuleNumInput value={row.vwapBufferPct} onCommit={v => onUpdate({ vwapBufferPct: v })} className="w-12 h-6 text-center text-[11px]" title="Buffer %" />
                <span className="font-mono text-zinc-300">{live.vwap != null ? `VWAP ${live.vwap.toFixed(2)}` : 'VWAP —'}</span>
              </div>
            )}
          </div>

          {/* Actions: Arm & Exit All */}
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/60">
            {(shownStatus(row, flat) === 'draft' || shownStatus(row, flat) === 'exited') && (
              <button onClick={onArm} className={cn('flex-1 flex items-center justify-center gap-1.5 text-xs font-black py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 cursor-pointer shadow-sm transition-all', FOCUS_RING)}>
                <Zap className="h-3.5 w-3.5" /> Arm
              </button>
            )}
            {row.status === 'armed' && (
              <button onClick={onDisarm} className={cn('flex-1 flex items-center justify-center gap-1.5 text-xs font-bold py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-all', FOCUS_RING)}>
                <ShieldOff className="h-3.5 w-3.5" /> Disarm
              </button>
            )}
            {shownStatus(row, flat) === 'entered' && (
              <div className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Active
              </div>
            )}
            <button onClick={() => onExit('ALL')} disabled={flat || !canTrade}
              className={cn('flex-1 flex items-center justify-center gap-1.5 text-xs font-black py-1.5 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-sm transition-all', FOCUS_RING)}>
              <ShieldOff className="h-3.5 w-3.5" /> Exit All
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}
const FocusTableRow = memo(FocusTableRowImpl, rowDataPropsEqual);

// ── Pro view for a single row ─────────────────────────────────────────────────
//
// A tight, grid-aligned layout built from the shadcn/ui primitives: one header
// bar for the row's schedule and command buttons, a legs grid (one line per
// leg: strike → price → position → its own rules → orders), and a side panel
// for row-wide stops and telemetry. Re-entry folds into a collapsible under
// the grid with a one-line summary. Same props, callbacks and rule helpers as
// the table/cards views — only the layout differs, so every guard (strike
// locks via useStrikeEditing, ownership-sized chips, commit-on-blur inputs)
// is shared, not re-implemented.

type FocusRowViewProps = Parameters<typeof FocusTableRowImpl>[0];

const PRO_LABEL = 'text-[11px] font-semibold uppercase tracking-wider text-zinc-500';
const PRO_INPUT = 'h-7 text-xs text-center bg-zinc-950/60 border-zinc-700 rounded-md';

/** A labelled control in the Pro header / side panel. */
function ProField({ label, title, children, className }: {
  label: string; title?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1.5', className)} title={title}>
      <span className={PRO_LABEL}>{label}</span>
      {children}
    </div>
  );
}

const PRO_STATUS: Record<FocusRowStatus, { cls: string; bar: string }> = {
  draft:   { cls: 'bg-zinc-800 text-zinc-300 border-zinc-700', bar: 'before:bg-zinc-700' },
  armed:   { cls: 'bg-violet-500/15 text-violet-300 border-violet-500/40', bar: 'before:bg-violet-500' },
  entered: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', bar: 'before:bg-emerald-500' },
  exited:  { cls: 'bg-zinc-800 text-zinc-400 border-zinc-700', bar: 'before:bg-zinc-600' },
};

/** One-line summary of the row's re-entry setup for the collapsed strip. */
function reentrySummary(row: FocusRow): string {
  const sl = reentryConfig(row, 'sl');
  const tgt = reentryConfig(row, 'tgt');
  const one = (c: typeof sl) => c.mode === 'off'
    ? 'off'
    : `${REENTRY_LABEL[c.mode]}${c.mode === 'otm' ? ` ${c.otmStrikes}` : ''} ×${c.max}`;
  const parts = [`SL: ${one(sl)}`, `Tgt: ${one(tgt)}`];
  if (row.noReEntryAfter) parts.push(`none after ${row.noReEntryAfter}`);
  if (row.squareOff === 'complete') parts.push('Square off complete');
  if (row.slToCost) parts.push(`Trail SL to BE (${row.slToCostScope === 'sl' ? 'SL legs' : 'all legs'})`);
  return parts.join(' · ');
}

/** Whole-rupee signed P&L with Indian grouping: +₹1,729 / −₹1,245 / ₹0. */
function fmtPnl0(n: number): string {
  if (!Number.isFinite(n)) return '\u2014';
  const r = Math.round(n);
  const sign = r < 0 ? '\u2212' : r > 0 ? '+' : '';
  return `${sign}\u20B9${Math.abs(r).toLocaleString('en-IN')}`;
}

function FocusProRowImpl({
  row, live, lotSize, spot, liveRealMoney, busy,
  expiries, buildupWsActive, buildupExpiryHint,
  onUpdate, onDelete, onArm, onDisarm, onExit, onExitPartial, onAddLot, onAddAllLegs, onLadderPlace, onLadderCancel, onReduceLot, onShift, onBlocked,
  onCancelPending,
}: FocusRowViewProps) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const { ceValue, peValue, totalValue, pcr, pcrOi } = legValues(row, live, lotSize);
  const canTrade = (isSimRow(row) || liveRealMoney) && !busy && (live.ceStrike != null || live.peStrike != null) && (lotSize ?? 0) > 0;
  const flat = rowFlat(row);
  // What is still in the market on the open legs. Premium left is in the same units as
  // the entry premium (Σ lots × price); Profit left is that in rupees (Σ qty × price) — the
  // most the open legs can still make if they all expire worthless.
  const leftPremium = !rowFlat(row) ? sidePremium(row, live, undefined, lotSize) : 0;
  const leftProfit = leftPremium * (lotSize ?? 0);
  const leftPct = live.entryPremium > 0 && leftPremium > 0 ? (leftPremium / live.entryPremium) * 100 : null;
  // Shown the way the legs read: the plain sum of each open leg's price (CE + PE), against the sum of
  // their entry prices. The percent stays rupee-weighted (it is what Profit left is made of), so on a
  // lopsided strangle (more lots on one leg) it can differ by a point or two from the plain ratio.
  const openLegs = legsOf(row).filter(l => rowOwnsLeg(row, l));
  const legNow = (l: 'CE' | 'PE') => Number(l === 'CE' ? live.ltpCe : live.ltpPe) || 0;
  const nowSum = openLegs.reduce((a, l) => a + legNow(l), 0);
  const entrySum = openLegs.reduce((a, l) => a + legOwnEntry(row, l, live), 0);
  // Break-evens at expiry of the legs open now, from the central payoff model (same maths as every
  // payoff chart). Re-solved only when the book changes, not on every tick.
  const beExpiry = row.expiry || expiries[0] || '';
  const beKey = flat ? '' : legsOf(row).filter(l => rowOwnsLeg(row, l)).map(l => {
    const strike = l === 'CE' ? live.ceStrike : live.peStrike;
    return `${l}:${strike}:${legOwnContracts(row, l, live)}:${legOwnEntry(row, l, live).toFixed(2)}`;
  }).join('|');
  const breakevens = useMemo<number[]>(() => {
    if (!beKey || !beExpiry || !(spot > 0)) return [];
    const legs = beKey.split('|').flatMap(part => {
      const [t, k, q, e] = part.split(':');
      const qty = Number(q), strike = Number(k), entry = Number(e);
      if (!(qty > 0) || !(strike > 0) || !(entry > 0)) return [];
      return [{ type: t as 'CE' | 'PE', strike, expiry: beExpiry, qty: -qty, entryPrice: entry }];
    });
    if (legs.length === 0) return [];
    try { return buildPayoffModel({ legs, spot: Math.round(spot / 5) * 5, light: true, strikeStep: STRIKE_STEP[row.underlying] })?.breakevens ?? []; } catch { return []; }
  }, [beKey, beExpiry, Math.round(spot / 5), row.underlying]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = shownStatus(row, flat);
  const tradeBlockedWhy = !isSimRow(row) && !liveRealMoney
    ? 'REAL row — turn on LIVE · REAL MONEY to place orders, or switch the row to SIM'
    : busy
      ? 'An order for this row is already in flight'
      : (lotSize ?? 0) <= 0
        ? 'Lot size for this index has not resolved yet'
        : 'Strike not resolved yet';
  const step = STRIKE_STEP[row.underlying];
  const [qty, setQty] = useState<Record<'CE' | 'PE', number>>({ CE: 1, PE: 1 });
  const [addAllLots, setAddAllLots] = useState(1);
  const [ladderLots, setLadderLots] = useState<Record<'CE' | 'PE', number>>({ CE: 1, PE: 1 });
  const [reOpen, setReOpen] = useState(false);
  const expiryLocked = rowOwnsLeg(row, 'CE') || rowOwnsLeg(row, 'PE');
  const onNearestExpiry = !row.expiry || row.expiry === expiries[0];
  const strikes = useStrikeEditing(row, live, onUpdate, onBlocked);
  const traded = legsOf(row);

  const clearRules = () => onUpdate({
    levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1',
    slRupees: '', slMultiplier: '', ceSlMultiplier: '1.2', peSlMultiplier: '1.2',
    slRollStrikes: 0, slToCost: false, slToCostScope: undefined, squareOff: undefined, reSlMode: 'off', reTgtMode: 'off',
    ceTgtPct: '', peTgtPct: '', noReEntryAfter: '', entryMomEnabled: false, entryMomValue: '', ceSimpleMom: undefined, peSimpleMom: undefined, ceRangeBreakout: undefined, peRangeBreakout: undefined, lazyLegs: undefined, reSlLazyId: undefined, reTgtLazyId: undefined, overallTarget: undefined, overallTrail: undefined, overallReSl: undefined, overallReTgt: undefined,
  });

  const legLine = (leg: 'CE' | 'PE') => {
    const isCe = leg === 'CE';
    const inSide = traded.includes(leg);
    const owns = rowOwnsLeg(row, leg);
    const legFlat = !owns;
    const ltp = isCe ? live.ltpCe : live.ltpPe;
    const strike = isCe ? live.ceStrike : live.peStrike;
    const pos = isCe ? live.cePosition : live.pePosition;
    const pnl = computeLegPnl(row, leg, live);
    const chips = partialCloseChips(legOwnContracts(row, leg, live), lotSize ?? 0, [25, 50, 75]);
    const buildup = isCe ? live.ceBuildup : live.peBuildup;
    const buildupStyle = buildup ? BUILDUP_STYLES[buildup] : undefined;
    const oiChg = isCe ? live.ceOiChgPct : live.peOiChgPct;
    const locked = strikes.legOpen[leg];
    const lockedTitle = `${leg} holds an open position — use the arrows to roll it, or exit the leg first`;
    const q = qty[leg];
    const tone = isCe ? 'text-emerald-400' : 'text-rose-400';
    const ladderOpen = !!onLadderPlace && owns && Number(pos?.netQty) < 0;
    const ladderRef = isCe ? live.ltpCe : live.ltpPe;
    const pending = (row.ladder ?? []).filter(o => o.leg === leg);
    return (
      <React.Fragment key={leg}>
      <TableRow className={cn('border-zinc-800/70 hover:bg-zinc-800/20', !inSide && !owns && 'opacity-50')}>
        <TableCell className="py-1.5 pl-3 pr-1 w-10">
          <span className={cn('inline-flex h-6 w-9 items-center justify-center rounded-md border text-xs font-black',
            isCe ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/10 text-rose-400 border-rose-500/30')}>{leg}</span>
        </TableCell>
        {/* Strike: rule → resolved strike → roll arrows */}
        <TableCell className="py-1.5 px-2">
          <div className="flex items-center gap-1.5">
            {strikes.mode === 'ATM' ? (
              <Select value={String((isCe ? row.ceOffset : row.peOffset) ?? 0)} disabled={locked}
                onValueChange={v => { if (v != null) strikes.setLeg(leg, isCe ? { ceOffset: Number(v) } : { peOffset: Number(v) }); }}>
                <SelectTrigger size="sm" title={locked ? lockedTitle : `${leg} strike as a step offset from ATM`}
                  className="h-7 w-36 text-xs font-semibold bg-zinc-950/60 border-zinc-700">
                  <SelectValue>{(v: string) => offsetLabel(Number(v), step)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {OFFSET_OPTIONS.map(n => <SelectItem key={n} value={String(n)}>{offsetLabel(n, step)}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <RuleNumInput value={(isCe ? row.cePremium : row.pePremium) ?? ''} disabled={locked} placeholder="₹ target"
                onCommit={v => strikes.setLeg(leg, isCe ? { cePremium: v } : { pePremium: v })}
                title={locked ? lockedTitle : `Target premium for ${leg} — the closest strike priced at or below it`}
                className={cn(PRO_INPUT, 'w-36')} />
            )}
            <span className="font-mono text-sm font-bold text-zinc-100 tabular-nums w-14 text-right">{strike ?? '—'}</span>
            <div className="flex items-center">
              <Button variant="ghost" size="icon" className="size-7 text-zinc-400 hover:text-emerald-400"
                disabled={busy || strike == null} onClick={() => onShift(leg, 'UP')}
                title={`Shift ${leg} strike up one step — closes and reopens any live position at the new strike`}
                aria-label={`Shift ${leg} strike up one step`}><ChevronUp className="size-4" /></Button>
              <Button variant="ghost" size="icon" className="size-7 text-zinc-400 hover:text-rose-400"
                disabled={busy || strike == null} onClick={() => onShift(leg, 'DOWN')}
                title={`Shift ${leg} strike down one step — closes and reopens any live position at the new strike`}
                aria-label={`Shift ${leg} strike down one step`}><ChevronDown className="size-4" /></Button>
            </div>
            {buildupStyle ? (
              <span className={cn('text-[11px] font-black px-1.5 py-0.5 rounded border leading-none', buildupStyle.cls)}
                title={`${buildupStyle.text}${oiChg != null && oiChg !== 0 ? ` — OI ${oiChg > 0 ? '+' : ''}${oiChg.toFixed(1)}%` : ''}`}>
                {buildup}{oiChg != null && oiChg !== 0 ? ` ${oiChg > 0 ? '+' : ''}${oiChg.toFixed(0)}%` : ''}
              </span>
            ) : buildupExpiryHint && strike != null ? (
              <span className="text-[11px] font-semibold text-zinc-500" title={buildupExpiryHint}>OI n/a</span>
            ) : null}
          </div>
        </TableCell>
        {/* Average entry: this row's own stamped entry (legOwnEntry), never the broker's blended day average when ours exists */}
        <TableCell className="py-1.5 px-2 text-center font-mono text-sm font-bold tabular-nums text-zinc-100"
          title={`${leg} average entry price (this row's own fills)`}>
          {owns && pos && Number(pos.netQty) !== 0 && legOwnEntry(row, leg, live) > 0 ? legOwnEntry(row, leg, live).toFixed(2) : '—'}
        </TableCell>
        <TableCell className={cn('py-1.5 px-2 text-center font-mono text-sm font-black tabular-nums', tone)}>
          {ltp != null ? ltp.toFixed(2) : '—'}
        </TableCell>
        <TableCell className="py-1.5 px-2 text-center">
          {owns && pos && Number(pos.netQty) !== 0
            ? <LegOpenBadge pos={pos} />
            : <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{inSide ? 'Flat' : 'Not traded'}</span>}
        </TableCell>
        <TableCell className={cn('py-1.5 px-2 text-center font-mono text-sm font-bold tabular-nums', pnlClass(pnl))}>
          {pnl != null ? fmtPnl0(pnl) : '—'}
        </TableCell>
        {/* This leg's own rules */}
        <TableCell className="py-1.5 px-2 text-center">
          <RuleNumInput value={(isCe ? row.ceSlMultiplier : row.peSlMultiplier) ?? '1.2'}
            onCommit={v => onUpdate(isCe ? { ceSlMultiplier: v } : { peSlMultiplier: v })}
            title={legSlOverridden(row, leg) ? `${leg} uses its ${legSlOverridden(row, leg)}; this × is the fallback when that cannot be measured` : `Exit ${leg} alone when its premium reaches its own entry × this`}
            className={cn(PRO_INPUT, 'w-14')} />
        </TableCell>
        <TableCell className="py-1.5 px-2 text-center">
          <RuleNumInput value={(isCe ? row.ceTgtPct : row.peTgtPct) ?? ''} placeholder="off"
            onCommit={v => onUpdate(isCe ? { ceTgtPct: v } : { peTgtPct: v })}
            title={`Exit ${leg} alone once it has moved this many ${legTgtUnitWords(row.legTgtUnit)}. Blank = off`}
            className={cn(PRO_INPUT, 'w-14')} />
        </TableCell>
        <TableCell className="py-1.5 px-2 text-center">
          <LegSlLevels row={row} live={live} leg={leg} lotSize={lotSize} inline />
        </TableCell>
        {/* Orders */}
        <TableCell className="py-1.5 pl-2 pr-3">
          <div className="flex items-center justify-end gap-1">
            <LegLotSelect value={q} onChange={n => setQty(p => ({ ...p, [leg]: n }))} className="w-11 h-7 text-xs" title={`Lots the ${leg} + / − buttons act on`} />
            <Button variant="outline" size="icon" className="size-7 border-zinc-700 bg-zinc-900 text-zinc-200"
              disabled={!canTrade} onClick={() => onAddLot(leg, q)}
              title={canTrade ? `Sell ${q} more lot(s) of ${leg}` : tradeBlockedWhy} aria-label={`Add ${q} ${leg} lots`}>
              <Plus className="size-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="size-7 border-zinc-700 bg-zinc-900 text-zinc-200"
              disabled={!canTrade || legFlat} onClick={() => onReduceLot(leg, q)}
              title={legFlat ? 'Nothing open' : canTrade ? `Buy back ${q} lot(s) of ${leg}` : tradeBlockedWhy} aria-label={`Reduce ${leg} by ${q} lots`}>
              <Minus className="size-3.5" />
            </Button>
            {/* Part-exit chips, shown directly (no menu): a chip is disabled when its % rounds to zero lots */}
            {chips.map(c => (
              <Button key={c.pct} variant="outline" size="sm"
                className="h-7 px-1.5 border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-300"
                disabled={!canTrade || legFlat || !c.enabled}
                onClick={() => onExitPartial(leg, c.pct as 25 | 50 | 75)}
                title={legFlat ? 'Nothing open' : c.title}
                aria-label={`Exit ${c.pct}% of ${leg}`}>
                {c.pct}%
              </Button>
            ))}
            <Button size="sm" className="h-7 px-3 bg-rose-600 text-oncolor hover:bg-rose-500 font-bold"
              disabled={!canTrade || legFlat} onClick={() => onExit(leg)}
              title={legFlat ? 'Nothing open' : canTrade ? `Exit the ${leg} leg` : tradeBlockedWhy}>
              Exit
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {(ladderOpen || pending.length > 0) && (
        <TableRow className="border-zinc-800/70 hover:bg-transparent">
          <TableCell colSpan={10} className="py-1 pl-3 pr-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('text-[11px] font-black uppercase tracking-wider', tone)}>{leg} limit sell</span>
              <LegLotSelect value={ladderLots[leg]} onChange={n => setLadderLots(p => ({ ...p, [leg]: n }))} className="w-11 h-7 text-xs" title={`Lots each ${leg} limit order sells`} />
              {LADDER_PCTS.map(pct => {
                const px = ladderRef != null && ladderRef > 0 ? ladderPrice(ladderRef, pct) : null;
                const taken = pending.some(o => o.pct === pct);
                return (
                  <Button key={pct} variant="outline" size="sm"
                    className="h-7 px-2 border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-200"
                    disabled={!ladderOpen || !canTrade || taken || px == null}
                    onClick={() => onLadderPlace?.(leg, pct, ladderLots[leg])}
                    title={taken ? `+${pct}% limit is already placed` : px != null ? `Place SELL LIMIT ${ladderLots[leg]} lot(s) at ${px.toFixed(2)} (+${pct}% over ${ladderRef!.toFixed(2)})` : 'Waiting for a price'}
                    aria-label={`${leg} sell limit ${pct} percent above price`}>
                    +{pct}%{px != null && <span className="ml-1 font-mono text-[11px] font-semibold text-zinc-400">{px.toFixed(2)}</span>}
                  </Button>
                );
              })}
              {pending.map(o => (
                <span key={o.orderId} className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-xs font-bold text-amber-300"
                  title={`Resting SELL LIMIT ${o.qty} @ ${o.price.toFixed(2)} (+${o.pct}%)${o.credited ? ` · ${o.credited} filled` : ''}`}>
                  {o.price.toFixed(2)} ×{Math.round(o.qty / (lotSize || 1))}
                  <button type="button" className="ml-0.5 rounded px-1 text-amber-200 hover:bg-amber-500/30 cursor-pointer"
                    onClick={() => onLadderCancel?.(leg, o.orderId)} aria-label={`Cancel ${leg} limit at ${o.price.toFixed(2)}`} title="Cancel this limit order">✕</button>
                </span>
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
      </React.Fragment>
    );
  };

  return (
    <div className={cn(
      'relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 shadow-sm',
      "before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-['']", PRO_STATUS[status].bar,
    )}>
      {/* ── Header: identity · schedule · command ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-4 pr-3 py-2 border-b border-zinc-800 bg-zinc-900/60">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn('h-6 px-2 text-[11px] font-bold uppercase tracking-wider', PRO_STATUS[status].cls)}>
            {status === 'entered' && <span className="mr-1 size-1.5 rounded-full bg-emerald-400 animate-pulse" />}
            {status}
          </Badge>
          <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-black', UNDERLYING_CHIP[row.underlying])}>
            <span className={cn('size-1.5 rounded-full', UNDERLYING_DOT[row.underlying])} />
            {row.underlying}
          </span>
          <RowModeToggle row={row} flat={flat} liveRealMoney={liveRealMoney} onUpdate={onUpdate} />
        </div>

        <Separator orientation="vertical" className="h-6 bg-zinc-800" />

        <ToggleGroup value={[row.side]} variant="outline" size="sm" spacing={0}
          onValueChange={(v: unknown[]) => { const s = v[v.length - 1] as FocusSide | undefined; if (s) onUpdate({ side: s }); }}
          aria-label="Legs this row trades" title="Trade the call, the put, or both">
          {(['CE', 'BOTH', 'PE'] as const).map(s => (
            <ToggleGroupItem key={s} value={s} className="h-7 px-2.5 text-xs font-bold aria-pressed:bg-violet-600 aria-pressed:text-oncolor">{s}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ProField label="Lots"><LotStepper value={row.lots} onChange={v => onUpdate({ lots: v })} /></ProField>
        <ProField label="Window" title="Entry time → exit time (IST)">
          <div className="w-[5.5rem]"><TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: clampHm(v, UNDERLYING_META[row.underlying].entryMinHm, UNDERLYING_META[row.underlying].entryMaxHm) })} /></div>
          <ArrowRight className="size-3.5 text-zinc-500" />
          <div className="w-[5.5rem]"><TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: clampHm(v, UNDERLYING_META[row.underlying].exitMinHm, UNDERLYING_META[row.underlying].exitMaxHm) })} /></div>
        </ProField>
        <ProField label="Expiry">
          <Select value={row.expiry || expiries[0] || ''} disabled={expiryLocked || expiries.length === 0}
            onValueChange={v => { if (v) onUpdate({ expiry: v }); }}>
            <SelectTrigger size="sm" title={expiryLocked ? 'Locked while a leg is open' : 'Contract expiry'}
              className="h-7 w-32 font-mono text-xs bg-zinc-950/60 border-zinc-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {expiries.map(e => <SelectItem key={e} value={e} className="font-mono text-xs">{e}</SelectItem>)}
            </SelectContent>
          </Select>
          <ToggleGroup value={[row.dte]} variant="outline" size="sm" spacing={0} disabled={!onNearestExpiry}
            onValueChange={(v: unknown[]) => { const d = v[v.length - 1] as FocusDte | undefined; if (d) onUpdate({ dte: d }); }}
            aria-label="Days to expiry filter"
            title={onNearestExpiry ? 'Only enter on this many days to the nearest expiry' : 'DTE filter applies to the nearest expiry only'}>
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <ToggleGroupItem key={d} value={d} className="h-7 px-2 font-mono text-xs aria-pressed:bg-violet-600 aria-pressed:text-oncolor">{d}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </ProField>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-7 pr-3">
          {breakevens.length > 0 && (
            <div className="flex flex-col items-end leading-none"
              title="Break-even index levels at expiry for the legs open now (premium collected on them only; realised P&L from closed legs is not included)">
              <span className={PRO_LABEL}>Breakeven</span>
              <span className="font-mono text-lg font-black tabular-nums text-sky-300">
                {breakevens.map(b => Math.round(b).toLocaleString('en-IN')).join(' – ')}
              </span>
            </div>
          )}
          {leftPremium > 0 && (
            <>
              <div className="flex flex-col items-end leading-none"
                title={`Sum of the open legs' prices now (${openLegs.map(l => `${l} ${legNow(l).toFixed(2)}`).join(' + ')}) against the sum of their entries (${entrySum.toFixed(2)})${leftPct != null ? `. ${leftPct.toFixed(0)}% of the premium (rupee-weighted by lots) is left to decay` : ''}`}>
                <span className={PRO_LABEL}>Premium left</span>
                <span className="font-mono text-lg font-black tabular-nums text-zinc-100">
                  {nowSum.toFixed(2)}
                  <span className="ml-1.5 text-xs font-bold text-zinc-400">of {entrySum.toFixed(2)}{leftPct != null && ` · ${leftPct.toFixed(0)}%`}</span>
                </span>
              </div>
              <div className="flex flex-col items-end leading-none"
                title={`Most you can still make on the open legs if everything expires worthless: Σ qty × current price = ${fmtInr(leftProfit)}. Realised so far is in P&L.`}>
                <span className={PRO_LABEL}>Profit left</span>
                <span className="font-mono text-lg font-black tabular-nums text-emerald-400">{fmtInr(leftProfit)}</span>
              </div>
            </>
          )}
          <div className="flex flex-col items-end leading-none" title="Row total P&L (realized + open mark-to-market)">
            <span className={PRO_LABEL}>P&amp;L</span>
            <span className={cn('font-mono text-lg font-black tabular-nums', pnlClass(live.pnl))}>
              {fmtPnl0(live.pnl)}
            </span>
          </div>
          </div>
          {onAddAllLegs && !flat && (
            <div className="flex items-center gap-1" title="Add this many lots to EVERY open leg of the row (CE then PE, one after the other)">
              <LegLotSelect value={addAllLots} onChange={setAddAllLots} className="w-12 h-8 text-xs" title="Lots to add to each open leg" />
              <Button size="sm" variant="outline" className="h-8 px-3 border-emerald-600/50 bg-zinc-900 text-emerald-400 hover:bg-emerald-600 hover:text-oncolor font-bold"
                disabled={!canTrade} onClick={() => onAddAllLegs(addAllLots)}
                title={canTrade ? `Sell ${addAllLots} more lot(s) on each open leg` : tradeBlockedWhy}
                aria-label={`Add ${addAllLots} lots to every open leg`}>
                <Plus className="size-3.5" /> Add to all legs
              </Button>
            </div>
          )}
          {(status === 'draft' || status === 'exited') && (
            <Button size="sm" className="h-8 px-4 bg-violet-600 text-oncolor hover:bg-violet-500 font-bold" onClick={onArm}>
              <Zap className="size-3.5" /> Arm
            </Button>
          )}
          {row.status === 'armed' && (
            <Button size="sm" variant="outline" className="h-8 px-4 border-zinc-700 bg-zinc-900 font-bold" onClick={onDisarm}>
              <ShieldOff className="size-3.5" /> Disarm
            </Button>
          )}
          <Button size="sm" className="h-8 px-4 bg-rose-600 text-oncolor hover:bg-rose-500 font-bold"
            disabled={flat || !canTrade} onClick={() => onExit('ALL')}
            title={flat ? 'Nothing open' : canTrade ? 'Exit every leg this row holds' : tradeBlockedWhy}>
            <ShieldOff className="size-3.5" /> Exit all
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-8 text-zinc-400" aria-label="Row actions" />}>
              <Ellipsis className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={clearRules}><X className="size-4" /> Clear rules</DropdownMenuItem>
              <DropdownMenuItem onClick={strikes.resetStrikes} disabled={strikes.anyOpen}><RefreshCw className="size-4" /> Reset strikes to ATM</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={!flat} onClick={onDelete}>
                <Trash2 className="size-4" /> {flat ? 'Delete row' : 'Delete (exit first)'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ── Legs grid ── */}
        <div className="min-w-0">
          <Table className="min-w-[1500px] table-fixed">
            <TableHeader>
              <TableRow className="bg-zinc-800 hover:bg-zinc-800 border-zinc-700">
                {[
                  // Fixed percentage widths (sum 100) so the columns spread evenly instead of
                  // each hugging its widest cell.
                  ['', 'pl-3 w-[3%]'], ['Strike', 'w-[23%]'], ['Entry', 'text-center w-[7%]'], ['LTP', 'text-center w-[7%]'], ['Position', 'text-center w-[10%]'], ['P&L', 'text-center w-[8%]'],
                  ['SL ×', 'text-center w-[6%]'], [`Tgt ${legTgtUnitLabel(row.legTgtUnit)}`, 'text-center w-[6%]'], ['Stop · target at', 'text-center w-[10%]'], ['Orders', 'text-right pr-3 w-[20%]'],
                ].map(([h, c], i) => (
                  <TableHead key={i} className={cn('h-8 px-2 text-xs font-bold text-white', c)}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {legLine('CE')}
              {legLine('PE')}
            </TableBody>
          </Table>

          {/* Row rules: how strikes are picked, then the row-wide stops */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 border-t border-zinc-800 bg-zinc-950/30">
            <ProField label="Strike by" title="ATM± picks by steps from ATM; ₹ picks the closest strike priced at or below a target premium">
              <ToggleGroup value={[strikes.mode]} variant="outline" size="sm" spacing={0} disabled={strikes.anyOpen}
                onValueChange={(v: unknown[]) => { const m = v[v.length - 1] as FocusStrikeMode | undefined; if (m) strikes.setMode(m); }}>
                <ToggleGroupItem value="ATM" className="h-7 px-2.5 text-xs font-bold aria-pressed:bg-violet-600 aria-pressed:text-oncolor">ATM ±</ToggleGroupItem>
                <ToggleGroupItem value="PREMIUM" className="h-7 px-2.5 text-xs font-bold aria-pressed:bg-violet-600 aria-pressed:text-oncolor">₹ premium</ToggleGroupItem>
              </ToggleGroup>
            </ProField>
            <label className="flex items-center gap-2 text-xs font-semibold text-zinc-300 cursor-pointer" title="Keep CE and PE moving together">
              <Checkbox checked={row.linked ?? true} onCheckedChange={c => onUpdate({ linked: !!c })} />
              Link legs
            </label>
            <ProField label="Tgt unit" title="Leg target type (both legs): % of the leg's own entry, premium points below it, or the index moving that far in the leg's favour from the spot at entry">
              <ToggleGroup value={[row.legTgtUnit ?? 'pct']} variant="outline" size="sm" spacing={0}
                onValueChange={(v: unknown[]) => { const u2 = v[v.length - 1] as LegTgtUnit | undefined; if (u2) onUpdate({ legTgtUnit: u2 }); }}>
                {LEG_TGT_UNIT_OPTIONS.map(o => (
                  <ToggleGroupItem key={o.value} value={o.value} className="h-7 px-2.5 text-xs font-bold aria-pressed:bg-violet-600 aria-pressed:text-oncolor">{legTgtUnitLabel(o.value as LegTgtUnit)}</ToggleGroupItem>
                ))}
              </ToggleGroup>
            </ProField>

            <Separator orientation="vertical" className="h-6 bg-zinc-800" />

            <span className={PRO_LABEL}>Row stops</span>
            <ProField label="SL ₹" title="Row stop loss in ₹ across both legs">
              <RuleNumInput value={row.slRupees} placeholder="off" onCommit={v => onUpdate({ slRupees: v })} className={cn(PRO_INPUT, 'w-20')} />
            </ProField>
            <ProField label="Pair ×" title="Pair stop: exit both legs when their combined premium reaches entry × this">
              <RuleNumInput value={row.slMultiplier} placeholder="off" onCommit={v => onUpdate({ slMultiplier: v })} className={cn(PRO_INPUT, 'w-14')} />
            </ProField>
            <ProField label="Spot H ↑" title="Exit the row when spot reaches this high">
              <RuleNumStepper value={row.levelHigh} onCommit={v => onUpdate({ levelHigh: v })}
                wrapperClassName="flex items-center gap-0.5" className={cn(PRO_INPUT, 'w-20')} />
            </ProField>
            <ProField label="Spot L ↓" title="Exit the row when spot falls to this low">
              <RuleNumStepper value={row.levelLow} onCommit={v => onUpdate({ levelLow: v })}
                wrapperClassName="flex items-center gap-0.5" className={cn(PRO_INPUT, 'w-20')} />
            </ProField>
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-2 font-semibold text-zinc-300 cursor-pointer" title="Exit when the combined premium crosses its session-open VWAP against you">
                <Switch size="sm" checked={row.levelVw} onCheckedChange={c => onUpdate({ levelVw: !!c })} />
                VWAP exit
              </label>
              {row.levelVw && (
                <>
                  <Select value={row.vwapInterval || '1'} onValueChange={v => { if (v) onUpdate({ vwapInterval: v }); }}>
                    <SelectTrigger size="sm" className="h-7 w-16 text-xs bg-zinc-950/60 border-zinc-700" aria-label="VWAP candle interval"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1m</SelectItem>
                      <SelectItem value="5">5m</SelectItem>
                    </SelectContent>
                  </Select>
                  <RuleNumInput value={row.vwapBufferPct} onCommit={v => onUpdate({ vwapBufferPct: v })} title="Buffer %" className={cn(PRO_INPUT, 'w-14')} />
                  <span className="font-mono text-zinc-400">{live.vwap != null ? live.vwap.toFixed(2) : '—'}</span>
                </>
              )}
            </div>
          </div>

          {/* Re-entry: one summary line, expands to the full controls */}
          <Collapsible open={reOpen} onOpenChange={setReOpen}>
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-t border-zinc-800 bg-zinc-950/30">
              <CollapsibleTrigger render={
                <button type="button" className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800/60 cursor-pointer', FOCUS_RING)} />
              }>
                <ChevronDown className={cn('size-4 text-zinc-500 transition-transform', !reOpen && '-rotate-90')} />
                <span className={PRO_LABEL}>Re-entry</span>
                <span className="font-mono text-zinc-300">{reentrySummary(row)}</span>
              </CollapsibleTrigger>
              {/* Waiting re-entries stay visible (and cancellable) while collapsed. */}
              {!reOpen && <LegReentryPendingChips row={row} onCancelPending={onCancelPending} />}
            </div>
            <CollapsibleContent>
              <div className="px-3 pb-2.5 pt-1 bg-zinc-950/30">
                <LegReentryControls row={row} onUpdate={onUpdate} onCancelPending={onCancelPending} legTargetsElsewhere />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {/* ── Side panel: telemetry ── */}
        <aside className="flex flex-col gap-1.5 border-t xl:border-t-0 xl:border-l border-zinc-800 p-3 bg-zinc-950/20">
          <div className="flex items-center justify-between">
            <span className={PRO_LABEL}>Telemetry</span>
            <span className="font-mono text-[11px] text-zinc-500">spot {spot > 0 ? spot.toFixed(2) : '—'}</span>
          </div>
          <LtpStack combinedLtp={combinedLtp} live={live} ceValue={ceValue} peValue={peValue}
            totalValue={totalValue} pcr={pcr} pcrOi={pcrOi} compact />
        </aside>
      </div>
    </div>
  );
}
const FocusProRow = memo(FocusProRowImpl, rowDataPropsEqual);

/** Row views, exported for the layout preview (app/focus-tool/preview), which
 *  renders them with sample data and no-op order callbacks. Rendering these
 *  does NOT start the scheduler — only the default FocusTool does. */
export { FocusProRow, FocusTableRow, type FocusRowViewProps };

// ── Card view for a single row ────────────────────────────────────────────────

function FocusRowCardImpl({
  row, live, lotSize, spot, liveRealMoney, broker, busy,
  expiries, buildupWsActive, buildupExpiryHint,
  onUpdate, onDelete, onArm, onDisarm, onExit, onExitPartial, onAddLot, onReduceLot, onShift, onBlocked,
  onCancelPending,
}: {
  row: FocusRow;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  /** This row's underlying's available expiries, nearest first. */
  expiries: string[];
  buildupWsActive?: boolean;
  buildupExpiryHint?: string | null;
  onUpdate: (patch: Partial<FocusRow>) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onExitPartial: (leg: 'CE' | 'PE', pct: 25 | 50 | 75) => void;
  onAddLot: (leg: 'CE' | 'PE', lots: number) => void;
  onReduceLot: (leg: 'CE' | 'PE', lots: number) => void;
  onCancelPending: (leg: 'CE' | 'PE') => void;
  onShift: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  onBlocked: (message: string) => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const { ceValue, peValue, totalValue, pcr, pcrOi } = legValues(row, live, lotSize);
  const canTrade = (isSimRow(row) || liveRealMoney) && !busy && (live.ceStrike != null || live.peStrike != null) && (lotSize ?? 0) > 0;
  // Ownership, not raw broker qty: checked against this row's own fill ledger.
  const flat = rowFlat(row);
  const ceFlat = !rowOwnsLeg(row, 'CE');
  const peFlat = !rowOwnsLeg(row, 'PE');
  // Quick partial-exit chips, same lot-aware rounding as Scalper/AdvancedScalper.
  // Sized off THIS row's own contracts, not the broker net: a closed leg
  // re-resolves to the live strike, where the book may hold another row's
  // (or a manual) position — chips must not offer to close that.
  const ceChips = partialCloseChips(legOwnContracts(row, 'CE', live), lotSize ?? 0, [25, 50, 75]);
  const peChips = partialCloseChips(legOwnContracts(row, 'PE', live), lotSize ?? 0, [25, 50, 75]);
  // Why the leg buttons are greyed out.
  const tradeBlockedWhy = !isSimRow(row) && !liveRealMoney
    ? 'REAL row — turn on LIVE · REAL MONEY to place orders, or switch the row to SIM'
    : busy
      ? 'An order for this row is already in flight'
      : (lotSize ?? 0) <= 0
        ? 'Lot size for this index has not resolved yet'
        : 'Strike not resolved yet';
  const step = STRIKE_STEP[row.underlying];
  // How many lots the +/- buttons act on, independently per leg
  const [ceQty, setCeQty] = useState(1);
  const [peQty, setPeQty] = useState(1);
  const cePnl = computeLegPnl(row, 'CE', live);
  const pePnl = computeLegPnl(row, 'PE', live);
  // Expiry is locked once this row owns an active leg.
  const expiryLocked = rowOwnsLeg(row, 'CE') || rowOwnsLeg(row, 'PE');
  const onNearestExpiry = !row.expiry || row.expiry === expiries[0];

  return (
    <div className={cn(
      'rounded-2xl border transition-all duration-200 p-3 flex flex-col gap-2 shadow-md',
      !flat
        ? 'border-emerald-500/40 border-l-[4px] border-l-emerald-500 bg-gradient-to-b from-emerald-950/15 via-zinc-900/90 to-zinc-950/95 shadow-emerald-950/20'
        : row.status === 'armed'
          ? 'border-violet-500/30 border-l-[4px] border-l-violet-500 bg-gradient-to-b from-violet-950/10 via-zinc-900/90 to-zinc-950/95'
          : 'border-zinc-800/80 hover:border-zinc-700/80 bg-gradient-to-b from-zinc-900/80 to-zinc-950/90',
    )}>
      {/* ── Header Area ── */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-black border', UNDERLYING_CHIP[row.underlying])}>
            <span className={cn('h-2 w-2 rounded-full', UNDERLYING_DOT[row.underlying])} />
            {row.underlying}
          </span>
          <RowModeToggle row={row} flat={flat} liveRealMoney={liveRealMoney} onUpdate={onUpdate} />
          <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-md bg-zinc-800/80 text-zinc-300 border border-zinc-700/60 font-mono">
            {row.side}
          </span>
          <span className="text-[11px] font-bold text-zinc-400 font-mono">
            {row.lots} Lot{row.lots > 1 ? 's' : ''}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span title="Realised + unrealised P&L across the legs this row trades"
            className={cn('text-xs font-mono font-bold px-2 py-0.5 rounded-md border tabular-nums',
              live.pnl > 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : live.pnl < 0 ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700')}>
            {live.pnl > 0 ? '+' : ''}₹{live.pnl.toFixed(0)}
          </span>
          <span className={cn('text-[11px] font-black px-2 py-0.5 rounded-md border uppercase tracking-wider', STATUS_PILL[shownStatus(row, flat)])}>
            {shownStatus(row, flat)}
          </span>
          <button
            type="button"
            onClick={flat ? onDelete : undefined}
            disabled={!flat}
            title={flat ? 'Delete this row' : 'Position open — exit position first to delete row'}
            aria-label="Delete row"
            className={cn('h-6 w-6 rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40 font-bold flex items-center justify-center transition-colors', FOCUS_RING)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Timing, Expiry & DTE Bar ── */}
      <div className="bg-zinc-950/40 border border-zinc-800/50 rounded-xl p-2 flex flex-col gap-1.5">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center justify-between gap-1 bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-2 py-1">
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-wider flex items-center gap-1">
              <Clock className="h-2.5 w-2.5 text-zinc-500" /> ENTRY
            </span>
            <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: clampHm(v, UNDERLYING_META[row.underlying].entryMinHm, UNDERLYING_META[row.underlying].entryMaxHm) })} />
          </div>
          <div className="flex items-center justify-between gap-1 bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-2 py-1">
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-wider flex items-center gap-1">
              <Clock className="h-2.5 w-2.5 text-zinc-500" /> EXIT
            </span>
            <TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: clampHm(v, UNDERLYING_META[row.underlying].exitMinHm, UNDERLYING_META[row.underlying].exitMaxHm) })} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 items-center text-xs">
          <div className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-2 py-1">
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-wider flex items-center gap-1 shrink-0">
              <Calendar className="h-2.5 w-2.5 text-zinc-500" /> EXPY
            </span>
            <select
              value={row.expiry || expiries[0] || ''}
              disabled={expiryLocked || expiries.length === 0}
              onChange={e => onUpdate({ expiry: e.target.value })}
              title={expiryLocked
                ? 'Locked while a leg is open — exit it first, or use the shift chevrons to roll it'
                : 'Which listed expiry this row trades'}
              className="text-[11px] font-bold h-6 px-1.5 border border-zinc-700 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500 disabled:opacity-50 disabled:cursor-not-allowed w-full cursor-pointer"
            >
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div className="flex items-center justify-between gap-1 bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-2 py-1">
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-wider" title="Active only while trading the nearest expiry">DTE</span>
            <div className="flex gap-0.5">
              {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
                <button
                  key={d}
                  onClick={() => onUpdate({ dte: d })}
                  disabled={!onNearestExpiry}
                  title={!onNearestExpiry ? 'DTE only applies when trading the nearest expiry' : undefined}
                  className={cn(
                    'text-[11px] font-extrabold px-1.5 py-0.5 rounded cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                    row.dte === d ? 'bg-violet-600 text-oncolor' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200',
                    FOCUS_RING,
                  )}
                >{d}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Hero Metric & Strike Box ── */}
      <div className="bg-zinc-950/60 rounded-xl p-2.5 border border-zinc-800/60 flex flex-col gap-2 shadow-inner">
        {/* Top Row: Strike Pair + Combined Premium & VWAP */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-wider">Active Strikes</span>
            <div className="flex items-center gap-1.5 font-mono font-bold text-sm text-zinc-100 tabular-nums">
              <span className="text-emerald-400">{live.ceStrike ?? '—'} <span className="text-[11px] text-emerald-500/70 font-sans">CE</span></span>
              <span className="text-zinc-600 font-normal">/</span>
              <span className="text-rose-400">{live.peStrike ?? '—'} <span className="text-[11px] text-rose-500/70 font-sans">PE</span></span>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <div className="flex items-center gap-1">
              <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Prem</span>
              <span className="font-mono font-black text-base text-zinc-100 tabular-nums">
                {combinedLtp > 0 ? `₹${combinedLtp.toFixed(2)}` : '—'}
              </span>
            </div>
            <span className="text-[11px] font-mono font-semibold text-violet-400 tabular-nums">
              VWAP 1m {live.vwap1m != null ? live.vwap1m.toFixed(2) : '—'}
            </span>
          </div>
        </div>

        {/* Middle: Leg Value Cards (CE & PE) */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-emerald-950/20 border border-emerald-500/20 rounded-lg px-2 py-1.5 flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-emerald-400 uppercase tracking-wider">CE Prem</span>
              <span className="text-xs font-mono font-bold text-emerald-300 tabular-nums">
                {live.ltpCe != null ? `₹${live.ltpCe.toFixed(2)}` : '—'}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-bold text-zinc-500 uppercase">Val</span>
              <span className="text-[11px] font-mono font-semibold text-zinc-300 tabular-nums">
                ₹{fmtValue(ceValue)}
              </span>
            </div>
          </div>

          <div className="bg-rose-950/20 border border-rose-500/20 rounded-lg px-2 py-1.5 flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-rose-400 uppercase tracking-wider">PE Prem</span>
              <span className="text-xs font-mono font-bold text-rose-300 tabular-nums">
                {live.ltpPe != null ? `₹${live.ltpPe.toFixed(2)}` : '—'}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-bold text-zinc-500 uppercase">Val</span>
              <span className="text-[11px] font-mono font-semibold text-zinc-300 tabular-nums">
                ₹{fmtValue(peValue)}
              </span>
            </div>
          </div>
        </div>

        {/* Bottom Row: Total Value + PCR Strips */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800/60 pt-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            <span className="text-[10px] font-black text-zinc-500 uppercase">Total ₹</span>
            <span className="font-bold text-zinc-200 tabular-nums">₹{fmtValue(totalValue)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded text-[11px] font-mono"
              title="Val PCR = PE ₹ value ÷ CE ₹ value">
              <span className="font-black text-amber-500">VAL</span>
              <span className="font-bold text-amber-300 tabular-nums">{pcr != null ? pcr.toFixed(2) : '—'}</span>
            </span>
            <span className="inline-flex items-center gap-1 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded text-[11px] font-mono"
              title={live.peOi != null && live.ceOi != null
                ? `OI PCR = PE OI ÷ CE OI (${live.peOi.toLocaleString('en-IN')} / ${live.ceOi.toLocaleString('en-IN')})`
                : 'OI PCR = PE OI ÷ CE OI'}>
              <span className="font-black text-sky-400">OI</span>
              <span className="font-bold text-sky-300 tabular-nums">{pcrOi != null ? pcrOi.toFixed(2) : '—'}</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Strike Configurator (StrikeEditor) ── */}
      <div className="bg-zinc-950/40 border border-zinc-800/50 rounded-xl p-2.5">
        <StrikeEditor row={row} live={live} step={step} onUpdate={onUpdate} onShift={onShift} shiftDisabled={busy} onBlocked={onBlocked}
          buildupWsActive={buildupWsActive} buildupExpiryHint={buildupExpiryHint} />
      </div>

      {/* ── CE and PE Legs (Unified Compact Action Panel) ── */}
      <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-2 flex flex-col gap-1.5">
        {/* CE Leg Row */}
        <div className="flex items-center justify-between gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className="text-[11px] font-black px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">CE</span>
            <span className="text-xs font-mono font-bold text-zinc-100 tabular-nums shrink-0">
              {live.ltpCe != null ? `₹${live.ltpCe.toFixed(2)}` : '—'}
            </span>
            <LegOpenBadge pos={rowOwnsLeg(row, 'CE') ? live.cePosition : null} />
            {cePnl != null && (
              <span className={cn(
                'text-[11px] font-mono font-black px-1.5 py-0.5 rounded border tabular-nums',
                cePnl > 0 ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 shadow-sm'
                  : cePnl < 0 ? 'bg-rose-500/15 text-rose-400 border-rose-500/40 shadow-sm'
                  : 'bg-zinc-800 text-zinc-400 border-zinc-700'
              )} title="CE leg mark-to-market P&L">
                {cePnl > 0 ? '+' : ''}₹{cePnl.toFixed(0)}
              </span>
            )}
            <LegSlLevels row={row} live={live} leg="CE" lotSize={lotSize} inline />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <LegLotSelect value={ceQty} onChange={setCeQty} className="w-9 h-5 text-[11px]" title="Lots the CE +/- buttons act on" />
            <button onClick={() => onAddLot('CE', ceQty)} disabled={!canTrade} title={canTrade ? `Add ${ceQty} CE lot(s)` : tradeBlockedWhy} aria-label={`Add ${ceQty} CE lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 font-bold flex items-center justify-center hover:bg-emerald-600 hover:border-emerald-600 hover:text-oncolor transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>+</button>
            <button onClick={() => onReduceLot('CE', ceQty)} disabled={!canTrade || ceFlat} title={ceFlat ? 'Nothing open on the CE leg' : canTrade ? `Reduce CE by ${ceQty} lot(s)` : tradeBlockedWhy} aria-label={`Reduce CE by ${ceQty} lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 font-bold flex items-center justify-center hover:bg-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>-</button>
            <button onClick={() => onExit('CE')} disabled={!canTrade || ceFlat} title={ceFlat ? 'Nothing open on the CE leg' : canTrade ? 'Exit CE leg' : tradeBlockedWhy} className={cn('text-[11px] font-bold px-2 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>Exit</button>
          </div>
        </div>
        {!ceFlat && (
          <div className="flex items-center justify-end gap-1 font-mono text-[11px] pt-1 border-t border-zinc-800/40">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mr-1">Partial:</span>
            {ceChips.map(c => (
              <button key={c.pct} type="button" onClick={() => onExitPartial('CE', c.pct as 25 | 50 | 75)}
                disabled={!canTrade || !c.enabled} title={canTrade ? c.title : tradeBlockedWhy}
                className={cn('px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-800/50 text-rose-400 hover:bg-rose-800 hover:text-oncolor transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>
                {c.pct}%
              </button>
            ))}
          </div>
        )}

        <div className="h-px bg-zinc-800/50" />

        {/* PE Leg Row */}
        <div className="flex items-center justify-between gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className="text-[11px] font-black px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30 shrink-0">PE</span>
            <span className="text-xs font-mono font-bold text-zinc-100 tabular-nums shrink-0">
              {live.ltpPe != null ? `₹${live.ltpPe.toFixed(2)}` : '—'}
            </span>
            <LegOpenBadge pos={rowOwnsLeg(row, 'PE') ? live.pePosition : null} />
            {pePnl != null && (
              <span className={cn(
                'text-[11px] font-mono font-black px-1.5 py-0.5 rounded border tabular-nums',
                pePnl > 0 ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 shadow-sm'
                  : pePnl < 0 ? 'bg-rose-500/15 text-rose-400 border-rose-500/40 shadow-sm'
                  : 'bg-zinc-800 text-zinc-400 border-zinc-700'
              )} title="PE leg mark-to-market P&L">
                {pePnl > 0 ? '+' : ''}₹{pePnl.toFixed(0)}
              </span>
            )}
            <LegSlLevels row={row} live={live} leg="PE" lotSize={lotSize} inline />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <LegLotSelect value={peQty} onChange={setPeQty} className="w-9 h-5 text-[11px]" title="Lots the PE +/- buttons act on" />
            <button onClick={() => onAddLot('PE', peQty)} disabled={!canTrade} title={canTrade ? `Add ${peQty} PE lot(s)` : tradeBlockedWhy} aria-label={`Add ${peQty} PE lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 font-bold flex items-center justify-center hover:bg-rose-600 hover:border-rose-600 hover:text-oncolor transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>+</button>
            <button onClick={() => onReduceLot('PE', peQty)} disabled={!canTrade || peFlat} title={peFlat ? 'Nothing open on the PE leg' : canTrade ? `Reduce PE by ${peQty} lot(s)` : tradeBlockedWhy} aria-label={`Reduce PE by ${peQty} lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 font-bold flex items-center justify-center hover:bg-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>-</button>
            <button onClick={() => onExit('PE')} disabled={!canTrade || peFlat} title={peFlat ? 'Nothing open on the PE leg' : canTrade ? 'Exit PE leg' : tradeBlockedWhy} className={cn('text-[11px] font-bold px-2 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>Exit</button>
          </div>
        </div>
        {!peFlat && (
          <div className="flex items-center justify-end gap-1 font-mono text-[11px] pt-1 border-t border-zinc-800/40">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mr-1">Partial:</span>
            {peChips.map(c => (
              <button key={c.pct} type="button" onClick={() => onExitPartial('PE', c.pct as 25 | 50 | 75)}
                disabled={!canTrade || !c.enabled} title={canTrade ? c.title : tradeBlockedWhy}
                className={cn('px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-800/50 text-rose-400 hover:bg-rose-800 hover:text-oncolor transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer', FOCUS_RING)}>
                {c.pct}%
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Level Exits & Risk Rules ── */}
      <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-1">
          <span className="text-[11px] font-black text-zinc-400 uppercase tracking-wider flex items-center gap-1">
            <Shield className="h-3 w-3 text-violet-400" />
            Exit Rules &amp; Safeguards
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1', slRupees: '', slMultiplier: '', ceSlMultiplier: '1.2', peSlMultiplier: '1.2', slRollStrikes: 0, slToCost: false, slToCostScope: undefined, squareOff: undefined, reSlMode: 'off', reTgtMode: 'off', ceTgtPct: '', peTgtPct: '', noReEntryAfter: '', entryMomEnabled: false, entryMomValue: '', ceSimpleMom: undefined, peSimpleMom: undefined, ceRangeBreakout: undefined, peRangeBreakout: undefined, lazyLegs: undefined, reSlLazyId: undefined, reTgtLazyId: undefined, overallTarget: undefined, overallTrail: undefined, overallReSl: undefined, overallReTgt: undefined })}
              className={cn('text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer', FOCUS_RING)}
            >
              Clear
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
          <div className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800/40 rounded-lg px-1.5 py-0.5">
            <span className="text-rose-400 text-[11px] font-black w-9 shrink-0">H&uarr;</span>
            <RuleNumStepper
              value={row.levelHigh}
              onCommit={v => onUpdate({ levelHigh: v })}
              wrapperClassName="w-full flex-1 flex items-center gap-0.5"
              className="w-full flex-1 min-w-0 h-5 text-center text-[11px]"
            />
          </div>
          <div className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800/40 rounded-lg px-1.5 py-0.5">
            <span className="text-emerald-400 text-[11px] font-black w-9 shrink-0">L&darr;</span>
            <RuleNumStepper
              value={row.levelLow}
              onCommit={v => onUpdate({ levelLow: v })}
              wrapperClassName="w-full flex-1 flex items-center gap-0.5"
              className="w-full flex-1 min-w-0 h-5 text-center text-[11px]"
            />
          </div>
          <div className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800/40 rounded-lg px-1.5 py-0.5">
            <span className="text-amber-400 text-[11px] font-black w-9 shrink-0">SL ₹</span>
            <RuleNumInput value={row.slRupees} onCommit={v => onUpdate({ slRupees: v })} className="w-full flex-1 min-w-0 h-5 text-center text-[11px]" />
          </div>
          <div className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800/40 rounded-lg px-1.5 py-0.5">
            <span className="text-amber-500 text-[11px] font-black w-9 shrink-0">SL &times;</span>
            <RuleNumInput value={row.slMultiplier} onCommit={v => onUpdate({ slMultiplier: v })} className="w-full flex-1 min-w-0 h-5 text-center text-[11px]" />
          </div>
          <div className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800/40 rounded-lg px-1.5 py-0.5">
            <span className="text-emerald-400 text-[11px] font-black w-9 shrink-0" title="Exit CE alone on its own premium multiple, independent of PE and of SL × above">CE &times;</span>
            <RuleNumInput value={row.ceSlMultiplier ?? '1.2'} onCommit={v => onUpdate({ ceSlMultiplier: v })}
              title={legSlOverridden(row, 'CE') ? `CE uses its ${legSlOverridden(row, 'CE')}; this × is the fallback when that cannot be measured (no delta / spot at entry)` : undefined} className="w-full flex-1 min-w-0 h-5 text-center text-[11px]" />
          </div>
          <div className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800/40 rounded-lg px-1.5 py-0.5">
            <span className="text-rose-400 text-[11px] font-black w-9 shrink-0" title="Exit PE alone on its own premium multiple, independent of CE and of SL × above">PE &times;</span>
            <RuleNumInput value={row.peSlMultiplier ?? '1.2'} onCommit={v => onUpdate({ peSlMultiplier: v })}
              title={legSlOverridden(row, 'PE') ? `PE uses its ${legSlOverridden(row, 'PE')}; this × is the fallback when that cannot be measured (no delta / spot at entry)` : undefined} className="w-full flex-1 min-w-0 h-5 text-center text-[11px]" />
          </div>
        </div>

        <div className="border-t border-zinc-800/50 pt-1">
          <LegReentryControls row={row} onUpdate={onUpdate} onCancelPending={onCancelPending} />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/50 pt-1">
          <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VWAP Exit"
            title="Exit when the combined premium crosses its session-open VWAP against you" />
          {row.levelVw && (
            <div className="flex items-center gap-1.5">
              <select
                value={row.vwapInterval || '1'}
                title="Candle interval the session-open VWAP is computed from"
                onChange={e => onUpdate({ vwapInterval: e.target.value })}
                className="text-[11px] font-bold h-5 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500"
              >
                <option value="1">1m</option>
                <option value="5">5m</option>
              </select>
              <div className="flex items-center gap-0.5">
                <span className="text-[10px] font-black text-zinc-500">buf%</span>
                <RuleNumInput value={row.vwapBufferPct} onCommit={v => onUpdate({ vwapBufferPct: v })} className="w-9 h-5 text-center text-[11px]"
                  title="Require the closed candle to clear VWAP by more than this % before exiting — blank means no buffer" />
              </div>
              <span className="text-[11px] font-mono font-bold text-zinc-400">
                {live.vwap != null ? `VWAP ${live.vwap.toFixed(2)}` : 'VWAP —'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Row Control Actions Footer ── */}
      <div className="flex items-center justify-between gap-2 border-t border-zinc-800/80 pt-2.5 mt-auto">
        <div className="flex items-center gap-1.5">
          {(shownStatus(row, flat) === 'draft' || shownStatus(row, flat) === 'exited') && (
            <button onClick={onArm} className={cn('flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 shadow-md shadow-violet-600/20 transition-all cursor-pointer', FOCUS_RING)}>
              <Zap className="h-3 w-3" />
              Arm Row
            </button>
          )}
          {row.status === 'armed' && (
            <button onClick={onDisarm} className={cn('flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-all cursor-pointer', FOCUS_RING)}>
              <ShieldOff className="h-3 w-3" />
              Disarm
            </button>
          )}
          {shownStatus(row, flat) === 'entered' && (
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Position Open
            </span>
          )}
        </div>
        <button onClick={() => onExit('ALL')} disabled={flat || !canTrade}
          title={flat ? 'Nothing open on this row' : 'Close every open leg of this row at market'}
          className={cn('flex items-center gap-1 text-xs font-extrabold px-3.5 py-1.5 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-rose-600/20 transition-all cursor-pointer', FOCUS_RING)}>
          <ShieldOff className="h-3 w-3" />
          Exit All
        </button>
      </div>
    </div>
  );
}
const FocusRowCard = memo(FocusRowCardImpl, rowDataPropsEqual);

// ── Side Drawer Modal ────────────────────────────────────────────────────────

export function FocusModal({
  isOpen,
  onClose,
  title,
  children,
  variant = 'drawer',
  wide = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** 'center' only: use almost the whole viewport (for wide grids such as the P&L-by-date table). */
  wide?: boolean;
  /** 'drawer' (default): right-side sliding panel, for compact detail views.
   *  'center': full-width centered dialog, for data-table-heavy content like
   *  the order/trade book that needs every column visible without scrolling. */
  variant?: 'drawer' | 'center';
}) {
  if (!isOpen) return null;
  if (variant === 'center') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-oncolor-dark/70 backdrop-blur-sm transition-opacity">
        <div className={cn('w-full max-h-[90vh] bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4 shadow-2xl text-white overflow-hidden', wide ? 'max-w-[96vw] h-[90vh]' : 'max-w-6xl')}>
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-100">{title}</h2>
            <button
              onClick={onClose}
              title="Close"
              aria-label="Close"
              className={cn('text-zinc-400 hover:text-white text-lg font-bold p-1 cursor-pointer rounded', FOCUS_RING)}
            >
              &times;
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {children}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-oncolor-dark/70 backdrop-blur-sm transition-opacity">
      <div className="h-full w-full max-w-xl bg-zinc-900 border-l border-zinc-800 p-6 flex flex-col gap-4 shadow-2xl text-white overflow-y-auto">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className={cn('text-zinc-400 hover:text-white text-lg font-bold p-1 cursor-pointer rounded', FOCUS_RING)}
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function FocusTool() {
  const { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker, authChecked } = useBrokerSelector();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const copyTrade = useCopyTrade(addToast);

  const [config, setConfig] = useState<FocusToolConfig>(DEFAULT_CONFIG);
  // Saves fire from many independent places — Arm/Disarm, leg Exit buttons,
  // the auto-entry/auto-exit scheduler, strike shifts, Save Preferences — with
  // no coordination between them. Chaining every save onto this promise makes
  // each one wait for the previous one to actually land before it fires, so
  // two saves close together apply in order instead of racing each other.
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const [positions, setPositions] = useState<PosRow[]>([]);
  // availabelBalance is a genuine Dhan API misspelling, kept verbatim here (and
  // by the Zerodha/Kotak funds routes reshaping onto the same key) rather than
  // renamed, so this stays a drop-in match for /api/scalper[/<broker>]/funds's
  // actual response shape — see Scalper.tsx's FundsView for the shared origin.
  const [fundsData, setFundsData] = useState<{ availabelBalance?: number; utilizedAmount?: number } | null>(null);
  // Session-open VWAP + last-closed-candle combined premium per strike pair
  // (see vwapKey) — only fetched for rows that actually enabled VW, refreshed
  // once a minute via /api/focus-tool/vwap. `close` is what the exit rule
  // actually compares against `vwap` (see evaluateRowExit) — a live tick
  // spike can't fire the exit on its own.
  const [rowVwap, setRowVwap] = useState<Record<string, { vwap: number | null; close: number | null }>>({});
  const { realised, unrealised, total } = useMemo(() => {
    let r = 0, u = 0;
    for (const p of positions) { r += Number(p.realizedProfit) || 0; u += Number(p.unrealizedProfit) || 0; }
    return { realised: r, unrealised: u, total: r + u };
  }, [positions]);
  // Indices in use: NIFTY always, the others once they have a row or a started group.
  // Everything fetched per index (expiries, lookups, futures, the live bridge) is
  // limited to these — BANKNIFTY / SENSEX cost nothing until you open a row for them.
  const watchedKey = UNDERLYINGS.filter(u => u === 'NIFTY'
    || config.rows.some(r => r.underlying === u)
    || config.groups.some(g => g.underlying === u && g.enabled)).join(',');
  const watched = useMemo(() => watchedKey.split(',') as FocusUnderlying[], [watchedKey]);
  const { futQuotes, spotPrices, lotSizes, expiries, lookups, chains } = useFocusMarketData({
    broker, watched, watchedKey, rows: config.rows, groups: config.groups,
  });
  // For handlers that run outside a render (the fill-ledger writer stamps the
  // entry delta from it).
  const chainsRef = useRef(chains);
  chainsRef.current = chains;
  // Rows with an order in flight — their leg buttons are disabled so a
  // double-click cannot send the same market order twice.
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  // Global Exit All — click-to-arm/click-to-confirm, same pattern as
  // AdvancedScalper/Scalper's own Exit All button.
  const [confirmExitAll, setConfirmExitAll] = useState(false);
  const [exitingAll, setExitingAll] = useState(false);
  // Rows an auto-exit is currently closing — a ref, not state, because the
  // watcher effect below must read the latest value synchronously on every
  // tick without itself being a dependency that re-triggers the effect.
  const autoExitingRef = useRef<Set<string>>(new Set());
  // Same as autoExitingRef, but keyed `${rowId}:${leg}` for the leg-wise SL x
  // — a leg exit must not be deduped by row id alone, or a CE breach on a row
  // could suppress an independent PE breach on the same row.
  const autoExitingLegRef = useRef<Set<string>>(new Set());
  // Auto leg exits (and their SL rolls) in flight per row. The two legs are
  // independent contracts, so a PE stop must not wait behind the CE's close +
  // roll (easily 10s) — they may run together, and the row's busy lock is only
  // released when the LAST of them finishes.
  const legExitsInFlightRef = useRef<Map<string, number>>(new Map());
  // A whole-row exit that fired while the row was busy (ms timestamp). Blocks
  // an SL roll from re-selling into a row the rules are about to flatten.
  const rowExitWantedRef = useRef<Map<string, number>>(new Map());
  // Waiting re-entries whose order is being placed right now (row:leg).
  const pendingFiringRef = useRef<Set<string>>(new Set());
  // Orders sent but not confirmed filled in full, keyed row:leg — see
  // UnconfirmedOrder / reconcileUnconfirmedOrder.
  const unconfirmedOrderRef = useRef<Map<string, UnconfirmedOrder>>(new Map());
  // Only one tab runs the automatic rules (scheduler, stops, targets,
  // re-entries) — a second tab is a second execution engine. Manual buttons
  // and settling this tab's own unconfirmed orders run in every tab.
  const { isLeader, leaderRef } = useTabLeader('focus-tool');
  // Rows the scheduler has already auto-entered. Same reasoning, plus: the
  // entry window stays open for the rest of the session, so without this a
  // row would re-enter on every 5s tick.
  const autoEnteringRef = useRef<Set<string>>(new Set());
  // Overall Momentum: each row's start premium and the strikes picked at the
  // entry time, stamped with its day (in memory — a reload re-captures it).
  // `min` / `last` / `close` build the 1-minute candle close of the combined
  // premium of THOSE strikes for the Candle Close evaluation.
  const entryMomRef = useRef<Record<string, {
    day: string; ref: number | null; ce: number | null; pe: number | null;
    min?: string; last?: number | null; close?: number | null;
  }>>({});
  const [entryMomStatus, setEntryMomStatus] = useState<Record<string, string>>({});
  // Simple Momentum, per `rowId:leg`: the strike picked and the start price (premium or spot)
  // seen at the entry time. start 0 = this leg has no momentum and enters at once.
  // `failed` = the order was rejected: never resent on its own.
  const simMomRef = useRef<Record<string, {
    day: string; kind: 'range' | 'momentum' | 'now'; strike: number; start: number; failed?: boolean;
    range?: { high: number; low: number }; rangeSince?: number; rangeNextTry?: number; rangeFetching?: boolean; rangeFailed?: boolean;
    /** Strike being rebuilt from the index's open at the range start (the tab was not open then). */
    strikeFetching?: boolean; strikeNextTry?: number; strikeSince?: number;
  }>>({});
  const simMomFiringRef = useRef<Set<string>>(new Set());
  const pendingRangeFetchRef = useRef<Record<string, { since: number; nextTry: number; fetching: boolean }>>({});
  const overallPeakRef = useRef<Record<string, { pnl?: number; pts?: number; wrote: number }>>({});
  const [peakMtm, setPeakMtm] = useState(0);
  const [lockMtm, setLockMtm] = useState<number | null>(null);
  /**
   * The AUTHORITATIVE trailing floor.
   *
   * A ref, not state: the tick-driven watcher ratchets it on every quote, and
   * routing that through setState would re-render the whole terminal on each
   * tick just to carry a number that changes a handful of times a session. The
   * `lockMtm` state is a display mirror, refreshed once a second by the clock
   * scheduler. Never read the state here — it lags by up to a second, and the
   * floor must only ever rise.
   */
  const lockFloorRef = useRef<number | null>(null);

  const [activeModal, setActiveModal] = useState<'risk' | 'orderbook' | 'optionchain' | 'greeks' | null>(null);
  // Remembered per browser: a display preference only, never trading state.
  const [viewMode, setViewModeState] = useState<FocusViewMode>('table');
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of a stored display preference
      if (v === 'pro' || v === 'table' || v === 'cards') setViewModeState(v);
    } catch { /* storage blocked — keep the default */ }
  }, []);
  const setViewMode = useCallback((v: FocusViewMode) => {
    setViewModeState(v);
    try { localStorage.setItem(VIEW_MODE_KEY, v); } catch { /* storage blocked */ }
  }, []);
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderSort, setOrderSort] = useState<SortState>({ key: 'createTime', dir: 'desc' });
  const [ordersTab, setOrdersTab] = useState<'orders' | 'trades' | 'positions'>('orders');
  const [trades, setTrades] = useState<Record<string, unknown>[]>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [tradeSort, setTradeSort] = useState<SortState>({ key: 'createTime', dir: 'desc' });
  const [positionSort, setPositionSort] = useState<SortState>({ key: 'unrealizedProfit', dir: 'desc' });

  const [riskEnabled, setRiskEnabled] = useState(config.riskEnabled);
  const [targetRupees, setTargetRupees] = useState(config.targetRupees);
  const [stopRupees, setStopRupees] = useState(config.stopRupees);
  const [trailEnabled, setTrailEnabled] = useState(config.trailEnabled);
  const [triggerRupees, setTriggerRupees] = useState(config.triggerRupees);
  const [lockRupees, setLockRupees] = useState(config.lockRupees);
  // AlgoTest broker-level trailing kind and its "every / by" amounts.
  const [trailX, setTrailX] = useState<TrailX>({ kind: config.trailKind ?? 'peakGap', every: config.trailEvery ?? '', by: config.trailBy ?? '' });
  const [liveRealMoney, setLiveRealMoney] = useState(config.liveRealMoney);

  // ── In-Tab Execution Engine ──────────────────────────────────────
  // Rules (scheduled entries, stop losses, profit targets, level exits)
  // execute directly within the browser session. The loops always run: a SIM
  // row trades on paper at any time, a REAL row only while LIVE · REAL MONEY
  // is armed for today. Per row, not per page — see rowMayTrade.
  const rowMayTrade = (row: Pick<FocusRow, 'mode'>, live: boolean) => isSimRow(row) || live;

  // Standalone bridge (scripts/tools/focus_tool_ws.py) — all three underlyings
  // over one WebSocket connection, independent of AdvancedScalper's
  // one-broker-one-underlying bridge. See useFocusToolWS's own doc comment.
  const { quotes: rawWsQuotes, bridgeStatus: focusWsStatus } = useFocusToolWS();
  // The last accepted WS frame stays in state when the feed stalls, so a frozen
  // price looked identical to a live one. During market hours, frames older than
  // WS_STALE_MS are dropped here: every consumer then falls back to the REST chain
  // (and the banner below says so). Checked on a 1s timer that only re-renders when
  // the flag flips, never per tick.
  const rawWsQuotesRef = useRef(rawWsQuotes);
  rawWsQuotesRef.current = rawWsQuotes;
  const [wsStale, setWsStale] = useState(false);
  useEffect(() => {
    const check = () => {
      const hm = istHm();
      const at = Date.parse(rawWsQuotesRef.current?.updated_at ?? '');
      const stale = hm >= '09:16' && hm < '15:30' && Number.isFinite(at) && Date.now() - at > WS_STALE_MS;
      setWsStale(prev => (prev === stale ? prev : stale));
    };
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, []);
  const focusWsQuotes = wsStale ? null : rawWsQuotes;

  const wsLive = focusWsStatus.status === 'RUNNING';

  // Start (or restart onto new expiries) once each underlying's listed
  // nearest is known. Subscribe to the union of nearest + every row's chosen
  // expiry (comma-separated) so a Sept monthly row still gets WS LTP/OI —
  // not nearest-only. Never stopped on unmount — same long-lived convention
  // as AdvancedScalper, so returning reconnects instantly.
  const niftyBridgeExpiry = bridgeExpiriesForUnderlying('NIFTY', config.rows, expiries.NIFTY ?? []);
  // '' = not watched: the bridge then does not subscribe that index at all.
  const bankniftyBridgeExpiry = watched.includes('BANKNIFTY') ? bridgeExpiriesForUnderlying('BANKNIFTY', config.rows, expiries.BANKNIFTY ?? []) : '';
  const sensexBridgeExpiry = watched.includes('SENSEX') ? bridgeExpiriesForUnderlying('SENSEX', config.rows, expiries.SENSEX ?? []) : '';
  // A watched index must have its expiry before the bridge starts, or it would start
  // without it and be restarted a moment later.
  const bridgeReady = !!niftyBridgeExpiry
    && (!watched.includes('BANKNIFTY') || !!bankniftyBridgeExpiry)
    && (!watched.includes('SENSEX') || !!sensexBridgeExpiry);
  useEffect(() => {
    if (!bridgeReady) return;
    fetch('/api/focus-tool/live-ws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        expiries: {
          NIFTY: niftyBridgeExpiry,
          BANKNIFTY: bankniftyBridgeExpiry,
          SENSEX: sensexBridgeExpiry,
        },
      }),
    }).catch(() => {});
  }, [bridgeReady, niftyBridgeExpiry, bankniftyBridgeExpiry, sensexBridgeExpiry]);

  // Self-heal: the effect above fires only when an expiry changes, so a bridge
  // that dies mid-session (a dashboard restart's PID sweep, a crash) is never
  // brought back and every premium silently falls back to the slower REST
  // chain. While it reads down, re-POST start every 15s — the route is
  // idempotent (start lock + "already running" check), so this is safe.
  const bridgeDown = ['STOPPED', 'STALE', 'ERROR'].includes(focusWsStatus.status);
  useEffect(() => {
    if (!bridgeDown || !bridgeReady) return;
    const restart = () => {
      fetch('/api/focus-tool/live-ws', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          expiries: {
            NIFTY: niftyBridgeExpiry,
            BANKNIFTY: bankniftyBridgeExpiry,
            SENSEX: sensexBridgeExpiry,
          },
        }),
      }).catch(() => {});
    };
    const t = setInterval(restart, 15_000);
    return () => clearInterval(t);
  }, [bridgeDown, bridgeReady, niftyBridgeExpiry, bankniftyBridgeExpiry, sensexBridgeExpiry]);

  /** Adopt a server-authoritative config: state plus the risk-bar mirrors. */
  // Last saved rev + content per row — see doSaveConfig and lib/revMerge.ts.
  const rowRevBookRef = useRef<RevBook>(new Map());
  // Saves queued or sent and not yet answered. The periodic re-read below only
  // runs while this is 0, when the server copy already holds every local change.
  const savesInFlightRef = useRef(0);
  // Bumped by every save. The re-read checks it did not move between sending
  // the GET and applying it: a save that starts AND lands during the GET
  // leaves the in-flight count at 0 but makes the response stale.
  const saveGenRef = useRef(0);
  // Outside trades already used to price a flat leg's close (outsideCloseExit),
  // so two rows on one strike can't both book the same trade.
  const usedOutsideTradeKeysRef = useRef<Set<string>>(new Set());
  const applyServerConfig = useCallback((d: FocusToolConfig, sentRows?: FocusRow[], stillFresh?: () => boolean) => {
    // After a save, take the server's copy only of rows this tab hasn't
    // changed since sending — a change made while the save was in flight goes
    // out with its own save and must not be reverted here.
    if (sentRows) setConfig(prev => ({ ...d, rows: adoptItems(prev.rows, sentRows, d.rows) }));
    else if (stillFresh) {
      // A periodic re-read: checked again inside the updater, after any local
      // edit queued in the same render has run (and saved).
      setConfig(prev => {
        if (!stillFresh()) return prev;
        noteItems(rowRevBookRef.current, 'r:', d.rows);
        return d;
      });
      if (!stillFresh()) return;
    } else setConfig(d);
    setRiskEnabled(d.riskEnabled);
    setTargetRupees(d.targetRupees);
    setStopRupees(d.stopRupees);
    setTrailEnabled(d.trailEnabled);
    setTriggerRupees(d.triggerRupees);
    setLockRupees(d.lockRupees);
    setTrailX({ kind: d.trailKind ?? 'peakGap', every: d.trailEvery ?? '', by: d.trailBy ?? '' });
    // The live arm expires with the session — see FocusToolConfig.liveArmedOn.
    // A config saved live yesterday comes back disarmed, so opening the page in
    // the morning never resumes trading a setup nobody has looked at today.
    setLiveRealMoney(!!d.liveRealMoney && d.liveArmedOn === istToday());
  }, []);

  useEffect(() => {
    fetch('/api/focus-tool/rows')
      .then(r => r.json())
      .then((j: { success: boolean; data?: FocusToolConfig }) => {
        if (j.success && j.data) {
          noteItems(rowRevBookRef.current, 'r:', j.data.rows);
          applyServerConfig(j.data);
        }
      })
      .catch(() => {});
  }, [applyServerConfig]);

  // Re-read the saved config every few seconds so this tab sees what another
  // tab saved — a leader that never saw a leg the other tab opened would not
  // watch its stop. Skipped while this tab has saves in flight.
  useEffect(() => {
    let cancelled = false;
    const t = setInterval(() => {
      if (savesInFlightRef.current !== 0) return;
      const gen = saveGenRef.current;
      const fresh = () => savesInFlightRef.current === 0 && saveGenRef.current === gen;
      fetch('/api/focus-tool/rows')
        .then(r => r.json())
        .then((j: { success: boolean; data?: FocusToolConfig }) => {
          if (cancelled || !j.success || !j.data || !fresh()) return;
          if (canon(j.data) === canon(schedulerRef.current.config)) return;
          applyServerConfig(j.data, undefined, fresh);
        })
        .catch(() => {});
    }, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [applyServerConfig]);


  /** Fetch the broker's position book once and return it, also refreshing
   *  state. Returns null if the call failed — callers that gate a real-money
   *  decision on this must treat null as "unknown", never as "flat". */
  const fetchPositionsNow = useCallback(async (): Promise<PosRow[] | null> => {
    try {
      const res = await fetch(scalperRoute(broker, 'poll'));
      const j = await res.json() as { success: boolean; positions?: PosRow[] };
      if (!j.success || !j.positions) return null;
      const rows = j.positions
        .filter(p => {
          const seg = String(p.exchangeSegment ?? '').toUpperCase();
          // MCX_COMM is admitted only for Dhan, the one broker whose MCX quantity
          // convention (lots) this page converts — see focusToolUnderlyings.
          if (seg.includes('FNO') || seg.includes('FO')) return true;
          // Only CRUDEOILM rows: other MCX contracts (CRUDEOIL x100, gas, gold...) have no unit
          // conversion here and would corrupt the header P&L if admitted.
          return broker === 'dhan' && seg === 'MCX_COMM' && underlyingOfSymbol(String(p.tradingSymbol ?? '')) === 'CRUDEOILM';
        })
        // MCX: Dhan reports quantity and P&L per LOT; rescale P&L, then express quantity in
        // barrels so the page's premium × quantity maths is right with no further care.
        // A no-op for NSE/BSE F&O.
        .map(p => {
          const scaled = scaleBrokerPnl(p as any) as PosRow;
          const u = underlyingOfSymbol(String(scaled.tradingSymbol ?? ''));
          if (!u || !isMcxUnderlying(u)) return scaled;
          return {
            ...scaled,
            netQty: toInternalQty(u, Number(scaled.netQty) || 0),
            buyQty: toInternalQty(u, Number((scaled as any).buyQty) || 0),
            sellQty: toInternalQty(u, Number((scaled as any).sellQty) || 0),
          } as PosRow;
        });
      setPositions(rows);
      return rows;
    } catch {
      return null;
    }
  }, [broker]);

  const pollPositions = useCallback(() => { void fetchPositionsNow(); }, [fetchPositionsNow]);

  // Margin available/utilized for the header tiles. Zerodha's funds route
  // only returns availabelBalance (no utilized/collateral breakdown), so
  // utilizedAmount stays undefined there and the tile shows — rather than a
  // fabricated number.
  const pollFunds = useCallback(() => {
    fetch(scalperRoute(broker, 'funds'))
      .then(r => r.json())
      .then((j: { success?: boolean; data?: { availabelBalance?: number; utilizedAmount?: number } }) => {
        if (j.success && j.data) setFundsData(j.data);
      })
      .catch(() => {});
  }, [broker]);

  useEffect(() => {
    pollFunds();
    const t = setInterval(pollFunds, 15000);
    return () => clearInterval(t);
  }, [pollFunds]);

  const fetchOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const res = await fetch(scalperRoute(broker, 'orders'));
      const j = await res.json();
      if (j.success && j.data) {
        setOrders(j.data);
      } else {
        setOrdersError(j.error ?? 'Failed to fetch orders');
      }
    } catch (e) {
      setOrdersError(String(e));
    } finally {
      setOrdersLoading(false);
    }
  }, [broker]);

  const fetchTrades = useCallback(async () => {
    setTradesLoading(true);
    setTradesError(null);
    try {
      const res = await fetch(scalperRoute(broker, 'trades'));
      const j = await res.json();
      if (j.success && j.data) {
        setTrades(j.data);
      } else {
        setTradesError(j.error ?? 'Failed to fetch trades');
      }
    } catch (e) {
      setTradesError(String(e));
    } finally {
      setTradesLoading(false);
    }
  }, [broker]);

  useEffect(() => {
    if (activeModal === 'orderbook') {
      fetchOrders();
      fetchTrades();
    }
  }, [activeModal, fetchOrders, fetchTrades]);


  // The trailing floor is OWNED by the scheduler's evaluateGlobalRisk, which
  // ratchets it forward between ticks (a floor recomputed from scratch each
  // render could fall, which is the one thing a trailing lock must never do).
  // This effect only RESETS it: turning the trail off, or changing its trigger
  // or gap, invalidates a floor derived from the old settings.
  useEffect(() => {
    lockFloorRef.current = null;
    setLockMtm(null);
  }, [trailEnabled, triggerRupees, lockRupees, trailX]);

  const underlyingPnl = useMemo(() => {
    const out: Record<FocusUnderlying, number> = { NIFTY: 0, BANKNIFTY: 0, SENSEX: 0, CRUDEOILM: 0 };
    for (const pos of positions) {
      const pnl = (Number(pos.realizedProfit) || 0) + (Number(pos.unrealizedProfit) || 0);
      const u = underlyingOfSymbol(pos.tradingSymbol);
      if (u) out[u] += pnl;
    }
    return out;
  }, [positions]);

  useEffect(() => {
    pollPositions();
    const t = setInterval(pollPositions, 2000);
    return () => clearInterval(t);
  }, [pollPositions]);

  // Spot per underlying: the WS bridge first (push-driven, all three
  // underlyings), then the top-indices poll (NIFTY/BANKNIFTY), then the
  // chain's own last_price (SENSEX, which the top-indices endpoint doesn't
  // serve) as the last-resort fallback.
  const spots = useMemo<Record<FocusUnderlying, number>>(() => {
    const out = { ...spotPrices };
    for (const u of UNDERLYINGS) {
      const wsSpot = focusWsQuotes?.[u]?.spot;
      if (wsSpot && wsSpot > 0) { out[u] = wsSpot; continue; }
      if (!(out[u] > 0)) out[u] = Number(chains[expKey(u, expiries[u]?.[0] ?? '')]?.spot ?? 0);
    }
    return out;
  }, [spotPrices, chains, focusWsQuotes, expiries]);

  // Futures quotes: prefer realtime WebSocket updates from the Focus Tool bridge,
  // falling back to the 3s REST poll while WS is connecting/down.
  const effectiveFutQuotes = useMemo<Record<FocusUnderlying, FutQuote | null>>(() => {
    const out = { ...futQuotes };
    for (const u of UNDERLYINGS) {
      const wsFut = focusWsQuotes?.[u]?.fut;
      if (wsFut && wsFut.ltp > 0) {
        out[u] = { ltp: wsFut.ltp, change_pct: wsFut.change_pct ?? null };
      }
    }
    return out;
  }, [futQuotes, focusWsQuotes]);

  /**
   * Per-row CE/PE strikes, premiums and live broker positions, keyed by row id.
   *
   * CE and PE resolve independently: ATM mode is `atm + offset * step` per leg
   * (no guard keeping CE >= PE — an inverted strangle is a valid, user-chosen
   * shape once the legs are independent); PREMIUM mode is the chain strike
   * closest to the leg's target rupee value. Recomputed continuously (not
   * stamped once at row creation) so the table always shows what a draft or
   * armed row would trade right now — but ONLY until the row opens. An open
   * row switches to the strikes it actually filled at (its own fill ledger, or
   * the worker's when the worker holds it); re-resolving a live position off a
   * moving ATM is how the page used to lose track of it entirely. See
   * FocusRowFill.
   *
   * Premium: the NIFTY tick bridge first when it is on this row's expiry —
   * it is realtime, where the chain route caches 10s — then the chain.
   *
   * The WS bridge multiplexes all three underlyings into one combined
   * payload and re-parses it fresh on every message (see useFocusToolWS),
   * so `focusWsQuotes` — and therefore every field this memo reads off it —
   * gets a brand new object reference on every tick even for underlyings
   * whose numbers didn't move. Recomputing here is unavoidable, but hand
   * back the SAME `RowLive` object as last time when a row's own computed
   * values are unchanged, so a tick that only moves one row doesn't hand
   * every other row's memoized component a new prop reference and force it
   * to re-render too (see the FocusTableRow/FocusRowCard memo comparators).
   */
  const rowLivePrevRef = useRef<Record<string, RowLive>>({});
  // Same object back for an unchanged paper leg, so rowLiveEqual's identity
  // check on cePosition/pePosition holds for sim rows exactly as it does for
  // broker rows (whose objects only change on a positions poll).
  const simPosCacheRef = useRef<Record<string, { qty: number; entry: number; pos: PosRow | null }>>({});
  const simPositionFor = (rowId: string, leg: 'CE' | 'PE', qty: number, entry: number | null | undefined) => {
    const key = `${rowId}:${leg}`;
    const e = Number(entry) || 0;
    const hit = simPosCacheRef.current[key];
    if (hit && hit.qty === qty && hit.entry === e) return hit.pos;
    const pos = simLegPosition(leg, qty, e);
    simPosCacheRef.current[key] = { qty, entry: e, pos };
    return pos;
  };
  const rowLiveEqual = (a: RowLive, b: RowLive) =>
    a.ceStrike === b.ceStrike && a.peStrike === b.peStrike
    && a.ltpCe === b.ltpCe && a.ltpPe === b.ltpPe
    && a.cePosition === b.cePosition && a.pePosition === b.pePosition
    && a.pnl === b.pnl && a.entryPremium === b.entryPremium && a.lotSize === b.lotSize
    && a.vwap === b.vwap && a.vwapClose === b.vwapClose
    && a.ceBuildup === b.ceBuildup && a.peBuildup === b.peBuildup
    && a.ceOiChgPct === b.ceOiChgPct && a.peOiChgPct === b.peOiChgPct
    && a.ceOi === b.ceOi && a.peOi === b.peOi
    && a.vwap1m === b.vwap1m && a.vwapClose1m === b.vwapClose1m
    && a.ceDelta === b.ceDelta && a.peDelta === b.peDelta
    && a.ceDeltaDhan === b.ceDeltaDhan && a.peDeltaDhan === b.peDeltaDhan;
  const rowLive = useMemo<Record<string, RowLive>>(() => {
    const out: Record<string, RowLive> = {};
    const prevOut = rowLivePrevRef.current;
    for (const row of config.rows) {
      const u = row.underlying;
      // The expiry THIS row trades — its own pick, or nearest until it picks
      // one. Everything below (chain/lookup lookups, WS-tick gating) must key
      // off this, not the underlying's nearest, now that a row can pick any
      // listed expiry.
      const rowExpiry = row.expiry || expiries[u]?.[0] || '';
      const step = STRIKE_STEP[u];
      const spot = spots[u] ?? 0;
      // ATM base per the index group's own "ATM BY" pick — Spot (the index
      // level) or Fut (the nearest futures contract's LTP, which can sit at a
      // premium/discount to spot). Falls back to spot if the futures strip
      // hasn't resolved yet, so a row is never left unresolved by a slow feed.
      const group = config.groups.find(g => g.underlying === u);
      const futLtp = effectiveFutQuotes[u]?.ltp ?? 0;
      const atmBase = group?.atmBy === 'Fut' && futLtp > 0 ? futLtp : spot;
      const atm = atmBase > 0 ? Math.round(atmBase / step) * step : null;
      const oc = chains[expKey(u, rowExpiry)]?.oc;

      // AlgoTest strike criteria when set; else ATM ± steps, or the ₹ premium
      // target as AlgoTest's Closest Premium (nearest either side).
      const crit = row.strikeCriteria;
      const critCtx = { atm: atm ?? 0, step, oc, roundInterval: row.roundInterval };
      const resolvedCe = crit
        ? resolveCriteriaStrike(crit, 'CE', row.ceCrit, critCtx)
        : row.strikeMode === 'PREMIUM'
          ? closestPremiumStrike(oc, 'CE', Number(row.cePremium))
          : (atm != null ? atm + (row.ceOffset ?? 0) * step : null);
      const resolvedPe = crit
        ? resolveCriteriaStrike(crit, 'PE', row.peCrit, critCtx)
        : row.strikeMode === 'PREMIUM'
          ? closestPremiumStrike(oc, 'PE', Number(row.pePremium))
          : (atm != null ? atm + (row.peOffset ?? 0) * step : null);

      // An OPEN row uses the strikes it actually filled at, never the live
      // resolution. ATM moves every time spot crosses a half-step, and a row
      // that re-resolved would look its own position up at a strike nobody
      // holds: P&L blanks, legsFlat() goes true, and every exit rule silently
      // stops being evaluated against a position that is still very much open.
      //
      // Pinned PER LEG, and only while the row still owns that leg: once a
      // leg's own qty is back to 0 its pin describes a closed position. A
      // row-wide pin kept a stopped-out CE on its old strike (22750) for as
      // long as the PE stayed open, so a fresh CE sold at the dead strike and
      // the CE selector could not follow the ATM. See legPinnedStrike.
      const cePin = legPinnedStrike(row, 'CE');
      const pePin = legPinnedStrike(row, 'PE');
      const ceStrike = cePin ?? resolvedCe;
      const peStrike = pePin ?? resolvedPe;

      if (ceStrike == null && peStrike == null) { out[row.id] = EMPTY_ROW_LIVE; continue; }

      const uWs = focusWsQuotes?.[u];
      const wsBook = focusWsBookForExpiry(uWs, rowExpiry);
      const ceKey = ceStrike != null ? strikeKey(ceStrike) : null;
      const peKey = peStrike != null ? strikeKey(peStrike) : null;
      const ceWs = ceKey && wsBook ? wsBook.strikes?.[ceKey] : undefined;
      const peWs = peKey && wsBook ? wsBook.strikes?.[peKey] : undefined;
      const ceCh = ceKey ? oc?.[ceKey] : undefined;
      const peCh = peKey ? oc?.[peKey] : undefined;

      const pick = (fromWs?: number, fromChain?: number): number | null => {
        if (Number(fromWs) > 0) return Number(fromWs);
        if (Number(fromChain) > 0) return Number(fromChain);
        return null;
      };

      const ceRef = ceKey ? lookups[expKey(u, rowExpiry)]?.strikes?.[ceKey] : undefined;
      const peRef = peKey ? lookups[expKey(u, rowExpiry)]?.strikes?.[peKey] : undefined;
      // Prefer the candidate under this row's own group product; only fall
      // back to a symbol/id-only match when it is unambiguous — see
      // findPositionForRef's own doc comment.
      const wantProduct = PRODUCT_ALIAS[group?.product ?? 'INTRADAY'][broker];
      // A sim row's "position" is its own paper ledger, never the broker book —
      // a real position at the same strike (another row, a manual trade) is
      // not this paper row's, and the paper fill is nowhere in the broker's.
      const sim = isSimRow(row);
      const cePosition = sim
        ? simPositionFor(row.id, 'CE', row.fill?.ceQty ?? 0, row.fill?.ceEntry)
        : findPositionForRef(positions, broker, ceRef, 'CE', wantProduct);
      const pePosition = sim
        ? simPositionFor(row.id, 'PE', row.fill?.peQty ?? 0, row.fill?.peEntry)
        : findPositionForRef(positions, broker, peRef, 'PE', wantProduct);

      const ltpCe = pick(ceWs?.ce?.ltp, ceCh?.ce);
      const ltpPe = pick(peWs?.pe?.ltp, peCh?.pe);
      // OI-buildup label/OI-change — display only, sourced straight off
      // focus_tool_ws.py (the single source of these labels, same thresholds
      // as AdvancedScalper's live_options_ws.py). '' from the bridge means
      // "not classifiable yet", normalized here to null.
      const ceBuildup = ceWs?.ce?.buildup || null;
      const peBuildup = peWs?.pe?.buildup || null;
      const ceOiChgPct = ceWs?.ce?.oi_chg_pct ?? null;
      const peOiChgPct = peWs?.pe?.oi_chg_pct ?? null;
      // Prefer WS OI when this row's expiry matches the bridge; otherwise the
      // polled chain (already fetched for this row's expiry for LTP/PREMIUM).
      const ceOi = pickOpenInterest(ceWs?.ce?.oi, ceCh?.ceOi);
      const peOi = pickOpenInterest(peWs?.pe?.oi, peCh?.peOi);

      /**
       * P&L across only the legs this row's Side trades.
       *
       * Split by how fast each half moves. REALISED comes off the broker and
       * only changes when something closes, so the 2s position poll is fine for
       * it. UNREALISED is marked HERE against the live tick — the broker's own
       * `unrealizedProfit` is a snapshot from that same 2s poll, and gating SL ₹
       * on it meant a rupee stop could sit breached for two seconds while the
       * price that breached it was already on screen.
       *
       * Dhan nets by security id, so a strike shared with another row (or a
       * running strategy) is ONE position with ONE P&L. Each row takes only its
       * own share, off the same ledger that clamps its exits — otherwise two
       * rows at one strike each claim the whole thing and the account budget
       * sees double the P&L that exists.
       *
       * Closed/rolled P&L lives on `fill.bookedPnl`, not on broker
       * `realizedProfit` of the current pin: a strike shift leaves realised on
       * the OLD security id, which this row no longer looks up.
       */
      const lotSize = lotSizes[u] ?? lookups[expKey(u, rowExpiry)]?.lotSize ?? 0;
      let entryNum = 0;
      const liveLegs: Parameters<typeof computeRowPnl>[1] = [];
      for (const leg of legsOf(row)) {
        const pos = leg === 'CE' ? cePosition : pePosition;
        if (!pos) {
          // The polled position book can trail a fill by a couple of seconds (a just-shifted or just-added
          // leg). The leg is already in this row's ledger and in sidePremium, so its entry must be in the
          // combined entry too — otherwise Pair × compares both legs now against ONE leg's entry and fires.
          if (rowOwnsLeg(row, leg)) {
            const owned = legOwnContracts(row, leg, { cePosition, pePosition } as RowLive);
            const stored = Number(leg === 'CE' ? row.fill?.ceEntry : row.fill?.peEntry) || 0;
            if (owned > 0 && stored > 0) entryNum += stored * owned;
          }
          continue;
        }
        // A broker position at this leg's strike that this row didn't open —
        // another row, a manual trade, a running strategy — must not be
        // counted as this row's premium/P&L. Without this, ownShare()/
        // computeRowPnl() in focusToolPnl.ts read a missing own qty as
        // "attribute the whole position to this row" instead of "none of it."
        if (!rowOwnsLeg(row, leg)) continue;
        // legOwnContracts reads this row's own fill ledger and never falls back
        // to the raw broker net — the single implementation of "how much does
        // this row own," also used by sidePremium/pairStopPremium so the
        // exit rules and this P&L calc can't disagree with each other.
        const owned = legOwnContracts(row, leg, { cePosition, pePosition } as RowLive);
        const ownQty = owned > 0 ? owned : undefined;
        const isShort = Number(pos.netQty) < 0;
        const avg = isShort ? (Number(pos.sellAvg) || 0) : (Number(pos.buyAvg) || 0);
        const ltp = leg === 'CE' ? ltpCe : ltpPe;
        liveLegs.push({
          netQty: Number(pos.netQty) || 0,
          buyAvg: Number(pos.buyAvg) || 0,
          sellAvg: Number(pos.sellAvg) || 0,
          ltp,
          unrealizedProfit: Number(pos.unrealizedProfit) || 0,
          ownQty,
        });
        // Combined entry for pair SL ×: Σ (lots × entry) = Σ (contracts ×
        // entry) / lotSize. NEVER falls back to the broker net: an
        // unowned/unresolved leg contributes nothing (see legOwnContracts).
        // This row's own stamped entry first, broker average as fallback —
        // the same precedence every leg rule uses (legOwnEntry). A same-strike
        // re-entry makes the broker's day-level average blend in the closed
        // trade, so "sole owner" is not enough to trust it.
        const storedEntry = Number(leg === 'CE' ? row.fill?.ceEntry : row.fill?.peEntry) || 0;
        const entryAvg = storedEntry > 0 ? storedEntry : avg;
        const q = owned;
        if (q > 0 && entryAvg > 0) {
          entryNum += entryAvg * q;
        }
      }
      const entryPremium = lotSize > 0 && entryNum > 0 ? entryNum / lotSize : 0;
      const pnl = computeRowPnl(
        rowDisplayBookedPnl(row.fill?.bookedPnl),
        liveLegs,
      );

      const vs = ceStrike != null && peStrike != null ? vwapSeriesFor(row, ceStrike, peStrike) : null;
      const vwapEntry = row.levelVw && vs && rowExpiry
        ? rowVwap[vwapKey(u, rowExpiry, vs.ce, vs.pe, vs.side, row.vwapInterval || '1')]
        : undefined;
      const vwap = vwapEntry?.vwap ?? null;
      const vwapClose = vwapEntry?.close ?? null;

      // Display-only VWAP under the LTP, at a FIXED 1m interval — independent
      // of the row's own VW exit rule (which may be off, or set to a
      // different interval). Shares vwapWantedKey's fetch below with the
      // exit-rule VWAP when a row's own interval already happens to be '1'.
      const vwap1mEntry = vs && rowExpiry
        ? rowVwap[vwapKey(u, rowExpiry, vs.ce, vs.pe, vs.side, '1')]
        : undefined;
      const vwap1m = vwap1mEntry?.vwap ?? null;
      const vwapClose1m = vwap1mEntry?.close ?? null;

      const ceDelta = ceStrike != null ? (oc?.[strikeKey(ceStrike)]?.ceDelta ?? null) : null;
      const peDelta = peStrike != null ? (oc?.[strikeKey(peStrike)]?.peDelta ?? null) : null;
      const ceDeltaDhan = ceStrike != null ? (oc?.[strikeKey(ceStrike)]?.ceDeltaDhan ?? null) : null;
      const peDeltaDhan = peStrike != null ? (oc?.[strikeKey(peStrike)]?.peDeltaDhan ?? null) : null;
      const computed: RowLive = {
        ceStrike, peStrike,
        ltpCe, ltpPe,
        cePosition, pePosition,
        pnl, entryPremium, lotSize: lotSize > 0 ? lotSize : 0, vwap, vwapClose,
        ceBuildup, peBuildup, ceOiChgPct, peOiChgPct, ceOi, peOi,
        vwap1m, vwapClose1m, ceDelta, peDelta, ceDeltaDhan, peDeltaDhan,
      };
      const prevLive = prevOut[row.id];
      out[row.id] = prevLive && rowLiveEqual(prevLive, computed) ? prevLive : computed;
    }
    rowLivePrevRef.current = out;
    return out;
  }, [config.rows, config.groups, spots, effectiveFutQuotes, chains, focusWsQuotes, lookups, lotSizes, positions, broker, expiries, rowVwap]);

  /**
   * P&L across THIS TOOL'S OWN rows — the book the account budget is measured
   * on, and the number the Python worker already uses for the same job.
   *
   * `total` (the header tiles) is whole-account F&O P&L and is deliberately
   * NOT used here: an unrelated strategy's drawdown must not trip this tool's
   * Stop and flatten its rows. The two executors disagreeing about which book
   * the budget watches meant the same Stop ₹ behaved differently depending on
   * whether the tab or the worker happened to be driving.
   */
  //
  // Real and sim rows are two separate books. Paper P&L never reaches the
  // real-money budget (a paper drawdown must not flatten real positions, and
  // a paper profit must not arm a real trail); sim rows get the same TARGET/
  // STOP/trail rules applied to their own total instead, so a forward test
  // behaves the way the real config would.
  const { toolPnl, simPnl } = useMemo(() => {
    let real = 0;
    let paper = 0;
    for (const row of config.rows) {
      const p = rowLive[row.id]?.pnl ?? 0;
      if (isSimRow(row)) paper += p; else real += p;
    }
    return { toolPnl: real, simPnl: paper };
  }, [config.rows, rowLive]);

  useEffect(() => {
    if (toolPnl > 0) setPeakMtm(prev => Math.max(prev, toolPnl));
  }, [toolPnl]);
  // The sim book's own peak and ratcheted floor — refs, not state: nothing on
  // screen shows them, they only feed the sim budget check.
  const simPeakRef = useRef(0);
  const simLockFloorRef = useRef<number | null>(null);
  useEffect(() => {
    if (simPnl > simPeakRef.current) simPeakRef.current = simPnl;
  }, [simPnl]);

  // Distinct strike pairs that need a VWAP: every row's own VW-rule interval
  // when that rule is on, PLUS a fixed 1m interval for every row with
  // resolved strikes (shown under the LTP regardless of the VW rule). A
  // plain string, not the wanted objects themselves, so the fetch effect
  // below only re-runs when the SET of strike pairs actually changes — not
  // on every live tick, which changes rowLive's identity constantly but
  // essentially never changes which strikes a row is sitting at.
  const vwapWantedKey = useMemo(() => {
    const keys = new Set<string>();
    for (const row of config.rows) {
      const live = rowLive[row.id];
      if (!live || live.ceStrike == null || live.peStrike == null) continue;
      const expiry = row.expiry || expiries[row.underlying]?.[0] || '';
      if (!expiry) continue;
      const vs = vwapSeriesFor(row, live.ceStrike, live.peStrike);
      if (row.levelVw) {
        keys.add(vwapKey(row.underlying, expiry, vs.ce, vs.pe, vs.side, row.vwapInterval || '1'));
      }
      keys.add(vwapKey(row.underlying, expiry, vs.ce, vs.pe, vs.side, '1'));
    }
    return Array.from(keys).sort().join('|');
  }, [config.rows, rowLive, expiries]);

  // Session-open VWAP fetch: one call per distinct strike pair + interval
  // among rows that actually enabled VW, refreshed once a minute (the
  // underlying data only moves in whole-minute bars anyway — see
  // focus_tool_vwap.py).
  useEffect(() => {
    if (!vwapWantedKey) return;
    const wanted = vwapWantedKey.split('|').map(key => {
      const [underlying, expiry, ceStrike, peStrike, side, interval] = key.split(':');
      return { key, underlying, expiry, ceStrike, peStrike, side, interval };
    });

    let cancelled = false;
    const fetchAll = () => {
      wanted.forEach(({ key, underlying, expiry, ceStrike, peStrike, side, interval }) => {
        const url = `/api/focus-tool/vwap?underlying=${underlying}&expiry=${expiry}&ceStrike=${ceStrike}&peStrike=${peStrike}&side=${side}&interval=${interval}`;
        fetch(url)
          .then(r => r.json())
          .then((j: { success?: boolean; vwap?: number | null; close?: number | null }) => {
            if (cancelled || !j.success) return;
            const next = { vwap: j.vwap ?? null, close: j.close ?? null };
            setRowVwap(prev => {
              const p = prev[key];
              if (p && p.vwap === next.vwap && p.close === next.close) return prev;
              return { ...prev, [key]: next };
            });
          })
          .catch(() => {});
      });
    };

    fetchAll();
    const t = setInterval(fetchAll, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [vwapWantedKey]);

  async function saveConfig(patch?: FocusConfigWrite) {
    // Queued rather than fired directly — see saveQueueRef's doc comment.
    // Each save waits for every save already queued ahead of it to land
    // first, so two saves fired close together apply in order.
    savesInFlightRef.current += 1;
    saveGenRef.current += 1;
    const run = saveQueueRef.current.then(() => doSaveConfig(patch)).finally(() => { savesInFlightRef.current -= 1; });
    // Swallow here so one failed save doesn't wedge the queue for whatever
    // saves come after it — doSaveConfig already reports the failure itself.
    saveQueueRef.current = run.catch(() => {});
    return run;
  }

  async function doSaveConfig(patch?: FocusConfigWrite) {
    try {
      const raw = patch ?? {
        riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees, liveRealMoney,
        trailKind: trailX.kind, trailEvery: trailX.every, trailBy: trailX.by,
        groups: config.groups,
      };
      // Rows carry a rev bumped only for rows this tab changed (lib/revMerge.ts);
      // the server keeps the newer copy of each row, so this save can't roll
      // back a row another tab (or this tab's own later save) moved on.
      const sentRows = raw.rows ? stampItems(rowRevBookRef.current, 'r:', raw.rows) : undefined;
      const body = sentRows ? { ...raw, rows: sentRows } : raw;
      const res = await fetch('/api/focus-tool/rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json() as { success: boolean; data?: FocusToolConfig; error?: string; conflicts?: string[]; refusedDeletes?: string[] };
      if (j.success && j.data) {
        noteItems(rowRevBookRef.current, 'r:', j.data.rows);
        applyServerConfig(j.data, sentRows);
        if (j.conflicts?.length) {
          addToast('error', 'Row changed elsewhere', `Kept the saved version of ${j.conflicts.length} row(s): another tab changed them first. Check those rows.`);
        }
        if (j.refusedDeletes?.length) {
          addToast('error', 'Row not deleted', 'It still holds a position on the server — exit it first.');
        }
      } else if (j.error) {
        addToast('error', 'Failed to save config', j.error);
      }
    } catch (e) {
      addToast('error', 'Network error saving config', String(e));
    }
  }

  /**
   * Global Exit All — every open F&O position for the active broker, at
   * once. Ported from AdvancedScalper/Scalper's own `handleExitAll` (same
   * click-to-arm/click-again-to-confirm flow, same routes, same behavior)
   * rather than reimplemented, per explicit choice: on Dhan this also force-
   * kills or gracefully shuts down every running Python strategy process
   * account-wide, so a flattened strategy can't silently re-enter. Not
   * scoped to Focus Tool's own rows — it is the same broker-level nuclear
   * exit the scalper terminals use, reused as-is rather than rebuilt.
   */
  async function handleExitAll() {
    if (!confirmExitAll) {
      setConfirmExitAll(true);
      setTimeout(() => setConfirmExitAll(false), 3000);
      return;
    }
    setExitingAll(true);
    setConfirmExitAll(false);
    for (const r of config.rows) logEvent('exit_all_positions', r, 'manual: EXIT ALL Positions (header button)');
    await Promise.all(config.rows.map(r => cancelLadderOrders(r.id)));
    try {
      if (broker !== 'dhan') {
        const label = BROKER_LABELS[broker];
        const res = await fetch(scalperRoute(broker, 'exit-all'), { method: 'POST' });
        const data = await res.json() as { success: boolean; closed: string[]; errors: string[] };
        if (data.success) {
          addToast('success', `All ${label} positions liquidated.${data.closed.length ? ` (${data.closed.join(', ')})` : ''}`);
        } else {
          addToast('error', `${label} exit failed`, data.errors.join('; ') || 'Unknown error');
        }
      } else {
        const res = await fetch('/api/exit-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'fno' }),
        });
        const data = await res.json();
        if (data.broker_exit) {
          const killed = data.killed?.length ?? 0;
          const fallback = data.trigger_fallback?.length ?? 0;
          const detail = killed > 0 ? ` ${killed} strategy process${killed === 1 ? '' : 'es'} terminated.` : '';
          const fb = fallback > 0 ? ` ${fallback} sent graceful shutdown.` : '';
          addToast('success', `All F&O positions liquidated at broker.${detail}${fb}`);
        } else {
          addToast('error', data.error || 'Broker exit failed — check Dhan account manually.');
        }
      }
    } catch (e) {
      addToast('error', 'Network error calling exit-all API.', String(e));
    } finally {
      // Retire every active Focus row so the tab scheduler cannot re-enter into a book we just nuked.
      // Sim rows are untouched: the broker exit didn't close their paper
      // legs, and wiping their ledger would silently drop the forward test.
      setConfig(prev => {
        const nextRows = prev.rows.map(r => {
          if (r.status === 'draft' || isSimRow(r)) return r;
          return {
            ...r,
            status: 'exited' as FocusRow['status'],
            fill: undefined,
            updatedAt: new Date().toISOString(),
          };
        });
        const nextConfig = { ...prev, rows: nextRows };
        saveConfig(nextConfig);
        return nextConfig;
      });
      setExitingAll(false);
      setTimeout(pollPositions, 1000);
    }
  }

  /**
   * H↑ is a breakout level above where spot might travel to, and L↓ the mirror
   * below — not a level already behind you. Saving one on the wrong side of the
   * current spot means the row's auto-exit fires the instant it starts being
   * watched, so this is rejected at Save rather than silently accepted.
   */
  function validateLevelExits(row: FocusRow, spot: number): string | null {
    const hi = Number(row.levelHigh);
    const lo = Number(row.levelLow);
    if (row.levelHigh && Number.isFinite(hi) && spot > 0 && hi <= spot) {
      return `H↑ (${hi}) must be above the current spot (${spot.toFixed(2)})`;
    }
    if (row.levelLow && Number.isFinite(lo) && spot > 0 && lo >= spot) {
      return `L↓ (${lo}) must be below the current spot (${spot.toFixed(2)})`;
    }
    return null;
  }

  function updateRow(id: string, patch: Partial<FocusRow>) {
    // A level exit is validated before it reaches STATE, not just before it
    // reaches disk. The in-tab watcher reads component state directly, so a
    // level on the wrong side of spot fires a real exit the moment it lands —
    // rejecting it only at save time protected the Python worker and nothing
    // else. Only a level that actually CHANGES is checked, so re-saving a row
    // whose level spot has since travelled past is not blocked (that row has
    // already exited on it anyway), and neither is an unrelated Timing save.
    const current = config.rows.find(r => r.id === id);
    // REAL ↔ SIM only on a flat, unarmed row. Flipping an open row would
    // either orphan a real broker position (page stops tracking it) or hand a
    // paper ledger to the real-order path (exits sized off a position that
    // doesn't exist). Flipping an ARMED sim row to real would fire a real entry
    // on the next tick if its entry time has already passed.
    if (current && 'mode' in patch && patch.mode !== current.mode) {
      if (!rowFlat(current)) {
        addToast('error', 'Mode not changed', 'Exit this row’s legs before switching between REAL and SIM');
        return;
      }
      if (current.status === 'armed') {
        addToast('error', 'Mode not changed', 'Disarm the row before switching between REAL and SIM');
        return;
      }
    }
    const levelChanged =
      ('levelHigh' in patch && patch.levelHigh !== current?.levelHigh) ||
      ('levelLow'  in patch && patch.levelLow  !== current?.levelLow);
    if (levelChanged && current) {
      const err = validateLevelExits({ ...current, ...patch }, spots[current.underlying] ?? 0);
      if (err) {
        addToast('error', 'Level exit rejected', err);
        return;
      }
    }
    setConfig(prev => {
      const nextRows = prev.rows.map(r => r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r);
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
  }

  // A saved row can carry an expiry that has since expired (e.g. NIFTY
  // 2026-09-08 saved weeks ago). The EXPY dropdown silently displays the
  // nearest listed date for it, but every chain/WS lookup keys on the dead
  // string — so premiums show "—" and the bridge subscribes to a contract-less
  // expiry. Snap a flat row to the nearest listed expiry once that underlying's
  // list has loaded. Never touches a row that is open or holds a fill.
  useEffect(() => {
    for (const r of config.rows) {
      const listed = expiries[r.underlying];
      if (!listed?.length || !r.expiry || listed.includes(r.expiry)) continue;
      if (r.fill || r.status === 'entered') continue;
      updateRow(r.id, { expiry: listed[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateRow is re-created every render
  }, [config.rows, expiries]);

  /** Arm a row for the scheduler. Clears the one-entry-per-row latch so a row
   *  that already entered and exited can be deliberately re-armed to trade
   *  again — otherwise re-arming would look accepted but never fire. */
  function armRow(id: string) {
    autoEnteringRef.current.delete(id);
    rowExitWantedRef.current.delete(id);
    // Drop any stale fill pin — arming means this row resolves its strikes
    // fresh at the next entry, so a pin from the previous cycle would make it
    // look its new position up at last time's strikes.
    updateRow(id, { status: 'armed', fill: undefined, overallReSlCount: 0, overallReTgtCount: 0, overallReMode: undefined });
  }

  function deleteRow(id: string) {
    const cfgRow = config.rows.find(r => r.id === id);
    if (cfgRow && !rowFlat(cfgRow)) {
      addToast('error', 'Cannot delete row', 'Exit the CE/PE legs first — this row still holds a position');
      return;
    }
    autoEnteringRef.current.delete(id);
    autoExitingRef.current.delete(id);
    setConfig(prev => {
      const nextRows = prev.rows.filter(r => r.id !== id);
      const nextConfig = { ...prev, rows: nextRows };
      // Explicit: the server keeps any row a save leaves out, and remembers
      // this id so a stale tab's save can't bring the row back.
      saveConfig({ ...nextConfig, deleteRowIds: [id] });
      return nextConfig;
    });
    addToast('success', 'Row deleted');
  }

  function addRow(underlying: FocusUnderlying) {
    const group = config.groups.find(g => g.underlying === underlying);
    const row = makeRow(underlying);
    row.expiry = expiries[underlying]?.[0] ?? '';
    // A new row starts linked: CE `n` steps above ATM, PE `n` steps below —
    // the group's ± offset as a symmetric strangle (0 is a straddle).
    const offset = group?.strikesOffset ?? 0;
    row.ceOffset = offset;
    row.peOffset = -offset;

    setConfig(prev => {
      const nextRows = [...prev.rows, row];
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
    addToast('success', `Added ${underlying} row`);
  }

  /**
   * Move this row's own fill ledger after an accepted order: `delta` units on
   * one leg, and the strike it was opened at when opening.
   *
   * Written through a functional update rather than off the render's `config`
   * so a burst of orders (both legs of an entry, a double leg-exit) composes
   * correctly even when React has not re-rendered between them.
   */
  function adjustFillQty(
    rowId: string, leg: 'CE' | 'PE', delta: number, strike?: number, bookedDelta = 0,
    entryPrice?: number,
    /** The range a Range Breakout open broke out of — stamped in the same write that opens the leg. */
    orb?: FocusOrbStamp | null,
  ) {
    setConfig(prev => {
      const nextRows = prev.rows.map(r => {
        if (r.id !== rowId) return r;
        const f = r.fill;
        const prevQty = leg === 'CE' ? (f?.ceQty ?? 0) : (f?.peQty ?? 0);
        const prevEntry = leg === 'CE' ? (f?.ceEntry ?? null) : (f?.peEntry ?? null);
        // Qty-weighted blend across every ADD on this leg (delta > 0) — a
        // reduce (delta < 0) never touches the stored entry, only the
        // remaining qty still carries it. No price for this fill (e.g. LTP
        // unavailable) leaves the existing entry untouched rather than
        // diluting it toward 0. A leg re-opening from flat with no price has
        // NO entry — the previous position's price describes a closed trade
        // (possibly another strike), and SL to cost would measure against it.
        const nextEntry = delta > 0 && Number(entryPrice) > 0
          ? ((Number(prevEntry) || 0) * prevQty + Number(entryPrice) * delta) / (prevQty + delta)
          : (delta > 0 && prevQty <= 0 ? null : prevEntry);
        const nextCeQty = leg === 'CE' ? Math.max(0, (f?.ceQty ?? 0) + delta) : (f?.ceQty ?? 0);
        const nextPeQty = leg === 'PE' ? Math.max(0, (f?.peQty ?? 0) + delta) : (f?.peQty ?? 0);
        // |delta| × 100 of the strike opened, off the polled chain — the base of a Delta stop / target / trail.
        const legDeltaEntry = (l: 'CE' | 'PE', nextQty: number, prev: number | null | undefined, rr: FocusRow) => {
          if (nextQty <= 0) return null;
          if (l === leg && prevQty <= 0 && strike != null) {
            const exp = rr.expiry || expiries[rr.underlying]?.[0] || '';
            const q = chainsRef.current[expKey(rr.underlying, exp)]?.oc?.[strikeKey(strike)];
            return (l === 'CE' ? q?.ceDelta : q?.peDelta) ?? null;
          }
          return prev ?? null;
        };
        const legSpotEntry = (l: 'CE' | 'PE', nextQty: number, prevSpot: number | null | undefined, u: FocusUnderlying) => {
          if (nextQty <= 0) return null;
          if (l === leg && prevQty <= 0) {
            const sp = schedulerRef.current.spots[u] ?? 0;
            return sp > 0 ? sp : null;
          }
          return prevSpot ?? null;
        };
        // Stamp the moment a leg goes from flat to held (persisted, not just
        // an in-memory ref) so a stale post-fill position poll has something
        // to check against before treating it as a ghost — see
        // isGhostDropProtected below. Cleared once the leg is flat again.
        const now = Date.now();
        const ceOpenedTs = leg === 'CE'
          ? nextOpenedTs(prevQty, nextCeQty, f?.ceOpenedTs, now)
          : (f?.ceOpenedTs ?? null);
        const peOpenedTs = leg === 'PE'
          ? nextOpenedTs(prevQty, nextPeQty, f?.peOpenedTs, now)
          : (f?.peOpenedTs ?? null);
        const nextFill: FocusRowFill = {
          // Carry every field this function doesn't own (roll counters,
          // cost-stop flags) — rebuilding the object field-by-field dropped
          // anything added later.
          ...f,
          ceStrike: leg === 'CE' && strike != null ? strike : (f?.ceStrike ?? null),
          peStrike: leg === 'PE' && strike != null ? strike : (f?.peStrike ?? null),
          ceQty: nextCeQty,
          peQty: nextPeQty,
          ceEntry: leg === 'CE' ? nextEntry : (f?.ceEntry ?? null),
          peEntry: leg === 'PE' ? nextEntry : (f?.peEntry ?? null),
          ceOpenedTs,
          peOpenedTs,
          // SL-to-cost belongs to the position it was armed on: a leg that
          // goes flat drops it, so a later re-open starts without it.
          ceCostStop: nextCeQty > 0 ? f?.ceCostStop : undefined,
          peCostStop: nextPeQty > 0 ? f?.peCostStop : undefined,
          // Likewise the Lazy Leg whose SL / target a slot is running on.
          ceLazyId: nextCeQty > 0 ? f?.ceLazyId : undefined,
          peLazyId: nextPeQty > 0 ? f?.peLazyId : undefined,
          // The spot when the leg opened from flat — the base of an Underlying
          // Points / % stop or target. Trail SL steps and the ORB range belong
          // to the position too, and go with it.
          ceSpotEntry: legSpotEntry('CE', nextCeQty, f?.ceSpotEntry, r.underlying),
          peSpotEntry: legSpotEntry('PE', nextPeQty, f?.peSpotEntry, r.underlying),
          ceDeltaEntry: legDeltaEntry('CE', nextCeQty, f?.ceDeltaEntry, r),
          peDeltaEntry: legDeltaEntry('PE', nextPeQty, f?.peDeltaEntry, r),
          // A leg opening from flat records the MODEL delta, so mark it; an add on a running leg keeps whatever basis it already had.
          ceDeltaModel: nextCeQty <= 0 ? undefined : (leg === 'CE' && prevQty <= 0 ? true : f?.ceDeltaModel),
          peDeltaModel: nextPeQty <= 0 ? undefined : (leg === 'PE' && prevQty <= 0 ? true : f?.peDeltaModel),
          ceTrailSteps: nextCeQty > 0 && !(leg === 'CE' && prevQty <= 0) ? f?.ceTrailSteps : undefined,
          peTrailSteps: nextPeQty > 0 && !(leg === 'PE' && prevQty <= 0) ? f?.peTrailSteps : undefined,
          ceOrb: nextCeQty <= 0 ? undefined : (leg === 'CE' && prevQty <= 0 ? (orb ?? undefined) : f?.ceOrb),
          peOrb: nextPeQty <= 0 ? undefined : (leg === 'PE' && prevQty <= 0 ? (orb ?? undefined) : f?.peOrb),
          bookedPnl: (f?.bookedPnl ?? 0) + (Number(bookedDelta) || 0),
          ts: f?.ts ?? new Date().toISOString(),
        };
        return { ...r, fill: nextFill, updatedAt: new Date().toISOString() };
      });
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
  }

  // ── Leg orders ──────────────────────────────────────────────────
  //
  // The Focus Tool is a premium-selling scheduler: opening a leg is a SELL,
  // reducing one is a BUY. A reducing order re-resolves its product from the
  // live position rather than from the group, because an order booked under
  // the wrong product does not reduce the position — the broker opens a fresh
  // one on the other side, doubling exposure at the moment risk was being cut.

  /**
   * Poll the position book briefly to confirm how much of a just-accepted
   * order actually filled, clamped to what was requested.
   *
   * The order API returning success:true means Dhan accepted the order
   * (TRANSIT status), not that it filled — crediting the ledger with the
   * full requested quantity on ACK alone drifts it away from the real book
   * on a partial fill or a fill that gets rejected after the ACK, and the
   * ledger is what every later exit is sized against. Falls back to
   * `requested` if the book can't be read within the window (the pre-fix
   * behavior) rather than silently zeroing a real fill out of the ledger.
   */
  async function confirmLegFillQty(
    u: FocusUnderlying, expiry: string, leg: 'CE' | 'PE', strike: number, product: string,
    netQtyBefore: number, side: 'BUY' | 'SELL', requested: number,
    opts: { maxWaitMs?: number; strict?: boolean } = {},
  ): Promise<number> {
    const maxWaitMs = opts.maxWaitMs ?? 2500;
    // strict: unread/unknown book → 0 (shift must not pretend the fill landed).
    // Non-strict keeps the pre-fix fallback of trusting `requested`.
    const onUnknown = opts.strict ? 0 : requested;
    const ref = lookups[expKey(u, expiry)]?.strikes?.[strikeKey(strike)];
    const id = leg === 'CE' ? ref?.ceId : ref?.peId;
    const sym = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
    if (broker === 'dhan' ? !id : !sym) return onUnknown;

    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      await new Promise(r => setTimeout(r, 350));
      const rows = await fetchPositionsNow();
      if (rows) {
        const candidates = broker === 'dhan'
          ? rows.filter(p => String(p.securityId) === String(id))
          : rows.filter(p => String(p.tradingSymbol) === sym);
        const pos = product
          ? candidates.find(p => positionProduct(p as unknown as Record<string, unknown>) === product)
          : (candidates.length === 1 ? candidates[0] : undefined);
        const netQtyNow = Number(pos?.netQty ?? 0);
        // Net moves toward BUY (+) or SELL (-) by exactly the filled
        // quantity; clamp to `requested` so an unrelated concurrent change
        // on the same book (another row, a running strategy) can't be
        // miscredited to this order.
        const observed = side === 'BUY' ? netQtyNow - netQtyBefore : netQtyBefore - netQtyNow;
        if (observed >= requested) return requested;
        if (Date.now() >= deadline) return Math.max(observed, 0);
      } else if (Date.now() >= deadline) {
        return onUnknown;
      }
    }
  }

  /**
   * Settle an unconfirmed close (see UnconfirmedOrder) against broker truth
   * and credit any late fill to the ledger (reducing it — never growing it).
   *
   *  - Dhan: the order itself (TRADED → filledQty; REJECTED/CANCELLED/
   *    EXPIRED → whatever filled before it died). Order status is
   *    authoritative, so no guessing from the book.
   *  - Kotak/Zerodha: a fresh position read, movement since the order went
   *    out, clamped to what is still unconfirmed (a sibling row trading the
   *    same contract can't be credited past this order's size). Unresolved
   *    after UNCONFIRMED_ORDER_HOLD_MS → treated as dead: a MARKET close not
   *    in the book by then did not fill.
   *
   * 'resolved' = safe to size a new close off a fresh book. Anything else =
   * do not resend yet. Throttled to one broker read per 1.5s per record.
   */
  async function reconcileUnconfirmedOrder(key: string): Promise<{ state: 'resolved' | 'pending'; credited: number }> {
    const rec = unconfirmedOrderRef.current.get(key);
    if (!rec) return { state: 'resolved', credited: 0 };
    // Row gone, re-armed or retired (ledger dropped): nothing left to credit
    // into — crediting would recreate a ledger on a finished row.
    const rowNow = schedulerRef.current.config.rows.find(r => r.id === rec.rowId);
    if (!rowNow?.fill) {
      unconfirmedOrderRef.current.delete(key);
      return { state: 'resolved', credited: 0 };
    }
    const now = Date.now();
    if (now - rec.lastCheck < 1_500) return { state: 'pending', credited: 0 };
    rec.lastCheck = now;
    const remaining = rec.requested - rec.filled;
    let filledNow: number | null = null;   // total filled on this order, if known
    let dead = false;
    if (broker === 'dhan' && rec.orderId) {
      try {
        const res = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(rec.orderId)}`);
        const j = await res.json() as { success?: boolean; data?: { orderStatus?: string; filledQty?: number } };
        if (j.success && j.data) {
          const st = String(j.data.orderStatus ?? '').toUpperCase();
          const fq = Math.min(rec.requested, Math.max(0, toInternalQty(rowNow.underlying, Number(j.data.filledQty) || 0)));
          if (st === 'TRADED') filledNow = rec.requested;
          else if (st === 'REJECTED' || st === 'CANCELLED' || st === 'CANCELED' || st === 'EXPIRED') {
            filledNow = fq; dead = true;
          } else if (fq > rec.filled) {
            filledNow = fq;   // part-traded, still working
          }
        }
      } catch { /* unknown — stays pending */ }
      // A MARKET close with no final status after a minute is abnormal; don't
      // let it block this leg's stops forever. Say so — the user should look.
      if (!dead && (filledNow ?? rec.filled) < rec.requested && now - rec.ts >= 60_000) {
        dead = true;
        addToast('error', `${rec.leg} ${rec.kind} order ${rec.orderId} still not final after 60s`,
          'Releasing the hold so the row\'s rules can act again — check this order in the order book');
      }
    } else {
      const rows = await fetchPositionsNow();
      if (rows) {
        const cands = broker === 'dhan'
          ? rows.filter(p => String(p.securityId) === String(rec.securityId))
          : rows.filter(p => String(p.tradingSymbol) === String(rec.symbol));
        const pos = rec.product
          ? cands.find(p => positionProduct(p as unknown as Record<string, unknown>) === rec.product)
          : (cands.length === 1 ? cands[0] : undefined);
        const netNow = Number(pos?.netQty ?? 0);
        const observed = rec.side === 'BUY' ? netNow - rec.netBefore : rec.netBefore - netNow;
        filledNow = Math.min(rec.requested, Math.max(rec.filled, observed));
      }
      if (now - rec.ts >= UNCONFIRMED_ORDER_HOLD_MS && (filledNow ?? rec.filled) < rec.requested) dead = true;
    }
    const late = filledNow != null ? Math.max(0, Math.min(remaining, filledNow - rec.filled)) : 0;
    if (late > 0) {
      if (rec.kind === 'close') {
        const mark = { ...rec.snap, qty: late };
        const booked = canMarkMtm(mark) ? mtmForQty(mark) : 0;
        adjustFillQty(rec.rowId, rec.leg, -late, undefined, booked);
        addToast('success', `${rec.leg} close confirmed late`,
          `${late} of ${rec.requested} filled after the check window — ledger updated. `
          + 'Re-entry / SL→Cost for that stop were NOT applied (they only follow a close confirmed in time).');
      } else {
        adjustFillQty(rec.rowId, rec.leg, late, rec.strike, 0, rec.entryPx, rec.orb);
        addToast('success', `${rec.leg} ${rec.strike} sell confirmed late`,
          `${late} of ${rec.requested} filled after the check window — now tracked by this row, stops included`);
      }
      rec.filled += late;
    }
    if (rec.filled >= rec.requested || dead) {
      unconfirmedOrderRef.current.delete(key);
      if (dead && rec.filled < rec.requested) {
        addToast('error', rec.kind === 'close' ? `${rec.leg} close did not fill` : `${rec.leg} ${rec.strike} sell did not fill`,
          rec.kind === 'close'
            ? `${rec.requested - rec.filled} still open and still tracked — the row's rules will retry`
            : `${rec.requested - rec.filled} of ${rec.requested} never filled — nothing more to track`);
      }
      return { state: 'resolved', credited: late };
    }
    return { state: 'pending', credited: late };
  }

  /** The 1s scheduler's pass: settle unconfirmed orders even if no rule retries. */
  function sweepUnconfirmedOrders() {
    for (const key of Array.from(unconfirmedOrderRef.current.keys())) {
      void reconcileUnconfirmedOrder(key);
    }
  }

  /**
   * Send one market order for one leg.
   *
   * `reduce` selects both the direction and where the product comes from, and
   * a reducing order is clamped to the quantity the broker actually shows on
   * that leg — never more.
   */
  async function placeLeg(
    row: FocusRow,
    leg: 'CE' | 'PE',
    opts: { reduce: boolean; lots?: number; all?: boolean; strikeOverride?: number; awaitFill?: boolean; orb?: FocusOrbStamp | null },
  ): Promise<boolean> {
    const u = row.underlying;
    const expiry = row.expiry || expiries[u]?.[0] || '';
    const what = `${u} ${leg}`;

    // A sim row never reaches the broker — and so needs neither the daily
    // LIVE arm nor a logged-in broker.
    if (isSimRow(row)) return placeSimLeg(row, leg, opts);

    if (!liveRealMoney) {
      addToast('error', 'Dry run', 'Enable LIVE · REAL MONEY to place orders');
      return false;
    }
    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', `Log in to ${BROKER_LABELS[broker]} before placing orders`);
      return false;
    }

    // A full exit (or a roll, which exits fully first) must not leave resting limit
    // sells behind: one filling after the leg is gone would open an unwatched short.
    if (opts.reduce && opts.all) await cancelLadderOrders(row.id, leg);
    const live = rowLive[row.id];
    // strikeOverride lets a strike-shift open the new strike immediately —
    // rowLive still reflects the OLD strike at this point because it derives
    // from config state, which the shift only updates after this call.
    const strike = opts.strikeOverride ?? (leg === 'CE' ? live?.ceStrike : live?.peStrike);
    const lotSize = lotSizes[u];
    if (!strike || !lotSize) {
      addToast('error', `${what} order not sent`, 'Strike or lot size not resolved yet');
      return false;
    }

    const ref = lookups[expKey(u, expiry)]?.strikes?.[strikeKey(strike)];
    const securityId = leg === 'CE' ? ref?.ceId : ref?.peId;
    const symbol     = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
    if (broker === 'dhan' ? !securityId : !symbol) {
      addToast('error', `${what} order not sent`, `No ${broker} contract for ${strike} ${leg}`);
      return false;
    }

    // Resolved against `strike` (the contract this order actually targets),
    // NOT `live.cePosition`/`pePosition` — those are pinned to the row's
    // CURRENT config strike, which is stale whenever `opts.strikeOverride`
    // names a different contract (a strike-shift reopen). Using the stale
    // pin here fed a wrong-security netQty into confirmLegFillQty's fill
    // check below, which made every shift-reopen report itself as unfilled
    // even when the real market order went through in full — see the shift
    // audit for the exact mechanism.
    const group = config.groups.find(g => g.underlying === u);
    const wantProduct = PRODUCT_ALIAS[group?.product ?? 'INTRADAY'][broker];

    // A previous order on this leg is still unconfirmed: settle it before
    // any close, and size off a FRESH book, never the 2s-poll state —
    // resending against a stale book is how a short gets closed twice and
    // ends up long (and closing ahead of a late-landing open undersizes).
    let bookRows: PosRow[] = positions;
    let credited = 0;
    const closeKey = `${row.id}:${leg}`;
    if (opts.reduce && unconfirmedOrderRef.current.has(closeKey)) {
      const r = await reconcileUnconfirmedOrder(closeKey);
      if (r.state !== 'resolved') {
        const rec = unconfirmedOrderRef.current.get(closeKey);
        if (rec && Date.now() - rec.lastToast > 5_000) {
          rec.lastToast = Date.now();
          addToast('error', `${what}: close on hold`,
            'The previous order on this leg is not confirmed yet — not sending a close until the broker settles it');
        }
        return false;
      }
      credited = r.credited;
      const fresh = await fetchPositionsNow();
      if (!fresh) {
        addToast('error', `${what} order not sent`, 'Position book unreadable after an unconfirmed order — retrying');
        return false;
      }
      bookRows = fresh;
    }
    const pos = findPositionForRef(bookRows, broker, ref, leg, wantProduct);
    const netQty = Number(pos?.netQty ?? 0);

    const pageOwn = Math.max(0, (Number(leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty) || 0) - credited);
    const ownQty = pageOwn > 0 ? pageOwn : undefined;

    let quantity: number;
    let side: 'BUY' | 'SELL';
    if (opts.reduce) {
      const brokerQty = Math.abs(netQty);

      if (netQty === 0) {
        const openedTs = leg === 'CE' ? row.fill?.ceOpenedTs : row.fill?.peOpenedTs;
        // Refuse to ghost-drop a leg this row only just opened — Kotak/
        // Zerodha have no fill-confirmation socket, so a poll right after a
        // real fill can still read the old (flat) position for a few
        // seconds. Treat that as "not caught up yet", not "actually flat",
        // and let the caller retry once the book settles rather than
        // silently dropping a live short from the ledger. `openedTs` is
        // persisted (see FocusRowFill), so this protects across a reload
        // too, not just within one tab session. Mirrors the retired
        // worker's own RECONCILE_GRACE_SECONDS.
        if (isGhostDropProtected(pageOwn, openedTs, Date.now())) {
          addToast('error', `${what} fill settling`,
            'Broker position not caught up with a just-opened fill yet — retry in a few seconds');
          return false;
        }
        if (pageOwn > 0) {
          // Closed outside this tool. Book its P&L from the actual outside
          // trade(s) when Dhan's trade book explains the whole qty exactly;
          // otherwise book nothing and say so, rather than invent a price
          // (dropping it silently lost the slice's P&L — 2026-10-01 audit).
          const entry = live ? legOwnEntry(row, leg, live) : (Number(leg === 'CE' ? row.fill?.ceEntry : row.fill?.peEntry) || 0);
          const openedAt = Number(leg === 'CE' ? row.fill?.ceOpenedTs : row.fill?.peOpenedTs) || 0;
          const match = broker === 'dhan' && securityId ? await outsideCloseExit(String(securityId), pageOwn, openedAt) : null;
          const exit = match?.exitPrice ?? null;
          const booked = exit != null ? closedSliceBooked(true, entry, exit, pageOwn) : 0;
          if (booked !== 0 && match) for (const k of match.keys) usedOutsideTradeKeysRef.current.add(k);
          adjustFillQty(row.id, leg, -pageOwn, undefined, booked);
          if (exit == null || booked === 0) {
            addToast('error', `${what} closed outside the tool`,
              `${pageOwn} qty was already flat at the broker. Its P&L could not be priced from the trade book and was not booked into this row.`);
          }
        }
        // Exit All walks every Side leg; an already-flat unowned leg is a no-op
        // success so one ghost PE clear is not reported as "Exit incomplete".
        if (opts.all) return true;
        addToast('error', `${what} already flat`, 'Nothing to reduce');
        return false;
      }
      // Close against the direction the broker actually shows, not against an
      // assumed short — a row could be held long.
      side = netQty < 0 ? 'BUY' : 'SELL';

      // Size against THIS row's own ledger, clamped by what the broker still
      // shows — the same rule lib/strategy_risk.resolve_exit_qty applies on the
      // Python side, and for the same reason: Dhan nets by security id, so two
      // rows at the same strike (or a row sharing a strike with a running
      // strategy) are ONE broker position. Sizing off the raw net quantity lets
      // whichever exits first flatten the other's leg too.
      if (ownQty === undefined || ownQty <= 0) {
        // No ledger entry — a position this page did not open (or one from
        // before the ledger existed). There is no "own" share to clamp to, so
        // fall back to the broker quantity and say so, rather than refuse to
        // let the user manage it.
        quantity = Math.min(opts.all ? brokerQty : (opts.lots ?? 1) * lotSize, brokerQty);
        if (opts.all && brokerQty > 0) {
          addToast('error', `${what}: unclamped exit`,
            `No fill record for this leg — closing the broker's full ${brokerQty} qty. If another row or strategy shares this strike, it is being closed too.`);
        }
      } else {
        const want = opts.all ? ownQty : (opts.lots ?? 1) * lotSize;
        quantity = Math.min(want, ownQty, brokerQty);
      }
    } else {
      side = 'SELL';
      quantity = (opts.lots ?? 1) * lotSize;
    }
    if (!(quantity > 0)) return false;

    // Reducing: the position's own product. Opening: the group's.
    const rawProduct = opts.reduce && pos
      ? positionProduct(pos as unknown as Record<string, unknown>)
      : PRODUCT_ALIAS[group?.product ?? 'INTRADAY'][broker];
    const product = closeOrderProduct(broker, rawProduct);
    if (!product) {
      addToast('error', `${what} order not sent`, `Cannot place a market order against product ${rawProduct}`);
      return false;
    }

    if (!brokerTradesUnderlying(broker, u)) {
      addToast('error', `${what} order not sent`, `${u} trades on Dhan only — switch broker`);
      return false;
    }
    const exchange = orderExchange(broker, u);
    const url = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
    // `quantity` is in page units (barrels for MCX); the broker takes lots there.
    const sentQty = orderQuantity(u, quantity);
    if (!(sentQty > 0)) {
      addToast('error', `${what} order not sent`, `${quantity} is under one ${u} lot (${UNDERLYING_META[u].unitsPerLot})`);
      return false;
    }
    const body = broker === 'dhan'
      ? { securityId, quantity: sentQty, side, orderType: 'MARKET', exchangeSegment: exchange, ...product.fields, source: FTS_ORDER_SOURCE }
      : { tradingsymbol: symbol, quantity: sentQty, side, orderType: 'MARKET', exchange, ...product.fields };

    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json() as { success?: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `${side} ${quantity} ${strike} ${leg}`, j.order_id ? `Order ${j.order_id}` : undefined);
        // Confirm the actual fill in the background rather than blocking on
        // it — this is a scalping terminal, and the row's busy lock (see
        // runRowAction) is held until this function returns, so awaiting the
        // confirmation poll here would leave the row's buttons disabled for
        // up to confirmLegFillQty's whole window on every single order. The
        // ledger (what the next exit sizes against) still gets corrected to
        // the real fill as soon as the poll resolves; the reduce path's own
        // min(ownQty, brokerQty) clamp already protects against over-closing
        // in the meantime, since it never trusts the ledger past what the
        // broker book actually shows.
        // Snapshot entry + LTP now so a reduce can bank the closed slice's
        // MTM into fill.bookedPnl (the pin moves off this strike on a roll).
        // The entry is this row's OWN (legOwnEntry: its stamp, the broker
        // average only for a legacy row with none) — the broker's buyAvg /
        // sellAvg is pooled across every row and trade on the contract
        // (2026-10-01 audit). Both slots carry it; mtmForQty picks by netQty.
        const ownEntry = live ? legOwnEntry(row, leg, live) : (Number(leg === 'CE' ? row.fill?.ceEntry : row.fill?.peEntry) || 0);
        const bookedSnap = opts.reduce ? {
          netQty,
          buyAvg: ownEntry,
          sellAvg: ownEntry,
          ltp: Number(leg === 'CE' ? live?.ltpCe : live?.ltpPe) || 0,
        } : null;
        // Opening: the LTP right before this order went out is this fill's
        // own entry-price estimate — stamped into fill.ceEntry/peEntry so a
        // shared-strike row's SL × entry side has a cost basis scoped to
        // only what THIS row itself opened (see FocusRowFill.ceEntry).
        // A strikeOverride open (shift / SL roll) targets a different strike
        // than rowLive's LTP describes, so quote the strike actually sold.
        const openEntryPx = opts.reduce ? 0
          : opts.strikeOverride != null
            ? simQuote(u, expiry, Number(strike), leg)
            : Number(leg === 'CE' ? live?.ltpCe : live?.ltpPe) || 0;
        const applyFill = (filled: number) => {
          if (filled < quantity) {
            addToast('error', `${what}: partial fill`,
              `Requested ${quantity}, broker confirms ${filled} filled — ledger updated to match`);
          }
          let bookedDelta = 0;
          let markOk = true;
          if (opts.reduce && filled > 0 && bookedSnap) {
            if (canMarkMtm({ ...bookedSnap, qty: filled })) {
              bookedDelta = mtmForQty({ ...bookedSnap, qty: filled });
            } else if (opts.awaitFill) {
              // Qty still updates below so the ledger matches the book; shift
              // must not reopen/move pin without a bankable mark.
              markOk = false;
            }
          }
          // Exit All that FULLY filled also drops any ledger drift above what
          // the broker held (quantity was clamped to the book). One that did
          // not must only drop what filled: zeroing the whole leg on a
          // rejected/unconfirmed close left a live short untracked, with no
          // stop watching it.
          const delta = opts.reduce
            ? (opts.all && filled >= quantity ? -pageOwn : -filled)
            : filled;
          if (filled < quantity) {
            unconfirmedOrderRef.current.set(`${row.id}:${leg}`, {
              kind: opts.reduce ? 'close' : 'open',
              strike: Number(strike),
              entryPx: openEntryPx,
              orb: opts.reduce ? null : (opts.orb ?? null),
              rowId: row.id, leg,
              orderId: j.order_id ? String(j.order_id) : null,
              securityId: securityId ? String(securityId) : null,
              symbol: symbol ? String(symbol) : null,
              product: rawProduct,
              netBefore: netQty,
              requested: quantity,
              filled,
              side,
              snap: bookedSnap ?? { netQty, buyAvg: 0, sellAvg: 0, ltp: 0 },
              ts: Date.now(), lastCheck: Date.now(), lastToast: Date.now(),
            });
          }
          adjustFillQty(row.id, leg, delta,
            opts.reduce ? undefined : Number(strike), bookedDelta, openEntryPx, opts.reduce ? undefined : opts.orb);
          // The close booked at the LTP snapshot; swap in the order's traded
          // average once Dhan reports it.
          if (opts.reduce && filled > 0 && bookedDelta !== 0 && bookedSnap && broker === 'dhan' && j.order_id) {
            void rebaseBookedOnTradedPrice(row.id, String(j.order_id), bookedSnap.netQty < 0, bookedSnap.ltp, filled);
          }
          // AlgoTest "Tgt/SL Ref Price: Traded Price" — re-base this fill's
          // share of the entry on what the broker actually filled at.
          // A shift's reopen (strikeOverride) always re-bases on the traded price: the stops and Pair × measure
          // from this leg's real fill, not the LTP quoted a moment before the order.
          if (!opts.reduce && filled > 0 && (row.refPrice === 'traded' || opts.strikeOverride != null) && broker === 'dhan' && j.order_id) {
            void rebaseEntryOnTradedPrice(row.id, leg, String(j.order_id), openEntryPx, filled);
          }
          return filled >= quantity && markOk;
        };
        if (opts.awaitFill) {
          const filled = await confirmLegFillQty(
            u, expiry, leg, strike, rawProduct, netQty, side, quantity,
            { maxWaitMs: 5000, strict: true },
          );
          pollPositions();
          return applyFill(filled);
        }
        confirmLegFillQty(u, expiry, leg, strike, rawProduct, netQty, side, quantity).then(filled => {
          applyFill(filled);
        });
        pollPositions();
        return true;
      }
      addToast('error', `${what} order rejected`, j.error ?? 'Unknown broker error');
      return false;
    } catch (e) {
      addToast('error', `${what} order failed`, String(e));
      return false;
    }
  }

  /**
   * Swap an open's LTP entry estimate for the order's average traded price
   * (Dhan reports it on the order). Only this fill's share of a blended entry
   * moves: entry += (traded − estimate) × filled / held. Leaves the estimate in
   * place when the price never comes back (a missed read is not a reason to
   * guess). Stops and targets measure from the new entry on the next tick.
   */
  /** Average price of the outside BUY trade(s) that closed `qty` of this
   *  contract: today's Dhan trade book, minus the Focus Tool's own orders
   *  (FTS_ORDER_SOURCE correlationIds), since the leg opened, not already used
   *  for another row. Null unless a run of trades adds up to exactly `qty`
   *  (matchOutsideTrades). */
  async function outsideCloseExit(securityId: string, qty: number, openedAt: number): Promise<{ exitPrice: number; keys: string[] } | null> {
    try {
      const r = await fetch('/api/scalper/poll');
      const j = await r.json() as { success?: boolean; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] };
      if (!j.success || !Array.isArray(j.trades)) return null;
      const own = new Set((j.orders ?? [])
        .filter(o => String(o.correlationId ?? '').startsWith(FTS_ORDER_SOURCE))
        .map(o => String(o.orderId ?? '')));
      const trades = j.trades.map(normalizeTradeRow).filter((t): t is NormalizedTrade => t != null);
      // Only trades since this leg opened can be its close (that also skips the
      // tool's own untagged closes of earlier cycles), and a trade already
      // used to price another row's close is not used again.
      return matchOutsideTrades(trades, securityId, 'B', qty, Date.now(), own, usedOutsideTradeKeysRef.current, openedAt);
    } catch {
      return null;
    }
  }

  /** The close side of rebaseEntryOnTradedPrice: moves bookedPnl by the gap
   *  between the LTP the close was booked at and the order's traded average. */
  async function rebaseBookedOnTradedPrice(rowId: string, orderId: string, isShort: boolean, estimate: number, filled: number) {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(orderId)}`);
        const j = await r.json() as { success?: boolean; data?: { averageTradedPrice?: number } };
        const atp = Number(j.data?.averageTradedPrice) || 0;
        if (j.success && atp > 0) {
          const delta = closeRebaseDelta(isShort, estimate, atp, filled);
          if (delta !== 0) patchFill(rowId, f => ({ bookedPnl: (f.bookedPnl ?? 0) + delta }));
          return;
        }
      } catch { /* retry */ }
      await new Promise(res => setTimeout(res, 1000));
    }
  }

  async function rebaseEntryOnTradedPrice(rowId: string, leg: 'CE' | 'PE', orderId: string, estimate: number, filled: number) {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(orderId)}`);
        const j = await r.json() as { success?: boolean; data?: { averageTradedPrice?: number } };
        const atp = Number(j.data?.averageTradedPrice) || 0;
        if (j.success && atp > 0) {
          patchFill(rowId, f => {
            const held = Number(leg === 'CE' ? f.ceQty : f.peQty) || 0;
            const cur = Number(leg === 'CE' ? f.ceEntry : f.peEntry) || 0;
            if (!(held > 0)) return {};
            const next = cur > 0 && estimate > 0 ? cur + (atp - estimate) * Math.min(filled, held) / held
              : (held <= filled ? atp : cur);
            if (!(next > 0)) return {};
            return leg === 'CE' ? { ceEntry: next } : { peEntry: next };
          });
          return;
        }
      } catch { /* retry */ }
      await new Promise(res => setTimeout(res, 1000));
    }
  }

  /** A strike's live premium for paper fills — the WS tick when it is on this
   *  expiry, else the chain. The same precedence rowLive's LTP uses, but for
   *  ANY strike, so a sim strike-shift can fill the new strike too. 0 = none. */
  function simQuote(u: FocusUnderlying, expiry: string, strike: number, leg: 'CE' | 'PE'): number {
    const ws = focusWsBookForExpiry(focusWsQuotes?.[u], expiry)?.strikes?.[strikeKey(strike)];
    const fromWs = Number(leg === 'CE' ? ws?.ce?.ltp : ws?.pe?.ltp);
    if (fromWs > 0) return fromWs;
    const ch = chains[expKey(u, expiry)]?.oc?.[strikeKey(strike)];
    const fromChain = Number(leg === 'CE' ? ch?.ce : ch?.pe);
    return fromChain > 0 ? fromChain : 0;
  }

  /**
   * placeLeg for a SIM row: a paper fill at the leg's live LTP, written
   * straight into the row's own fill ledger. No broker call and no fill
   * confirmation — there is no book to confirm against, so the ledger IS the
   * position. Sized exactly like a real order (opens are lots × lot size,
   * reduces clamp to what this row holds), so the forward test reflects what
   * the real config would have done — minus slippage: LTP, not bid/ask.
   * Every fill is appended to the sim journal, which outlives the ledger.
   */
  function placeSimLeg(
    row: FocusRow,
    leg: 'CE' | 'PE',
    opts: { reduce: boolean; lots?: number; all?: boolean; strikeOverride?: number; orb?: FocusOrbStamp | null },
  ): boolean {
    const u = row.underlying;
    const expiry = row.expiry || expiries[u]?.[0] || '';
    const what = `SIM ${u} ${leg}`;
    // The freshest ledger, not the caller's snapshot: two quick reduces must
    // not both close the same paper quantity.
    const current = schedulerRef.current.config.rows.find(r => r.id === row.id) ?? row;
    const live = rowLive[row.id];
    const strike = opts.strikeOverride ?? (leg === 'CE' ? live?.ceStrike : live?.peStrike);
    const lotSize = lotSizes[u];
    if (!strike || !lotSize) {
      addToast('error', `${what} not filled`, 'Strike or lot size not resolved yet');
      return false;
    }
    const px = simQuote(u, expiry, strike, leg);
    if (!(px > 0)) {
      addToast('error', `${what} not filled`, `No live premium for ${strike} ${leg} yet`);
      return false;
    }
    const own = Number(leg === 'CE' ? current.fill?.ceQty : current.fill?.peQty) || 0;

    const journal = (side: 'BUY' | 'SELL', qty: number, booked: number) => {
      fetch('/api/focus-tool/sim-trades', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId: row.id, underlying: u, expiry, leg, strike, side, qty, price: px, booked }),
      }).catch(() => {});
    };

    if (opts.reduce) {
      if (own <= 0) {
        if (opts.all) return true;
        addToast('error', `${what} already flat`, 'Nothing to reduce');
        return false;
      }
      const qty = opts.all ? own : Math.min((opts.lots ?? 1) * lotSize, own);
      const entry = Number(leg === 'CE' ? current.fill?.ceEntry : current.fill?.peEntry) || 0;
      // Short leg: bought back at px against the paper entry.
      const booked = entry > 0 ? (entry - px) * qty : 0;
      adjustFillQty(row.id, leg, -qty, undefined, booked);
      journal('BUY', qty, booked);
      addToast('success', `SIM BUY ${qty} ${strike} ${leg} @ ${px.toFixed(2)}`,
        `Booked ${booked >= 0 ? '+' : ''}₹${booked.toFixed(0)}`);
      return true;
    }
    const qty = (opts.lots ?? 1) * lotSize;
    adjustFillQty(row.id, leg, qty, Number(strike), 0, px, opts.orb);
    journal('SELL', qty, 0);
    addToast('success', `SIM SELL ${qty} ${strike} ${leg} @ ${px.toFixed(2)}`);
    return true;
  }

  /**
   * Poll until this row's close at `strike` has fully landed.
   *
   * `targetRemaining` is how much of the broker position may still be open
   * after OUR close (0 when we alone hold the strike; brokerQty − ownQty when
   * another row/strategy shares it). Success only when remaining ≤ that floor
   * — a partial fill of the close returns null, never a fraction. Strike
   * shifts must not reopen until this returns a number.
   */
  async function verifyLegClosed(
    u: FocusUnderlying, expiry: string, leg: 'CE' | 'PE', strike: number, closedQty: number, product: string,
    opts: { maxWaitMs?: number; targetRemaining?: number; brokerQtyBefore?: number } = {},
  ): Promise<number | null> {
    const maxWaitMs = opts.maxWaitMs ?? 4000;
    const targetRemaining = Math.max(0, opts.targetRemaining ?? 0);
    const brokerQtyBefore = Math.max(closedQty, Number(opts.brokerQtyBefore) || closedQty);
    const ref = lookups[expKey(u, expiry)]?.strikes?.[strikeKey(strike)];
    const id = leg === 'CE' ? ref?.ceId : ref?.peId;
    const sym = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
    if (broker === 'dhan' ? !id : !sym) return null;

    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      await new Promise(r => setTimeout(r, 400));
      const rows = await fetchPositionsNow();
      if (rows) {
        const candidates = broker === 'dhan'
          ? rows.filter(p => String(p.securityId) === String(id))
          : rows.filter(p => String(p.tradingSymbol) === sym);
        // Only read the same product the close was placed against — a
        // same-strike position under a different product must not be
        // mistaken for this leg's own remaining quantity.
        const pos = product
          ? candidates.find(p => positionProduct(p as unknown as Record<string, unknown>) === product)
          : (candidates.length === 1 ? candidates[0] : undefined);
        const remaining = Math.abs(Number(pos?.netQty ?? 0));
        const observedClosed = Math.max(0, brokerQtyBefore - remaining);
        // Need BOTH: book at/under the shared-strike floor AND enough qty
        // left the book to cover OUR close (floor alone is not proof).
        if (remaining <= targetRemaining && observedClosed >= closedQty) return closedQty;
        // Incomplete close: keep waiting. Never report a partial amount —
        // callers (strike shift) must not reopen on a fraction.
        if (Date.now() >= deadline) return null;
      } else if (Date.now() >= deadline) {
        return null;
      }
    }
  }

  /**
   * Poll until THIS ROW'S OWN ledger reports flat on both legs — NOT until
   * the broker's raw book at its strikes reaches zero. Broker netQty can
   * never reach zero while a sibling row (two straddles parked on the same
   * ATM strike is a legitimate shape) or an untracked residual still holds
   * quantity at the same security, which used to leave a row's own
   * successful close reported as "unconfirmed" indefinitely — stuck at its
   * pre-close status forever, with only a toast as any trace.
   *
   * Ledger-based flatness (`rowFlat`) is only trustworthy once the closing
   * order's fill is CONFIRMED — callers MUST place the close with
   * `awaitFill: true` before calling this, or the ledger still shows the
   * pre-close qty on the very first check and this returns false even
   * though the close landed. Re-reads the row fresh off `schedulerRef` each
   * pass rather than a snapshot captured before the close, since
   * `adjustFillQty` updates asynchronously.
   */
  async function waitRowFlat(rowId: string, maxWaitMs = 4000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const currentRow = schedulerRef.current.config.rows.find(r => r.id === rowId);
      if (currentRow && rowFlat(currentRow)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 400));
    }
  }

  /**
   * The row's own Exit buttons. 'ALL' closes every leg this row trades,
   * sequentially so one rejection is reported against the leg it belongs to;
   * once the book confirms the row is flat the strike pin is dropped, the same
   * way an auto-exit drops it.
   */
  function handleManualExit(row: FocusRow, leg: 'CE' | 'PE' | 'ALL') {
    return runRowAction(row.id, async () => {
      logEvent('manual_exit', row, `manual: exit ${leg}`, { leg });
      // Exit All closes only legs this row holds. A leg it already closed
      // re-resolves to the live strike, and placeLeg's no-ledger fallback
      // would close whatever the broker shows there — another row's or a
      // manual position — unclamped.
      const legs = leg === 'ALL' ? legsOf(row).filter(l => rowOwnsLeg(row, l)) : [leg];
      // A single-leg Exit on the row's LAST open leg flattens the row — retire
      // it like Exit All does, or it stays 'entered' with a stale pin. Decided
      // up front: after the close, the ledger update lands asynchronously.
      const lastLeg = leg !== 'ALL' && !rowOwnsLeg(row, leg === 'CE' ? 'PE' : 'CE');
      // Concurrently, not one after the other. This is the panic button: legs
      // are independent orders against different contracts, and serialising
      // them made a straddle's second leg wait out the first's full round trip
      // (~60ms) for nothing. Each leg still reports its own rejection.
      // awaitFill so the ledger is confirmed-updated by the time waitRowFlat
      // reads it below.
      const accepted = await Promise.all(legs.map(l => placeLeg(row, l, { reduce: true, all: true, awaitFill: true })));
      // Each leg already reported its own rejection via placeLeg's own toast;
      // still short-circuit here so a rejected leg does not sit through the
      // full waitRowFlat timeout for a row that was never fully closed (same
      // guard autoExitRow applies to its own Promise.all above).
      if (leg === 'ALL' && !accepted.every(Boolean)) {
        addToast('error', 'Exit incomplete', `${row.underlying}: a leg was rejected — still open, check the position book`);
        return;
      }
      // Exit All ends the cycle outright, waiting re-entries included. A
      // single-leg Exit of the last open leg does not: a cost / momentum
      // re-entry still waiting on the OTHER leg keeps the row alive (cancel
      // it from its chip).
      const waiting = () => hasPendingReentry(schedulerRef.current.config.rows.find(r => r.id === row.id));
      if ((leg === 'ALL' || (lastLeg && accepted[0] && !waiting())) && await waitRowFlat(row.id)
        && (leg === 'ALL' || !waiting())) {
        updateRow(row.id, { status: 'exited', fill: undefined });
      }
    });
  }

  /**
   * Quick partial exit — the 25/50/75% chips below CE/PE. Sizing mirrors
   * Scalper/AdvancedScalper's own chips (`partialCloseChips`, round-down to
   * whole lots off the broker's net qty); placeLeg then re-clamps that lot
   * count against this row's own ledger, same as a full Exit does.
   */
  function handleManualExitPartial(row: FocusRow, leg: 'CE' | 'PE', pct: 25 | 50 | 75) {
    return runRowAction(row.id, async () => {
      logEvent('manual_exit_partial', row, `manual: exit ${pct}% of ${leg}`, { leg, pct });
      const u = row.underlying;
      const live = rowLive[row.id];
      const lotSize = lotSizes[u];
      if (!lotSize || !live) return;
      // Own contracts only — see the chips' own comment in the row views.
      const own = legOwnContracts(row, leg, live);
      if (!(own > 0)) return;
      const chip = partialCloseChips(own, lotSize, [pct]).find(c => c.pct === pct);
      if (!chip?.enabled) return;
      await placeLeg(row, leg, { reduce: true, lots: chip.lots, awaitFill: true });
    });
  }

  /**
   * Shift one leg's strike up or down by one listed step.
   *
   * All-or-nothing on an open leg: the full qty at the current strike must
   * close and confirm flat before anything opens at the new strike and before
   * the pin/config moves. A partial close aborts with the pin left on the old
   * strike. Flat legs only move the config (ATM ±1 or PREMIUM target = new LTP),
   * mirrored when linked and the other leg is flat.
   */
  async function handleShiftStrike(row: FocusRow, leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') {
    if (busyRows.has(row.id)) return;
    logEvent('manual_shift', row, `manual: shift ${leg} ${direction}`, { leg, direction });
    const u = row.underlying;
    // A shift only moves the strike, never the expiry — always this row's own.
    const expiry = row.expiry || expiries[u]?.[0] || '';
    const step = STRIKE_STEP[u];
    const live = rowLive[row.id] ?? EMPTY_ROW_LIVE;
    const currStrike = leg === 'CE' ? live.ceStrike : live.peStrike;
    if (currStrike == null) {
      addToast('error', 'Cannot shift', `${leg} strike not resolved yet`);
      return;
    }
    const newStrike = direction === 'UP' ? currStrike + step : currStrike - step;
    const newRef = lookups[expKey(u, expiry)]?.strikes?.[strikeKey(newStrike)];
    const hasContract = broker === 'dhan' ? !!(leg === 'CE' ? newRef?.ceId : newRef?.peId)
                                           : !!(leg === 'CE' ? newRef?.ceSymbol : newRef?.peSymbol);
    // A sim row trades no contract — it only needs a premium to fill at.
    if (!isSimRow(row) && !hasContract) {
      addToast('error', 'Cannot shift', `No ${broker} contract for ${newStrike} ${leg}`);
      return;
    }

    await runRowAction(row.id, async () => {
      const pos = leg === 'CE' ? live.cePosition : live.pePosition;
      const netQty = Number(pos?.netQty ?? 0);
      const owns = rowOwnsLeg(row, leg);
      // Only roll a position this row opened. A coincidental book at the
      // resolved strike is someone else's — moving THIS row's offset must
      // not close and reopen it.
      if (isSimRow(row) && netQty !== 0 && owns) {
        // Paper roll: same close-then-reopen, same lots, but there is no book
        // to verify against — the ledger is the position. Check the new
        // strike has a premium BEFORE closing, so a roll can't strand the
        // row flat on a strike it then fails to reopen.
        const lotSize = lotSizes[u];
        const ledgerQty = (leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty) ?? 0;
        if (!lotSize || !(ledgerQty > 0) || ledgerQty % lotSize !== 0) {
          addToast('error', 'Cannot shift', `${currStrike} ${leg} paper qty ${ledgerQty} is not a whole-lot multiple`);
          return;
        }
        if (!(simQuote(u, expiry, newStrike, leg) > 0)) {
          addToast('error', 'Cannot shift', `No live premium for ${newStrike} ${leg} yet`);
          return;
        }
        if (!await placeLeg(row, leg, { reduce: true, all: true })) {
          addToast('error', 'Shift aborted', `${currStrike} ${leg} paper close failed — left on this strike`);
          return;
        }
        if (!await placeLeg(row, leg, { reduce: false, lots: ledgerQty / lotSize, strikeOverride: newStrike })) {
          addToast('error', 'Shift incomplete', `Closed ${currStrike} ${leg} but the ${newStrike} ${leg} paper fill failed — reopen manually`);
          return;
        }
      } else if (netQty !== 0 && owns) {
        const lotSize = lotSizes[u];
        if (!lotSize) {
          addToast('error', 'Cannot shift', `Lot size for ${u} not resolved yet`);
          return;
        }
        // All-or-nothing: close THIS row's full qty at the old strike, confirm
        // OUR fill + book floor, then reopen the same lots. Never move the pin
        // on a partial close or an unmarked bookedPnl.
        const brokerQty = Math.abs(netQty);
        const ledgerQty = leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty;
        const closeQty = ledgerQty && ledgerQty > 0 ? Math.min(ledgerQty, brokerQty) : brokerQty;
        if (!(closeQty > 0) || closeQty % lotSize !== 0) {
          addToast('error', 'Cannot shift',
            `${currStrike} ${leg} qty ${closeQty} is not a whole-lot multiple of ${lotSize}`);
          return;
        }
        const lots = closeQty / lotSize;
        const targetRemaining = Math.max(0, brokerQty - closeQty);
        const markSnap = {
          netQty,
          buyAvg: Number(pos?.buyAvg) || 0,
          sellAvg: Number(pos?.sellAvg) || 0,
          ltp: Number(leg === 'CE' ? live.ltpCe : live.ltpPe) || 0,
          qty: closeQty,
        };
        if (!canMarkMtm(markSnap)) {
          addToast('error', 'Cannot shift',
            `${currStrike} ${leg}: no live premium/avg to bank P&L — wait for a quote and retry`);
          return;
        }

        const closedOk = await placeLeg(row, leg, { reduce: true, all: true, awaitFill: true });
        if (!closedOk) {
          addToast('error', 'Shift aborted', `${currStrike} ${leg} close did not fully fill — position left on this strike`);
          return;
        }

        const product = positionProduct(pos as unknown as Record<string, unknown>);
        const closedUnits = await verifyLegClosed(
          u, expiry, leg, currStrike, closeQty, product,
          { targetRemaining, brokerQtyBefore: brokerQty },
        );
        const afterRows = await fetchPositionsNow();
        if (!afterRows) {
          addToast('error', 'Shift halted — old strike not fully closed',
            `Could not re-read positions after closing ${currStrike} ${leg} — no new leg opened.`);
          return;
        }
        const afterRef = lookups[expKey(u, expiry)]?.strikes?.[strikeKey(currStrike)];
        const afterId = leg === 'CE' ? afterRef?.ceId : afterRef?.peId;
        const afterSym = leg === 'CE' ? afterRef?.ceSymbol : afterRef?.peSymbol;
        const afterPos = broker === 'dhan'
          ? afterRows.find(p => String(p.securityId) === String(afterId)
            && positionProduct(p as unknown as Record<string, unknown>) === product)
          : afterRows.find(p => String(p.tradingSymbol) === afterSym
            && positionProduct(p as unknown as Record<string, unknown>) === product);
        const brokerAfter = Math.abs(Number(afterPos?.netQty ?? 0));
        if (
          closedUnits == null
          || !shiftMayReopen(closeQty, closedUnits)
          || !shiftCloseConfirmed({
            requestedClose: closeQty,
            filled: closeQty, // placeLeg awaitFill already required full fill
            brokerQtyAfter: brokerAfter,
            targetRemaining,
          })
        ) {
          addToast('error', 'Shift halted — old strike not fully closed',
            `Could not confirm ${currStrike} ${leg} flat for ${closeQty} qty — no new leg opened. Check the position book and retry.`);
          return;
        }

        const opened = await placeLeg(row, leg, {
          reduce: false, lots, strikeOverride: newStrike, awaitFill: true,
        });
        if (!opened) {
          addToast('error', 'Shift incomplete', `Closed ${currStrike} ${leg}; the ${newStrike} ${leg} sell was rejected or not confirmed yet. A late fill is picked up automatically — check the order book before reopening by hand, or you will double it`);
          return;
        }
      }

      // Move the row's own config so it keeps resolving to the new strike —
      // mirrors StrikeEditor's linked-offset-negation logic (setLeg) so a
      // shift on a linked row keeps CE/PE as a symmetric strangle. The mirror
      // is suppressed when the OTHER leg holds a position: only the shifted
      // leg's position is rolled here, so moving the other leg's config would
      // leave its live position at a strike this row no longer looks up —
      // untracked and unexitable from this page (see StrikeEditor's note).
      const otherLeg = leg === 'CE' ? 'PE' : 'CE';
      const otherOpen = rowOwnsLeg(row, otherLeg);
      const linked = (row.linked ?? true) && !otherOpen;
      if ((row.linked ?? true) && otherOpen) {
        addToast('error', 'Linked leg kept its strike', `${otherLeg} holds an open position — only ${leg} was rolled`);
      }
      if (row.strikeMode === 'PREMIUM') {
        const oc = chains[expKey(u, expiry)]?.oc;
        const newLtp = oc?.[strikeKey(newStrike)]?.[leg === 'CE' ? 'ce' : 'pe'];
        if (!(Number(newLtp) > 0)) {
          // Book/pin already moved (fill ledger stamped newStrike). Keep the
          // old ₹ target rather than aborting — user can retarget manually.
          addToast('error', 'Strike shifted — set ₹ target',
            `Position is at ${newStrike} ${leg}; no live premium yet to auto-update the target`);
        } else {
          const val = String(newLtp);
          const patch: Partial<FocusRow> = leg === 'CE' ? { cePremium: val } : { pePremium: val };
          if (linked) { if (leg === 'CE') patch.pePremium = val; else patch.cePremium = val; }
          updateRow(row.id, patch);
        }
      } else {
        const curOffset = leg === 'CE' ? (row.ceOffset ?? 0) : (row.peOffset ?? 0);
        const newOffset = curOffset + (direction === 'UP' ? 1 : -1);
        const patch: Partial<FocusRow> = leg === 'CE' ? { ceOffset: newOffset } : { peOffset: newOffset };
        if (linked) { if (leg === 'CE') patch.peOffset = -newOffset; else patch.ceOffset = -newOffset; }
        updateRow(row.id, patch);
      }
    });
  }

  /** Serialise a row's orders and disable its buttons while one is in flight. */
  // ── Limit ladder ───────────────────────────────────────────────────────
  // Resting SELL limits on an open short leg at +5…30% of its price at click. A fill
  // sells the leg further, so it is credited to the row's fill ledger (the stops and
  // exits size off that ledger) as it lands. Dhan, REAL rows only. Cancelled whenever
  // the leg is fully exited or rolled (placeLeg), so a late fill can never open a
  // position nothing is watching.
  const ladderCreditedRef = useRef<Map<string, number>>(new Map());
  const ladderBusyRef = useRef(false);

  function patchLadder(rowId: string, fn: (cur: FocusLadderOrder[]) => FocusLadderOrder[]) {
    setConfig(prev => {
      const nextRows = prev.rows.map(r => r.id === rowId ? { ...r, ladder: fn(r.ladder ?? []), updatedAt: new Date().toISOString() } : r);
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
  }

  /** Settle one ladder order against the broker: credit new fills, drop it once terminal. */
  async function reconcileLadderOrder(rowId: string, o: FocusLadderOrder): Promise<void> {
    try {
      const r = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(o.orderId)}`);
      const j = await r.json() as { success?: boolean; data?: { orderStatus?: string; filledQty?: number; averageTradedPrice?: number } };
      if (!j.success || !j.data) return;   // unreadable: keep it, retry next tick
      const status = String(j.data.orderStatus ?? '').toUpperCase();
      const ladderRow = schedulerRef.current.config.rows.find(x => x.id === rowId);
      if (!ladderRow) return;
      // The order book counts MCX in lots; the ledger is in page units (barrels).
      const filled = toInternalQty(ladderRow.underlying, Number(j.data.filledQty) || 0);
      const done = Math.max(o.credited, ladderCreditedRef.current.get(o.orderId) ?? 0);
      const delta = filled - done;
      if (delta > 0) {
        ladderCreditedRef.current.set(o.orderId, filled);
        const px = Number(j.data.averageTradedPrice) || o.price;
        adjustFillQty(rowId, o.leg, delta, o.strike, 0, px);
        const row = schedulerRef.current.config.rows.find(x => x.id === rowId);
        addToast('success', `Ladder fill: SELL ${delta} ${o.strike} ${o.leg} @ ${px.toFixed(2)}`, `+${o.pct}% limit`);
        if (row) logEvent('ladder_fill', row, `limit +${o.pct}% filled`, { leg: o.leg, strike: o.strike, qty: delta, price: px, orderId: o.orderId });
      }
      const terminal = ['TRADED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(status);
      if (terminal) {
        patchLadder(rowId, cur => cur.filter(x => x.orderId !== o.orderId));
        ladderCreditedRef.current.delete(o.orderId);
      } else if (delta > 0) {
        patchLadder(rowId, cur => cur.map(x => x.orderId === o.orderId ? { ...x, credited: filled } : x));
      }
    } catch { /* retry next tick */ }
  }

  async function reconcileLadder() {
    if (ladderBusyRef.current) return;
    ladderBusyRef.current = true;
    try {
      for (const row of schedulerRef.current.config.rows) {
        for (const o of row.ladder ?? []) await reconcileLadderOrder(row.id, o);
      }
    } finally { ladderBusyRef.current = false; }
  }
  const reconcileLadderRef = useRef(reconcileLadder);
  reconcileLadderRef.current = reconcileLadder;
  const hasLadder = config.rows.some(r => (r.ladder?.length ?? 0) > 0);
  useEffect(() => {
    if (!hasLadder || isLeader !== true) return;
    const t = setInterval(() => { void reconcileLadderRef.current(); }, 3000);
    return () => clearInterval(t);
  }, [hasLadder, isLeader]);

  /** Cancel a row's resting ladder orders (one leg, one order, or all). Never blocks an exit on failure. */
  async function cancelLadderOrders(rowId: string, leg?: 'CE' | 'PE', orderId?: string): Promise<void> {
    const row = schedulerRef.current.config.rows.find(r => r.id === rowId);
    const targets = (row?.ladder ?? []).filter(o => (!leg || o.leg === leg) && (!orderId || o.orderId === orderId));
    if (targets.length === 0) return;
    await Promise.all(targets.map(async o => {
      try {
        const r = await fetch('/api/scalper/orders', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: o.orderId, broker: 'dhan' }),
        });
        const j = await r.json() as { success?: boolean };
        if (!j.success) addToast('error', `Could not cancel ${o.strike} ${o.leg} +${o.pct}% limit`, 'Cancel it in the broker order book before it fills');
      } catch {
        addToast('error', `Could not cancel ${o.strike} ${o.leg} +${o.pct}% limit`, 'Cancel it in the broker order book before it fills');
      }
      await reconcileLadderOrder(rowId, o);   // credit any fill that beat the cancel
    }));
    if (row) logEvent('ladder_cancel', row, `cancelled ${targets.length} limit order(s)`, { leg: leg ?? 'ALL' });
  }

  async function placeLadderOrder(row: FocusRow, leg: 'CE' | 'PE', pct: number, lots: number): Promise<void> {
    const what = `${row.underlying} ${leg}`;
    if (isSimRow(row)) { addToast('error', 'Limit ladder not available', 'SIM rows have no broker orders — it is for REAL rows'); return; }
    if (broker !== 'dhan') { addToast('error', 'Limit ladder not available', 'Dhan only for now'); return; }
    if (!liveRealMoney) { addToast('error', 'Dry run', 'Enable LIVE · REAL MONEY to place orders'); return; }
    if (!hasAuthenticatedBroker) { addToast('error', 'No broker logged in', 'Log in to Dhan before placing orders'); return; }
    const live = rowLive[row.id];
    const pos = leg === 'CE' ? live?.cePosition : live?.pePosition;
    const strike = leg === 'CE' ? live?.ceStrike : live?.peStrike;
    const ltp = Number(leg === 'CE' ? live?.ltpCe : live?.ltpPe) || 0;
    const lotSize = lotSizes[row.underlying];
    if (!rowOwnsLeg(row, leg) || !(Number(pos?.netQty) < 0)) { addToast('error', `${what} order not sent`, 'The leg is not an open short'); return; }
    if (!strike || !(ltp > 0) || !lotSize) { addToast('error', `${what} order not sent`, 'Strike, price or lot size not resolved yet'); return; }
    if ((row.ladder ?? []).some(o => o.leg === leg && o.strike === strike && o.pct === pct)) {
      addToast('error', `${what} +${pct}% already placed`, 'Cancel it first to move it'); return;
    }
    const expiry = row.expiry || expiries[row.underlying]?.[0] || '';
    const ref = lookups[expKey(row.underlying, expiry)]?.strikes?.[strikeKey(strike)];
    const securityId = leg === 'CE' ? ref?.ceId : ref?.peId;
    if (!securityId) { addToast('error', `${what} order not sent`, `No Dhan contract for ${strike} ${leg}`); return; }
    const group = config.groups.find(g => g.underlying === row.underlying);
    const product = closeOrderProduct(broker, PRODUCT_ALIAS[group?.product ?? 'INTRADAY'][broker]);
    if (!product) { addToast('error', `${what} order not sent`, 'Unsupported product'); return; }
    const price = Number(ladderPrice(ltp, pct).toFixed(2));
    const quantity = Math.max(1, Math.round(lots)) * lotSize;
    if (!(orderQuantity(row.underlying, quantity) > 0)) { addToast('error', `${what} order not sent`, 'Quantity is under one lot'); return; }
    try {
      const res = await fetch('/api/scalper/fast-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ securityId, quantity: orderQuantity(row.underlying, quantity), side: 'SELL', orderType: 'LIMIT', price, exchangeSegment: orderExchange(broker, row.underlying), ...product.fields, source: FTS_ORDER_SOURCE }),
      });
      const j = await res.json() as { success?: boolean; order_id?: string; error?: string };
      if (!j.success || !j.order_id) { addToast('error', `${what} limit rejected`, j.error ?? 'Unknown broker error'); return; }
      patchLadder(row.id, cur => [...cur, { orderId: String(j.order_id), leg, strike, pct, price, qty: quantity, credited: 0, placedAt: Date.now() }]);
      addToast('success', `SELL LIMIT ${quantity} ${strike} ${leg} @ ${price.toFixed(2)}`, `+${pct}% over ${ltp.toFixed(2)} · order ${j.order_id}`);
      logEvent('ladder_place', row, `limit +${pct}% over ${ltp}`, { leg, strike, qty: quantity, price, orderId: String(j.order_id) });
    } catch (e) {
      addToast('error', `${what} limit failed`, String(e));
    }
  }

  // ── Portfolio Greeks (on demand) ───────────────────────────────────────
  // Every open leg of every row, priced through the central payoff library from the leg's live
  // premium (same numbers as the payoff charts and Multi-Leg Focus). Grouped by index, since
  // deltas in different indices are not additive. Follows each row's own fill ledger, not the
  // broker's netted position, so rows sharing a contract each count their own share.
  const [greeksSnap, setGreeksSnap] = useState<{
    at: Date;
    groups: { underlying: FocusUnderlying; spot: number; result: ReturnType<typeof computeBasketGreeks>; labels: Record<string, string> }[];
  } | null>(null);
  function runPortfolioGreeks() {
    const groups: NonNullable<typeof greeksSnap>['groups'] = [];
    for (const u of UNDERLYINGS) {
      const legs: GreekLeg[] = [];
      const marks: Record<string, number> = {};
      const labels: Record<string, string> = {};
      for (const row of config.rows) {
        if (row.underlying !== u) continue;
        const live = rowLive[row.id];
        if (!live) continue;
        for (const leg of legsOf(row)) {
          if (!rowOwnsLeg(row, leg)) continue;
          const units = legOwnContracts(row, leg, live);
          const strike = leg === 'CE' ? live.ceStrike : live.peStrike;
          if (!(units > 0) || !strike) continue;
          const pos = leg === 'CE' ? live.cePosition : live.pePosition;
          const id = `${row.id}:${leg}`;
          legs.push({
            legId: id, side: Number(pos?.netQty) > 0 ? 'B' : 'S', option: leg, strike,
            expiry: row.expiry || expiries[u]?.[0] || '', units,
          });
          const ltp = Number(leg === 'CE' ? live.ltpCe : live.ltpPe) || 0;
          if (ltp > 0) marks[id] = ltp;
          labels[id] = `${isSimRow(row) ? 'SIM ' : ''}${row.id.slice(-4)}`;
        }
      }
      if (legs.length === 0) continue;
      const result = computeBasketGreeks(legs, { spot: spots[u] ?? 0, markOf: gl => marks[gl.legId], fallbackIv: 0.15 });
      groups.push({ underlying: u, spot: spots[u] ?? 0, result, labels });
    }
    setGreeksSnap({ at: new Date(), groups });
  }

  /**
   * Audit journal entry (debug/focus_tool_events.jsonl): what happened to a row, the
   * rule behind it and the prices at that moment. Never blocks or throws.
   */
  function logEvent(kind: string, row: FocusRow, reason: string, extra: Record<string, unknown> = {}) {
    const live = rowLive[row.id];
    postFocusEvent({
      kind, rowId: row.id, underlying: row.underlying, expiry: row.expiry || expiries[row.underlying]?.[0] || '',
      mode: isSimRow(row) ? 'sim' : 'real', status: row.status, reason,
      spot: spots[row.underlying] ?? null,
      ceStrike: live?.ceStrike ?? null, peStrike: live?.peStrike ?? null,
      ltpCe: live?.ltpCe ?? null, ltpPe: live?.ltpPe ?? null,
      ceQty: row.fill?.ceQty ?? null, peQty: row.fill?.peQty ?? null,
      ceEntry: row.fill?.ceEntry ?? null, peEntry: row.fill?.peEntry ?? null,
      ...extra,
    });
  }

  /**
   * Adds `lots` to every open leg of a row — CE then PE, strictly one after the other.
   * If the first leg's order does not go through, the second is NOT sent, so a failure
   * never leaves the straddle lopsided by more than the one leg that did fill; a
   * half-done add is called out in the toast.
   */
  function addLotsToAllLegs(row: FocusRow, lots: number) {
    return runRowAction(row.id, async () => {
      logEvent('add_all_legs', row, `manual: add ${lots} lot(s) to every open leg`, { lots });
      const legs = legsOf(row).filter(l => rowOwnsLeg(row, l));
      if (legs.length === 0) { addToast('error', 'Nothing to add to', 'This row has no open leg'); return; }
      const added: string[] = [];
      for (const leg of legs) {
        const ok = await placeLeg(row, leg, { reduce: false, lots });
        if (!ok) {
          addToast('error', added.length ? 'Add lots incomplete — row is lopsided' : 'Add lots failed',
            added.length ? `${added.join(', ')} got ${lots} more lot(s); ${leg} did NOT. Fix ${leg} by hand.` : `${leg} order did not go through; nothing was added.`);
          return;
        }
        added.push(leg);
      }
      addToast('success', `Added ${lots} lot(s) to ${added.join(' + ')}`, `${row.underlying} row`);
    });
  }

  async function runRowAction(rowId: string, fn: () => Promise<unknown>) {
    if (busyRows.has(rowId)) return;
    setBusyRows(prev => new Set(prev).add(rowId));
    try { await fn(); }
    finally {
      setBusyRows(prev => { const next = new Set(prev); next.delete(rowId); return next; });
    }
  }

  /**
   * The live tracking loop: whenever a row's resolved data changes (spot,
   * premiums or broker positions all flow through `rowLive`), check every row
   * that actually holds a position for a level-exit breach and square it off
   * at market.
   *
   * Gated on LIVE · REAL MONEY the same way placeLeg is — a dry run must not
   * spam auto-exit toasts for breaches it can never act on. This only runs
   * while the Focus Tool tab stays open; there is no background worker behind
   * this page, so closing the tab (or losing the connection) pauses watching
   * exactly like it pauses everything else here.
   */
  // Latest values for the scheduler's interval callback. Kept in a ref so the
  // interval reads current data without the effect re-subscribing (and
  // resetting its own timer) on every tick of live market data.
  // The risk fields come from the control strip's own state, not from
  // `config` — those are the values currently on screen, and a user who
  // toggles Risk on expects it to be watching straight away rather than only
  // after a separate Save.
  const schedulerSnapshot = {
    config, rowLive, spots, toolPnl, lockMtm, peakMtm, liveRealMoney,
    riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees,
  };
  const schedulerRef = useRef(schedulerSnapshot);
  schedulerRef.current = schedulerSnapshot;
  const expiriesRef = useRef(expiries);
  expiriesRef.current = expiries;

  /**
   * The row's running peak P&L / premium profit this cycle — what the trailing
   * options ratchet on. Cached per ledger (a new cycle starts a new ledger, so a
   * new peak) and saved to the ledger at most every 5s, so a reload resumes from
   * it instead of re-arming a lock the market has already passed.
   */
  function trackOverallPeak(row: FocusRow, live: RowLive): { pnl: number; pts: number } {
    if (!row.overallTarget?.enabled && !row.overallTrail?.enabled) return { pnl: 0, pts: 0 };
    const key = `${row.id}:${row.fill?.ts ?? ''}`;
    const hit = overallPeakRef.current[key];
    const prev = hit ?? { pnl: row.fill?.peakPnl, pts: row.fill?.peakPts, wrote: 0 };
    const next = nextOverallPeak(prev, overallProgress(row, live, undefined, live.lotSize));
    const entry = { ...next, wrote: hit?.wrote ?? 0 };
    // Compared with what is SAVED, not with the cache: a peak made inside the
    // 5s window must still be written once it has passed, even if it never rises again.
    const unsaved = next.pnl !== (row.fill?.peakPnl ?? 0) || next.pts !== (row.fill?.peakPts ?? 0);
    if (row.fill && unsaved && Date.now() - entry.wrote > 5_000) {
      entry.wrote = Date.now();
      patchFill(row.id, () => ({ peakPnl: next.pnl, peakPts: next.pts }));
    }
    overallPeakRef.current[key] = entry;
    return next;
  }

  /**
   * AlgoTest "Re-entry on Overall SL / Target": once the row is confirmed flat
   * after an overall exit, start a new cycle — re-arm it with a fresh ledger (so
   * strikes resolve at the current ATM and the peak and baselines restart),
   * counted against its max of 5. `overallReMode` tells the entry how: ASAP opens
   * every leg at once, MOMENTUM goes through each leg's Simple Momentum. Returns
   * false when the row should just retire.
   */
  function reenterAfterOverall(row: FocusRow, reason: string): boolean {
    const kind = overallExitKind(reason);
    if (!kind) return false;
    const snap = schedulerRef.current;
    const fresh = snap.config.rows.find(r => r.id === row.id) ?? row;
    const group = snap.config.groups.find(g => g.underlying === fresh.underlying);
    const d = evaluateOverallReentry(fresh, kind, {
      nowHm: istHm(), product: group?.product ?? 'INTRADAY', groupEnabled: !!group?.enabled,
      backstopHm: UNDERLYING_META[fresh.underlying].backstopHm,
    });
    const tag = `${isSimRow(fresh) ? 'SIM ' : ''}${fresh.underlying}`;
    if (!d.enter) {
      if ((kind === 'sl' ? fresh.overallReSl : fresh.overallReTgt)?.enabled) addToast('error', `${tag} no re-entry`, d.reason);
      return false;
    }
    const wantedAt = rowExitWantedRef.current.get(row.id);
    if (wantedAt != null && Date.now() - wantedAt < 5_000) return false;
    autoEnteringRef.current.delete(row.id);
    for (const leg of ['CE', 'PE']) { delete simMomRef.current[`${row.id}:${leg}`]; putMomStatus(`${row.id}:${leg}`, ''); }
    const countKey = kind === 'sl' ? 'overallReSlCount' : 'overallReTgtCount';
    const count = ((kind === 'sl' ? fresh.overallReSlCount : fresh.overallReTgtCount) ?? 0) + 1;
    const cfg = kind === 'sl' ? fresh.overallReSl : fresh.overallReTgt;
    updateRow(row.id, { status: 'armed', fill: undefined, overallReMode: d.mode, [countKey]: count });
    addToast('success', `${tag} re-entry ${count}/${cfg?.max}`,
      `RE ${d.mode.toUpperCase()} after overall ${kind === 'sl' ? 'SL' : 'target'}: re-opening at the current ATM`);
    return true;
  }

  /**
   * Square off every leg of one row at market and mark it exited. Deduped by
   * `autoExitingRef` so a rule that stays breached across ticks (they all do)
   * cannot fire a second time while the first exit is still in flight.
   */
  function autoExitRow(row: FocusRow, reason: string) {
    if (autoExitingRef.current.has(row.id)) return;
    const closeUnsettled = unconfirmedOrderRef.current.has(`${row.id}:CE`)
      || unconfirmedOrderRef.current.has(`${row.id}:PE`);
    if (busyRows.has(row.id) || (legExitsInFlightRef.current.get(row.id) ?? 0) > 0 || closeUnsettled) {
      // Something else holds the row (a leg exit/roll, a manual order). The
      // rules re-fire this every tick while the breach lasts, so it runs once
      // the row frees up — but record it, so an SL roll finishing in the
      // meantime doesn't sell a fresh leg into a row about to be flattened.
      rowExitWantedRef.current.set(row.id, Date.now());
      return;
    }
    rowExitWantedRef.current.delete(row.id);
    autoExitingRef.current.add(row.id);
    // Also hold the manual busy lock: the row's own Exit All / +/- buttons go
    // through runRowAction, and without a shared lock a click landing while
    // this exit is in flight sends a SECOND full-size closing order and flips
    // the position the other way.
    setBusyRows(prev => new Set(prev).add(row.id));
    addToast('error', `${isSimRow(row) ? 'SIM ' : ''}Auto-exit: ${row.underlying} ${row.id.slice(-4)}`, reason);
    logEvent('auto_exit_row', row, reason);
    // awaitFill so the ledger is confirmed-updated by the time waitRowFlat
    // reads it below.
    // Owned legs only — same reason as handleManualExit's Exit All.
    Promise.all(legsOf(row).filter(l => rowOwnsLeg(row, l))
      .map(leg => placeLeg(row, leg, { reduce: true, all: true, awaitFill: true })))
      .then(async accepted => {
        // Only call the row exited once the broker's own book agrees every
        // leg is flat. Marking it exited off the order ACKs alone would
        // silently retire a row that still holds a position — and because
        // this ref is then cleared, nothing would try again either.
        if (!accepted.every(Boolean)) {
          addToast('error', 'Auto-exit incomplete', `${row.underlying}: a leg was rejected — still open, check the position book`);
          return;
        }
        if (await waitRowFlat(row.id)) {
          // Flat and confirmed. An overall SL / target exit may start a new cycle;
          // otherwise retire the row and drop its strike pin.
          if (!reenterAfterOverall(row, reason)) updateRow(row.id, { status: 'exited', fill: undefined });
        } else {
          addToast('error', 'Auto-exit unconfirmed',
            `${row.underlying}: orders were accepted but the book still shows quantity — left open so the rules keep watching it. Check the position book.`);
        }
      })
      .finally(() => {
        autoExitingRef.current.delete(row.id);
        setBusyRows(prev => { const next = new Set(prev); next.delete(row.id); return next; });
      });
  }

  /**
   * Functional patch of a row's fill ledger — same composition guarantee as
   * adjustFillQty (a burst of writes can't clobber each other), for the
   * fields adjustFillQty doesn't own: roll counters and cost-stop flags.
   * A no-op when the row holds no ledger.
   */
  function patchFill(rowId: string, patch: (f: FocusRowFill) => Partial<FocusRowFill>) {
    setConfig(prev => {
      let changed = false;
      const nextRows = prev.rows.map(r => {
        if (r.id !== rowId || !r.fill) return r;
        changed = true;
        return { ...r, fill: { ...r.fill, ...patch(r.fill) }, updatedAt: new Date().toISOString() };
      });
      if (!changed) return prev;
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
  }

  /** Whether a row's ledger still has a cost / momentum re-entry waiting. */
  function hasPendingReentry(row: FocusRow | undefined): boolean {
    return !!(row?.fill?.cePending || row?.fill?.pePending);
  }

  /**
   * The strike this row's config resolves `leg` to right now — for RE-ASAP /
   * RE-Momentum, which pick "the ATM (or ₹-target strike) available at that
   * time". Waits for the render that follows the close: until then rowLive
   * still pins the leg to the strike that just closed. Null if that render
   * doesn't land within 2s or the strike can't resolve.
   */
  async function resolvedStrikeAfterClose(rowId: string, leg: 'CE' | 'PE'): Promise<number | null> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const snap = schedulerRef.current;
      const r = snap.config.rows.find(x => x.id === rowId);
      const qty = Number(leg === 'CE' ? r?.fill?.ceQty : r?.fill?.peQty) || 0;
      if (r && qty <= 0) {
        const l = snap.rowLive[rowId];
        const strike = leg === 'CE' ? l?.ceStrike : l?.peStrike;
        if (strike != null) return strike;
      }
      if (Date.now() >= deadline) return null;
      await new Promise(res => setTimeout(res, 100));
    }
  }

  /**
   * The row's combined premium (1 lot per leg, as AlgoTest's Overall Momentum
   * counts it) with `leg` priced at `strike` and every other leg this row trades
   * at its own current strike. 0 while any quote is missing.
   */
  function combinedPremiumFor(rowId: string, leg: 'CE' | 'PE', strike: number): number {
    const snap = schedulerRef.current;
    const row = snap.config.rows.find(r => r.id === rowId);
    if (!row) return 0;
    const expiry = row.expiry || expiries[row.underlying]?.[0] || '';
    const l = snap.rowLive[rowId] ?? EMPTY_ROW_LIVE;
    let sum = 0;
    for (const x of legsOf(row)) {
      const q = x === leg
        ? actionsRef.current.simQuote(row.underlying, expiry, strike, leg)
        : ((x === 'CE' ? l.ltpCe : l.ltpPe) ?? 0);
      if (!(q > 0)) return 0;
      sum += q;
    }
    return sum;
  }

  /** The Overall Momentum level from a combined-premium start, or null when unreachable. */
  function combinedMomentumLevel(row: FocusRow, start: number): { price: number; dir: 'up' | 'down' } | null {
    if (!entryMomentumOn(row) || !(start > 0)) return null;
    const dir = row.entryMomDir === 'down' ? 'down' : 'up';
    const price = momentumTrigger(start, dir, row.entryMomUnit === 'pct' ? 'pct' : 'pts', Number(row.entryMomValue));
    return price > 0 ? { price, dir } : null;
  }

  /**
   * Open a Lazy Leg after a leg's SL / target closed it (AlgoTest "Lazy Leg").
   *
   * It takes over the CE/PE slot of its own type, so that slot must be free —
   * the leg that just closed frees it when the types match; a different type
   * whose leg is still open is refused (the ledger holds one position per
   * slot). It opens at ATM ± its own steps, is stamped with its id so its own
   * SL % / target % replace the row's, and is counted BEFORE the order so a
   * rejection can't loop; each lazy leg fires at most once per cycle, which
   * also keeps a chain from cycling.
   */
  async function openLazyLeg(
    row: FocusRow, lazyId: string, trigger: FocusReentryTrigger,
  ): Promise<'reentered' | 'pending' | 'skipped' | 'unconfirmed'> {
    const snap = schedulerRef.current;
    const lazy = row.lazyLegs?.find(l => l.id === lazyId);
    if (!lazy) return 'skipped';
    const u = row.underlying;
    const leg = lazy.leg;
    const name = `Lazy ${(row.lazyLegs ?? []).findIndex(l => l.id === lazyId) + 1}`;
    const tag = `${isSimRow(row) ? 'SIM ' : ''}${u} ${name}`;
    const refuse = (why: string): 'skipped' => { addToast('error', `${tag} not opened`, why); return 'skipped'; };
    const wantedAt = rowExitWantedRef.current.get(row.id);
    if (wantedAt != null && Date.now() - wantedAt < 5_000) return refuse('A whole-row exit is pending');
    if (!row.fill) return 'skipped';
    if (!legsOf(row).includes(leg)) return refuse(`This row does not trade ${leg}`);
    if (row.fill.lazyUsed?.includes(lazy.id)) return refuse('Already opened once this cycle');
    const group = snap.config.groups.find(g => g.underlying === u);
    const closed = reentryWindowClosed(row, { nowHm: istHm(), product: group?.product ?? 'INTRADAY', groupEnabled: !!group?.enabled, backstopHm: UNDERLYING_META[u].backstopHm });
    if (closed) return refuse(closed);
    if (!rowMayTrade(row, snap.liveRealMoney)) return refuse('LIVE · REAL MONEY is off');
    if (rowOwnsLeg(row, leg)) return refuse(`The ${leg} leg is still open — a Lazy Leg needs its slot free`);
    if (!(lazyLotsOf(lazy) > 0)) return refuse('Lots must be above 0');

    const base = await resolvedStrikeAfterClose(row.id, leg);
    if (base == null) return refuse('Could not resolve the current strike');
    const step = STRIKE_STEP[u];
    // Plain ATM ± rows: the resolved strike minus its own offset IS the ATM the
    // row used. Any other rule (₹ premium, strike criteria) resolves a strike
    // that says nothing about ATM, so take ATM from the price the group's
    // ATM BY names — spot, or the futures LTP — exactly as rowLive does.
    const futLtp = effectiveFutQuotes[u]?.ltp ?? 0;
    const atmBase = group?.atmBy === 'Fut' && futLtp > 0 ? futLtp : (snap.spots[u] ?? 0);
    const atm = !row.strikeCriteria && row.strikeMode === 'ATM'
      ? base - ((leg === 'CE' ? row.ceOffset : row.peOffset) ?? 0) * step
      : Math.round(atmBase / step) * step;
    if (!(atm > 0)) return refuse('ATM is not available');
    const strike = lazyLegStrike(lazy, atm, step);
    const lots = multipliedLots(row, lazyLotsOf(lazy));

    // AlgoTest: a lazy leg keeps its own Simple Momentum or ORB. Measured from
    // now (when it activates): arm a waiting entry instead of selling at once.
    const lazyRb = lazy.rangeBreakout;
    const rbMin = Math.trunc(Number(lazyRb?.minutes));
    if ((lazyRb?.enabled && rbMin > 0) || simpleMomOn(lazy.simpleMom)) {
      const expiry = row.expiry || expiries[u]?.[0] || '';
      let pending: FocusPendingReentry | null = null;
      if (lazyRb?.enabled && rbMin > 0) {
        const nowHm = istHm();
        const end = addMinutesHm(nowHm, rbMin);
        if (end) {
          pending = { trigger, mode: 'range', strike, lots, price: 0, dir: lazyRb.side === 'low' ? 'down' : 'up', since: Date.now(),
            range: { start: nowHm, end, side: lazyRb.side, on: lazyRb.on }, lazyId: lazy.id };
        }
      } else if (lazy.simpleMom) {
        const m = lazy.simpleMom;
        const startPx = m.src === 'underlying' ? (snap.spots[u] ?? 0) : actionsRef.current.simQuote(u, expiry, strike, leg);
        const lvl = startPx > 0 ? simpleMomLevel(m, startPx) : null;
        pending = { trigger, mode: 'momentum', strike, lots, price: lvl ?? 0, dir: m.dir, since: Date.now(), lazyId: lazy.id,
          ...(m.src === 'underlying' ? { src: 'underlying' as const } : {}) };
      }
      if (!pending) return refuse('No room for its range today');
      patchFill(row.id, f => ({
        lazyUsed: [...(f.lazyUsed ?? []), lazy.id],
        ...(leg === 'CE' ? { cePending: pending } : { pePending: pending }),
      }));
      addToast('success', `${tag} armed`, pending.mode === 'range'
        ? `Waits for the ${pending.range?.start}–${pending.range?.end} range ${lazyRb?.side} on ${lazyRb?.on === 'underlying' ? 'the index' : `${strike} ${leg}`}`
        : pending.price > 0 ? `Sells ${lots} lot(s) ${strike} ${leg} when ${pending.src === 'underlying' ? 'spot' : 'premium'} ${pending.dir === 'down' ? '≤' : '≥'} ${pending.price.toFixed(2)}`
          : `Waiting for a premium on ${strike} ${leg} to measure its momentum from`);
      return 'pending';
    }

    patchFill(row.id, f => ({
      lazyUsed: [...(f.lazyUsed ?? []), lazy.id],
      ...(leg === 'CE' ? { ceLazyId: lazy.id } : { peLazyId: lazy.id }),
    }));
    const fresh = schedulerRef.current.config.rows.find(r => r.id === row.id) ?? row;
    const ok = await actionsRef.current.placeLeg(fresh, leg, {
      reduce: false, lots, strikeOverride: strike, awaitFill: true,
    });
    if (!ok) {
      patchFill(row.id, () => (leg === 'CE' ? { ceLazyId: undefined } : { peLazyId: undefined }));
      addToast('error', `${tag} not confirmed`,
        `The ${strike} ${leg} order was rejected or not confirmed filled in time. It may still fill late (then it runs on the row's own SL / target) — do NOT reopen it by hand.`);
      return 'unconfirmed';
    }
    addToast('success', `${tag} opened`,
      `After ${trigger === 'sl' ? 'SL' : 'target'}: sold ${lots} lot(s) ${strike} ${leg}`
      + `${Number(lazy.slPct) > 0 ? `, SL ${lazy.slPct} ${legTgtUnitLabel(lazy.slBasis ?? 'pct')}` : ''}`
      + `${Number(lazy.tgtPct) > 0 ? `, target ${lazy.tgtPct} ${legTgtUnitLabel(lazy.tgtUnit ?? 'pct')}` : ''}`);
    return 'reentered';
  }

  /**
   * Re-entry after a leg's own SL × or target close has CONFIRMED (AlgoTest's
   * "Re-Entry on SL / Tgt", sell side only — see FocusReentryMode).
   *
   *  - asap / otm: sell now — at the strike the row resolves to now, or N
   *    strikes further OTM than the one that closed. The attempt is counted
   *    BEFORE the order goes out, so a rejecting broker can't loop.
   *  - cost / momentum: arm a FocusPendingReentry in the ledger; the 1s
   *    scheduler fires it (checkPendingReentries) once the price is reached,
   *    and counts it then.
   *
   * Reads row/config/functions fresh (schedulerRef / actionsRef): this runs
   * after the close's awaits, and the render that started it is stale.
   */
  async function reenterLegAfterExit(
    rowId: string, leg: 'CE' | 'PE', trigger: FocusReentryTrigger,
    closedStrike: number | null, closedQty: number, closedEntry: number, closedLazyId: string | null = null,
  ): Promise<'reentered' | 'pending' | 'skipped' | 'unconfirmed'> {
    const snap = schedulerRef.current;
    const row = snap.config.rows.find(r => r.id === rowId);
    if (!row) return 'skipped';
    logEvent('reentry_leg', row, `re-entry after ${trigger}`, { leg, closedStrike, closedQty, closedEntry });
    const lazyId = nextLazyLegId(row, closedLazyId, trigger);
    if (lazyId) return openLazyLeg(row, lazyId, trigger);
    // A Lazy Leg with nothing chained after it ends the line: the row's own
    // re-entry setting belongs to the root leg, not to a lazy one.
    if (closedLazyId) return 'skipped';
    const cfgRaw = reentryConfig(row, trigger);
    if (cfgRaw.mode === 'off' || cfgRaw.mode === 'lazy') return 'skipped';
    // RE MOMENTUM follows whatever momentum the leg has: Overall Momentum's
    // combined premium, a new range, its Simple Momentum — or, with none of
    // them, it "behaves exactly like RE ASAP" (AlgoTest glossary).
    const momKind = cfgRaw.mode === 'momentum' ? momentumReentryKind(row, leg) : null;
    const cfg = momKind === 'asap' ? { ...cfgRaw, mode: 'asap' as const } : cfgRaw;
    // A leftover leg the row's Side no longer trades still gets its own stop
    // (legStopReason ignores Side on purpose) — but must never be re-sold.
    if (!legsOf(row).includes(leg)) return 'skipped';
    const u = row.underlying;
    const tag = `${isSimRow(row) ? 'SIM ' : ''}${u} ${leg}`;
    const what = trigger === 'sl' ? 'SL' : 'target';
    // A whole-row exit (account stop/target/trail, book exit, exit time) fired
    // while this leg was closing and is waiting for the row to free up —
    // re-selling now would only open a leg to be flattened a moment later.
    const wantedAt = rowExitWantedRef.current.get(rowId);
    if (wantedAt != null && Date.now() - wantedAt < 5_000) {
      addToast('error', `${tag} no re-entry`, 'A whole-row exit is pending');
      return 'skipped';
    }
    // Ledger dropped while the close was in flight (re-armed, or retired by
    // another path) — this cycle is over, don't start a new leg in it.
    if (!row.fill) return 'skipped';
    const group = snap.config.groups.find(g => g.underlying === u);
    const done = Number(trigger === 'sl'
      ? (leg === 'CE' ? row.fill.ceRolls : row.fill.peRolls)
      : (leg === 'CE' ? row.fill.ceTgtReentries : row.fill.peTgtReentries)) || 0;
    const decision = evaluateReentry(row, trigger, {
      nowHm: istHm(),
      product: group?.product ?? 'INTRADAY',
      groupEnabled: !!group?.enabled,
      done,
    });
    if (!decision.enter) {
      addToast('error', `${tag} no re-entry`, decision.reason);
      return 'skipped';
    }
    if (!rowMayTrade(row, snap.liveRealMoney)) {
      addToast('error', `${tag} no re-entry`, 'LIVE · REAL MONEY is off');
      return 'skipped';
    }
    const lotSize = lotSizes[u] ?? 0;
    const lots = lotSize > 0 ? Math.floor(closedQty / lotSize) : 0;
    if (closedStrike == null || !(lots > 0)) {
      addToast('error', `${tag} no re-entry`, 'Closed strike or lot size unknown — leg left closed');
      return 'skipped';
    }
    const expiry = row.expiry || expiries[u]?.[0] || '';
    const countPatch = (n: number): Partial<FocusRowFill> => trigger === 'sl'
      ? (leg === 'CE' ? { ceRolls: n } : { peRolls: n })
      : (leg === 'CE' ? { ceTgtReentries: n } : { peTgtReentries: n });

    // ── RE MOMENTUM on a Range Breakout leg: a NEW range of the same length ──
    // (AlgoTest: 09:20–10:20 closed at 10:45 → 10:45–11:45, on a strike picked now.)
    const rb = leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout;
    if (momKind === 'range' && rangeBreakoutOn(rb, row.entryTime)) {
      // A BTST / Positional range spans sessions, so a new range "of the same
      // length" from now would end in a later session, after this row's exit
      // time — an intraday row cannot carry it there.
      if (rb.kind === 'btst' || rb.kind === 'positional') {
        addToast('error', `${tag} no re-entry`,
          `RE MOMENTUM on a ${rb.kind === 'btst' ? 'BTST' : 'Positional'} range needs a new multi-session range — not supported; pick RE ASAP or RE COST for this leg`);
        return 'skipped';
      }
      const win = reRangeWindow(row.entryTime, rb.end, istHm());
      const rangeStrike = win ? await resolvedStrikeAfterClose(rowId, leg) : null;
      if (!win || rangeStrike == null) {
        addToast('error', `${tag} no re-entry`, win ? 'Could not resolve the current strike for the new range' : 'No room for a new range today');
        return 'skipped';
      }
      const pending: FocusPendingReentry = {
        trigger, mode: 'range', strike: rangeStrike, lots, price: 0, dir: rb.side === 'low' ? 'down' : 'up', since: Date.now(),
        range: { start: win.start, end: win.end, side: rb.side, on: rb.on },
      };
      patchFill(rowId, () => (leg === 'CE' ? { cePending: pending } : { pePending: pending }));
      addToast('success', `${tag} re-entry armed`,
        `RE MOMENTUM after ${what}: new range ${win.start}–${win.end} on ${rb.on === 'underlying' ? 'the index' : `${rangeStrike} ${leg}`}; sell ${lots} lot(s) when the ${rb.side} is reached`);
      return 'pending';
    }

    // ── Waiting modes: arm, don't trade ──
    if (cfg.mode === 'cost' || cfg.mode === 'momentum') {
      let strike = closedStrike;
      let quoteNow = 0;
      // RE-Cost waits for the strike's INITIAL entry, not the last cost fill.
      const basis = cfg.mode === 'cost'
        ? costReentryBasis(leg === 'CE' ? row.fill.ceCostBasis : row.fill.peCostBasis, closedStrike, closedEntry)
        : null;
      // RE-Momentum follows the leg's own Simple Momentum — AlgoTest: it only
      // works with Simple Momentum switched on.
      const simple = leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom;
      const combined = momKind === 'combined';
      if (cfg.mode === 'momentum') {
        const s2 = await resolvedStrikeAfterClose(rowId, leg);
        if (s2 == null) {
          addToast('error', `${tag} no re-entry`, 'Could not resolve the current strike for momentum re-entry');
          return 'skipped';
        }
        strike = s2;
        quoteNow = combined
          ? combinedPremiumFor(rowId, leg, strike)
          : simple?.src === 'underlying'
            ? (schedulerRef.current.spots[u] ?? 0)
            : actionsRef.current.simQuote(u, expiry, strike, leg);
      }
      // A momentum strike the feed isn't carrying yet has no premium: arm it
      // with price 0 and let checkPendingReentries take the reference from
      // the first quote (cancelled after MOMENTUM_QUOTE_WAIT_MS).
      const awaitQuote = cfg.mode === 'momentum' && !(quoteNow > 0);
      const level = awaitQuote
        ? { price: 0, dir: (combined ? row.entryMomDir : simple?.dir) ?? 'down' }
        : combined
          ? combinedMomentumLevel(row, quoteNow)
          : pendingReentryLevel(cfg.mode, trigger, {
            entry: basis?.price ?? closedEntry, start: quoteNow, simple,
          });
      if (!level) {
        addToast('error', `${tag} no re-entry`, cfg.mode === 'cost'
          ? 'No entry price recorded for the closed leg'
          : 'The momentum level is not reachable from the current price');
        return 'skipped';
      }
      const pending: FocusPendingReentry = {
        trigger, mode: cfg.mode, strike, lots, price: level.price, dir: level.dir, since: Date.now(),
        ...(combined ? { src: 'combined' as const }
          : cfg.mode === 'momentum' && simple?.src === 'underlying' ? { src: 'underlying' as const } : {}),
      };
      patchFill(rowId, () => (leg === 'CE'
        ? { cePending: pending, ...(basis ? { ceCostBasis: basis } : {}) }
        : { pePending: pending, ...(basis ? { peCostBasis: basis } : {}) }));
      addToast('success', `${tag} re-entry armed`, awaitQuote
        ? `RE MOMENTUM after ${what}: waiting for a premium on ${strike} ${leg} to measure the move from`
        : `RE ${cfg.mode.toUpperCase()} after ${what}: sell ${lots} lot(s) ${strike} ${leg} when ${combined ? 'the combined premium' : simple?.src === 'underlying' && cfg.mode === 'momentum' ? 'spot' : 'premium'} ${level.dir === 'down' ? '≤' : '≥'} ${level.price.toFixed(2)}`);
      return 'pending';
    }

    // ── Immediate modes ──
    const newStrike = cfg.mode === 'otm'
      ? slRollStrike(leg, closedStrike, cfg.otmStrikes, STRIKE_STEP[u])
      : await resolvedStrikeAfterClose(rowId, leg);
    if (newStrike == null) {
      addToast('error', `${tag} no re-entry`, 'Could not resolve the current strike');
      return 'skipped';
    }
    patchFill(rowId, () => countPatch(done + 1));
    const fresh = schedulerRef.current.config.rows.find(r => r.id === rowId) ?? row;
    const ok = await actionsRef.current.placeLeg(fresh, leg, {
      reduce: false, lots, strikeOverride: newStrike, awaitFill: true,
    });
    if (!ok) {
      addToast('error', `${tag} re-entry not confirmed`,
        `Closed at ${closedStrike}; the ${newStrike} ${leg} re-entry was rejected or not confirmed filled in time. `
        + 'It may still fill late — this row will pick that up, so do NOT reopen it by hand.');
      return 'unconfirmed';
    }
    addToast('success', `${tag} re-entered (${cfg.mode.toUpperCase()}${momKind === 'asap' ? ' — RE MOMENTUM with no momentum set' : ''})`,
      `${what} at ${closedStrike} → re-sold ${lots} lot(s) at ${newStrike} (${done + 1}/${cfg.max})`);
    return 'reentered';
  }

  /**
   * Read a waiting re-entry's new range (high / low) once it has ended and save
   * it onto the pending. Polled every 10s until the server says it is complete;
   * the pending is dropped after 5 minutes without data.
   */
  function fetchPendingRange(
    row: FocusRow, leg: 'CE' | 'PE', p: FocusPendingReentry, expiry: string, drop: (why?: string) => void,
  ) {
    const r = p.range;
    if (!r) return;
    const key = `${row.id}:${leg}:${p.since}`;
    const st = (pendingRangeFetchRef.current[key] ??= { since: Date.now(), nextTry: 0, fetching: false });
    if (st.fetching || Date.now() < st.nextTry) return;
    if (Date.now() - st.since > 5 * 60_000) { delete pendingRangeFetchRef.current[key]; drop('Range data unavailable — no re-entry'); return; }
    st.fetching = true;
    const q = new URLSearchParams({ underlying: row.underlying, on: r.on, start: r.start, end: r.end });
    if (r.on === 'instrument') { q.set('expiry', expiry); q.set('strike', String(p.strike)); q.set('leg', leg); }
    fetch(`/api/focus-tool/range?${q}`)
      .then(res => res.json())
      .then((j: { complete?: boolean; high?: number | null; low?: number | null }) => {
        if (j.complete && typeof j.high === 'number' && typeof j.low === 'number') {
          const { high, low } = j;
          patchFill(row.id, f => {
            const cur = leg === 'CE' ? f.cePending : f.pePending;
            if (!cur || cur.since !== p.since || !cur.range) return {};
            const next = { ...cur, range: { ...cur.range, high, low } };
            return leg === 'CE' ? { cePending: next } : { pePending: next };
          });
          delete pendingRangeFetchRef.current[key];
        } else st.nextTry = Date.now() + 10_000;
      })
      .catch(() => { st.nextTry = Date.now() + 10_000; })
      .finally(() => { st.fetching = false; });
  }

  /**
   * The 1s scheduler's pass over waiting cost / momentum re-entries.
   *
   * Dropped (never fired) when: the leg is open again (the user re-sold it by
   * hand), the mode for its trigger was changed, the cap is used up, the
   * window closed (No re-entry after / exit time / 15:17 / index stopped) or
   * a whole-row exit is pending. Merely waits while LIVE is off or the row is
   * busy. Fires through runRowAction so it serialises with manual orders.
   */
  function checkPendingReentries() {
    const snap = schedulerRef.current;
    const nowHm = istHm();
    for (const row of snap.config.rows) {
      if (!hasPendingReentry(row)) continue;
      // At most ONE firing per row per tick: runRowAction's busy check reads
      // this render's state, so a second leg firing in the same pass would
      // run as a second concurrent action on the row. The other leg (still
      // hit next tick) goes once this one's order has finished.
      let firedThisRow = false;
      for (const leg of ['CE', 'PE'] as const) {
        if (firedThisRow) break;
        const p = leg === 'CE' ? row.fill?.cePending : row.fill?.pePending;
        if (!p) continue;
        const key = `${row.id}:${leg}`;
        if (pendingFiringRef.current.has(key)) continue;
        const tag = `${isSimRow(row) ? 'SIM ' : ''}${row.underlying} ${leg}`;
        const clear = (why?: string) => {
          patchFill(row.id, () => (leg === 'CE' ? { cePending: null } : { pePending: null }));
          if (why) addToast('error', `${tag} re-entry cancelled`, why);
        };
        if (rowOwnsLeg(row, leg)) { clear(); continue; }
        if (!legsOf(row).includes(leg)) { clear(`Row no longer trades ${leg}`); continue; }
        const cfg = reentryConfig(row, p.trigger);
        // A lazy leg waiting on its own momentum / range is not governed by the
        // row's re-entry mode or count — only by its own definition still existing.
        const lazyP = p.lazyId ? (row.lazyLegs ?? []).find(l => l.id === p.lazyId) : null;
        if (p.lazyId && !lazyP) { clear('Lazy Leg removed'); continue; }
        if (!p.lazyId && cfg.mode !== (p.mode === 'range' ? 'momentum' : p.mode)) { clear('Re-entry setting changed'); continue; }
        if (!p.lazyId && p.mode !== 'cost') {
          const k = momentumReentryKind(row, leg);
          const want = k === 'combined' ? 'combined' : k === 'range' ? 'range' : k === 'simple' ? 'simple' : 'asap';
          const have = p.mode === 'range' ? 'range' : p.src === 'combined' ? 'combined' : 'simple';
          if (want !== have) { clear('Momentum setting changed'); continue; }
        }
        const done = Number(p.trigger === 'sl'
          ? (leg === 'CE' ? row.fill?.ceRolls : row.fill?.peRolls)
          : (leg === 'CE' ? row.fill?.ceTgtReentries : row.fill?.peTgtReentries)) || 0;
        if (!p.lazyId && done >= cfg.max) { clear(`Re-entry limit ${cfg.max} reached`); continue; }
        const group = snap.config.groups.find(g => g.underlying === row.underlying);
        // Already waiting: "No re-entry after" no longer applies (AlgoTest
        // counts when the stop / target hit) — the exit time, 15:17 and Stop
        // Monitoring After still do.
        const closed = reentryWindowClosed(row, {
          nowHm, product: group?.product ?? 'INTRADAY', groupEnabled: !!group?.enabled,
          backstopHm: UNDERLYING_META[row.underlying].backstopHm,
        }, true);
        if (closed) { clear(closed); continue; }
        const wantedAt = rowExitWantedRef.current.get(row.id);
        if (wantedAt != null && Date.now() - wantedAt < 5_000) { clear('A whole-row exit is pending'); continue; }
        const breach = pendingLevelBreach(row, snap.spots[row.underlying] ?? 0);
        if (breach) { clear(breach); continue; }
        const expiry = row.expiry || expiries[row.underlying]?.[0] || '';
        const ltp = simQuote(row.underlying, expiry, p.strike, leg);
        // Momentum armed before its strike had a premium: the first quote is
        // the reference (taken even while LIVE is off or the row is busy, so
        // it stays close to the stop/target). Never fires on the tick that
        // sets it.
        // A new range after RE MOMENTUM on a Range Breakout leg: wait for it to end,
        // read it, then wait for the price to reach its high / low.
        let rangeHit = false;
        if (p.mode === 'range' && p.range) {
          const r = p.range;
          if (istHm() < r.end) continue;
          if (r.high == null || r.low == null) { fetchPendingRange(row, leg, p, expiry, clear); continue; }
          rangeHit = rangeBreakoutHit(r, { high: r.high, low: r.low }, r.on === 'underlying' ? (snap.spots[row.underlying] ?? 0) : ltp);
        }
        const combinedNow = p.src === 'combined' ? combinedPremiumFor(row.id, leg, p.strike) : 0;
        if (awaitingMomentumQuote(p)) {
          const start = p.src === 'combined' ? combinedNow : ltp;
          const level = start > 0
            ? (p.src === 'combined'
              ? combinedMomentumLevel(row, start)
              : pendingReentryLevel('momentum', p.trigger, {
                start, simple: lazyP ? lazyP.simpleMom : (leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom),
              }))
            : null;
          if (level) {
            const next: FocusPendingReentry = { ...p, price: level.price, dir: level.dir };
            patchFill(row.id, () => (leg === 'CE' ? { cePending: next } : { pePending: next }));
            addToast('success', `${tag} re-entry armed`,
              `RE MOMENTUM: sell ${p.lots} lot(s) ${p.strike} ${leg} when premium ${level.dir === 'down' ? '≤' : '≥'} ${level.price.toFixed(2)}`);
          } else if (start > 0) {
            clear('Momentum is off for this leg, or its level is not reachable from the new strike\'s premium');
          } else if (Date.now() - p.since > MOMENTUM_QUOTE_WAIT_MS) {
            clear(`No premium for ${p.strike} ${leg} within ${MOMENTUM_QUOTE_WAIT_MS / 1000}s`);
          }
          continue;
        }
        if (!rowMayTrade(row, snap.liveRealMoney)) continue;
        if (busyRows.has(row.id) || autoExitingRef.current.has(row.id)
          || (legExitsInFlightRef.current.get(row.id) ?? 0) > 0) continue;
        // An underlying-momentum re-entry is measured on the spot, not the strike.
        const watched = p.src === 'underlying' ? (snap.spots[row.underlying] ?? 0)
          : p.src === 'combined' ? combinedNow : ltp;
        if (p.mode === 'range' ? !rangeHit : !pendingReentryHit(p, watched)) continue;

        pendingFiringRef.current.add(key);
        firedThisRow = true;
        runRowAction(row.id, async () => {
          // Clear and count BEFORE the order: a rejection must not re-fire
          // on the next tick.
          const countKey = p.trigger === 'sl'
            ? (leg === 'CE' ? 'ceRolls' : 'peRolls')
            : (leg === 'CE' ? 'ceTgtReentries' : 'peTgtReentries');
          patchFill(row.id, () => ({
            ...(leg === 'CE' ? { cePending: null } : { pePending: null }),
            // A lazy leg opens as itself (its own SL / target); it is not a counted re-entry.
            ...(p.lazyId ? (leg === 'CE' ? { ceLazyId: p.lazyId } : { peLazyId: p.lazyId }) : { [countKey]: done + 1 }),
          }));
          addToast('success', `${tag} RE-${p.mode.toUpperCase()} triggered`,
            p.mode === 'range' && p.range
              ? `New range ${p.range.start}–${p.range.end}: ${p.range.on === 'underlying' ? 'spot' : 'premium'} reached the ${p.range.side} (${(p.range.side === 'high' ? p.range.high : p.range.low)?.toFixed(2)}) — selling ${p.lots} lot(s) ${p.strike} ${leg}`
              : `${p.src === 'underlying' ? 'Spot' : p.src === 'combined' ? 'Combined premium' : 'Premium'} ${watched.toFixed(2)} ${p.dir === 'down' ? '≤' : '≥'} ${p.price.toFixed(2)} — selling ${p.lots} lot(s) ${p.strike} ${leg}`);
          const fresh = schedulerRef.current.config.rows.find(r => r.id === row.id) ?? row;
          // A new range is this position's ORB Range stop base.
          const orb = p.mode === 'range' && p.range?.high != null && p.range.low != null
            ? { high: p.range.high, low: p.range.low, side: p.range.side, on: p.range.on } : null;
          const ok = await placeLeg(fresh, leg, {
            reduce: false, lots: p.lots, strikeOverride: p.strike, awaitFill: true, orb,
          });
          if (!ok) {
            if (p.lazyId) patchFill(row.id, () => (leg === 'CE' ? { ceLazyId: undefined } : { peLazyId: undefined }));
            addToast('error', `${tag} re-entry not confirmed`,
              'Rejected or not confirmed filled in time — check the position book');
          }
        }).finally(() => pendingFiringRef.current.delete(key));
      }
    }
  }

  /**
   * Drop every waiting re-entry on rows matching `pred`, in ONE state update.
   * For whole-book exits (account budget, Book Exit): those only act on rows
   * that hold something, and a row waiting to re-enter holds nothing.
   */
  function cancelPendingWhere(pred: (r: FocusRow) => boolean, why: string) {
    const hit = schedulerRef.current.config.rows.filter(r => pred(r) && hasPendingReentry(r));
    if (!hit.length) return;
    const ids = new Set(hit.map(r => r.id));
    setConfig(prev => {
      const nextRows = prev.rows.map(r => (ids.has(r.id) && r.fill)
        ? { ...r, fill: { ...r.fill, cePending: null, pePending: null }, updatedAt: new Date().toISOString() }
        : r);
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
    addToast('error', `Re-entry cancelled (${hit.length} row${hit.length > 1 ? 's' : ''})`, why);
  }

  /**
   * A spot level that would exit the row right after a re-entry fills: the
   * row's own H↑/L↓, or its index's Book Exit. Those rules only watch rows
   * holding something, so a waiting row must check them itself. Null = clear.
   */
  function pendingLevelBreach(row: FocusRow, spot: number): string | null {
    if (!(spot > 0)) return null;
    const hi = Number(row.levelHigh);
    if (row.levelHigh && Number.isFinite(hi) && spot >= hi) return `spot ${spot.toFixed(2)} ≥ H↑ ${hi}`;
    const lo = Number(row.levelLow);
    if (row.levelLow && Number.isFinite(lo) && spot <= lo) return `spot ${spot.toFixed(2)} ≤ L↓ ${lo}`;
    const g = schedulerRef.current.config.groups.find(x => x.underlying === row.underlying);
    if (g?.bookExit) {
      const gh = Number(g.spotHigh);
      const gl = Number(g.spotLow);
      if (g.spotHigh && Number.isFinite(gh) && gh > 0 && spot >= gh) return `book exit: spot ${spot.toFixed(2)} ≥ ${gh}`;
      if (g.spotLow && Number.isFinite(gl) && gl > 0 && spot <= gl) return `book exit: spot ${spot.toFixed(2)} ≤ ${gl}`;
    }
    return null;
  }

  /** The row's own "cancel" on a waiting re-entry. */
  function cancelPendingReentry(rowId: string, leg: 'CE' | 'PE') {
    patchFill(rowId, () => (leg === 'CE' ? { cePending: null } : { pePending: null }));
    addToast('success', `${leg} re-entry cancelled`);
  }

  /**
   * Close just one leg on its own stop or target, leaving the other leg
   * exactly as it was. `kind` says what fired:
   *
   *  - 'sl'   — the leg's own SL ×. Once the close is confirmed: arms
   *             SL-to-cost on the other leg (row.slToCost), then runs the
   *             SL re-entry (row.reSlMode). Both opt-in.
   *  - 'tgt'  — the leg's own target (% or points). Runs the target re-entry
   *             (row.reTgtMode); never arms SL-to-cost.
   *  - 'cost' — the SL-to-cost stop itself. Just closes; never re-enters or
   *             arms anything, so the features can't feed each other.
   *
   * If nothing is left open afterwards (and nothing is waiting to re-enter)
   * this was the row's last leg — retire it like autoExitRow once the ledger
   * confirms flat, or it would sit at 'entered' with no Arm button.
   */
  function autoExitLeg(row: FocusRow, leg: 'CE' | 'PE', reason: string, kind: 'sl' | 'tgt' | 'cost' = 'sl'): boolean {
    const key = `${row.id}:${leg}`;
    if (autoExitingLegRef.current.has(key) || autoExitingRef.current.has(row.id)) return false;
    // A previous order on this leg is still unconfirmed — the scheduler's
    // sweep settles it; retrying now would only be refused (and toast on
    // every tick). The rule fires again once it is settled, if still needed.
    if (unconfirmedOrderRef.current.has(key)) return false;
    const inFlight = legExitsInFlightRef.current.get(row.id) ?? 0;
    // Busy for any reason other than the OTHER leg's auto exit (a manual
    // order, a shift, a firing re-entry) → wait for it. Busy only because the
    // other leg is exiting → go ahead: different contract, breached now.
    if (busyRows.has(row.id) && inFlight === 0) return false;
    autoExitingLegRef.current.add(key);
    legExitsInFlightRef.current.set(row.id, inFlight + 1);
    // Also hold the manual busy lock (see autoExitRow above) — without it a
    // click on this row's own Exit/Add/Reduce buttons while this leg's close
    // (or its re-entry) is in flight sends a second concurrent order.
    setBusyRows(prev => new Set(prev).add(row.id));
    addToast(kind === 'tgt' ? 'success' : 'error',
      `${isSimRow(row) ? 'SIM ' : ''}Auto-exit ${leg}: ${row.underlying} ${row.id.slice(-4)}`, reason);
    logEvent('auto_exit_leg', row, reason, { leg, rule: kind });
    // Captured before the close: afterwards the ledger is 0 and the pin gone.
    const live = rowLive[row.id] ?? EMPTY_ROW_LIVE;
    const closedStrike = leg === 'CE' ? live.ceStrike : live.peStrike;
    const closingQty = legOwnContracts(row, leg, live);
    const closedEntry = legOwnEntry(row, leg, live);
    const closedLazyId = runningLazyLeg(row, leg)?.id ?? null;
    const other: 'CE' | 'PE' = leg === 'CE' ? 'PE' : 'CE';
    // awaitFill so the ledger is confirmed-updated by the time waitRowFlat
    // reads it below — and so a re-entry never opens on an unconfirmed close.
    placeLeg(row, leg, { reduce: true, all: true, awaitFill: true })
      .then(async accepted => {
        if (!accepted) return;
        // AlgoTest legwise Square Off → Complete: a leg's SL / target closes
        // every other leg of the row too. The strategy is over, so no
        // SL-to-cost and no re-entry — straight to the flat check below.
        const latest = schedulerRef.current.config.rows.find(r => r.id === row.id);
        let squaredOff = false;
        if ((kind === 'sl' || kind === 'tgt') && latest?.squareOff === 'complete') {
          squaredOff = true;
          patchFill(row.id, () => ({ cePending: null, pePending: null }));
          const rest = (['CE', 'PE'] as const).filter(l => l !== leg && rowOwnsLeg(latest, l));
          if (rest.length) {
            addToast('error', `${row.underlying} Square Off Complete`, `${leg} ${kind === 'sl' ? 'SL' : 'target'} hit — closing ${rest.join(' + ')} too`);
            const closed = await Promise.all(rest.map(l => placeLeg(latest, l, { reduce: true, all: true, awaitFill: true })));
            if (!closed.every(Boolean)) {
              addToast('error', 'Square Off incomplete', `${row.underlying}: a leg was rejected — still open, check the position book`);
              return;
            }
          }
        }
        if (!squaredOff && kind === 'sl') {
          const fresh = schedulerRef.current.config.rows.find(r => r.id === row.id);
          if (fresh && rowOwnsLeg(fresh, other) && costStopApplies(fresh, other)) {
            patchFill(row.id, () => (other === 'CE' ? { ceCostStop: true } : { peCostStop: true }));
            addToast('success', `${row.underlying} ${other} SL moved to cost`,
              `${leg} stopped out — ${other} now exits if its premium returns to its entry`);
          }
        }
        if (!squaredOff && (kind === 'sl' || kind === 'tgt')) {
          const re = await reenterLegAfterExit(row.id, leg, kind, closedStrike, closingQty, closedEntry, closedLazyId);
          // 'unconfirmed': an order went out but didn't confirm — it may fill
          // late, so don't retire on a momentarily-flat ledger. 'pending':
          // the row must stay alive to fire it.
          if (re !== 'skipped') return;
        }
        // The other leg may be mid-close too (both legs can exit at once) —
        // retire only when this is the last in-flight leg exit.
        if ((legExitsInFlightRef.current.get(row.id) ?? 0) > 1) return;
        if (hasPendingReentry(schedulerRef.current.config.rows.find(r => r.id === row.id))) return;
        if (await waitRowFlat(row.id)
          && !hasPendingReentry(schedulerRef.current.config.rows.find(r => r.id === row.id))) {
          updateRow(row.id, { status: 'exited', fill: undefined });
        }
      })
      .finally(() => {
        autoExitingLegRef.current.delete(key);
        const left = (legExitsInFlightRef.current.get(row.id) ?? 1) - 1;
        if (left > 0) {
          legExitsInFlightRef.current.set(row.id, left);
          return;
        }
        legExitsInFlightRef.current.delete(row.id);
        setBusyRows(prev => { const next = new Set(prev); next.delete(row.id); return next; });
      });
    return true;
  }

  useEffect(() => {
    if (isLeader !== true) return; // another tab runs the automatic rules
    // Real rows are only watched while LIVE is armed (a dry run must not spam
    // exit toasts for breaches it can never act on); sim rows always are.
    const openRows = config.rows.filter(r => {
      const l = rowLive[r.id];
      if (!l) return false;
      return !rowFlat(r) && rowMayTrade(r, liveRealMoney);
    });
    if (!openRows.length) return;

    // ── Account budget, on every tick ──
    // This used to sit in the 5s scheduler, which meant a target could be
    // overshot — or a stop breached — by up to five seconds of movement while
    // the numbers driving it (spot, premiums) were already on screen. It is a
    // pure function of data that arrives with the ticks, so it belongs here.
    //
    // Evaluated twice, once per book, with the same thresholds: the real book
    // against real P&L, the sim book against paper P&L, each with its own
    // peak and trail floor. A breach in one flattens only that book.
    const riskCfg = { riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees,
      trailKind: trailX.kind, trailEvery: trailX.every, trailBy: trailX.by };
    const realOpen = openRows.filter(r => !isSimRow(r));
    const simOpen = openRows.filter(r => isSimRow(r));
    const risk = evaluateGlobalRisk(riskCfg,
      { totalPnl: toolPnl, peakPnl: peakMtm, lockFloor: lockFloorRef.current });
    const simRisk = evaluateGlobalRisk(riskCfg,
      { totalPnl: simPnl, peakPnl: simPeakRef.current, lockFloor: simLockFloorRef.current });
    if (realOpen.length) lockFloorRef.current = risk.lockFloor;
    if (simOpen.length) simLockFloorRef.current = simRisk.lockFloor;
    const flattened = new Set<string>();
    if (risk.exitAll && realOpen.length) {
      for (const row of realOpen) { autoExitRow(row, risk.reason); flattened.add(row.id); }
      // A flat row still waiting to re-enter is not in openRows — without
      // this it would re-sell into a book the budget just flattened.
      cancelPendingWhere(r => !isSimRow(r), risk.reason);
    }
    if (simRisk.exitAll && simOpen.length) {
      for (const row of simOpen) { autoExitRow(row, `SIM book: ${simRisk.reason}`); flattened.add(row.id); }
      cancelPendingWhere(r => isSimRow(r), `SIM book: ${simRisk.reason}`);
    }
    if (flattened.size === openRows.length) return;   // whole book just flattened

    // ── Book Exit, on every tick ──
    // A spot LEVEL against a spot that moves continuously. Checking it five
    // times a minute was the single largest hole on this side.
    for (const g of config.groups) {
      if (!g.bookExit) continue;
      const spot = spots[g.underlying] ?? 0;
      if (!(spot > 0)) continue;
      const hi = Number(g.spotHigh);
      const lo = Number(g.spotLow);
      let reason: string | null = null;
      if (g.spotHigh && Number.isFinite(hi) && hi > 0 && spot >= hi) {
        reason = `${g.underlying} book exit: spot ${spot.toFixed(2)} ≥ ${hi}`;
      } else if (g.spotLow && Number.isFinite(lo) && lo > 0 && spot <= lo) {
        reason = `${g.underlying} book exit: spot ${spot.toFixed(2)} ≤ ${lo}`;
      }
      if (reason) {
        for (const row of openRows.filter(r => r.underlying === g.underlying && !flattened.has(r.id))) {
          autoExitRow(row, reason);
        }
        cancelPendingWhere(r => r.underlying === g.underlying, reason);
      }
    }

    // ── Per-row level exits ──
    const nowHm = istHm();
    for (const row of openRows) {
      if (flattened.has(row.id)) continue;
      const live = rowLive[row.id];
      if (!live) continue;
      // AlgoTest "Stop Monitoring After": no rule runs any more; the position is
      // left to the row's exit time (the scheduler still fires that).
      if (monitoringStopped(row, nowHm)) continue;
      const spot = spots[row.underlying] ?? 0;

      // Leg-wise SL x first: it can fire independently of, and more often
      // than, the pair-level rules below. Skip the whole-row check this tick
      // once a leg exit has been sent — the position book it would be
      // evaluated against is about to change.
      // Each leg is judged on its own every tick — a CE close still in
      // flight (its ledger only drops once the fill confirms) must not hide a
      // PE breach behind a `continue`. SL × first, then SL to cost (only armed
      // once the sibling leg's own SL × has fired).
      let legAction = false;
      for (const leg of ['CE', 'PE'] as const) {
        // Already exiting: nothing new to fire on this leg. The pair rules
        // below still run, so a whole-row breach during the close/roll gets
        // recorded (rowExitWantedRef) and stops the roll re-selling.
        if (autoExitingLegRef.current.has(`${row.id}:${leg}`)) continue;
        // legAction only when an exit actually STARTED: a breach that is
        // held (unconfirmed order, row busy) must not also suppress the
        // row's own pair/level rules below every tick while it waits.
        // The stop in force, computed once: its Trail SL steps are saved so a
        // reload (or a bounce back up) never loosens it — only ever upward —
        // and the same object is checked for a breach.
        const stop = ownedLegStop(row, leg, live);
        const steps = stop?.trailed ?? 0;
        if (steps > (Number(leg === 'CE' ? row.fill?.ceTrailSteps : row.fill?.peTrailSteps) || 0)) {
          patchFill(row.id, f => {
            const cur = Number(leg === 'CE' ? f.ceTrailSteps : f.peTrailSteps) || 0;
            return steps > cur ? (leg === 'CE' ? { ceTrailSteps: steps } : { peTrailSteps: steps }) : {};
          });
        }
        const slReason = legStopHit(stop, leg, live, spot);
        if (slReason) { if (autoExitLeg(row, leg, slReason)) legAction = true; continue; }
        const tgtReason = legTargetReason(row, leg, live, undefined, spot);
        if (tgtReason) { if (autoExitLeg(row, leg, tgtReason, 'tgt')) legAction = true; continue; }
        const costReason = costStopReason(row, leg, live);
        if (costReason && autoExitLeg(row, leg, costReason, 'cost')) legAction = true;
      }
      if (legAction) continue;

      // Levels, VW, SL ₹ / SL × first; then Overall Target and the trailing options.
      const peak = trackOverallPeak(row, live);
      const reason = evaluateRowExit(
        row, live, spot, undefined, live.lotSize,
      ) ?? evaluateOverallExit(row, live, peak, undefined, live.lotSize)?.reason ?? null;
      if (reason) autoExitRow(row, reason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowLive, spots, liveRealMoney, toolPnl, simPnl, riskEnabled, targetRupees, stopRupees,
      trailEnabled, triggerRupees, lockRupees, trailX, peakMtm, lockMtm, isLeader]);

  /**
   * Open every leg this row trades, at its configured lot size.
   *
   * Deduped through `autoEnteringRef` — the scheduler re-checks every few
   * seconds and the entry window stays open for the rest of the session, so
   * without this a row would re-enter on every tick.
   */
  function autoEnterRow(row: FocusRow, reason: string, strikes?: { CE?: number | null; PE?: number | null }) {
    if (autoEnteringRef.current.has(row.id) || autoExitingRef.current.has(row.id)) return;
    autoEnteringRef.current.add(row.id);
    addToast('success', `${isSimRow(row) ? 'SIM ' : ''}Auto-entry: ${row.underlying} ${row.id.slice(-4)}`, reason);
    logEvent('auto_entry', row, reason);
    (async () => {
      // Each accepted leg stamps its own strike and quantity onto the row's
      // fill ledger from inside placeLeg, so the row stops re-resolving off the
      // live ATM the moment the first leg is away (see FocusRowFill).
      // AlgoTest Delta Range: no strike inside the range → that leg is SKIPPED, not a failure.
      const live0 = schedulerRef.current.rowLive[row.id];
      // With pinned strikes (Overall Momentum) a null pin means that leg was
      // skipped when the strikes were picked — never revive it from the live
      // strike, or a leg the momentum never measured gets sold.
      const skipped = row.strikeCriteria === 'DELTA_RANGE'
        ? legsOf(row).filter(l => (strikes ? strikes[l] : (l === 'CE' ? live0?.ceStrike : live0?.peStrike)) == null)
        : [];
      if (skipped.length) {
        addToast('error', `${row.underlying}: ${skipped.join('+')} skipped`, 'No strike inside the Delta Range — that leg takes no entry (AlgoTest)');
      }
      const wanted = legsOf(row).filter(l => !skipped.includes(l));
      // Every leg skipped: nothing trades this cycle — retire the row rather than retry each second.
      if (!wanted.length) { updateRow(row.id, { status: 'exited' }); autoEnteringRef.current.delete(row.id); return; }
      const filled: Record<'CE' | 'PE', boolean> = { CE: false, PE: false };

      // Sequential, so one leg's rejection is reported against that leg and a
      // failure part-way through doesn't leave two orders racing.
      // Overall Momentum picks the strikes at the entry time and keeps them.
      const at = (leg: 'CE' | 'PE') => (strikes?.[leg] ? { strikeOverride: strikes[leg]! } : {});
      for (const leg of wanted) {
        if (await placeLeg(row, leg, { reduce: false, lots: multipliedLots(row, row.lots), ...at(leg) })) filled[leg] = true;
      }

      // A BOTH row that only got one leg away is a NAKED short, not a
      // straddle. Retry the missing leg once before accepting that shape —
      // and if it still will not go, say so loudly rather than marking the row
      // entered and moving on, which is how a naked leg used to go unnoticed.
      const missing = wanted.filter(l => !filled[l]);
      if (missing.length && missing.length < wanted.length) {
        for (const leg of missing) {
          if (await placeLeg(row, leg, { reduce: false, lots: multipliedLots(row, row.lots), ...at(leg) })) filled[leg] = true;
        }
      }

      const opened = wanted.filter(l => filled[l]);
      if (!opened.length) {
        addToast('error', 'Auto-entry failed', `${row.underlying}: no leg was accepted — row left armed`);
        autoEnteringRef.current.delete(row.id);   // let it retry on a later tick
        await fetchPositionsNow();
        return;
      }

      updateRow(row.id, { status: 'entered' });

      const stillMissing = wanted.filter(l => !filled[l]);
      if (stillMissing.length) {
        addToast('error', `${row.underlying}: NAKED ${stillMissing.join('+')} leg`,
          `${opened.join('+')} opened but ${stillMissing.join('+')} was rejected twice — this row is one-sided. Close it or place the missing leg manually.`);
      }
      await fetchPositionsNow();
    })().catch(() => autoEnteringRef.current.delete(row.id));
  }

  /** Show (or clear, with '') one waiting-for-momentum status line. */
  function putMomStatus(key: string, text: string) {
    setEntryMomStatus(prev => {
      if ((prev[key] ?? '') === text) return prev;
      const next = { ...prev };
      if (text) next[key] = text; else delete next[key];
      return next;
    });
  }

  /** The entry gate a leg is set up with: Range Breakout, Simple Momentum, or neither (opens at the entry time). */
  function legEntryKind(row: FocusRow, leg: 'CE' | 'PE'): 'range' | 'momentum' | 'now' {
    // A re-entry cycle after an overall SL / target: ASAP opens at once; MOMENTUM
    // goes through each leg's Simple Momentum (a leg without it opens at once).
    // The first-entry gates (Overall Momentum, Range Breakout) do not apply.
    // Overall Momentum on: every leg goes through the combined-premium gate
    // (the all-legs path) — Simple Momentum and Range Breakout are disabled.
    if (entryMomentumOn(row)) return 'now';
    if (row.overallReMode) {
      return row.overallReMode === 'momentum' && simpleMomOn(leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom) ? 'momentum' : 'now';
    }
    if (rangeBreakoutOn(leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout, row.entryTime)) return 'range';
    return simpleMomOn(leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom) ? 'momentum' : 'now';
  }

  function rowHasLegEntryGate(row: FocusRow): boolean {
    return legsOf(row).some(l => legEntryKind(row, l) !== 'now');
  }

  /**
   * Leg-by-leg entry gates — AlgoTest Simple Momentum and Range Breakout. Once
   * the row may enter (`enterOk`), each leg picks its strike at the entry time
   * and then:
   *  - momentum: notes its start price (its own premium, or the spot) and waits
   *    until that has moved the set amount;
   *  - range: tracks the high / low of [entry time, range end) on its strike or
   *    the index (read from 1-minute bars once the range has ended — see
   *    /api/focus-tool/range) and opens when the price reaches the high / low;
   *  - neither: opens at once.
   * Legs are independent, so a straddle can open one side now and the other later.
   *
   * The row stays 'armed' until its first leg is away, then turns 'entered'
   * (the same hand-off autoEnterRow makes). Waiting legs are dropped — never
   * fired — once the row is disarmed/retired, its index is stopped, its exit
   * time or the 15:17 backstop passes, or Overall Momentum is switched on.
   * A rejected order is NOT retried: the leg is parked as failed so a bad
   * order can't repeat every second.
   *
   * A range is only trusted when its strike was picked inside the range
   * window: the strike is remembered across a reload (localStorage), but a tab
   * opened after the range ended with no remembered strike cannot know which
   * strike was ATM at the entry time, so that leg is skipped, not guessed.
   */
  function driveLegEntries(row: FocusRow, enterOk: boolean, nowHm: string) {
    const snap = schedulerRef.current;
    const u = row.underlying;
    const today = istToday();
    const expiry = row.expiry || expiries[u]?.[0] || '';
    const group = snap.config.groups.find(g => g.underlying === u);
    const live = snap.rowLive[row.id] ?? EMPTY_ROW_LIVE;
    const spot = snap.spots[u] ?? 0;
    const closedReason = (row.status !== 'armed' && row.status !== 'entered') ? `row is ${row.status}`
      : !group?.enabled ? 'index stopped'
      : entryMomentumOn(row) ? 'Overall Momentum turned on'
      : monitoringStopped(row, nowHm) ? `monitoring stopped at ${row.stopMonitoringAfter}`
      : (row.exitTime && nowHm >= row.exitTime) ? `past its exit time ${row.exitTime}`
      : ((group?.product ?? 'INTRADAY') === 'INTRADAY' && nowHm >= UNDERLYING_META[row.underlying].backstopHm) ? `past ${UNDERLYING_META[row.underlying].backstopHm} intraday cutoff`
      : null;
    let fired = false;   // one order per row per tick — busyRows reads this render's state
    // A BTST / Positional range leg makes the row's other legs wait for its range end too.
    const mdr = rowHasMultiDayRange(row);
    const mdrWin = mdr ? rangeWindow(mdr, row.entryTime, today, expiry) : null;

    for (const leg of legsOf(row)) {
      const key = `${row.id}:${leg}`;
      const kind = legEntryKind(row, leg);
      const m = leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom;
      const rb = leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout;
      const win = kind === 'range' && rb ? rangeWindow(rb, row.entryTime, today, expiry) : null;
      // A BTST / Positional range that STARTS today (it ends on a later day):
      // pick and remember its strike at the entry time, while this tab is open.
      // Whatever the row's status — a row that already traded today's range
      // (entered, or exited) still needs tomorrow's strike when it is re-armed.
      if (kind === 'range' && rb && (rb.kind === 'btst' || rb.kind === 'positional')
        && nowHm >= row.entryTime && loadRangeStrike(key, today) == null) {
        const startsToday = rb.kind === 'btst' || (expiry && tradingDte(today, expiry) === Math.trunc(Number(rb.startDte)));
        const liveStrike = leg === 'CE' ? live.ceStrike : live.peStrike;
        if (startsToday && liveStrike) saveRangeStrike(key, today, liveStrike);
      }
      if (kind === 'range' && !win) { putMomStatus(key, `${leg}: Range Breakout window is not valid for expiry ${expiry || '—'}`); continue; }
      const winTxt = win ? (win.startDate === win.endDate ? `${win.start}–${win.end}` : `${win.startDate} ${win.start} → ${win.endDate} ${win.end}`) : '';
      const tag = `${isSimRow(row) ? 'SIM ' : ''}${u} ${leg}`;
      const drop = (why?: string) => {
        delete simMomRef.current[key];
        putMomStatus(key, '');
        if (why) addToast('error', `${tag} entry cancelled`, why);
      };
      let st: (typeof simMomRef.current)[string] | undefined = simMomRef.current[key];
      if (st && (st.day !== today || rowOwnsLeg(row, leg))) { drop(); st = undefined; }
      if (st && closedReason) { drop(closedReason); continue; }
      // The leg's gate was edited while waiting: start over.
      if (st && st.kind !== kind) { drop(); st = undefined; }

      if (!st) {
        if (!(row.status === 'armed' && enterOk) || rowOwnsLeg(row, leg)) continue;
        let strike: number | null = leg === 'CE' ? live.ceStrike : live.peStrike;
        let start = 0;
        if (kind === 'range' && rb && win) {
          const ph = rangeWindowPhase(win, today, nowHm);
          if (ph === 'before' || ph === 'over') {
            putMomStatus(key, ph === 'over' ? `${leg}: range ${winTxt} is over` : `${leg}: range ${winTxt} not started`);
            continue;
          }
          // The strike belongs to the range start. At the start (on its own
          // day) it is the live strike, remembered across a reload; later only
          // a remembered one will do — or, for an ATM-mode row with spot ATM,
          // the ATM rebuilt from the index's open at the range start.
          const remembered = loadRangeStrike(key, win.startDate);
          const atStart = today === win.startDate && nowHm >= win.start && (ph === 'tracking' || win.startDate === win.endDate)
            && remembered == null && !(nowHm >= win.end && today === win.endDate);
          if (atStart && strike) {
            saveRangeStrike(key, win.startDate, strike);
          } else {
            strike = remembered;
            if (strike == null) {
              const rebuildable = !row.strikeCriteria && (row.strikeMode ?? 'ATM') === 'ATM' && (group?.atmBy ?? 'Spot') === 'Spot';
              if (!rebuildable) {
                simMomRef.current[key] = { day: today, kind, strike: 0, start: 0, failed: true };
                putMomStatus(key, `range missed: the tab was not open at ${win.startDate} ${win.start} to pick the ${leg} strike`);
                continue;
              }
              // Rebuild from the index's first bar of the range (fetchRangeStartStrike fills st.strike).
              simMomRef.current[key] = { day: today, kind, strike: 0, start: 0 };
              st = simMomRef.current[key];
            }
          }
        }
        if (!strike && !(st && kind === 'range')) continue;
        if (kind === 'momentum' && m && strike) {
          start = m.src === 'underlying' ? spot : simQuote(u, expiry, strike, leg);
          if (!(start > 0)) { putMomStatus(key, `waiting for a start ${m.src === 'underlying' ? 'spot' : 'premium'}`); continue; }
        }
        if (!st) {
          st = { day: today, kind, strike: strike ?? 0, start };
          simMomRef.current[key] = st;
        }
      }
      if (kind === 'range' && rb && win && !(st.strike > 0) && !st.failed) {
        putMomStatus(key, `${leg}: working out the ${win.startDate} ${win.start} ATM from the index`);
        fetchRangeStartStrike(st, row, leg, win, key);
        continue;
      }
      // Legs with no gate wait for a BTST / Positional range's end in the same row.
      if (kind === 'now' && mdrWin && rangeWindowPhase(mdrWin, today, nowHm) !== 'ended') {
        putMomStatus(key, `${leg}: opens with the range leg, after ${mdrWin.endDate} ${mdrWin.end}`);
        continue;
      }

      if (st.failed) {
        if (st.strike > 0) putMomStatus(key, `${st.strike} ${leg}: entry did not go through — not retried`);
        continue;
      }

      let now = 1;
      let trigger = '';
      if (kind === 'momentum' && m) {
        now = m.src === 'underlying' ? spot : simQuote(u, expiry, st.strike, leg);
        if (!simpleMomHit(m, st.start, now)) {
          const level = simpleMomLevel(m, st.start);
          putMomStatus(key, level == null
            ? `${st.strike} ${leg}: momentum level unreachable`
            : `${st.strike} ${leg}: ${m.src === 'underlying' ? 'spot' : 'premium'} ${now > 0 ? now.toFixed(2) : '—'} needs ${m.dir === 'down' ? '≤' : '≥'} ${level.toFixed(2)} (start ${st.start.toFixed(2)})`);
          continue;
        }
        trigger = `Simple Momentum hit: ${m.src === 'underlying' ? 'spot' : 'premium'} ${now.toFixed(2)} from ${st.start.toFixed(2)}`;
      } else if (kind === 'range' && rb && win) {
        const what = `${rb.side === 'high' ? 'high' : 'low'} of ${winTxt} on ${rb.on === 'underlying' ? 'the index' : `${st.strike} ${leg}`}`;
        const ph = rangeWindowPhase(win, today, nowHm);
        if (ph !== 'ended') {
          putMomStatus(key, `${st.strike} ${leg}: ${ph === 'over' ? 'range is over' : `tracking the range ${winTxt}`}`);
          continue;
        }
        if (!st.range) {
          if (st.rangeFailed) { putMomStatus(key, `${st.strike} ${leg}: range data unavailable — no entry`); continue; }
          putMomStatus(key, `${st.strike} ${leg}: reading the ${winTxt} range`);
          fetchLegRange(st, row, leg, rb, expiry, win);
          continue;
        }
        now = rb.on === 'underlying' ? spot : simQuote(u, expiry, st.strike, leg);
        if (!rangeBreakoutHit(rb, st.range, now)) {
          putMomStatus(key, `${st.strike} ${leg}: ${what} = ${(rb.side === 'high' ? st.range.high : st.range.low).toFixed(2)}; now ${now > 0 ? now.toFixed(2) : '—'}, waiting for it to reach the ${rb.side}`);
          continue;
        }
        trigger = `Range breakout: ${rb.on === 'underlying' ? 'spot' : 'premium'} ${now.toFixed(2)} reached the ${what} (${(rb.side === 'high' ? st.range.high : st.range.low).toFixed(2)})`;
      }
      putMomStatus(key, '');
      if (fired || busyRows.has(row.id) || autoExitingRef.current.has(row.id) || simMomFiringRef.current.has(key)) continue;

      simMomFiringRef.current.add(key);
      fired = true;
      const armed = st;
      runRowAction(row.id, async () => {
        const fresh = schedulerRef.current.config.rows.find(r => r.id === row.id) ?? row;
        addToast('success', `${tag} entry`, trigger
          ? `${trigger} — selling ${multipliedLots(row, row.lots)} lot(s) ${armed.strike} ${leg}`
          : `Entry time reached — selling ${multipliedLots(row, row.lots)} lot(s) ${armed.strike} ${leg}`);
        // The range it broke out of is the base of its ORB Range stop — handed
        // to the ledger write that opens the leg (whenever the fill confirms).
        const orb = kind === 'range' && rb && armed.range
          ? { high: armed.range.high, low: armed.range.low, side: rb.side, on: rb.on } : null;
        const ok = await placeLeg(fresh, leg, { reduce: false, lots: multipliedLots(row, row.lots), strikeOverride: armed.strike, orb });
        if (ok) {
          delete simMomRef.current[key];
          const cur = schedulerRef.current.config.rows.find(r => r.id === row.id);
          if (cur?.status === 'armed') updateRow(row.id, { status: 'entered' });
        } else {
          armed.failed = true;
          const other: 'CE' | 'PE' = leg === 'CE' ? 'PE' : 'CE';
          addToast('error', `${tag} entry failed`, legsOf(row).includes(other) && rowOwnsLeg(fresh, other)
            ? `${other} is open but ${leg} was rejected — this row is one-sided. Place ${leg} manually if you want it.`
            : `${leg} was rejected — not retried. Disarm and re-arm the row to try again.`);
        }
        await fetchPositionsNow();
      }).finally(() => simMomFiringRef.current.delete(key));
    }
  }

  /**
   * Read a leg's finished range (high / low) from 1-minute bars. Polled every
   * 10s until the server says the range is complete; gives up after 5 minutes
   * so a leg can't wait forever on data that is not coming.
   */
  function fetchLegRange(
    st: NonNullable<(typeof simMomRef.current)[string]>, row: FocusRow, leg: 'CE' | 'PE',
    rb: FocusLegRangeBreakout, expiry: string, win: { startDate: string; start: string; endDate: string; end: string },
  ) {
    const nowMs = Date.now();
    st.rangeSince ??= nowMs;
    if (st.rangeFetching || nowMs < (st.rangeNextTry ?? 0)) return;
    if (nowMs - st.rangeSince > 5 * 60_000) { st.rangeFailed = true; return; }
    st.rangeFetching = true;
    const q = new URLSearchParams({
      underlying: row.underlying, on: rb.on, start: win.start, end: win.end, startDate: win.startDate, endDate: win.endDate,
    });
    if (rb.on === 'instrument') { q.set('expiry', expiry); q.set('strike', String(st.strike)); q.set('leg', leg); }
    fetch(`/api/focus-tool/range?${q}`)
      .then(r => r.json())
      .then((j: { complete?: boolean; high?: number | null; low?: number | null }) => {
        if (j.complete && typeof j.high === 'number' && typeof j.low === 'number') st.range = { high: j.high, low: j.low };
        else st.rangeNextTry = Date.now() + 10_000;
      })
      .catch(() => { st.rangeNextTry = Date.now() + 10_000; })
      .finally(() => { st.rangeFetching = false; });
  }

  /**
   * Rebuild the strike a range leg would have picked at its range start, for a
   * tab that was not open then: the index's first 1-minute bar open in the
   * range → ATM → this leg's ATM ± offset. ATM-mode rows on spot ATM only (a
   * premium or criteria strike needs the chain as it was, which is gone).
   * Remembered like a live pick; gives up (no entry) after 5 minutes.
   */
  function fetchRangeStartStrike(
    st: NonNullable<(typeof simMomRef.current)[string]>, row: FocusRow, leg: 'CE' | 'PE',
    win: { startDate: string; start: string; endDate: string; end: string }, key: string,
  ) {
    const nowMs = Date.now();
    st.strikeSince ??= nowMs;
    if (st.strikeFetching || nowMs < (st.strikeNextTry ?? 0)) return;
    if (nowMs - st.strikeSince > 5 * 60_000) { st.failed = true; putMomStatus(key, `range missed: could not read the ${leg} strike at ${win.start}`); return; }
    st.strikeFetching = true;
    // A two-minute slice from the start is enough for its first bar's open.
    const end = addMinutesHm(win.start, 2);
    if (!end) { st.failed = true; putMomStatus(key, `range missed: no ${leg} strike for a range starting ${win.start}`); return; }
    const q = new URLSearchParams({ underlying: row.underlying, on: 'underlying', start: win.start, end, startDate: win.startDate, endDate: win.startDate });
    fetch(`/api/focus-tool/range?${q}`)
      .then(r => r.json())
      .then((j: { open?: number | null }) => {
        const open = Number(j.open) || 0;
        const step = STRIKE_STEP[row.underlying];
        if (open > 0 && step > 0) {
          const strike = Math.round(open / step) * step + ((leg === 'CE' ? row.ceOffset : row.peOffset) ?? 0) * step;
          st.strike = strike;
          saveRangeStrike(key, win.startDate, strike);
        } else st.strikeNextTry = Date.now() + 10_000;
      })
      .catch(() => { st.strikeNextTry = Date.now() + 10_000; })
      .finally(() => { st.strikeFetching = false; });
  }

  // The scheduler's interval closure is created once, on mount,
  // so calling autoEnterRow/autoExitRow directly would pin that render's
  // versions — and with them a stale `lookups`/`lotSizes`/`rowLive` inside
  // placeLeg, which resolves the contract an order is actually sent for.
  // Going through a ref that every render refreshes keeps orders on current data.
  const actionsRef = useRef({ autoEnterRow, autoExitRow, placeLeg, simQuote, checkPendingReentries, sweepUnconfirmedOrders, driveLegEntries, rowHasLegEntryGate });
  actionsRef.current = { autoEnterRow, autoExitRow, placeLeg, simQuote, checkPendingReentries, sweepUnconfirmedOrders, driveLegEntries, rowHasLegEntryGate };

  /**
   * The scheduler: everything time- or account-level driven, on a 1s tick.
   *
   * Split from the per-row level-exit watcher above because those rules are
   * data-driven (they fire the moment a price crosses), while these are clock-
   * and aggregate-driven and must keep firing even when no tick arrives.
   * Ordered exits-before-entries, and account-wide rules before per-row ones,
   * so a stop-out is never immediately followed by a fresh entry on the same
   * tick.
   *
   * Always ticking; each row is gated on its own mode — a REAL row only acts
   * while LIVE · REAL MONEY is armed, a SIM row always (rowMayTrade). Like
   * everything else on this page, it only runs while the tab is open.
   */
  useEffect(() => {
    const tick = () => {
      const { config: cfg, rowLive: live, liveRealMoney: liveArmed } = schedulerRef.current;
      // Display mirror of the authoritative floor — see lockFloorRef. The
      // identity return makes an unchanged floor a no-op rather than a render.
      setLockMtm(prev => (prev === lockFloorRef.current ? prev : lockFloorRef.current));
      const nowHm = istHm();
      const openRows = cfg.rows.filter(r => {
        const l = live[r.id];
        return l && !rowFlat(r) && rowMayTrade(r, liveArmed);
      });

      // Only the leader tab acts; a follower still settles its own unconfirmed orders.
      const lead = leaderRef.current;

      // ── 1. Per-row time exit, plus the repo-wide 15:17 intraday backstop ──
      for (const row of lead ? openRows : []) {
        if (row.exitTime && nowHm >= row.exitTime) {
          actionsRef.current.autoExitRow(row, `Exit time ${row.exitTime} reached`);
          continue;
        }
        const product = cfg.groups.find(g => g.underlying === row.underlying)?.product ?? 'INTRADAY';
        const backstopHm = UNDERLYING_META[row.underlying].backstopHm;
        if (product === 'INTRADAY' && nowHm >= backstopHm) {
          actionsRef.current.autoExitRow(row, `Intraday backstop ${backstopHm} reached`);
        }
      }

      // ── 2. Settle unconfirmed orders; then waiting re-entries ──
      actionsRef.current.sweepUnconfirmedOrders();
      if (!lead) return;
      actionsRef.current.checkPendingReentries();

      // ── 3. Auto-entry for armed rows ──
      for (const row of cfg.rows) {
        if (!rowMayTrade(row, liveArmed)) continue;
        const l = live[row.id] ?? EMPTY_ROW_LIVE;
        const group = cfg.groups.find(g => g.underlying === row.underlying);
        // Stop Monitoring After: no new entry either. Waiting leg gates drop
        // themselves inside driveLegEntries.
        if (monitoringStopped(row, nowHm) && row.status === 'armed' && !Object.keys(simMomRef.current).some(k => k.startsWith(`${row.id}:`))) {
          delete entryMomRef.current[row.id];
          putMomStatus(row.id, rowFlat(row) ? `monitoring stopped at ${row.stopMonitoringAfter} — no entry` : '');
          continue;
        }
        // A BTST / Positional range leg enters on its range's END day, after its
        // End — not at the entry time (that is when the range STARTED, earlier).
        const multiDay = !entryMomentumOn(row) && !!rowHasMultiDayRange(row);
        const decision = evaluateEntry(multiDay ? { ...row, entryTime: '09:15' } : row, {
          nowHm,
          groupEnabled: !!group?.enabled,
          product: group?.product ?? 'INTRADAY',
          backstopHm: UNDERLYING_META[row.underlying].backstopHm,
          dte: dteFor(row.expiry || expiriesRef.current[row.underlying]?.[0] || ''),
          strikesReady: l.ceStrike != null || l.peStrike != null,
          flat: rowFlat(row),
        });
        // Per-leg Simple Momentum replaces the all-legs-at-once entry for this row.
        const simKeys = [`${row.id}:CE`, `${row.id}:PE`];
        if (actionsRef.current.rowHasLegEntryGate(row) || simKeys.some(k => simMomRef.current[k])) {
          actionsRef.current.driveLegEntries(row, decision.enter, nowHm);
          continue;
        }
        let enter = decision.enter;
        let reason = decision.reason;
        let momStatus = '';
        let pinned: { CE?: number | null; PE?: number | null } | undefined;
        // Overall Momentum gates the first entry and a RE MOMENTUM cycle after an
        // overall SL / target; RE ASAP skips it (AlgoTest).
        if (enter && entryMomentumOn(row) && row.overallReMode !== 'asap') {
          const today = istToday();
          let st = entryMomRef.current[row.id];
          // The strikes belong to the entry time, as on AlgoTest — watching the
          // live ATM instead would jump the combined premium every time the
          // ATM moved and enter on that jump, at strikes nobody measured. Pin
          // only once EVERY traded leg has a strike (a chain still loading must
          // not pin an empty leg for the rest of the day).
          // (Delta Range is the exception: a leg with no strike inside the range
          // is skipped, so the legs that did resolve are the strategy.)
          const hasStrike = (lg: 'CE' | 'PE') => (lg === 'CE' ? l.ceStrike : l.peStrike) != null;
          const legsReady = row.strikeCriteria === 'DELTA_RANGE' ? legsOf(row).some(hasStrike) : legsOf(row).every(hasStrike);
          if ((!st || st.day !== today) && legsReady) {
            st = { day: today, ref: null, ce: l.ceStrike, pe: l.peStrike };
            entryMomRef.current[row.id] = st;
          }
          if (!st || st.day !== today) {
            putMomStatus(row.id, 'momentum: waiting for every leg\'s strike to resolve');
            continue;
          }
          const expiry = row.expiry || expiriesRef.current[row.underlying]?.[0] || '';
          const pinnedLegs = legsOf(row).filter(lg => (lg === 'CE' ? st!.ce : st!.pe) != null);
          const quotes = pinnedLegs.map(leg => actionsRef.current.simQuote(row.underlying, expiry, (leg === 'CE' ? st!.ce : st!.pe)!, leg));
          const liveNow = quotes.every(q => q > 0) ? quotes.reduce((a, b) => a + b, 0) : null;
          // Candle Close: the last value of each finished candle (1 / 3 / 5 / 15
          // minutes) of THESE strikes.
          const min = candleBucket(nowHm, row.entryMomCandleMin ?? 1);
          if (st.min && st.min !== min) st.close = st.last ?? st.close ?? null;
          st.min = min;
          if (liveNow != null) st.last = liveNow;
          const watched = row.entryMomEval === 'candle' ? (st.close ?? null) : liveNow;
          const md = evaluateEntryMomentum(row, st.ref, watched, liveNow);
          if (md.ref != null) st.ref = md.ref;
          pinned = { CE: st.ce, PE: st.pe };
          if (md.ready) reason = `${decision.reason}; ${md.reason}`;
          else { enter = false; momStatus = md.reason; }
        }
        // The start premium only lives while the row is waiting to enter: any
        // loss of eligibility (disarmed, index stopped, …) or the entry itself drops it.
        if (enter || !decision.enter) delete entryMomRef.current[row.id];
        putMomStatus(row.id, momStatus);
        if (enter) actionsRef.current.autoEnterRow(row, reason, pinned);
      }
    };

    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Start/Stop, ATM BY, Product, Strikes±, and the Book Exit on/off toggle are
   * each a single, complete choice the instant they're clicked — safe to save
   * immediately, same as Arm. Since the Worker only ever sees the FILE (not
   * this tab's memory), an unsaved "Start" that only lives in local state is
   * invisible to it: the tab would honor it, the worker wouldn't, and that gap
   * is exactly what caused the earlier "why didn't it enter" confusion.
   *
   * Spot H↑/L↓ are free-typed RuleNumInputs (commit on blur/Enter), not a
   * discrete choice, so they're the one exception — those stay behind the
   * explicit Save Preferences button.
   * Auto-saving on every keystroke would let a half-typed level (e.g. "2" on
   * the way to typing "25000") briefly reach disk, and a worker tick landing
   * in that instant would read spot >= 2 as breached and fire a real exit.
   */
  function updateGroup(underlying: FocusUnderlying, patch: Partial<FocusIndexGroup>) {
    // Book Exit levels get the same before-state check as a row's H↑/L↓: the
    // 5s scheduler reads these out of memory, so a level already behind spot
    // books out every row in the index on the next tick.
    const spot = spots[underlying] ?? 0;
    const hi = Number(patch.spotHigh);
    const lo = Number(patch.spotLow);
    if (patch.spotHigh && Number.isFinite(hi) && spot > 0 && hi <= spot) {
      addToast('error', 'Book exit level rejected', `Spot H↑ (${hi}) must be above the current ${underlying} spot (${spot.toFixed(2)})`);
      return;
    }
    if (patch.spotLow && Number.isFinite(lo) && spot > 0 && lo >= spot) {
      addToast('error', 'Book exit level rejected', `Spot L↓ (${lo}) must be below the current ${underlying} spot (${spot.toFixed(2)})`);
      return;
    }

    setConfig(prev => {
      const nextGroups = prev.groups.map(g => g.underlying === underlying ? { ...g, ...patch } : g);
      const nextConfig = { ...prev, groups: nextGroups };
      saveConfig(nextConfig);
      return nextConfig;
    });
  }

  /**
   * The risk-bar toggles (Risk enabled, Trail) and the LIVE · REAL MONEY
   * master switch are each a single, complete flip — same reasoning as
   * updateGroup above, and the same stakes: liveRealMoney in particular is
   * the switch that gates every real order, so a toggle that only lives in
   * this tab's memory means the Worker could keep trading (or stay dry) on
   * the OLD value. Reads the *new* value explicitly rather than the
   * about-to-be-stale closures, since setState is async.
   */
  function saveRiskPatch(partial: Partial<Pick<FocusToolConfig,
    'riskEnabled' | 'trailEnabled' | 'liveRealMoney' | 'liveArmedOn' | 'targetRupees' | 'stopRupees' | 'triggerRupees' | 'lockRupees'
    | 'trailKind' | 'trailEvery' | 'trailBy'
  >>) {
    saveConfig({
      riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees, liveRealMoney,
      trailKind: trailX.kind, trailEvery: trailX.every, trailBy: trailX.by,
      ...partial,
      // No rows/groups: this render's `config` can be stale, and a stale row
      // would be stamped as a newer change. The server keeps what it has.
    });
  }
  function toggleRiskEnabled() {
    const next = !riskEnabled;
    setRiskEnabled(next);
    saveRiskPatch({ riskEnabled: next });
  }
  function toggleTrailEnabled() {
    const next = !trailEnabled;
    setTrailEnabled(next);
    saveRiskPatch({ trailEnabled: next });
  }
  function toggleLiveRealMoney() {
    const next = !liveRealMoney;
    setLiveRealMoney(next);
    // Stamp the day the arm was made. Both this page and the worker refuse to
    // treat a stale stamp as live, so the arm has to be renewed each session.
    saveRiskPatch({ liveRealMoney: next, liveArmedOn: next ? istToday() : '' });
  }

  function handleSetTargetRupees(v: string) {
    setTargetRupees(v);
    saveRiskPatch({ targetRupees: v });
  }
  function handleSetStopRupees(v: string) {
    setStopRupees(v);
    saveRiskPatch({ stopRupees: v });
  }
  function handleSetTriggerRupees(v: string) {
    setTriggerRupees(v);
    saveRiskPatch({ triggerRupees: v });
  }
  function handleSetLockRupees(v: string) {
    setLockRupees(v);
    saveRiskPatch({ lockRupees: v });
  }
  function handleSetTrailX(patch: Partial<TrailX>) {
    const next = { ...trailX, ...patch };
    setTrailX(next);
    saveRiskPatch({ trailKind: next.kind, trailEvery: next.every, trailBy: next.by });
  }

  /**
   * AlgoTest "Estimate Margin" for one row: Dhan's margin calculator on selling
   * the legs the row trades, at the strikes it resolves to now (or holds),
   * lots × Quantity Multiplier. Standalone — the account's positions are not
   * folded in. Approximate, like AlgoTest's own figure.
   */
  const estimateRowMargin = useCallback(async (rowId: string): Promise<string> => {
    const snap = schedulerRef.current;
    const row = snap.config.rows.find(r => r.id === rowId);
    if (!row) return 'row not found';
    if (isMcxUnderlying(row.underlying)) return `margin estimate is not available for ${row.underlying} yet`;
    const l = snap.rowLive[rowId];
    const expiry = row.expiry || expiriesRef.current[row.underlying]?.[0] || '';
    const lots = multipliedLots(row, row.lots);
    const legs = legsOf(row).flatMap(leg => {
      const strike = leg === 'CE' ? l?.ceStrike : l?.peStrike;
      const price = (leg === 'CE' ? l?.ltpCe : l?.ltpPe) ?? 0;
      return strike ? [{ strike, type: leg, side: 'SELL' as const, qtyLots: lots, price }] : [];
    });
    if (!legs.length || !expiry) return 'strikes not resolved yet';
    try {
      const r = await fetch('/api/options/margin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying: row.underlying, expiry, legs }),
      });
      const j = await r.json() as { success?: boolean; data?: { total_margin?: number }; error?: string };
      const total = Number(j.data?.total_margin) || 0;
      if (!j.success || !(total > 0)) return j.error ?? 'unavailable';
      return `≈ ₹${Math.round(total).toLocaleString('en-IN')} for ${legs.map(x => `${x.strike} ${x.type}`).join(' + ')} × ${lots} lot(s)`;
    } catch (e) { return String(e); }
  }, []);

  const rowsByUnderlying = useMemo<Record<FocusUnderlying, FocusRow[]>>(() => {
    const m: Record<FocusUnderlying, FocusRow[]> = { NIFTY: [], BANKNIFTY: [], SENSEX: [], CRUDEOILM: [] };
    for (const r of config.rows) m[r.underlying].push(r);
    return m;
  }, [config.rows]);

  return (
    <EntryMomContext.Provider value={entryMomStatus}>
    <MarginEstimateContext.Provider value={estimateRowMargin}>
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col font-sans relative">
      {/* Fixed toast overlay */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs ${
            t.type === 'success'
              ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-900/95 border-rose-500/40 text-rose-200'
          }`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      {/* Nav */}
      <div className="border-b border-zinc-800 bg-zinc-950">
        <NavBar />
      </div>

      <FocusHeader
        futQuotes={effectiveFutQuotes}
        shown={UNDERLYINGS}
        realised={realised}
        unrealised={unrealised}
        total={total}
        marginAvailable={fundsData?.availabelBalance != null ? Number(fundsData.availabelBalance) : null}
        marginUtilized={fundsData?.utilizedAmount != null ? Number(fundsData.utilizedAmount) : null}
        wsLive={wsLive}
        broker={broker}
        setBroker={setBroker}
        authenticatedBrokers={authenticatedBrokers}
      />

      {authChecked && !hasAuthenticatedBroker && (
        <div className="z-20 bg-amber-900/95 border-b border-amber-500/40 px-4 py-2 text-center">
          <p className="text-xs font-bold text-amber-200">
            No broker logged in — log in to Dhan, Zerodha or Kotak to place orders.
          </p>
        </div>
      )}

      {isLeader === false && (
        <div role="status" className="z-20 bg-amber-900/95 border-b border-amber-500/40 px-4 py-2 text-center">
          <p className="text-xs font-bold text-amber-200">
            Focus Tool is open in another tab, and that tab runs the automatic rules (entries, exits, stops, re-entries).
            This tab won&apos;t fire them; manual buttons still work. Close the other tab to make this one take over.
          </p>
        </div>
      )}

      <ControlStrip
        liveRealMoney={liveRealMoney} onToggleLive={toggleLiveRealMoney} broker={broker}
        riskEnabled={riskEnabled} onToggleRisk={toggleRiskEnabled}
        targetRupees={targetRupees} setTargetRupees={handleSetTargetRupees}
        stopRupees={stopRupees} setStopRupees={handleSetStopRupees}
        trailEnabled={trailEnabled} onToggleTrail={toggleTrailEnabled}
        triggerRupees={triggerRupees} setTriggerRupees={handleSetTriggerRupees}
        lockRupees={lockRupees} setLockRupees={handleSetLockRupees}
        trailX={trailX} setTrailX={handleSetTrailX}
        totalPnl={toolPnl}
        peakMtm={peakMtm}
        lockMtm={lockMtm}
        simPnl={simPnl}
        simRows={config.rows.filter(isSimRow).length}
        copyTrade={copyTrade}
        onOpenRisk={() => setActiveModal('risk')}
        onOpenOrders={() => setActiveModal('orderbook')}
        onOpenOptionChain={() => setActiveModal('optionchain')}
        onOpenGreeks={() => { runPortfolioGreeks(); setActiveModal('greeks'); }}
        onSetViewMode={setViewMode}
        viewMode={viewMode}
        onExitAll={handleExitAll} confirmExitAll={confirmExitAll} exitingAll={exitingAll}
      />

      {wsStale && (
        <div role="status" className="mx-6 mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-400">
          Live feed stalled — no tick for {Math.round(WS_STALE_MS / 1000)}s+. Prices below are from the slower option-chain poll (3s, cached) until the feed resumes.
        </div>
      )}

      {/* Main */}
      <div className="flex-1 px-6 py-5 flex flex-col gap-6">
        {UNDERLYINGS.map(u => {
          const group = config.groups.find(g => g.underlying === u) ?? makeGroup(u);
          const rows = rowsByUnderlying[u];
          // Only indices in use are shown: NIFTY always, the others once they have a
          // row or a started group. Hidden ones come back via the "+ BANKNIFTY" chips below.
          if (u !== 'NIFTY' && rows.length === 0 && !group.enabled) return null;

          return (
            <div key={u} className="flex flex-col gap-3">
              <IndexGroupBar
                group={group}
                onChange={patch => updateGroup(u, patch)}
                spot={spots[u] ?? 0}
                liveAtm={(() => {
                  const base = group.atmBy === 'Fut' && (effectiveFutQuotes[u]?.ltp ?? 0) > 0
                    ? effectiveFutQuotes[u]!.ltp : (spots[u] ?? 0);
                  return base > 0 ? Math.round(base / STRIKE_STEP[u]) * STRIKE_STEP[u] : 0;
                })()}
                lot={lotSizes[u]} dte={dteFor(expiries[u]?.[0] ?? '')} wsLive={wsLive}
              />

              <div className={cn("bg-zinc-900/40 border border-zinc-800/80 rounded-2xl overflow-hidden shadow-sm", viewMode === 'cards' ? 'p-4' : viewMode === 'pro' ? 'p-3' : '')}>
                {viewMode === 'pro' ? (
                  rows.length === 0 ? (
                    <div className="py-12 text-center flex flex-col items-center gap-1">
                      <span className="text-sm font-bold text-zinc-300">No trading rows configured</span>
                      <span className="text-xs text-zinc-500">Click &ldquo;Add Row&rdquo; to schedule a straddle or strangle entry.</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {rows.map(row => {
                        const { buildupWsActive, buildupExpiryHint } = rowBuildupWsFlags(
                          row, wsLive,
                          (focusWsQuotes?.[u]?.books
                            ? Object.keys(focusWsQuotes[u]!.books!).join(',')
                            : undefined)
                            ?? focusWsQuotes?.[u]?.expiry
                            ?? focusWsStatus.expiries?.[u],
                        );
                        return (
                        <FocusProRow
                          key={row.id} row={row} rowIndex={0}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          expiries={expiries[u] ?? []}
                          buildupWsActive={buildupWsActive}
                          buildupExpiryHint={buildupExpiryHint}
                          onUpdate={patch => updateRow(row.id, patch)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => armRow(row.id)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' })}
                          onExit={leg => handleManualExit(row, leg)}
                          onExitPartial={(leg, pct) => handleManualExitPartial(row, leg, pct)}
                          onAddLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots }))}
                          onAddAllLegs={lots => addLotsToAllLegs(row, lots)}
                          onLadderPlace={(leg, pct, lots) => { void placeLadderOrder(row, leg, pct, lots); }}
                          onLadderCancel={(leg, orderId) => { void cancelLadderOrders(row.id, leg, orderId); }}
                          onReduceLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots }))}
                          onShift={(leg, dir) => handleShiftStrike(row, leg, dir)}
                          onBlocked={msg => addToast('error', 'Strike locked', msg)}
                          onCancelPending={leg => cancelPendingReentry(row.id, leg)}
                        />
                        );
                      })}
                    </div>
                  )
                ) : viewMode === 'cards' ? (
                  rows.length === 0 ? (
                    <div className="py-14 text-center flex flex-col items-center justify-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-zinc-800/60 border border-zinc-700/50 flex items-center justify-center text-zinc-500 shadow-sm">
                        <Layers className="h-6 w-6" />
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-bold text-zinc-300">No trading rows configured</span>
                        <span className="text-xs text-zinc-500 mt-0.5">Click &ldquo;Add Row&rdquo; above to schedule a straddle or strangle entry.</span>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 min-[2200px]:grid-cols-4 gap-4">
                      {rows.map(row => {
                        const { buildupWsActive, buildupExpiryHint } = rowBuildupWsFlags(
                          row, wsLive,
                          // Prefer book keys (multi-expiry); fall back to status fingerprint.
                          (focusWsQuotes?.[u]?.books
                            ? Object.keys(focusWsQuotes[u]!.books!).join(',')
                            : undefined)
                            ?? focusWsQuotes?.[u]?.expiry
                            ?? focusWsStatus.expiries?.[u],
                        );
                        return (
                        <FocusRowCard
                          key={row.id} row={row}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          expiries={expiries[u] ?? []}
                          buildupWsActive={buildupWsActive}
                          buildupExpiryHint={buildupExpiryHint}
                          onUpdate={patch => updateRow(row.id, patch)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => armRow(row.id)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' })}
                          onExit={leg => handleManualExit(row, leg)}
                          onExitPartial={(leg, pct) => handleManualExitPartial(row, leg, pct)}
                          onAddLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots }))}
                          onReduceLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots }))}
                          onShift={(leg, dir) => handleShiftStrike(row, leg, dir)}
                          onBlocked={msg => addToast('error', 'Strike locked', msg)}
                          onCancelPending={leg => cancelPendingReentry(row.id, leg)}
                        />
                        );
                      })}
                    </div>
                  )
                ) : (
                  /* A row has a hard minimum width — strike editor (now ~280px+
                     with OI-buildup on a second line), LTP stack, and six
                     numeric level-exit boxes on one line. Without this scroller
                     the table overflowed the rounded-2xl `overflow-hidden`
                     wrapper above and the Level Exits column was simply
                     clipped: no scrollbar, no way to reach it. */
                  <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left min-w-[1500px]">
                    <thead>
                      <tr className="bg-zinc-800 border-b border-zinc-700/80 text-xs font-bold text-white uppercase tracking-wider">
                        <th className="py-2 px-3 border-r border-zinc-700/60" title="Underlying, timing, side, lots, and expiry">Strategy &amp; Setup</th>
                        <th className="py-2 px-3 border-r border-zinc-700/60" title="CE and PE strikes, picked by ATM offset or target premium">Strikes &amp; Selection</th>
                        <th className="py-2 px-3 border-r border-zinc-700/60" title="Combined premium, CE/PE breakdown, ₹ value and Val/OI PCR">Market Telemetry</th>
                        <th className="py-2 px-3 border-r border-zinc-700/60" title="Each leg's orders, its own SL × and target, and re-entry after a leg stop or target">CE / PE Legs &amp; Re-entry</th>
                        <th className="py-2 px-3" title="Status, row P&L, row-wide stops (₹, pair ×, spot levels, VWAP), arm and exit all">Safeguards &amp; Command</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, rowIndex) => {
                        const { buildupWsActive, buildupExpiryHint } = rowBuildupWsFlags(
                          row, wsLive,
                          (focusWsQuotes?.[u]?.books
                            ? Object.keys(focusWsQuotes[u]!.books!).join(',')
                            : undefined)
                            ?? focusWsQuotes?.[u]?.expiry
                            ?? focusWsStatus.expiries?.[u],
                        );
                        return (
                        <FocusTableRow
                          key={row.id} row={row} rowIndex={rowIndex}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          expiries={expiries[u] ?? []}
                          buildupWsActive={buildupWsActive}
                          buildupExpiryHint={buildupExpiryHint}
                          onUpdate={patch => updateRow(row.id, patch)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => armRow(row.id)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' })}
                          onExit={leg => handleManualExit(row, leg)}
                          onExitPartial={(leg, pct) => handleManualExitPartial(row, leg, pct)}
                          onAddLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots }))}
                          onReduceLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots }))}
                          onShift={(leg, dir) => handleShiftStrike(row, leg, dir)}
                          onBlocked={msg => addToast('error', 'Strike locked', msg)}
                          onCancelPending={leg => cancelPendingReentry(row.id, leg)}
                        />
                        );
                      })}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-12 text-center">
                            <div className="flex flex-col items-center gap-2">
                              <TrendingUp className="h-8 w-8 text-zinc-700" />
                              <span className="text-sm font-semibold text-zinc-500">No rows configured</span>
                              <span className="text-xs text-zinc-600">Click &ldquo;Add Row&rdquo; to schedule a straddle or strangle entry.</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                )}

                <div className="px-4 py-3 bg-zinc-900/40 border-t border-zinc-800 mt-3">
                  <button
                    onClick={() => addRow(u)}
                    title={`Add another straddle / strangle rule for ${u}`}
                    className={cn('flex items-center gap-1.5 text-xs font-extrabold px-3 py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 transition-colors cursor-pointer', FOCUS_RING)}
                  >
                    <Plus className="h-4 w-4" /> Add Row
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {UNDERLYINGS.some(u => u !== 'NIFTY' && rowsByUnderlying[u].length === 0 && !(config.groups.find(g => g.underlying === u)?.enabled)) && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-semibold">Other indices:</span>
            {UNDERLYINGS.filter(u => u !== 'NIFTY' && rowsByUnderlying[u].length === 0 && !(config.groups.find(g => g.underlying === u)?.enabled)).map(u => (
              <button
                key={u} type="button" onClick={() => addRow(u)}
                title={`Add a ${u} row (shows the ${u} section)`}
                className={cn('flex items-center gap-1 text-xs font-extrabold px-2.5 py-1 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer', FOCUS_RING)}
              >
                <Plus className="h-3.5 w-3.5" /> {u}
              </button>
            ))}
          </div>
        )}
      </div>


      <FocusModal
        isOpen={activeModal === 'greeks'}
        onClose={() => setActiveModal(null)}
        title="Portfolio Greeks"
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>{greeksSnap ? `as of ${greeksSnap.at.toLocaleTimeString('en-IN')}` : ''}</span>
            <Button size="sm" variant="outline" className="ml-auto h-7 gap-1 border-zinc-700 bg-zinc-900 text-xs font-bold" onClick={runPortfolioGreeks}>
              <RefreshCw className="size-3" /> Refresh
            </Button>
          </div>
          {greeksSnap && greeksSnap.groups.length === 0 && (
            <p className="text-sm text-zinc-400">No open legs to compute Greeks for.</p>
          )}
          {greeksSnap?.groups.map(g => {
            const n = g.result.net;
            const stat = (label: string, value: string, tone: string, sub?: string) => (
              <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <span className="text-[11px] font-black uppercase tracking-widest text-zinc-500">{label}</span>
                <span className={cn('font-mono text-lg font-black tabular-nums', tone)}>{value}</span>
                {sub && <span className="text-[11px] text-zinc-500">{sub}</span>}
              </div>
            );
            return (
              <div key={g.underlying} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-black', UNDERLYING_CHIP[g.underlying])}>
                    <span className={cn('size-1.5 rounded-full', UNDERLYING_DOT[g.underlying])} />{g.underlying}
                  </span>
                  <span className="text-xs text-zinc-400">spot {g.spot > 0 ? g.spot.toFixed(2) : '—'} · {g.result.legs.length} leg(s)</span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {stat('Net Delta', n.delta.toFixed(2), n.delta > 0 ? 'text-emerald-400' : n.delta < 0 ? 'text-rose-400' : 'text-zinc-100', 'index units')}
                  {stat('Net Gamma', n.gamma.toFixed(4), n.gamma < 0 ? 'text-rose-400' : 'text-zinc-100')}
                  {stat('Net Theta', `₹${n.theta.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, n.theta > 0 ? 'text-emerald-400' : 'text-rose-400', 'per day')}
                  {stat('Net Vega', n.vega.toFixed(2), n.vega < 0 ? 'text-rose-400' : 'text-zinc-100', 'per 1% IV')}
                </div>
                <table className="w-full font-mono text-xs tabular-nums">
                  <thead>
                    <tr className="bg-zinc-800 text-xs font-bold text-white">
                      <th className="px-2 py-1 text-left">Leg</th>
                      <th className="px-2 py-1 text-right">Delta</th><th className="px-2 py-1 text-right">Gamma</th>
                      <th className="px-2 py-1 text-right">Theta</th><th className="px-2 py-1 text-right">Vega</th><th className="px-2 py-1 text-right">IV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.result.legs.map(l => {
                      const k = (l.side === 'S' ? -1 : 1) * l.units;
                      const f = (v: number | null, d: number) => v === null ? '—' : (v * k).toFixed(d);
                      return (
                        <tr key={l.legId} className="border-b border-zinc-800/60 text-zinc-300">
                          <td className="px-2 py-1">{g.labels[l.legId]} · {l.side === 'S' ? 'SELL' : 'BUY'} {l.strike} {l.option} ×{l.units}</td>
                          <td className="px-2 py-1 text-right">{f(l.delta, 2)}</td><td className="px-2 py-1 text-right">{f(l.gamma, 4)}</td>
                          <td className="px-2 py-1 text-right">{f(l.theta, 0)}</td><td className="px-2 py-1 text-right">{f(l.vega, 2)}</td>
                          <td className="px-2 py-1 text-right">{l.iv === null ? '—' : `${(l.iv * 100).toFixed(1)}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {g.result.assumed.length > 0 && (
                  <p className="text-xs text-amber-300">
                    {g.result.assumed.length} leg(s) have no live price ({g.result.assumed.map(l => `${l.strike} ${l.option}`).join(', ')}) — priced on an assumed 15% IV, so their Greeks are indicative.
                  </p>
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-zinc-500">
            Computed from each row&apos;s own fill record (not the broker&apos;s netted position) and each leg&apos;s live price, through the same pricing library as the payoff charts.
          </p>
        </div>
      </FocusModal>

      <FocusModal
        isOpen={activeModal === 'risk'}
        onClose={() => setActiveModal(null)}
        title="Risk & MTM Details"
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">Realised P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(realised))}>{fmtInr(realised, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">Unrealised P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(unrealised))}>{fmtInr(unrealised, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">Total P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(total))}>{fmtInr(total, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">This Tool&apos;s P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(toolPnl))}>{fmtInr(toolPnl, true)}</span>
            </div>
          </div>

          <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">Account Budget</h3>
            <p className="text-[10px] text-zinc-500 leading-relaxed -mt-1">
              Target, Stop and Trail are measured on <strong className="text-zinc-300">this tool&apos;s own rows</strong>
              {' '}({fmtInr(toolPnl, true)}), not on the whole-account total above — an unrelated strategy&apos;s
              drawdown must not flatten these positions. Session peak {fmtInr(peakMtm, true)}.
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Target Profit:</span>
                <span className="font-mono text-emerald-400 font-bold">{targetRupees ? `₹${Number(targetRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Stop Loss:</span>
                <span className="font-mono text-rose-400 font-bold">{stopRupees ? `-₹${Number(stopRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Trail SL Trigger:</span>
                <span className="font-mono text-amber-400 font-bold">{trailEnabled && triggerRupees ? `₹${Number(triggerRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Trail SL Lock:</span>
                <span className="font-mono text-amber-500 font-bold">{trailEnabled && lockRupees ? `₹${Number(lockRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1 col-span-2">
                <span className="text-zinc-500">Room to Stop:</span>
                <span className={cn("font-mono font-bold", toolPnl + (Number(stopRupees) || 0) < 0 ? "text-rose-400" : "text-zinc-300")}>
                  {stopRupees ? fmtInr(toolPnl + Number(stopRupees), true) : '—'}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-1">By Underlying</h3>
            {FOCUS_UNDERLYINGS.map(u => {
              const val = underlyingPnl[u];
              return (
                <div key={u} className="flex justify-between items-center text-xs border-b border-zinc-850 py-1">
                  <span className="font-semibold text-zinc-300">{u}</span>
                  <span className={cn("font-mono font-bold", pnlClass(val))}>{fmtInr(val, true)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </FocusModal>

      <FocusModal
        isOpen={activeModal === 'orderbook'}
        onClose={() => setActiveModal(null)}
        title="Orders"
        variant="center"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1">
              {([['orders', 'Order Book', orders.length], ['trades', 'Tradebook', trades.length], ['positions', 'Positions', positions.length]] as const).map(
                ([tab, label, count]) => (
                  <button
                    key={tab}
                    onClick={() => setOrdersTab(tab)}
                    className={cn(
                      'px-3 py-1.5 text-xs font-semibold rounded-lg transition-all',
                      ordersTab === tab
                        ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                        : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
                      FOCUS_RING,
                    )}
                  >
                    {label}{count > 0 ? ` (${count})` : ''}
                  </button>
                ),
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider leading-tight">
                Every {ordersTab === 'orders' ? 'order' : ordersTab === 'trades' ? 'trade' : 'position'} on the account, not only this tool&apos;s
              </span>
              <button
                onClick={() => { fetchOrders(); fetchTrades(); void fetchPositionsNow(); }}
                disabled={ordersLoading || tradesLoading}
                className={cn('text-xs font-semibold px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer disabled:opacity-40 transition-all flex items-center gap-1', FOCUS_RING)}
              >
                <RefreshCw className={cn("h-3 w-3", (ordersLoading || tradesLoading) && "animate-spin")} />
                Refresh
              </button>
            </div>
          </div>

          {ordersTab === 'orders' ? (
            <>
              {ordersError && (
                <div className="text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 font-mono">
                  Error loading orders: {ordersError}
                </div>
              )}
              {ordersLoading && !orders.length ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <RefreshCw className="h-6 w-6 text-zinc-600 animate-spin" />
                  <span className="text-xs text-zinc-500">Loading order book…</span>
                </div>
              ) : (
                <div className="border border-zinc-800 rounded-xl overflow-hidden max-h-[65vh] overflow-y-auto">
                  <TabTable
                    tab="orders"
                    data={orders}
                    sort={orderSort}
                    onSort={key => setOrderSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })}
                  />
                </div>
              )}
            </>
          ) : ordersTab === 'trades' ? (
            <>
              {tradesError && (
                <div className="text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 font-mono">
                  Error loading trades: {tradesError}
                </div>
              )}
              {tradesLoading && !trades.length ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <RefreshCw className="h-6 w-6 text-zinc-600 animate-spin" />
                  <span className="text-xs text-zinc-500">Loading tradebook…</span>
                </div>
              ) : (
                <div className="border border-zinc-800 rounded-xl overflow-hidden max-h-[65vh] overflow-y-auto">
                  <TabTable
                    tab="trades"
                    data={trades}
                    sort={tradeSort}
                    onSort={key => setTradeSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="border border-zinc-800 rounded-xl overflow-hidden max-h-[65vh] overflow-y-auto">
              <TabTable
                tab="positions"
                data={positions as unknown as Record<string, unknown>[]}
                sort={positionSort}
                onSort={key => setPositionSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })}
              />
            </div>
          )}
        </div>
      </FocusModal>

      <FocusOptionChainModal
        isOpen={activeModal === 'optionchain'}
        onClose={() => setActiveModal(null)}
        expiries={expiries.NIFTY ?? []}
        broker={broker}
      />
    </div>
    </MarginEstimateContext.Provider>
    </EntryMomContext.Provider>
  );
}

