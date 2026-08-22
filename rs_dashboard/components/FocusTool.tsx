'use client';

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import NavBar from './NavBar';
import {
  TrendingUp, Zap, ShieldOff, Shield, Activity,
  Clock, Plus, Check, Save, Layers, Target, Lock, RefreshCw, X,
  ChevronUp, ChevronDown, Server,
} from 'lucide-react';
import { TabTable, type SortState } from './Scalper';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { closeOrderProduct, positionProduct } from '@/lib/positionProduct';
import { scaleBrokerPnl } from '@/lib/positionPnl';
import { useCopyTrade, CopyTradeControls, type CopyTradeApi } from './CopyTrade';
import { useFocusToolWS } from '@/lib/useFocusToolWS';
import { cn } from '@/lib/utils';
import type {
  FocusToolConfig, FocusRow, FocusIndexGroup,
  FocusUnderlying, FocusDte, FocusSide, FocusRowStatus, FocusStrikeMode,
} from '@/lib/focusToolRows';

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

/**
 * Repo-wide intraday square-off time (see CLAUDE.md — every strategy hardcodes
 * 15:17 IST). Applied here as a backstop for MIS rows so a row whose own exit
 * time is later than the broker's own auto-square-off never rides into it.
 */
const INTRADAY_BACKSTOP_HM = '15:17';

