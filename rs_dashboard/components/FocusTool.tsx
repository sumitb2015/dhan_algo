'use client';

import React, {
  useState, useEffect, useCallback, useMemo, useRef, memo,
} from 'react';
import NavBar from './NavBar';
import {
  TrendingUp, Zap, ShieldOff, Shield, Activity,
  Clock, Plus, Check, Save, Layers, Target, Lock, RefreshCw, X,
  ChevronUp, ChevronDown, Server, Grid3x3,
} from 'lucide-react';
import { TabTable, type SortState, BUILDUP_STYLES } from './Scalper';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { closeOrderProduct, positionProduct } from '@/lib/positionProduct';
import { scaleBrokerPnl } from '@/lib/positionPnl';
import { useCopyTrade, CopyTradeControls, type CopyTradeApi } from './CopyTrade';
import { useFocusToolWS } from '@/lib/useFocusToolWS';
import FocusOptionChainModal from './FocusOptionChainModal';
import { cn } from '@/lib/utils';
import type {
  FocusToolConfig, FocusRow, FocusRowFill, FocusIndexGroup,
  FocusUnderlying, FocusDte, FocusSide, FocusRowStatus, FocusStrikeMode,
} from '@/lib/focusToolRows';
// The rule engine. Extracted so it can be tested, and so the same cases can be
// run against focus_tool_rows_worker.py — see focusToolRules.cases.json.
import {
  INTRADAY_BACKSTOP_HM, EMPTY_ROW_LIVE,
  legsOf, rowFlat, rowOwnsLeg, sidePremium, legStopReason,
  dteMatches, dteForExpiry, evaluateRowExit, evaluateEntry, evaluateGlobalRisk,
  legStopPremium, pairStopPremium,
  type PosRow, type RowLive,
} from '@/lib/focusToolRules';
import { computeRowPnl, mtmForQty, shiftMayReopen, canMarkMtm, shiftCloseConfirmed, rowDisplayBookedPnl, putCallRatio, valuePutCallRatio } from '@/lib/focusToolPnl';

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const UNDERLYINGS: FocusUnderlying[] = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
const STRIKE_STEP: Record<FocusUnderlying, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 };

// ATM-offset dropdown range for the strike editor: +-10 steps either side.
const OFFSET_OPTIONS: number[] = Array.from({ length: 21 }, (_, i) => i - 10);

function offsetLabel(n: number, step: number): string {
  if (n === 0) return 'ATM';
  const rupees = n * step;
  return `ATM${n > 0 ? '+' : ''}${n} (${rupees > 0 ? '+' : ''}${rupees})`;
}

const FUT_LABELS: Record<FocusUnderlying, string> = {
  NIFTY: 'NIFTY FUT',
  BANKNIFTY: 'BANKNIFTY FUT',
  SENSEX: 'SENSEX FUT',
};

// Order-routing vocabulary. SENSEX is the only BSE underlying here, and each
// broker spells the same exchange differently — Dhan takes a segment, Kite an
// exchange code, Neo a lower-case one.
const UNDERLYING_SEGMENT: Record<FocusUnderlying, string> = {
  NIFTY: 'NSE_FNO',
  BANKNIFTY: 'NSE_FNO',
  SENSEX: 'BSE_FNO',
} as const;

