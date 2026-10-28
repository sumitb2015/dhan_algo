'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadDefaults, saveDefaults, clearDefaults, resolveDefaults, LADDER_UNDERLYINGS, type LadderDefaults } from '@/lib/priceLadderDefaults';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Rows3, Crosshair, AlertTriangle, ShieldAlert, Trash2, Briefcase, ClipboardList, ReceiptText, ChevronRight, ChevronUp, ChevronDown, Clock, Settings, X, Plus, Info, Table2, Volume2, VolumeX, OctagonX } from 'lucide-react';
import { toast } from 'sonner';
import { MCX_LOT_MULTIPLIER, scaleBrokerPnl } from '@/lib/positionPnl';
import { oiRowsFor, maxOi, type OiStrike } from '@/lib/priceLadderOi';
import NavBar from '@/components/NavBar';
import { sharedJson } from '@/lib/sharedPoll';
import { BrokerPicker, usePageBroker } from '@/components/BrokerPicker';
import { BROKER_LABELS, scalperRoute } from '@/hooks/useBrokerSelector';
import OrdersTradesModal from '@/components/multiLegFocus/OrdersTradesModal';
import { FOCUS_RING } from '@/components/Scalper';
import type { BrokerPortfolio } from '@/app/api/dashboard/portfolio/route';
import { computePivots, pivotChips, PIVOT_FORMULAS } from '@/lib/pivotLevels';
import { LadderGrid, type EntryMark, widgetsFor, pairWidgetsFor, basketWidgetsFor, type LadderWidget } from '@/components/priceLadder/LadderGrid';
import { BasketLegsModal } from '@/components/priceLadder/BasketLegsModal';
import { basketTemplates, daysToExpiry, draftFromTemplate, draftSyn, draftToParam, synSane, SYN_PAUSED_PREFIX, SYN_PAUSED_NOTE, basketNowPnl, basketName, isBasketLive, sumBasketPnl, type DraftLeg, type LadderBasket } from '@/lib/priceLadderBasket';
import { isPairLive, legSlPrice, pairName, pairNowPnl, LEG_KEYS, PAIR_STRIKE_STEP, openPositionCount, sumPairPnl, pairStrikes, pairCentreOffsets, type LadderPair, type PairLeg, type PairLegKey, type PairStructure } from '@/lib/priceLadderPair';
import { LadderOptionChain } from '@/components/priceLadder/LadderOptionChain';
import { StepArrows } from '@/components/priceLadder/StepArrows';
import { guardKey, scopeMtm } from '@/lib/priceLadderGuard';
import { planExitAll, type ExitAllPlan } from '@/lib/priceLadderExitAll';
import { MtmGuardCard } from '@/components/priceLadder/MtmGuardCard';
import { installAlertSoundUnlock, playEntryChime, playExitChime, playWarnChime } from '@/lib/alertSound';
import { chimeFor } from '@/lib/priceLadderChime';
import {
  MAX_LADDER_LOTS, isTradedStrike, paneOf, MCX_LADDER_UNDERLYINGS, DEFAULT_SL_BUFFER_PCT, MIN_SL_BUFFER_PCT, MAX_SL_BUFFER_PCT, stopLimitPrice, isMcxUnderlying, sessionFor, spotKeyUnderlying, istDay, istHhmm, isLive, atmStrikeOf, atmOffsetLabel, limitZone, ownNet, sliceNowPnl, sumSlicePnl, classifyClick,
  type ClickType, type LadderZones, type LadderBroker, type LadderMode, type LadderSide, type LadderSlice, type LadderState, type OptType,
  type LadderContract,
} from '@/lib/priceLadder';

// Price Ladder (/price-ladder). XY mode trades an option on the INDEX's levels (OptionX "Price Ladder XY"): click a
// level to arm an entry, with a bracket target / SL / trailing SL in index points. The dashboard SERVER watches and
// fires them (lib/priceLadderServer.ts), so closing this tab does not disarm anything. Plain mode is a one-click
// LIMIT / SL ladder on the option's own premium. This component only draws and asks; every rule and check is server-side.

/** Index underlyings, then the MCX ones the ladder trades (MCX_LADDER_UNDERLYINGS). */
const UNDERLYINGS: readonly string[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', ...MCX_LADDER_UNDERLYINGS];
/** Accounts the ladder can trade on. Prices always come from Dhan; only orders, positions and order books are per broker. */
const LADDER_BROKERS = ['dhan', 'kotak', 'zerodha'] as const;
/** The server checks a strangle against the same steps (lib/priceLadderPair.ts). */
const STRIKE_STEP = PAIR_STRIKE_STEP;
/** The `strike` state of a futures selection: a sentinel that keeps every "a contract is selected" check truthy. */
const FUT_STRIKE = -1;
/** A contract as shown in labels: `22600CE`, or `FUT` for the futures. */
const tagOf = (strike: number | null, opt: OptType) => (opt === 'FUT' ? 'FUT' : `${strike ?? ''}${opt}`);
const XY_TICKS = [1, 5, 10, 25];
const PLAIN_TICKS = [0.05, 0.5, 1];
/** Pair mode's axis is the combined CE + PE premium. */
const PAIR_TICKS = [0.5, 1, 2, 5];
/** The page's ladder: the two single-option modes, Pair (a straddle / strangle on its combined premium) or Basket (a prebuilt multi-leg strategy on its net premium). */
type PageMode = LadderMode | 'pair' | 'basket';
const MODE_TICK: Record<PageMode, number> = { xy: 5, plain: 1, pair: 1, basket: 1 };
const TICKS_OF: Record<PageMode, readonly number[]> = { xy: XY_TICKS, plain: PLAIN_TICKS, pair: PAIR_TICKS, basket: PAIR_TICKS };
const ROWS = 31;
const POLL_MS = 1000;
/** The one-shot expiry / option-chain loads retry this many times, LOAD_RETRY_MS × attempt apart. */
const LOAD_RETRIES = 4;
const LOAD_RETRY_MS = 4000;

interface SpotView { spot: number; at: number; source: string; fresh: boolean }
interface StateResp {
  state: LadderState; spots: Record<string, SpotView>; ltps: Record<string, number>; liveArmed: boolean; now: number;
  /** The server watcher has not ticked for a while (decided on the server, so the push stream carries the change). */
  watcherQuiet?: boolean;
  /** Where the page's XY axis sits in `spots`: the index name, or for MCX the option month's futures contract. */
  spotKey?: string | null;
  /** Why the selected contract could not be resolved (e.g. no MCX futures month), or null. */
  contractError?: string | null;
  /** Pair mode: why a pair leg could not be resolved, or null. */
  pairError?: string | null;
  /** The selection this reply describes. */
  request?: { underlying: string; expiry: string; strike: number | null; opt: string | null; pairCe?: number | null; pairPe?: number | null; basket?: string };
  /** Basket mode: the legs on screen with their live premiums, and the net premium A (credit = the strategy as defined receives money). */
  basket?: { legs: { strike: number; opt: 'CE' | 'PE'; side: LadderSide; ratio: number; far?: boolean; expiry?: string; securityId: string; ltp: number | null; bid?: number | null; ask?: number | null }[]; a: number | null; credit: boolean | null; lotSize: number; mult: number;
    /** A synthetic future: what its legs can be traded at (null until the bridge has both books), and why the last prices are not trusted. */
    syn?: boolean; market?: { buy: number; sell: number; spread: number } | null; marketStale?: string | null; marketWide?: string | null } | null;
  basketError?: string | null;
  /** Pair mode: the CE / PE legs on screen and their combined premium (null when a leg has no live price). */
  pair?: {
    ce: { strike: number; securityId: string; ltp: number | null }; pe: { strike: number; securityId: string; ltp: number | null };
    combined: number | null; lotSize: number; mult: number;
  } | null;
  contract: {
    securityId: string; lotSize: number; ltp: number | null; mult?: number; refExpiry?: string;
    /** MCX: the futures axis's day high / low / previous close, from its WebSocket quote. */
    axisDay?: { high: number | null; low: number | null; prevClose: number | null } | null;
  } | null;
  /** Key market levels (PDH, PDL, Today High, Today Low) for the active underlying. */
  keyLevels?: {
    pdh: number | null;
    pdl: number | null;
    pdc?: number | null;
    dayHigh: number | null;
    dayLow: number | null;
  } | null;
}
interface IndexQuote { ltp: number; prev_close: number; change_pct: number | null; day_high: number | null; day_low: number | null }

/** How often an XY ladder re-reads the chain for its OI bars. */
const OI_POLL_MS = 30_000;

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key); if (v && (allowed as readonly string[]).includes(v)) return v as T; } catch { /* none */ }
  return fallback;
}
function savePref(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* best effort */ } }

/** A number box that commits on blur / Enter only (dhan-commit-on-blur), so a half-typed value never reaches a rule. */
function NumField({ value, onCommit, min, max, step, label, width = 'w-16', compact }: {
  value: number; onCommit: (v: number) => void; min: number; max?: number; step?: number; label: string; width?: string; compact?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Arrow steps only move the draft; the value is committed once the user stops stepping (or on blur / Enter), so a
  // held key or a run of clicks sends ONE change to a live rule instead of one per step.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  // A step still waiting to commit is dropped with the row: the stale onCommit must not post for a closed leg.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const commit = () => {
    clearTimer();
    if (draft == null) return;
    const n = pending.current ?? Number(draft);
    pending.current = null;
    if (Number.isFinite(n) && n >= min && (max == null || n <= max)) onCommit(n);
    setDraft(null);
  };
  const stepBy = (dir: 1 | -1) => {
    const inc = step ?? 1;
    const cur = pending.current ?? Number(draft ?? value);
    const base = Number.isFinite(cur) ? cur : value;
    const decimals = (v: number) => (String(v).split('.')[1] ?? '').length;
    const dp = Math.max(decimals(inc), decimals(base));
    let n = Number((base + dir * inc).toFixed(dp));
    if (n < min) n = min;
    if (max != null && n > max) n = max;
    pending.current = n;
    setDraft(String(n));
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      const v = pending.current;
      pending.current = null;
      setDraft(null);
      if (v != null && v !== value) onCommit(v);
    }, 500);
  };
  return (
    <div className={`${width} relative inline-flex`}>
      <input
        aria-label={label} inputMode="decimal"
        className={`w-full pl-2 pr-6 ${compact ? 'py-[3px]' : 'py-1'} rounded bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-500`}
        value={draft ?? String(value)}
        onChange={e => { clearTimer(); pending.current = null; setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { clearTimer(); pending.current = null; setDraft(null); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepBy(e.key === 'ArrowUp' ? 1 : -1); }
        }}
      />
      <StepArrows label={label} onStep={stepBy} />
    </div>
  );
}