/** Wall-clock 'HH:MM' in IST, regardless of the browser's own timezone. */
function istHm(): string {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Whether a row's DTE filter admits an expiry that is `dte` days out. */
function dteMatches(filter: FocusDte, dte: number | null): boolean {
  if (filter === 'Any') return true;
  if (dte == null) return false;
  if (filter === '0') return dte === 0;
  if (filter === '1') return dte === 1;
  return dte === 0 || dte === 1;   // '0+1'
}

/** Whole days from today (IST) to `expiry`. Both sides are read as calendar
 *  dates, so this never drifts by an hour-of-day. */
function dteFor(expiry: string): number | null {
  if (!expiry) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const ms = Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** The option chain keys strikes as '24250.000000'; every other source uses
 *  '24250'. Normalise both onto the integer form before joining them. */
function strikeKey(n: number | string): string {
  return String(Math.round(Number(n)));
}

function newId(): string {
  return `ft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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

/** Legs this row trades — `side` selects which, it is not a direction. */
function legsOf(row: FocusRow): ('CE' | 'PE')[] {
  return row.side === 'BOTH' ? ['CE', 'PE'] : [row.side as 'CE' | 'PE'];
}

/**
 * Per-leg value (lots × premium) and the PE/CE ratio between them, for the
 * row's LTP display. PCR is PE value ÷ CE value — mathematically identical to
 * PE LTP ÷ CE LTP since `lots` is the same for both legs and cancels out, but
 * computed off the values for clarity at the call site.
 */
function legValues(row: FocusRow, live: RowLive): { ceValue: number; peValue: number; pcr: number | null } {
  const ceValue = (live.ltpCe ?? 0) * row.lots;
  const peValue = (live.ltpPe ?? 0) * row.lots;
  return { ceValue, peValue, pcr: ceValue > 0 ? peValue / ceValue : null };
}

/**
 * Current premium across only the legs this row's Side trades AND that are
 * still actually open. A leg the row's Side names but that has already been
 * closed (by a leg-wise stop, a manual Exit, or anything else) must not keep
 * contributing its market LTP here — evaluateRowExit only ever runs while the
 * row holds a position (see the auto-exit watcher), so this can never starve
 * the pre-entry preview, only avoid comparing against a phantom leg.
 */
function sidePremium(row: FocusRow, live: RowLive): number {
  let sum = 0;
  for (const leg of legsOf(row)) {
    const pos = leg === 'CE' ? live.cePosition : live.pePosition;
    if (!pos || Number(pos.netQty) === 0) continue;
    sum += (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  }
  return sum;
}

/**
 * (leg's own SL x reason, or null). Independent of the pair's combined
 * slMultiplier/slRupees, and independent of `row.side` — a leftover position
 * on a leg the row no longer trades still deserves its own stop. Only fires
 * while that leg actually holds a position; a flat leg has no premium to
 * measure a multiple against.
 */
function legStopReason(row: FocusRow, leg: 'CE' | 'PE', live: RowLive): string | null {
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const qty = Number(pos?.netQty ?? 0);
  if (qty === 0) return null;
  const mult = Number(leg === 'CE' ? row.ceSlMultiplier : row.peSlMultiplier);
  if (!(mult > 1)) return null;
  // Short: hurt by the leg's own premium expanding through a multiple of what
  // it was sold for (this tool only ever opens with a SELL — see placeLeg).
  const entry = qty < 0 ? Number(pos?.sellAvg) || 0 : Number(pos?.buyAvg) || 0;
  const now = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  if (entry > 0 && now > 0 && now >= entry * mult) {
    return `${leg} SL ×${mult} hit (premium ${now.toFixed(2)} vs entry ${entry.toFixed(2)})`;
  }
  return null;
}

/** True once neither leg carries a broker quantity — safe to delete the row. */
function legsFlat(live: RowLive): boolean {
  const ceQty = Number(live.cePosition?.netQty ?? 0);
  const peQty = Number(live.pePosition?.netQty ?? 0);
  return ceQty === 0 && peQty === 0;
}

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface PosRow {
  tradingSymbol: string;
  securityId: string;
  exchangeSegment: string;
  productType: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastTradedPrice?: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

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

/** Everything the table needs to draw one row live. */
interface RowLive {
  ceStrike: number | null;
  peStrike: number | null;
  ltpCe: number | null;
  ltpPe: number | null;
  cePosition: PosRow | null;
  pePosition: PosRow | null;
  /** Realised + unrealised P&L across the legs this row's Side actually trades,
   *  read straight off the broker's own position(s) — see rowLive's doc comment. */
  pnl: number;
  /** Combined entry premium for those same legs, off the position's own avg price. */
  entryPremium: number;
  /** Session-open VWAP of the combined CE+PE premium at this row's strikes —
   *  null until fetched (rows with VW off never fetch it) or if the intraday
   *  data isn't available yet. See useEffect below / focus_tool_vwap.py. */
  vwap: number | null;
}

const EMPTY_ROW_LIVE: RowLive = {
  ceStrike: null, peStrike: null, ltpCe: null, ltpPe: null, cePosition: null, pePosition: null,
  pnl: 0, entryPremium: 0, vwap: null,
};

/** Cache/lookup key for a strike pair's VWAP — shared across every row that
 *  happens to trade the same underlying/expiry/CE-strike/PE-strike/side, so two
 *  rows on the same strangle share one fetch instead of doubling it. Side is
 *  part of the key because a CE-only row needs a CE-only VWAP: comparing it
 *  against a combined CE+PE VWAP would exit at the wrong premium. */
function vwapKey(
  underlying: FocusUnderlying, expiry: string, ceStrike: number, peStrike: number, side: FocusSide,
): string {
  return `${underlying}:${expiry}:${ceStrike}:${peStrike}:${side}`;
}

/** Heartbeat record from scripts/tools/focus_tool_rows_worker.py, corrected by
 *  the API route against the PID and the heartbeat age. */
interface WorkerStatus {
  status: 'RUNNING' | 'STOPPED' | 'STALE' | 'ERROR';
  pid?: number;
  broker?: string;
  dryRun?: boolean;
  liveRealMoney?: boolean;
  openRows?: number;
  totalPnl?: number;
  trailState?: string;
  lastUpdate?: string;
  note?: string;
  error?: string;
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
  slRupees: '',
  slMultiplier: '1',
  ceSlMultiplier: '1',
  peSlMultiplier: '1',
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
  updatedAt: new Date().toISOString(),
};

// â”€â”€ Primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-300 cursor-pointer select-none"
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

function NumInput({ value, onChange, placeholder, className, title, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; title?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      title={title}
      disabled={disabled}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
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

/** Lots-per-leg config field: a number box flanked by -/+ steppers, clamped at 1. */
function LotStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        title="Reduce lots by one"
        className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors"
      >
        -
      </button>
      <NumInput
        value={String(value)}
        onChange={v => onChange(Math.max(1, Number(v) || 1))}
        className="w-10 text-center px-1"
        title="Lots to trade per leg"
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        title="Add one lot"
        className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors"
      >
        +
      </button>
    </div>
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

function TimeInput({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }) {
  return (
    <div className="relative flex items-center">
      <input
        type="time"
        title={title}
        value={value}
        onChange={e => onChange(e.target.value)}
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
          )}
        >{o}</button>
      ))}
    </div>
  );
}

/** One leg's strike selector: an ATM-offset dropdown or a target-premium
 *  input, with the currently resolved strike shown alongside. */
function StrikeLegSelector({
  leg, mode, offset, premium, resolvedStrike, step, onOffsetChange, onPremiumChange, onShift, shiftDisabled, locked,
}: {
  leg: 'CE' | 'PE';
  mode: FocusStrikeMode;
  offset: number;
  premium: string;
  resolvedStrike: number | null;
  step: number;
  onOffsetChange: (n: number) => void;
  onPremiumChange: (v: string) => void;
  onShift?: (direction: 'UP' | 'DOWN') => void;
  shiftDisabled?: boolean;
  /** This leg holds an open position — its strike config is frozen so the
   *  position cannot be orphaned. See StrikeEditor's doc comment. */
  locked?: boolean;
}) {
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
        <NumInput value={premium} onChange={onPremiumChange} className="w-16 h-6" disabled={locked}
          placeholder="₹" title={locked ? lockedTitle : `Target premium for the ${leg} leg — resolves to the closest listed strike priced at or below this value`} />
      )}
      <span className="text-[11px] font-mono font-bold text-zinc-300 min-w-[42px] text-right">
        {resolvedStrike ?? '—'}
      </span>
      {onShift && (
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onShift('UP')}
            disabled={shiftDisabled || resolvedStrike == null}
            title={`Shift ${leg} strike up one step — closes and reopens any live position at the new strike`}
            className="h-5 w-6 flex items-center justify-center rounded-t border border-emerald-500/20 bg-emerald-500/10 text-emerald-400
                       hover:bg-emerald-500 hover:text-oncolor hover:border-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed
                       transition-all active:scale-95"
          >
            <ChevronUp size={13} strokeWidth={3} />
          </button>
          <button
            type="button"
            onClick={() => onShift('DOWN')}
            disabled={shiftDisabled || resolvedStrike == null}
            title={`Shift ${leg} strike down one step — closes and reopens any live position at the new strike`}
            className="h-5 w-6 flex items-center justify-center rounded-b border border-rose-500/20 bg-rose-500/10 text-rose-400
                       hover:bg-rose-500 hover:text-oncolor hover:border-rose-500 disabled:opacity-30 disabled:cursor-not-allowed
                       transition-all active:scale-95"
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
function StrikeEditor({ row, live, step, onUpdate, onShift, shiftDisabled, onBlocked }: {
  row: FocusRow;
  live: RowLive;
  step: number;
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onShift?: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  shiftDisabled?: boolean;
  onBlocked?: (message: string) => void;
}) {
  /**
   * A leg holding an open broker position is LOCKED against strike-config
   * edits.
   *
   * This row finds its positions by looking up whatever strike its config
   * currently resolves to (see rowLive's findPos). Move the config off an open
   * position and that position stops being found: its badge vanishes, the row
   * reports itself flat, Exit All disappears and Delete Row unlocks — while
   * the position is still very much open at the broker, now with nothing on
   * this page tracking it. So editing an open leg's strike is refused, and the
   * shift chevrons — which close and reopen the position at the new strike —
   * are the sanctioned way to move it.
   */
  const legOpen = {
    CE: Number(live.cePosition?.netQty ?? 0) !== 0,
    PE: Number(live.pePosition?.netQty ?? 0) !== 0,
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
    <div className="flex flex-col gap-1 w-[200px]">
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
        resolvedStrike={live.ceStrike} step={step} locked={legOpen.CE}
        onOffsetChange={n => setLeg('CE', { ceOffset: n })}
        onPremiumChange={v => setLeg('CE', { cePremium: v })}
        onShift={onShift ? dir => onShift('CE', dir) : undefined} shiftDisabled={shiftDisabled} />
      <StrikeLegSelector leg="PE" mode={mode} offset={row.peOffset ?? 0} premium={row.pePremium ?? ''}
        resolvedStrike={live.peStrike} step={step} locked={legOpen.PE}
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
            className="text-[9px] font-bold text-emerald-400 hover:text-emerald-300 cursor-pointer">
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
            className="text-[9px] text-zinc-500 hover:text-zinc-400 cursor-pointer"
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
      className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 cursor-pointer transition-colors"
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

function ControlStrip({
  liveRealMoney, onToggleLive, broker,
  riskEnabled, onToggleRisk,
  targetRupees, setTargetRupees,
  stopRupees, setStopRupees,
  trailEnabled, onToggleTrail,
  triggerRupees, setTriggerRupees,
  lockRupees, setLockRupees,
  onSave, saving, peakMtm, lockMtm,
  copyTrade,
  onOpenRisk, onOpenOrders, onToggleViewMode, viewMode,
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
  onSave: () => void; saving: boolean; peakMtm: number; lockMtm: number | null;
  copyTrade: CopyTradeApi;
  onOpenRisk: () => void;
  onOpenOrders: () => void;
  onToggleViewMode: () => void;
  viewMode: 'table' | 'cards';
  workerStatus: WorkerStatus;
  onToggleWorker: () => void;
  onExitAll: () => void;
  confirmExitAll: boolean;
  exitingAll: boolean;
}) {
  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-2.5 flex items-center gap-5 flex-nowrap overflow-x-auto">
      {/* Positions section */}
      <div className="flex items-center gap-2 flex-nowrap shrink-0">
        <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest whitespace-nowrap">Positions</span>
        <button
          onClick={onToggleLive}
          title={liveRealMoney
            ? 'Live: armed rows place real orders. Click to return to dry run.'
            : 'Dry run: no orders are sent. Click to go live with real money.'}
          className={cn(
            'flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full text-oncolor transition-colors cursor-pointer',
            liveRealMoney ? 'bg-rose-600 hover:bg-rose-500' : 'bg-zinc-700 hover:bg-zinc-600',
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
              : 'Rules currently run only while this tab is open. Start the worker to keep them running server-side.'}
          className={cn(
            'flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border cursor-pointer transition-colors',
            workerStatus.status === 'RUNNING'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
              : workerStatus.status === 'STALE' || workerStatus.status === 'ERROR'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:border-zinc-600',
          )}
        >
          <Server className="h-3.5 w-3.5" />
          {workerStatus.status === 'RUNNING'
            ? `Worker on${workerStatus.openRows ? ` · ${workerStatus.openRows}` : ''}`
            : workerStatus.status === 'STALE' ? 'Worker stale'
              : workerStatus.status === 'ERROR' ? 'Worker error' : 'Worker off'}
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          title="Save the free-typed number fields — Target / Stop / Trigger / Lock and each group's Spot H↑/L↓ — to disk, where the Python worker reads them. Everything else (Arm/Exit, Start/Stop, ATM BY, Product, Strikes±, Risk/Trail on-off, LIVE · REAL MONEY) already saves itself the instant you click it."
          className="flex items-center gap-1 text-xs font-bold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 transition-colors cursor-pointer disabled:opacity-50"
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
          )}
        >
          {exitingAll ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
          {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
        </button>
        <GhostBtn onClick={onOpenRisk} title="Account-level P&L, target, stop and trail state">
          <Shield className="h-3.5 w-3.5 text-violet-400" />
          Risk / MTM
        </GhostBtn>
        <GhostBtn onClick={onOpenOrders} title="Today's broker order book for this account">
          <Activity className="h-3.5 w-3.5 text-zinc-400" />
          Order Book
        </GhostBtn>
        <GhostBtn onClick={onToggleViewMode} title="Toggle between Table and Cards view">
          <Layers className="h-3.5 w-3.5 text-zinc-400" />
          {viewMode === 'cards' ? 'Table' : 'Cards'}
        </GhostBtn>
      </div>

      <div className="h-5 w-px bg-zinc-800 shrink-0" />

      {/* Risk section */}
      <div className="flex items-center gap-3 flex-nowrap shrink-0">
        <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest whitespace-nowrap">Risk</span>
        <SwitchToggle checked={riskEnabled} onChange={onToggleRisk}
          title="Enable the account-wide target and stop below" />

        <div className="flex items-center gap-1.5">
          <Target className="h-3 w-3 text-emerald-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Target</span>
          <NumInput value={targetRupees} onChange={setTargetRupees} className="w-16" placeholder="0"
            title="Close every open row once total P&L reaches this profit (₹)" />
        </div>

        <div className="flex items-center gap-1.5">
          <ShieldOff className="h-3 w-3 text-rose-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Stop</span>
          <NumInput value={stopRupees} onChange={setStopRupees} className="w-16" placeholder="0"
            title="Close every open row once total P&L falls to this loss (₹)" />
        </div>

        <div className="h-4 w-px bg-zinc-800" />

        <SwitchToggle checked={trailEnabled} onChange={onToggleTrail} label="Trail"
          title="Ratchet a profit floor upward as P&L makes new peaks" />

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-black text-zinc-500 uppercase">Trigger</span>
          <NumInput value={triggerRupees} onChange={setTriggerRupees} className="w-16" placeholder="0"
            title="Profit (₹) at which the trail wakes up and starts locking" />
        </div>

        <div className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-amber-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Lock</span>
          <NumInput value={lockRupees} onChange={setLockRupees} className="w-16" placeholder="0"
            title="Profit (₹) kept back from each new peak — the floor that never falls" />
        </div>

        <span className="text-[10px] font-mono text-zinc-500"
          title="Peak: best total P&L so far today. Lock: the floor the trail is currently holding.">
          Peak <strong className="text-zinc-300">{peakMtm}</strong>
          <span className="mx-1.5 text-zinc-700">&middot;</span>
          Lock <strong className="text-zinc-300">{lockMtm != null ? lockMtm : '\u2014'}</strong>
        </span>
      </div>

      {/* Copy Trade Controls — wrapped so its fragment's items (label, per-
          broker checkboxes, the ARM button) form one flex group that can't be
          split across a wrap point; the strip itself no longer wraps at all
          (flex-nowrap + overflow-x-auto above), but this keeps the group
          intact if that ever changes. */}
      <div className="flex items-center gap-2 flex-nowrap shrink-0">
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
              <NumInput value={group.spotHigh} onChange={v => onChange({ spotHigh: v })} className="w-16"
                title="Book out when spot trades at or above this level" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black text-emerald-400 uppercase">Spot L&darr;</span>
              <NumInput value={group.spotLow} onChange={v => onChange({ spotLow: v })} className="w-16"
                title="Book out when spot trades at or below this level" />
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
            <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-widest">{label}</span>
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

function FocusTableRow({
  row, live, lotSize, spot, liveRealMoney, broker, busy,
  onUpdate, onDelete, onArm, onDisarm, onExit, onAddLot, onReduceLot, onShift, onBlocked,
}: {
  row: FocusRow;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onAddLot: (leg: 'CE' | 'PE', lots: number) => void;
  onReduceLot: (leg: 'CE' | 'PE', lots: number) => void;
  onShift: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  onBlocked: (message: string) => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const { ceValue, peValue, pcr } = legValues(row, live);
  // Orders are only sendable once at least one leg's contract and the lot size
  // are known — placeLeg re-checks the specific leg it is about to trade.
  const canTrade = liveRealMoney && !busy && (live.ceStrike != null || live.peStrike != null) && (lotSize ?? 0) > 0;
  const flat = legsFlat(live);
  const step = STRIKE_STEP[row.underlying];
  // How many lots the +/- buttons act on, independently per leg — e.g. add 2
  // lots of CE and 1 of PE in one click each, rather than clicking + twice on
  // one side. UI-only convenience, not persisted with the row.
  const [ceQty, setCeQty] = useState(1);
  const [peQty, setPeQty] = useState(1);

  return (
    <tr className="border-b border-zinc-700/70 hover:bg-zinc-800/20 transition-colors">

      {/* TIMING */}
      <td className="p-3 align-top">
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
            <span className="text-[9px] font-black text-zinc-600 w-8"
              title="Only enter when the nearest expiry is this many days away">DTE</span>
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <button
                key={d}
                onClick={() => onUpdate({ dte: d })}
                title={d === 'Any' ? 'Enter on any expiry' : `Enter only when expiry is ${d} day(s) away`}
                className={cn(
                  'text-[10px] font-extrabold px-2 py-0.5 rounded cursor-pointer transition-colors',
                  row.dte === d
                    ? 'bg-violet-600 text-oncolor'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200',
                )}
              >{d}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onUpdate(row, true)}
              title="Save this row's timing settings"
              className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors"
            >
              <Check className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </td>

      {/* CE / PE STRIKES */}
      <td className="p-3 align-top">
        <StrikeEditor row={row} live={live} step={step} onUpdate={onUpdate} onShift={onShift} shiftDisabled={busy} onBlocked={onBlocked} />
      </td>

      {/* LTP */}
      <td className="p-3 align-middle">
        <div title="Combined CE + PE premium right now"
          className="text-base font-mono font-black text-zinc-100 tabular-nums">
          {combinedLtp > 0 ? combinedLtp.toFixed(2) : '\u2014'}
        </div>
        <div className="text-xs font-mono font-bold mt-0.5 flex items-center gap-1">
          <span className="text-emerald-400">CE {live.ltpCe != null ? live.ltpCe.toFixed(2) : '\u2014'}</span>
          <span className="text-zinc-700">/</span>
          <span className="text-rose-400">PE {live.ltpPe != null ? live.ltpPe.toFixed(2) : '\u2014'}</span>
        </div>
        <div className="text-[10px] font-mono font-semibold mt-1 flex items-center gap-1 whitespace-nowrap"
          title="Value = lots &times; premium per leg">
          <span className="text-emerald-500">CE&nbsp;&#8377;{ceValue.toFixed(2)}</span>
          <span className="text-zinc-700">/</span>
          <span className="text-rose-500">PE&nbsp;&#8377;{peValue.toFixed(2)}</span>
        </div>
        <div className="text-[10px] font-mono font-bold mt-0.5 text-amber-400"
          title="PCR = PE value &#247; CE value">
          PCR {pcr != null ? pcr.toFixed(2) : '\u2014'}
        </div>
      </td>

      {/* LOTS */}
      <td className="p-3 align-middle">
        <LotStepper value={row.lots} onChange={v => onUpdate({ lots: v })} />
      </td>

      {/* SIDE */}
      <td className="p-3 align-middle">
        <SegPill
          options={['CE', 'BOTH', 'PE'] as const}
          value={row.side as 'CE' | 'BOTH' | 'PE'}
          title="Which legs to trade: call only, put only, or both"
          onChange={s => onUpdate({ side: s })}
        />
      </td>

      {/* STATUS / ACTIONS */}
      <td className="p-3 align-middle text-center border-l border-r border-zinc-800">
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
          {row.status === 'draft' && (
            <button
              onClick={onArm}
              title="Watch this row and enter it at its entry time"
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 cursor-pointer transition-colors"
            >
              Arm
            </button>
          )}
          {row.status === 'armed' && (
            <button
              onClick={onDisarm}
              title="Stop watching this row - it will not enter"
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600 cursor-pointer transition-colors"
            >
              Disarm
            </button>
          )}
          <button
            onClick={() => onExit('ALL')}
            disabled={flat || !canTrade}
            title={flat ? 'Nothing open on this row' : 'Close every open leg of this row at market'}
            className="text-xs font-extrabold px-3 py-1 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Exit All
          </button>
          {flat ? (
            <button
              onClick={onDelete}
              title="Delete this row"
              className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 hover:text-rose-400 cursor-pointer transition-colors"
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
      <td className="p-3 align-middle text-center">
        <div className="flex flex-col items-center gap-1.5">
          <span title="Live premium of the call leg"
            className="text-sm font-mono font-bold text-emerald-400 tabular-nums">
            {live.ltpCe != null ? live.ltpCe.toFixed(2) : '\u2014'}
          </span>
          <LegOpenBadge pos={live.cePosition} />
          <div className="flex items-center gap-1">
            <NumInput value={String(ceQty)} onChange={v => setCeQty(Math.max(1, Number(v) || 1))}
              className="w-9 h-6 text-center px-1" title="Lots the CE +/- buttons act on" />
            <button onClick={() => onAddLot('CE', ceQty)} title={`Add ${ceQty} lot(s) to the CE leg`} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors">+</button>
            <button onClick={() => onReduceLot('CE', ceQty)} title={`Reduce the CE leg by ${ceQty} lot(s)`} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors">-</button>
            <button onClick={() => onExit('CE')} title="Close the CE leg at market" className="text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors">Exit</button>
          </div>
        </div>
      </td>

      {/* PE */}
      <td className="p-3 align-middle text-center border-r border-zinc-800">
        <div className="flex flex-col items-center gap-1.5">
          <span title="Live premium of the put leg"
            className="text-sm font-mono font-bold text-rose-400 tabular-nums">
            {live.ltpPe != null ? live.ltpPe.toFixed(2) : '\u2014'}
          </span>
          <LegOpenBadge pos={live.pePosition} />
          <div className="flex items-center gap-1">
            <NumInput value={String(peQty)} onChange={v => setPeQty(Math.max(1, Number(v) || 1))}
              className="w-9 h-6 text-center px-1" title="Lots the PE +/- buttons act on" />
            <button onClick={() => onAddLot('PE', peQty)} title={`Add ${peQty} lot(s) to the PE leg`} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors">+</button>
            <button onClick={() => onReduceLot('PE', peQty)} title={`Reduce the PE leg by ${peQty} lot(s)`} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors">-</button>
            <button onClick={() => onExit('PE')} title="Close the PE leg at market" className="text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors">Exit</button>
          </div>
        </div>
      </td>

      {/* LEVEL EXITS */}
      <td className="p-3 align-middle text-center">
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-black text-rose-400">H&uarr;</span>
              <NumInput value={row.levelHigh} onChange={v => onUpdate({ levelHigh: v })} className="w-20"
                title="Exit this row when spot trades at or above this level" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-black text-emerald-400">L&darr;</span>
              <NumInput value={row.levelLow} onChange={v => onUpdate({ levelLow: v })} className="w-20"
                title="Exit this row when spot trades at or below this level" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VW"
              title="Exit when the combined premium crosses its session-open VWAP against you" />
            {row.levelVw && (
              <span className="text-[9px] font-mono font-bold text-zinc-500" title="Session-open VWAP of the combined premium, refreshed once a minute">
                {live.vwap != null ? `VWAP ${live.vwap.toFixed(2)}` : 'VWAP —'}
              </span>
            )}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-amber-400">SL &#8377;</span>
                <NumInput value={row.slRupees} onChange={v => onUpdate({ slRupees: v })} className="w-14"
                  title="Exit at this rupee loss on the pair — independent of SL &times;" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-amber-500">SL &times;</span>
                <NumInput value={row.slMultiplier} onChange={v => onUpdate({ slMultiplier: v })} className="w-9"
                  title="Exit when premium moves this multiple against you (must be above 1) — independent of SL &#8377;" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-emerald-400">CE &times;</span>
                <NumInput value={row.ceSlMultiplier ?? '1'} onChange={v => onUpdate({ ceSlMultiplier: v })} className="w-9"
                  title="Exit CE alone when its own premium moves this multiple against its own entry — independent of PE and of the pair SL &times; above" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-black text-rose-400">PE &times;</span>
                <NumInput value={row.peSlMultiplier ?? '1'} onChange={v => onUpdate({ peSlMultiplier: v })} className="w-9"
                  title="Exit PE alone when its own premium moves this multiple against its own entry — independent of CE and of the pair SL &times; above" />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onUpdate(row, true)}
              title="Save this row's level exits"
              className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors"
            >
              <Check className="h-3 w-3" /> Save
            </button>
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, slRupees: '', slMultiplier: '1', ceSlMultiplier: '1', peSlMultiplier: '1' }, true)}
              title="Clear every level exit on this row"
              className="text-[10px] font-bold text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors"
            >
              &times; clear
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── Card view for a single row ────────────────────────────────────────────────

function FocusRowCard({
  row, live, lotSize, spot, liveRealMoney, broker, busy,
  onUpdate, onDelete, onArm, onDisarm, onExit, onAddLot, onReduceLot, onShift, onBlocked,
}: {
  row: FocusRow;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onAddLot: (leg: 'CE' | 'PE', lots: number) => void;
  onReduceLot: (leg: 'CE' | 'PE', lots: number) => void;
  onShift: (leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') => void;
  onBlocked: (message: string) => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const { ceValue, peValue, pcr } = legValues(row, live);
  const canTrade = liveRealMoney && !busy && (live.ceStrike != null || live.peStrike != null) && (lotSize ?? 0) > 0;
  const flat = legsFlat(live);
  const step = STRIKE_STEP[row.underlying];
  // How many lots the +/- buttons act on, independently per leg — see the
  // matching note in FocusTableRow. UI-only, not persisted.
  const [ceQty, setCeQty] = useState(1);
  const [peQty, setPeQty] = useState(1);

  return (
    <div className={cn(
      'rounded-xl border bg-zinc-900/60 p-4 flex flex-col gap-3',
      !flat ? 'border-emerald-500/30' : 'border-zinc-800 hover:border-zinc-700/60'
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
            className="text-zinc-600 hover:text-rose-400 disabled:hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 font-bold text-xs p-1"
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
          <span className="text-[8px] font-black text-zinc-500 w-9">DTE</span>
          <div className="flex gap-1">
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <button
                key={d}
                onClick={() => onUpdate({ dte: d })}
                className={cn(
                  'text-[9px] font-extrabold px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                  row.dte === d ? 'bg-violet-600 text-oncolor' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
                )}
              >{d}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Strike and LTP details */}
      <div className="flex items-center justify-between bg-zinc-950/20 rounded-xl p-3 border border-zinc-800/40">
        <div className="flex flex-col">
          <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider">CE / PE Strike</span>
          <span className="font-mono font-bold text-zinc-200 text-sm mt-0.5">
            {live.ceStrike ?? '—'} / {live.peStrike ?? '—'}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider">Premium</span>
          <span className="text-sm font-mono font-black text-zinc-100 mt-0.5">{combinedLtp > 0 ? combinedLtp.toFixed(2) : '—'}</span>
        </div>
      </div>

      {/* CE/PE value + PCR */}
      <div className="flex items-center justify-between bg-zinc-950/20 rounded-xl px-3 py-2 border border-zinc-800/40 text-[10px] font-mono font-semibold">
        <span title="Value = lots × premium per leg">
          <span className="text-emerald-500">CE&nbsp;₹{ceValue.toFixed(2)}</span>
          <span className="text-zinc-700 mx-1">/</span>
          <span className="text-rose-500">PE&nbsp;₹{peValue.toFixed(2)}</span>
        </span>
        <span className="text-amber-400 font-bold" title="PCR = PE value ÷ CE value">
          PCR {pcr != null ? pcr.toFixed(2) : '—'}
        </span>
      </div>

      {/* Strike editor */}
      <div className="bg-zinc-950/20 border border-zinc-800/40 rounded-xl p-3">
        <StrikeEditor row={row} live={live} step={step} onUpdate={onUpdate} onShift={onShift} shiftDisabled={busy} onBlocked={onBlocked} />
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
            <NumInput value={String(ceQty)} onChange={v => setCeQty(Math.max(1, Number(v) || 1))}
              className="w-8 h-5 text-center px-0.5" title="Lots the CE +/- buttons act on" />
            <button onClick={() => onAddLot('CE', ceQty)} title={`Add ${ceQty} CE lot(s)`} className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 cursor-pointer">+</button>
            <button onClick={() => onReduceLot('CE', ceQty)} title={`Reduce CE by ${ceQty} lot(s)`} className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer">-</button>
            <button onClick={() => onExit('CE')} title="Exit CE leg" className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer">Exit</button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-rose-400">PE</span>
            <span className="text-xs font-mono font-bold text-zinc-300">{live.ltpPe != null ? live.ltpPe.toFixed(2) : '—'}</span>
            <LegOpenBadge pos={live.pePosition} />
          </div>
          <div className="flex items-center gap-1">
            <NumInput value={String(peQty)} onChange={v => setPeQty(Math.max(1, Number(v) || 1))}
              className="w-8 h-5 text-center px-0.5" title="Lots the PE +/- buttons act on" />
            <button onClick={() => onAddLot('PE', peQty)} title={`Add ${peQty} PE lot(s)`} className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 cursor-pointer">+</button>
            <button onClick={() => onReduceLot('PE', peQty)} title={`Reduce PE by ${peQty} lot(s)`} className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer">-</button>
            <button onClick={() => onExit('PE')} title="Exit PE leg" className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer">Exit</button>
          </div>
        </div>
      </div>

      {/* Level Exits */}
      <div className="flex flex-col gap-1 text-[11px]">
        <div className="flex justify-between items-center">
          <span className="text-rose-400 text-[9px] font-black">H&uarr;</span>
          <NumInput value={row.levelHigh} onChange={v => onUpdate({ levelHigh: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-emerald-400 text-[9px] font-black">L&darr;</span>
          <NumInput value={row.levelLow} onChange={v => onUpdate({ levelLow: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-amber-400 text-[9px] font-black">SL ₹</span>
          <NumInput value={row.slRupees} onChange={v => onUpdate({ slRupees: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-amber-500 text-[9px] font-black">SL &times;</span>
          <NumInput value={row.slMultiplier} onChange={v => onUpdate({ slMultiplier: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-emerald-400 text-[9px] font-black" title="Exit CE alone on its own premium multiple, independent of PE and of SL × above">CE &times;</span>
          <NumInput value={row.ceSlMultiplier ?? '1'} onChange={v => onUpdate({ ceSlMultiplier: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-rose-400 text-[9px] font-black" title="Exit PE alone on its own premium multiple, independent of CE and of SL × above">PE &times;</span>
          <NumInput value={row.peSlMultiplier ?? '1'} onChange={v => onUpdate({ peSlMultiplier: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VW"
            title="Exit when the combined premium crosses its session-open VWAP against you" />
          {row.levelVw && (
            <span className="text-[9px] font-mono font-bold text-zinc-500">
              {live.vwap != null ? `VWAP ${live.vwap.toFixed(2)}` : 'VWAP —'}
            </span>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => onUpdate(row, true)}
              className="text-[9px] font-bold text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded hover:bg-emerald-500/10"
            >
              Save Exits
            </button>
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, slRupees: '', slMultiplier: '1', ceSlMultiplier: '1', peSlMultiplier: '1' }, true)}
              className="text-[9px] text-zinc-500 hover:text-zinc-400"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Row Control Actions */}
      <div className="flex justify-end gap-2 border-t border-zinc-800/80 pt-2.5 mt-1">
        {row.status === 'draft' && (
          <button onClick={onArm} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500">
            Arm Row
          </button>
        )}
        {row.status === 'armed' && (
          <button onClick={onDisarm} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600">
            Disarm
          </button>
        )}
        <button onClick={() => onExit('ALL')} disabled={flat || !canTrade}
          title={flat ? 'Nothing open on this row' : 'Close every open leg of this row at market'}
          className="text-xs font-extrabold px-3 py-1.5 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed">
          Exit All
        </button>
      </div>
    </div>
  );
}

// ── Side Drawer Modal ────────────────────────────────────────────────────────

function FocusModal({
  isOpen,
  onClose,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-oncolor-dark/70 backdrop-blur-sm transition-opacity">
      <div className="h-full w-full max-w-xl bg-zinc-900 border-l border-zinc-800 p-6 flex flex-col gap-4 shadow-2xl text-white overflow-y-auto">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white text-lg font-bold p-1 cursor-pointer"
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
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
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
  // Session-open VWAP per strike pair (see vwapKey) — only fetched for rows
  // that actually enabled VW, refreshed once a minute via /api/focus-tool/vwap.
  const [rowVwap, setRowVwap] = useState<Record<string, number | null>>({});
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
  const [lookups, setLookups] = useState<Record<FocusUnderlying, LookupData | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
  const [chains, setChains] = useState<Record<FocusUnderlying, ChainData | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
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

  const [activeModal, setActiveModal] = useState<'risk' | 'orderbook' | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderSort, setOrderSort] = useState<SortState>({ key: 'createTime', dir: 'desc' });

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
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>({ status: 'STOPPED' });
  const workerRunning = workerStatus.status === 'RUNNING';

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

  const toggleWorker = useCallback(async () => {
    const starting = !workerRunning;
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
    setLiveRealMoney(d.liveRealMoney);
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

  // ── Lot sizes + per-strike order handles ────────────────────────
  // One lookup per underlying per expiry: it carries the lot size AND the
  // ce/pe security ids (Dhan) or trading symbols (everyone else) that the leg
  // buttons need to place an order.
  const lookupSeq = React.useRef(0);
  useEffect(() => {
    const seq = ++lookupSeq.current;
    UNDERLYINGS.forEach(u => {
      const expiry = expiries[u]?.[0];
      if (!expiry) return;
      fetch(`${scalperRoute(broker, 'lookup')}?underlying=${u}&expiry=${expiry}`)
        .then(r => r.json())
        .then((j: { success?: boolean; data?: LookupData }) => {
          // Out-of-order guard: a slow lookup for the previous broker must not
          // land on top of the current one's — those ids place orders.
          if (seq !== lookupSeq.current) return;
          if (!j.success || !j.data?.strikes) return;
          setLookups(prev => ({ ...prev, [u]: j.data! }));
          if (Number(j.data.lotSize) > 0) {
            setLotSizes(prev => ({ ...prev, [u]: Number(j.data!.lotSize) }));
          }
        })
        .catch(() => {});
    });
  }, [broker, expiryKey]);

  // ── Option premiums ─────────────────────────────────────────────
  // The chain is the fallback LTP source for every underlying, and the spot
  // source for SENSEX. The standalone tick bridge (useFocusToolWS, all three
  // underlyings) is preferred per-strike in rowLive below because it's
  // realtime; the chain route caches 10s and is paced ~1 call/3s per
  // underlying account-wide, so it is polled at that cadence and only for
  // underlyings that actually have rows.
  const activeUnderlyings = UNDERLYINGS.filter(u => config.rows.some(r => r.underlying === u));
  const activeKey = activeUnderlyings.join('|');
  const chainSeq = React.useRef(0);
  useEffect(() => {
    if (!activeKey) return;
    const seq = ++chainSeq.current;
    const fetchChains = () => {
      activeKey.split('|').forEach(name => {
        const u = name as FocusUnderlying;
        const expiry = expiries[u]?.[0];
        if (!expiry) return;
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
            setChains(prev => ({ ...prev, [u]: { spot: Number(j.data?.chain?.last_price ?? 0), oc: flat } }));
          })
          .catch(() => {});
      });
    };
    fetchChains();
    const t = setInterval(fetchChains, 3000);
    return () => clearInterval(t);
  }, [broker, expiryKey, activeKey]);

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

  useEffect(() => {
    if (activeModal === 'orderbook') {
      fetchOrders();
    }
  }, [activeModal, fetchOrders]);

  useEffect(() => {
    if (total > 0) {
      setPeakMtm(prev => Math.max(prev, total));
    }
  }, [total]);

  useEffect(() => {
    const trigger = Number(triggerRupees) || 0;
    const lock = Number(lockRupees) || 0;
    if (trailEnabled && trigger > 0 && peakMtm >= trigger) {
      setLockMtm(peakMtm - lock);
    } else {
      setLockMtm(null);
    }
  }, [trailEnabled, triggerRupees, lockRupees, peakMtm]);

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
      if (!(out[u] > 0)) out[u] = Number(chains[u]?.spot ?? 0);
    }
    return out;
  }, [spotPrices, chains, focusWsQuotes]);

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
   * armed row would trade right now.
   *
   * Premium: the NIFTY tick bridge first when it is on this row's expiry —
   * it is realtime, where the chain route caches 10s — then the chain.
   */
  const rowLive = useMemo<Record<string, RowLive>>(() => {
    const out: Record<string, RowLive> = {};
    for (const row of config.rows) {
      const u = row.underlying;
      const step = STRIKE_STEP[u];
      const spot = spots[u] ?? 0;
      // ATM base per the index group's own "ATM BY" pick — Spot (the index
      // level) or Fut (the nearest futures contract's LTP, which can sit at a
      // premium/discount to spot). Falls back to spot if the futures strip
      // hasn't resolved yet, so a row is never left unresolved by a slow feed.
      const group = config.groups.find(g => g.underlying === u);
      const futLtp = futQuotes[u]?.ltp ?? 0;
      const atmBase = group?.atmBy === 'Fut' && futLtp > 0 ? futLtp : spot;
      const atm = atmBase > 0 ? Math.round(atmBase / step) * step : null;
      const oc = chains[u]?.oc;

      const ceStrike = row.strikeMode === 'PREMIUM'
        ? nearestStrikeByPremium(oc, 'CE', Number(row.cePremium))
        : (atm != null ? atm + (row.ceOffset ?? 0) * step : null);
      const peStrike = row.strikeMode === 'PREMIUM'
        ? nearestStrikeByPremium(oc, 'PE', Number(row.pePremium))
        : (atm != null ? atm + (row.peOffset ?? 0) * step : null);

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

      const ceRef = ceKey ? lookups[u]?.strikes?.[ceKey] : undefined;
      const peRef = peKey ? lookups[u]?.strikes?.[peKey] : undefined;
      const findPos = (leg: 'CE' | 'PE'): PosRow | null => {
        const ref = leg === 'CE' ? ceRef : peRef;
        // Dhan is the only broker with a numeric security id; the rest join by
        // trading symbol.
        if (broker === 'dhan') {
          const id = leg === 'CE' ? ref?.ceId : ref?.peId;
          if (!id) return null;
          return positions.find(p => String(p.securityId) === String(id)) ?? null;
        }
        const sym = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
        if (!sym) return null;
        return positions.find(p => String(p.tradingSymbol) === sym) ?? null;
      };

      const cePosition = findPos('CE');
      const pePosition = findPos('PE');

      // P&L and entry premium across only the legs this row's Side trades —
      // read off the broker's own position, never a client-side guess (this
      // tool doesn't stamp its own entry price anywhere).
      let pnl = 0;
      let entryPremium = 0;
      for (const leg of legsOf(row)) {
        const pos = leg === 'CE' ? cePosition : pePosition;
        if (!pos) continue;
        pnl += (Number(pos.realizedProfit) || 0) + (Number(pos.unrealizedProfit) || 0);
        entryPremium += pos.netQty < 0 ? (Number(pos.sellAvg) || 0) : (Number(pos.buyAvg) || 0);
      }

      const rowExpiry = row.expiry || expiries[u]?.[0] || '';
      const vwap = row.levelVw && ceStrike != null && peStrike != null && rowExpiry
        ? (rowVwap[vwapKey(u, rowExpiry, ceStrike, peStrike, row.side)] ?? null)
        : null;

      out[row.id] = {
        ceStrike, peStrike,
        ltpCe: pick(ceWs?.ce?.ltp, ceCh?.ce),
        ltpPe: pick(peWs?.pe?.ltp, peCh?.pe),
        cePosition, pePosition,
        pnl, entryPremium, vwap,
      };
    }
    return out;
  }, [config.rows, config.groups, spots, futQuotes, chains, focusWsQuotes, lookups, positions, broker, expiries, rowVwap]);

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
      keys.add(vwapKey(row.underlying, expiry, live.ceStrike, live.peStrike, row.side));
    }
    return Array.from(keys).sort().join('|');
  }, [config.rows, rowLive, expiries]);

  // Session-open VWAP fetch: one call per distinct strike pair among rows
  // that actually enabled VW, refreshed once a minute (the underlying data
  // only moves in whole-minute bars anyway — see focus_tool_vwap.py).
  useEffect(() => {
    if (!vwapWantedKey) return;
    const wanted = vwapWantedKey.split('|').map(key => {
      const [underlying, expiry, ceStrike, peStrike, side] = key.split(':');
      return { key, underlying, expiry, ceStrike, peStrike, side };
    });

    let cancelled = false;
    const fetchAll = () => {
      wanted.forEach(({ key, underlying, expiry, ceStrike, peStrike, side }) => {
        const url = `/api/focus-tool/vwap?underlying=${underlying}&expiry=${expiry}&ceStrike=${ceStrike}&peStrike=${peStrike}&side=${side}`;
        fetch(url)
          .then(r => r.json())
          .then((j: { success?: boolean; vwap?: number | null }) => {
            if (cancelled || !j.success) return;
            setRowVwap(prev => (prev[key] === (j.vwap ?? null) ? prev : { ...prev, [key]: j.vwap ?? null }));
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
    setConfig(prev => {
      const nextRows = prev.rows.map(r => r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r);
      const nextConfig = { ...prev, rows: nextRows };
      if (saveToDisk) {
        const row = nextRows.find(r => r.id === id);
        const err = row ? validateLevelExits(row, spots[row.underlying] ?? 0) : null;
        if (err) {
          addToast('error', 'Level exit not saved', err);
        } else {
          saveConfig(nextConfig);
        }
      }
      return nextConfig;
    });
  }

  /** Arm a row for the scheduler. Clears the one-entry-per-row latch so a row
   *  that already entered and exited can be deliberately re-armed to trade
   *  again — otherwise re-arming would look accepted but never fire. */
  function armRow(id: string) {
    autoEnteringRef.current.delete(id);
    updateRow(id, { status: 'armed' }, true);
  }

  function deleteRow(id: string) {
    autoEnteringRef.current.delete(id);
    autoExitingRef.current.delete(id);
    if (!legsFlat(rowLive[id] ?? EMPTY_ROW_LIVE)) {
      addToast('error', 'Cannot delete row', 'Exit the CE/PE legs first — this row still holds a position');
      return;
    }
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

  // ── Leg orders ──────────────────────────────────────────────────
  //
  // The Focus Tool is a premium-selling scheduler: opening a leg is a SELL,
  // reducing one is a BUY. A reducing order re-resolves its product from the
  // live position rather than from the group, because an order booked under
  // the wrong product does not reduce the position — the broker opens a fresh
  // one on the other side, doubling exposure at the moment risk was being cut.

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
    opts: { reduce: boolean; lots?: number; all?: boolean; strikeOverride?: number },
  ): Promise<boolean> {
    const u = row.underlying;
    const what = `${u} ${leg}`;

    if (!liveRealMoney) {
      addToast('error', 'Dry run', 'Enable LIVE · REAL MONEY to place orders');
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

    const ref = lookups[u]?.strikes?.[strikeKey(strike)];
    const securityId = leg === 'CE' ? ref?.ceId : ref?.peId;
    const symbol     = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
    if (broker === 'dhan' ? !securityId : !symbol) {
      addToast('error', `${what} order not sent`, `No ${broker} contract for ${strike} ${leg}`);
      return false;
    }

    const pos = leg === 'CE' ? live.cePosition : live.pePosition;
    const netQty = Number(pos?.netQty ?? 0);

    let quantity: number;
    let side: 'BUY' | 'SELL';
    if (opts.reduce) {
      if (netQty === 0) {
        addToast('error', `${what} already flat`, 'Nothing to reduce');
        return false;
      }
      // Close against the direction the broker actually shows, not against an
      // assumed short — a row could be held long.
      side = netQty < 0 ? 'BUY' : 'SELL';
      const want = opts.all ? Math.abs(netQty) : (opts.lots ?? 1) * lotSize;
      quantity = Math.min(want, Math.abs(netQty));
    } else {
      side = 'SELL';
      quantity = (opts.lots ?? 1) * lotSize;
    }
    if (!(quantity > 0)) return false;

    // Reducing: the position's own product. Opening: the group's.
    const group = config.groups.find(g => g.underlying === u);
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
   * Poll the broker's position book until one leg at `strike` reads flat, and
   * return how many units actually left the book.
   *
   * Returns null if the leg is still not flat when the deadline passes, or if
   * every position fetch failed — the caller must treat that as "unknown", not
   * as "flat". A market close normally settles well inside this window; the
   * retries exist so a slow fill isn't mistaken for a failed one.
   */
  async function verifyLegClosed(
    u: FocusUnderlying, leg: 'CE' | 'PE', strike: number, qtyBefore: number,
    maxWaitMs = 4000,
  ): Promise<number | null> {
    const ref = lookups[u]?.strikes?.[strikeKey(strike)];
    const id = leg === 'CE' ? ref?.ceId : ref?.peId;
    const sym = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
    if (broker === 'dhan' ? !id : !sym) return null;

    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      await new Promise(r => setTimeout(r, 400));
      const rows = await fetchPositionsNow();
      if (rows) {
        const pos = broker === 'dhan'
          ? rows.find(p => String(p.securityId) === String(id))
          : rows.find(p => String(p.tradingSymbol) === sym);
        const remaining = Math.abs(Number(pos?.netQty ?? 0));
        if (remaining === 0) return qtyBefore;
        // Partially filled and no longer shrinking is still reported once the
        // deadline passes; until then keep waiting for the rest.
        if (Date.now() >= deadline) return remaining < qtyBefore ? qtyBefore - remaining : null;
      } else if (Date.now() >= deadline) {
        return null;
      }
    }
  }

  /**
   * Shift one leg's strike up or down by one listed step — same behavior as
   * AdvancedScalper's chevrons: an open position is closed at the current
   * strike and reopened at the new one for the same quantity, then the row's
   * own strike-resolution config is moved so it keeps pointing at the new
   * strike (ATM mode: the leg's offset ±1 step, mirrored to the other leg
   * when linked; PREMIUM mode: the leg's target premium reset to the new
   * strike's own LTP so it keeps resolving there). A flat leg just moves the
   * config — no orders.
   */
  async function handleShiftStrike(row: FocusRow, leg: 'CE' | 'PE', direction: 'UP' | 'DOWN') {
    if (busyRows.has(row.id)) return;
    const u = row.underlying;
    const step = STRIKE_STEP[u];
    const live = rowLive[row.id] ?? EMPTY_ROW_LIVE;
    const currStrike = leg === 'CE' ? live.ceStrike : live.peStrike;
    if (currStrike == null) {
      addToast('error', 'Cannot shift', `${leg} strike not resolved yet`);
      return;
    }
    const newStrike = direction === 'UP' ? currStrike + step : currStrike - step;
    const newRef = lookups[u]?.strikes?.[strikeKey(newStrike)];
    const hasContract = broker === 'dhan' ? !!(leg === 'CE' ? newRef?.ceId : newRef?.peId)
                                           : !!(leg === 'CE' ? newRef?.ceSymbol : newRef?.peSymbol);
    if (!hasContract) {
      addToast('error', 'Cannot shift', `No ${broker} contract for ${newStrike} ${leg}`);
      return;
    }

    await runRowAction(row.id, async () => {
      const pos = leg === 'CE' ? live.cePosition : live.pePosition;
      const netQty = Number(pos?.netQty ?? 0);

      if (netQty !== 0) {
        const lotSize = lotSizes[u];
        if (!lotSize) {
          addToast('error', 'Cannot shift', `Lot size for ${u} not resolved yet`);
          return;
        }
        const accepted = await placeLeg(row, leg, { reduce: true, all: true });
        if (!accepted) {
          addToast('error', 'Shift aborted', `${currStrike} ${leg} close was not confirmed — position left untouched`);
          return;
        }

        // An accepted order is not a filled order. Reopening at the new strike
        // on the strength of the broker's ACK alone would double this leg's
        // exposure whenever the close doesn't fill (or only partly fills), so
        // confirm against the position book before opening anything.
        const closedUnits = await verifyLegClosed(u, leg, currStrike, Math.abs(netQty));
        if (closedUnits == null) {
          addToast('error', 'Shift halted', `Could not confirm ${currStrike} ${leg} is flat — no new leg opened. Check the position book.`);
          return;
        }
        if (closedUnits === 0) {
          addToast('error', 'Shift aborted', `Nothing left ${currStrike} ${leg} — no new leg opened`);
          return;
        }

        // Size the new leg off what ACTUALLY left the book, never off the
        // pre-close snapshot — a partial fill re-opened at full size would
        // leave the account net long/short after the roll.
        const lots = Math.floor(closedUnits / lotSize);
        if (lots < 1) {
          addToast('error', 'Shift incomplete', `${closedUnits} qty closed at ${currStrike} ${leg} is under one lot — reopen manually at ${newStrike}`);
        } else {
          if (closedUnits % lotSize !== 0) {
            addToast('error', 'Partial re-entry', `Reopening ${lots} lot(s) of the ${closedUnits} qty closed — the remainder stays flat`);
          }
          const opened = await placeLeg(row, leg, { reduce: false, lots, strikeOverride: newStrike });
          if (!opened) {
            addToast('error', 'Shift incomplete', `Closed ${currStrike} ${leg} but the new ${newStrike} ${leg} order failed — reopen manually`);
          }
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
      const otherOpen = Number(
        (otherLeg === 'CE' ? live.cePosition : live.pePosition)?.netQty ?? 0,
      ) !== 0;
      const linked = (row.linked ?? true) && !otherOpen;
      if ((row.linked ?? true) && otherOpen) {
        addToast('error', 'Linked leg kept its strike', `${otherLeg} holds an open position — only ${leg} was rolled`);
      }
      if (row.strikeMode === 'PREMIUM') {
        const oc = chains[u]?.oc;
        const newLtp = oc?.[strikeKey(newStrike)]?.[leg === 'CE' ? 'ce' : 'pe'];
        if (!(Number(newLtp) > 0)) {
          addToast('error', 'Strike shifted, target not updated', `No live premium for ${newStrike} ${leg} yet — set the ₹ target manually`);
          return;
        }
        const val = String(newLtp);
        const patch: Partial<FocusRow> = leg === 'CE' ? { cePremium: val } : { pePremium: val };
        if (linked) { if (leg === 'CE') patch.pePremium = val; else patch.cePremium = val; }
        updateRow(row.id, patch, true);
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
   * First level-exit rule this row breaches, or null if none has. Checked in
   * this order: H↑, L↓, VW, SL ₹, SL × — matching the exit ladder in the
   * sibling implementation (focus_tool_worker.py's evaluate_exit).
   *
   * H↑/L↓ compare against spot. VW compares against a genuine session-open
   * VWAP (fetched once a minute per strike pair — see vwapWantedKey's effect
   * and scripts/tools/focus_tool_vwap.py; live.vwap is null until fetched or
   * if VW is off, so the rule is silently inert until real data exists —
   * never fires on a guess). SL ₹/SL × against the broker's own P&L and
   * entry price.
   */
  function evaluateRowExit(row: FocusRow, live: RowLive, spot: number): string | null {
    const hi = Number(row.levelHigh);
    if (row.levelHigh && Number.isFinite(hi) && spot > 0 && spot >= hi) {
      return `H↑ breached: spot ${spot.toFixed(2)} ≥ ${hi}`;
    }
    const lo = Number(row.levelLow);
    if (row.levelLow && Number.isFinite(lo) && spot > 0 && spot <= lo) {
      return `L↓ breached: spot ${spot.toFixed(2)} ≤ ${lo}`;
    }
    // Premium of only the legs this row's Side trades. `entryPremium` is
    // already restricted the same way (see rowLive), so a CE-only row must not
    // compare a CE entry price against a CE+PE current price — that mismatch
    // would fire, or fail to fire, a real-money exit at the wrong threshold.
    const nowPremium = sidePremium(row, live);
    if (row.levelVw && live.vwap != null && live.vwap > 0) {
      // This tool only ever opens with a SELL (see placeLeg) — hurt by the
      // premium expanding past VWAP, same as slMult below.
      if (nowPremium > 0 && nowPremium >= live.vwap) {
        return `VW breached: premium ${nowPremium.toFixed(2)} ≥ VWAP ${live.vwap.toFixed(2)}`;
      }
    }
    const slRs = Number(row.slRupees);
    if (row.slRupees && Number.isFinite(slRs) && slRs > 0) {
      if (live.pnl <= -slRs) return `SL ₹${slRs} hit (P&L ₹${live.pnl.toFixed(0)})`;
    }
    const slMult = Number(row.slMultiplier);
    if (row.slMultiplier && Number.isFinite(slMult) && slMult > 1) {
      const entry = live.entryPremium;
      // This tool only ever opens with a SELL (see placeLeg) — the position is
      // hurt by the premium expanding past a multiple of what it was sold for.
      if (entry > 0 && nowPremium > 0 && nowPremium >= entry * slMult) {
        return `SL ×${slMult} hit (premium ${nowPremium.toFixed(2)} vs entry ${entry.toFixed(2)})`;
      }
    }
    return null;
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
  const schedulerRef = useRef({
    config, rowLive, spots, total, lockMtm, riskEnabled, targetRupees, stopRupees, trailEnabled,
  });
  schedulerRef.current = {
    config, rowLive, spots, total, lockMtm, riskEnabled, targetRupees, stopRupees, trailEnabled,
  };
  const expiriesRef = useRef(expiries);
  expiriesRef.current = expiries;

  /**
   * Square off every leg of one row at market and mark it exited. Deduped by
   * `autoExitingRef` so a rule that stays breached across ticks (they all do)
   * cannot fire a second time while the first exit is still in flight.
   */
  function autoExitRow(row: FocusRow, reason: string) {
    if (autoExitingRef.current.has(row.id)) return;
    autoExitingRef.current.add(row.id);
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
        const rows = await fetchPositionsNow();
        if (rows) updateRow(row.id, { status: 'exited' }, true);
      })
      .finally(() => autoExitingRef.current.delete(row.id));
  }

  /**
   * Close just one leg on its own SL x breach, leaving the other leg (and the
   * row itself) exactly as it was. Unlike autoExitRow this never touches
   * `status` — a partial exit does not mean the row is done, and the other
   * leg's own rules keep being evaluated on later ticks.
   */
  function autoExitLeg(row: FocusRow, leg: 'CE' | 'PE', reason: string) {
    const key = `${row.id}:${leg}`;
    if (autoExitingLegRef.current.has(key)) return;
    autoExitingLegRef.current.add(key);
    addToast('error', `Auto-exit ${leg}: ${row.underlying} ${row.id.slice(-4)}`, reason);
    placeLeg(row, leg, { reduce: true, all: true })
      .finally(() => autoExitingLegRef.current.delete(key));
  }

  useEffect(() => {
    // Same hand-off as the scheduler below: the worker evaluates these very
    // rules server-side, so the tab must not race it.
    if (!liveRealMoney || workerRunning) return;
    for (const row of config.rows) {
      const live = rowLive[row.id];
      if (!live || legsFlat(live)) continue;

      // Leg-wise SL x first: it can fire independently of, and more often
      // than, the pair-level rules below. Skip the whole-row check this tick
      // once a leg exit has been sent — the position book it would be
      // evaluated against is about to change.
      const ceReason = legStopReason(row, 'CE', live);
      if (ceReason) { autoExitLeg(row, 'CE', ceReason); continue; }
      const peReason = legStopReason(row, 'PE', live);
      if (peReason) { autoExitLeg(row, 'PE', peReason); continue; }

      const reason = evaluateRowExit(row, live, spots[row.underlying] ?? 0);
      if (reason) autoExitRow(row, reason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowLive, spots, liveRealMoney, workerRunning]);

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
      let anyFilled = false;
      // Sequential, so one leg's rejection is reported against that leg and a
      // failure part-way through doesn't leave two orders racing.
      for (const leg of legsOf(row)) {
        if (await placeLeg(row, leg, { reduce: false, lots: row.lots })) anyFilled = true;
      }
      if (anyFilled) {
        updateRow(row.id, { status: 'entered' }, true);
      } else {
        addToast('error', 'Auto-entry failed', `${row.underlying}: no leg was accepted — row left armed`);
        autoEnteringRef.current.delete(row.id);   // let it retry on a later tick
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
    // and race every exit.
    if (!liveRealMoney || workerRunning) return;

    const tick = () => {
      const {
        config: cfg, rowLive: live, spots: sp, total: tot, lockMtm: lock,
        riskEnabled: riskOn, targetRupees: target$, stopRupees: stop$, trailEnabled: trailOn,
      } = schedulerRef.current;
      const nowHm = istHm();
      const openRows = cfg.rows.filter(r => {
        const l = live[r.id];
        return l && !legsFlat(l);
      });

      // ── 1. Account-wide risk: closes every open row at once ──
      if (riskOn && openRows.length) {
        const target = Number(target$);
        const stop = Number(stop$);
        let reason: string | null = null;
        if (target$ && target > 0 && tot >= target) {
          reason = `Account target hit: ${fmtInr(tot, true)} ≥ ${fmtInr(target)}`;
        } else if (stop$ && stop > 0 && tot <= -stop) {
          reason = `Account stop hit: ${fmtInr(tot, true)} ≤ ${fmtInr(-stop, true)}`;
        } else if (trailOn && lock != null && tot <= lock) {
          reason = `Trailing lock hit: ${fmtInr(tot, true)} ≤ ${fmtInr(lock, true)}`;
        }
        if (reason) {
          for (const row of openRows) actionsRef.current.autoExitRow(row, reason);
          return;   // nothing else should run on a tick that just flattened the book
        }
      }

      // ── 2. Per-index Book Exit on spot levels ──
      for (const g of cfg.groups) {
        if (!g.bookExit) continue;
        const spot = sp[g.underlying] ?? 0;
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
          for (const row of openRows.filter(r => r.underlying === g.underlying)) actionsRef.current.autoExitRow(row, reason);
        }
      }

      // ── 3. Per-row time exit, plus the repo-wide 15:17 intraday backstop ──
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

      // ── 4. Auto-entry for armed rows ──
      for (const row of cfg.rows) {
        if (row.status !== 'armed') continue;
        const l = live[row.id];
        if (!l || !legsFlat(l)) continue;                       // already holds a position
        const group = cfg.groups.find(g => g.underlying === row.underlying);
        if (!group?.enabled) continue;                          // index not started
        if (!row.entryTime || nowHm < row.entryTime) continue;  // not yet
        // Never enter into a window that has already closed — arming a row
        // after its own exit time (or after the intraday backstop) must not
        // open a position that the next tick immediately squares off.
        if (row.exitTime && nowHm >= row.exitTime) continue;
        if (group.product === 'INTRADAY' && nowHm >= INTRADAY_BACKSTOP_HM) continue;
        if (!dteMatches(row.dte, dteFor(row.expiry || expiriesRef.current[row.underlying]?.[0] || ''))) continue;
        if (!(l.ceStrike != null || l.peStrike != null)) continue;
        actionsRef.current.autoEnterRow(row, `Entry time ${row.entryTime} reached`);
      }
    };

    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRealMoney, workerRunning]);

  /**
   * Start/Stop, ATM BY, Product, Strikes±, and the Book Exit on/off toggle are
   * each a single, complete choice the instant they're clicked — safe to save
   * immediately, same as Arm. Since the Worker only ever sees the FILE (not
   * this tab's memory), an unsaved "Start" that only lives in local state is
   * invisible to it: the tab would honor it, the worker wouldn't, and that gap
   * is exactly what caused the earlier "why didn't it enter" confusion.
   *
   * Spot H↑/L↓ are free-typed NumInputs, not a discrete choice, so they're the
   * one exception — those stay behind the explicit Save Preferences button.
   * Auto-saving on every keystroke would let a half-typed level (e.g. "2" on
   * the way to typing "25000") briefly reach disk, and a worker tick landing
   * in that instant would read spot >= 2 as breached and fire a real exit.
   */
  function updateGroup(underlying: FocusUnderlying, patch: Partial<FocusIndexGroup>) {
    const freeTextFields = new Set(['spotHigh', 'spotLow']);
    const isFreeTextEdit = Object.keys(patch).every(k => freeTextFields.has(k));

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
    'riskEnabled' | 'trailEnabled' | 'liveRealMoney'
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
    saveRiskPatch({ liveRealMoney: next });
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
        futQuotes={futQuotes}
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

      <ControlStrip
        liveRealMoney={liveRealMoney} onToggleLive={toggleLiveRealMoney} broker={broker}
        riskEnabled={riskEnabled} onToggleRisk={toggleRiskEnabled}
        targetRupees={targetRupees} setTargetRupees={setTargetRupees}
        stopRupees={stopRupees} setStopRupees={setStopRupees}
        trailEnabled={trailEnabled} onToggleTrail={toggleTrailEnabled}
        triggerRupees={triggerRupees} setTriggerRupees={setTriggerRupees}
        lockRupees={lockRupees} setLockRupees={setLockRupees}
        onSave={() => saveConfig()} saving={saving} peakMtm={peakMtm} lockMtm={lockMtm}
        copyTrade={copyTrade}
        onOpenRisk={() => setActiveModal('risk')}
        onOpenOrders={() => setActiveModal('orderbook')}
        onToggleViewMode={() => setViewMode(v => v === 'cards' ? 'table' : 'cards')}
        viewMode={viewMode}
        workerStatus={workerStatus} onToggleWorker={toggleWorker}
        onExitAll={handleExitAll} confirmExitAll={confirmExitAll} exitingAll={exitingAll}
      />

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
                  const base = group.atmBy === 'Fut' && (futQuotes[u]?.ltp ?? 0) > 0
                    ? futQuotes[u]!.ltp : (spots[u] ?? 0);
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
                          onUpdate={(patch, save) => updateRow(row.id, patch, save)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => armRow(row.id)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' }, true)}
                          onExit={leg => runRowAction(row.id, async () => {
                            const legs = leg === 'ALL' ? legsOf(row) : [leg];
                            for (const l of legs) await placeLeg(row, l, { reduce: true, all: true });
                          })}
                          onAddLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots }))}
                          onReduceLot={(leg, lots) => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots }))}
                          onShift={(leg, dir) => handleShiftStrike(row, leg, dir)}
                          onBlocked={msg => addToast('error', 'Strike locked', msg)}
                        />
                      ))}
                    </div>
                  )
                ) : (
                  <table className="w-full border-collapse text-left">
                    <thead>
                      {/* Section group headers */}
                      <tr className="border-b border-zinc-800">
                        <th colSpan={5} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r border-zinc-700" title="How this row enters: timing, strike, size and side">
                          Configuration
                        </th>
                        <th className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r border-zinc-700" title="Row state and its arm / disarm / exit control">
                          Status
                        </th>
                        <th colSpan={3} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider" title="Open legs and every rule that can close them">
                          Positions &amp; Exits
                        </th>
                      </tr>
                      {/* Column headers */}
                      <tr className="bg-zinc-800/50 border-b border-zinc-800 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                        <th className="p-3" title="Entry time, exit time and the expiry-days filter">Timing</th>
                        <th className="p-3" title="CE and PE strikes, picked by ATM offset or by target premium">CE / PE Strikes</th>
                        <th className="p-3" title="Combined premium, with the CE and PE breakdown">LTP</th>
                        <th className="p-3" title="Lots per leg">Lots</th>
                        <th className="p-3 border-r border-zinc-800" title="Trade the call, the put, or both">Side</th>
                        <th className="p-3 border-r border-zinc-800" title="Where the row stands, and its arm / exit control">Status / Actions</th>
                        <th className="p-3 text-center" title="Call leg: live premium and lot controls">CE</th>
                        <th className="p-3 text-center border-r border-zinc-800" title="Put leg: live premium and lot controls">PE</th>
                        <th className="p-3 text-center" title="Spot, VWAP and stop-loss rules that close this row">Level Exits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => (
                        <FocusTableRow
                          key={row.id} row={row}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          onUpdate={(patch, save) => updateRow(row.id, patch, save)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => armRow(row.id)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' }, true)}
                          onExit={leg => runRowAction(row.id, async () => {
                            // 'ALL' is the row's Exit All button: close every leg
                            // this row trades, sequentially so one rejection is
                            // reported against the leg it belongs to.
                            const legs = leg === 'ALL' ? legsOf(row) : [leg];
                            for (const l of legs) await placeLeg(row, l, { reduce: true, all: true });
                          })}
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
                )}

                <div className="px-4 py-3 bg-zinc-900/40 border-t border-zinc-800 mt-3">
                  <button
                    onClick={() => addRow(u)}
                    title={`Add another straddle / strangle rule for ${u}`}
                    className="flex items-center gap-1.5 text-xs font-extrabold px-3 py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 transition-colors cursor-pointer"
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
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Session Peak P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(peakMtm))}>{fmtInr(peakMtm, true)}</span>
            </div>
          </div>

          <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">Account Budget</h3>
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
                <span className={cn("font-mono font-bold", total + (Number(stopRupees) || 0) < 0 ? "text-rose-400" : "text-zinc-300")}>
                  {stopRupees ? fmtInr(total + Number(stopRupees), true) : '—'}
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
        title="Broker Order Book"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider leading-tight">
              Every order on the account, not only this tool's
            </span>
            <button
              onClick={fetchOrders}
              disabled={ordersLoading}
              className="text-xs font-semibold px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer disabled:opacity-40 transition-all flex items-center gap-1"
            >
              <RefreshCw className={cn("h-3 w-3", ordersLoading && "animate-spin")} />
              Refresh
            </button>
          </div>

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
            <div className="border border-zinc-800 rounded-xl overflow-hidden max-h-[500px] overflow-y-auto">
              <TabTable
                tab="orders"
                data={orders}
                sort={orderSort}
                onSort={key => setOrderSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })}
              />
            </div>
          )}
        </div>
      </FocusModal>
    </div>
  );
}