function orderExchange(broker: Broker, u: FocusUnderlying): string {
  const bse = u === 'SENSEX';
  if (broker === 'dhan')  return bse ? 'BSE_FNO' : 'NSE_FNO';
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
};
const UNDERLYING_TXT: Record<FocusUnderlying, string> = {
  NIFTY: 'text-violet-400',
  BANKNIFTY: 'text-sky-400',
  SENSEX: 'text-amber-400',
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

/** Set once the user stops the server-side worker by hand, so the auto-start
 *  effect leaves it alone on the next mount. Per-browser, which is the right
 *  scope for a per-user decision on a local single-user tool. */
const WORKER_OPT_OUT_KEY = 'focusTool.workerStoppedByUser';

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

/** The option chain keys strikes as '24250.000000'; every other source uses
 *  '24250'. Normalise both onto the integer form before joining them. */
function strikeKey(n: number | string): string {
  return String(Math.round(Number(n)));
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
  for (const u of ['BANKNIFTY', 'SENSEX', 'NIFTY'] as FocusUnderlying[]) {
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
  ceValue: number | null; peValue: number | null; pcr: number | null; pcrOi: number | null;
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
  return {
    ceValue, peValue,
    pcr: valuePutCallRatio(peValue, ceValue, live.ltpPe, live.ltpCe),
    pcrOi: putCallRatio(live.peOi, live.ceOi),
  };
}

/** Compact LTP column: combined premium → CE/PE → ₹ values → Val/OI PCR strip. */
function LtpStack({
  combinedLtp, live, ceValue, peValue, pcr, pcrOi, compact = false,
}: {
  combinedLtp: number;
  live: RowLive;
  ceValue: number | null;
  peValue: number | null;
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
        <div className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500 leading-none mb-1">Prem</div>
        <div
          title="Combined CE + PE premium right now"
          className={cn(
            'font-mono font-black text-zinc-100 tabular-nums leading-none',
            compact ? 'text-sm' : 'text-base',
          )}
        >
          {combinedLtp > 0 ? combinedLtp.toFixed(2) : '\u2014'}
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
      <div className="flex rounded-md border border-zinc-800 divide-x divide-zinc-800 overflow-hidden">
        <span
          className="flex-1 min-w-0 px-1.5 py-1 flex flex-col gap-0.5"
          title="Val PCR = PE ₹ value ÷ CE ₹ value at this row's strikes (falls back to PE premium ÷ CE premium if ₹ values are unresolved)"
        >
          <span className="text-[9px] font-black tracking-widest text-amber-500 leading-none">VAL</span>
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
          <span className="text-[9px] font-black tracking-widest text-zinc-400 leading-none">OI</span>
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

interface FutQuote {
  ltp: number;
  change_pct: number | null;
}

/** Per-strike order handles from /api/scalper[/<broker>]/lookup. Dhan is the
 *  only broker that trades by numeric security id; the rest trade by symbol. */
interface StrikeRef { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }
interface LookupData { lotSize: number; strikes: Record<string, StrikeRef> }

/** Spot + per-strike premiums, flattened out of /api/options/chain. */
interface ChainData {
  spot: number;
  oc: Record<string, { ce: number; pe: number }>;
}

/** Cache key for `lookups`/`chains` — a row can trade any listed expiry, not
 *  just the nearest, so both caches are keyed per (underlying, expiry) pair
 *  rather than per underlying alone. */
function expKey(underlying: FocusUnderlying, expiry: string): string {
  return `${underlying}:${expiry}`;
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

/** Heartbeat record from scripts/tools/focus_tool_rows_worker.py, corrected by
 *  the API route against the PID and the heartbeat age. */
interface WorkerStatusRow {
  id: string;
  /** The worker's ledger holds a position for this row. */
  open?: boolean;
  /** Config status the worker last saw / wrote (entered/exited). */
  status?: string;
  ceStrike?: number | null;
  peStrike?: number | null;
  /** Absolute units the worker still holds on each leg. */
  ceQty?: number;
  peQty?: number;
  /** Realised from legs this worker already closed/rolled on this row. */
  bookedPnl?: number;
  pnl?: number;
}

interface WorkerStatus {
  /** UNKNOWN is the client-side initial value, before the first heartbeat poll
   *  has landed — it is never reported by the API. It exists so the in-tab
   *  executor can tell "the worker is stopped" apart from "we have not asked
   *  yet", which are not the same decision. */
  status: 'RUNNING' | 'STOPPED' | 'STALE' | 'ERROR' | 'UNKNOWN';
  pid?: number;
  broker?: string;
  dryRun?: boolean;
  liveRealMoney?: boolean;
  openRows?: number;
  totalPnl?: number;
  peakPnl?: number;
  lockFloor?: number | null;
  trailState?: string;
  lastUpdate?: string;
  note?: string;
  error?: string;
  /** Per-row snapshot. Used as a strike pin for rows the WORKER entered — it
   *  never writes `status: 'entered'` back into the config, so without this the
   *  page would keep resolving those rows off the live ATM and lose them the
   *  same way it lost its own (see FocusRowFill). */
  rows?: WorkerStatusRow[];
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
  entryTime: '09:20',
  exitTime: '15:15',
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
  levelHigh: '',
  levelLow: '',
  levelVw: false,
  vwapInterval: '1',
  vwapBufferPct: '0.1',
  slRupees: '',
  slMultiplier: '1.2',
  ceSlMultiplier: '1.2',
  peSlMultiplier: '1.2',
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

/** Micro-type scale for dense control/label text. FocusTool runs almost
 *  entirely below Tailwind's text-xs (12px) floor — these are the four sizes
 *  already in use throughout the file, named once so new UI picks one of
 *  four instead of a fifth arbitrary value. */
const TXT_MICRO   = 'text-[8px]';  // stat labels (SPOT/ATM/LOT/DTE), column footnotes
const TXT_LABEL   = 'text-[9px]';  // field labels, badges, uppercase tags — default micro size
const TXT_VALUE   = 'text-[10px]'; // secondary readouts: VWAP, PCR, timing text
const TXT_CAPTION = 'text-[11px]'; // switch labels, primary compact inputs

function LivePulse({ active }: { active: boolean }) {
  return (
    <span title={active ? 'Live tick feed connected' : 'Live tick feed not running'} className={cn(
      'inline-flex items-center gap-1.5 text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider border',
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
function RuleNumStepper({ value, onCommit, className, title, disabled }: {
  value: string; onCommit: (v: string) => void; className?: string; title?: string; disabled?: boolean;
}) {
  const step = (delta: number) => onCommit(String((Number(value) || 0) + delta));
  return (
    <div className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={disabled}
        title="Decrease by 1"
        aria-label="Decrease by 1"
        className={cn('h-6 w-5 shrink-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}
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
        className={cn('h-6 w-5 shrink-0 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}
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
    <select
      value={value}
      title={title}
      onChange={e => onChange(Math.max(1, Number(e.target.value) || 1))}
      className={cn(
        'text-[10px] font-bold h-6 px-0.5 border border-zinc-700 rounded bg-zinc-900 text-zinc-200',
        'focus:outline-none focus:border-violet-500 cursor-pointer',
        className,
      )}
    >
      {opts.map(n => <option key={n} value={n}>{n}</option>)}
    </select>
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
      title={`Broker position: ${qty > 0 ? 'long' : 'short'} ${Math.abs(qty)} @ avg ${avg.toFixed(2)}`}
      className={cn(
        'text-[9px] font-black px-1 py-0.5 rounded border uppercase tracking-wide whitespace-nowrap',
        qty < 0
          ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
          : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      )}
    >
      {qty < 0 ? 'S' : 'L'} {Math.abs(qty)} @ {avg.toFixed(2)}
    </span>
  );
}

function slTone(now: number | null, stop: number | null, idle: string): string {
  if (now == null || stop == null || !(now > 0) || !(stop > 0)) return idle;
  if (now >= stop) return 'text-rose-400';
  if (now >= stop * 0.9) return 'text-amber-300';
  return idle;
}

/** Calculated SL × premiums under a CE/PE position cell. */
function LegSlLevels({
  row, live, leg, workerHold, align = 'center',
}: {
  row: FocusRow;
  live: RowLive;
  leg: 'CE' | 'PE';
  workerHold?: WorkerStatusRow | null;
  align?: 'center' | 'start';
}) {
  const legLevel = legStopPremium(row, leg, live, workerHold);
  const pairLevel = pairStopPremium(row, live, workerHold);
  if (legLevel == null && pairLevel == null) return null;
  const nowLeg = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? null;
  const nowPair = live.entryPremium > 0
    ? sidePremium(row, live, workerHold)
    : (() => {
        const legs = legsOf(row);
        if (!legs.length) return 0;
        return legs.reduce((s, l) => s + ((l === 'CE' ? live.ltpCe : live.ltpPe) ?? 0), 0) / legs.length;
      })();
  return (
    <div className={cn('flex flex-col gap-0.5 leading-none', align === 'start' ? 'items-start' : 'items-center')}>
      {legLevel != null && (
        <span
          className={cn('text-[10px] font-mono font-bold tabular-nums', slTone(nowLeg, legLevel, leg === 'CE' ? 'text-emerald-400' : 'text-rose-400'))}
          title={`${leg} SL × fires when this leg's premium reaches ${legLevel.toFixed(2)} (entry × ${leg === 'CE' ? row.ceSlMultiplier : row.peSlMultiplier})`}
        >
          {leg} × {legLevel.toFixed(2)}
        </span>
      )}
      {pairLevel != null && (
        <span
          className={cn('text-[10px] font-mono font-bold tabular-nums', slTone(nowPair, pairLevel, 'text-amber-500'))}
          title={`Pair SL × fires when the qty-weighted premium of this row's open legs reaches ${pairLevel.toFixed(2)} (weighted entry × ${row.slMultiplier})`}
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
function TimeInput({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next && next !== value) onChange(next);
  };

  return (
    <div className="relative flex items-center">
      <input
        type="time"
        title={title}
        value={draft}
        onFocus={() => { focusedRef.current = true; }}
        onChange={e => setDraft(e.target.value)}
        onBlur={e => { focusedRef.current = false; commit(e.currentTarget.value); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); }
        }}
        className="h-6 text-[10px] font-mono font-bold pl-1.5 pr-7 border border-zinc-700 rounded bg-zinc-900 text-zinc-100 focus:outline-none focus:border-violet-500 w-[104px]"
      />
      <Clock className="h-3 w-3 text-zinc-600 absolute right-1.5 pointer-events-none" />
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
            'text-[10px] font-bold px-2.5 py-0.5 rounded-md cursor-pointer transition-colors',
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
  onOffsetChange, onPremiumChange, onShift, shiftDisabled, locked,
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
   *  and thresholds as AdvancedScalper — null/'' hides the chip. */
  buildup?: string | null;
  /** OI change vs prev day (%), shown alongside the buildup chip. */
  oiChgPct?: number | null;
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
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn('text-[9px] font-black w-5', leg === 'CE' ? 'text-emerald-400' : 'text-rose-400')}>{leg}</span>
      {mode === 'ATM' ? (
        <select
          value={offset}
          disabled={locked}
          title={locked ? lockedTitle : `${leg} strike as a step offset from ATM`}
          onChange={e => onOffsetChange(Number(e.target.value))}
          className="text-[10px] font-bold h-6 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500 w-24 disabled:opacity-50 disabled:cursor-not-allowed"
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
        className="text-[10px] font-mono font-semibold text-zinc-500 min-w-[38px] text-right"
        title={`Live ${leg} premium at this strike — the reference entry price`}
      >
        {resolvedStrike != null && ltp != null && ltp > 0 ? `@${ltp.toFixed(2)}` : '—'}
      </span>
      {buildupStyle && (
        <span
          className={cn('text-[8px] font-black px-1 py-0.5 rounded border leading-none', buildupStyle.cls)}
          title={`${buildupStyle.text}${oiChgPct != null && oiChgPct !== 0 ? ` — OI ${oiChgPct > 0 ? '+' : ''}${oiChgPct.toFixed(1)}%` : ''}`}
        >
          {buildup}
        </span>
      )}
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
  );
}

/** The full CE/PE strike editor for one row: ATM±/₹ mode toggle, independent
 *  CE and PE selectors, a link checkbox to keep them mirrored, and Save/clear. */
function StrikeEditor({ row, live, step, onUpdate, onShift, shiftDisabled, onBlocked, workerHold }: {
  row: FocusRow;
  live: RowLive;
  step: number;
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onShift?: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  shiftDisabled?: boolean;
  onBlocked?: (message: string) => void;
  workerHold?: WorkerStatusRow | null;
}) {
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
    CE: rowOwnsLeg(row, 'CE', workerHold),
    PE: rowOwnsLeg(row, 'PE', workerHold),
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

  return (
    <div className="flex flex-col gap-1 w-[236px]">
      <SegPill options={['ATM±', '₹'] as const}
        value={mode === 'ATM' ? 'ATM±' : '₹'}
        onChange={v => {
          // Switching mode re-resolves BOTH legs from a different rule, so an
          // open leg would move — same orphaning as a direct edit.
          if (anyOpen) { onBlocked?.(blockedNote(legOpen.CE ? 'CE' : 'PE')); return; }
          onUpdate({ strikeMode: v === 'ATM±' ? 'ATM' : 'PREMIUM' });
        }}
        title={anyOpen
          ? 'Locked while a leg is open — exit it first'
          : 'ATM± picks a strike by steps from ATM; ₹ picks the closest strike priced at or below a target premium'}
        className="self-start" />
      <StrikeLegSelector leg="CE" mode={mode} offset={row.ceOffset ?? 0} premium={row.cePremium ?? ''}
        resolvedStrike={live.ceStrike} step={step} ltp={live.ltpCe} locked={legOpen.CE}
        buildup={live.ceBuildup} oiChgPct={live.ceOiChgPct}
        onOffsetChange={n => setLeg('CE', { ceOffset: n })}
        onPremiumChange={v => setLeg('CE', { cePremium: v })}
        onShift={onShift ? dir => onShift('CE', dir) : undefined} shiftDisabled={shiftDisabled} />
      <StrikeLegSelector leg="PE" mode={mode} offset={row.peOffset ?? 0} premium={row.pePremium ?? ''}
        resolvedStrike={live.peStrike} step={step} ltp={live.ltpPe} locked={legOpen.PE}
        buildup={live.peBuildup} oiChgPct={live.peOiChgPct}
        onOffsetChange={n => setLeg('PE', { peOffset: n })}
        onPremiumChange={v => setLeg('PE', { pePremium: v })}
        onShift={onShift ? dir => onShift('PE', dir) : undefined} shiftDisabled={shiftDisabled} />
      <div className="flex items-center justify-between mt-0.5">
        <label title="Keep CE and PE moving together" className="inline-flex items-center gap-1 text-[9px] font-bold text-zinc-500 cursor-pointer select-none">
          <input type="checkbox" checked={row.linked ?? true}
            onChange={e => onUpdate({ linked: e.target.checked })}
            className="h-3 w-3 rounded-sm border-zinc-700 bg-zinc-900 accent-violet-500" />
          link
        </label>
        <div className="flex items-center gap-1.5">
          <button onClick={() => onUpdate(row, true)} title="Save this row's strike settings"
            className={cn('text-[9px] font-bold text-emerald-400 hover:text-emerald-300 cursor-pointer rounded', FOCUS_RING)}>
            <Check className="h-2.5 w-2.5 inline -mt-0.5" /> Save
          </button>
          <button
            onClick={() => {
              if (anyOpen) { onBlocked?.(blockedNote(legOpen.CE ? 'CE' : 'PE')); return; }
              onUpdate({
                strikeMode: 'ATM', linked: true, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '',
              }, true);
            }}
            title={anyOpen ? 'Locked while a leg is open — exit it first' : "Reset this row's strike settings to ATM"}
            className={cn('text-[9px] text-zinc-500 hover:text-zinc-400 cursor-pointer rounded', FOCUS_RING)}
          >
            &times; clear
          </button>
        </div>
      </div>
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
  futQuotes, realised, unrealised, total, marginAvailable, marginUtilized,
  wsLive, broker, setBroker, authenticatedBrokers,
}: {
  futQuotes: Record<FocusUnderlying, FutQuote | null>;
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
          <p className="text-[9px] font-bold text-violet-400 uppercase tracking-[0.18em] mb-0.5">
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
        {UNDERLYINGS.map(u => {
          const q = futQuotes[u];
          const chg = q?.change_pct;
          return (
            <div key={u} className="flex flex-col items-center"
              title={`${FUT_LABELS[u]} last price and % change since previous close`}>
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">{FUT_LABELS[u]}</span>
              <span className="text-sm font-mono font-black text-zinc-100 tabular-nums">
                {q ? q.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '\u2014'}
              </span>
              {chg != null && (
                <span className={cn('text-[9px] font-mono font-bold', chg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
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
                <span className="text-[8px] font-bold text-zinc-500 uppercase tracking-wider">{label}</span>
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
                <span className="text-[8px] font-bold text-zinc-500 uppercase tracking-wider">{label}</span>
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

function ControlStrip({
  liveRealMoney, onToggleLive, broker,
  riskEnabled, onToggleRisk,
  targetRupees, setTargetRupees,
  stopRupees, setStopRupees,
  trailEnabled, onToggleTrail,
  triggerRupees, setTriggerRupees,
  lockRupees, setLockRupees,
  onSave, saving, totalPnl, peakMtm, lockMtm,
  copyTrade,
  onOpenRisk, onOpenOrders, onOpenOptionChain, onToggleViewMode, viewMode,
  workerStatus, onToggleWorker,
  onExitAll, confirmExitAll, exitingAll,
}: {
  liveRealMoney: boolean; onToggleLive: () => void; broker: Broker;
  riskEnabled: boolean; onToggleRisk: () => void;
  targetRupees: string; setTargetRupees: (v: string) => void;
  stopRupees: string; setStopRupees: (v: string) => void;
  trailEnabled: boolean; onToggleTrail: () => void;
  triggerRupees: string; setTriggerRupees: (v: string) => void;
  lockRupees: string; setLockRupees: (v: string) => void;
  onSave: () => void; saving: boolean; totalPnl: number; peakMtm: number; lockMtm: number | null;
  copyTrade: CopyTradeApi;
  onOpenRisk: () => void;
  onOpenOrders: () => void;
  onOpenOptionChain: () => void;
  onToggleViewMode: () => void;
  viewMode: 'table' | 'cards';
  workerStatus: WorkerStatus;
  onToggleWorker: () => void;
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
            ? 'Live: armed rows place real orders. Click to return to dry run.'
            : 'Dry run: no orders are sent. Click to go live with real money.'}
          className={cn(
            'flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full text-oncolor transition-colors cursor-pointer',
            liveRealMoney ? 'bg-rose-600 hover:bg-rose-500' : 'bg-zinc-700 hover:bg-zinc-600',
            FOCUS_RING,
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-oncolor animate-pulse" />
          LIVE &middot; REAL MONEY
        </button>
        <button
          onClick={onToggleWorker}
          title={workerStatus.status === 'RUNNING'
            ? `Rules are running server-side (PID ${workerStatus.pid ?? '?'}) — entries and exits fire even with this tab closed. Click to stop; open positions are left as they are.`
            : workerStatus.status === 'STALE'
              ? 'The worker process stopped heartbeating — nothing is watching. Click to restart.'
              : workerStatus.status === 'UNKNOWN'
                // Neither executor acts in this window — see tabMayTrade.
                ? 'Checking whether the server-side worker is running. Nothing enters or exits until this resolves.'
                : 'Rules currently run only while this tab is open. Start the worker to keep them running server-side.'}
          className={cn(
            'flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border cursor-pointer transition-colors',
            workerStatus.status === 'RUNNING'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
              : workerStatus.status === 'STALE' || workerStatus.status === 'ERROR'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:border-zinc-600',
            FOCUS_RING,
          )}
        >
          <Server className={cn('h-3.5 w-3.5', workerStatus.status === 'UNKNOWN' && 'animate-pulse')} />
          {workerStatus.status === 'RUNNING'
            ? `Worker on${workerStatus.openRows ? ` · ${workerStatus.openRows}` : ''}`
            : workerStatus.status === 'STALE' ? 'Worker stale'
              : workerStatus.status === 'ERROR' ? 'Worker error'
                : workerStatus.status === 'UNKNOWN' ? 'Worker…' : 'Worker off'}
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          title="Save the free-typed number fields — Target / Stop / Trigger / Lock and each group's Spot H↑/L↓ — to disk, where the Python worker reads them. Everything else (Arm/Exit, Start/Stop, ATM BY, Product, Strikes±, Risk/Trail on-off, LIVE · REAL MONEY) already saves itself the instant you click it."
          className={cn('flex items-center gap-1 text-xs font-bold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 transition-colors cursor-pointer disabled:opacity-50', FOCUS_RING)}
        >
          <Save className="h-3 w-3" /> {saving ? 'Saving…' : 'Save Preferences'}
        </button>
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
        <GhostBtn onClick={onOpenOrders} title="Today's broker order book and tradebook for this account">
          <Activity className="h-3.5 w-3.5 text-zinc-400" />
          Orders
        </GhostBtn>
        <GhostBtn onClick={onOpenOptionChain} title="Live NIFTY option chain — price/OI/volume by strike, with Buy/Sell">
          <Grid3x3 className="h-3.5 w-3.5 text-cyan-400" />
          Option Chain
        </GhostBtn>
        <GhostBtn onClick={onToggleViewMode} title="Toggle between Table and Cards view">
          <Layers className="h-3.5 w-3.5 text-zinc-400" />
          {viewMode === 'cards' ? 'Table' : 'Cards'}
        </GhostBtn>
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
          title="Ratchet a profit floor upward as P&L makes new peaks" />

        <div className="flex items-center gap-1.5">
          <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>Trigger</span>
          <RuleNumInput value={triggerRupees} onCommit={setTriggerRupees} className="w-16" placeholder="0"
            title="Profit (₹) at which the trail wakes up and starts locking" />
        </div>

        <div className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-amber-500" />
          <span className={cn(TXT_VALUE, 'font-black text-zinc-500 uppercase')}>Lock</span>
          <RuleNumInput value={lockRupees} onCommit={setLockRupees} className="w-16" placeholder="0"
            title="Profit (₹) kept back from each new peak — the floor that never falls" />
        </div>

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
          <span className="flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Running
          </span>
        )}

        <div className="h-4 w-px bg-zinc-800" />

        {/* ATM BY */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">ATM BY</span>
          <SegPill options={['Spot', 'Fut'] as const} value={group.atmBy} onChange={v => onChange({ atmBy: v })}
            title="Pick the ATM strike off the index spot or off the future" />
        </div>

        {/* PRODUCT */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">PRODUCT</span>
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
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">STRIKES &plusmn;</span>
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
              <span className="text-[9px] font-black text-rose-400 uppercase">Spot H&uarr;</span>
              <RuleNumInput value={group.spotHigh} onCommit={v => onChange({ spotHigh: v })} className="w-16"
                title="Book out when spot trades at or above this level. Applies when you leave the field, not while typing." />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black text-emerald-400 uppercase">Spot L&darr;</span>
              <RuleNumInput value={group.spotLow} onCommit={v => onChange({ spotLow: v })} className="w-16"
                title="Book out when spot trades at or below this level. Applies when you leave the field, not while typing." />
            </div>
          </div>
        )}
      </div>

      {/* Right stats */}
      <div className="flex items-center gap-4">
        {([
          { label: 'SPOT', hint: 'Current index level', val: spot > 0 ? spot.toFixed(2) : '\u2014' },
          { label: 'ATM', hint: `Nearest strike to ${group.atmBy === 'Fut' ? 'the futures LTP' : 'spot'} right now, per ATM BY`, val: liveAtm > 0 ? liveAtm : '\u2014' },
          { label: 'LOT', hint: 'Contracts in one lot of this index', val: lot ?? '\u2014' },
          { label: 'DTE', hint: 'Days to the nearest expiry', val: dte ?? '\u2014' },
        ] as const).map(({ label, val, hint }) => (
          <div key={label} className="flex flex-col items-center" title={hint}>
            <span className={cn(TXT_MICRO, 'font-bold text-zinc-600 uppercase tracking-widest')}>{label}</span>
            <span className="text-xs font-mono font-bold text-zinc-200 tabular-nums">{val}</span>
          </div>
        ))}
        {wsLive && (
          <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/25 uppercase tracking-wider">
            LIVE
          </span>
        )}
      </div>
    </div>
  );
}

// ── Table Row ─────────────────────────────────────────────────────────────────

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
    workerHold?: WorkerStatusRow | null; expiries?: string[] },
  next: typeof prev,
): boolean {
  return prev.row === next.row && prev.live === next.live
    && prev.lotSize === next.lotSize && prev.spot === next.spot
    && prev.liveRealMoney === next.liveRealMoney && prev.broker === next.broker
    && prev.busy === next.busy && prev.rowIndex === next.rowIndex
    && prev.workerHold?.open === next.workerHold?.open
    && prev.workerHold?.ceStrike === next.workerHold?.ceStrike
    && prev.workerHold?.peStrike === next.workerHold?.peStrike
    && prev.expiries === next.expiries;
}

function FocusTableRowImpl({
  row, rowIndex, live, lotSize, spot, liveRealMoney, broker, busy,
  workerHold, expiries,
  onUpdate, onDelete, onArm, onDisarm, onExit, onAddLot, onReduceLot, onShift, onBlocked,
}: {
  row: FocusRow;
  rowIndex: number;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  workerHold?: WorkerStatusRow | null;
  /** This row's underlying's available expiries, nearest first. */
  expiries: string[];
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onAddLot: (leg: 'CE' | 'PE', lots: number) => void;
  onReduceLot: (leg: 'CE' | 'PE', lots: number) => void;
  onShift: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  onBlocked: (message: string) => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const { ceValue, peValue, pcr, pcrOi } = legValues(row, live, lotSize);
  // Orders are only sendable once at least one leg's contract and the lot size
  // are known — placeLeg re-checks the specific leg it is about to trade.
  const canTrade = liveRealMoney && !busy && (live.ceStrike != null || live.peStrike != null) && (lotSize ?? 0) > 0;
  // Ownership, not raw broker qty: a ghost worker pin (broker already flat) must
  // still offer Exit so placeLeg can queue the drop-leg clear. A coincidental
  // book at this strike that THIS row never opened stays locked out.
  const flat = rowFlat(row, workerHold);
  const ceFlat = !rowOwnsLeg(row, 'CE', workerHold);
  const peFlat = !rowOwnsLeg(row, 'PE', workerHold);
  // Why the leg buttons are greyed out. They used to stay clickable in every
  // one of these states and only report the problem as a toast after the fact.
  const tradeBlockedWhy = !liveRealMoney
    ? 'Dry run — turn on LIVE · REAL MONEY to place orders'
    : busy
      ? 'An order for this row is already in flight'
      : (lotSize ?? 0) <= 0
        ? 'Lot size for this index has not resolved yet'
        : 'Strike not resolved yet';
  const step = STRIKE_STEP[row.underlying];
  // How many lots the +/- buttons act on, independently per leg — e.g. add 2
  // lots of CE and 1 of PE in one click each, rather than clicking + twice on
  // one side. UI-only convenience, not persisted with the row.
  const [ceQty, setCeQty] = useState(1);
  const [peQty, setPeQty] = useState(1);
  // Expiry, like strike, is locked once this row owns a leg — moving it would
  // orphan position tracking the same way editing an owned leg's strike would
  // (see StrikeEditor's doc comment).
  const expiryLocked = rowOwnsLeg(row, 'CE', workerHold) || rowOwnsLeg(row, 'PE', workerHold);
  // DTE (0/1/0+1) only means something relative to the NEAREST expiry — a row
  // that picked a further-out expiry has its own fixed DTE that never changes
  // day to day, so the filter is disabled rather than silently inert.
  const onNearestExpiry = !row.expiry || row.expiry === expiries[0];

  return (
    <tr className={cn(
      'border-b border-zinc-800/80 transition-colors',
      !flat ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : cn(
        rowIndex % 2 === 1 && 'bg-zinc-900/25',
        'hover:bg-zinc-800/35',
      ),
    )}>

      {/* TIMING */}
      <td className={cn(
        'p-3 align-top',
        !flat && 'border-l-2 border-l-emerald-500',
        flat && 'border-l-2 border-l-transparent',
      )}>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-zinc-600 w-8">ENTRY</span>
            <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: v })}
              title="Time of day this row enters, once armed" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-zinc-600 w-8">EXIT</span>
            <TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: v })}
              title="Time of day this row closes, whatever the P&L" />
          </div>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] font-black text-zinc-600 w-8">EXPY</span>
            <select
              value={row.expiry || expiries[0] || ''}
              disabled={expiryLocked || expiries.length === 0}
              onChange={e => onUpdate({ expiry: e.target.value })}
              title={expiryLocked
                ? 'Locked while a leg is open — exit it first, or use the shift chevrons to roll it'
                : 'Which listed expiry this row trades'}
              className="text-[10px] font-bold h-6 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] font-black text-zinc-600 w-8"
              title="Only enter when the row's expiry is this many days away — active only while trading the nearest expiry">DTE</span>
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <button
                key={d}
                onClick={() => onUpdate({ dte: d })}
                disabled={!onNearestExpiry}
                title={!onNearestExpiry
                  ? 'DTE only applies when trading the nearest expiry'
                  : d === 'Any' ? 'Enter on any expiry' : `Enter only when expiry is ${d} day(s) away`}
                className={cn(
                  'text-[10px] font-extrabold px-2 py-0.5 rounded cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  row.dte === d
                    ? 'bg-violet-600 text-oncolor'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200',
                  FOCUS_RING,
                )}
              >{d}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onUpdate(row, true)}
              title="Save this row's timing settings"
              className={cn('flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors', FOCUS_RING)}
            >
              <Check className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </td>

      {/* CE / PE STRIKES */}
      <td className="p-3 align-top">
        <StrikeEditor row={row} live={live} step={step} onUpdate={onUpdate} onShift={onShift} shiftDisabled={busy} onBlocked={onBlocked} workerHold={workerHold} />
      </td>

      {/* LTP */}
      <td className="p-3 align-top">
        <LtpStack
          combinedLtp={combinedLtp}
          live={live}
          ceValue={ceValue}
          peValue={peValue}
          pcr={pcr}
          pcrOi={pcrOi}
        />
      </td>

      {/* LOTS */}
      <td className="p-3 align-top">
        <LotStepper value={row.lots} onChange={v => onUpdate({ lots: v })} />
      </td>

      {/* SIDE */}
      <td className="p-3 align-top border-r-2 border-r-zinc-700">
        <SegPill
          options={['CE', 'BOTH', 'PE'] as const}
          value={row.side as 'CE' | 'BOTH' | 'PE'}
          title="Which legs to trade: call only, put only, or both"
          onChange={s => onUpdate({ side: s })}
        />
      </td>

      {/* STATUS / ACTIONS */}
      <td className="p-3 align-top text-center border-r-2 border-r-zinc-700">
        <div className="flex flex-col items-center gap-2">
          <span title="Draft/Armed are this row's own watch state (set by Arm/Disarm below) — they track whether a position is actually open only loosely, since nothing here auto-enters yet. Whether legs are OPEN is shown by the CE/PE badges and Exit All below, straight off the broker."
            className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border capitalize', STATUS_PILL[row.status])}>
            {row.status}
          </span>
          {!flat && (
            <span title="Realised + unrealised P&L across the legs this row's Side trades, off the broker's own position"
              className={cn('text-xs font-mono font-bold tabular-nums',
                live.pnl > 0 ? 'text-emerald-400' : live.pnl < 0 ? 'text-rose-400' : 'text-zinc-400')}>
              {live.pnl >= 0 ? '+' : ''}₹{live.pnl.toFixed(0)}
            </span>
          )}
          {(row.status === 'draft' || row.status === 'exited') && (
            <button
              onClick={onArm}
              title="Watch this row and enter it at its entry time"
              className={cn('text-xs font-extrabold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 cursor-pointer transition-colors', FOCUS_RING)}
            >
              Arm
            </button>
          )}
          {row.status === 'armed' && (
            <button
              onClick={onDisarm}
              title="Stop watching this row - it will not enter"
              className={cn('text-xs font-extrabold px-3 py-1 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600 cursor-pointer transition-colors', FOCUS_RING)}
            >
              Disarm
            </button>
          )}
          <button
            onClick={() => onExit('ALL')}
            disabled={flat || !canTrade}
            title={flat ? 'Nothing open on this row' : 'Close every open leg of this row at market'}
            className={cn('text-xs font-extrabold px-3 py-1 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}
          >
            Exit All
          </button>
          {flat ? (
            <button
              onClick={onDelete}
              title="Delete this row"
              aria-label="Delete row"
              className={cn('flex items-center gap-1 text-[10px] font-bold text-zinc-500 hover:text-rose-400 cursor-pointer transition-colors', FOCUS_RING)}
            >
              <X className="h-3 w-3" /> Delete
            </button>
          ) : (
            <span
              title="Exit the CE/PE legs before this row can be deleted"
              className="flex items-center gap-1 text-[10px] font-bold text-zinc-700 cursor-not-allowed"
            >
              <X className="h-3 w-3" /> Delete
            </span>
          )}
        </div>
      </td>

      {/* CE */}
      <td className="p-3 align-top text-center">
        <div className="flex flex-col items-center gap-1.5">
          <span title="Live premium of the call leg"
            className="text-sm font-mono font-bold text-emerald-400 tabular-nums">
            {live.ltpCe != null ? live.ltpCe.toFixed(2) : '\u2014'}
          </span>
          <LegOpenBadge pos={live.cePosition} />
          <div className="flex items-center gap-1">
            <LegLotSelect value={ceQty} onChange={setCeQty} className="w-10"
              title="Lots the CE +/- buttons act on" />
            <button onClick={() => onAddLot('CE', ceQty)} disabled={!canTrade} title={canTrade ? `Add ${ceQty} lot(s) to the CE leg` : tradeBlockedWhy} aria-label={`Add ${ceQty} lot(s) to the CE leg`} className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}>+</button>
            <button onClick={() => onReduceLot('CE', ceQty)} disabled={!canTrade || ceFlat} title={ceFlat ? 'Nothing open on the CE leg' : canTrade ? `Reduce the CE leg by ${ceQty} lot(s)` : tradeBlockedWhy} aria-label={`Reduce the CE leg by ${ceQty} lot(s)`} className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}>-</button>
            <button onClick={() => onExit('CE')} disabled={!canTrade || ceFlat} title={ceFlat ? 'Nothing open on the CE leg' : canTrade ? 'Close the CE leg at market' : tradeBlockedWhy} className={cn('text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}>Exit</button>
          </div>
          <LegSlLevels row={row} live={live} leg="CE" workerHold={workerHold} />
        </div>
      </td>

      {/* PE */}
      <td className="p-3 align-top text-center border-r-2 border-r-zinc-700">
        <div className="flex flex-col items-center gap-1.5">
          <span title="Live premium of the put leg"
            className="text-sm font-mono font-bold text-rose-400 tabular-nums">
            {live.ltpPe != null ? live.ltpPe.toFixed(2) : '\u2014'}
          </span>
          <LegOpenBadge pos={live.pePosition} />
          <div className="flex items-center gap-1">
            <LegLotSelect value={peQty} onChange={setPeQty} className="w-10"
              title="Lots the PE +/- buttons act on" />
            <button onClick={() => onAddLot('PE', peQty)} disabled={!canTrade} title={canTrade ? `Add ${peQty} lot(s) to the PE leg` : tradeBlockedWhy} aria-label={`Add ${peQty} lot(s) to the PE leg`} className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}>+</button>
            <button onClick={() => onReduceLot('PE', peQty)} disabled={!canTrade || peFlat} title={peFlat ? 'Nothing open on the PE leg' : canTrade ? `Reduce the PE leg by ${peQty} lot(s)` : tradeBlockedWhy} aria-label={`Reduce the PE leg by ${peQty} lot(s)`} className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}>-</button>
            <button onClick={() => onExit('PE')} disabled={!canTrade || peFlat} title={peFlat ? 'Nothing open on the PE leg' : canTrade ? 'Close the PE leg at market' : tradeBlockedWhy} className={cn('text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors', FOCUS_RING)}>Exit</button>
          </div>
          <LegSlLevels row={row} live={live} leg="PE" workerHold={workerHold} />
        </div>
      </td>

      {/* LEVEL EXITS */}
      <td className="p-3 align-top text-center">
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-black text-rose-400">H&uarr;</span>
              <RuleNumStepper value={row.levelHigh} onCommit={v => onUpdate({ levelHigh: v })} className="w-14"
                title="Exit this row when spot trades at or above this level. Applies when you leave the field, not while typing." />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-black text-emerald-400">L&darr;</span>
              <RuleNumStepper value={row.levelLow} onCommit={v => onUpdate({ levelLow: v })} className="w-14"
                title="Exit this row when spot trades at or below this level. Applies when you leave the field, not while typing." />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VW"
              title="Exit when the combined premium crosses its session-open VWAP against you" />
            {row.levelVw && (
              <>
                <select
                  value={row.vwapInterval || '1'}
                  title="Candle interval the session-open VWAP is computed from"
                  onChange={e => onUpdate({ vwapInterval: e.target.value })}
                  className="text-[9px] font-bold h-5 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-300 focus:outline-none focus:border-violet-500"
                >
                  <option value="1">1m</option>
                  <option value="5">5m</option>
                </select>
                <div className="flex items-center gap-0.5">
                  <span className="text-[9px] font-black text-zinc-500">buf%</span>
                  <RuleNumInput value={row.vwapBufferPct} onCommit={v => onUpdate({ vwapBufferPct: v })} className="w-10"
                    title="Require the closed candle to clear VWAP by more than this % before exiting — blank means no buffer" />
                </div>
                <span className="text-[9px] font-mono font-bold text-zinc-500" title="Session-open VWAP of the combined premium, refreshed once a minute">
                  {live.vwap != null ? `VWAP ${live.vwap.toFixed(2)}` : 'VWAP —'}
                </span>
              </>
            )}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-amber-400">SL &#8377;</span>
                <RuleNumInput value={row.slRupees} onCommit={v => onUpdate({ slRupees: v })} className="w-14"
                  title="Exit at this rupee loss on the pair — independent of SL &times;. Applies when you leave the field, not while typing." />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-amber-500">SL &times;</span>
                <RuleNumInput value={row.slMultiplier} onCommit={v => onUpdate({ slMultiplier: v })} className="w-12"
                  title="Exit when premium moves this multiple against you (must be above 1) — independent of SL &#8377;" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-emerald-400">CE &times;</span>
                <RuleNumInput value={row.ceSlMultiplier ?? '1.2'} onCommit={v => onUpdate({ ceSlMultiplier: v })} className="w-12"
                  title="Exit CE alone when its own premium moves this multiple against its own entry — independent of PE and of the pair SL &times; above" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-rose-400">PE &times;</span>
                <RuleNumInput value={row.peSlMultiplier ?? '1.2'} onCommit={v => onUpdate({ peSlMultiplier: v })} className="w-12"
                  title="Exit PE alone when its own premium moves this multiple against its own entry — independent of CE and of the pair SL &times; above" />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onUpdate(row, true)}
              title="Save this row's level exits"
              className={cn('flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors', FOCUS_RING)}
            >
              <Check className="h-3 w-3" /> Save
            </button>
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1', slRupees: '', slMultiplier: '1.2', ceSlMultiplier: '1.2', peSlMultiplier: '1.2' }, true)}
              title="Clear every level exit on this row"
              className={cn('text-[10px] font-bold text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors', FOCUS_RING)}
            >
              &times; clear
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}
const FocusTableRow = memo(FocusTableRowImpl, rowDataPropsEqual);

// ── Card view for a single row ────────────────────────────────────────────────

function FocusRowCardImpl({
  row, live, lotSize, spot, liveRealMoney, broker, busy,
  workerHold, expiries,
  onUpdate, onDelete, onArm, onDisarm, onExit, onAddLot, onReduceLot, onShift, onBlocked,
}: {
  row: FocusRow;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  workerHold?: WorkerStatusRow | null;
  /** This row's underlying's available expiries, nearest first. */
  expiries: string[];
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onAddLot: (leg: 'CE' | 'PE', lots: number) => void;
  onReduceLot: (leg: 'CE' | 'PE', lots: number) => void;
  onShift: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  onBlocked: (message: string) => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const { ceValue, peValue, pcr, pcrOi } = legValues(row, live, lotSize);
  const canTrade = liveRealMoney && !busy && (live.ceStrike != null || live.peStrike != null) && (lotSize ?? 0) > 0;
  // Ownership, not raw broker qty: a ghost worker pin (broker already flat) must
  // still offer Exit so placeLeg can queue the drop-leg clear. A coincidental
  // book at this strike that THIS row never opened stays locked out.
  const flat = rowFlat(row, workerHold);
  const ceFlat = !rowOwnsLeg(row, 'CE', workerHold);
  const peFlat = !rowOwnsLeg(row, 'PE', workerHold);
  // Why the leg buttons are greyed out. They used to stay clickable in every
  // one of these states and only report the problem as a toast after the fact.
  const tradeBlockedWhy = !liveRealMoney
    ? 'Dry run — turn on LIVE · REAL MONEY to place orders'
    : busy
      ? 'An order for this row is already in flight'
      : (lotSize ?? 0) <= 0
        ? 'Lot size for this index has not resolved yet'
        : 'Strike not resolved yet';
  const step = STRIKE_STEP[row.underlying];
  // How many lots the +/- buttons act on, independently per leg — see the
  // matching note in FocusTableRow. UI-only, not persisted.
  const [ceQty, setCeQty] = useState(1);
  const [peQty, setPeQty] = useState(1);
  // See the matching note in FocusTableRow.
  const expiryLocked = rowOwnsLeg(row, 'CE', workerHold) || rowOwnsLeg(row, 'PE', workerHold);
  const onNearestExpiry = !row.expiry || row.expiry === expiries[0];

  return (
    <div className={cn(
      'rounded-xl border bg-zinc-900/60 p-4 flex flex-col gap-3',
      !flat
        ? 'border-emerald-500/40 border-l-[3px] border-l-emerald-500'
        : 'border-zinc-800 hover:border-zinc-700/60',
    )}>
      {/* Header Info */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
        <div className="flex flex-col">
          <span className="text-xs font-bold text-white tracking-wide">{row.underlying}</span>
          <span className="text-[10px] text-zinc-500 font-mono mt-0.5">
            {row.side} &middot; {row.lots} Lot{row.lots > 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {!flat && (
            <span title="Realised + unrealised P&L across the legs this row's Side trades"
              className={cn('text-xs font-mono font-bold tabular-nums',
                live.pnl > 0 ? 'text-emerald-400' : live.pnl < 0 ? 'text-rose-400' : 'text-zinc-400')}>
              {live.pnl >= 0 ? '+' : ''}₹{live.pnl.toFixed(0)}
            </span>
          )}
          <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded-full border capitalize', STATUS_PILL[row.status])}>
            {row.status}
          </span>
          <button
            onClick={onDelete}
            disabled={!flat}
            title={flat ? 'Delete this row' : 'Exit the CE/PE legs before this row can be deleted'}
            aria-label="Delete row"
            className={cn('text-zinc-600 hover:text-rose-400 disabled:hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 font-bold text-xs p-1', FOCUS_RING)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Timing and DTE */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-black text-zinc-500 w-9">ENTRY</span>
          <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: v })} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-black text-zinc-500 w-9">EXIT</span>
          <TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: v })} />
        </div>
        <div className="col-span-2 flex items-center gap-1.5 mt-0.5">
          <span className="text-[8px] font-black text-zinc-500 w-9">EXPY</span>
          <select
            value={row.expiry || expiries[0] || ''}
            disabled={expiryLocked || expiries.length === 0}
            onChange={e => onUpdate({ expiry: e.target.value })}
            title={expiryLocked
              ? 'Locked while a leg is open — exit it first, or use the shift chevrons to roll it'
              : 'Which listed expiry this row trades'}
            className="text-[9px] font-bold h-5 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {expiries.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div className="col-span-2 flex items-center gap-1.5 mt-0.5">
          <span className="text-[8px] font-black text-zinc-500 w-9" title="Active only while trading the nearest expiry">DTE</span>
          <div className="flex gap-1">
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <button
                key={d}
                onClick={() => onUpdate({ dte: d })}
                disabled={!onNearestExpiry}
                title={!onNearestExpiry ? 'DTE only applies when trading the nearest expiry' : undefined}
                className={cn(
                  'text-[9px] font-extrabold px-1.5 py-0.5 rounded cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  row.dte === d ? 'bg-violet-600 text-oncolor' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700',
                  FOCUS_RING,
                )}
              >{d}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Strike + LTP readout */}
      <div className="grid grid-cols-[1fr_auto] gap-3 bg-zinc-950/30 rounded-xl p-3 border border-zinc-800/50">
        <div className="flex flex-col gap-0.5">
          <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider">CE / PE Strike</span>
          <span className="font-mono font-bold text-zinc-200 text-sm">
            {live.ceStrike ?? '\u2014'} / {live.peStrike ?? '\u2014'}
          </span>
        </div>
        <LtpStack
          combinedLtp={combinedLtp}
          live={live}
          ceValue={ceValue}
          peValue={peValue}
          pcr={pcr}
          pcrOi={pcrOi}
          compact
        />
      </div>

      {/* Strike editor */}
      <div className="bg-zinc-950/20 border border-zinc-800/40 rounded-xl p-3">
        <StrikeEditor row={row} live={live} step={step} onUpdate={onUpdate} onShift={onShift} shiftDisabled={busy} onBlocked={onBlocked} workerHold={workerHold} />
      </div>

      {/* CE and PE Legs */}
      <div className="flex flex-col gap-2 bg-zinc-950/20 border border-zinc-800/40 rounded-xl p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-emerald-400">CE</span>
            <span className="text-xs font-mono font-bold text-zinc-300">{live.ltpCe != null ? live.ltpCe.toFixed(2) : '—'}</span>
            <LegOpenBadge pos={live.cePosition} />
          </div>
          <div className="flex items-center gap-1">
            <LegLotSelect value={ceQty} onChange={setCeQty} className="w-9 h-5"
              title="Lots the CE +/- buttons act on" />
            <button onClick={() => onAddLot('CE', ceQty)} disabled={!canTrade} title={canTrade ? `Add ${ceQty} CE lot(s)` : tradeBlockedWhy} aria-label={`Add ${ceQty} CE lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}>+</button>
            <button onClick={() => onReduceLot('CE', ceQty)} disabled={!canTrade || ceFlat} title={ceFlat ? 'Nothing open on the CE leg' : canTrade ? `Reduce CE by ${ceQty} lot(s)` : tradeBlockedWhy} aria-label={`Reduce CE by ${ceQty} lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}>-</button>
            <button onClick={() => onExit('CE')} disabled={!canTrade || ceFlat} title={ceFlat ? 'Nothing open on the CE leg' : canTrade ? 'Exit CE leg' : tradeBlockedWhy} className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}>Exit</button>
          </div>
        </div>
        <LegSlLevels row={row} live={live} leg="CE" workerHold={workerHold} align="start" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-rose-400">PE</span>
            <span className="text-xs font-mono font-bold text-zinc-300">{live.ltpPe != null ? live.ltpPe.toFixed(2) : '—'}</span>
            <LegOpenBadge pos={live.pePosition} />
          </div>
          <div className="flex items-center gap-1">
            <LegLotSelect value={peQty} onChange={setPeQty} className="w-9 h-5"
              title="Lots the PE +/- buttons act on" />
            <button onClick={() => onAddLot('PE', peQty)} disabled={!canTrade} title={canTrade ? `Add ${peQty} PE lot(s)` : tradeBlockedWhy} aria-label={`Add ${peQty} PE lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}>+</button>
            <button onClick={() => onReduceLot('PE', peQty)} disabled={!canTrade || peFlat} title={peFlat ? 'Nothing open on the PE leg' : canTrade ? `Reduce PE by ${peQty} lot(s)` : tradeBlockedWhy} aria-label={`Reduce PE by ${peQty} lot(s)`} className={cn('h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}>-</button>
            <button onClick={() => onExit('PE')} disabled={!canTrade || peFlat} title={peFlat ? 'Nothing open on the PE leg' : canTrade ? 'Exit PE leg' : tradeBlockedWhy} className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}>Exit</button>
          </div>
        </div>
        <LegSlLevels row={row} live={live} leg="PE" workerHold={workerHold} align="start" />
      </div>

      {/* Level Exits */}
      <div className="flex flex-col gap-1 text-[11px]">
        <div className="flex justify-between items-center">
          <span className="text-rose-400 text-[9px] font-black">H&uarr;</span>
          <RuleNumStepper value={row.levelHigh} onCommit={v => onUpdate({ levelHigh: v })} className="w-14 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-emerald-400 text-[9px] font-black">L&darr;</span>
          <RuleNumStepper value={row.levelLow} onCommit={v => onUpdate({ levelLow: v })} className="w-14 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-amber-400 text-[9px] font-black">SL ₹</span>
          <RuleNumInput value={row.slRupees} onCommit={v => onUpdate({ slRupees: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-amber-500 text-[9px] font-black">SL &times;</span>
          <RuleNumInput value={row.slMultiplier} onCommit={v => onUpdate({ slMultiplier: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-emerald-400 text-[9px] font-black" title="Exit CE alone on its own premium multiple, independent of PE and of SL × above">CE &times;</span>
          <RuleNumInput value={row.ceSlMultiplier ?? '1.2'} onCommit={v => onUpdate({ ceSlMultiplier: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-rose-400 text-[9px] font-black" title="Exit PE alone on its own premium multiple, independent of CE and of SL × above">PE &times;</span>
          <RuleNumInput value={row.peSlMultiplier ?? '1.2'} onCommit={v => onUpdate({ peSlMultiplier: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VW"
            title="Exit when the combined premium crosses its session-open VWAP against you" />
          {row.levelVw && (
            <>
              <select
                value={row.vwapInterval || '1'}
                title="Candle interval the session-open VWAP is computed from"
                onChange={e => onUpdate({ vwapInterval: e.target.value })}
                className="text-[9px] font-bold h-5 px-1 border border-zinc-700 rounded bg-zinc-900 text-zinc-300 focus:outline-none focus:border-violet-500"
              >
                <option value="1">1m</option>
                <option value="5">5m</option>
              </select>
              <div className="flex items-center gap-0.5">
                <span className="text-[9px] font-black text-zinc-500">buf%</span>
                <RuleNumInput value={row.vwapBufferPct} onCommit={v => onUpdate({ vwapBufferPct: v })} className="w-10 h-6"
                  title="Require the closed candle to clear VWAP by more than this % before exiting — blank means no buffer" />
              </div>
              <span className="text-[9px] font-mono font-bold text-zinc-500">
                {live.vwap != null ? `VWAP ${live.vwap.toFixed(2)}` : 'VWAP —'}
              </span>
            </>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => onUpdate(row, true)}
              className={cn('text-[9px] font-bold text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded hover:bg-emerald-500/10', FOCUS_RING)}
            >
              Save Exits
            </button>
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1', slRupees: '', slMultiplier: '1.2', ceSlMultiplier: '1.2', peSlMultiplier: '1.2' }, true)}
              className={cn('text-[9px] text-zinc-500 hover:text-zinc-400', FOCUS_RING)}
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Row Control Actions */}
      <div className="flex justify-end gap-2 border-t border-zinc-800/80 pt-2.5 mt-1">
        {(row.status === 'draft' || row.status === 'exited') && (
          <button onClick={onArm} className={cn('text-xs font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500', FOCUS_RING)}>
            Arm Row
          </button>
        )}
        {row.status === 'armed' && (
          <button onClick={onDisarm} className={cn('text-xs font-bold px-3 py-1.5 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600', FOCUS_RING)}>
            Disarm
          </button>
        )}
        <button onClick={() => onExit('ALL')} disabled={flat || !canTrade}
          title={flat ? 'Nothing open on this row' : 'Close every open leg of this row at market'}
          className={cn('text-xs font-extrabold px-3 py-1.5 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING)}>
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
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** 'drawer' (default): right-side sliding panel, for compact detail views.
   *  'center': full-width centered dialog, for data-table-heavy content like
   *  the order/trade book that needs every column visible without scrolling. */
  variant?: 'drawer' | 'center';
}) {
  if (!isOpen) return null;
  if (variant === 'center') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-oncolor-dark/70 backdrop-blur-sm transition-opacity">
        <div className="w-full max-w-6xl max-h-[90vh] bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4 shadow-2xl text-white overflow-hidden">
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
  const [saving, setSaving] = useState(false);
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
  const [futQuotes, setFutQuotes] = useState<Record<FocusUnderlying, FutQuote | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
  const [spotPrices, setSpotPrices] = useState<Record<FocusUnderlying, number>>({
    NIFTY: 0, BANKNIFTY: 0, SENSEX: 0,
  });
  const [lotSizes, setLotSizes] = useState<Record<FocusUnderlying, number | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
  const [expiries, setExpiries] = useState<Record<FocusUnderlying, string[]>>({
    NIFTY: [], BANKNIFTY: [], SENSEX: [],
  });
  // Keyed by expKey(underlying, expiry) — a row can trade any listed expiry,
  // not just the nearest, so these can no longer be one entry per underlying.
  // See expKey's doc comment.
  const [lookups, setLookups] = useState<Record<string, LookupData | null>>({});
  const [chains, setChains] = useState<Record<string, ChainData | null>>({});
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
  // Rows the scheduler has already auto-entered. Same reasoning, plus: the
  // entry window stays open for the rest of the session, so without this a
  // row would re-enter on every 5s tick.
  const autoEnteringRef = useRef<Set<string>>(new Set());
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

  const [activeModal, setActiveModal] = useState<'risk' | 'orderbook' | 'optionchain' | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderSort, setOrderSort] = useState<SortState>({ key: 'createTime', dir: 'desc' });
  const [ordersTab, setOrdersTab] = useState<'orders' | 'trades'>('orders');
  const [trades, setTrades] = useState<Record<string, unknown>[]>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [tradeSort, setTradeSort] = useState<SortState>({ key: 'createTime', dir: 'desc' });

  const [riskEnabled, setRiskEnabled] = useState(config.riskEnabled);
  const [targetRupees, setTargetRupees] = useState(config.targetRupees);
  const [stopRupees, setStopRupees] = useState(config.stopRupees);
  const [trailEnabled, setTrailEnabled] = useState(config.trailEnabled);
  const [triggerRupees, setTriggerRupees] = useState(config.triggerRupees);
  const [lockRupees, setLockRupees] = useState(config.lockRupees);
  const [liveRealMoney, setLiveRealMoney] = useState(config.liveRealMoney);

  // ── Server-side rule engine ──────────────────────────────────────
  // scripts/tools/focus_tool_rows_worker.py runs the same entry/exit rules
  // outside the browser, so a scheduled entry or a level exit still fires with
  // this tab closed. While it is RUNNING the in-tab scheduler stands down —
  // see the scheduler effect — so only one of the two ever places orders.
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>({ status: 'UNKNOWN' });
  const workerRunning = workerStatus.status === 'RUNNING';
  /**
   * May THIS TAB place orders right now?
   *
   * Not simply `liveRealMoney && !workerRunning`. On mount the worker status is
   * UNKNOWN for up to one poll interval, and the saved config (which can carry
   * liveRealMoney: true) usually lands first — so the scheduler's immediate
   * first tick used to run while the worker was up and running the very same
   * rules, double-entering any armed row whose entry time had passed.
   *
   * Standing down while UNKNOWN is the safe asymmetry: a false "stopped"
   * duplicates real orders, a false "running" costs one 3s poll of delay.
   *
   * STALE is excluded for a different reason: it means the heartbeat stopped
   * but the PID is still alive. That process can still place orders, so the tab
   * taking over would be the double-driving this gate exists to prevent —
   * except now against a worker nobody can see the state of. The banner below
   * says so, and the Worker button restarts it (stop-and-wait, then respawn).
   */
  const tabMayTrade = liveRealMoney
    && !['RUNNING', 'UNKNOWN', 'STALE'].includes(workerStatus.status);

  const pollWorker = useCallback(() => {
    fetch('/api/focus-tool/worker')
      .then(r => r.json())
      .then((j: { success?: boolean; status?: WorkerStatus }) => {
        if (j.success && j.status) setWorkerStatus(j.status);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    pollWorker();
    const t = setInterval(pollWorker, 3000);
    return () => clearInterval(t);
  }, [pollWorker]);

  // Adopt enter/exit status the worker writes to disk. The page only loads
  // config once on mount, so without this a worker-driven CE SL → full flat
  // leaves the pill stuck on "armed" and the Arm button never comes back.
  //
  // Never overwrite a local `armed` with a stale `exited`/`entered` snapshot:
  // Arm writes `armed` to disk immediately, but the worker status poll can lag
  // a tick and still report the previous cycle's `exited` — adopting that
  // wiped the Arm button (and a later Save could put `exited` back on disk
  // over the user's Arm).
  useEffect(() => {
    const wrows = workerStatus.rows;
    if (!wrows?.length) return;
    setConfig(prev => {
      let changed = false;
      const nextRows = prev.rows.map(r => {
        const w = wrows.find(x => x.id === r.id);
        const ws = w?.status;
        if (ws !== 'entered' && ws !== 'exited') return r;
        if (r.status === ws) return r;
        // Arm is explicit user intent. A lagging poll can still say `exited`
        // from the previous cycle — never wipe Arm with that. DO adopt
        // `entered` once the worker actually holds, so the pill matches the book.
        if (r.status === 'armed') {
          if (ws === 'entered' && w?.open) {
            changed = true;
            return { ...r, status: 'entered' as FocusRow['status'] };
          }
          return r;
        }
        // entered ← only while the worker still holds something; a stale
        // "entered" after flat must not fight an exited/draft local state.
        if (ws === 'entered' && !w?.open) return r;
        changed = true;
        return { ...r, status: ws as FocusRow['status'] };
      });
      return changed ? { ...prev, rows: nextRows } : prev;
    });
  }, [workerStatus.rows]);

  const toggleWorker = useCallback(async () => {
    const starting = !workerRunning;
    // Remember an explicit stop so the auto-start effect below does not undo
    // it the next time this page mounts. A process that places real orders
    // must not come back just because the user navigated away and returned.
    try {
      if (starting) localStorage.removeItem(WORKER_OPT_OUT_KEY);
      else localStorage.setItem(WORKER_OPT_OUT_KEY, '1');
    } catch { /* private mode / storage disabled — auto-start stays as it was */ }
    try {
      const res = await fetch('/api/focus-tool/worker', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(starting ? { action: 'start', broker } : { action: 'stop' }),
      });
      const j = await res.json() as { success?: boolean; message?: string; error?: string };
      if (j.success) {
        addToast('success', starting ? 'Worker starting' : 'Worker stopping',
          starting
            ? 'Rules now run server-side — safe to close this tab'
            : 'Open positions are left exactly as they are');
      } else {
        addToast('error', starting ? 'Could not start worker' : 'Could not stop worker', j.error);
      }
    } catch (e) {
      addToast('error', 'Worker request failed', String(e));
    }
    setTimeout(pollWorker, 800);
  }, [workerRunning, broker, addToast, pollWorker]);

  // Auto-start the worker on mount, and again whenever the order-routing
  // broker changes — same convention as the live-quote bridge below: a
  // long-lived background process that comes up on its own rather than
  // waiting on a button, and restarts itself onto new routing rather than
  // silently keeping stale broker credentials. Idempotent (the route reports
  // "already running" when the broker hasn't changed) and silent — this isn't
  // a user action, so it doesn't toast the way the manual button does. The
  // worker only PLACES an order once the config's own LIVE - REAL MONEY switch
  // is on, so starting it here is not itself a live-trading decision.
  useEffect(() => {
    // ...unless the user turned it off by hand. See toggleWorker.
    try {
      if (localStorage.getItem(WORKER_OPT_OUT_KEY) === '1') return;
    } catch { /* storage unavailable — fall through and auto-start */ }
    fetch('/api/focus-tool/worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', broker }),
    })
      .then(() => setTimeout(pollWorker, 800))
      .catch(() => {});
  }, [broker, pollWorker]);

  // Standalone bridge (scripts/tools/focus_tool_ws.py) — all three underlyings
  // over one WebSocket connection, independent of AdvancedScalper's
  // one-broker-one-underlying bridge. See useFocusToolWS's own doc comment.
  const { quotes: focusWsQuotes, bridgeStatus: focusWsStatus } = useFocusToolWS();
  const wsLive = focusWsStatus.status === 'RUNNING';

  // Start (or restart onto new expiries) the bridge once all three
  // underlyings' nearest expiry is known. Never stopped on unmount — same
  // long-lived-background-process convention the AdvancedScalper bridge
  // follows, so returning to this page reconnects instantly.
  const niftyExpiry = expiries.NIFTY?.[0];
  const bankniftyExpiry = expiries.BANKNIFTY?.[0];
  const sensexExpiry = expiries.SENSEX?.[0];
  useEffect(() => {
    if (!niftyExpiry || !bankniftyExpiry || !sensexExpiry) return;
    fetch('/api/focus-tool/live-ws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        expiries: { NIFTY: niftyExpiry, BANKNIFTY: bankniftyExpiry, SENSEX: sensexExpiry },
      }),
    }).catch(() => {});
  }, [niftyExpiry, bankniftyExpiry, sensexExpiry]);

  /** Adopt a server-authoritative config: state plus the risk-bar mirrors. */
  const applyServerConfig = useCallback((d: FocusToolConfig) => {
    setConfig(d);
    setRiskEnabled(d.riskEnabled);
    setTargetRupees(d.targetRupees);
    setStopRupees(d.stopRupees);
    setTrailEnabled(d.trailEnabled);
    setTriggerRupees(d.triggerRupees);
    setLockRupees(d.lockRupees);
    // The live arm expires with the session — see FocusToolConfig.liveArmedOn.
    // A config saved live yesterday comes back disarmed, so opening the page in
    // the morning never resumes trading a setup nobody has looked at today.
    setLiveRealMoney(!!d.liveRealMoney && d.liveArmedOn === istToday());
  }, []);

  useEffect(() => {
    fetch('/api/focus-tool/rows')
      .then(r => r.json())
      .then((j: { success: boolean; data?: FocusToolConfig }) => {
        if (j.success && j.data) applyServerConfig(j.data);
      })
      .catch(() => {});
  }, [applyServerConfig]);

  useEffect(() => {
    UNDERLYINGS.forEach(u => {
      fetch(`/api/options/expiries?underlying=${u}&broker=${broker}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (j.success && j.data) setExpiries(prev => ({ ...prev, [u]: j.data! }));
        })
        .catch(() => {});
    });
  }, [broker]);

  useEffect(() => {
    const fetchTopIndices = () => {
      fetch('/api/scalper/top-indices')
        .then(r => r.json())
        .then((j: { success?: boolean; quotes?: Record<string, { ltp: number; change_pct: number | null }> }) => {
          if (!j.quotes) return;
          const q = j.quotes;
          // Spot only. This endpoint has no futures rows at all — the header's
          // futures strip is served by /api/focus-tool/futures below — and it
          // dropped SENSEX in favour of CRUDEOIL, so SENSEX spot comes off its
          // option chain instead (see the chain effect).
          const KEY_MAP: Record<string, FocusUnderlying> = {
            'NIFTY 50': 'NIFTY', 'NIFTY': 'NIFTY', 'BANKNIFTY': 'BANKNIFTY', 'SENSEX': 'SENSEX',
          };
          setSpotPrices(prev => {
            const next = { ...prev };
            for (const [key, val] of Object.entries(q)) {
              const u = KEY_MAP[key];
              if (u && val?.ltp) {
                next[u] = val.ltp;
              }
            }
            return next;
          });
        })
        .catch(() => {});
    };
    fetchTopIndices();
    const t = setInterval(fetchTopIndices, 2000);
    return () => clearInterval(t);
  }, [broker]);

  // ── Futures strip ───────────────────────────────────────────────
  // /api/focus-tool/futures exists precisely for this header: futures contract
  // ids expire, so it resolves them once per IST day and then quotes them off
  // Dhan's batched OHLC endpoint. % change comes from the same response —
  // the route caches the first genuine (pre-15:30-flip) close each day and
  // guards against a later flipped value, so this never needs to reason about
  // the flip itself. The header hides the % when it's still null (no genuine
  // close cached yet today).
  useEffect(() => {
    const fetchFuts = () => {
      fetch('/api/focus-tool/futures')
        .then(r => r.json())
        .then((j: { quotes?: Record<string, { ltp: number; change_pct: number | null }> }) => {
          if (!j.quotes) return;
          setFutQuotes(prev => {
            const next = { ...prev };
            for (const u of UNDERLYINGS) {
              const q = j.quotes?.[u];
              if (q && q.ltp > 0) next[u] = { ltp: q.ltp, change_pct: q.change_pct ?? null };
            }
            return next;
          });
        })
        .catch(() => {});
    };
    fetchFuts();
    const t = setInterval(fetchFuts, 3000);
    return () => clearInterval(t);
  }, []);

  // The nearest expiry per underlying, as a scalar dep. `expiries` is replaced
  // wholesale on every fetch, so depending on the object itself would re-run
  // these effects on every poll even when nothing changed.
  const expiryKey = UNDERLYINGS.map(u => expiries[u]?.[0] ?? '').join('|');
  // Every row's own picked expiry (or '' if it hasn't picked one yet), as a
  // scalar dep — a row can trade any listed expiry, not just nearest, so the
  // lookup/chain effects below must also warm whatever a row actually picked.
  const rowExpiryKey = config.rows.map(r => `${r.underlying}:${r.expiry ?? ''}`).join('|');

  // ── Lot sizes + per-strike order handles ────────────────────────
  // One lookup per (underlying, expiry): it carries the lot size AND the
  // ce/pe security ids (Dhan) or trading symbols (everyone else) that the leg
  // buttons need to place an order. Nearest expiry is pre-warmed for every
  // underlying unconditionally (see the chain effect below for why); each
  // row's own picked expiry is added on top since it may not be nearest.
  const lookupSeq = React.useRef(0);
  useEffect(() => {
    const seq = ++lookupSeq.current;
    const pairs = new Map<string, { u: FocusUnderlying; expiry: string }>();
    UNDERLYINGS.forEach(u => {
      const nearest = expiries[u]?.[0];
      if (nearest) pairs.set(expKey(u, nearest), { u, expiry: nearest });
    });
    config.rows.forEach(r => {
      const e = r.expiry || expiries[r.underlying]?.[0];
      if (e) pairs.set(expKey(r.underlying, e), { u: r.underlying, expiry: e });
    });
    pairs.forEach(({ u, expiry }) => {
      fetch(`${scalperRoute(broker, 'lookup')}?underlying=${u}&expiry=${expiry}`)
        .then(r => r.json())
        .then((j: { success?: boolean; data?: LookupData }) => {
          // Out-of-order guard: a slow lookup for the previous broker must not
          // land on top of the current one's — those ids place orders.
          if (seq !== lookupSeq.current) return;
          if (!j.success || !j.data?.strikes) return;
          setLookups(prev => ({ ...prev, [expKey(u, expiry)]: j.data! }));
          if (Number(j.data.lotSize) > 0) {
            setLotSizes(prev => ({ ...prev, [u]: Number(j.data!.lotSize) }));
          }
        })
        .catch(() => {});
    });
  }, [broker, expiryKey, rowExpiryKey]);

  // ── Option premiums ─────────────────────────────────────────────
  // The chain is the fallback LTP source for every underlying, and the spot
  // source for SENSEX. The standalone tick bridge (useFocusToolWS, all three
  // underlyings) is preferred per-strike in rowLive below because it's
  // realtime; the chain route caches 10s and is paced ~1 call/3s per
  // underlying account-wide, so it is polled at that cadence and only for
  // underlyings that actually have rows.
  // Pre-warmed, not lazy. Both /api/options/chain and /api/scalper/lookup spawn
  // Python on a cold cache — measured at 6.5s and 2.7s respectively, against
  // ~7ms once warm. Waiting until a row exists put that cold spawn in front of
  // the first trade of the day, which is the worst possible place for it. An
  // underlying whose GROUP is started is warmed even with no rows yet.
  const activeUnderlyings = UNDERLYINGS.filter(u =>
    config.rows.some(r => r.underlying === u)
    || config.groups.some(g => g.underlying === u && g.enabled));
  const activeKey = activeUnderlyings.join('|');
  const chainSeq = React.useRef(0);
  useEffect(() => {
    if (!activeKey) return;
    const seq = ++chainSeq.current;
    const fetchChains = () => {
      const pairs = new Map<string, { u: FocusUnderlying; expiry: string }>();
      activeKey.split('|').forEach(name => {
        const u = name as FocusUnderlying;
        const nearest = expiries[u]?.[0];
        if (nearest) pairs.set(expKey(u, nearest), { u, expiry: nearest });
      });
      // Every row's own picked expiry, even on an underlying whose group
      // isn't "active" by the enabled/has-rows test above — a lone draft row
      // pointed at a further expiry still needs its own chain to resolve
      // PREMIUM-mode strikes and show a live LTP.
      config.rows.forEach(r => {
        const e = r.expiry || expiries[r.underlying]?.[0];
        if (e) pairs.set(expKey(r.underlying, e), { u: r.underlying, expiry: e });
      });
      pairs.forEach(({ u, expiry }) => {
        fetch(`/api/options/chain?underlying=${u}&expiry=${expiry}&broker=${broker}`)
          .then(r => r.json())
          .then((j: {
            success?: boolean;
            data?: { chain?: { last_price?: number; oc?: Record<string, {
              ce?: { last_price?: number }; pe?: { last_price?: number };
            }> } };
          }) => {
            if (seq !== chainSeq.current) return;
            const oc = j.data?.chain?.oc;
            // A failed chain fetch surfaces as 200 OK with no `oc`. Holding the
            // last good chain beats blanking every premium on one 429.
            if (!j.success || !oc) return;
            const flat: ChainData['oc'] = {};
            for (const [k, v] of Object.entries(oc)) {
              flat[strikeKey(k)] = {
                ce: Number(v.ce?.last_price ?? 0),
                pe: Number(v.pe?.last_price ?? 0),
              };
            }
            setChains(prev => ({ ...prev, [expKey(u, expiry)]: { spot: Number(j.data?.chain?.last_price ?? 0), oc: flat } }));
          })
          .catch(() => {});
      });
    };
    fetchChains();
    const t = setInterval(fetchChains, 3000);
    return () => clearInterval(t);
  }, [broker, expiryKey, activeKey, rowExpiryKey]);

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
          return seg.includes('FNO') || seg.includes('FO');
        })
        // A no-op for NSE/BSE F&O, but applied at the pipeline entrance so
        // it cannot be forgotten if a commodity row ever reaches here.
        .map(p => scaleBrokerPnl(p as any) as PosRow);
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
  }, [trailEnabled, triggerRupees, lockRupees]);

  const underlyingPnl = useMemo(() => {
    const out: Record<FocusUnderlying, number> = { NIFTY: 0, BANKNIFTY: 0, SENSEX: 0 };
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
   * The listed strike whose LTP sits closest to `target`, scanning this
   * underlying's fetched chain. Only PREMIUM-mode legs use this; ATM-mode legs
   * resolve arithmetically from `atm`/`step` instead.
   */
  /**
   * The listed strike whose premium is the closest one AT OR BELOW `target` —
   * not simply the closest by absolute difference. A strike priced above the
   * target is never picked, even if it happens to sit nearer than the best
   * strike under it: for a premium seller, the target is a ceiling on what
   * you're willing to sell for, not a midpoint to snap to.
   */
  function nearestStrikeByPremium(
    oc: Record<string, { ce: number; pe: number }> | undefined,
    leg: 'CE' | 'PE',
    target: number,
  ): number | null {
    if (!oc || !(target > 0)) return null;
    let best: number | null = null;
    let bestPx = -Infinity;
    for (const [k, v] of Object.entries(oc)) {
      const px = leg === 'CE' ? v.ce : v.pe;
      if (!(px > 0) || px > target) continue;
      if (px > bestPx) { bestPx = px; best = Number(k); }
    }
    return best;
  }

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
  const rowLiveEqual = (a: RowLive, b: RowLive) =>
    a.ceStrike === b.ceStrike && a.peStrike === b.peStrike
    && a.ltpCe === b.ltpCe && a.ltpPe === b.ltpPe
    && a.cePosition === b.cePosition && a.pePosition === b.pePosition
    && a.pnl === b.pnl && a.entryPremium === b.entryPremium && a.vwap === b.vwap && a.vwapClose === b.vwapClose
    && a.ceBuildup === b.ceBuildup && a.peBuildup === b.peBuildup
    && a.ceOiChgPct === b.ceOiChgPct && a.peOiChgPct === b.peOiChgPct
    && a.ceOi === b.ceOi && a.peOi === b.peOi;
  const rowLive = useMemo<Record<string, RowLive>>(() => {
    const out: Record<string, RowLive> = {};
    const prevOut = rowLivePrevRef.current;
    // Strike pins for rows the WORKER holds — see WorkerStatus.rows.
    const workerFills: Record<string, { ceStrike: number | null; peStrike: number | null; ceQty?: number; peQty?: number }> = {};
    for (const r of workerStatus.rows ?? []) {
      if (r?.open && r.id) {
        workerFills[r.id] = {
          ceStrike: r.ceStrike ?? null, peStrike: r.peStrike ?? null,
          ceQty: r.ceQty, peQty: r.peQty,
        };
      }
    }
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

      const resolvedCe = row.strikeMode === 'PREMIUM'
        ? nearestStrikeByPremium(oc, 'CE', Number(row.cePremium))
        : (atm != null ? atm + (row.ceOffset ?? 0) * step : null);
      const resolvedPe = row.strikeMode === 'PREMIUM'
        ? nearestStrikeByPremium(oc, 'PE', Number(row.pePremium))
        : (atm != null ? atm + (row.peOffset ?? 0) * step : null);

      // An OPEN row uses the strikes it actually filled at, never the live
      // resolution. ATM moves every time spot crosses a half-step, and a row
      // that re-resolved would look its own position up at a strike nobody
      // holds: P&L blanks, legsFlat() goes true, and every exit rule silently
      // stops being evaluated against a position that is still very much open.
      // The pin comes from this page's own fill record, or from the worker's
      // ledger when the worker is the one holding it.
      // The pin is live as soon as the ledger names a strike — not gated on
      // `status`, because the worker never writes `entered` back into the
      // config and the page's own first leg is away before it does.
      const hasPin = !!row.fill && (row.fill.ceStrike != null || row.fill.peStrike != null);
      const pin = workerFills[row.id] ?? (hasPin ? row.fill : undefined);
      const ceStrike = pin ? (pin.ceStrike ?? null) : resolvedCe;
      const peStrike = pin ? (pin.peStrike ?? null) : resolvedPe;

      if (ceStrike == null && peStrike == null) { out[row.id] = EMPTY_ROW_LIVE; continue; }

      const uWs = focusWsQuotes?.[u];
      const wsOnThisRow = !!uWs && (!row.expiry || uWs.expiry === row.expiry);
      const ceKey = ceStrike != null ? strikeKey(ceStrike) : null;
      const peKey = peStrike != null ? strikeKey(peStrike) : null;
      const ceWs = ceKey && wsOnThisRow ? uWs!.strikes?.[ceKey] : undefined;
      const peWs = peKey && wsOnThisRow ? uWs!.strikes?.[peKey] : undefined;
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
      const cePosition = findPositionForRef(positions, broker, ceRef, 'CE', wantProduct);
      const pePosition = findPositionForRef(positions, broker, peRef, 'PE', wantProduct);

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
      const ceOi = ceWs?.ce?.oi != null && Number(ceWs.ce.oi) >= 0 ? Number(ceWs.ce.oi) : null;
      const peOi = peWs?.pe?.oi != null && Number(peWs.pe.oi) >= 0 ? Number(peWs.pe.oi) : null;

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
       * the OLD security id, which this row no longer looks up. When the
       * worker holds the row it banks leg-wise SL closes into its own
       * `bookedPnl` — the page fill is empty for worker-driven entries, so
       * without preferring the worker's booked the row would show only the
       * leftover PE's live MTM after a CE SL.
       */
      const workerHold = (workerStatus.rows ?? []).find(r => r.id === row.id) ?? null;
      let entryNum = 0;
      let entryDen = 0;
      const liveLegs: Parameters<typeof computeRowPnl>[1] = [];
      for (const leg of legsOf(row)) {
        const pos = leg === 'CE' ? cePosition : pePosition;
        if (!pos) continue;
        // A broker position at this leg's strike that this row didn't open —
        // another row, a manual trade, a running strategy — must not be
        // counted as this row's premium/P&L. Without this, ownShare()/
        // computeRowPnl() in focusToolPnl.ts read a missing own qty as
        // "attribute the whole position to this row" instead of "none of it."
        if (!rowOwnsLeg(row, leg, workerHold)) continue;
        // Prefer the worker's own qty when the page fill is empty (worker
        // entered this row without writing the page ledger).
        const pageOwn = leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty;
        const workerOwn = leg === 'CE' ? workerHold?.ceQty : workerHold?.peQty;
        const ownQty = (Number(pageOwn) > 0 ? pageOwn : undefined)
          ?? (Number(workerOwn) > 0 ? workerOwn : undefined);
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
        // Qty-weighted entry for pair SL × — unequal CE/PE sizes must not be
        // treated as a 1-lot CE+PE sum.
        const q = Math.abs(Number(ownQty) || Number(pos.netQty) || 0);
        if (q > 0 && avg > 0) {
          entryNum += avg * q;
          entryDen += q;
        }
      }
      const entryPremium = entryDen > 0 ? entryNum / entryDen : 0;
      const pnl = computeRowPnl(
        rowDisplayBookedPnl(row.fill?.bookedPnl, workerHold),
        liveLegs,
      );

      const vwapEntry = row.levelVw && ceStrike != null && peStrike != null && rowExpiry
        ? rowVwap[vwapKey(u, rowExpiry, ceStrike, peStrike, row.side, row.vwapInterval || '1')]
        : undefined;
      const vwap = vwapEntry?.vwap ?? null;
      const vwapClose = vwapEntry?.close ?? null;

      const computed: RowLive = {
        ceStrike, peStrike,
        ltpCe, ltpPe,
        cePosition, pePosition,
        pnl, entryPremium, vwap, vwapClose,
        ceBuildup, peBuildup, ceOiChgPct, peOiChgPct, ceOi, peOi,
      };
      const prevLive = prevOut[row.id];
      out[row.id] = prevLive && rowLiveEqual(prevLive, computed) ? prevLive : computed;
    }
    rowLivePrevRef.current = out;
    return out;
  }, [config.rows, config.groups, spots, futQuotes, chains, focusWsQuotes, lookups, positions, broker, expiries, rowVwap, workerStatus.rows]);

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
  const toolPnl = useMemo(() => {
    let sum = 0;
    for (const row of config.rows) sum += rowLive[row.id]?.pnl ?? 0;
    return sum;
  }, [config.rows, rowLive]);

  useEffect(() => {
    if (toolPnl > 0) setPeakMtm(prev => Math.max(prev, toolPnl));
  }, [toolPnl]);

  // Distinct strike pairs that need a VWAP, among rows with VW enabled. A
  // plain string, not the wanted objects themselves, so the fetch effect
  // below only re-runs when the SET of strike pairs actually changes — not
  // on every live tick, which changes rowLive's identity constantly but
  // essentially never changes which strikes a row is sitting at.
  const vwapWantedKey = useMemo(() => {
    const keys = new Set<string>();
    for (const row of config.rows) {
      if (!row.levelVw) continue;
      const live = rowLive[row.id];
      if (!live || live.ceStrike == null || live.peStrike == null) continue;
      const expiry = row.expiry || expiries[row.underlying]?.[0] || '';
      if (!expiry) continue;
      keys.add(vwapKey(row.underlying, expiry, live.ceStrike, live.peStrike, row.side, row.vwapInterval || '1'));
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

  async function saveConfig(patch?: Partial<FocusToolConfig>) {
    // Queued rather than fired directly — see saveQueueRef's doc comment.
    // Each save waits for every save already queued ahead of it to land
    // first, so two saves fired close together apply in order.
    const run = saveQueueRef.current.then(() => doSaveConfig(patch));
    // Swallow here so one failed save doesn't wedge the queue for whatever
    // saves come after it — doSaveConfig already reports the failure itself.
    saveQueueRef.current = run.catch(() => {});
    return run;
  }

  async function doSaveConfig(patch?: Partial<FocusToolConfig>) {
    setSaving(true);
    try {
      const body = patch ?? {
        riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees, liveRealMoney,
        groups: config.groups,
        rows: config.rows,
      };
      const res = await fetch('/api/focus-tool/rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j.success && j.data) {
        applyServerConfig(j.data);
        addToast('success', 'Ultimate Scalper Terminal configuration saved');
      } else if (j.error) {
        addToast('error', 'Failed to save config', j.error);
      }
    } catch (e) {
      addToast('error', 'Network error saving config', String(e));
    } finally {
      setSaving(false);
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
      // Retire every Focus row so the worker / tab scheduler cannot re-enter
      // into a book we just nuked. Also queue ghost-leg drops for any pin the
      // worker still holds (broker is flat; ledger may lag).
      const wrows = workerStatus.rows ?? [];
      setConfig(prev => {
        const nextRows = prev.rows.map(r => {
          const w = wrows.find(x => x.id === r.id);
          if (r.status === 'draft' && !w?.open) return r;
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
      for (const w of wrows) {
        if (!w?.open || !w.id) continue;
        for (const leg of ['CE', 'PE'] as const) {
          const strike = leg === 'CE' ? w.ceStrike : w.peStrike;
          if (strike == null) continue;
          fetch('/api/focus-tool/worker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'drop-leg', rowId: w.id, leg }),
          }).catch(() => {});
        }
      }
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

  function updateRow(id: string, patch: Partial<FocusRow>, saveToDisk = false) {
    // A level exit is validated before it reaches STATE, not just before it
    // reaches disk. The in-tab watcher reads component state directly, so a
    // level on the wrong side of spot fires a real exit the moment it lands —
    // rejecting it only at save time protected the Python worker and nothing
    // else. Only a level that actually CHANGES is checked, so re-saving a row
    // whose level spot has since travelled past is not blocked (that row has
    // already exited on it anyway), and neither is an unrelated Timing save.
    const current = config.rows.find(r => r.id === id);
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
      if (saveToDisk) saveConfig(nextConfig);
      return nextConfig;
    });
  }

  /** Arm a row for the scheduler. Clears the one-entry-per-row latch so a row
   *  that already entered and exited can be deliberately re-armed to trade
   *  again — otherwise re-arming would look accepted but never fire. */
  function armRow(id: string) {
    autoEnteringRef.current.delete(id);
    // Drop any stale fill pin — arming means this row resolves its strikes
    // fresh at the next entry, so a pin from the previous cycle would make it
    // look its new position up at last time's strikes.
    updateRow(id, { status: 'armed', fill: undefined }, true);
  }

  function deleteRow(id: string) {
    // The worker's own ledger is checked before the broker book: deleting a row
    // it holds leaves that position with no config row to evaluate it against
    // — see orphan_rows() in focus_tool_rows_worker.py, which then has to keep
    // it alive on the bell alone. Better to refuse the delete here.
    if ((workerStatus.rows ?? []).some(r => r.id === id && r.open)) {
      addToast('error', 'Cannot delete row', 'The server-side worker still holds a position for this row — exit it first');
      return;
    }
    const cfgRow = config.rows.find(r => r.id === id);
    const workerHold = (workerStatus.rows ?? []).find(r => r.id === id);
    if (cfgRow && (rowOwnsLeg(cfgRow, 'CE', workerHold) || rowOwnsLeg(cfgRow, 'PE', workerHold))) {
      addToast('error', 'Cannot delete row', 'Exit the CE/PE legs first — this row still holds a position');
      return;
    }
    autoEnteringRef.current.delete(id);
    autoExitingRef.current.delete(id);
    setConfig(prev => {
      const nextRows = prev.rows.filter(r => r.id !== id);
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
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
  ) {
    setConfig(prev => {
      const nextRows = prev.rows.map(r => {
        if (r.id !== rowId) return r;
        const f = r.fill;
        const nextFill: FocusRowFill = {
          ceStrike: leg === 'CE' && strike != null ? strike : (f?.ceStrike ?? null),
          peStrike: leg === 'PE' && strike != null ? strike : (f?.peStrike ?? null),
          ceQty: leg === 'CE' ? Math.max(0, (f?.ceQty ?? 0) + delta) : (f?.ceQty ?? 0),
          peQty: leg === 'PE' ? Math.max(0, (f?.peQty ?? 0) + delta) : (f?.peQty ?? 0),
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
   * Send one market order for one leg.
   *
   * `reduce` selects both the direction and where the product comes from, and
   * a reducing order is clamped to the quantity the broker actually shows on
   * that leg — never more.
   */
  async function placeLeg(
    row: FocusRow,
    leg: 'CE' | 'PE',
    opts: { reduce: boolean; lots?: number; all?: boolean; strikeOverride?: number; awaitFill?: boolean },
  ): Promise<boolean> {
    const u = row.underlying;
    const expiry = row.expiry || expiries[u]?.[0] || '';
    const what = `${u} ${leg}`;

    if (!liveRealMoney) {
      addToast('error', 'Dry run', 'Enable LIVE · REAL MONEY to place orders');
      return false;
    }
    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', `Log in to ${BROKER_LABELS[broker]} before placing orders`);
      return false;
    }

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
    const pos = findPositionForRef(positions, broker, ref, leg, wantProduct);
    const netQty = Number(pos?.netQty ?? 0);

    let quantity: number;
    let side: 'BUY' | 'SELL';
    if (opts.reduce) {
      if (netQty === 0) {
        // Broker already flat. If the worker still pins this leg (reconcile
        // blocked by a dead token, or closed elsewhere), ask it to drop the
        // ghost so the row can go exited and be re-armed — otherwise Exit is
        // a dead end and Arm is blocked forever.
        const workerHold = (workerStatus.rows ?? []).find(r => r.id === row.id);
        const heldStrike = leg === 'CE' ? workerHold?.ceStrike : workerHold?.peStrike;
        if (workerHold?.open && heldStrike != null && rowOwnsLeg(row, leg, workerHold)) {
          try {
            const dropRes = await fetch('/api/focus-tool/worker', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'drop-leg', rowId: row.id, leg }),
            });
            const dropJ = await dropRes.json() as { success?: boolean; error?: string };
            if (dropJ.success) {
              addToast('success', `${what} cleared`, 'Broker already flat — dropped stale worker pin');
              return true;
            }
            addToast('error', `${what} ghost pin`, dropJ.error || 'Could not clear worker ledger');
          } catch (e) {
            addToast('error', `${what} ghost pin`, e instanceof Error ? e.message : 'drop-leg failed');
          }
          return false;
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
      // Prefer the page fill; fall back to the worker's published qty when the
      // worker entered this row (page fill stays empty for those).
      const workerHold = (workerStatus.rows ?? []).find(r => r.id === row.id);
      const pageOwn = leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty;
      const workerOwn = leg === 'CE' ? workerHold?.ceQty : workerHold?.peQty;
      const ownQty = (Number(pageOwn) > 0 ? Number(pageOwn) : 0)
        || (Number(workerOwn) > 0 ? Number(workerOwn) : 0)
        || undefined;
      const brokerQty = Math.abs(netQty);
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
      // Opening more exposure on a leg the WORKER already holds is how the
      // two ledgers silently drift apart: the worker tracks only what IT
      // placed (self.fills), never reads this page's fill record, and never
      // learns about an order this tab sends. Its own leg-wise SL then closes
      // only the qty it thinks it opened, leaving whatever the tab added
      // behind as a live, unmanaged position — exactly what happened to the
      // 2026-08-25 24150 CE (worker's ledger said 195; four tab-side adds
      // brought the broker to -455 net; the worker's SL closed its own 195
      // and left -260 short, untracked, until a further tab-side add grew it
      // to -390). Refuse rather than add to a leg this tab cannot see the
      // true size of. A strike-shift reopen (`strikeOverride`) is exempt —
      // handleShiftStrike already refuses the whole shift earlier when the
      // worker holds the leg being rolled, so reaching here means it doesn't.
      const workerHold = (workerStatus.rows ?? []).find(r => r.id === row.id);
      const heldStrike = leg === 'CE' ? workerHold?.ceStrike : workerHold?.peStrike;
      if (workerHold?.open && heldStrike != null && !opts.strikeOverride) {
        addToast('error', `${what} blocked`,
          `${leg} is held by the server-side worker — stop the worker before adding to this leg from the tab, or let the worker's own rules manage it`);
        return false;
      }
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

    const exchange = orderExchange(broker, u);
    const url = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
    const body = broker === 'dhan'
      ? { securityId, quantity, side, orderType: 'MARKET', exchangeSegment: exchange, ...product.fields }
      : { tradingsymbol: symbol, quantity, side, orderType: 'MARKET', exchange, ...product.fields };

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
        // Snapshot entry avg + LTP now so a reduce can bank the closed slice's
        // MTM into fill.bookedPnl (the pin moves off this strike on a roll).
        const bookedSnap = opts.reduce ? {
          netQty,
          buyAvg: Number(pos?.buyAvg) || 0,
          sellAvg: Number(pos?.sellAvg) || 0,
          ltp: Number(leg === 'CE' ? live?.ltpCe : live?.ltpPe) || 0,
        } : null;
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
          adjustFillQty(row.id, leg, opts.reduce ? -filled : filled,
            opts.reduce ? undefined : Number(strike), bookedDelta);
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
   * Poll the broker's position book until neither of this row's legs shows any
   * quantity at the strikes it actually holds.
   *
   * Returns false if it is still not flat when the deadline passes, or if
   * every fetch failed — the caller must treat that as "unknown", never as
   * "flat". `live` is captured before the closing orders go out so the strikes
   * checked are the ones that were closed.
   */
  async function waitRowFlat(row: FocusRow, live: RowLive, maxWaitMs = 4000): Promise<boolean> {
    const u = row.underlying;
    const expiry = row.expiry || expiries[u]?.[0] || '';
    const handles = (['CE', 'PE'] as const).map(leg => {
      const strike = leg === 'CE' ? live.ceStrike : live.peStrike;
      if (strike == null) return null;
      const ref = lookups[expKey(u, expiry)]?.strikes?.[strikeKey(strike)];
      const id = leg === 'CE' ? ref?.ceId : ref?.peId;
      const sym = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
      return broker === 'dhan' ? (id ? { id } : null) : (sym ? { sym } : null);
    }).filter(Boolean) as ({ id?: string; sym?: string })[];

    if (!handles.length) return false;

    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      await new Promise(r => setTimeout(r, 400));
      const rows = await fetchPositionsNow();
      if (rows) {
        const stillOpen = handles.some(h => {
          const pos = h.id
            ? rows.find(p => String(p.securityId) === String(h.id))
            : rows.find(p => String(p.tradingSymbol) === h.sym);
          return Math.abs(Number(pos?.netQty ?? 0)) > 0;
        });
        if (!stillOpen) return true;
      }
      if (Date.now() >= deadline) return false;
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
      const live = rowLive[row.id] ?? EMPTY_ROW_LIVE;
      const legs = leg === 'ALL' ? legsOf(row) : [leg];
      // Concurrently, not one after the other. This is the panic button: legs
      // are independent orders against different contracts, and serialising
      // them made a straddle's second leg wait out the first's full round trip
      // (~60ms) for nothing. Each leg still reports its own rejection.
      const accepted = await Promise.all(legs.map(l => placeLeg(row, l, { reduce: true, all: true })));
      // Each leg already reported its own rejection via placeLeg's own toast;
      // still short-circuit here so a rejected leg does not sit through the
      // full waitRowFlat timeout for a row that was never fully closed (same
      // guard autoExitRow applies to its own Promise.all above).
      if (leg === 'ALL' && !accepted.every(Boolean)) {
        addToast('error', 'Exit incomplete', `${row.underlying}: a leg was rejected — still open, check the position book`);
        return;
      }
      if (leg === 'ALL' && await waitRowFlat(row, live)) {
        updateRow(row.id, { status: 'exited', fill: undefined }, true);
      }
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
    if (!hasContract) {
      addToast('error', 'Cannot shift', `No ${broker} contract for ${newStrike} ${leg}`);
      return;
    }

    await runRowAction(row.id, async () => {
      const pos = leg === 'CE' ? live.cePosition : live.pePosition;
      const netQty = Number(pos?.netQty ?? 0);
      const workerHold = (workerStatus.rows ?? []).find(r => r.id === row.id);
      const owns = rowOwnsLeg(row, leg, workerHold);
      // The worker tracks positions purely through its own state file,
      // written only by itself — a shift placed from this tab goes through
      // the dashboard's own order route and never touches it. The worker's
      // own reconciliation pass would then see the old strike go flat and
      // DROP the leg from its ledger entirely, never discovering the new
      // strike — silently ending SL/exit-time/book-exit/account-risk
      // enforcement for it on both engines. Refuse rather than shift into a
      // state the worker can't track; the user must stop the worker (or exit
      // the leg through it) first.
      const heldStrike = leg === 'CE' ? workerHold?.ceStrike : workerHold?.peStrike;
      if (workerHold?.open && heldStrike != null) {
        addToast('error', 'Cannot shift',
          `${currStrike} ${leg} is held by the server-side worker — stop the worker (or exit this leg through it) before rolling it from this tab`);
        return;
      }
      // Only roll a position this row opened. A coincidental book at the
      // resolved strike is someone else's — moving THIS row's offset must
      // not close and reopen it.
      if (netQty !== 0 && owns) {
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
          addToast('error', 'Shift incomplete', `Closed ${currStrike} ${leg} but the new ${newStrike} ${leg} order failed or did not fill — reopen manually`);
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
      const otherOpen = rowOwnsLeg(row, otherLeg, workerHold);
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
          updateRow(row.id, patch, true);
        }
      } else {
        const curOffset = leg === 'CE' ? (row.ceOffset ?? 0) : (row.peOffset ?? 0);
        const newOffset = curOffset + (direction === 'UP' ? 1 : -1);
        const patch: Partial<FocusRow> = leg === 'CE' ? { ceOffset: newOffset } : { peOffset: newOffset };
        if (linked) { if (leg === 'CE') patch.peOffset = -newOffset; else patch.ceOffset = -newOffset; }
        updateRow(row.id, patch, true);
      }
    });
  }

  /** Serialise a row's orders and disable its buttons while one is in flight. */
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
    config, rowLive, spots, toolPnl, lockMtm, peakMtm,
    riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees,
    workerRows: workerStatus.rows,
  };
  const schedulerRef = useRef(schedulerSnapshot);
  schedulerRef.current = schedulerSnapshot;
  const expiriesRef = useRef(expiries);
  expiriesRef.current = expiries;

  /**
   * Square off every leg of one row at market and mark it exited. Deduped by
   * `autoExitingRef` so a rule that stays breached across ticks (they all do)
   * cannot fire a second time while the first exit is still in flight.
   */
  function autoExitRow(row: FocusRow, reason: string) {
    if (autoExitingRef.current.has(row.id) || busyRows.has(row.id)) return;
    autoExitingRef.current.add(row.id);
    // Also hold the manual busy lock: the row's own Exit All / +/- buttons go
    // through runRowAction, and without a shared lock a click landing while
    // this exit is in flight sends a SECOND full-size closing order and flips
    // the position the other way.
    setBusyRows(prev => new Set(prev).add(row.id));
    const live = rowLive[row.id] ?? EMPTY_ROW_LIVE;
    addToast('error', `Auto-exit: ${row.underlying} ${row.id.slice(-4)}`, reason);
    Promise.all(legsOf(row).map(leg => placeLeg(row, leg, { reduce: true, all: true })))
      .then(async accepted => {
        // Only call the row exited once the broker's own book agrees every
        // leg is flat. Marking it exited off the order ACKs alone would
        // silently retire a row that still holds a position — and because
        // this ref is then cleared, nothing would try again either.
        if (!accepted.every(Boolean)) {
          addToast('error', 'Auto-exit incomplete', `${row.underlying}: a leg was rejected — still open, check the position book`);
          return;
        }
        if (await waitRowFlat(row, live)) {
          // Flat and confirmed — retire the row and drop its strike pin.
          updateRow(row.id, { status: 'exited', fill: undefined }, true);
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
   * Close just one leg on its own SL x breach, leaving the other leg (and the
   * row itself) exactly as it was. Unlike autoExitRow this never touches
   * `status` — a partial exit does not mean the row is done, and the other
   * leg's own rules keep being evaluated on later ticks.
   */
  function autoExitLeg(row: FocusRow, leg: 'CE' | 'PE', reason: string) {
    const key = `${row.id}:${leg}`;
    if (autoExitingLegRef.current.has(key) || busyRows.has(row.id)) return;
    autoExitingLegRef.current.add(key);
    // Also hold the manual busy lock (see autoExitRow above) — without it a
    // click on this row's own Exit/Add/Reduce buttons while this leg's close
    // is in flight sends a second concurrent order against the same leg.
    setBusyRows(prev => new Set(prev).add(row.id));
    addToast('error', `Auto-exit ${leg}: ${row.underlying} ${row.id.slice(-4)}`, reason);
    placeLeg(row, leg, { reduce: true, all: true })
      .finally(() => {
        autoExitingLegRef.current.delete(key);
        setBusyRows(prev => { const next = new Set(prev); next.delete(row.id); return next; });
      });
  }

  useEffect(() => {
    // Same hand-off as the scheduler below: the worker evaluates these very
    // rules server-side, so the tab must not race it — and must not act at all
    // until it knows whether the worker is up. See tabMayTrade.
    if (!tabMayTrade) return;

    const openRows = config.rows.filter(r => {
      const l = rowLive[r.id];
      if (!l) return false;
      const workerHold = (workerStatus.rows ?? []).find(w => w.id === r.id) ?? null;
      return !rowFlat(r, workerHold);
    });
    if (!openRows.length) return;

    // ── Account budget, on every tick ──
    // This used to sit in the 5s scheduler, which meant a target could be
    // overshot — or a stop breached — by up to five seconds of movement while
    // the numbers driving it (spot, premiums) were already on screen. It is a
    // pure function of data that arrives with the ticks, so it belongs here.
    const risk = evaluateGlobalRisk(
      { riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees },
      { totalPnl: toolPnl, peakPnl: peakMtm, lockFloor: lockFloorRef.current },
    );
    lockFloorRef.current = risk.lockFloor;
    if (risk.exitAll) {
      for (const row of openRows) autoExitRow(row, risk.reason);
      return;   // nothing else runs on a tick that just flattened the book
    }

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
        for (const row of openRows.filter(r => r.underlying === g.underlying)) {
          autoExitRow(row, reason);
        }
      }
    }

    // ── Per-row level exits ──
    for (const row of openRows) {
      const live = rowLive[row.id];
      if (!live) continue;

      // Leg-wise SL x first: it can fire independently of, and more often
      // than, the pair-level rules below. Skip the whole-row check this tick
      // once a leg exit has been sent — the position book it would be
      // evaluated against is about to change.
      const workerHold = (workerStatus.rows ?? []).find(w => w.id === row.id) ?? null;
      const ceReason = legStopReason(row, 'CE', live, workerHold);
      if (ceReason) { autoExitLeg(row, 'CE', ceReason); continue; }
      const peReason = legStopReason(row, 'PE', live, workerHold);
      if (peReason) { autoExitLeg(row, 'PE', peReason); continue; }

      const reason = evaluateRowExit(row, live, spots[row.underlying] ?? 0, workerHold);
      if (reason) autoExitRow(row, reason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowLive, spots, tabMayTrade, toolPnl, riskEnabled, targetRupees, stopRupees,
      trailEnabled, triggerRupees, lockRupees, peakMtm, lockMtm, workerStatus.rows]);

  /**
   * Open every leg this row trades, at its configured lot size.
   *
   * Deduped through `autoEnteringRef` — the scheduler re-checks every few
   * seconds and the entry window stays open for the rest of the session, so
   * without this a row would re-enter on every tick.
   */
  function autoEnterRow(row: FocusRow, reason: string) {
    if (autoEnteringRef.current.has(row.id) || autoExitingRef.current.has(row.id)) return;
    autoEnteringRef.current.add(row.id);
    addToast('success', `Auto-entry: ${row.underlying} ${row.id.slice(-4)}`, reason);
    (async () => {
      // Each accepted leg stamps its own strike and quantity onto the row's
      // fill ledger from inside placeLeg, so the row stops re-resolving off the
      // live ATM the moment the first leg is away (see FocusRowFill).
      const wanted = legsOf(row);
      const filled: Record<'CE' | 'PE', boolean> = { CE: false, PE: false };

      // Sequential, so one leg's rejection is reported against that leg and a
      // failure part-way through doesn't leave two orders racing.
      for (const leg of wanted) {
        if (await placeLeg(row, leg, { reduce: false, lots: row.lots })) filled[leg] = true;
      }

      // A BOTH row that only got one leg away is a NAKED short, not a
      // straddle. Retry the missing leg once before accepting that shape —
      // and if it still will not go, say so loudly rather than marking the row
      // entered and moving on, which is how a naked leg used to go unnoticed.
      const missing = wanted.filter(l => !filled[l]);
      if (missing.length && missing.length < wanted.length) {
        for (const leg of missing) {
          if (await placeLeg(row, leg, { reduce: false, lots: row.lots })) filled[leg] = true;
        }
      }

      const opened = wanted.filter(l => filled[l]);
      if (!opened.length) {
        addToast('error', 'Auto-entry failed', `${row.underlying}: no leg was accepted — row left armed`);
        autoEnteringRef.current.delete(row.id);   // let it retry on a later tick
        await fetchPositionsNow();
        return;
      }

      updateRow(row.id, { status: 'entered' }, true);

      const stillMissing = wanted.filter(l => !filled[l]);
      if (stillMissing.length) {
        addToast('error', `${row.underlying}: NAKED ${stillMissing.join('+')} leg`,
          `${opened.join('+')} opened but ${stillMissing.join('+')} was rejected twice — this row is one-sided. Close it or place the missing leg manually.`);
      }
      await fetchPositionsNow();
    })().catch(() => autoEnteringRef.current.delete(row.id));
  }

  // The scheduler's interval closure is created once per liveRealMoney flip,
  // so calling autoEnterRow/autoExitRow directly would pin that render's
  // versions — and with them a stale `lookups`/`lotSizes`/`rowLive` inside
  // placeLeg, which resolves the contract an order is actually sent for.
  // Going through a ref that every render refreshes keeps orders on current data.
  const actionsRef = useRef({ autoEnterRow, autoExitRow });
  actionsRef.current = { autoEnterRow, autoExitRow };

  /**
   * The scheduler: everything time- or account-level driven, on a 5s tick.
   *
   * Split from the per-row level-exit watcher above because those rules are
   * data-driven (they fire the moment a price crosses), while these are clock-
   * and aggregate-driven and must keep firing even when no tick arrives.
   * Ordered exits-before-entries, and account-wide rules before per-row ones,
   * so a stop-out is never immediately followed by a fresh entry on the same
   * tick.
   *
   * Entirely gated on LIVE · REAL MONEY, and — like everything else on this
   * page — only runs while the tab is open. There is no server-side worker
   * behind any of this.
   */
  useEffect(() => {
    // The Python worker is the authority whenever it is up: it runs the same
    // rules against the same config, so both acting would double every entry
    // and race every exit. Until its status is known, neither acts. See
    // tabMayTrade.
    if (!tabMayTrade) return;

    const tick = () => {
      const { config: cfg, rowLive: live, workerRows } = schedulerRef.current;
      // Display mirror of the authoritative floor — see lockFloorRef. The
      // identity return makes an unchanged floor a no-op rather than a render.
      setLockMtm(prev => (prev === lockFloorRef.current ? prev : lockFloorRef.current));
      const nowHm = istHm();
      const findWorkerHold = (id: string) => (workerRows ?? []).find(w => w.id === id) ?? null;
      const openRows = cfg.rows.filter(r => {
        const l = live[r.id];
        return l && !rowFlat(r, findWorkerHold(r.id));
      });

      // The account budget and Book Exit used to live here. Both are pure
      // functions of data that arrives with the ticks, so they moved to the
      // tick-driven watcher above — a spot level checked every 5s is a spot
      // level checked five times a minute. What is left is genuinely
      // clock-driven and must keep firing when no tick arrives at all.

      // ── 1. Per-row time exit, plus the repo-wide 15:17 intraday backstop ──
      for (const row of openRows) {
        if (row.exitTime && nowHm >= row.exitTime) {
          actionsRef.current.autoExitRow(row, `Exit time ${row.exitTime} reached`);
          continue;
        }
        const product = cfg.groups.find(g => g.underlying === row.underlying)?.product ?? 'INTRADAY';
        if (product === 'INTRADAY' && nowHm >= INTRADAY_BACKSTOP_HM) {
          actionsRef.current.autoExitRow(row, `Intraday backstop ${INTRADAY_BACKSTOP_HM} reached`);
        }
      }

      // ── 2. Auto-entry for armed rows ──
      // Every condition lives in the shared evaluateEntry, which the worker
      // runs too — including the reason string, so both report the same thing
      // about the same row.
      for (const row of cfg.rows) {
        const l = live[row.id] ?? EMPTY_ROW_LIVE;
        const group = cfg.groups.find(g => g.underlying === row.underlying);
        const decision = evaluateEntry(row, {
          nowHm,
          groupEnabled: !!group?.enabled,
          product: group?.product ?? 'INTRADAY',
          dte: dteFor(row.expiry || expiriesRef.current[row.underlying]?.[0] || ''),
          strikesReady: l.ceStrike != null || l.peStrike != null,
          flat: rowFlat(row, findWorkerHold(row.id)),
        });
        if (decision.enter) actionsRef.current.autoEnterRow(row, decision.reason);
      }
    };

    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabMayTrade]);

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
    const freeTextFields = new Set(['spotHigh', 'spotLow']);
    const isFreeTextEdit = Object.keys(patch).every(k => freeTextFields.has(k));

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
      if (!isFreeTextEdit) saveConfig(nextConfig);
      return nextConfig;
    });
  }

  /**
   * The risk-bar toggles (Risk enabled, Trail) and the LIVE · REAL MONEY
   * master switch are each a single, complete flip — same reasoning as
   * updateGroup above, and the same stakes: liveRealMoney in particular is
   * the switch that gates every real order, so a toggle that only lives in
   * this tab's memory until some later Save Preferences click means the
   * Worker could keep trading (or stay dry) on the OLD value for however long
   * that gap lasts. Reads the *new* value explicitly rather than the
   * about-to-be-stale `riskEnabled`/etc. closures, since setState is async.
   */
  function saveRiskPatch(partial: Partial<Pick<FocusToolConfig,
    'riskEnabled' | 'trailEnabled' | 'liveRealMoney' | 'liveArmedOn'
  >>) {
    saveConfig({
      riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees, liveRealMoney,
      ...partial,
      groups: config.groups,
      rows: config.rows,
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

  const rowsByUnderlying = useMemo<Record<FocusUnderlying, FocusRow[]>>(() => {
    const m: Record<FocusUnderlying, FocusRow[]> = { NIFTY: [], BANKNIFTY: [], SENSEX: [] };
    for (const r of config.rows) m[r.underlying].push(r);
    return m;
  }, [config.rows]);

  return (
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

      <ControlStrip
        liveRealMoney={liveRealMoney} onToggleLive={toggleLiveRealMoney} broker={broker}
        riskEnabled={riskEnabled} onToggleRisk={toggleRiskEnabled}
        targetRupees={targetRupees} setTargetRupees={setTargetRupees}
        stopRupees={stopRupees} setStopRupees={setStopRupees}
        trailEnabled={trailEnabled} onToggleTrail={toggleTrailEnabled}
        triggerRupees={triggerRupees} setTriggerRupees={setTriggerRupees}
        lockRupees={lockRupees} setLockRupees={setLockRupees}
        onSave={() => saveConfig()} saving={saving}
        totalPnl={workerRunning ? (workerStatus.totalPnl ?? 0) : toolPnl}
        peakMtm={workerRunning ? (workerStatus.peakPnl ?? 0) : peakMtm}
        lockMtm={workerRunning ? (workerStatus.lockFloor ?? null) : lockMtm}
        copyTrade={copyTrade}
        onOpenRisk={() => setActiveModal('risk')}
        onOpenOrders={() => setActiveModal('orderbook')}
        onOpenOptionChain={() => setActiveModal('optionchain')}
        onToggleViewMode={() => setViewMode(v => v === 'cards' ? 'table' : 'cards')}
        viewMode={viewMode}
        workerStatus={workerStatus} onToggleWorker={toggleWorker}
        onExitAll={handleExitAll} confirmExitAll={confirmExitAll} exitingAll={exitingAll}
      />

      {/* A wedged worker is the one state where NOTHING is watching: its PID is
          alive so the tab must not take over (it would double-drive against a
          process whose state nobody can see), but it has stopped evaluating.
          Silence here would read exactly like a healthy quiet market. */}
      {liveRealMoney && workerStatus.status === 'STALE' && (
        <div className="mx-6 mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 flex items-center gap-3">
          <ShieldOff className="h-4 w-4 text-amber-400 shrink-0" />
          <p className="text-[11px] text-amber-300 leading-relaxed">
            <strong>Nothing is watching your rules.</strong> The worker process (PID {workerStatus.pid ?? '?'})
            {' '}is alive but has stopped heartbeating, so this tab will not take over — two executors against
            {' '}one config would double every entry. Restart it with the Worker button. Open positions are untouched.
          </p>
        </div>
      )}

      {/* Main */}
      <div className="flex-1 px-6 py-5 flex flex-col gap-6">
        {UNDERLYINGS.map(u => {
          const group = config.groups.find(g => g.underlying === u) ?? makeGroup(u);
          const rows = rowsByUnderlying[u];

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

              <div className={cn("bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden", viewMode === 'cards' ? 'p-4' : '')}>
                {viewMode === 'cards' ? (
                  rows.length === 0 ? (
                    <div className="py-12 text-center flex flex-col items-center justify-center gap-2">
                      <TrendingUp className="h-8 w-8 text-zinc-700" />
                      <span className="text-sm font-semibold text-zinc-500">No rows configured</span>
                      <span className="text-xs text-zinc-600">Click &ldquo;Add Row&rdquo; to schedule a straddle or strangle entry.</span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {rows.map(row => (
                        <FocusRowCard
                          key={row.id} row={row}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          workerHold={(workerStatus.rows ?? []).find(r => r.id === row.id) ?? null}
                          expiries={expiries[u] ?? []}
                          onUpdate={(patch, save) => updateRow(row.id, patch, save)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => armRow(row.id)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' }, true)}
                          onExit={leg => handleManualExit(row, leg)}
                          onAddLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots }))}
                          onReduceLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots }))}
                          onShift={(leg, dir) => handleShiftStrike(row, leg, dir)}
                          onBlocked={msg => addToast('error', 'Strike locked', msg)}
                        />
                      ))}
                    </div>
                  )
                ) : (
                  /* A row has a hard minimum width — a 200px strike editor, a
                     LTP stack, and six numeric level-exit boxes on one line.
                     Without this scroller the table overflowed the rounded-2xl
                     `overflow-hidden` wrapper above and the Level Exits column
                     was simply clipped: no scrollbar, no way to reach it. */
                  <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left min-w-[1560px]">
                    <thead>
                      {/* Section group headers */}
                      <tr className="border-b border-zinc-700">
                        <th colSpan={5} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r-2 border-r-zinc-600" title="How this row enters: timing, strike, size and side">
                          Configuration
                        </th>
                        <th className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r-2 border-r-zinc-600" title="Row state and its arm / disarm / exit control">
                          Status
                        </th>
                        <th colSpan={3} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider" title="Open legs and every rule that can close them">
                          Positions &amp; Exits
                        </th>
                      </tr>
                      {/* Column headers */}
                      <tr className="bg-zinc-800 border-b border-zinc-700 text-xs font-bold text-white uppercase tracking-wider">
                        <th className="p-3" title="Entry time, exit time and the expiry-days filter">Timing</th>
                        <th className="p-3" title="CE and PE strikes, picked by ATM offset or by target premium">CE / PE Strikes</th>
                        <th className="p-3" title="Combined premium, CE/PE breakdown, ₹ value and Val/OI PCR">LTP</th>
                        <th className="p-3" title="Lots per leg">Lots</th>
                        <th className="p-3 border-r-2 border-r-zinc-600" title="Trade the call, the put, or both">Side</th>
                        <th className="p-3 border-r-2 border-r-zinc-600" title="Where the row stands, and its arm / exit control">Status / Actions</th>
                        <th className="p-3 text-center" title="Call leg: live premium, lot controls, and calculated CE × / pair SL × levels">CE</th>
                        <th className="p-3 text-center border-r-2 border-r-zinc-600" title="Put leg: live premium, lot controls, and calculated PE × / pair SL × levels">PE</th>
                        <th className="p-3 text-center" title="Spot, VWAP and stop-loss rules that close this row">Level Exits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, rowIndex) => (
                        <FocusTableRow
                          key={row.id} row={row} rowIndex={rowIndex}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          workerHold={(workerStatus.rows ?? []).find(r => r.id === row.id) ?? null}
                          expiries={expiries[u] ?? []}
                          onUpdate={(patch, save) => updateRow(row.id, patch, save)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => armRow(row.id)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' }, true)}
                          onExit={leg => handleManualExit(row, leg)}
                          onAddLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots }))}
                          onReduceLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots }))}
                          onShift={(leg, dir) => handleShiftStrike(row, leg, dir)}
                          onBlocked={msg => addToast('error', 'Strike locked', msg)}
                        />
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={9} className="py-12 text-center">
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
      </div>


      <FocusModal
        isOpen={activeModal === 'risk'}
        onClose={() => setActiveModal(null)}
        title="Risk & MTM Details"
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Realised P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(realised))}>{fmtInr(realised, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Unrealised P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(unrealised))}>{fmtInr(unrealised, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Total P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(total))}>{fmtInr(total, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">This Tool&apos;s P&L</span>
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
            {(['NIFTY', 'BANKNIFTY', 'SENSEX'] as const).map(u => {
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
              {([['orders', 'Order Book', orders.length], ['trades', 'Tradebook', trades.length]] as const).map(
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
                Every {ordersTab === 'orders' ? 'order' : 'trade'} on the account, not only this tool&apos;s
              </span>
              <button
                onClick={() => { fetchOrders(); fetchTrades(); }}
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
          ) : (
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
          )}
        </div>
      </FocusModal>

      <FocusOptionChainModal
        isOpen={activeModal === 'optionchain'}
        onClose={() => setActiveModal(null)}
        expiries={expiries.NIFTY ?? []}
      />
    </div>
  );
}