/** Loud paper-trading marker: SIM orders never reach the broker, so it must be impossible to mistake for REAL. */
function SimBadge({ className = '' }: { className?: string }) {
  return (
    <span role="status" title="SIM mode: paper orders only — nothing is sent to the broker"
      className={`inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-2 py-1 text-xs font-extrabold uppercase tracking-wider text-oncolor-dark ring-2 ring-amber-400/50 animate-pulse ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-oncolor-dark" aria-hidden />SIM · PAPER — NOT REAL
    </span>
  );
}

/** The ladder form's dropdowns: one height (matches the segmented buttons) and one width, so every control's left edge lines up. */
const SELECT_CLS = `h-6 w-36 max-w-full min-w-0 px-2 rounded bg-zinc-900 border border-zinc-700 text-xs text-zinc-100 ${FOCUS_RING}`;

function Seg<T extends string>({ value, options, onChange, labels, disabled, compact }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>>; disabled?: boolean; compact?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden">
      {options.map(o => (
        <button
          key={o} type="button" disabled={disabled} aria-pressed={value === o} onClick={() => onChange(o)}
          className={`px-2.5 ${compact ? 'py-[3px]' : 'py-1'} text-xs font-semibold transition-colors disabled:opacity-50 ${value === o ? 'bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/30' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

const fmtMoney = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const pnlClass = (v: number | null) => (v == null ? 'text-zinc-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400');
const timeOf = (at: number) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

/** One ladder pane. The page can show two side by side: the second keeps its own saved choices (keys end in `-2`), has no
 *  NavBar, and neither auto-focuses a live contract nor chimes (the first pane already does both). The ledger and the
 *  server watcher are shared — every slice carries its own contract, so the panes only differ in what they display. */
const EXIT_BTN = 'flex-1 px-2 py-1 rounded text-xs font-semibold border border-red-500/40 text-red-300 hover:bg-red-500/15 disabled:opacity-40 disabled:cursor-not-allowed';

/** One "Exit 25 / 50 / 75 %" dropdown instead of three more buttons; shares that would exit nothing are disabled, and so is the trigger when none is usable. */
function PartialExit({ disabled, isOff, tip, onPick }: { disabled: boolean; isOff?: (pct: number) => boolean; tip?: string; onPick: (pct: number) => void }) {
  const pcts = [25, 50, 75];
  const none = disabled || pcts.every(p => isOff?.(p));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={none} aria-label="Partial exit" title={none ? 'Nothing to part-exit' : 'Exit a share of the open lots at market'}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold border border-red-500/40 text-red-300 hover:bg-red-500/15 disabled:opacity-40 disabled:cursor-not-allowed">
        Part <ChevronDown className="w-3 h-3" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {pcts.map(p => <DropdownMenuItem key={p} disabled={isOff?.(p)} title={tip} onClick={() => onPick(p)}>Exit {p}%</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The ladder form's starting values, saved in this browser and applied whenever the page loads. */
function DefaultsPanel({ saved, onChange, onReset, onApplyNow }: { saved: LadderDefaults; onChange: (patch: LadderDefaults) => void; onReset: () => void; onApplyNow: () => void }) {
  const d = resolveDefaults(saved);
  const row = 'flex items-center justify-between gap-3';
  const lab = 'text-xs font-medium text-zinc-300';
  return (
    <div className="space-y-2.5 pt-3 border-t border-zinc-800">
      <div>
        <span className="text-xs font-bold text-zinc-200">Ladder defaults</span>
        <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">What a ladder starts with each time this page loads. Saved in this browser; changes apply from the next load, or press Apply now.</p>
      </div>
      <div className={row}><span className={lab}>Ladder mode</span><Seg compact value={d.mode} options={['xy', 'plain', 'pair', 'basket'] as const} labels={{ xy: 'Index', plain: 'Plain', pair: 'Pair', basket: 'Basket' }} onChange={mode => onChange({ mode })} /></div>
      <div className={row}><span className={lab}>Product</span><Seg compact value={d.product} options={['NRML', 'MIS'] as const} onChange={product => onChange({ product })} /></div>
      <div className={row}><span className={lab}>Underlying</span>
        <select aria-label="Default underlying" value={d.underlying} onChange={e => onChange({ underlying: e.target.value })} className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-xs text-zinc-100">
          {LADDER_UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      <div className={row}><span className={lab}>Ladder 1 option</span><Seg compact value={d.opt1} options={['CE', 'PE'] as const} labels={{ CE: 'Call', PE: 'Put' }} onChange={opt1 => onChange({ opt1 })} /></div>
      <div className={row}><span className={lab}>Ladder 2 option</span><Seg compact value={d.opt2} options={['CE', 'PE'] as const} labels={{ CE: 'Call', PE: 'Put' }} onChange={opt2 => onChange({ opt2 })} /></div>
      <div className={row}><span className={lab}>Zones</span><Seg compact value={d.zones} options={['classic', 'anywhere'] as const} labels={{ classic: 'Classic', anywhere: 'Anywhere' }} onChange={zones => onChange({ zones })} /></div>
      <div className={row}><span className={lab}>Order type</span><Seg compact value={d.orderType} options={['LIMIT', 'SL'] as const} labels={{ LIMIT: 'Limit', SL: 'SL' }} onChange={orderType => onChange({ orderType })} /></div>
      <div className={row}><span className={lab}>Style</span><Seg compact value={d.style} options={['Single', 'Bracket', 'Cover'] as const} onChange={style => onChange({ style })} /></div>
      <div className={row}><span className={lab}>Target pts</span><NumField compact label="Default target points" value={d.tgtPts} onCommit={tgtPts => onChange({ tgtPts })} min={1} /></div>
      <div className={row}><span className={lab}>SL pts</span><NumField compact label="Default stop-loss points" value={d.slPts} onCommit={slPts => onChange({ slPts })} min={1} /></div>
      <div className={row}><label className={`${lab} flex items-center gap-1.5`}><input type="checkbox" checked={d.trailOn} onChange={e => onChange({ trailOn: e.target.checked })} /> Trail SL by (pts)</label><NumField compact label="Default trailing points" value={d.trailPts} onCommit={trailPts => onChange({ trailPts })} min={1} /></div>
      <div className={row}><span className={lab} title="Index ladder only: the previous day's Central Pivot Range — TC / P / BC marks, and the rows between BC and TC tinted. Applies at once.">CPR (TC / P / BC)</span><Seg compact value={d.cprOn ? 'on' : 'off'} options={['on', 'off'] as const} labels={{ on: 'On', off: 'Off' }} onChange={v => onChange({ cprOn: v === 'on' })} /></div>
      <div className={row}><span className={lab} title="Index ladder only: the previous day's R1-R4 resistance and S1-S4 support marks. Applies at once.">Pivots (R1-R4 / S1-S4)</span><Seg compact value={d.pivotsOn ? 'on' : 'off'} options={['on', 'off'] as const} labels={{ on: 'On', off: 'Off' }} onChange={v => onChange({ pivotsOn: v === 'on' })} /></div>
      <div className={row}><span className={lab} title="Classic: R1 = 2P-L, R2 = P+range, R3 = P+2 range, R4 = P+3 range. Traditional: R3 = H+2(P-L), R4 = R3+(R2-R1). Camarilla: close ± range x 1.1/12, /6, /4, /2. The CPR is the same in all three.">Pivot formula</span><Seg compact value={d.pivotFormula} options={PIVOT_FORMULAS} labels={{ classic: 'Classic', traditional: 'Traditional (default)', camarilla: 'Camarilla' }} onChange={pivotFormula => onChange({ pivotFormula })} /></div>
      <div className={row}><span className={lab} title="Index ladder only: where the open-interest bars are drawn. Applies at once.">OI bars</span><Seg compact value={d.oiPlace} options={['center', 'edges'] as const} labels={{ center: 'Beside price', edges: 'Outer edges' }} onChange={oiPlace => onChange({ oiPlace })} /></div>
      <div className={row}><span className={lab}>Lots</span><NumField compact label="Default lots" value={d.lots} onCommit={v => onChange({ lots: Math.min(MAX_LADDER_LOTS, Math.max(1, Math.round(v))) })} min={1} max={MAX_LADDER_LOTS} width="w-14" /></div>
      <div className="flex items-center gap-2 pt-1">
        <button type="button" onClick={onApplyNow} className="px-3 py-1 rounded-md border border-zinc-700 text-xs font-semibold text-zinc-200 hover:text-white hover:border-zinc-500">Apply now</button>
        <button type="button" onClick={onReset} className="px-3 py-1 rounded-md border border-zinc-800 text-xs text-zinc-400 hover:text-white">Reset to built-in</button>
      </div>
    </div>
  );
}

/** A page notice with a close button. Hidden until it remounts: the condition clearing and returning, or a new `key` (a changed message), shows it again. */
function Banner({ tone, children }: { tone: 'red' | 'amber'; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const c = tone === 'red' ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-amber-500/30 bg-amber-500/10 text-xs text-amber-300';
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-md border text-xs ${c}`}>
      {children}
      <button type="button" onClick={() => setOpen(false)} aria-label="Dismiss notice" title="Dismiss" className="ml-auto shrink-0 rounded p-0.5 hover:bg-zinc-800/60 focus-visible:outline focus-visible:outline-2">
        <X className="w-3.5 h-3.5" aria-hidden />
      </button>
    </div>
  );
}

export default function PriceLadder({ ladderId = 1, dual = false, onAddLadder, onRemoveLadder, onBrokerChange, peerBroker, onHeaderHeight, headerMinHeight, onRowHeight, rowMinHeight, onTopHeight, topMinHeight, onBannerHeight, bannerMinHeight, collapsed = false, onToggleCollapsed }: {
  ladderId?: 1 | 2; dual?: boolean; onAddLadder?: () => void; onRemoveLadder?: () => void;
  /** Reports this pane's broker; the other pane gets it as `peerBroker`. */
  onBrokerChange?: (b: LadderBroker) => void; peerBroker?: LadderBroker | null;
  /** Side by side: this header's own height is reported, and both headers are held to the taller one so the two ladders start level. */
  onHeaderHeight?: (h: number) => void; headerMinHeight?: number;
  /** The chips + header-buttons row above the title: ladder 1's wraps onto two lines (it carries the NavBar), so both panes are held to the taller one and the titles sit level. */
  onRowHeight?: (h: number) => void; rowMinHeight?: number;
  /** Height of the banners + ladder block above the orders panel; the workspace holds both panes to the taller so the orders panels line up. */
  onTopHeight?: (h: number) => void; topMinHeight?: number;
  /** Same for the banner stack alone, so a notice in one pane ("MCX is closed") cannot push that pane's ladder below the other's. */
  onBannerHeight?: (h: number) => void; bannerMinHeight?: number;
  /** The header's control rows folded away (shared by both panes), leaving the title row. */
  collapsed?: boolean; onToggleCollapsed?: () => void;
}) {
  const second = ladderId === 2;
  const k = useCallback((key: string) => (second ? `${key}-2` : key), [second]);
  const [broker, setBroker, brokerLoaded] = usePageBroker<LadderBroker>(k('price-ladder-broker'), LADDER_BROKERS);
  useEffect(() => { onBrokerChange?.(broker); }, [broker, onBrokerChange]);
  // The broker account chip and the Positions / Order / Trade book buttons are shown once: on ladder 1, and on ladder 2
  // only when it trades a different broker (they describe that broker's account, not the ladder).
  const showAccount = !second || peerBroker == null || peerBroker !== broker;
  const headRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = headRef.current;
    if (!el || !onHeaderHeight) return;
    const ro = new ResizeObserver(() => onHeaderHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeaderHeight]);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !onRowHeight) return;
    // The min-height is on an outer wrapper, so this reads the row's own natural height.
    const ro = new ResizeObserver(() => onRowHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onRowHeight]);
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topRef.current;
    if (!el || !onTopHeight) return;
    // Measure the natural height: the min-height we apply is dropped from the reading by observing the inner wrapper.
    const ro = new ResizeObserver(() => onTopHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onTopHeight]);
  const bannerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bannerRef.current;
    if (!el || !onBannerHeight) return;
    const ro = new ResizeObserver(() => onBannerHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onBannerHeight]);
  const [mode, setModeRaw] = useState<PageMode>('xy');
  // Pair mode: a straddle on the centre strike, or a strangle with its CE `ceOff` strikes above it and its PE `peOff` strikes below it (independent).
  const [structure, setStructure] = useState<PairStructure>('straddle');
  const [ceOff, setCeOff] = useState(2);
  const [peOff, setPeOff] = useState(2);
  // Basket mode: the strategy template, the legs on screen (edited in the pop-up; the side is AS DEFINED by the strategy) and whether
  // the user changed them (an edited draft is never re-built from the template when ATM moves).
  // A synthetic future (NIFTY / BANKNIFTY / SENSEX): a page-only choice, never an `opt`. It rides Basket mode with two fixed legs
  // (long = BUY CE + SELL PE at ATM) and trades on the synthetic price K + CE - PE.
  const [syn, setSyn] = useState(false);
  const [basketKey, setBasketKey] = useState('iron-condor');
  const [basketLegs, setBasketLegs] = useState<DraftLeg[]>([]);
  const [basketEdited, setBasketEdited] = useState(false);
  const [basketModalOpen, setBasketModalOpen] = useState(false);
  // A calendar / diagonal's far expiry (later than `expiry`); rides in the price request on the far legs themselves.
  const [farExpiry, setFarExpiry] = useState('');
  const basketHasFar = basketLegs.some(l => l.far);
  // Until the synthetic's own two legs are built, the legs on screen are the last strategy's: nothing is requested for them.
  const synShaped = basketLegs.length === 2 && basketLegs[0].strike === basketLegs[1].strike && basketLegs[0].opt !== basketLegs[1].opt;
  const basketParam = mode === 'basket' && (!basketHasFar || farExpiry) && (!syn || synShaped) ? draftToParam(basketLegs, farExpiry) : '';
  const synK = syn && synShaped ? basketLegs[0].strike : 0;
  // Pair mode: a leg moving this % against its own fill exits both legs (0 = off).
  const [legSlPct, setLegSlPct] = useState(0);
  const [real, setReal] = useState(false);               // per page load, never persisted
  const [oiOn, setOiOn] = useState(true);                 // XY only: OI bars behind the strike rows; remembered per browser
  const oiShownRef = useRef(false);   // XY mode with the OI bars on: Plain / Pair ladders never build OI rows
  const [oiRows, setOiRows] = useState<{ key: string; rows: OiStrike[]; at: number; staleSince: number | null }>({ key: '', rows: [], at: 0, staleSince: null });   // keyed by underlying|expiry so a switch never shows the old chain's bars
  const [soundOn, setSoundOn] = useState(true);          // trade chimes; remembered per browser
  const [realAck, setRealAck] = useState(false);         // first REAL click this page load asks first
  // A REAL order's first-click confirmation (confirming it lets later clicks this page load straight through), or a
  // `setting` confirmation (its own title and button; it never switches the REAL-order confirmation off).
  const [confirm, setConfirm] = useState<null | { text: string; run: () => void; setting?: { title: string; button: string } }>(null);
  const [armModal, setArmModal] = useState(false);
  // Exit all (every ladder at once). The plan is frozen when the dialog opens, so what is confirmed is what was read; the server
  // rebuilds it under the ledger lock and refuses if anything changed in between.
  const [exitAllSnap, setExitAllSnap] = useState<ExitAllPlan | null>(null);
  const [exitAllCancel, setExitAllCancel] = useState(true);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [dismissedBlock, setDismissedBlock] = useState<string | null>(null);   // the pause reason the user closed; a different reason shows again
  const [savedDefaults, setSavedDefaults] = useState<LadderDefaults>({});
  const [chainOpen, setChainOpen] = useState(false);
  const [underlying, setUnderlyingRaw] = useState<string>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [strikes, setStrikes] = useState<number[]>([]);
  // The spot / futures price the chain was read at: the ATM marker's fallback until the live axis price arrives.
  const [chainSpot, setChainSpot] = useState(0);
  const [strike, setStrike] = useState<number | null>(null);
  // Ladder 1 starts on the ATM call, ladder 2 on the ATM put (the strike defaults to ATM once the chain loads).
  const [opt, setOpt] = useState<OptType>(second ? 'PE' : 'CE');
  // Futures (MCX, Dhan only) are the same selection with opt 'FUT': no strike, so `strike` holds FUT_STRIKE (truthy, never sent as a strike).
  const isFut = opt === 'FUT';
  // Futures trade on Dhan only (the server refuses them elsewhere): leave Future when the account moves off Dhan.
  useEffect(() => { if (opt === 'FUT' && brokerLoaded && broker !== 'dhan') { setOpt('CE'); setStrike(null); setExpiry(''); setExpiries([]); } }, [opt, broker, brokerLoaded]);  // eslint-disable-line react-hooks/set-state-in-effect
  const [product, setProduct] = useState<'NRML' | 'MIS'>('MIS');
  const [orderType, setOrderType] = useState<ClickType>('LIMIT');
  // Classic: fixed limit zones (the other side needs Order Type SL). Anywhere: both columns at every level, the side of
  // the price deciding LIMIT or stop (plain: an SL-limit `slBufferPct` past the trigger).
  const [zones, setZonesRaw] = useState<LadderZones>('classic');
  const setZones = (z: LadderZones) => { setZonesRaw(z); savePref(k('price-ladder-zones'), z); };
  /** The mode's tick: the one last chosen for it (remembered per mode), else its default. */
  const tickFor = useCallback((m: PageMode) => Number(readPref(k(`price-ladder-tick-${m}`), TICKS_OF[m].map(String), String(MODE_TICK[m]))), [k]);
  const chooseTick = (t: number, m: PageMode) => { setTick(t); savePref(k(`price-ladder-tick-${m}`), String(t)); };
  const [slBufferPct, setSlBufferPct] = useState(DEFAULT_SL_BUFFER_PCT);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [style, setStyle] = useState<'Single' | 'Bracket' | 'Cover'>('Bracket');
  const [tgtPts, setTgtPts] = useState(40);
  const [slPts, setSlPts] = useState(30);
  const [trailOn, setTrailOn] = useState(false);
  const [trailPts, setTrailPts] = useState(30);
  const [lots, setLots] = useState(1);
  const [tickRaw, setTick] = useState(5);
  // A future's Plain ladder steps in whole rupees: a saved option-premium tick (0.05) would make 31 rows span ₹1.5.
  const tick = isFut && tickRaw < 1 ? 1 : tickRaw;
  const [center, setCenter] = useState(0);
  const [follow, setFollow] = useState(true);
  // The user scrolled the ladder away: hold the window where they put it until Centre / Follow.
  const [manual, setManual] = useState(false);
  const [data, setData] = useState<StateResp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The last poll could not reach the dashboard server at all (not an error reply): the watcher may be down with it.
  const [unreachable, setUnreachable] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, IndexQuote>>({});
  // An index's change and day range come from top-indices. Its CRUDEOILM row is the FRONT futures month, not the option
  // month's futures on this ladder's axis, so MCX takes them from that axis's own WebSocket quote instead (below).
  const topIndexQ = isMcxUnderlying(underlying) ? null : quotes[underlying] ?? null;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lastEventAt = useRef<number>(0);

  // Preferences (after mount: the first render must match the server HTML).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const savedMode = readPref(k('price-ladder-mode'), ['xy', 'plain', 'pair', 'basket'] as const, 'xy');
    setModeRaw(savedMode);
    // The tick belongs to the mode (setMode sets it on a click): a page reopened into Plain must not keep XY's 5.
    setTick(tickFor(savedMode));
    setZonesRaw(readPref(k('price-ladder-zones'), ['classic', 'anywhere'] as const, 'classic'));
    setEventsOpen(readPref(k('price-ladder-events-open'), ['0', '1'] as const, '0') === '1');
    setSoundOn(readPref(k('price-ladder-sound'), ['0', '1'] as const, '1') === '1');
    setOiOn(readPref(k('price-ladder-oi'), ['0', '1'] as const, '1') === '1');
    setUnderlyingRaw(readPref(k('price-ladder-underlying'), UNDERLYINGS, 'NIFTY'));
    // The user's saved defaults win over the last-used values above, field by field; an unset field keeps its old behaviour.
    const d = loadDefaults();
    setSavedDefaults(d);
    if (d.mode) { setModeRaw(d.mode); setTick(tickFor(d.mode)); }
    if (d.zones) setZonesRaw(d.zones);
    if (d.underlying) setUnderlyingRaw(d.underlying);
    if (d.product) setProduct(d.product);
    if (d.orderType) setOrderType(d.orderType);
    if (d.style) setStyle(d.style);
    if (d.tgtPts != null) setTgtPts(d.tgtPts);
    if (d.slPts != null) setSlPts(d.slPts);
    if (d.trailOn != null) setTrailOn(d.trailOn);
    if (d.trailPts != null) setTrailPts(d.trailPts);
    if (d.lots != null) setLots(d.lots);
    const o = second ? d.opt2 : d.opt1;
    if (o) setOpt(o);
    /* eslint-enable react-hooks/set-state-in-effect */
    return installAlertSoundUnlock();
  }, [k, tickFor, second]);
  // Each mode has its own axis (index / premium / combined premium): drop the old rows until the new price arrives,
  // so a Pair ladder never shows the XY futures levels as if they were combined premiums.
  const setMode = (m: PageMode) => { setModeRaw(m); savePref(k('price-ladder-mode'), m); setTick(tickFor(m)); setCenter(0); setFollow(true); setManual(false); };
  // The pair's strikes: CE = centre + ceOff steps, PE = centre − peOff steps (a straddle: both on the centre). Null when a
  // leg is not in the chain's strike list.
  const pairStep = STRIKE_STEP[underlying] ?? 50;
  const built = mode === 'pair' && strike ? pairStrikes(structure, strike, pairStep, ceOff, peOff) : null;
  const pairCe = built?.ce ?? null;
  const pairPe = built?.pe ?? null;
  const pairOk = pairCe != null && pairPe != null && strikes.includes(pairCe) && strikes.includes(pairPe);
  // The expiry is cleared too: the old underlying's date must not be asked of the new one's chain for a render.
  const setUnderlying = (u: string) => { if (opt === 'FUT' && !isMcxUnderlying(u)) setOpt('CE'); if (syn && isMcxUnderlying(u)) { setSyn(false); setMode('xy'); } setUnderlyingRaw(u); savePref(k('price-ladder-underlying'), u); setExpiry(''); setExpiries([]); setStrike(opt === 'FUT' && isMcxUnderlying(u) ? FUT_STRIKE : null); setCenter(0); setFollow(true); setManual(false); };

  // Option <-> Future: a different expiry list and no strike, so the old selection is dropped until the new list arrives.
  // The Pair / Basket ladders are options-only (two legs / a strategy), so a future falls back to Index.
  const chooseOpt = (o: OptType | 'SYN') => {
    if (o === 'SYN') {
      if (syn) return;
      // The reply is matched on strike + opt like any selection, so a Put or option strike stays selected (a Future's sentinel is dropped).
      setSyn(true); setBasketEdited(false);
      if (isFut) { setOpt('CE'); setStrike(null); setExpiry(''); setExpiries([]); setStrikes([]); }
      setCenter(0); setFollow(true); setManual(false);
      if (mode !== 'basket') setMode('basket');
      return;
    }
    if (syn) { setSyn(false); setBasketEdited(false); setMode('xy'); }
    if ((o === 'FUT') !== isFut) { setExpiry(''); setExpiries([]); setStrikes([]); setCenter(0); setFollow(true); setManual(false); setStrike(o === 'FUT' ? FUT_STRIKE : null); if (o === 'FUT' && (mode === 'pair' || mode === 'basket')) setMode('xy'); }
    setOpt(o);
  };

  // The other pane may have saved defaults since this one loaded: re-read when the dialog opens.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- storage is only readable after mount
  useEffect(() => { if (settingsModalOpen) setSavedDefaults(loadDefaults()); }, [settingsModalOpen]);
  // Saves only what the user touched: an untouched field keeps following the last-used value.
  const changeDefaults = (patch: LadderDefaults) => { const next = { ...savedDefaults, ...patch }; saveDefaults(next); setSavedDefaults(next); };
  const resetDefaults = () => { clearDefaults(); setSavedDefaults({}); };
  /** Puts this ladder on the saved defaults now (the other pane takes them on its next load). */
  const applyDefaultsNow = () => {
    const d = resolveDefaults(savedDefaults);
    setMode(d.mode); setZones(d.zones);
    if (d.underlying !== underlying) setUnderlying(d.underlying);
    setProduct(d.product); setOrderType(d.orderType); setStyle(d.style);
    setTgtPts(d.tgtPts); setSlPts(d.slPts); setTrailOn(d.trailOn); setTrailPts(d.trailPts); setLots(d.lots);
    setOpt(second ? d.opt2 : d.opt1);
  };

  // The indices feed is the XY ladder's spot source. There is no REST fallback: if the feed is down the levels pause (a quote call would feed Dhan's 1/s limit).
  useEffect(() => {
    fetch('/api/live-indices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }).catch(() => {});
  }, []);

  // Expiries -> strikes (the chain gives the strike list and an ATM to start on).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One-shot per underlying. A failure (Dhan rate limit, a slow spawn) is retried a few times, spaced wider than the
    // option-chain limit (~1 call / 3 s), instead of leaving the page on an error until a reload.
    const load = (attempt: number) => {
      fetch(isFut ? `/api/price-ladder/futures?underlying=${underlying}` : `/api/options/expiries?underlying=${underlying}&broker=dhan`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (cancelled) return;
          if (j.success && j.data?.length) { setExpiries(j.data); setExpiry(prev => (j.data!.includes(prev) ? prev : j.data![0])); setLoadError(null); }
          else throw new Error('no expiries');
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < LOAD_RETRIES) timer = setTimeout(() => load(attempt + 1), LOAD_RETRY_MS * (attempt + 1));
          else setLoadError(`Could not load ${underlying} expiries`);
        });
    };
    load(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [underlying, isFut]);

  useEffect(() => {
    if (!expiry || isFut) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (attempt: number) => {
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain?: { oc?: Record<string, { ce?: { last_price?: number }; pe?: { last_price?: number } }> }; spot?: number; future_price?: number } }) => {
        if (cancelled) return;
        const oc = j.data?.chain?.oc;
        if (!j.success || !oc) throw new Error('no chain');
        const list = Object.keys(oc).map(Number).filter(n => n > 0 && isTradedStrike(underlying, n)).sort((a, b) => a - b);
        setStrikes(list);
        if (oiShownRef.current) setOiRows({ key: `${underlying}|${expiry}`, rows: oiRowsFor(oc, n => isTradedStrike(underlying, n)), at: Date.now(), staleSince: null });
        // MCX chains can come back with spot 0 but the option month's futures price set: that is the right ATM base.
        const spot = Number(j.data?.spot) || Number(j.data?.future_price) || 0;
        setChainSpot(spot);
        const step = STRIKE_STEP[underlying] ?? 50;
        setStrike(prev => {
          if (prev != null && list.includes(prev)) return prev;
          if (!list.length) return null;
          // No spot in the reply: the strike where call and put are closest in price (put-call parity's ATM).
          const parity = () => {
            let best: number | null = null, gap = Infinity;
            for (const k of list) {
              const row = oc[String(k)] ?? oc[k.toFixed(6)];
              const ce = Number(row?.ce?.last_price), pe = Number(row?.pe?.last_price);
              // Both legs priced above a token tick: two untraded far strikes at 0.05 / 0.05 are "equal" but not ATM.
              if (ce >= 1 && pe >= 1 && Math.abs(ce - pe) < gap) { gap = Math.abs(ce - pe); best = k; }
            }
            return best;
          };
          const atm = spot > 0 ? Math.round(spot / step) * step : parity() ?? list[Math.floor(list.length / 2)];
          return list.reduce((a, b) => (Math.abs(b - atm) < Math.abs(a - atm) ? b : a));
        });
        setLoadError(null);
      })
      .catch(() => {
        if (cancelled) return;
        // The chain is Dhan's rate-limited REST call (~1 per 3 s, shared with every other tab): back off, then give up.
        if (attempt < LOAD_RETRIES) timer = setTimeout(() => load(attempt + 1), LOAD_RETRY_MS * (attempt + 1));
        else setLoadError(`Could not load the ${underlying} option chain`);
      });
    };
    load(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [underlying, expiry, isFut]);

  // OI changes slowly: re-read the chain every 30 s while the tab is visible, only for an XY ladder showing the bars (and at
  // once when the bars come back after being off for longer). The chain route dedupes and paces the call (Dhan's ~1 per
  // 3 s). One read at a time, newest wins, and a failed read keeps the last bars rather than blanking them.
  useEffect(() => { oiShownRef.current = oiOn && mode === 'xy' && !isFut; }, [oiOn, mode, isFut]);
  const oiAtRef = useRef(0);
  useEffect(() => { oiAtRef.current = oiRows.at; }, [oiRows.at]);
  useEffect(() => {
    if (!oiOn || mode !== 'xy' || !expiry || isFut) return;
    let cancelled = false, inFlight = false;
    const key = `${underlying}|${expiry}`;
    const readOnce = () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=dhan&allowStale=1`, { cache: 'no-store' })
        .then(r => r.json())
        .then((j: { success?: boolean; stale?: boolean; as_of?: number; data?: { chain?: { oc?: Record<string, { ce?: { oi?: number; previous_oi?: number }; pe?: { oi?: number; previous_oi?: number } }> } } }) => {
          const oc = j.data?.chain?.oc;
          // allowStale=1: when Dhan refused a fresh chain the route answers with the last good one, flagged `stale` + `as_of`.
          if (!cancelled && j.success && oc) setOiRows({ key, rows: oiRowsFor(oc, n => isTradedStrike(underlying, n)), at: Date.now(), staleSince: j.stale && j.as_of ? j.as_of : null });
        })
        .catch(() => { /* keep the last bars */ })
        .finally(() => { inFlight = false; });
    };
    if (Date.now() - oiAtRef.current > OI_POLL_MS) readOnce();
    const t = setInterval(readOnce, OI_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [oiOn, mode, underlying, expiry, isFut]);

  // Ladder state + spot + the shown contract's LTP. Pushed by /api/price-ladder/stream (Server-Sent Events) the moment
  // it changes; the 1 s poll below only runs while the stream is not delivering. A view's ledger is applied only if it
  // is not OLDER than the one on screen (state.rev, bumped per write) — a late push or poll must not undo a click.
  const applyView = useCallback((v: StateResp) => {
    setUnreachable(false);
    setData(d => {
      if (!d) return v;
      const older = v.state.date === d.state.date && (v.state.rev ?? 0) < (d.state.rev ?? 0);
      return older ? { ...v, state: d.state, liveArmed: d.liveArmed } : v;
    });
  }, []);
  // Open = the stream is connected (it sends only on change, plus a keepalive comment, so silence is not a failure).
  const streamOpen = useRef(false);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const q = new URLSearchParams({ underlying });
    if (expiry && strike) { q.set('expiry', expiry); q.set('strike', String(strike)); q.set('opt', opt); }
    if (expiry && pairOk) { q.set('pairCe', String(pairCe)); q.set('pairPe', String(pairPe)); }
    if (expiry && basketParam) q.set('basket', basketParam);
    if (expiry && basketParam && synK > 0) q.set('syn', String(synK));
    // Open only while the tab is visible: each open stream holds one of the browser's ~6 connections to this server
    // (HTTP/1.1), shared with every dashboard tab — a hidden ladder must not hold one and queue another tab's orders.
    let es: EventSource | null = null;
    const open = () => {
      if (es || document.hidden) return;
      es = new EventSource(`/api/price-ladder/stream?${q}`);
      es.onmessage = onMsg;
      es.onopen = () => { streamOpen.current = true; };
      // EventSource reconnects on its own; until it does, the poll below takes over.
      es.onerror = () => { streamOpen.current = false; };
    };
    const close = () => { es?.close(); es = null; streamOpen.current = false; };
    const onVis = () => (document.hidden ? close() : open());
    const onMsg = (e: MessageEvent<string>) => {
      try {
        const j = JSON.parse(e.data) as { success: boolean; data?: StateResp; error?: string };
        if (!j.success || !j.data) { setLoadError(j.error ?? 'Could not read the ladder'); return; }
        applyView(j.data);
        setLoadError(null);
      } catch { /* a malformed event: the next one replaces it */ }
    };
    open();
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); close(); };
  }, [underlying, expiry, strike, opt, pairOk, pairCe, pairPe, basketParam, synK, applyView]);

  // Fallback poll: out-of-order replies are dropped, one request per selection at a time (a reply can outlive the 1 s
  // tick, and a new poll every tick would make every reply "out of order").
  const seq = useRef(0);
  const pollInFlight = useRef<string | null>(null);
  const poll = useCallback(async () => {
    if (streamOpen.current) return;
    const key = `${underlying}|${expiry}|${strike}|${opt}|${pairOk ? `${pairCe}/${pairPe}` : ''}|${basketParam}|${synK}`;
    if (pollInFlight.current === key) return;
    pollInFlight.current = key;
    const my = ++seq.current;
    const q = new URLSearchParams({ underlying });
    if (expiry && strike) { q.set('expiry', expiry); q.set('strike', String(strike)); q.set('opt', opt); }
    if (expiry && pairOk) { q.set('pairCe', String(pairCe)); q.set('pairPe', String(pairPe)); }
    if (expiry && basketParam) q.set('basket', basketParam);
    if (expiry && basketParam && synK > 0) q.set('syn', String(synK));
    try {
      const r = await fetch(`/api/price-ladder/state?${q}`, { cache: 'no-store' });
      const j = await r.json() as { success: boolean; data?: StateResp; error?: string };
      if (my !== seq.current) return;
      if (!j.success || !j.data) { setLoadError(j.error ?? 'Could not read the ladder'); return; }
      applyView(j.data);
      setLoadError(null);
    } catch {
      if (my === seq.current) { setLoadError('Could not reach the dashboard server'); setUnreachable(true); }
    } finally {
      if (pollInFlight.current === key) pollInFlight.current = null;
    }
  }, [underlying, expiry, strike, opt, pairOk, pairCe, pairPe, basketParam, synK, applyView]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void poll();
    const t = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // Index card: change and day range.
  useEffect(() => {
    let cancelled = false;
    const load = () => sharedJson<{ quotes?: Record<string, IndexQuote> }>('/api/scalper/top-indices', 2500).then(j => {
      if (!cancelled) setQuotes(j.quotes ?? {});
    }).catch(() => {});
    void load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Whether each broker's saved session is still valid (/api/auth/broker-status, a file check — no broker call). A REAL
  // order on an expired session is refused by the server anyway; this says so up front instead of on the click.
  const [sessions, setSessions] = useState<Partial<Record<LadderBroker, boolean>>>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => sharedJson<Partial<Record<LadderBroker, boolean>>>('/api/auth/broker-status', 30_000)
      .then(j => { if (!cancelled) setSessions(j); }).catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Header account P&L: the shared, server-cached portfolio read (display only — it never sizes an order), every 5 s
  // while the tab is visible. A failed or incomplete read shows '—', never a stale or partial number.
  const [acct, setAcct] = useState<{ pnl: number | null; open: number | null; note: string | null }>({ pnl: null, open: null, note: null });
  // Estimated charges on today's executed orders (Dhan Rs 20 / order, Kotak 0): the Net P&L chip is the account P&L minus these.
  const [charges, setCharges] = useState<{ total: number | null; orders: number; brokerage: number; note: string | null; breakdown: Record<string, number> | null }>({ total: null, orders: 0, brokerage: 0, note: null, breakdown: null });
  const chargesSeq = useRef(0);
  useEffect(() => {
    const my = ++chargesSeq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCharges({ total: null, orders: 0, brokerage: 0, note: null, breakdown: null });
    if (!brokerLoaded) return;
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const j = await sharedJson<{ success?: boolean; charges?: number; orders?: number; brokeragePerOrder?: number; breakdown?: Record<string, number>; error?: string }>(`/api/price-ladder/charges?broker=${broker}`, 10_000);
        if (my !== chargesSeq.current) return;
        if (!j.success || typeof j.charges !== 'number') return setCharges({ total: null, orders: 0, brokerage: 0, note: j.error ?? 'Could not read the trade book', breakdown: null });
        setCharges({ total: j.charges, orders: j.orders ?? 0, brokerage: j.brokeragePerOrder ?? 0, note: null, breakdown: j.breakdown ?? null });
      } catch (e) {
        if (my === chargesSeq.current) setCharges({ total: null, orders: 0, brokerage: 0, note: String((e as Error).message ?? e), breakdown: null });
      }
    };
    void load();
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
  }, [broker, brokerLoaded]);
  const acctSeq = useRef(0);
  useEffect(() => {
    const my = ++acctSeq.current;     // a broker switch drops the previous broker's in-flight reply
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcct({ pnl: null, open: null, note: null });
    if (!brokerLoaded) return;
    const fail = (note: string) => { if (my === acctSeq.current) setAcct({ pnl: null, open: null, note }); };
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const j = await sharedJson<{ success?: boolean; brokers?: BrokerPortfolio[] }>(`/api/dashboard/portfolio?broker=${broker}`, 4000);
        if (my !== acctSeq.current) return;
        const b = j.brokers?.find(x => x.broker === broker);
        if (!j.success || !b) return fail('Could not read the account');
        if (!b.connected) return fail(b.error ?? 'Not connected');
        if (b.error && /positions|ltp-join/.test(b.error)) return fail(b.error);
        if (b.unpricedPositions > 0) {
          return void setAcct({ pnl: null, open: b.openPositions, note: `${b.unpricedPositions} open leg(s) have no live price — total unknown` });
        }
        setAcct({ pnl: b.totalPnl, open: b.openPositions, note: null });
      } catch (e) {
        fail(String((e as Error).message ?? e));
      }
    };
    void load();
    const t = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(t);
  }, [broker, brokerLoaded]);

  // The broker book (positions / orders / trades), fetched only while its window is open. View only on this page:
  // ladder orders are changed from the ladder, so the book never resizes one behind the engine's lot cap.
  type BookTab = 'positions' | 'orders' | 'trades';
  const [bookOpen, setBookOpen] = useState<BookTab | null>(null);
  const [book, setBook] = useState<{ positions: Record<string, unknown>[]; orders: Record<string, unknown>[]; trades: Record<string, unknown>[] }>({ positions: [], orders: [], trades: [] });
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const bookSeq = useRef(0);
  const fetchBook = useCallback(async () => {
    const my = ++bookSeq.current;
    setBookLoading(true);
    try {
      // Kotak sends no LTP: ?ltp=1 prices its open option legs from Dhan's chain (unpriced legs stay 0 = unknown).
      const r = await fetch(`${scalperRoute(broker, 'poll')}${broker === 'kotak' ? '?ltp=1' : ''}`, { cache: 'no-store' });
      const j = await r.json() as { success?: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; positionsError?: string | null; ordersError?: string | null; tradesError?: string | null; error?: string };
      if (my !== bookSeq.current) return;
      if (!j.success) { setBookError(j.error ?? 'Could not read the broker book'); return; }
      // A part that failed keeps its last good rows; the error says so rather than showing an empty book.
      setBook(d => ({
        // Dhan reports MCX P&L per lot, without the barrels-per-lot multiplier (CRUDEOILM x10): rescale it here, as the other terminals do.
        positions: !j.positionsError && Array.isArray(j.positions) ? j.positions.map(p => scaleBrokerPnl(p)) : d.positions,
        orders: !j.ordersError && Array.isArray(j.orders) ? j.orders : d.orders,
        trades: !j.tradesError && Array.isArray(j.trades) ? j.trades : d.trades,
      }));
      const errs = [j.positionsError && `positions: ${j.positionsError}`, j.ordersError && `orders: ${j.ordersError}`, j.tradesError && `trades: ${j.tradesError}`].filter(Boolean);
      setBookError(errs.length ? `${errs.join(' · ')} — showing the last good rows` : null);
    } catch (e) {
      if (my === bookSeq.current) setBookError(String((e as Error).message ?? e));
    } finally {
      if (my === bookSeq.current) setBookLoading(false);
    }
  }, [broker]);
  useEffect(() => {
    ++bookSeq.current;                // a broker switch or close drops any reply still in flight
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBook({ positions: [], orders: [], trades: [] });
    setBookError(null);
    if (!bookOpen || !brokerLoaded) return;
    void fetchBook();
    const t = setInterval(() => { void fetchBook(); }, 5000);
    return () => clearInterval(t);
  }, [bookOpen, brokerLoaded, fetchBook]);

  // Close all / part of a broker position from the positions window. The server re-reads the broker book and sizes the
  // order itself; this only names the position and the share, after asking.
  const closeBrokerPosition = useCallback(async (row: Record<string, unknown>, pct: 25 | 50 | 75 | 100): Promise<{ ok: boolean; text: string }> => {
    const sym = String(row.tradingSymbol ?? row.symbol ?? '');
    const net = Number(row.netQty ?? 0);
    const key = broker === 'dhan' ? String(row.securityId ?? '') : sym;
    const product = String(row.productType ?? '');
    if (!key || !product || !net) return { ok: false, text: 'This row has no open quantity to close' };
    const label = `${BROKER_LABELS[broker]} · ${sym} (${product}, net ${net})`;
    const hedge = net > 0 ? '\n\nThis is a bought position: closing it can raise margin if you still hold shorts.' : '';
    if (!window.confirm(`Close ${pct === 100 ? 'ALL' : `${pct}%`} of ${label} at MARKET now?${hedge}`)) return { ok: false, text: 'Cancelled — nothing was sent' };
    try {
      const r = await fetch('/api/price-ladder/close-position', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker, key, product, pct }),
      });
      const j = await r.json() as { success?: boolean; error?: string; unknown?: boolean; data?: { message?: string } };
      if (j.success) return { ok: true, text: j.data?.message ?? 'Close sent' };
      return { ok: false, text: j.unknown ? `${j.error ?? 'Status unknown'} — check Orders/Positions before retrying` : (j.error ?? 'Close failed') };
    } catch (e) {
      return { ok: false, text: `Status unknown — ${String((e as Error).message ?? e)}. Check Positions before retrying` };
    }
  }, [broker]);

  // Chime on fills and exits (the server writes the event; any open tab hears it).
  useEffect(() => {
    const evs = data?.state.events ?? [];
    if (!evs.length) return;
    const newest = evs[evs.length - 1].at;
    if (lastEventAt.current === 0) { lastEventAt.current = newest; return; }
    const fresh = evs.filter(e => e.at > lastEventAt.current);
    lastEventAt.current = Math.max(lastEventAt.current, newest);
    const chime = !second && soundOn ? chimeFor(fresh.map(e => e.msg)) : null;
    if (chime === 'warn') playWarnChime(); else if (chime === 'exit') playExitChime(); else if (chime === 'entry') playEntryChime();
    for (const e of fresh) if (e.level === 'error') toast.error(e.msg);
  }, [data?.state.events, second, soundOn]);

  const mcx = isMcxUnderlying(underlying);
  // The reply describes the selection on screen (it can lag one poll behind an expiry / strike / underlying switch).
  // Anything tied to the contract — its LTP, lot, and for MCX the futures month on the axis — is read only from a
  // matching reply; until then the ladder shows no price and cannot place.
  const rq = data?.request;
  const matches = !!rq && rq.underlying === underlying && rq.expiry === expiry && rq.strike === strike && rq.opt === opt;
  const shownC = matches ? data?.contract ?? null : null;
  // The pair on screen, from a reply for exactly these two strikes.
  const pairView = mode === 'pair' && pairOk && matches && rq?.pairCe === pairCe && rq?.pairPe === pairPe ? data?.pair ?? null : null;
  const combined = pairView?.combined ?? 0;
  const axisKey = mcx
    ? (matches && data?.spotKey && spotKeyUnderlying(data.spotKey) === underlying ? data.spotKey : null)
    : underlying;
  const spotView = axisKey ? data?.spots[axisKey] : undefined;
  const axisName = mcx ? `${underlying} FUT${shownC?.refExpiry ? ` ${shownC.refExpiry}` : ''}` : underlying;
  // Each error is shown only in the mode it belongs to: a pair leg's in Pair mode, the single contract's in XY / Plain.
  const contractError = matches && mode !== 'pair' ? data?.contractError ?? null : null;
  const pairError = matches && mode === 'pair' ? data?.pairError ?? null : null;
  const sessionNote = sessionFor(underlying, istDay(), data?.state?.settings?.mcxAutoExitTime, data?.state?.settings?.nseAutoExitTime).note ?? null;
  // False only once the status says so (unknown = not blocked; the server still checks every REAL order).
  const sessionDown = sessions[broker] === false;
  const spot = spotView?.spot ?? 0;
  const spotFreshNow = !!spotView?.fresh;
  // ATM from the live axis price (the chain's own spot until it arrives), so every strike reads as its distance from ATM.
  const atmStrike = atmStrikeOf(strikes, spotView?.spot || chainSpot);
  const optLtp = shownC?.ltp ?? 0;
  // ── Basket mode ── the strategy's legs on the listed strikes around ATM, built once per strategy / underlying / expiry
  // (an ATM drift never moves legs the user is looking at, and edited legs are never rebuilt).
  const basketTpl = useMemo(() => basketTemplates().find(t => t.key === basketKey) ?? null, [basketKey]);
  const tplHasFar = !!basketTpl?.legs.some(l => l.expiryRole === 'far');
  // The far expiry follows the near one: the next listed expiry, unless the chosen one is still later than it.
  useEffect(() => {
    if (mode !== 'basket' || !(tplHasFar || basketHasFar)) return;
    const later = expiries.filter(x => x > expiry);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!later.includes(farExpiry)) setFarExpiry(later[0] ?? '');
  }, [mode, tplHasFar, basketHasFar, expiries, expiry, farExpiry]);
  const atmRef = useRef<number | null>(null);
  useEffect(() => { atmRef.current = atmStrike; }, [atmStrike]);
  const buildBasket = useCallback(() => {
    const atm = atmRef.current;
    if (!strikes.length || atm == null) return;
    // The synthetic sits on the ATM strike (long as defined; the server orients it by the side clicked).
    if (syn) { setBasketLegs(draftSyn(atm, 'BUY')); return; }
    if (!basketTpl) return;
    setBasketLegs(draftFromTemplate(basketTpl.legs, atm, STRIKE_STEP[underlying] ?? 50, strikes));
  }, [basketTpl, strikes, underlying, syn]);
  const atmReady = atmStrike != null;
  // A synthetic sits on the ATM strike: when ATM moves its legs are rebuilt on the new one, unless a live synthetic of this
  // broker / mode / underlying / expiry exists (the page then keeps showing the strike that position is on).
  const synLive = syn && (data?.state.baskets ?? []).some(b => b.kind === 'syn' && isBasketLive(b) && b.broker === broker && b.mode === (real ? 'real' : 'sim')
    && b.legs[0].contract.underlying === underlying && b.legs[0].contract.expiry === expiry);
  const synAtm = syn && !synLive ? atmStrike : null;
  useEffect(() => { if (mode === 'basket' && !basketEdited) buildBasket(); }, [mode, basketEdited, buildBasket, atmReady, expiry, synAtm]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBasketEdited(false);
  }, [underlying, expiry]);
  // The synthetic's price moves in whole rupees like a future's, so it uses the Index ladder's steps.
  useEffect(() => { if (syn && !XY_TICKS.includes(tickRaw)) setTick(1); }, [syn, tickRaw]);
  const basketOk = mode === 'basket' && matches && rq?.basket === basketParam;
  const basketView = basketOk ? data?.basket ?? null : null;
  const basketErr = basketOk ? data?.basketError ?? null : null;
  const netA = basketView?.a ?? 0;
  const ax = shownC?.axisDay;
  const indexQ: IndexQuote | null = !mcx ? topIndexQ : ax && spot > 0 ? {
    ltp: spot, prev_close: ax.prevClose ?? 0, day_high: ax.high, day_low: ax.low,
    change_pct: ax.prevClose ? ((spot - ax.prevClose) / ax.prevClose) * 100 : null,
  } : null;
  const lotSize = shownC?.lotSize ?? null;
  const securityId = shownC?.securityId ?? null;
  const refPrice = mode === 'xy' ? spot : mode === 'pair' ? combined : mode === 'basket' ? netA : optLtp;

  // The pointer (or keyboard focus) is on the ladder: its rows hold still, so a price tick cannot re-centre a different
  // level under the mouse between aiming and clicking (seen live: a click armed a breakout three rows from the aim).
  const [held, setHeld] = useState(false);
  // Keep the ladder centred on the reference price while following; re-centre when it walks off the visible window.
  // Held rows only move for a first price (center 0); the re-centre catches up the moment the pointer leaves.
  useEffect(() => {
    if (!(refPrice > 0)) return;
    if (held && center !== 0) return;
    const half = Math.floor(ROWS / 2) * tick;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (follow || center === 0 || (!manual && Math.abs(refPrice - center) > half * 0.8)) setCenter(refPrice);
  }, [refPrice, follow, manual, tick, center, held]);
  // A different contract (strike / CE-PE / expiry, or an Active Trades chip) is a new price axis in plain mode: drop the
  // scroll hold so the walk-off re-centre can bring its price back on screen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManual(false);
  }, [underlying, expiry, strike, opt]);
  const scrollLadder = useCallback((ticks: number) => {
    setFollow(false); setManual(true);
    setCenter(c => {
      const next = Number(((c > 0 ? c : refPrice) + ticks * tick).toFixed(2));
      return next > tick * Math.floor(ROWS / 2) ? next : c;
    });
  }, [refPrice, tick]);

  const slices = useMemo(() => data?.state.slices ?? [], [data?.state.slices]);
  // The position block, its P&L and Exit follow the page's SIM/REAL switch: paper and real slices never net together.
  const pageMode = real ? 'real' : 'sim';
  // Ladder markers follow the SIM/REAL switch too: a paper level must never look like a real one on the ladder.
  const mine = useMemo(() => slices.filter(s => isLive(s) && s.broker === broker && s.mode === pageMode && s.contract.securityId === securityId), [slices, broker, pageMode, securityId]);
  const pairs = useMemo(() => data?.state.pairs ?? [], [data?.state.pairs]);
  const baskets = useMemo(() => data?.state.baskets ?? [], [data?.state.baskets]);
  // Baskets drawn on the ladder: this broker, the page's mode, exactly the contracts on screen (side-blind: it is the same instrument).
  const viewSig = basketView ? basketView.legs.map(l => l.securityId).sort().join(',') : '';
  const sigOf = (b: LadderBasket) => b.legs.map(l => l.contract.securityId).sort().join(',');
  const myBaskets = useMemo(() => (viewSig ? baskets.filter(b => isBasketLive(b) && b.broker === broker && b.mode === pageMode && sigOf(b) === viewSig) : []),
    [baskets, viewSig, broker, pageMode]);
  const basketLocked = myBaskets.length > 0;
  // Pairs drawn on the ladder: this broker, the page's mode, exactly the two legs on screen.
  const myPairs = useMemo(() => (pairView ? pairs.filter(p => isPairLive(p) && p.broker === broker && p.mode === pageMode
    && p.legs.ce.contract.securityId === pairView.ce.securityId && p.legs.pe.contract.securityId === pairView.pe.securityId) : []),
  [pairs, pairView, broker, pageMode]);
  // Where each open position was entered, on the ladder's own axis (index level in XY, fill premium in plain).
  const entryMarks = useMemo(() => {
    const marks: EntryMark[] = [];
    if (mode === 'basket') {
      for (const b of myBaskets) if ((b.state === 'open' || b.state === 'broken' || b.state === 'exiting' || b.state === 'unknown') && b.entryY) marks.push({ y: b.entryY, side: b.side, qty: b.lots * b.legs[0].contract.lotSize, pnl: basketNowPnl(b, data?.ltps ?? {}) });
      return marks;
    }
    if (mode === 'pair') {
      // A pair's entry on the combined axis (the row IS the combined fill, so no separate fill tag).
      for (const p of myPairs) if ((p.state === 'open' || p.state === 'broken' || p.state === 'exiting' || p.state === 'unknown') && p.entryY) marks.push({ y: p.entryY, side: p.side, qty: p.qty, pnl: pairNowPnl(p, data?.ltps ?? {}) });
      return marks;
    }
    for (const s of mine) {
      const held = Number(s.filledQty) || 0;
      if ((s.state !== 'open' && s.state !== 'exiting') || held <= 0) continue;
      const y = mode === 'xy' ? (s.kind === 'xy' ? s.entryY ?? s.entryLevel : s.market ? s.entryY : undefined) : s.avg;
      if (y && Number.isFinite(y)) marks.push({ y, side: s.side, qty: held, avg: s.avg, pnl: sliceNowPnl(s, optLtp) ?? null });
    }
    return marks;
  }, [mine, mode, myPairs, myBaskets, optLtp, data?.ltps]);
  // Previous-day CPR and R1-R4 / S1-S4 for the Index ladder, from the previous session's high / low / close the view carries.
  const pivotPrefs = resolveDefaults(savedDefaults);
  const pivots = useMemo(() => {
    const k = data?.keyLevels;
    return pivotChips(computePivots(k?.pdh ?? 0, k?.pdl ?? 0, k?.pdc ?? 0, pivotPrefs.pivotFormula), { cpr: pivotPrefs.cprOn, pivots: pivotPrefs.pivotsOn });
  }, [data?.keyLevels?.pdh, data?.keyLevels?.pdl, data?.keyLevels?.pdc, pivotPrefs.pivotFormula, pivotPrefs.cprOn, pivotPrefs.pivotsOn]);  // eslint-disable-line react-hooks/exhaustive-deps
  const net = securityId ? ownNet(slices.filter(s => s.broker === broker && s.mode === pageMode), securityId) : { qty: 0, avg: null };
  const contractPnl = useMemo(() => sumSlicePnl(slices, s => s.broker === broker && s.mode === pageMode && s.contract.securityId === securityId, () => optLtp),
    [slices, broker, pageMode, securityId, optLtp]);
  // This ladder's own P&L across every contract it placed, for this broker and the page's SIM/REAL mode (open legs at
  // live LTP). Pairs count too; '—' when any open slice or pair has no price (a partial sum would hide that leg's loss).
  // The same function and scope the server's MTM guard reads, so the chip and the guard can never disagree. Each ladder
  // has its own guard over only the orders it placed, even when both are on one broker.
  const guardScope = useMemo(() => ({ broker, mode: pageMode, pane: ladderId } as const), [broker, pageMode, ladderId]);
  const ladderPnl = useMemo(() => (data ? scopeMtm(data.state, guardScope, data.ltps ?? {}) : null), [data, guardScope]);
  const myGuardKey = guardKey(broker, pageMode, ladderId);

  // Pair mode's Net Pos panel: the pairs on the two legs on screen (this broker and mode). Net is in lots (a short pair is
  // negative), P&L includes the ones closed today, the average is the combined entry premium weighted by lots.
  const pairHere = useMemo(() => (pairView ? pairs.filter(p => p.broker === broker && p.mode === pageMode
    && p.legs.ce.contract.securityId === pairView.ce.securityId && p.legs.pe.contract.securityId === pairView.pe.securityId) : []), [pairs, pairView, broker, pageMode]);
  const pairPnl = useMemo(() => sumPairPnl(pairHere, () => true, data?.ltps ?? {}), [pairHere, data?.ltps]);
  const pairHeldNow = myPairs.filter(p => p.state === 'open' || p.state === 'broken' || p.state === 'rolling' || p.state === 'exiting');
  const pairNetLots = pairHeldNow.reduce((a, p) => a + (p.side === 'SELL' ? -1 : 1) * p.lots, 0);
  const pairLotsHeld = pairHeldNow.reduce((a, p) => a + p.lots, 0);
  const pairAvgEntry = pairLotsHeld > 0
    ? pairHeldNow.reduce((a, p) => a + p.lots * (p.entryY ?? ((p.legs.ce.avg ?? 0) + (p.legs.pe.avg ?? 0))), 0) / pairLotsHeld : null;
  const pairExitable = myPairs.filter(p => (p.state === 'open' || p.state === 'broken' || p.state === 'rolling') && !p.exitWanted);
  const pairOpenLots = myPairs.filter(p => p.state === 'open' && !p.exitWanted).reduce((a, p) => a + p.lots, 0);
  // Basket mode's Net Pos panel: the same numbers for the baskets on the legs on screen.
  const basketHere = useMemo(() => (viewSig ? baskets.filter(b => b.broker === broker && b.mode === pageMode && sigOf(b) === viewSig) : []), [baskets, viewSig, broker, pageMode]);
  const basketPnl = useMemo(() => sumBasketPnl(basketHere, () => true, data?.ltps ?? {}), [basketHere, data?.ltps]);
  const basketHeldNow = myBaskets.filter(b => b.state === 'open' || b.state === 'broken' || b.state === 'exiting');
  const basketNetLots = basketHeldNow.reduce((a, b) => a + (b.side === 'SELL' ? -1 : 1) * b.lots, 0);
  const basketLotsHeld = basketHeldNow.reduce((a, b) => a + b.lots, 0);
  const basketAvgEntry = basketLotsHeld > 0 ? basketHeldNow.reduce((a, b) => a + b.lots * (b.entryY ?? 0), 0) / basketLotsHeld : null;
  const basketExitable = myBaskets.filter(b => (b.state === 'open' || b.state === 'broken') && !b.exitWanted);
  const basketOpenLots = basketExitable.filter(b => b.state === 'open').reduce((a, b) => a + b.lots, 0);

  const liveArmed = !!data?.liveArmed;
  const realBlocked = real && !liveArmed;

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true);
    try {
      const r = await fetch('/api/price-ladder/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})) as { success?: boolean; error?: string; unknown?: boolean; data?: { state?: LadderState } };
      if (j.data?.state) {
        // Newer than any poll still in flight: bump seq so an older GET reply cannot put back what this changed.
        seq.current++;
        const st = j.data.state;
        setData(d => (d && !(st.date === d.state.date && (st.rev ?? 0) < (d.state.rev ?? 0)) ? { ...d, state: st } : d));
      }
      if (j.unknown) { toast.error(`Order status UNKNOWN — check Positions/Orders before doing anything else. ${j.error ?? ''}`); return false; }
      if (!j.success) { toast.error(j.error ?? `Request failed (${r.status})`); return false; }
      return true;
    } catch {
      toast.error('No reply from the server — the request may or may not have gone through. Check the orders list.');
      return false;
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, []);

  // `expect` = the verdict the user saw / confirmed: the server refuses rather than place a different kind of order if
  // the price crossed the level in between.
  const send = useCallback((side: LadderSide, price: number, expect: { kind: 'limit' | 'stop'; dir: 'above' | 'below' }) => {
    if (!expiry || !strike) return;
    void post({
      action: 'arm', kind: mode, broker, mode: real ? 'real' : 'sim', underlying, expiry, strike, opt, side, lots, product,
      orderType, level: price, zones, expect, ...(zones === 'anywhere' && mode === 'plain' ? { slBufferPct } : {}), ...(second ? { pane: 2 } : {}),
      // Cover = SL only (tgtPts 0), as OptionX's Cover order; Bracket = target + SL.
      // Single + trail = a trailing stop on its own: SL only, starting at the trail distance.
      ...(mode === 'xy' && style !== 'Single' ? { bracket: { tgtPts: style === 'Cover' ? 0 : tgtPts, slPts, ...(trailOn ? { trailPts } : {}) } }
        : mode === 'xy' && trailOn ? { bracket: { tgtPts: 0, slPts: trailPts, trailPts } } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${mode === 'xy' ? 'armed at' : 'placed at'} ${price}`); });
  }, [post, mode, broker, real, underlying, expiry, strike, opt, lots, product, orderType, zones, slBufferPct, style, tgtPts, slPts, trailOn, trailPts, second]);

  // Buy / Sell Market buttons: the selected contract at market now (single option; the server applies every arm check).
  const sendMarket = useCallback((side: LadderSide) => {
    if (!expiry || !strike) return;
    const what = `${side} ${lots} lot(s) ${underlying} ${tagOf(strike, opt)} at MARKET now`;
    // Like every REAL ladder click, the first one this page load asks first.
    const run = () => void post({
      action: 'market', broker, mode: real ? 'real' : 'sim', underlying, expiry, strike, opt, side, lots, product, ...(second ? { pane: 2 } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${lots} lot(s) ${underlying} ${tagOf(strike, opt)} sent at MARKET`); });
    if (real && !realAck) setConfirm({ text: what, run }); else run();
  }, [post, broker, real, realAck, underlying, expiry, strike, opt, lots, product, second]);

  // Pair mode Buy / Sell Market: both legs at market now, no level and no bracket (exit from the pair widget or the MTM guard).
  const sendPairMarket = useCallback((side: LadderSide) => {
    if (!expiry || !pairOk) return;
    const name = structure === 'straddle' ? `${pairCe} straddle` : `${pairCe}CE / ${pairPe}PE strangle`;
    const run = () => void post({
      action: 'pair', op: 'market', broker, mode: real ? 'real' : 'sim', underlying, expiry, structure, ceStrike: pairCe, peStrike: pairPe,
      side, lots, product, ...(second ? { pane: 2 } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${lots} lot(s) ${underlying} ${name} sent at MARKET`); });
    if (real && !realAck) setConfirm({ text: `${side} ${lots} lot(s) ${underlying} ${name} — BOTH legs at MARKET now. If only one leg fills, it is closed again at market`, run }); else run();
  }, [post, broker, real, realAck, underlying, expiry, structure, pairOk, pairCe, pairPe, lots, product, second]);

  // Pair mode: the entry is on the combined premium (Buy below / Sell above = limit-like; the other side a breakout).
  const sendPair = useCallback((side: LadderSide, price: number, expect: { kind: 'limit' | 'stop'; dir: 'above' | 'below' }) => {
    if (!expiry || !pairOk) return;
    void post({
      action: 'pair', op: 'arm', broker, mode: real ? 'real' : 'sim', underlying, expiry, structure, ceStrike: pairCe, peStrike: pairPe,
      side, lots, product, orderType, level: price, zones, expect, ...(legSlPct > 0 ? { legSlPct } : {}), ...(second ? { pane: 2 } : {}),
      ...(style !== 'Single' ? { bracket: { tgtPts: style === 'Cover' ? 0 : tgtPts, slPts, ...(trailOn ? { trailPts } : {}) } }
        : trailOn ? { bracket: { tgtPts: 0, slPts: trailPts, trailPts } } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${structure} armed at combined ${price}`); });
  }, [post, broker, real, underlying, expiry, structure, pairOk, pairCe, pairPe, lots, product, orderType, zones, legSlPct, style, tgtPts, slPts, trailOn, trailPts, second]);

  // Basket mode (SIM only for now: the server refuses a REAL basket, and the page says so before asking).
  const basketPayload = { strategy: basketKey, name: basketTpl?.name ?? 'Basket', legs: basketLegs, ...(syn ? { kind: 'syn' as const, synStrike: synK } : {}), underlying, expiry, ...(basketHasFar ? { farExpiry } : {}), broker, product, lots, mode: (real ? 'real' : 'sim') as 'real' | 'sim' };
  const sendBasket = useCallback((side: LadderSide, price: number, expect: { kind: 'limit' | 'stop'; dir: 'above' | 'below' }) => {
    if (!expiry || !basketView?.a) return;
    void post({
      action: 'basket', op: 'arm', ...basketPayload, side, orderType, level: price, zones, expect, ...(second ? { pane: 2 } : {}),
      ...(style !== 'Single' ? { bracket: { tgtPts: style === 'Cover' ? 0 : tgtPts, slPts, ...(trailOn ? { trailPts } : {}) } }
        : trailOn ? { bracket: { tgtPts: 0, slPts: trailPts, trailPts } } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${basketTpl?.name ?? 'basket'} armed at net ${price}`); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post, basketKey, basketTpl, basketLegs, syn, synK, basketHasFar, farExpiry, underlying, expiry, broker, real, product, lots, orderType, zones, style, tgtPts, slPts, trailOn, trailPts, second, basketView?.a]);
  const sendBasketMarket = (side: LadderSide) => {
    if (!expiry || !basketView?.a) return;
    const run = () => void post({ action: 'basket', op: 'market', ...basketPayload, side, ...(second ? { pane: 2 } : {}) })
      .then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${lots} lot(s) ${basketTpl?.name ?? 'basket'} sent at MARKET`); });
    if (real && !realAck) {
      setConfirm({ text: `${side} ${lots} lot(s) ${underlying} ${basketTpl?.name ?? 'basket'} (${basketLegs.length} legs) at MARKET now — the BUY legs first, the SELL legs only after they fill. If a leg fails, what filled is closed again at market`, run });
      return;
    }
    run();
  };

  const onPlace = (side: LadderSide, price: number) => {
    if (mode === 'basket') {
      const v = classifyClick({ mode: 'plain', opt: 'CE', side, level: price, ref: refPrice, orderType, zones });
      if (!v.ok) { toast.warning(v.error); return; }
      if (real && !realAck) {
        setConfirm({
          text: `${side} ${lots} lot(s) ${underlying} ${basketTpl?.name ?? 'basket'} (${basketLegs.length} legs) when the net premium ${v.dir === 'below' ? 'falls to' : 'rises to'} ${price} — the BUY legs at MARKET first, the SELL legs only after they fill. If a leg fails, what filled is closed again at market`,
          run: () => sendBasket(side, price, { kind: v.kind, dir: v.dir }),
        });
        return;
      }
      sendBasket(side, price, { kind: v.kind, dir: v.dir });
      return;
    }
    if (mode === 'pair') {
      const v = classifyClick({ mode: 'plain', opt: 'CE', side, level: price, ref: refPrice, orderType, zones });
      if (!v.ok) { toast.warning(v.error); return; }
      if (real && !realAck) {
        const name = structure === 'straddle' ? `${pairCe} straddle` : `${pairCe}CE / ${pairPe}PE strangle`;
        setConfirm({
          text: `${side} ${lots} lot(s) ${underlying} ${name} — BOTH legs at MARKET when the combined premium ${v.dir === 'below' ? 'falls to' : 'rises to'} ${price}. If only one leg fills, it is closed again at market`,
          run: () => sendPair(side, price, { kind: v.kind, dir: v.dir }),
        });
        return;
      }
      sendPair(side, price, { kind: v.kind, dir: v.dir });
      return;
    }
    // Same verdict the server applies, shown before the click costs a round trip.
    const v = classifyClick({ mode, opt, side, level: price, ref: refPrice, orderType, zones });
    if (!v.ok) { toast.warning(v.error); return; }
    if (real && !realAck) {
      // The server computes the SL-limit's limit from the same buffer; this preview uses the same function.
      const lim = mode === 'plain' && v.kind === 'stop' && zones === 'anywhere' ? stopLimitPrice(side, price, slBufferPct) : null;
      const what = mode === 'xy'
        ? `${side} ${lots} lot(s) ${underlying} ${tagOf(strike, opt)} at MARKET when ${axisName} ${v.dir === 'below' ? 'falls to' : 'rises to'} ${price}`
        : lim
          ? `SL-limit ${side} ${lots} lot(s) ${underlying} ${tagOf(strike, opt)}: trigger ${price.toFixed(2)}, limit ${lim.toFixed(2)}`
          : `${v.kind === 'limit' ? 'LIMIT' : 'SL'} ${side} ${lots} lot(s) ${underlying} ${tagOf(strike, opt)} at ${price}`;
      setConfirm({ text: what, run: () => send(side, price, { kind: v.kind, dir: v.dir }) });
      return;
    }
    send(side, price, { kind: v.kind, dir: v.dir });
  };

  // Shift a pair (both legs) or roll one leg N strikes: the old leg closes in full first, then the new strike opens at
  // MARKET — opening orders, so a REAL pair asks first (every time: a roll is two trades, never a one-click habit).
  const onRoll = (p: LadderPair, legs: 'both' | 'ce' | 'pe', steps: number) => {
    const step = STRIKE_STEP[p.legs.ce.contract.underlying] ?? 50;
    const moving = legs === 'both' ? (['ce', 'pe'] as const) : [legs];
    const to = moving.map(k => `${p.legs[k].contract.strike}${k.toUpperCase()} → ${p.legs[k].contract.strike + steps * step}${k.toUpperCase()}`).join(', ');
    const run = () => void post({ action: 'pair', op: 'roll', id: p.id, legs, steps }).then(ok => { if (ok) toast.success(`Rolling ${to}`); });
    if (p.mode === 'real') {
      setConfirm({ text: `${legs === 'both' ? 'Shift' : `Roll the ${legs.toUpperCase()} leg of`} the ${pairName(p)} ${steps > 0 ? 'up' : 'down'} ${Math.abs(steps)} strike(s): ${to}. The old leg is closed at MARKET first, then the new one opened at MARKET (if it fails, the whole pair is closed)`, run });
      return;
    }
    run();
  };

  // The MCX / NSE cutoffs (MIS square-off / "only exits" time). A time already passed would square off open MIS positions
  // at once: the server refuses that without confirmPast, and the page asks first, naming what it would do.
  const setCutoff = (market: 'mcx' | 'nse', time: string) => {
    const label = market === 'mcx' ? 'MCX' : 'NSE';
    const field = market === 'mcx' ? 'mcxAutoExitTime' : 'nseAutoExitTime';
    const send = async (confirmPast: boolean) => {
      try {
        const r = await fetch('/api/price-ladder/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', [field]: time, confirmPast }) });
        const j = await r.json().catch(() => ({})) as { success?: boolean; error?: string; needsConfirm?: boolean; data?: { state?: LadderState } };
        if (j.needsConfirm && !confirmPast) {
          setConfirm({ text: j.error ?? `Set the ${label} cutoff to ${time}?`, run: () => { void send(true); }, setting: { title: `Set the ${label} cutoff to ${time}?`, button: 'Set cutoff and square off' } });
          return;
        }
        if (!j.success) { toast.error(j.error ?? `Could not set the cutoff (${r.status})`); return; }
        if (j.data?.state) { seq.current++; const st = j.data.state; setData(d => (d ? { ...d, state: st } : d)); }
        toast.success(`${label} cutoff set to ${time} IST`);
      } catch {
        toast.error('No reply from the server — check the cutoff before trading');
      }
    };
    void send(false);
  };

  // Drag-to-modify (OptionX): an armed entry moves its level; an open bracket moves its target or SL. The server re-checks
  // every rule (a LIMIT entry cannot be dragged across spot into a breakout; target/SL must stay on their side of spot).
  const onMove = (ids: string[], what: 'entry' | 'tgt' | 'sl', price: number) => {
    const done = (ok: boolean) => { if (ok) toast.success(`${what === 'entry' ? 'Entry' : what === 'tgt' ? 'Target' : 'SL'} moved to ${price}`); };
    if (mode === 'basket') {
      void post({ action: 'basket', op: 'modify', id: ids[0], ...(what === 'entry' ? { level: price } : what === 'tgt' ? { tgtY: price } : { slY: price }) }).then(done);
      return;
    }
    if (mode === 'pair') {
      void post({ action: 'pair', op: 'modify', id: ids[0], ...(what === 'entry' ? { level: price } : what === 'tgt' ? { tgtY: price } : { slY: price }) }).then(done);
      return;
    }
    void post({ action: 'modify', id: ids[0], ...(what === 'entry' ? { level: price } : { ids, ...(what === 'tgt' ? { tgtY: price } : { slY: price }) }) })
      .then(ok => { if (ok) toast.success(`${what === 'entry' ? 'Entry' : what === 'tgt' ? 'Target' : 'SL'} moved to ${price}`); });
  };

  // The + / − on a ladder widget. An unfilled order changes its lots in place (− stops at 1 lot: × cancels). An open
  // position: − exits one lot at market (never confirmed — it only reduces), + adds one lot at market under the same
  // target / SL — an opening order, so on REAL the first one this page load asks first, like a ladder click.
  const onAdjust = (w: LadderWidget, delta: 1 | -1, pair = mode === 'pair') => {
    if (mode === 'basket') { toast.info('Use the 25 / 50 / 75 / Exit buttons to change a basket\'s lots'); return; }
    if (pair) {
      if (w.adjust !== 'position') return;
      // − exits one lot of both legs (only reduces: never confirmed); + adds one to both at market — an opening order,
      // so the first REAL one this page load asks first.
      if (delta < 0) { void post({ action: 'pair', op: 'reduce', id: w.ids[0] }).then(ok => { if (ok) toast.success('Exiting 1 lot of both legs'); }); return; }
      const addOne = () => void post({ action: 'pair', op: 'add', id: w.ids[0] }).then(ok => { if (ok) toast.success('Adding 1 lot to both legs at market'); });
      // The pair's own mode decides (the table can show a REAL pair while the page is on SIM).
      const target = pairs.find(x => x.id === w.ids[0]);
      if ((target?.mode === 'real' || (!target && real)) && !realAck) {
        setConfirm({ text: `Add 1 lot to BOTH legs of this pair at MARKET (it joins the same target / SL; if only one leg fills, it is closed again)`, run: addOne });
        return;
      }
      addOne();
      return;
    }
    if (w.adjust === 'order') {
      const lots = w.lots + delta;
      if (lots < 1) { toast.info('One lot is the minimum — use × to cancel'); return; }
      if (lots > MAX_LADDER_LOTS) { toast.warning(`${MAX_LADDER_LOTS} lots is the cap`); return; }
      void post({ action: 'lots', id: w.ids[0], lots });
      return;
    }
    if (w.adjust !== 'position') return;
    if (delta < 0) {
      void post({ action: 'exit', ids: w.ids, lots: 1 }).then(ok => { if (ok) toast.success('Exiting 1 lot'); });
      return;
    }
    const addOne = () => void post({ action: 'add', id: w.ids[0] }).then(ok => { if (ok) toast.success('Adding 1 lot at market'); });
    if (real && !realAck) {
      setConfirm({ text: `Add 1 lot to the ${underlying} ${tagOf(strike, opt)} position at MARKET (it joins the same target / SL)`, run: addOne });
      return;
    }
    addOne();
  };
  // Armed (not yet fired) levels on what the ladder shows: its option, or the pairs / baskets on the legs on screen.
  const armedPairIds = myPairs.filter(p => p.state === 'armed').map(p => p.id);
  const armedBasketIds = myBaskets.filter(b => b.state === 'armed').map(b => b.id);
  const pendingHere = mode === 'pair' ? armedPairIds.length : mode === 'basket' ? armedBasketIds.length : mine.filter(s => (s.state === 'armed' || s.state === 'working') && s.mode === pageMode).length;

  // A price that has not moved is only a problem while the market is trading: outside the session there are no live
  // prices, so the stale warning is not shown (the server still refuses to arm without a fresh price).
  // The server's own clock (its last reply), so render stays pure; before the first reply there is nothing to warn about.
  const sess = sessionFor(underlying, istDay(data?.now), data?.state?.settings?.mcxAutoExitTime, data?.state?.settings?.nseAutoExitTime);
  const hhmmNow = data ? istHhmm(data.now) : 0;
  const inSession = !!data && sess.open < sess.close && hhmmNow >= sess.open && hhmmNow < sess.close;
  const stale = mode === 'xy' && !spotFreshNow;
  // Something live in the ledger, and the server that runs it has gone quiet (no reply, or its watcher tick is overdue).
  const anyLive = !!data && (data.state.slices.some(x => isLive(x) && x.state !== 'unknown') || (data.state.pairs ?? []).some(isPairLive) || (data.state.baskets ?? []).some(isBasketLive));
  const notTracking = anyLive && (unreachable || !!data?.watcherQuiet);
  const placeDisabled = busy || !brokerLoaded || !strike || !(refPrice > 0) || realBlocked || (real && sessionDown) || (mode === 'xy' && stale)
    || (mode === 'pair' && !pairView) || (mode === 'basket' && !basketView?.a);
  // Why a click on the ladder would do nothing, in the order the checks run; shown as a chip so a blocked cursor is never unexplained.
  const placeBlockReason = !placeDisabled || busy ? null
    : !brokerLoaded ? 'loading the broker account'
    : realBlocked || (real && sessionDown) ? null   // each already has its own banner above
    : !strike || !(refPrice > 0) ? (mode === 'xy' ? `waiting for the ${mcx ? 'futures' : 'index'} price and the option chain` : 'waiting for the option chain and live premiums')
    : mode === 'xy' && stale ? (inSession ? null : `${axisName} ${mcx ? 'price' : 'spot'} is not updating (market closed?); levels are paused until it moves`)
    : mode === 'pair' && !pairView ? 'waiting for both legs of the pair'
    : mode === 'basket' && !basketView?.a ? 'waiting for a live price on every basket leg'
    : null;
  const decimals = mode === 'xy' || isFut || syn ? (tick < 1 ? 2 : 0) : 2;
  // A future's price moves in whole rupees (tick 1), so its Plain ladder uses the Index ladder's steps, not the option premium's.
  const ticks = mode === 'xy' || isFut || syn ? XY_TICKS : mode === 'pair' || mode === 'basket' ? PAIR_TICKS : PLAIN_TICKS;
  const HELP_TEXT = syn
                ? `Synthetic future: the ladder is the synthetic price ${synK || 'K'} + CE − PE (ATM call against put). Buy = long (BUY CE + SELL PE), Sell = short (SELL CE + BUY PE); a long gains as the price rises. Buy below it / Sell above it = limit-like entry; the other side ${zones === 'anywhere' ? 'is a breakout (BO)' : 'needs Order Type SL (breakout)'}. Both legs fill when it crosses the level (REAL: the BOUGHT leg first, the SOLD leg once it filled; a failed leg closes what filled); target / SL / trail are synthetic-price points and exit both legs (REAL: the sold leg is covered first). Levels pause while either leg's price is stale or the synthetic strays more than 1.5% from the index.`
                : mode === 'basket'
                ? `Basket: the ladder is the strategy's NET premium (${basketView?.credit ? 'a credit: Sell = collect it' : basketView?.credit === false ? 'a debit: Buy = pay it' : 'credit or debit'}). Sell above it / Buy below it = limit-like entry; the other side ${zones === 'anywhere' ? 'is a breakout (BO)' : 'needs Order Type SL (breakout)'}. The legs are as the strategy defines them when your direction matches (Sell a credit / Buy a debit), every leg mirrored otherwise. When the net crosses the level the legs fill together (REAL: the BUY legs first, the SELL legs once they filled; a failed leg closes what filled); target / SL / trail are net-premium points and exit every leg (REAL: shorts covered first).`
                : mode === 'pair'
                ? `Pair: the ladder is the combined premium (CE + PE). Sell above it / Buy below it = limit-like entry; the other side ${zones === 'anywhere' ? 'is a breakout (BO)' : 'needs Order Type SL (breakout)'}. Both legs go at MARKET together when the combined crosses the level (REAL: if only one fills, it is closed again); target / SL / trail are in combined-premium points and exit both legs.`
                : mode === 'xy'
                ? `Click the Buy or Sell column at an index level. ${opt === 'PE' ? 'Put: the ladder is inverted — a Buy is a limit ABOVE spot. ' : ''}Limit = the option is cheaper/dearer at that level; the other side ${zones === 'anywhere' ? 'is a breakout by itself (Anywhere)' : 'needs SL (breakout)'}. The option order goes at MARKET when ${axisName} crosses the level.`
                : zones === 'anywhere'
                  ? `Anywhere: Buy below LTP / Sell above it = LIMIT; Sell below / Buy above = SL-limit, its limit ${slBufferPct}% past the trigger. Orders rest at the broker.`
                  : 'Click Buy below LTP or Sell above it for a LIMIT; the other side places an SL-M stop (Order Type SL). Orders rest at the broker.';
  const dataDate = data ? data.state.date : null;
  const optLabel = syn
    ? `${underlying} ${expiry} ${synK ? `${synK} ` : ''}Synthetic Future`
    : mode === 'basket'
    ? `${underlying} ${expiry}${basketHasFar && farExpiry ? ` / ${farExpiry}` : ''} ${basketTpl?.name ?? 'Basket'}${basketEdited ? ' (edited)' : ''}`
    : mode === 'pair'
    ? (pairOk ? `${underlying} ${expiry} ${structure === 'straddle' ? `${pairCe} straddle` : `${pairCe}CE / ${pairPe}PE strangle`}` : `${underlying} — pair strikes not in the chain`)
    : strike ? `${underlying} ${expiry} ${isFut ? 'FUT' : `${strike} ${opt}`}` : `${underlying} —`;
  // With two ladders open each lists only the orders it placed (ladder 1 also every order from before panes); one
  // ladder lists everything, so closing ladder 2 never hides its positions.
  const inPane = useCallback((x: { pane?: number }) => !dual || paneOf(x) === ladderId, [dual, ladderId]);
  const paneSlices = useMemo(() => slices.filter(inPane), [slices, inPane]);
  const panePairs = useMemo(() => pairs.filter(inPane), [pairs, inPane]);
  const paneBaskets = useMemo(() => baskets.filter(inPane), [baskets, inPane]);
  // The ladder draws only the page's own mode (SIM or REAL), and the page always opens in SIM (REAL is never remembered), so after
  // a reload REAL positions are live at the broker but not on the ladder: count them so the page can say so.
  const hiddenReal = useMemo(() => (real ? 0
    : paneSlices.filter(x => isLive(x) && x.broker === broker && x.mode === 'real').length
      + panePairs.filter(x => isPairLive(x) && x.broker === broker && x.mode === 'real').length
      + paneBaskets.filter(x => isBasketLive(x) && x.broker === broker && x.mode === 'real').length),
  [real, paneSlices, panePairs, paneBaskets, broker]);
  const paneEvents = useMemo(() => {
    const evs = data?.state.events ?? [];
    if (!dual) return evs;
    const ids = new Set([...paneSlices.map(x => x.id), ...panePairs.map(p => p.id), ...paneBaskets.map(b => b.id)]);
    return evs.filter(e => (e.sliceId ? ids.has(e.sliceId) : ladderId === 1));
  }, [data?.state.events, dual, ladderId, paneSlices, panePairs, paneBaskets]);
  const live = paneSlices.filter(isLive);
  const latestEvent = paneEvents.length ? paneEvents[paneEvents.length - 1] : null;
  // Live orders on the contract on screen that the ladder does not draw (the other SIM/REAL mode, or another broker).
  // Pair mode: live pairs on these same two legs that the ladder does not draw (another broker or SIM/REAL).
  const hiddenPairs = mode === 'pair' && pairView ? pairs.filter(p => isPairLive(p)
    && p.legs.ce.contract.securityId === pairView.ce.securityId && p.legs.pe.contract.securityId === pairView.pe.securityId
    && (p.broker !== broker || p.mode !== pageMode)) : [];
  const done = paneSlices.filter(s => !isLive(s));
  // Live pairs / baskets of this ladder that the ladder is NOT drawing (other strikes / legs): the table lists them, so the page
  // says why they have no marker and offers to put them on the ladder. (The same legs on another broker / mode have their own banner.)
  const offPairs = panePairs.filter(p => isPairLive(p) && !myPairs.some(y => y.id === p.id) && !hiddenPairs.some(h => h.id === p.id));
  const offBaskets = paneBaskets.filter(b => isBasketLive(b) && !myBaskets.some(y => y.id === b.id));
  // Positions held (not armed levels): a contract + side group with filled lots, and a pair that has a leg on.
  const openPositions = openPositionCount(paneSlices, panePairs, paneBaskets);
  // Everything every ladder holds, for the header's Exit all (the ledger the page holds is the whole file, both panes and every broker).
  const exitAllPlan = useMemo(() => (data ? planExitAll(data.state) : null), [data]);

  // Switch the page to a slice's contract (Active Trades chip, orders list). Moving into REAL re-arms the first-click
  // confirmation, exactly like the SIM/REAL switch.
  const selectContract = useCallback((s: { contract: LadderContract; broker?: LadderBroker; mode?: 'real' | 'sim' }) => {
    // Another underlying is another price axis: drop the old rows until its price arrives.
    if (s.contract.underlying && s.contract.underlying !== underlying) setCenter(0);
    if (s.contract.underlying) setUnderlyingRaw(s.contract.underlying);
    if (s.contract.expiry) setExpiry(s.contract.expiry);
    if (s.contract.opt === 'FUT') setStrike(FUT_STRIKE); else if (s.contract.strike) setStrike(s.contract.strike);
    if (s.contract.opt) setOpt(s.contract.opt);
    if (s.broker) setBroker(s.broker);
    if (s.mode) { setReal(s.mode === 'real'); setRealAck(false); }
  }, [setBroker, underlying]);

  // Show a pair on the ladder: Pair mode on its underlying / expiry, centre strike and offsets.
  const selectPair = useCallback((p: LadderPair) => {
    const c = p.legs.ce.contract, pc = p.legs.pe.contract;
    if (c.underlying !== underlying) setCenter(0);
    setUnderlyingRaw(c.underlying);
    setExpiry(c.expiry);
    setModeRaw('pair'); setTick(tickFor('pair'));
    setStructure(p.structure);
    const step = STRIKE_STEP[c.underlying] ?? 50;
    const o = pairCentreOffsets(c.strike, pc.strike, step);
    setStrike(o.centre); setCeOff(o.ceOff); setPeOff(o.peOff);
    setBroker(p.broker);
    setReal(p.mode === 'real'); setRealAck(false);
  }, [setBroker, underlying, tickFor]);

  // Show a basket on the ladder: Basket mode on its underlying / expiry with its own legs (side-blind: the same contracts draw the same
  // net premium, whichever direction it was traded).
  const selectBasket = useCallback((b: LadderBasket) => {
    const c = b.legs[0].contract;
    if (c.underlying !== underlying) setCenter(0);
    setUnderlyingRaw(c.underlying);
    setExpiry(c.expiry);
    setModeRaw('basket'); setTick(tickFor('basket'));
    if (basketTemplates().some(t => t.key === b.strategy)) setBasketKey(b.strategy);
    setBasketLegs(b.legs.map(l => ({ side: l.side, opt: l.contract.opt as 'CE' | 'PE', strike: l.contract.strike, ratio: l.ratio })));
    setBasketEdited(true);
    setBroker(b.broker);
    setReal(b.mode === 'real'); setRealAck(false);
  }, [setBroker, underlying, tickFor]);

  // Auto-focus the contract of the newest live trade on first load so the user immediately sees it. It never switches
  // the page into REAL on its own: it prefers a trade in the page's mode (SIM on load) and otherwise shows the contract
  // only — the REAL chip in Active Trades switches mode with a click.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (autoFocusedRef.current || !data || second) return;
    const liveSlices = data.state.slices.filter(isLive);
    if (!liveSlices.length) return;
    const sameMode = liveSlices.filter(x => x.mode === (real ? 'real' : 'sim'));
    const latest = (sameMode.length ? sameMode : liveSlices)[(sameMode.length ? sameMode : liveSlices).length - 1];
    if (!latest.contract) return;
    autoFocusedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot on first data, guarded by autoFocusedRef
    selectContract({ contract: latest.contract, broker: latest.broker });
  }, [data, real, selectContract, second]);

  // Always visible (it sits in the top row, not in the foldable controls): an emergency exit must never be one click behind a chevron.
  const exitAllEl = !second && (<button type="button" disabled={busy || !exitAllPlan || (exitAllPlan.positions === 0 && exitAllPlan.cancelSliceIds.length + exitAllPlan.cancelPairIds.length + exitAllPlan.cancelBasketIds.length === 0)}
        onClick={() => { if (!data) return; setExitAllCancel(true); setExitAllSnap(planExitAll(data.state)); }}
        aria-label={`Exit all positions in all ladders (${exitAllPlan?.positions ?? 0} open)`}
        title="Exit every open position in every ladder (both panes, every broker, SIM and REAL) in one go. Asks first; optionally cancels armed levels and resting orders too"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}>
        <OctagonX className="w-3.5 h-3.5" aria-hidden="true" /> Exit all
        {(exitAllPlan?.positions ?? 0) > 0 && <span className="px-1 rounded bg-red-500/25 font-mono text-[10px]">{exitAllPlan?.positions}</span>}
      </button>);

  // The broker / SIM-REAL / arm / data / chain / settings / add-ladder buttons. With ONE ladder they sit in the top row beside
  // the index chips (right-aligned, same order); with two, each ladder keeps them in its own title row.
  const headControls = !collapsed && (<div className="flex items-center gap-2 flex-wrap">
      <BrokerPicker value={broker} onChange={setBroker} disabled={busy} brokers={LADDER_BROKERS} />
      {/* REAL needs the daily arm: choosing it while unarmed asks once (the dialog below arms for today and then switches). */}
      <Seg value={real ? 'REAL' : 'SIM'} options={['SIM', 'REAL'] as const} onChange={v => { if (v === 'REAL' && !liveArmed) { setArmModal(true); return; } setReal(v === 'REAL'); setRealAck(false); }} />
      {!real && <SimBadge />}
      {!second && <button type="button" aria-pressed={soundOn} aria-label={soundOn ? 'Mute trade chimes' : 'Unmute trade chimes'}
        title={soundOn ? 'Trade chimes on: rising = entry, falling = exit, low buzz = rejected / unknown. Click to mute' : 'Trade chimes muted. Click to unmute'}
        onClick={() => { const v = !soundOn; setSoundOn(v); savePref(k('price-ladder-sound'), v ? '1' : '0'); }}
        className={`p-1.5 rounded-md border bg-zinc-900 cursor-pointer ${soundOn ? 'border-zinc-700 text-zinc-300 hover:text-white' : 'border-amber-500/50 text-amber-400'}`}>
        {soundOn ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
      </button>}
      {!second && liveArmed && <button
        type="button" onClick={() => void post({ action: 'live', on: false })}
        title="REAL is armed for today. Disarm: new REAL orders are refused and armed REAL levels are cancelled (exits still work)"
        className="px-2.5 py-1 rounded-md text-xs font-bold border border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
      >
        REAL armed · Disarm
      </button>}
      {!second && <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
        DATA: {dataDate ?? '—'}
      </span>}
      <button type="button" onClick={() => setChainOpen(true)} disabled={!expiry || isFut}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer disabled:opacity-50"
        title={isFut ? 'Futures have no option chain' : `The ${underlying} option chain for ${expiry || 'the selected expiry'}`}>
        <Table2 className="w-3.5 h-3.5 text-emerald-400" /> Option chain
      </button>
      {!second && <button
        type="button"
        onClick={() => setSettingsModalOpen(true)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer"
        title="Configure Price Ladder trading cutoff & session thresholds"
      >
        <Settings className="w-3.5 h-3.5 text-amber-400" />
        Settings
      </button>}
      {second ? (
        <button type="button" onClick={onRemoveLadder} title="Close this ladder (orders it placed keep running on the server)"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer">
          <X className="w-3.5 h-3.5 text-red-400" /> Close ladder 2
        </button>
      ) : !dual && onAddLadder && (
        <button type="button" onClick={onAddLadder} title="Show a second, independent ladder beside this one (max 2)"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer">
          <Plus className="w-3.5 h-3.5 text-emerald-400" /> Add ladder
        </button>
      )}
    </div>);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white min-w-0">
      <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur xl:min-h-[var(--ladder-head-h)]" style={headerMinHeight ? ({ '--ladder-head-h': `${headerMinHeight + 1}px` } as React.CSSProperties) : undefined}>
      <div ref={headRef}>
      {/* Indices + P&L: always visible, above the foldable controls */}
      <div className="xl:min-h-[var(--ladder-row-h)]" style={rowMinHeight ? ({ '--ladder-row-h': `${rowMinHeight}px` } as React.CSSProperties) : undefined}>
      <div ref={rowRef} className="flex items-center gap-2 flex-wrap px-6 pt-2.5 text-xs min-h-[38px]">
        {notTracking && (
          <span role="alert" title="The dashboard server is not running its watcher: brackets, armed levels, the MTM guard and the square-off are NOT being run. Orders already at the broker stay live. Restart the dashboard server."
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-red-500/40 bg-red-500/15 text-red-300 font-bold">
            <AlertTriangle className="w-3.5 h-3.5" /> Server not tracking your trades
          </span>
        )}
        {!second && <>
          <QuoteChip label="NIFTY" q={quotes.NIFTY} />
          <QuoteChip label="INDIA VIX" q={quotes.VIX} />
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
        </>}
        <PnlChip label={`Ladder P&L · ${real ? 'REAL' : 'SIM'}`} value={ladderPnl}
          title={`The ladder's own P&L on ${BROKER_LABELS[broker]}, every contract, ${real ? 'REAL' : 'SIM'} orders only: closed at their exit, open at the live LTP, since entry (a carried NRML position counts from its entry). '—' if an open leg has no price.`} />
        {showAccount && <PnlChip label={`${BROKER_LABELS[broker]} P&L`} value={acct.pnl}
          title={`${BROKER_LABELS[broker]} account P&L today: realised + unrealised over all positions, as the broker reports it (includes trades not made on the ladder)${acct.note ? ` — ${acct.note}` : ''}`} />}
        {showAccount && <PnlChip label="Net P&L" value={acct.pnl != null && charges.total != null ? acct.pnl - charges.total : null}
          title={charges.total == null
            ? `${BROKER_LABELS[broker]} P&L minus charges — charges unavailable${charges.note ? `: ${charges.note}` : ''}`
            : `${BROKER_LABELS[broker]} P&L after estimated charges of ₹${Math.round(charges.total).toLocaleString('en-IN')} on ${charges.orders} executed order(s) today (brokerage ₹${charges.brokerage}/order${charges.breakdown ? ` · STT/CTT ₹${Math.round(charges.breakdown.stt)} · exchange ₹${Math.round(charges.breakdown.exchange)} · GST ₹${Math.round(charges.breakdown.gst)} · stamp ₹${Math.round(charges.breakdown.stamp)} · SEBI ₹${Math.round(charges.breakdown.sebi)}` : ''}). An estimate from rate tables, not your contract note.`} />}
        {showAccount && acct.note && <span className="text-amber-300 truncate max-w-[18rem]" title={acct.note}>{acct.note}</span>}
        {exitAllEl}
        {/* The standard header buttons (theme, alerts, settings, Sync Data, Update, Disconnect): at the top right of the page, in the always-visible top row. Side by side that is ladder 2's row; alone, ladder 1's. */}
        {(dual ? second : true) && <div className="ml-auto"><NavBar /></div>}
        {!second && !dual && headControls && <div>{headControls}</div>}
      </div>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-3">
        <div className="flex items-center gap-3 min-w-0 max-w-full">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Rows3 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">PRICE LADDER{dual ? ` ${ladderId}` : ''} · {mode === 'xy' ? 'Index' : mode === 'pair' ? 'PAIR' : mode === 'basket' ? 'BASKET' : 'PLAIN'}</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              {axisName} <span className="font-mono">{spot ? spot.toFixed(2) : '—'}</span>
            </h1>
            {/* One line with two ladders (the longer pair text would wrap and push that pane's button row lower than the other's). */}
            <p className={`text-[10px] text-zinc-500 font-medium mt-1 ${dual ? 'truncate' : ''}`} title={dual ? 'Hover for the full description' : undefined}>
              {mode === 'xy' ? `Trade the option on ${mcx ? 'its futures month\'s' : 'index'} levels — the server fires armed levels with this tab closed`
                : mode === 'basket' ? 'Prebuilt strategies (iron condor, butterfly, …) on their net premium — the server fires every leg with this tab closed'
                : mode === 'pair' ? 'Straddles / strangles on their combined CE + PE premium — the server fires both legs with this tab closed'
                  : 'One-click LIMIT / SL orders on the option premium'}
            </p>
          </div>
          {onToggleCollapsed && (
            <button type="button" onClick={onToggleCollapsed} aria-expanded={!collapsed}
              aria-label={collapsed ? 'Show header controls' : 'Hide header controls'}
              title={collapsed ? 'Show the controls (broker, SIM/REAL, P&L, books)' : 'Hide the controls for more room'}
              className="p-1.5 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer">
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          )}
          {collapsed && (
            <>
              <span className={`text-[10px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${real ? 'text-red-300 bg-red-500/10 border-red-500/30' : 'text-zinc-300 bg-zinc-900 border-zinc-700'}`}
                title="Broker and order mode for this ladder (shown while the controls are hidden)">
                {BROKER_LABELS[broker]} · {real ? 'REAL' : 'SIM'}
              </span>
              {!real && <SimBadge />}
            </>
          )}
        </div>
        {/* Two ladders: each pane's buttons take their own full-width row under its title, so both rows sit at the same height. */}
        {(second || dual) && <div className="basis-full">{headControls}</div>}
      </div>
      {/* Books: part of the foldable controls (the chips above stay visible) */}
      {!collapsed && <div className="flex items-center gap-2 flex-wrap px-6 pb-2.5 text-xs">
        <BookButton icon={<Briefcase className="w-3.5 h-3.5" />} label="Positions" count={acct.open} onClick={() => setBookOpen('positions')} />
        <BookButton icon={<ClipboardList className="w-3.5 h-3.5" />} label="Order book" onClick={() => setBookOpen('orders')} />
        <BookButton icon={<ReceiptText className="w-3.5 h-3.5" />} label="Trade book" onClick={() => setBookOpen('trades')} />
      </div>}
      </div>
      </div>
      {bookOpen && (
        <OrdersTradesModal
          isOpen
          readOnly
          subtitle="Orders: view only — change ladder orders from the ladder. Positions: close at market (all or a share)"
          initialTab={bookOpen}
          onClose={() => setBookOpen(null)}
          broker={broker}
          ordersData={book.orders}
          tradesData={book.trades}
          positionsData={book.positions}
          isLoading={bookLoading}
          error={bookError}
          onRefresh={() => { void fetchBook(); }}
          onClosePosition={closeBrokerPosition}
        />
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 pt-1.5 pb-5 max-w-[1680px] w-full mx-auto">
        <div className="flex flex-col gap-4 xl:min-h-[var(--ladder-top-h)]" style={topMinHeight ? ({ '--ladder-top-h': `${topMinHeight}px` } as React.CSSProperties) : undefined}>
        <div ref={topRef} className="flex flex-col gap-4">
        <div className="xl:min-h-[var(--ladder-banner-h)]" style={{ ...(bannerMinHeight ? { '--ladder-banner-h': `${bannerMinHeight}px` } : { marginBottom: -16 }) } as React.CSSProperties}>
        <div ref={bannerRef} className="flex flex-col gap-4">
        {loadError && (
          <Banner tone="red" key={String(loadError)}>
            <AlertTriangle className="w-4 h-4" /> {loadError}
          </Banner>
        )}
        {stale && inSession && (
          <Banner tone="amber">
            <AlertTriangle className="w-4 h-4" /> {axisName} {mcx ? 'price' : 'spot'} is stale{spotView ? ` (last ${timeOf(spotView.at)}, ${spotView.source})` : ''} — {mcx ? 'futures' : 'index'} levels are paused until it updates.
          </Banner>
        )}
        {pairError && (
          <Banner tone="red" key={String(pairError)}>
            <AlertTriangle className="w-4 h-4" /> Pair leg: {pairError}
          </Banner>
        )}
        {contractError && (
          <Banner tone="red" key={String(contractError)}>
            <AlertTriangle className="w-4 h-4" /> {contractError}
          </Banner>
        )}
        {mcx && sessionNote && (
          <Banner tone="amber" key={String(sessionNote)}>
            <AlertTriangle className="w-4 h-4" /> {sessionNote}
          </Banner>
        )}
        {hiddenReal > 0 && (
          <Banner tone="amber">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="min-w-0">{hiddenReal} live REAL order(s) / position(s) on {BROKER_LABELS[broker]} are not drawn here: this page is in SIM (it always opens in SIM). They are still running; the table below lists them.</span>
            <button type="button" onClick={() => { if (!liveArmed) { setArmModal(true); return; } setReal(true); setRealAck(false); }}
              className={`px-2 py-0.5 rounded border border-amber-500/50 font-bold hover:bg-amber-500/20 whitespace-nowrap ${FOCUS_RING}`}>Show REAL</button>
          </Banner>
        )}
        {sessionDown && (
          <Banner tone="amber">
            <AlertTriangle className="w-4 h-4" />
            {BROKER_LABELS[broker]} session is not logged in — {real ? 'REAL orders are off until you log in (Autologin); exits already sent keep retrying.' : 'SIM works; REAL needs a fresh login (Autologin).'}
          </Banner>
        )}
        {mode === 'pair' && pairView && !(pairView.combined && pairView.combined > 0) && (
          <Banner tone="amber">
            <AlertTriangle className="w-4 h-4" /> No live price for {pairView.ce.ltp ? 'the PE leg' : pairView.pe.ltp ? 'the CE leg' : 'either leg'} yet — pair levels are paused until both legs price (the feed may still be subscribing).
          </Banner>
        )}
        {syn && (() => {
          const live = (data?.state.baskets ?? []).some(b => b.kind === 'syn' && isBasketLive(b) && b.note?.startsWith(SYN_PAUSED_PREFIX));
          const a = basketView?.a ?? 0;
          const bad = a > 0 && !(spot > 0 && spotView?.fresh !== false && synSane(a, spot, daysToExpiry(expiry, istDay(data?.now))));
          const why = basketView?.marketStale ? `${SYN_PAUSED_PREFIX} — ${basketView.marketStale}; levels are paused until it clears` : null;
          const wide = !why && basketView?.marketWide ? `New entries are refused: ${basketView.marketWide}` : null;
          return live || bad || why || wide ? <Banner tone="amber"><AlertTriangle className="w-4 h-4" /> {why ?? (live || bad ? SYN_PAUSED_NOTE : wide)}</Banner> : null;
        })()}
        {mode === 'basket' && (basketErr || (basketView && !basketView.a)) && (
          <Banner tone="amber" key={String(basketErr)}>
            <AlertTriangle className="w-4 h-4" /> {basketErr ?? 'No live price for every leg yet (or the strategy nets to nothing) — basket levels are paused until all legs price.'}
          </Banner>
        )}
        {((mode === 'pair' && offPairs.length > 0) || (mode === 'basket' && offBaskets.length > 0) || hiddenPairs.length > 0) && (
          <Banner tone="amber">
            <div className="flex flex-col gap-1.5 min-w-0">
            {mode === 'pair' && offPairs.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {offPairs.length} live pair(s) are on other strikes, so they are not drawn on this ladder:
                {offPairs.slice(0, 4).map(p => (
                  <button key={p.id} type="button" onClick={() => selectPair(p)} title="Put this pair on the ladder"
                    className={`px-2 py-0.5 rounded border border-amber-500/50 font-bold hover:bg-amber-500/20 ${FOCUS_RING}`}>Show {pairName(p)}</button>
                ))}
              </div>
            )}
            {mode === 'basket' && offBaskets.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {offBaskets.length} live basket(s) are on other legs, so they are not drawn on this ladder:
                {offBaskets.slice(0, 4).map(b => (
                  <button key={b.id} type="button" onClick={() => selectBasket(b)} title="Put this basket on the ladder"
                    className={`px-2 py-0.5 rounded border border-amber-500/50 font-bold hover:bg-amber-500/20 ${FOCUS_RING}`}>Show {basketName(b)}</button>
                ))}
              </div>
            )}
            {hiddenPairs.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {hiddenPairs.map(p => (
                  <span key={p.id} className="inline-flex items-center gap-2">
                    {p.lots} lot(s) {p.side} {p.state === 'armed' ? 'armed ' : ''}{p.mode === 'real' ? 'REAL' : 'SIM'} {pairName(p)} on {BROKER_LABELS[p.broker]} — not shown: the ladder is on {real ? 'REAL' : 'SIM'} · {BROKER_LABELS[broker]}.
                    <button type="button" onClick={() => selectPair(p)}
                      className={`px-2 py-0.5 rounded border border-amber-500/50 font-bold hover:bg-amber-500/20 ${FOCUS_RING}`}>
                      Show {p.mode === 'real' ? 'REAL' : 'SIM'}{p.broker !== broker ? ` · ${BROKER_LABELS[p.broker]}` : ''}
                    </button>
                  </span>
                ))}
              </div>
            )}
            </div>
          </Banner>
        )}
        {realBlocked && (
          <Banner tone="red">
            <ShieldAlert className="w-4 h-4" /> REAL mode: arm LIVE · REAL MONEY for today before placing. Exits always work.
            <button type="button" onClick={() => setArmModal(true)} className={`ml-2 px-2 py-0.5 rounded border border-red-500/50 font-bold hover:bg-red-500/20 ${FOCUS_RING}`}>Arm for today</button>
          </Banner>
        )}

        </div>
        </div>

        <div className={`grid grid-cols-1 gap-4 ${dual ? '2xl:grid-cols-[272px_minmax(0,1fr)]' : 'lg:grid-cols-[272px_minmax(0,1fr)]'}`}>
          {/* ── left panel ── */}
          <div className="flex flex-col gap-2" style={{ fontFeatureSettings: '"cv11", "ss01"' }}>
            {/* Side by side below 2xl when two ladders stack their panel above the grid: the two cards share a row. */}
            <div className={dual ? 'grid grid-cols-2 2xl:grid-cols-1 gap-2 items-start [&>*:only-child]:col-span-2 2xl:[&>*:only-child]:col-span-1' : 'contents'}>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
              <p className="text-xs font-semibold tracking-tight text-zinc-400">{optLabel}</p>
              {mode === 'basket' ? (
                <>
                  <p className="text-2xl font-mono font-bold tracking-tight text-white leading-tight" title="Net premium: the strategy's legs, signed by side and ratio">
                    {netA ? netA.toFixed(2) : '—'}
                    {basketView?.credit != null && <span className={`ml-2 text-xs font-bold ${basketView.credit ? 'text-emerald-400' : 'text-sky-300'}`}>{basketView.credit ? 'net credit' : 'net debit'}</span>}
                  </p>
                  <ul className="font-mono text-[11px] text-zinc-400 mt-0.5" aria-label="Basket legs">
                    {(basketView?.legs ?? []).map((l, i) => (
                      <li key={i}><span className={l.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>{l.side === 'BUY' ? 'B' : 'S'}</span> {l.strike}{l.opt}{l.ratio > 1 ? ` ×${l.ratio}` : ''} <span className="text-zinc-200">{l.ltp?.toFixed(2) ?? '—'}</span></li>
                    ))}
                  </ul>
                </>
              ) : mode === 'pair' ? (
                <>
                  <p className="text-2xl font-mono font-bold tracking-tight text-white leading-tight" title="Combined premium: CE LTP + PE LTP">{combined ? combined.toFixed(2) : '—'}</p>
                  <p className="font-mono text-xs text-zinc-400">
                    CE {pairView?.ce.strike ?? '—'} <span className="text-zinc-200">{pairView?.ce.ltp?.toFixed(2) ?? '—'}</span>
                    {' + '}PE {pairView?.pe.strike ?? '—'} <span className="text-zinc-200">{pairView?.pe.ltp?.toFixed(2) ?? '—'}</span>
                  </p>
                </>
              ) : (
                <p className="text-2xl font-mono font-bold tracking-tight text-white leading-tight">{optLtp ? optLtp.toFixed(2) : '—'}</p>
              )}
              <div className="mt-1.5 pt-1.5 border-t border-zinc-800 text-xs">
                <p className="font-medium text-zinc-400">{axisName} <span className="font-mono text-zinc-200">{spot ? spot.toFixed(2) : '—'}</span>
                  {indexQ?.change_pct != null && <span className={`ml-2 font-mono ${indexQ.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{indexQ.change_pct >= 0 ? '+' : ''}{indexQ.change_pct.toFixed(2)}%</span>}
                </p>
                <p className="font-mono text-zinc-500 mt-0.5">H {indexQ?.day_high?.toFixed(2) ?? '—'} · L {indexQ?.day_low?.toFixed(2) ?? '—'}</p>
              </div>
            </div>

            {mode !== 'pair' && mode !== 'basket' && <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 grid grid-cols-2 gap-y-0.5 text-xs">
              <span className="text-zinc-400 font-medium">Net Pos <span className="text-zinc-500">({pageMode.toUpperCase()})</span></span><span className="font-mono text-right text-zinc-100">{net.qty}</span>
              <span className="text-zinc-400 font-medium">P&amp;L</span><span className={`font-mono text-right ${pnlClass(contractPnl)}`}>{fmtMoney(contractPnl)}</span>
              <span className="text-zinc-400 font-medium">Avg Price</span><span className="font-mono text-right text-zinc-100">{net.avg ? net.avg.toFixed(2) : '—'}</span>
              <div className="col-span-2 flex gap-1 mt-1.5">
                <button type="button" disabled={busy || net.qty === 0} onClick={() => void post({ action: 'exit', securityId, broker, mode: pageMode, pct: 100 })}
                  className={EXIT_BTN}>Exit ({net.qty})</button>
                <PartialExit disabled={busy || net.qty === 0} onPick={p => void post({ action: 'exit', securityId, broker, mode: pageMode, pct: p })} />
              </div>
            </div>}
            {mode === 'basket' && <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 grid grid-cols-2 gap-y-0.5 text-xs">
              <span className="text-zinc-400 font-medium">Net Pos <span className="text-zinc-500">({pageMode.toUpperCase()})</span></span><span className="font-mono text-right text-zinc-100" aria-label="Basket net position">{basketNetLots} lot{Math.abs(basketNetLots) === 1 ? '' : 's'}</span>
              <span className="text-zinc-400 font-medium">P&amp;L</span><span className={`font-mono text-right ${pnlClass(basketPnl)}`}>{fmtMoney(basketPnl)}</span>
              <span className="text-zinc-400 font-medium" title="Net premium at entry, weighted by lots">Avg Price</span><span className="font-mono text-right text-zinc-100">{basketAvgEntry ? basketAvgEntry.toFixed(2) : '—'}</span>
              <div className="col-span-2 flex gap-1 mt-1.5">
                <button type="button" disabled={busy || basketExitable.length === 0} title="Exit every open basket on these legs at market"
                  onClick={() => void post({ action: 'basket', op: 'exitShare', ids: basketExitable.map(y => y.id), pct: 100 })}
                  className={EXIT_BTN}>Exit ({basketLotsHeld}L)</button>
                <PartialExit disabled={busy || basketExitable.length === 0} tip="Whole lots, rounded down, at market" isOff={p => Math.floor((basketOpenLots * p) / 100) < 1} onPick={p => void post({ action: 'basket', op: 'exitShare', ids: basketExitable.map(y => y.id), pct: p })} />
              </div>
            </div>}
            {mode === 'pair' && <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 grid grid-cols-2 gap-y-0.5 text-xs">
              <span className="text-zinc-400 font-medium">Net Pos <span className="text-zinc-500">({pageMode.toUpperCase()})</span></span><span className="font-mono text-right text-zinc-100" aria-label="Pair net position">{pairNetLots} lot{Math.abs(pairNetLots) === 1 ? '' : 's'}</span>
              <span className="text-zinc-400 font-medium">P&amp;L</span><span className={`font-mono text-right ${pnlClass(pairPnl)}`}>{fmtMoney(pairPnl)}</span>
              <span className="text-zinc-400 font-medium" title="Combined CE + PE entry premium, weighted by lots">Avg Price</span><span className="font-mono text-right text-zinc-100">{pairAvgEntry ? pairAvgEntry.toFixed(2) : '—'}</span>
              <div className="col-span-2 flex gap-1 mt-1.5">
                <button type="button" disabled={busy || pairExitable.length === 0} title="Exit every open pair on these legs, both legs at market"
                  onClick={() => void post({ action: 'pair', op: 'exitShare', ids: pairExitable.map(y => y.id), pct: 100 })}
                  className={EXIT_BTN}>Exit ({pairLotsHeld}L)</button>
                <PartialExit disabled={busy || pairExitable.length === 0} tip="Whole lots, rounded down, both legs at market" isOff={p => Math.floor((pairOpenLots * p) / 100) < 1} onPick={p => void post({ action: 'pair', op: 'exitShare', ids: pairExitable.map(y => y.id), pct: p })} />
              </div>
            </div>}
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 flex flex-col gap-1.5 text-xs">
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Ladder</span>
                <Seg compact value={mode} options={(syn ? ['basket'] : isFut ? ['xy', 'plain'] : ['xy', 'plain', 'pair', 'basket']) as readonly PageMode[]} labels={{ xy: 'Index', plain: 'Plain', pair: 'Pair', basket: syn ? 'Synthetic' : 'Basket' }} onChange={setMode} />
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Product</span>
                <Seg compact value={product} options={['NRML', 'MIS'] as const} onChange={setProduct} />
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Underlying</span>
                <select aria-label="Underlying" value={underlying} onChange={e => setUnderlying(e.target.value)} className={SELECT_CLS}>
                  {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Expiry</span>
                <select aria-label="Expiry" value={expiry} onChange={e => { setExpiry(e.target.value); setStrike(isFut ? FUT_STRIKE : null); }} className={SELECT_CLS}>
                  {expiries.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              {mode !== 'basket' && !isFut && <div className="flex items-center justify-between gap-2 min-w-0"><span className="text-zinc-400 font-medium">Strike</span>
                {/* min-w-0 + a width cap: the longer "22600 · ATM+10" labels shrink the select; they must not push anything over the ladder. */}
                <select aria-label="Strike" value={strike ?? ''} onChange={e => setStrike(Number(e.target.value))} className={`${SELECT_CLS} font-mono`}>
                  {strikes.map(k => { const off = atmOffsetLabel(strikes, atmStrike, k); return <option key={k} value={k}>{off ? `${k}  ·  ${off}` : k}</option>; })}
                </select>
              </div>}
              {mode === 'basket' && syn && (
                <>
                <div className="flex items-center justify-between gap-2 min-w-0"><span className="text-zinc-400 font-medium" title="The synthetic sits on the at-the-money strike, picked when the legs are built">Strike</span>
                  <span className="font-mono text-zinc-100" aria-label="Synthetic strike">{synK ? (atmStrike != null && synK !== atmStrike ? `${synK} (${synK > atmStrike ? '+' : ''}${synK - atmStrike} from ATM ${atmStrike})` : `${synK} ATM`) : '—'}
                    {basketView && <span className="ml-2 text-zinc-400">CE {basketView.legs.find(l => l.opt === 'CE')?.ltp ?? '—'} · PE {basketView.legs.find(l => l.opt === 'PE')?.ltp ?? '—'}</span>}</span>
                </div>
                <div className="flex items-center justify-between gap-2 min-w-0 font-mono text-[11px]" aria-label="Synthetic market">
                  <span className="text-zinc-400 font-sans font-medium" title="What the two legs can really be traded at: buy = CE ask − PE bid, sell = CE bid − PE ask">Market</span>
                  {basketView?.market
                    ? <span className="text-zinc-100">Buy {basketView.market.buy.toFixed(2)} · Sell {basketView.market.sell.toFixed(2)} <span className={basketView.marketWide ? 'text-amber-400' : 'text-zinc-400'}>spread {basketView.market.spread.toFixed(2)}</span></span>
                    : <span className="text-zinc-500" title="Needs the bid / ask of both legs from the price bridge; the last prices and the index check still guard the ladder">no market depth</span>}
                </div>
                </>
              )}
              {mode === 'basket' && !syn && (
                <>
                  <div className="flex items-center justify-between gap-2 min-w-0"><span className="text-zinc-400 font-medium">Strategy</span>
                    <select aria-label="Basket strategy" value={basketKey} onChange={e => { setBasketKey(e.target.value); setBasketEdited(false); }} disabled={basketLocked}
                      className={`${SELECT_CLS} disabled:opacity-50`}>
                      {[...new Set(basketTemplates().map(t => t.category))].map(c => (
                        <optgroup key={c} label={c}>{basketTemplates().filter(t => t.category === c).map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</optgroup>
                      ))}
                    </select>
                  </div>
                  {(tplHasFar || basketHasFar) && (
                    <div className="flex items-center justify-between gap-2"><span className="text-zinc-400 font-medium" title="The far legs of a calendar / diagonal trade on this expiry; the near legs on the Expiry above.">Far expiry</span>
                      <select aria-label="Far expiry" value={farExpiry} onChange={e => setFarExpiry(e.target.value)} disabled={basketLocked}
                        className={`${SELECT_CLS} disabled:opacity-50`}>
                        {expiries.filter(x => x > expiry).map(x => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Legs <span className="text-zinc-500">({basketLegs.length})</span></span>
                    <button type="button" onClick={() => setBasketModalOpen(true)} className={`px-2.5 py-0.5 rounded border border-zinc-700 text-zinc-200 hover:text-white ${FOCUS_RING}`}>Edit legs</button>
                  </div>
                </>
              )}
              {((mode !== 'pair' && mode !== 'basket') || syn) && (
                <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Option</span>
                  <Seg compact value={(syn ? 'SYN' : opt) as OptType | 'SYN'} options={(mcx ? (broker === 'dhan' ? ['CE', 'PE', 'FUT'] : ['CE', 'PE']) : ['CE', 'PE', 'SYN']) as readonly (OptType | 'SYN')[]} labels={{ CE: 'Call', PE: 'Put', FUT: 'Future', SYN: 'Synthetic' }} onChange={chooseOpt} />
                </div>
              )}
              {mode === 'pair' && (
                <>
                  <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="Straddle: CE and PE on the strike above. Strangle: CE some strikes above it, PE some below — set separately.">Structure</span>
                    <Seg compact value={structure} options={['straddle', 'strangle'] as const} labels={{ straddle: 'Straddle', strangle: 'Strangle' }} onChange={setStructure} />
                  </div>
                  {structure === 'strangle' && (
                    <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title={`How many strikes (${pairStep} points each) the call is above the Strike and the put below it. Set them independently; the Strike above is the centre (ATM by default).`}>Call + / Put −</span>
                      <span className="flex items-center gap-1">
                        <NumField compact label="Call strikes above the centre" value={ceOff} onCommit={v => setCeOff(Math.max(0, Math.min(30, Math.round(v))))} min={0} max={30} width="w-12" />
                        <NumField compact label="Put strikes below the centre" value={peOff} onCommit={v => setPeOff(Math.max(0, Math.min(30, Math.round(v))))} min={0} max={30} width="w-12" />
                      </span>
                    </div>
                  )}
                  <p className="text-zinc-500">{pairOk
                    ? `CE ${pairCe} (${atmOffsetLabel(strikes, atmStrike, pairCe!) ?? '—'}) · PE ${pairPe} (${atmOffsetLabel(strikes, atmStrike, pairPe!) ?? '—'})`
                    : structure === 'strangle' && ceOff + peOff < 1 ? 'A strangle needs the call above the put — raise an offset' : 'Those strikes are not in the chain — pick another centre or offset'}</p>
                  <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="Per-leg stop: either leg moving this % against its own fill exits BOTH legs (a short leg rising — 100 = doubled; a long leg falling). 0 = off. Runs alongside the combined target / SL.">Leg SL %</span>
                    <NumField compact label="Per-leg stop-loss percent (0 = off)" value={legSlPct} onCommit={v => setLegSlPct(Math.max(0, Math.round(v)))} min={0} max={1000} step={5} width="w-16" />
                  </div>
                </>
              )}
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="Classic: Buy and Sell each work on their limit side (the other side needs Order Type SL). Anywhere: both columns at every level — the other side is a stop by itself.">Zones</span>
                <Seg compact value={zones} options={['classic', 'anywhere'] as const} labels={{ classic: 'Classic', anywhere: 'Anywhere' }} onChange={setZones} />
              </div>
              {zones === 'classic' ? (
                <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Order Type</span>
                  <Seg compact value={orderType} options={['LIMIT', 'SL'] as const} labels={{ LIMIT: 'Limit', SL: 'SL' }} onChange={setOrderType} />
                </div>
              ) : mode === 'plain' ? (
                <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="An SL-limit's limit sits this % past its trigger: below it for a Sell, above it for a Buy">SL limit buffer %</span>
                  <NumField compact label="SL limit buffer percent" value={slBufferPct} onCommit={setSlBufferPct} min={MIN_SL_BUFFER_PCT} max={MAX_SL_BUFFER_PCT} step={0.1} />
                </div>
              ) : null}
              {(mode === 'xy' || mode === 'pair' || mode === 'basket') && (
                <>
                  <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title={mode === 'pair' ? 'Target / SL / trail are points of the combined premium' : mode === 'basket' ? 'Target / SL / trail are points of the basket\'s net premium' : undefined}>Style</span>
                    <Seg compact value={style} options={['Single', 'Bracket', 'Cover'] as const} onChange={setStyle} />
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 items-center">
                    {style === 'Bracket' && <><span className="text-zinc-400 font-medium">Target pts</span><NumField compact label="Target points" value={tgtPts} onCommit={setTgtPts} min={1} /></>}
                    {style !== 'Single' && <><span className="text-zinc-400 font-medium">SL pts</span><NumField compact label="Stop-loss points" value={slPts} onCommit={setSlPts} min={1} /></>}
                    {/* Every style: Single + trail = a trailing stop on its own (the SL starts at the trail distance). */}
                    <label className="flex items-center gap-1.5 text-zinc-400" title="Continuous trailing SL: the SL stays this many points behind the best level reached and moves with every new high / low — never back">
                      <input type="checkbox" checked={trailOn} onChange={e => setTrailOn(e.target.checked)} /> Trail SL by
                    </label>
                    <NumField compact label="Trailing SL distance in points" value={trailPts} onCommit={setTrailPts} min={1} />
                  </div>
                </>
              )}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Lots {lotSize ? <span className="text-zinc-500">({mcx ? `${lots * (MCX_LOT_MULTIPLIER[underlying] ?? 1)} bbl` : `${lots * lotSize} qty`})</span> : null}</span>
                  <NumField compact label="Lots" value={lots} onCommit={v => setLots(Math.min(MAX_LADDER_LOTS, Math.max(1, Math.round(v))))} min={1} max={MAX_LADDER_LOTS} />
                </div>
                {/* Quick sizes in four equal buttons, the same height as the form's other controls. */}
                <div className="grid grid-cols-4 gap-1.5">
                  {[1, 5, 10].map(n => (
                    <button key={n} type="button" onClick={() => setLots(l => Math.min(MAX_LADDER_LOTS, l + n))} className={`h-6 rounded border border-zinc-700 text-xs text-zinc-300 hover:text-white ${FOCUS_RING}`}>+{n}</button>
                  ))}
                  <button type="button" onClick={() => setLots(1)} className={`h-6 rounded border border-zinc-700 text-xs text-zinc-400 hover:text-white ${FOCUS_RING}`}>Clear</button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" disabled={busy || !expiry || (mode === 'basket' ? !basketView?.a : mode === 'pair' ? !pairOk : !strike)} onClick={() => (mode === 'basket' ? sendBasketMarket('BUY') : mode === 'pair' ? sendPairMarket('BUY') : sendMarket('BUY'))}
                  title={mode === 'basket' ? `BUY ${lots} lot(s) of the basket (every leg) at market now` : mode === 'pair' ? `BUY ${lots} lot(s) of the ${structure} (both legs) at market now` : `BUY ${lots} lot(s) ${strike ?? ''}${opt} at market now`} aria-label="Buy at market"
                  className="px-2 py-1.5 rounded bg-emerald-600 text-oncolor font-bold hover:bg-emerald-500 disabled:opacity-50">Buy Market</button>
                <button type="button" disabled={busy || !expiry || (mode === 'basket' ? !basketView?.a : mode === 'pair' ? !pairOk : !strike)} onClick={() => (mode === 'basket' ? sendBasketMarket('SELL') : mode === 'pair' ? sendPairMarket('SELL') : sendMarket('SELL'))}
                  title={mode === 'basket' ? `SELL ${lots} lot(s) of the basket (every leg) at market now` : mode === 'pair' ? `SELL ${lots} lot(s) of the ${structure} (both legs) at market now` : `SELL ${lots} lot(s) ${strike ?? ''}${opt} at market now`} aria-label="Sell at market"
                  className="px-2 py-1.5 rounded bg-red-600 text-oncolor font-bold hover:bg-red-500 disabled:opacity-50">Sell Market</button>
              </div>
            </div>
            <MtmGuardCard key={myGuardKey} broker={broker} real={real} ladderId={ladderId} mtm={ladderPnl} guard={data?.state?.guards?.[myGuardKey]} post={post} />
            <p className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              <span className="inline-flex items-center gap-1 cursor-help" title={HELP_TEXT} aria-label={HELP_TEXT} role="img"><Info className="w-3.5 h-3.5" aria-hidden /> How the ladder works</span>
            </p>
          </div>

          {/* ── ladder ── */}
          <div className="flex flex-col gap-2 min-w-0">
            {/* Every ladder shows it, in every mode, whether or not it holds anything yet. */}
            <div className="flex items-center gap-2 flex-wrap px-2.5 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800 text-xs">
              <span className="text-zinc-400 font-semibold flex items-center gap-1.5"
                title="Positions this ladder holds right now: one per contract + side (a strangle or straddle counts as one). Armed levels and resting orders are not positions; they show on the ladder.">
                <span className={`w-2 h-2 rounded-full ${openPositions > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
                Open positions:
              </span>
              <span className="font-mono font-bold text-zinc-100" aria-label="Open positions">{openPositions}</span>
              <span className="w-px h-4 bg-zinc-800 shrink-0 mx-1" />
              <PnlChip label="Total P&L" value={ladderPnl}
                title={`This ladder's total P&L on ${BROKER_LABELS[broker]} · ${real ? 'REAL' : 'SIM'} — the same number as the Ladder P&L chip above and the MTM guard: trades closed today at their exit, open ones at the live price. '—' while an open leg has no price.`} />
            </div>
            {/* -mb-2 takes the column gap back: the Tick row sits right above the Buy / Bids header. */}
            <div className="flex items-center gap-2 flex-wrap text-xs -mt-1.5 -mb-2">
              <div className="flex items-center gap-2 w-full rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-1">
              <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
              <span className="text-zinc-400">Tick</span>
              <Seg value={String(tick)} options={ticks.map(String)} onChange={v => chooseTick(Number(v), mode)} />
              <button type="button" onClick={() => { setFollow(true); setManual(false); setCenter(refPrice); }} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white">
                <Crosshair className="w-3.5 h-3.5" /> Centre
              </button>
              {mode === 'xy' && <label className="flex items-center gap-1.5 text-zinc-400" title="Previous day's Central Pivot Range: TC / P / BC marks, the rows between BC and TC tinted. Formula and the R/S switch are in Settings."><input type="checkbox" checked={pivotPrefs.cprOn} onChange={e => changeDefaults({ cprOn: e.target.checked })} /> CPR</label>}
              {mode === 'xy' && <label className="flex items-center gap-1.5 text-zinc-400" title={`Previous day's R1-R4 and S1-S4 (${pivotPrefs.pivotFormula} formula; change it in Settings)`}><input type="checkbox" checked={pivotPrefs.pivotsOn} onChange={e => changeDefaults({ pivotsOn: e.target.checked })} /> R/S</label>}
              {mode === 'xy' && !isFut && <label className="flex items-center gap-1.5 text-zinc-400" title="Open-interest bars on the strike rows: puts left of the Price column, calls right"><input type="checkbox" checked={oiOn} onChange={e => { setOiOn(e.target.checked); savePref(k('price-ladder-oi'), e.target.checked ? '1' : '0'); }} /> OI</label>}
              {mode === 'xy' && oiOn && oiRows.staleSince != null && <span className="text-[10px] text-amber-300" title="Dhan refused a fresh option chain, so the OI bars come from the last good one">OI stale since {timeOf(oiRows.staleSince)}</span>}
              <label className="flex items-center gap-1.5 text-zinc-400"><input type="checkbox" checked={follow} onChange={e => { setFollow(e.target.checked); if (e.target.checked) setManual(false); }} /> Follow</label>
              <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setSettingsModalOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer"
                title="Configure trading cutoff & Price Ladder settings"
              >
                <Settings className="w-3.5 h-3.5 text-amber-400" /> Settings
              </button>
              <button
                type="button" disabled={busy || pendingHere === 0}
                onClick={() => void post(mode === 'pair' ? { action: 'pair', op: 'cancelAll', ids: armedPairIds } : mode === 'basket' ? { action: 'basket', op: 'cancelAll', ids: armedBasketIds } : { action: 'cancelAll', securityId, broker, mode: pageMode })}
                className="px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white disabled:opacity-40"
              >
                Cancel all ({pendingHere})
              </button>
              </div>
              {real && <span className="font-bold text-red-400" title="REAL orders">REAL</span>}
              {/* Closing it keeps its space (invisible, not removed) so the two ladders stay level. */}
              {placeBlockReason && <span className={`inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 pl-2 pr-1 py-0.5 text-[11px] font-semibold text-amber-300 ${dismissedBlock === placeBlockReason ? 'invisible' : ''}`} role="status" title="Clicks on the ladder are ignored until this clears"><AlertTriangle className="w-3 h-3" aria-hidden /> Ordering paused: {placeBlockReason}
                <button type="button" onClick={() => setDismissedBlock(placeBlockReason)} aria-label="Dismiss notice" title="Dismiss" tabIndex={dismissedBlock === placeBlockReason ? -1 : 0} className="ml-0.5 rounded p-0.5 hover:bg-amber-500/20"><X className="w-3 h-3" aria-hidden /></button></span>}
              </div>
              </div>
            </div>
            <LadderGrid
              center={center} refPrice={refPrice} tick={tick} rows={ROWS}
              widgets={mode === 'basket' ? basketWidgetsFor(myBaskets) : mode === 'pair' ? pairWidgetsFor(myPairs) : widgetsFor(mine, mode)}
              limitZoneBuy={limitZone(mode === 'pair' || mode === 'basket' ? 'plain' : mode, opt, 'BUY')}
              zones={zones} stopLimitFor={mode === 'plain' ? (side, p) => stopLimitPrice(side, p, slBufferPct) : undefined}
              onPlace={onPlace} onCancel={id => void post(mode === 'basket' ? { action: 'basket', op: 'cancel', id } : mode === 'pair' ? { action: 'pair', op: 'cancel', id } : { action: 'cancel', id })} onMove={onMove} onAdjust={onAdjust}
              disabled={placeDisabled} decimals={decimals} entryMarks={entryMarks}
              oi={mode === 'xy' && !isFut && oiOn && oiRows.key === `${underlying}|${expiry}` && oiRows.rows.length ? { rows: oiRows.rows, max: maxOi(oiRows.rows) } : undefined}
              oiPlace={resolveDefaults(savedDefaults).oiPlace}
              onScroll={refPrice > 0 ? scrollLadder : undefined}
              onTrail={(w, delta) => { void post(mode === 'basket' ? { action: 'basket', op: 'trail', id: w.ids[0], delta } : mode === 'pair' ? { action: 'pair', op: 'trail', id: w.ids[0], delta } : { action: 'trail', id: w.ids[0], delta }); }}
              onHoldChange={setHeld}
              pivots={mode === 'xy' ? pivots : undefined}
              keyLevels={mode === 'xy' ? {
                pdh: data?.keyLevels?.pdh ?? null,
                pdl: data?.keyLevels?.pdl ?? null,
                dayHigh: indexQ?.day_high ?? data?.keyLevels?.dayHigh ?? null,
                dayLow: indexQ?.day_low ?? data?.keyLevels?.dayLow ?? null,
              } : undefined}
            />
          </div>
        </div>

        </div>
        </div>

        {/* ── orders ── */}
        <div className="rounded-lg border border-zinc-800 overflow-x-auto">
          <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/40">
            <p className="text-xs font-bold text-white">Ladder orders &amp; positions <span className="text-zinc-500 font-medium">({live.length} live)</span></p>
            {(done.length > 0 || panePairs.some(p => !isPairLive(p))) && (
              <button type="button" onClick={() => void post({ action: 'clear', ...(dual ? { pane: ladderId } : {}) })} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white">
                <Trash2 className="w-3.5 h-3.5" /> Clear finished
              </button>
            )}
          </div>
          {paneSlices.length === 0 ? (
            <p className="px-3 py-3 text-center text-xs text-zinc-500">No ladder orders today{dual ? ' from this ladder' : ''}. Click a price on the ladder to place one.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-zinc-800">
                <tr className="text-left">
                  {[
                    ['Time', 'When the order was placed / armed'],
                    ['Mode', ''],
                    ['Contract', ''],
                    ['Side', ''],
                    ['Qty', 'Filled quantity (ordered while unfilled), in lots'],
                    ['Trigger', 'Index: the index / futures level that fires the entry. Plain: the LIMIT / SL price'],
                    ['Fired at', 'Index: the index / futures level when the entry fired (the bracket is measured from it)'],
                    ['Entry ₹', 'Option entry price: the average fill'],
                    ['LTP ₹', 'Option live price (open positions)'],
                    ['Exit ₹', 'Option exit price: the average exit fill, with the exit time'],
                    ['TGT / SL', 'Bracket target / stop on the index / futures level (T = trailing step)'],
                    ['State', ''],
                    ['P&L', 'Closed: at the exit price. Open: at the live price'],
                    ['', ''],
                  ].map(([h, t], i) => (
                    <th key={`${h}-${i}`} title={t || undefined} className="px-2 py-1.5 text-xs font-bold text-white whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...paneSlices].reverse().map(s => <SliceRow key={s.id} s={s} ltp={data?.ltps[s.contract.securityId]} busy={busy} post={post} trailPts={trailPts} onSelect={selectContract} />)}
              </tbody>
            </table>
          )}
        </div>

        {panePairs.length > 0 && (
          <PairTable pairs={panePairs} ltps={data?.ltps ?? {}} busy={busy} post={post} trailPts={trailPts} onSelect={selectPair} shown={new Set(myPairs.map(y => y.id))}
            onLots={(p, d) => onAdjust({ key: p.id, price: 0, column: p.side, kind: 'pos', label: 'Pair position', qty: p.qty, lots: p.lots, ids: [p.id], adjust: 'position' }, d, true)}
            onRoll={onRoll} />
        )}

        {paneBaskets.length > 0 && (
          <BasketTable baskets={paneBaskets} ltps={data?.ltps ?? {}} busy={busy} post={post} shown={new Set(myBaskets.map(y => y.id))} onSelect={selectBasket} />
        )}
        {basketModalOpen && (
          <BasketLegsModal name={basketTpl?.name ?? 'Basket'} legs={basketLegs} strikes={strikes} atmStrike={atmStrike} locked={basketLocked} farExpiry={tplHasFar || basketHasFar ? farExpiry : null} nearExpiry={expiry} spot={spot} lots={lots} unitsPerLot={(basketView?.lotSize ?? 0) * (basketView?.mult ?? 1)}
            prices={basketLegs.map((_, i) => basketView?.legs[i]?.ltp ?? null)}
            onChange={l => { setBasketLegs(l); setBasketEdited(true); }}
            onReset={() => { setBasketEdited(false); buildBasket(); }}
            onClose={() => setBasketModalOpen(false)} />
        )}

        {/* Collapsed by default (remembered per browser); the header keeps the count and the newest event in view. */}
        <details
          open={eventsOpen}
          onToggle={e => { const o = (e.currentTarget as HTMLDetailsElement).open; setEventsOpen(o); savePref(k('price-ladder-events-open'), o ? '1' : '0'); }}
          className="rounded-lg border border-zinc-800 group"
        >
          <summary className={`flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden rounded-lg ${FOCUS_RING}`}>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400 transition-transform group-open:rotate-90" aria-hidden />
            <span className="text-xs font-bold text-white">Events</span>
            <span className="text-xs text-zinc-500">({paneEvents.length})</span>
            {latestEvent && (
              <span className={`ml-2 min-w-0 truncate font-mono text-[11px] ${latestEvent.level === 'error' ? 'text-red-400' : latestEvent.level === 'warn' ? 'text-amber-300' : 'text-zinc-400'}`}>
                {timeOf(latestEvent.at)} {latestEvent.msg}
              </span>
            )}
          </summary>
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto font-mono text-[11px] px-3 pb-3">
            {paneEvents.slice(-60).reverse().map((e, i) => (
              <p key={`${e.at}-${i}`} className={e.level === 'error' ? 'text-red-400' : e.level === 'warn' ? 'text-amber-300' : 'text-zinc-400'}>
                {timeOf(e.at)} {e.msg}
              </p>
            ))}
            {!paneEvents.length && <p className="text-zinc-500">Nothing yet.</p>}
          </div>
        </details>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3">
            <p className="text-sm font-bold text-white">{confirm.setting ? confirm.setting.title : 'Place a REAL-money order?'}</p>
            <p className="text-xs text-zinc-300">{confirm.setting ? confirm.text : `${confirm.text} on ${BROKER_LABELS[broker]}.`}</p>
            {!confirm.setting && <p className="text-[11px] text-zinc-500">Further clicks on this page load go straight through.</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300">Cancel</button>
              <button type="button" onClick={() => { const c = confirm; setConfirm(null); if (!c.setting) setRealAck(true); c.run(); }} className="px-3 py-1.5 rounded-md bg-red-600 text-xs font-bold text-oncolor">{confirm.setting ? confirm.setting.button : 'Place REAL order'}</button>
            </div>
          </div>
        </div>
      )}
      {exitAllSnap && (() => {
        const snap = exitAllSnap;
        const pendingN = snap.cancelSliceIds.length + snap.cancelPairIds.length + snap.cancelBasketIds.length;
        const confirm = async () => {
          const ok = await post({ action: 'exitAll', signature: snap.signature, cancelPending: exitAllCancel });
          if (ok) { toast.success(`Exiting ${snap.positions} position(s)${exitAllCancel && pendingN ? ` and cancelling ${pendingN} pending` : ''} — watch the exits settle`); setExitAllSnap(null); }
        };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true" aria-labelledby="exit-all-title">
            <div className="w-full max-w-lg rounded-lg border border-red-500/40 bg-zinc-900 p-4 flex flex-col gap-3">
              <p id="exit-all-title" className="text-sm font-bold text-white">Exit all positions in all ladders?</p>
              <p className="text-xs text-zinc-300">Each position below is exited at MARKET, sized against the broker&apos;s own book. REAL exits go to the broker; SIM exits close paper positions.</p>
              <ul className="flex flex-col gap-1" aria-label="What will be exited">
                {snap.groups.map(g => (
                  <li key={`${g.broker}|${g.mode}`} className="flex items-center justify-between gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs">
                    <span className="flex items-center gap-2">
                      <span className="font-bold text-zinc-100">{BROKER_LABELS[g.broker]}</span>
                      <span className={`px-1.5 py-px rounded text-[10px] font-bold ${g.mode === 'real' ? 'bg-red-500/20 text-red-300' : 'bg-zinc-700 text-zinc-300'}`}>{g.mode === 'real' ? 'REAL' : 'SIM'}</span>
                    </span>
                    <span className="font-mono text-zinc-200">{g.positions} position{g.positions === 1 ? '' : 's'}{g.pending ? ` · ${g.pending} pending` : ''}</span>
                  </li>
                ))}
              </ul>
              {pendingN > 0 && (
                <label className="flex items-start gap-2 text-xs text-zinc-200 cursor-pointer">
                  <input type="checkbox" checked={exitAllCancel} onChange={e => setExitAllCancel(e.target.checked)} className="mt-0.5" />
                  <span>Also cancel {pendingN} armed level(s) and resting order(s), so nothing re-enters after the exit.</span>
                </label>
              )}
              {snap.unknown > 0 && (
                <p className="text-xs text-amber-300 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />{snap.unknown} item(s) have an UNKNOWN order status and are not touched: check Orders / Positions and resolve each one.</p>
              )}
              {snap.inFlight > 0 && (
                <p className="text-xs text-amber-300 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />{snap.inFlight} entry order(s) are being sent right now and are not included: press Exit all again once they settle.</p>
              )}
              {snap.alreadyExiting > 0 && <p className="text-[11px] text-zinc-400">{snap.alreadyExiting} already exiting: left as they are.</p>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setExitAllSnap(null)} className={`px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300 ${FOCUS_RING}`}>Cancel</button>
                <button type="button" disabled={busy || (snap.positions === 0 && !(exitAllCancel && pendingN))} onClick={() => void confirm()}
                  className={`px-3 py-1.5 rounded-md bg-red-600 text-xs font-bold text-oncolor disabled:opacity-50 ${FOCUS_RING}`}>
                  {snap.positions > 0 ? `Exit all ${snap.positions} position${snap.positions === 1 ? '' : 's'}` : 'Cancel pending only'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {armModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3">
            <p className="text-sm font-bold text-white">Arm LIVE · REAL MONEY for today?</p>
            <p className="text-xs text-zinc-300">REAL ladder orders will place real orders on your broker account. Armed index levels are fired by the dashboard server even with this tab closed, until {sessionFor(underlying, istDay(), data?.state?.settings?.mcxAutoExitTime, data?.state?.settings?.nseAutoExitTime).autoExitLabel} IST{mcx ? ` (${underlying}, today)` : ''}.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setArmModal(false)} className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300">Cancel</button>
              <button type="button" onClick={() => { setArmModal(false); void post({ action: 'live', on: true }); setReal(true); setRealAck(false); }} className="px-3 py-1.5 rounded-md bg-red-600 text-xs font-bold text-oncolor">Arm for today and switch to REAL</button>
            </div>
          </div>
        </div>
      )}
      {chainOpen && expiry && (
        <LadderOptionChain underlying={underlying} expiry={expiry} selectedStrike={strike} selectedOpt={opt === 'FUT' ? 'CE' : opt}
          onPick={(k, o) => { setStrike(k); setOpt(o); }} onClose={() => setChainOpen(false)} />
      )}
      {settingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-5 flex flex-col gap-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <Settings className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Price Ladder Settings</h3>
                  <p className="text-[10px] text-zinc-400">Trading cutoffs and ladder defaults</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  MCX Trading Cutoff (CRUDEOILM)
                </span>
                <span className="text-xs font-mono font-bold text-amber-300">
                  {data?.state?.settings?.mcxAutoExitTime ?? '23:15'} IST
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Trading cutoff and MIS auto square-off threshold. After this time, new orders and armed levels are rejected ahead of the session close.
              </p>
              <div className="grid grid-cols-4 gap-2 pt-1">
                {(['23:00', '23:15', '23:20', '23:25'] as const).map(time => {
                  const active = (data?.state?.settings?.mcxAutoExitTime ?? '23:15') === time;
                  return (
                    <button
                      key={time}
                      type="button"
                      onClick={() => setCutoff('mcx', time)}
                      className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                        active
                          ? 'border-amber-500/50 bg-amber-500/20 text-amber-300 font-bold ring-1 ring-amber-500/30'
                          : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                      }`}
                    >
                      {time}
                      <span className="text-[10px] font-sans font-normal text-zinc-500">
                        {time === '23:15' ? 'Default' : time === '23:00' ? '11:00 PM' : 'IST'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3 pt-3 border-t border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  NSE Trading Cutoff (Nifty, Bank Nifty & other indices)
                </span>
                <span className="text-xs font-mono font-bold text-amber-300">
                  {data?.state?.settings?.nseAutoExitTime ?? '15:17'} IST
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Trading cutoff and MIS auto square-off for NSE / BSE index options. After this time, new orders and armed levels are rejected ahead of the 15:40 close.
              </p>
              <div className="grid grid-cols-4 gap-2 pt-1">
                {(['15:17', '15:25', '15:35', '15:39'] as const).map(time => {
                  const active = (data?.state?.settings?.nseAutoExitTime ?? '15:17') === time;
                  return (
                    <button
                      key={time}
                      type="button"
                      onClick={() => setCutoff('nse', time)}
                      className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                        active
                          ? 'border-amber-500/50 bg-amber-500/20 text-amber-300 font-bold ring-1 ring-amber-500/30'
                          : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                      }`}
                    >
                      {time}
                      <span className="text-[10px] font-sans font-normal text-zinc-500">
                        {time === '15:17' ? 'Default' : 'IST'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <DefaultsPanel saved={savedDefaults} onChange={changeDefaults} onReset={resetDefaults} onApplyNow={applyDefaultsNow} />

            <div className="pt-3 border-t border-zinc-800 flex justify-end">
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-xs font-semibold text-white hover:bg-zinc-700 transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuoteChip({ label, q }: { label: string; q?: IndexQuote }) {
  const ch = q?.change_pct;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900">
      <span className="text-[10px] font-bold tracking-wider text-zinc-400">{label}</span>
      <span className="font-mono font-bold text-zinc-100">{q?.ltp ? q.ltp.toFixed(2) : '—'}</span>
      {ch != null && <span className={`font-mono ${ch >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{ch >= 0 ? '+' : ''}{ch.toFixed(2)}%</span>}
    </span>
  );
}

function PnlChip({ label, value, title }: { label: string; value: number | null; title: string }) {
  const tone = value == null ? 'text-zinc-400' : value > 0 ? 'text-emerald-400' : value < 0 ? 'text-red-400' : 'text-zinc-200';
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900" title={title}>
      <span className="text-[10px] font-bold tracking-wider text-zinc-400 uppercase">{label}</span>
      <span className={`font-mono font-bold ${tone}`}>{value == null ? '—' : `${value >= 0 ? '+' : '−'}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}</span>
    </span>
  );
}

function BookButton({ icon, label, count, onClick }: { icon: ReactNode; label: string; count?: number | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 ${FOCUS_RING}`}>
      {icon}{label}{count != null && <span className="font-mono text-zinc-400">({count})</span>}
    </button>
  );
}

/** A position's trailing SL: its distance (edit = set, 0 = off), or a button to switch it on at the panel's distance. */
function TrailControl({ s, busy, post, fallback }: { s: LadderSlice; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; fallback: number }) {
  const cur = s.bracket?.trailPts ?? 0;
  const step = s.bracket?.trailMode !== 'distance' && cur > 0;   // an older step trail, kept until changed
  if (!cur) {
    return (
      <button type="button" disabled={busy} onClick={() => void post({ action: 'trail', id: s.id, trailPts: fallback })}
        className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}
        title={`Trail the SL ${fallback} points behind the best level from now on`}>
        Trail {fallback}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" title={step ? `Step trail: ${cur} pts of SL per ${cur} pts of move. Change the distance to switch to continuous trailing.` : `Continuous trailing SL, ${cur} pts behind the best level`}>
      <span className="text-amber-300 text-[11px]">{step ? 'Step' : 'Trail'}</span>
      <NumField label="Trailing SL distance in points" value={cur} min={0} width="w-14" onCommit={v => { if (v !== cur) void post({ action: 'trail', id: s.id, trailPts: v }); }} />
      <button type="button" disabled={busy} onClick={() => void post({ action: 'trail', id: s.id, trailPts: 0 })}
        className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
        Off
      </button>
    </span>
  );
}

function SliceRow({ s, ltp, busy, post, trailPts, onSelect }: { s: LadderSlice; ltp: number | undefined; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; trailPts: number; onSelect?: (s: LadderSlice) => void }) {
  const live = isLive(s);
  const pnl = sliceNowPnl(s, ltp) ?? null;
  const qty = Number(s.filledQty) || s.qty;
  const trig = s.kind === 'xy'
    ? (s.entryLevel ? `${s.contract.underlying}${s.contract.ref ? ' FUT' : ''} ${s.entryDir === 'below' ? '≤' : '≥'} ${s.entryLevel}` : '—')
    : s.stopLimitPrice ? `SL ${s.triggerPrice} → ${s.stopLimitPrice.toFixed(2)}`
      : `${s.orderType === 'SL' ? 'SL ' : ''}${s.limitPrice ?? s.triggerPrice ?? '—'}`;
  const stateClass = s.state === 'unknown' || s.state === 'rejected' ? 'text-red-400 font-bold'
    : s.state === 'open' ? 'text-emerald-400 font-bold' : s.state === 'armed' || s.state === 'working' ? 'text-sky-300' : 'text-zinc-400';
  return (
    <tr className={`border-t border-zinc-900 ${live ? '' : 'opacity-60'}`}>
      <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{timeOf(s.createdAt)}</td>
      <td className="px-2 py-1 whitespace-nowrap"><span className={s.mode === 'real' ? 'font-bold text-red-400' : 'text-zinc-300'}>{s.mode.toUpperCase()}</span> <span className="text-zinc-500">{s.broker}</span></td>
      <td
        onClick={() => onSelect?.(s)}
        title={onSelect ? 'Click to view this contract on the ladder' : undefined}
        className={`px-2 py-1 whitespace-nowrap text-zinc-200 ${onSelect ? 'cursor-pointer hover:text-white hover:underline' : ''}`}
      >
        {s.contract.underlying} {s.contract.expiry.slice(5)} {s.contract.opt === 'FUT' ? 'FUT' : `${s.contract.strike}${s.contract.opt}`} <span className="text-zinc-500">{s.product}</span>
      </td>
      <td className={`px-2 py-1 font-bold ${s.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{s.side}</td>
      <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
        {/* MCX on Dhan: qty is lots, so show the barrels too. */}
        {s.contract.mult ? <>{qty}L <span className="text-zinc-500">({qty * s.contract.mult} bbl)</span></> : <>{qty} <span className="text-zinc-500">({s.lots}L)</span></>}
      </td>
      <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">{trig}</td>
      <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">{s.kind === 'xy' && s.entryY ? s.entryY.toFixed(2) : '—'}</td>
      <td className="px-2 py-1 font-mono font-bold text-zinc-100 whitespace-nowrap">{s.avg ? s.avg.toFixed(2) : '—'}</td>
      <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">{(s.state === 'open' || s.state === 'exiting') && ltp ? ltp.toFixed(2) : '—'}</td>
      <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
        {s.exitAvg ? <>{s.exitAvg.toFixed(2)}{s.closedAt ? <span className="text-zinc-500"> · {timeOf(s.closedAt)}</span> : null}</> : '—'}
      </td>
      <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">
        {s.bracket ? `${s.bracket.tgtPts > 0 ? (s.tgtY ?? `+${s.bracket.tgtPts}`) : 'Cover'} / ${s.slY ?? `-${s.bracket.slPts}`}${s.bracket.trailPts ? ` · T${s.bracket.trailPts}` : ''}` : '—'}
      </td>
      <td className={`px-2 py-1 whitespace-nowrap ${stateClass}`} title={s.note ?? s.exitReason ?? ''}>
        {s.state.toUpperCase()}{s.state === 'closed' && s.exitReason ? <span className="text-zinc-500 font-normal"> · {s.exitReason}</span> : null}
        {s.note && s.state !== 'closed' ? <span className="block text-[10px] font-normal text-zinc-500 max-w-64 truncate">{s.note}</span> : null}
      </td>
      <td className={`px-2 py-1 font-mono ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</td>
      <td className="px-2 py-1 whitespace-nowrap">
        <div className="flex gap-1">
          {(s.state === 'armed' || s.state === 'working') && (
            <button type="button" disabled={busy} onClick={() => void post({ action: 'cancel', id: s.id })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Cancel</button>
          )}
          {s.state === 'open' && (
            <button type="button" disabled={busy} onClick={() => void post({ action: 'exit', id: s.id, pct: 100 })} className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15">Exit</button>
          )}
          {/* Trailing SL, switched on or changed any time: the distance behind the best level (commit on Enter / blur). */}
          {(s.state === 'open' || s.state === 'armed') && s.bracket && (
            <TrailControl s={s} busy={busy} post={post} fallback={trailPts} />
          )}
          {s.state === 'unknown' && (
            <>
              <button type="button" disabled={busy} onClick={() => void post({ action: 'resolve', id: s.id, outcome: 'open' })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white" title="You checked Positions and it is open: track it">It is open</button>
              <button type="button" disabled={busy} onClick={() => void post({ action: 'resolve', id: s.id, outcome: 'flat' })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white" title="You checked Positions and nothing is open">Nothing open</button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Pair mode's own orders & positions (both legs on one row, with each leg's own order status). */
function PairTable({ pairs, ltps, busy, post, trailPts, onSelect, shown, onLots, onRoll }: {
  /** The pairs the ladder is drawing right now (the others get a 'View on ladder' link). */
  shown: ReadonlySet<string>;
  pairs: LadderPair[]; ltps: Record<string, number>; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>;
  trailPts: number; onSelect: (p: LadderPair) => void;
  /** + / − one lot on both legs (the page asks first for a REAL add, as on the ladder). */
  onLots: (p: LadderPair, delta: 1 | -1) => void;
  /** Shift both legs / roll one leg N strikes (the page asks first for a REAL pair). */
  onRoll: (p: LadderPair, legs: 'both' | 'ce' | 'pe', steps: number) => void;
}) {
  const heads: [string, string][] = [
    ['Time', 'When the pair was armed'], ['Mode', ''], ['Pair', ''], ['Side', ''], ['Qty', 'Per leg, in lots'],
    ['Trigger', 'The combined premium (CE + PE) that fires the entry'],
    ['Entry ₹', 'CE fill + PE fill = combined fill'], ['Now ₹', 'Live CE + PE (open pairs)'], ['Exit ₹', 'CE exit + PE exit, with the exit time'],
    ['TGT / SL', 'Bracket target / stop on the combined premium (T = trailing distance)'], ['State', ''],
    ['P&L', 'Both legs: closed at their exits, open at live prices'], ['', ''],
  ];
  const two = (a?: number, b?: number) => (a && b ? `${a.toFixed(2)} + ${b.toFixed(2)} = ${(a + b).toFixed(2)}` : '—');
  return (
    <div className="rounded-lg border border-zinc-800 overflow-x-auto">
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/40">
        <p className="text-xs font-bold text-white">Pair orders &amp; positions <span className="text-zinc-500 font-medium">({pairs.filter(isPairLive).length} live)</span></p>
        {pairs.some(p => p.state === 'armed') && (
          <button type="button" disabled={busy} onClick={() => void post({ action: 'pair', op: 'cancelAll', ids: pairs.filter(p => p.state === 'armed').map(p => p.id) })}
            title="Cancel every armed (not yet fired) pair in this table; open pairs are not touched"
            className={`px-2 py-0.5 rounded border border-zinc-700 text-xs text-zinc-300 hover:text-white disabled:opacity-40 ${FOCUS_RING}`}>Cancel all armed ({pairs.filter(p => p.state === 'armed').length})</button>
        )}
      </div>
      <table className="w-full text-xs">
        <thead className="bg-zinc-800">
          <tr className="text-left">
            {heads.map(([h, t], i) => <th key={`${h}-${i}`} title={t || undefined} className="px-2 py-1.5 text-xs font-bold text-white whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...pairs].reverse().map(p => {
            const live = isPairLive(p);
            const pnl = pairNowPnl(p, ltps) ?? null;
            const ce = p.legs.ce, pe = p.legs.pe;
            const nowCe = ltps[ce.contract.securityId], nowPe = ltps[pe.contract.securityId];
            const mult = ce.contract.mult;
            const stateClass = p.state === 'unknown' || p.state === 'broken' ? 'text-red-400 font-bold'
              : p.state === 'open' ? 'text-emerald-400 font-bold' : p.state === 'armed' || p.state === 'placing' || p.state === 'exiting' || p.state === 'rolling' ? 'text-sky-300' : 'text-zinc-400';
            const holding = p.state === 'open' || p.state === 'broken' || p.state === 'exiting' || p.state === 'rolling';
            const unknownLegs = LEG_KEYS.filter(k => p.legs[k].unknown);
            return (
              <tr key={p.id} className={`border-t border-zinc-900 ${live ? '' : 'opacity-60'}`}>
                <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{timeOf(p.createdAt)}</td>
                <td className="px-2 py-1 whitespace-nowrap"><span className={p.mode === 'real' ? 'font-bold text-red-400' : 'text-zinc-300'}>{p.mode.toUpperCase()}</span> <span className="text-zinc-500">{p.broker}</span></td>
                <td className="px-2 py-1 whitespace-nowrap text-zinc-200">
                  <span onClick={() => onSelect(p)} title="Click to view this pair on the ladder" className="cursor-pointer hover:text-white hover:underline">
                    {ce.contract.underlying} {ce.contract.expiry.slice(5)} {pairName(p)} <span className="text-zinc-500">{p.product}</span>
                  </span>
                  {live && !shown.has(p.id) && <button type="button" onClick={() => onSelect(p)} className="ml-2 text-[10px] text-amber-300 underline font-sans">View on ladder</button>}
                  {/* REAL: each leg's own order, so a one-legged moment is visible as it happens. */}
                  {p.mode === 'real' && p.state !== 'armed' && (
                    <span className="block text-[10px] font-mono text-zinc-400">{LEG_KEYS.map(k => <span key={k} className={`mr-2 ${p.legs[k].unknown || p.legs[k].outside || p.legs[k].entry === 'dead' ? 'text-red-400' : ''}`}>{legStatus(k, p.legs[k])}</span>)}</span>
                  )}
                </td>
                <td className={`px-2 py-1 font-bold ${p.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{p.side}</td>
                <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
                  {mult ? <>{p.qty}L <span className="text-zinc-500">({p.qty * mult} bbl)</span></> : <>{p.qty} <span className="text-zinc-500">({p.lots}L)</span></>}
                </td>
                <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">{p.entryLevel ? `CE+PE ${p.entryDir === 'below' ? '≤' : '≥'} ${p.entryLevel}` : '—'}</td>
                <td className="px-2 py-1 font-mono font-bold text-zinc-100 whitespace-nowrap">{two(ce.avg, pe.avg)}</td>
                <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">{holding ? two(nowCe, nowPe) : '—'}</td>
                <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
                  {ce.exitAvg && pe.exitAvg ? <>{two(ce.exitAvg, pe.exitAvg)}{p.closedAt ? <span className="text-zinc-500"> · {timeOf(p.closedAt)}</span> : null}</>
                    : ce.exitAvg || pe.exitAvg ? `${ce.exitAvg ? `CE ${ce.exitAvg.toFixed(2)}` : ''}${pe.exitAvg ? ` PE ${pe.exitAvg.toFixed(2)}` : ''}` : '—'}
                </td>
                <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">
                  {p.bracket ? `${p.bracket.tgtPts > 0 ? (p.tgtY ?? `±${p.bracket.tgtPts}`) : 'Cover'} / ${p.slY ?? `±${p.bracket.slPts}`}${p.bracket.trailPts ? ` · T${p.bracket.trailPts}` : ''}` : '—'}
                  {p.legSlPct ? (
                    <span className="block text-[10px] text-amber-300" title="Per-leg stop: either leg reaching its level exits both legs">
                      Leg SL {p.legSlPct}%{LEG_KEYS.map(k => { const v = legSlPrice(p, p.legs[k]); return v != null ? ` · ${k.toUpperCase()} ${v.toFixed(2)}` : ''; }).join('')}
                    </span>
                  ) : null}
                </td>
                <td className={`px-2 py-1 whitespace-nowrap ${stateClass}`} title={p.note ?? p.exitReason ?? ''}>
                  {p.state.toUpperCase()}{p.state === 'closed' && p.exitReason ? <span className="text-zinc-500 font-normal"> · {p.exitReason}</span> : null}
                  {p.note && p.state !== 'closed' ? <span className="block text-[10px] font-normal text-zinc-500 max-w-64 truncate">{p.note}</span> : null}
                </td>
                <td className={`px-2 py-1 font-mono ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  <div className="flex gap-1">
                    {p.state === 'armed' && (
                      <button type="button" disabled={busy} onClick={() => void post({ action: 'pair', op: 'cancel', id: p.id })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Cancel</button>
                    )}
                    {(p.state === 'open' || p.state === 'broken') && (
                      <button type="button" disabled={busy || !!p.exitWanted} onClick={() => void post({ action: 'pair', op: 'exit', id: p.id })}
                        title={p.state === 'broken' ? 'Exit what is left of this pair at market' : 'Exit both legs at market'}
                        className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15 disabled:opacity-40">
                        {p.exitWanted ? 'Exiting…' : p.state === 'broken' ? 'Exit remaining' : 'Exit both'}
                      </button>
                    )}
                    {/* UNKNOWN: the user checks Orders / Positions and says what each unknown leg really is. */}
                    {p.state === 'unknown' && unknownLegs.map(k => (
                      <span key={k} className="inline-flex items-center gap-1">
                        <span className="text-[10px] font-bold text-red-400">{k.toUpperCase()}</span>
                        <button type="button" disabled={busy} onClick={() => void post({ action: 'pair', op: 'resolve', id: p.id, leg: k, outcome: 'open' })}
                          title={p.legs[k].unknown === 'entry' ? 'You checked Positions: this leg filled — track it' : 'You checked Positions: this leg is still open — send its exit again'}
                          className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">It is open</button>
                        <button type="button" disabled={busy} onClick={() => void post({ action: 'pair', op: 'resolve', id: p.id, leg: k, outcome: 'flat' })}
                          title={p.legs[k].unknown === 'entry' ? 'You checked Positions: nothing opened on this leg' : 'You checked Positions: this leg is closed'}
                          className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Nothing open</button>
                      </span>
                    ))}
                    {p.state === 'open' && (
                      <span className="inline-flex rounded border border-zinc-700 overflow-hidden">
                        <button type="button" disabled={busy} onClick={() => onLots(p, 1)} title="Add 1 lot to both legs at market (joins this pair's target / SL)" aria-label={`Add 1 lot to ${pairName(p)}`}
                          className="px-1.5 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40">+1</button>
                        <button type="button" disabled={busy} onClick={() => onLots(p, -1)} title="Exit 1 lot of both legs at market" aria-label={`Exit 1 lot of ${pairName(p)}`}
                          className="px-1.5 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-800 border-l border-zinc-700 disabled:opacity-40">−1</button>
                      </span>
                    )}
                    {p.state === 'open' && <PairRollControl p={p} busy={busy} onRoll={onRoll} />}
                    {(p.state === 'open' || p.state === 'armed') && (
                      <span className="inline-flex items-center gap-1" title="Per-leg stop %: either leg moving this far against its own fill exits both legs (0 = off)">
                        <span className="text-[11px] text-zinc-400">Leg SL%</span>
                        <NumField label="Per-leg stop-loss percent (0 = off)" value={p.legSlPct ?? 0} min={0} max={1000} step={5} width="w-14"
                          onCommit={v => { if (v !== (p.legSlPct ?? 0)) void post({ action: 'pair', op: 'legsl', id: p.id, legSlPct: Math.round(v) }); }} />
                      </span>
                    )}
                    {(p.state === 'open' || p.state === 'armed') && p.bracket && <PairTrailControl p={p} busy={busy} post={post} fallback={trailPts} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One REAL leg's order status, short: "CE 65 @ 120.50", "PE rejected", "CE UNKNOWN", "PE exit sent". */
function legStatus(k: PairLegKey, l: PairLeg): string {
  const K = k.toUpperCase();
  if (l.unknown) return `${K} UNKNOWN (${l.unknown})`;
  if (l.entry === 'dead') return `${K} rejected${l.note ? `: ${l.note}` : ''}`;
  if (l.entry === 'sent') return `${K} sent`;
  if (l.exitOrderId || l.exitSentAt) return `${K} exit sent`;
  const held = l.held ?? 0;
  const bits = [held > 0 ? `${held} held` : (l.exitedQty ?? 0) > 0 ? 'flat' : '', l.avg ? `@ ${l.avg.toFixed(2)}` : '', l.outside ? '(closed outside)' : ''].filter(Boolean);
  return `${K} ${bits.join(' ') || '—'}`;
}

/** Shift both legs / roll one leg of an open pair N strikes up (+) or down (−). */
function PairRollControl({ p, busy, onRoll }: { p: LadderPair; busy: boolean; onRoll: (p: LadderPair, legs: 'both' | 'ce' | 'pe', steps: number) => void }) {
  const [legs, setLegs] = useState<'both' | 'ce' | 'pe'>('both');
  const [steps, setSteps] = useState(1);
  const btn = `px-1.5 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40 ${FOCUS_RING}`;
  return (
    <span className="inline-flex items-center gap-1" title="Shift both legs, or roll one leg, by N strikes: the old leg closes first, then the new strike opens">
      <select aria-label="What to roll" value={legs} onChange={e => setLegs(e.target.value as 'both' | 'ce' | 'pe')}
        className="px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-200">
        <option value="both">Shift</option>
        <option value="ce">Roll CE</option>
        <option value="pe">Roll PE</option>
      </select>
      <NumField label="Strikes to roll" value={steps} min={1} max={20} width="w-12" onCommit={v => setSteps(Math.max(1, Math.min(20, Math.round(v))))} />
      <span className="inline-flex rounded border border-zinc-700 overflow-hidden">
        <button type="button" disabled={busy} className={btn} aria-label={`${legs === 'both' ? 'Shift' : `Roll ${legs.toUpperCase()}`} up ${steps} strike(s)`} title={`Up ${steps} strike(s)`} onClick={() => onRoll(p, legs, steps)}>↑</button>
        <button type="button" disabled={busy} className={`${btn} border-l border-zinc-700`} aria-label={`${legs === 'both' ? 'Shift' : `Roll ${legs.toUpperCase()}`} down ${steps} strike(s)`} title={`Down ${steps} strike(s)`} onClick={() => onRoll(p, legs, -steps)}>↓</button>
      </span>
    </span>
  );
}

/** A pair's continuous trailing SL (combined-premium points): edit = set, 0 / Off = off. */
function PairTrailControl({ p, busy, post, fallback }: { p: LadderPair; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; fallback: number }) {
  const cur = p.bracket?.trailPts ?? 0;
  const send = (trailPts: number) => void post({ action: 'pair', op: 'trail', id: p.id, trailPts });
  if (!cur) {
    return (
      <button type="button" disabled={busy} onClick={() => send(fallback)} title={`Trail the SL ${fallback} points of combined premium behind the best level from now on`}
        className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
        Trail {fallback}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" title={`Continuous trailing SL, ${cur} pts of combined premium behind the best level`}>
      <span className="text-amber-300 text-[11px]">Trail</span>
      <NumField label="Pair trailing SL distance in points" value={cur} min={0} width="w-14" onCommit={v => { if (v !== cur) send(v); }} />
      <button type="button" disabled={busy} onClick={() => send(0)} className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}>Off</button>
    </span>
  );
}


/** The baskets (armed, open and finished today) of this ladder: what each is, where it entered, its P&L, and its Cancel / Exit. */
function BasketTable({ baskets, ltps, busy, post, shown, onSelect }: { baskets: LadderBasket[]; ltps: Record<string, number>; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; shown: ReadonlySet<string>; onSelect: (b: LadderBasket) => void }) {
  const heads = ['Time', 'Mode', 'Basket', 'Side', 'Lots', 'Legs', 'Trigger', 'Entry net', 'Now net', 'TGT / SL', 'State', 'P&L', ''];
  return (
    <div className="rounded-lg border border-zinc-800 overflow-x-auto">
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/40">
        <p className="text-xs font-bold text-white">Basket orders &amp; positions <span className="text-zinc-500 font-medium">({baskets.filter(isBasketLive).length} live)</span></p>
        {baskets.some(b => b.state === 'armed') && (
          <button type="button" disabled={busy} onClick={() => void post({ action: 'basket', op: 'cancelAll', ids: baskets.filter(b => b.state === 'armed').map(b => b.id) })}
            title="Cancel every armed (not yet fired) basket in this table; open baskets are not touched"
            className={`px-2 py-0.5 rounded border border-zinc-700 text-xs text-zinc-300 hover:text-white disabled:opacity-40 ${FOCUS_RING}`}>Cancel all armed ({baskets.filter(b => b.state === 'armed').length})</button>
        )}
      </div>
      <table className="w-full text-xs">
        <thead className="bg-zinc-800">
          <tr className="text-left">{heads.map((h, i) => <th key={`${h}-${i}`} className="px-2 py-1.5 text-xs font-bold text-white whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody>
          {[...baskets].reverse().map(b => {
            const live = isBasketLive(b);
            const pnl = basketNowPnl(b, ltps) ?? null;
            let now: number | null = null;
            { let v = 0, ok = true; for (const l of b.legs) { const px = ltps[l.contract.securityId]; if (!(px > 0)) { ok = false; break; } v += (l.side === 'BUY' ? 1 : -1) * l.ratio * px; } if (ok) now = Math.round((b.side === 'BUY' ? v : -v) * 100) / 100; }
            const stateClass = b.state === 'open' ? 'text-emerald-400 font-bold' : b.state === 'armed' || b.state === 'exiting' || b.state === 'placing' ? 'text-sky-300' : b.state === 'unknown' || b.state === 'broken' ? 'text-red-400 font-bold' : 'text-zinc-400';
            const unknownLegs = b.legs.filter(l => l.unknown);
            return (
              <tr key={b.id} className={`border-t border-zinc-900 ${live ? '' : 'opacity-60'}`}>
                <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{timeOf(b.createdAt)}</td>
                <td className="px-2 py-1">{b.mode === 'real' ? <span className="text-red-400 font-bold">REAL</span> : 'SIM'}</td>
                <td className="px-2 py-1 font-mono whitespace-nowrap" title={basketName(b)}>{basketName(b)}{live && !shown.has(b.id) && <button type="button" onClick={() => onSelect(b)} className="ml-2 text-[10px] text-amber-300 underline font-sans">View on ladder</button>}</td>
                <td className={`px-2 py-1 font-bold ${b.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`} title={b.side === 'SELL' ? 'Receives the net premium' : 'Pays the net premium'}>{b.side}</td>
                <td className="px-2 py-1 font-mono">{b.lots}</td>
                <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{b.legs.map(l => `${l.side === 'BUY' ? '+' : '−'}${l.contract.strike}${l.contract.opt}${l.ratio > 1 ? `×${l.ratio}` : ''}`).join(' ')}</td>
                <td className="px-2 py-1 font-mono whitespace-nowrap">{b.entryLevel ? `net ${b.entryDir === 'below' ? '≤' : '≥'} ${b.entryLevel}` : '—'}</td>
                <td className="px-2 py-1 font-mono">{b.entryY ? b.entryY.toFixed(2) : '—'}</td>
                <td className="px-2 py-1 font-mono">{live && b.state !== 'armed' && now != null ? now.toFixed(2) : '—'}</td>
                <td className="px-2 py-1 font-mono whitespace-nowrap">{b.tgtY != null || b.slY != null ? `${b.tgtY != null ? b.tgtY.toFixed(2) : '—'} / ${b.slY != null ? b.slY.toFixed(2) : '—'}${b.bracket?.trailPts ? ` (T${b.bracket.trailPts})` : ''}` : '—'}</td>
                <td className={`px-2 py-1 ${stateClass}`}>{b.state.toUpperCase()}{b.state === 'closed' && b.exitReason ? <span className="text-zinc-500 font-normal"> · {b.exitReason}</span> : null}{b.note && b.state !== 'closed' ? <span className="block text-[10px] font-normal text-zinc-500 max-w-64 truncate">{b.note}</span> : null}</td>
                <td className={`px-2 py-1 font-mono ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {b.state === 'armed' && <button type="button" disabled={busy} onClick={() => void post({ action: 'basket', op: 'cancel', id: b.id })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Cancel</button>}
                  {(b.state === 'open' || b.state === 'broken') && <button type="button" disabled={busy || !!b.exitWanted} onClick={() => void post({ action: 'basket', op: 'exit', id: b.id })} title={b.state === 'broken' ? 'Exit what is left of this basket at market' : 'Exit every leg at market (shorts first)'}
                    className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15 disabled:opacity-40">{b.exitWanted ? 'Exiting…' : b.state === 'broken' ? 'Exit remaining' : 'Exit all legs'}</button>}
                  {/* UNKNOWN: the user checks Orders / Positions and says what each unknown leg really is. */}
                  {b.state === 'unknown' && unknownLegs.map(l => (
                    <span key={l.key} className="inline-flex items-center gap-1 mr-2" title={`${l.contract.strike}${l.contract.opt}: ${l.unknown} order outcome unknown`}>
                      <span className="font-mono text-zinc-300">{l.contract.strike}{l.contract.opt}</span>
                      <button type="button" disabled={busy} onClick={() => void post({ action: 'basket', op: 'resolve', id: b.id, leg: l.key, outcome: 'open' })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Is open</button>
                      <button type="button" disabled={busy} onClick={() => void post({ action: 'basket', op: 'resolve', id: b.id, leg: l.key, outcome: 'flat' })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Is flat</button>
                    </span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
