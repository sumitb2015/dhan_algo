'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import NavBar from './NavBar';
import { Zap, RefreshCw, Shield, ShieldOff, ChevronDown, ChevronUp, Wallet } from 'lucide-react';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useProfitLock, ProfitLockControls } from './ProfitLock';
import { useCopyTrade, CopyTradeControls } from './CopyTrade';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { contractMultiplier, scaleBrokerPnl } from '@/lib/positionPnl';
import { partialCloseChips } from '@/lib/partialQty';
import { positionKey, positionProduct, findLivePosition, closeOrderProduct } from '@/lib/positionProduct';
import { cn } from '@/lib/utils';

// Visible keyboard-only focus ring for every clickable control on this page and
// on AdvancedScalper.tsx (which imports this rather than redefining it, since
// both pages share OptionPanel/PositionsTable/TabTable/FundsView already).
// `focus-visible` (not `focus`) keeps mouse clicks silent. Mirrors FocusTool.tsx's
// own FOCUS_RING, which stays file-local there since nothing else imports it.
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

// Micro-type scale for this page's dense control/label text — the three sizes
// already in use here, named once. No text-[8px] tier exists in this file
// (unlike FocusTool's TXT_MICRO), so only three are defined.
export const TXT_LABEL   = 'text-[9px]';  // field labels, badges — default micro size
export const TXT_VALUE   = 'text-[10px]'; // secondary readouts, most of this file's micro text
export const TXT_CAPTION = 'text-[11px]'; // switch labels, nuclear-action buttons

/**
 * Turns a Target/SL pair — two numbers with no visual relationship today —
 * into one bar: rose from -SL to 0, emerald from 0 to +Target, and a marker
 * at the current total. Mirrors FocusTool.tsx's RiskRail, minus the trail
 * lock floor tick (this page's P&L Guard has no trail concept). Exported so
 * AdvancedScalper.tsx's own Guard bar can reuse it rather than redefining it.
 * The exact numbers stay as text next to the bar — on a real-money page the
 * figure matters more than the visual, so the bar is supplementary.
 */
export function RiskRail({ totalPnl, target, stop }: {
  totalPnl: number; target: number | null; stop: number | null;
}) {
  const hasTarget = target != null && target > 0;
  const hasStop = stop != null && stop > 0;
  const fmt = (v: number) => `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  if (!hasTarget && !hasStop) {
    return <div className="h-1.5 w-24 rounded-full bg-zinc-800 shrink-0" title="Set a Target or SL to see it plotted here" />;
  }
  const lo = hasStop ? -(stop as number) : Math.min(totalPnl, 0) * 1.2 || -1;
  const hi = hasTarget ? (target as number) : Math.max(totalPnl, 0) * 1.2 || 1;
  if (!(hi > lo)) {
    return <div className="h-1.5 w-24 rounded-full bg-zinc-800 shrink-0" />;
  }
  const pct = (v: number) => ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100;
  const zero = pct(0);
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div
        className="relative h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden"
        title={`SL ${hasStop ? fmt(-(stop as number)) : '—'} · Target ${hasTarget ? fmt(target as number) : '—'} · Total ${fmt(totalPnl)}`}
      >
        <div className="absolute inset-y-0 bg-rose-500/25" style={{ left: 0, width: `${zero}%` }} />
        <div className="absolute inset-y-0 bg-emerald-500/25" style={{ left: `${zero}%`, width: `${100 - zero}%` }} />
        <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: `${zero}%` }} />
        <div
          className={cn('absolute -top-0.5 h-2.5 w-0.5 rounded-full', totalPnl >= 0 ? 'bg-emerald-400' : 'bg-rose-400')}
          style={{ left: `${pct(totalPnl)}%` }}
        />
      </div>
      <span className={cn(TXT_VALUE, 'font-mono text-zinc-500 whitespace-nowrap')}>{fmt(totalPnl)}</span>
    </div>
  );
}

/**
 * A live premium's trend over the last ~60-90s — a scalper reads momentum,
 * not just level. Unlike FocusTool.tsx's Sparkline (which reads history
 * sampled externally into a ref by its one parent), this one owns its own
 * sampling: OptionPanel is rendered by both Scalper.tsx and
 * AdvancedScalper.tsx, so a self-contained component that only needs the
 * current `value`/`trendValue` as plain number props — and samples them into
 * its own ref on its own interval — avoids making every parent implement the
 * same sampling ref independently. Colored by the sign of `trendValue`'s own
 * trend (the row's P&L, when available) rather than the plotted value's
 * direction, since a rising premium can mean the position is winning (long)
 * or losing (short) depending on side. Renders nothing until 2+ samples.
 */
function Sparkline({ value, trendValue }: { value: number; trendValue?: number }) {
  // Write-only "keep fresh for the interval closure" refs, synced from an
  // effect rather than assigned during render (unsafe under React's rules).
  // The sampled series themselves live in state, not refs — reading a ref's
  // .current during render is unsafe.
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  const trendValueRef = useRef(trendValue);
  useEffect(() => { trendValueRef.current = trendValue; }, [trendValue]);
  const [history, setHistory] = useState<number[]>([]);
  const [trend, setTrend] = useState<number[]>([]);
  useEffect(() => {
    const id = setInterval(() => {
      if (valueRef.current > 0) {
        setHistory(h => (h.length >= 50 ? [...h.slice(1), valueRef.current] : [...h, valueRef.current]));
      }
      if (trendValueRef.current != null) {
        const tv = trendValueRef.current;
        setTrend(t => (t.length >= 50 ? [...t.slice(1), tv] : [...t, tv]));
      }
    }, 1500);
    return () => clearInterval(id);
  }, []);
  // OptionPanel (this component's only parent, in both Scalper.tsx and
  // AdvancedScalper.tsx) re-renders on every WS tick since it needs the live
  // `value`/`trendValue` — but `history`/`trend` only actually change every
  // 1.5s via the sampling interval above, so the min/max/points work is
  // memoized to run once per real data change, not once per tick.
  const pts = useMemo(() => {
    if (history.length < 2) return null;
    const w = 64, h = 18;
    const min = Math.min(...history), max = Math.max(...history);
    const span = max - min || 1;
    return history.map((v, i) =>
      `${(i / (history.length - 1)) * w},${h - ((v - min) / span) * h}`).join(' ');
  }, [history]);
  if (!pts) return null;
  const w = 64, h = 18;
  const trendGood = trend.length >= 2 ? trend[trend.length - 1] >= trend[0] : null;
  const colorClass = trendGood == null ? 'text-zinc-500' : trendGood ? 'text-emerald-400' : 'text-rose-400';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={cn(colorClass, 'inline-block')} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
    </svg>
  );
}

// A MARKET close order being accepted by the broker doesn't guarantee it filled.
// Polls the live positions book a few times so callers that chain a follow-up
// action (e.g. strike shift opening the new leg) can confirm the symbol is
// actually flat before proceeding — instead of assuming success from order
// acceptance alone. Not used on the hot SL/target/manual-close paths, where
// the extra round trips would add latency scalping can't afford.
// Polls the live book until `accept(absNetQty)` holds, resolving the observed
// absolute netQty — or null on timeout. A missing row counts as flat (0).
// `ref` identifies WHICH book to watch — it must carry the same product as the
// position being closed, or the poll reads the other product's row and can
// report a leg flat while it is still fully open.
async function pollPositionQty(
  broker: Broker,
  ref: Record<string, unknown>,
  accept: (absNetQty: number) => boolean,
  attempts = 4,
  delayMs = 500,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    try {
      const res = await fetch(scalperRoute(broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      if (j.success && j.data) {
        const found = findLivePosition(j.data, ref);
        // An ambiguous book is inconclusive, not flat — retry rather than
        // reporting a close that may not have happened.
        if (found.kind === 'ambiguous') continue;
        const abs = found.kind === 'match' ? Math.abs(Number(found.row.netQty) || 0) : 0;
        if (accept(abs)) return abs;
      }
    } catch {
      // treat as inconclusive, retry
    }
  }
  return null;
}

export async function pollPositionFlat(broker: Broker, ref: Record<string, unknown>, attempts = 4, delayMs = 500): Promise<boolean> {
  return (await pollPositionQty(broker, ref, abs => abs === 0, attempts, delayMs)) !== null;
}

// Partial-close counterpart: succeeds as soon as the book shows the leg has
// shrunk by at least `minReduction` units, and resolves how much actually left
// (which can exceed the request if something else closed concurrently). null
// means the reduction was never observed — callers that chain a follow-up open
// must treat that as a failure rather than sizing off a guess.
export async function pollPositionReduced(
  broker: Broker,
  ref: Record<string, unknown>,
  prevAbs: number,
  minReduction: number,
  attempts = 4,
  delayMs = 500,
): Promise<number | null> {
  const observed = await pollPositionQty(broker, ref, abs => prevAbs - abs >= minReduction, attempts, delayMs);
  return observed === null ? null : prevAbs - observed;
}

// ─── Types ────────────────────────────────────────────────────────

export interface OptionSide {
  ltp: number; oi: number; volume: number; high?: number; low?: number; open?: number; prev_close?: number; change?: number; change_pct?: number;
  /** Prev-day OI change % and 4-way buildup label ('LB'|'SB'|'SC'|'LU'|'') from the WS bridge */
  oi_chg_pct?: number; buildup?: string;
}
export interface StrikeData  { strike: number; ce: OptionSide; pe: OptionSide }

export interface LiveQuotes {
  updated_at: string | null;
  underlying?: string;
  expiry?: string;
  spot: number;
  spot_change?: number;
  spot_change_pct?: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
}

export interface BridgeStatus {
  status: 'RUNNING' | 'STOPPED' | 'STARTING' | 'ERROR';
  pid?: number;
  subscribed?: number;
}

export interface ChainOcEntry {
  ce?: { last_price?: number; previous_close?: number; previous_close_price?: number };
  pe?: { last_price?: number; previous_close?: number; previous_close_price?: number };
}

export interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
  detail?: string;
}

export interface PnlGuardStatus {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE' | string;
  profit?: number;
  loss?: number;
  productType?: string[];
  enableKillSwitch?: boolean;
}

export interface PositionGuard {
  target: string;        // take-profit price (₹)
  sl: string;            // stop-loss price (₹); also the anchor for trailing SL
  trailEnabled: boolean; // checkbox: trail SL 1:1 with profit from the configured SL level
  bestPrice: number;     // best price achieved (max LTP for long, min LTP for short); 0 = not yet set
  triggered: boolean;    // prevents double-fire while order is in flight
}

// ─── Helpers ──────────────────────────────────────────────────────

export function fmtLTP(n: number): string {
  return n > 0
    ? `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
}

function fmtOI(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n > 0 ? n.toLocaleString('en-IN') : '—';
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
const STRIKE_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 };

// ─── Main Component ───────────────────────────────────────────────

export default function Scalper() {
  // Underlying
  const [underlying, setUnderlying] = useState<typeof UNDERLYINGS[number]>('NIFTY');
  const strikeStep = STRIKE_STEP[underlying] ?? 50;

  // Expiry
  const [expiries, setExpiries]   = useState<string[]>([]);
  const [expiry, setExpiry]       = useState('');

  // Chain data (one-time fetch per expiry for prev close + strike list)
  const [allStrikes, setAllStrikes]     = useState<number[]>([]);
  const [prevClose, setPrevClose]       = useState<Record<string, { ce: number; pe: number }>>({});
  const [chainSpot, setChainSpot]       = useState(0);
  const [prevSpot, setPrevSpot]         = useState(0);

  // Security ID map per strike — enables fast-order (no Python per order)
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }>>({});
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  // null until the lookup resolves it from DhanHelper.get_lot_size(). Never seed
  // this with a literal: exchange lot sizes get revised (NIFTY has been 75 and is
  // 65 today), and a seeded value is indistinguishable from a resolved one — it
  // would size real orders against a stale number, and would carry the previous
  // underlying's lot across a NIFTY→SENSEX switch.
  const [lotSize, setLotSize]       = useState<number | null>(null);

  // Orders in flight, keyed by side — blocks double-fire and gates the Buy/Sell
  // buttons until strikeMap is loaded (avoids a silent fallback to the slow
  // Python order path right after an expiry switch).
  const [orderPending, setOrderPending] = useState<Set<'CE' | 'PE'>>(new Set());
  const orderInFlightRef = useRef<Set<'CE' | 'PE'>>(new Set());

  // Live data: direct WebSocket to the Python bridge (HTTP polling fallback)
  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying);

  // Trading controls
  const [lots, setLots]           = useState(1);
  const [orderMode, setOrderMode] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [ceStrike, setCeStrike]   = useState<number | null>(null);
  const [peStrike, setPeStrike]   = useState<number | null>(null);
  const [ceLimitPrice, setCeLimitPrice] = useState('');
  const [peLimitPrice, setPeLimitPrice] = useState('');

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Exit-all confirm-arm
  const [confirmExitAll, setConfirmExitAll] = useState(false);
  const [exitingAll, setExitingAll] = useState(false);

  // Bottom tabs
  const [activeTab, setActiveTab]       = useState<'positions' | 'orders' | 'trades' | 'funds'>('positions');
  const [positionsData, setPositionsData] = useState<Record<string, unknown>[]>([]);
  const [ordersData, setOrdersData]       = useState<Record<string, unknown>[]>([]);
  const [tradesData, setTradesData]       = useState<Record<string, unknown>[]>([]);
  const [fundsData, setFundsData]         = useState<Record<string, any> | null>(null);
  const [tabLoading, setTabLoading]       = useState(false);
  const [tableSort, setTableSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'none', dir: 'asc' });
  const handleTableSort = useCallback((key: string) => {
    setTableSort(prev => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }));
  }, []);

  // P&L Guard
  const [pnlGuardStatus, setPnlGuardStatus]   = useState<PnlGuardStatus | null>(null);
  const [profitTarget, setProfitTarget]       = useState('');
  const [lossLimit, setLossLimit]             = useState('');
  const [guardProductTypes, setGuardProductTypes] = useState<string[]>(['INTRADAY']);
  const [enableKillSwitch, setEnableKillSwitch]   = useState(false);
  const [settingPnl, setSettingPnl]     = useState(false);
  const [clearingPnl, setClearingPnl]   = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [guardError, setGuardError]     = useState('');

  // Per-position guards (target / SL / trailing SL)
  // Keyed by lib/positionProduct's `positionKey` — (symbol, product), not symbol
  // alone: the same strike can be open under both INTRADAY and MARGIN, and those
  // are two positions that must be guarded and closed independently.
  const [posGuards, setPosGuards] = useState<Record<string, PositionGuard>>({});
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());

  // Refs for guard monitor interval — avoids stale closures
  const positionsRef = useRef<Record<string, unknown>[]>([]);
  const posGuardsRef = useRef<Record<string, PositionGuard>>({});
  // Synchronous re-entrancy lock: React state updates are async, so the guard
  // loop and a manual Close click can both enter closePosition before either
  // sees the other's `triggered`/`closingPositions` update.
  const closingInFlightRef = useRef<Set<string>>(new Set());
  // Tracks the latest expiry so an out-of-order lookup response can detect it's stale
  const expiryRef = useRef('');
  useEffect(() => { expiryRef.current = expiry; }, [expiry]);

  // ─── Derived values ──────────────────────────────────────────────

  const spot = liveQuotes?.spot ?? chainSpot;
  const atm  = spot > 0 ? Math.round(spot / strikeStep) * strikeStep : 0;

  const visibleStrikes = useMemo(() => {
    if (!allStrikes.length) return allStrikes;
    if (atm === 0) return allStrikes.slice(0, 21);
    const idx = allStrikes.reduce((best, sk, i) =>
      Math.abs(sk - atm) < Math.abs(allStrikes[best] - atm) ? i : best, 0);
    return allStrikes.slice(Math.max(0, idx - 10), idx + 11);
  }, [allStrikes, atm]);

  const ceLtp = ceStrike != null ? (liveQuotes?.strikes?.[String(ceStrike)]?.ce?.ltp ?? 0) : 0;
  const peLtp = peStrike != null ? (liveQuotes?.strikes?.[String(peStrike)]?.pe?.ltp ?? 0) : 0;

  const ceHigh = ceStrike != null ? (liveQuotes?.strikes?.[String(ceStrike)]?.ce?.high ?? 0) : 0;
  const ceLow  = ceStrike != null ? (liveQuotes?.strikes?.[String(ceStrike)]?.ce?.low ?? 0) : 0;
  const peHigh = peStrike != null ? (liveQuotes?.strikes?.[String(peStrike)]?.pe?.high ?? 0) : 0;
  const peLow  = peStrike != null ? (liveQuotes?.strikes?.[String(peStrike)]?.pe?.low ?? 0) : 0;

  const ceBuildup = ceStrike != null ? (liveQuotes?.strikes?.[String(ceStrike)]?.ce?.buildup ?? '') : '';
  const peBuildup = peStrike != null ? (liveQuotes?.strikes?.[String(peStrike)]?.pe?.buildup ?? '') : '';
  const ceOiChgPct = ceStrike != null ? (liveQuotes?.strikes?.[String(ceStrike)]?.ce?.oi_chg_pct ?? 0) : 0;
  const peOiChgPct = peStrike != null ? (liveQuotes?.strikes?.[String(peStrike)]?.pe?.oi_chg_pct ?? 0) : 0;

  const cePrevClose = ceStrike != null ? (prevClose[String(ceStrike)]?.ce ?? liveQuotes?.strikes?.[String(ceStrike)]?.ce?.prev_close ?? 0) : 0;
  const pePrevClose = peStrike != null ? (prevClose[String(peStrike)]?.pe ?? liveQuotes?.strikes?.[String(peStrike)]?.pe?.prev_close ?? 0) : 0;
  const cePct = (ceLtp > 0 && cePrevClose > 0) ? ((ceLtp - cePrevClose) / cePrevClose) * 100 : (liveQuotes?.strikes?.[String(ceStrike!)]?.ce?.change_pct ?? null);
  const pePct = (peLtp > 0 && pePrevClose > 0) ? ((peLtp - pePrevClose) / pePrevClose) * 100 : (liveQuotes?.strikes?.[String(peStrike!)]?.pe?.change_pct ?? null);

  // True once the lookup for the current expiry has returned security IDs —
  // gates ordering so a click can never silently fall back to the slow
  // Python order path (strikeMap is reset to {} on every expiry change).
  const strikesReady = Object.keys(strikeMap).length > 0;

  const secIdToStrikeSide = useMemo(() => {
    const map: Record<string, { strike: number; side: 'ce' | 'pe' }> = {};
    for (const [strike, ids] of Object.entries(strikeMap)) {
      if (ids.ceId) map[ids.ceId] = { strike: Number(strike), side: 'ce' };
      if (ids.peId) map[ids.peId] = { strike: Number(strike), side: 'pe' };
    }
    return map;
  }, [strikeMap]);

  // Dhan's /positions endpoint occasionally reports realizedProfit=0 for a
  // fully-closed position even though buyQty/sellQty/buyAvg/sellAvg show a
  // real matched profit (observed on NIFTY-Jul2026-23900-PE: buyQty=sellQty=195,
  // buyAvg=4.7, sellAvg=8.2 => realized should be 682.5, API returned 0).
  // For any position that's flat (netQty === 0), recompute realizedProfit
  // from buyQty/sellQty/buyAvg/sellAvg instead of trusting the field as-is.
  const realizedFixedPositions = useMemo(() => {
    return positionsData.map(pos => {
      const netQty = Number(pos.netQty);
      const mult   = contractMultiplier(pos);

      // Dhan reports MCX P&L unscaled by barrels-per-lot (see scaleBrokerPnl). Rescale before
      // anything below reads it - the LTP back-calculation divides by that same multiplier, so
      // an unscaled figure derives an LTP a hundredth of the way back from the entry price.
      const row = scaleBrokerPnl(pos, mult);

      // ── LTP fallback: Dhan's /positions v2 API omits lastTradedPrice.
      // Back-calculate from unrealizedProfit so the table shows a value
      // even before the live WS bridge enriches the row, and for positions
      // on expiries / segments the bridge isn't watching.
      const brokerLtp = Number(row.lastTradedPrice);
      let withLtp: typeof pos = row;
      if ((!brokerLtp || !Number.isFinite(brokerLtp)) && netQty !== 0) {
        const unrealized = Number(row.unrealizedProfit);
        const buyAvg     = Number(row.buyAvg);
        const sellAvg    = Number(row.sellAvg);
        if (Number.isFinite(unrealized) && mult > 0) {
          const derivedLtp = netQty > 0
            ? buyAvg  + unrealized / (netQty  * mult)
            : sellAvg - unrealized / (Math.abs(netQty) * mult);
          if (Number.isFinite(derivedLtp) && derivedLtp > 0) {
            withLtp = { ...row, lastTradedPrice: derivedLtp };
          }
        }
      }

      // ── realizedProfit=0-on-flat-position fix
      if (netQty !== 0) return withLtp;

      const buyQty  = Number(pos.buyQty);
      const sellQty = Number(pos.sellQty);
      const buyAvgF = Number(pos.buyAvg);
      const sellAvgF = Number(pos.sellAvg);
      if (!buyQty || !sellQty) return withLtp;

      const recomputedRealized = mult * (sellQty * sellAvgF - buyQty * buyAvgF);
      if (Number(row.realizedProfit) === recomputedRealized) return withLtp;

      return { ...withLtp, realizedProfit: recomputedRealized };
    });
  }, [positionsData]);

  const enrichedPositions = useMemo(() => {
    if (!liveQuotes?.strikes || Object.keys(secIdToStrikeSide).length === 0)
      return realizedFixedPositions;

    return realizedFixedPositions.map(pos => {
      const secId = String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
      const mapping = secIdToStrikeSide[secId];
      if (!mapping) return pos;

      const strikeData = liveQuotes.strikes[String(mapping.strike)];
      if (!strikeData) return pos;

      const liveLtp = strikeData[mapping.side]?.ltp ?? 0;
      if (liveLtp <= 0) return pos;

      const netQty = Number(pos.netQty);
      const buyAvg = Number(pos.buyAvg);
      const sellAvg = Number(pos.sellAvg);
      const mult = contractMultiplier(pos);
      const unrealizedProfit = netQty === 0
        ? Number(pos.unrealizedProfit)
        : netQty > 0
          ? mult * netQty * (liveLtp - buyAvg)
          : mult * Math.abs(netQty) * (sellAvg - liveLtp);

      return { ...pos, lastTradedPrice: liveLtp, unrealizedProfit };
    });
  }, [realizedFixedPositions, liveQuotes, secIdToStrikeSide]);

  const totalPnl = useMemo(() => enrichedPositions.reduce((sum, p) =>
    sum + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0),
    [enrichedPositions]);

  // Net CE / PE Values & Difference computed strictly from OPEN POSITIONS: short legs add,
  // long legs (hedges) subtract, per side — so a long hedge offsets the shorts on its side
  // instead of inflating the gross total the same way a short would.
  const { totalCEVal, totalPEVal, cePeDiff } = useMemo(() => {
    let ceSum = 0;
    let peSum = 0;

    for (const pos of enrichedPositions) {
      const netQty = Number(pos.netQty);
      if (!netQty || netQty === 0) continue; // Only open positions

      const secId = broker !== 'dhan'
        ? String(pos.tradingSymbol ?? '')
        : String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
      const mapping = secIdToStrikeSide[secId];

      let side: 'CE' | 'PE' | null = mapping ? (mapping.side.toUpperCase() as 'CE' | 'PE') : null;

      // Equity trading symbols can coincidentally end in "CE"/"PE" (e.g. "RELIANCE"),
      // so the symbol-suffix fallback below is only safe to run on F&O positions.
      const segment = String(pos.exchangeSegment ?? pos.exchange ?? '').toUpperCase();
      const isFno = segment.includes('FNO') || segment.includes('FO');

      if (!side && isFno) {
        const optType = String(pos.optionType ?? pos.option_type ?? pos.drvOptionType ?? '').toUpperCase();
        if (optType.includes('CALL') || optType === 'CE') side = 'CE';
        else if (optType.includes('PUT') || optType === 'PE') side = 'PE';
        else {
          const sym = String(pos.tradingSymbol ?? pos.tradingsymbol ?? pos.symbol ?? '').toUpperCase();
          if (/\bCE\b|-CE$/.test(sym)) side = 'CE';
          else if (/\bPE\b|-PE$/.test(sym)) side = 'PE';
        }
      }

      if (!side) continue;

      const ltp = Number(pos.lastTradedPrice) || Number(pos.buyAvg) || Number(pos.sellAvg) || 0;
      // netQty is already a total unit count, so qty * price is rupees directly.
      // Dividing by the selected underlying's `lotSize` would misprice any position
      // on a different underlying (e.g. an open SENSEX leg while NIFTY is selected).
      // Net a long leg against the shorts on the same side (e.g. a far-OTM long
      // hedge sitting alongside short strikes) rather than adding both as gross —
      // otherwise a hedge leg inflates CE/PE Val the same way a short does.
      const val = Math.abs(netQty) * ltp * contractMultiplier(pos);
      const signedVal = netQty > 0 ? -val : val;

      if (side === 'CE') ceSum += signedVal;
      else if (side === 'PE') peSum += signedVal;
    }

    return {
      totalCEVal: ceSum,
      totalPEVal: peSum,
      cePeDiff: ceSum - peSum,
    };
  }, [enrichedPositions, secIdToStrikeSide, broker]);

  // ─── useEffect 1: Load expiries based on broker + underlying ───────

  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        const data = j.data;
        if (j.success && data?.length) {
          setExpiries(data);
          setExpiry(prev => data.includes(prev) ? prev : data[0]);
        }
      })
      .catch(() => {});
  }, [broker, underlying]);

  // ─── useEffect 1a: Load prev-close whenever underlying changes ────

  useEffect(() => {
    fetch(`/api/scalper/nifty-prev-close?underlying=${underlying}`)
      .then(r => r.json())
      .then((j: { success: boolean; prevClose?: number }) => {
        if (j.success && j.prevClose) setPrevSpot(j.prevClose);
      })
      .catch(() => {});
  }, [underlying]);

  // ─── useEffect 1b: Load mount data ───────────────────────────────

  useEffect(() => {
    fetch('/api/pnl-exit')
      .then(r => r.json())
      .then((j: { success: boolean; data?: PnlGuardStatus }) => {
        if (j.success && j.data) setPnlGuardStatus(j.data as PnlGuardStatus);
      })
      .catch(() => {});
  }, []);

  // ─── useEffect 2a: On expiry/underlying change — reset selections ──

  // Keyed on the CONTRACT SET only, deliberately not on `broker`: the same
  // contracts exist at every broker, so switching the selector must never move
  // a panel that has an open leg sitting on its strike.
  useEffect(() => {
    if (!expiry) return;

    // Reset strike state when expiry/underlying changes. chainSpot must be
    // cleared too — NIFTY and SENSEX spot values differ by ~3x magnitude, so
    // leaving the old value in place would briefly show e.g. "SENSEX 25453"
    // (new underlying's label, old underlying's spot) until the chain fetch
    // below resolves.
    setCeStrike(null);
    setPeStrike(null);
    setAllStrikes([]);
    setPrevClose({});
    setStrikeMap({});   // liveQuotes reset is handled inside useLiveOptionsWS
    setChainSpot(0);
    // Lot size belongs to the OUTGOING underlying (NIFTY 65 vs SENSEX 20). Keeping
    // it would size the first order after a switch against the wrong contract.
    setLotSize(null);
  }, [expiry, underlying]);

  // ─── useEffect 2b: Fetch the chain (strike ladder + prev close) ────

  // Broker-scoped, so it must re-run on a broker switch: /api/options/chain
  // serves Dhan from the live option-chain API and the others from their own
  // instrument cache (and 400s on unsupported broker/underlying pairs). Leaving
  // `broker` out left the ladder and prev-close on the previous broker's data
  // while the strikeMap effect below had already re-resolved for the new one.
  useEffect(() => {
    if (!expiry) return;

    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number } }) => {
        if (!j.success || !j.data?.chain?.oc) return;
        const oc = j.data.chain.oc;
        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        setAllStrikes(strikes);

        // Extract prev close for each strike
        const pc: Record<string, { ce: number; pe: number }> = {};
        for (const [sk, entry] of Object.entries(oc)) {
          // Dhan keys the chain by a 6-decimal float string ("23950.000000")
          // but every read below keys by the plain integer strike, so normalise
          // or the prev-close fallback silently never hits.
          pc[String(Number(sk))] = {
            ce: entry.ce?.previous_close_price ?? entry.ce?.previous_close ?? 0,
            pe: entry.pe?.previous_close_price ?? entry.pe?.previous_close ?? 0,
          };
        }
        setPrevClose(pc);

        const spotPrice = j.data.spot ?? 0;
        if (spotPrice > 0) setChainSpot(spotPrice);

        // Default only the strikes that aren't set yet (i.e. right after the
        // reset above) to ATM. A plain re-fetch — which a broker switch now
        // triggers — must leave an existing selection alone, or a panel holding
        // an open leg would silently jump to ATM and stop showing that position.
        if (strikes.length) {
          const atmTarget = spotPrice > 0 ? Math.round(spotPrice / strikeStep) * strikeStep : 0;
          const nearest = atmTarget > 0
            ? strikes.reduce((prev, cur) => Math.abs(cur - atmTarget) < Math.abs(prev - atmTarget) ? cur : prev)
            : strikes[Math.floor(strikes.length / 2)];
          setCeStrike(prev => prev ?? nearest);
          setPeStrike(prev => prev ?? nearest);
        }
      })
      .catch(() => {});
  }, [expiry, underlying, broker, strikeStep]);

  // ─── useEffect 2c: WS bridge lifecycle ────────────────────────────

  useEffect(() => {
    if (!expiry) return;

    // Start a WS bridge for every authenticated broker concurrently — each
    // runs independently on its own port/files (see useLiveOptionsWS), so
    // switching the broker selector never spawns or kills a process. That is
    // also why `broker` is not a dependency here.
    for (const b of authenticatedBrokers) {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 30, broker: b }),
      }).catch(() => {});
    }

    // Cleanup: stop every started bridge when expiry/underlying changes or component unmounts
    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', brokers: authenticatedBrokers }),
      }).catch(() => {});
    };
  }, [expiry, underlying, authenticatedBrokers]);

  // Re-resolves strikeMap (Dhan securityId / Zerodha tradingsymbol per strike)
  // whenever the expiry OR the selected broker changes. Order routing is
  // still broker-specific — only the live-quotes WS bridges (started above)
  // run concurrently for both brokers regardless of selection.
  useEffect(() => {
    if (!expiry) return;

    const requestedExpiry = expiry;
    const lookupUrl = `${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${expiry}`;
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }> } }) => {
        if (requestedExpiry !== expiryRef.current) return;
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          // Only accept a usable lot size. Leaving it null keeps every
          // sizing-dependent control disabled rather than trading on a bad value.
          setLotSize(Number(j.data.lotSize) > 0 ? Number(j.data.lotSize) : null);
        }
      })
      .catch(() => {});
  }, [expiry, broker, underlying]);

  // Live quotes arrive via useLiveOptionsWS (direct WebSocket push from the
  // Python bridge, rAF-coalesced; falls back to 100ms HTTP polling if the WS
  // is unavailable). The old useEffect-3 poll loop lived here.

  // ─── useEffect 4: Poll positions/orders/trades every 2s ──────────

  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    fetch(scalperRoute(broker, 'all'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; funds?: Record<string, any>; pnl_guard?: any }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
          setFundsData(j.funds ?? null);
          setPnlGuardStatus(j.pnl_guard ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setTabLoading(false));
  }, [broker]);

  const pollTabData = useCallback(() => {
    fetch(scalperRoute(broker, 'poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
        }
      })
      .catch(() => {});
  }, [broker]);

  const pollFunds = useCallback(() => {
    fetch(scalperRoute(broker, 'funds'))
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, any> }) => {
        if (j.success) setFundsData(j.data ?? null);
      })
      .catch(() => {});
  }, [broker]);

  useEffect(() => {
    fetchTabData();
    // 2s poll: /api/scalper/poll is now direct Dhan REST (~0.3s round trip,
    // 3 calls per tick = 1.5 req/s), so SL/target detection reacts within ~2s.
    const id = setInterval(pollTabData, 2000);
    // Funds change only on order fills — a 15s refresh keeps the header chip
    // current without adding to the hot 2s poll.
    const fundsId = setInterval(pollFunds, 15000);
    return () => { clearInterval(id); clearInterval(fundsId); };
  }, [fetchTabData, pollTabData, pollFunds]);

  // Keep refs in sync so the guard interval always reads latest values without stale closures
  useEffect(() => { positionsRef.current = enrichedPositions; }, [enrichedPositions]);
  useEffect(() => { posGuardsRef.current = posGuards; }, [posGuards]);

  // Clear stale data immediately on broker switch so a Dhan position is
  // never displayed or acted on as if it belonged to Zerodha (or vice versa).
  useEffect(() => {
    setPositionsData([]);
    setOrdersData([]);
    setTradesData([]);
    setFundsData(null);
    setStrikeMap({});
  }, [broker]);

  // ─── Toast helper ─────────────────────────────────────────────────

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  // ─── placeOrder ───────────────────────────────────────────────────

  const placeOrder = useCallback(async (side: 'BUY' | 'SELL', option: 'CE' | 'PE') => {
    const strike = option === 'CE' ? ceStrike : peStrike;
    const limitPrice = option === 'CE' ? ceLimitPrice : peLimitPrice;
    if (!strike || !expiry) return;
    if (orderInFlightRef.current.has(option)) return;

    if (orderMode === 'LIMIT') {
      const priceNum = Number(limitPrice);
      if (!limitPrice || isNaN(priceNum) || priceNum <= 0) {
        addToast('error', 'Enter a valid limit price');
        return;
      }
    }

    // Quantity is lots × lot size, so an unresolved lot size means the order size
    // is unknown. Refuse rather than fall back to a literal.
    if (!lotSize || lotSize <= 0) {
      addToast('error', `${side} ${option} failed`, `Lot size for ${underlying} not resolved yet — retry in a moment`);
      return;
    }

    orderInFlightRef.current.add(option);
    setOrderPending(prev => new Set([...prev, option]));

    try {
      const entry = strikeMap[String(strike)];
      let res: Response;
      if (broker !== 'dhan') {
        // Every non-Dhan broker orders by trading symbol and shares this
        // request shape; only the exchange spelling differs.
        const symbol = entry?.[option === 'CE' ? 'ceSymbol' : 'peSymbol'];
        if (!symbol) {
          addToast('error', `${side} ${option} failed`, `${BROKER_LABELS[broker]} strike data still loading`);
          return;
        }
        res = await fetch(scalperRoute(broker, 'order'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tradingsymbol: symbol,
            quantity: lots * lotSize,
            side,
            orderType: orderMode,
            exchange: broker === 'kotak'
              ? (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
              : (underlying === 'SENSEX' ? 'BFO' : 'NFO'),
            ...(orderMode === 'LIMIT' ? { price: Number(limitPrice) } : {}),
          }),
        });
      } else {
        // Fast path: direct Dhan REST call (no Python spawn, no CSV load)
        const secId = entry?.[option === 'CE' ? 'ceId' : 'peId'];
        if (secId) {
          res = await fetch('/api/scalper/fast-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              securityId: secId,
              quantity: lots * lotSize,
              side,
              orderType: orderMode,
              exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
              ...(orderMode === 'LIMIT' ? { price: Number(limitPrice) } : {}),
            }),
          });
        } else {
          // Fallback: Python path (strikeMap not yet loaded)
          const body: Record<string, unknown> = {
            underlying, expiry, strike, option, side, lots, type: orderMode,
          };
          if (orderMode === 'LIMIT') body.price = Number(limitPrice);
          res = await fetch('/api/scalper/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
      }

      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `${side} ${option} placed`, `ID: ${j.order_id}`);
        setTimeout(fetchTabData, 1000);
      } else {
        addToast('error', `${side} ${option} failed`, j.error ?? 'Unknown error');
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
    } finally {
      orderInFlightRef.current.delete(option);
      setOrderPending(prev => { const s = new Set(prev); s.delete(option); return s; });
    }
  }, [ceStrike, peStrike, ceLimitPrice, peLimitPrice, expiry, lots, lotSize, strikeMap, orderMode, broker, addToast, fetchTabData]);

  // ─── Per-position close ───────────────────────────────────────────

  // ok=false means the close could not be confirmed (order failed / errored) —
  // callers that chain further actions (e.g. strike shift) MUST NOT proceed as
  // if the position were closed. qty is the signed live netQty seen right
  // before closing (0 if the position was already flat), for callers that
  // need to size a follow-up order off the real prior exposure rather than
  // a possibly-stale value passed in.
  const closePosition = useCallback(async (pos: Record<string, unknown>, reason: string, opts?: { verifyFlat?: boolean }): Promise<{ ok: boolean; qty: number }> => {
    const sym = String(pos.tradingSymbol ?? '');
    const fallbackSecId = String(pos.securityId ?? pos.security_id ?? '');
    // Guards and in-flight tracking key off (symbol, product): the same symbol
    // can be open under two products, and they must be closed independently.
    const key = positionKey(pos);
    const product = positionProduct(pos);

    if (!sym || !fallbackSecId) {
      addToast('error', `Cannot close ${sym || 'position'}`, 'Missing security ID');
      return { ok: false, qty: 0 };
    }

    // A product this broker cannot book (CO/BO, or a foreign vocabulary) must
    // not be sent — the order route would default it to intraday, which opens a
    // new position instead of reducing this one.
    const productPayload = closeOrderProduct(broker, product);
    if (!productPayload) {
      addToast('error', `Cannot close ${sym}`, `Unsupported product "${product}" — square this leg off at the broker`);
      return { ok: false, qty: 0 };
    }

    // Prevent double-fire while order is in flight
    if (closingInFlightRef.current.has(key)) return { ok: false, qty: 0 };
    closingInFlightRef.current.add(key);
    setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: true } } : prev);
    setClosingPositions(prev => new Set([...prev, key]));

    try {
      // Fetch live positions to get the current open quantity (avoids acting on stale data).
      // Exchange is derived from the POSITION itself (not the currently-selected
      // underlying) — a stale position from a different underlying than what's
      // selected in the UI must still close on its own exchange.
      let liveNetQty = 0;
      let liveSecId = fallbackSecId;
      let liveExchange = String(pos.exchangeSegment ?? pos.exchange ??
        (broker === 'kotak' ? 'nse_fo' : broker === 'zerodha' ? 'NFO' : 'NSE_FNO'));
      try {
        const posUrl = scalperRoute(broker, 'positions');
        const posRes = await fetch(posUrl);
        const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (posJson.success && posJson.data) {
          const found = findLivePosition(posJson.data, pos);
          if (found.kind === 'ambiguous') {
            // `triggered` is deliberately left set: a guard that cannot identify
            // its own row cannot close it either, and re-entering here every
            // second would bury every other toast under a storm of this one.
            addToast('error', `Cannot close ${sym}`,
              `${found.count} rows share this symbol and the position reports no product — close it from the broker terminal`);
            return { ok: false, qty: 0 };
          }
          if (found.kind === 'match') {
            liveNetQty = Number(found.row.netQty);
            liveSecId = String(found.row.securityId ?? found.row.security_id ?? fallbackSecId);
            liveExchange = String(found.row.exchangeSegment ?? found.row.exchange ?? liveExchange);
          }
        }
      } catch {
        // Fall back to the quantity from the position object passed in
        liveNetQty = Number(pos.netQty);
      }

      if (liveNetQty === 0) {
        addToast('success', `${sym} already flat`, `(${reason})`);
        setPosGuards(prev => { const next = { ...prev }; delete next[key]; return next; });
        fetchTabData();
        return { ok: true, qty: 0 };
      }

      const side = liveNetQty > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(liveNetQty);

      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const res = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          // Dhan is the only broker that closes by numeric securityId; the rest
          // close by trading symbol. productPayload books the close under the
          // position's own product so it reduces rather than opens.
          broker !== 'dhan'
            ? { tradingsymbol: sym, quantity: qty, side, orderType: 'MARKET', exchange: liveExchange, ...productPayload.fields }
            : { securityId: liveSecId, quantity: qty, side, orderType: 'MARKET', exchangeSegment: liveExchange, ...productPayload.fields },
        ),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        // A MARKET order accepted by the broker isn't necessarily filled — for
        // callers that chain a follow-up open (strike shift), poll live
        // positions briefly to confirm it actually went flat before reporting
        // success, so a post-acceptance rejection can't lead to a doubled
        // position. Skipped by default: the SL/target/manual-close paths that
        // use closePosition constantly during scalping need the fast return.
        if (opts?.verifyFlat) {
          const confirmedFlat = await pollPositionFlat(broker, pos);
          if (!confirmedFlat) {
            addToast('error', `Could not confirm ${sym} closed`, 'Order accepted but position still shows open — check manually');
            setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
            return { ok: false, qty: liveNetQty };
          }
        }
        addToast('success', `Closed ${sym} (${reason})`,
          `${qty} qty${productPayload.assumed ? '' : ` · ${product}`} · ID: ${j.order_id}`);
        // Drop the guard entirely — leaving it would carry stale bestPrice /
        // trailEnabled into a future re-entry on the same symbol.
        setPosGuards(prev => { const next = { ...prev }; delete next[key]; return next; });
        setTimeout(fetchTabData, 800);
        return { ok: true, qty: liveNetQty };
      } else {
        addToast('error', `Close failed: ${sym}`, j.error ?? 'Unknown error');
        setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
        return { ok: false, qty: liveNetQty };
      }
    } catch (e) {
      addToast('error', 'Network error closing position', String(e));
      setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
      return { ok: false, qty: 0 };
    } finally {
      closingInFlightRef.current.delete(key);
      setClosingPositions(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  }, [broker, addToast, fetchTabData]);

  // ─── Client-side profit lock (total P&L floor) ────────────────────

  const exitAllForLock = useCallback(async (reason: string) => {
    const open = positionsRef.current.filter(p => Number(p.netQty) !== 0);
    await Promise.allSettled(open.map(pos => closePosition(pos, reason)));
    setTimeout(fetchTabData, 1000);
  }, [closePosition, fetchTabData]);

  const hasOpenPositions = useMemo(
    () => enrichedPositions.some(p => Number(p.netQty) !== 0),
    [enrichedPositions]);

  const profitLock = useProfitLock({
    totalPnl,
    hasOpenPositions,
    exitAll: exitAllForLock,
    notify: addToast,
    storageKey: 'profit_lock_v1',
  });

  const copyTrade = useCopyTrade(addToast);

  const handleExitAll = useCallback(async () => {
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
      setTimeout(fetchTabData, 1000);
    }
  }, [confirmExitAll, broker, addToast, fetchTabData]);

  // `posKey` is the composite (symbol, product) key from lib/positionProduct,
  // NOT a trading symbol — see the posGuards declaration.
  const handleGuardChange = useCallback((posKey: string, field: 'target' | 'sl', value: string) => {
    setPosGuards(prev => {
      const existing: PositionGuard = prev[posKey] ?? { target: '', sl: '', trailEnabled: false, bestPrice: 0, triggered: false };
      return {
        ...prev,
        [posKey]: { ...existing, [field]: value, triggered: false },
      };
    });
  }, []);

  const handleTrailToggle = useCallback((posKey: string) => {
    setPosGuards(prev => {
      const existing: PositionGuard = prev[posKey] ?? { target: '', sl: '', trailEnabled: false, bestPrice: 0, triggered: false };
      return {
        ...prev,
        [posKey]: { ...existing, trailEnabled: !existing.trailEnabled, bestPrice: 0, triggered: false },
      };
    });
  }, []);

  // Guard monitoring — 1s interval reads LTP from positions data and fires closes
  useEffect(() => {
    const id = setInterval(() => {
      const guards = posGuardsRef.current;
      const positions = positionsRef.current;
      const peakUpdates: Record<string, number> = {};

      for (const pos of positions) {
        // Keyed per (symbol, product) — the same symbol open under two products
        // is two independently guarded rows, not one shared guard.
        const posKey = positionKey(pos);
        const guard = guards[posKey];
        if (!guard || guard.triggered) continue;

        const ltp = Number(pos.lastTradedPrice);
        const netQty = Number(pos.netQty);
        if (ltp <= 0 || netQty === 0) continue;

        const isLong = netQty > 0;

        // Target (take profit)
        const targetNum = parseFloat(guard.target);
        if (!isNaN(targetNum) && targetNum > 0) {
          if ((isLong && ltp >= targetNum) || (!isLong && ltp <= targetNum)) {
            closePosition(pos, 'Target hit');
            continue;
          }
        }

        if (guard.trailEnabled) {
          // Trailing SL: 1:1 with profit, anchored to the configured SL level
          const slNum = parseFloat(guard.sl);
          if (!isNaN(slNum) && slNum > 0) {
            const entryPrice = isLong ? Number(pos.buyAvg) : Number(pos.sellAvg);
            if (entryPrice > 0) {
              const initialRisk = Math.abs(slNum - entryPrice);
              const currentBest = guard.bestPrice;
              const newBest = currentBest === 0
                ? ltp
                : (isLong ? Math.max(currentBest, ltp) : Math.min(currentBest, ltp));
              if (newBest !== currentBest) peakUpdates[posKey] = newBest;

              const effectiveBest = peakUpdates[posKey] ?? currentBest;
              if (effectiveBest > 0) {
                const trailSLPrice = isLong
                  ? effectiveBest - initialRisk
                  : effectiveBest + initialRisk;
                // Only enforce the trail once it's tighter than the original SL;
                // otherwise fall back to the original SL so the position stays protected.
                const trailActive = isLong ? trailSLPrice > slNum : trailSLPrice < slNum;
                if (trailActive) {
                  if ((isLong && ltp <= trailSLPrice) || (!isLong && ltp >= trailSLPrice)) {
                    closePosition(pos, 'Trail SL hit');
                    continue;
                  }
                } else if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
                  closePosition(pos, 'SL hit');
                  continue;
                }
              }
            }
          }
        } else {
          // Hard SL (no trailing)
          const slNum = parseFloat(guard.sl);
          if (!isNaN(slNum) && slNum > 0) {
            if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
              closePosition(pos, 'SL hit');
              continue;
            }
          }
        }
      }

      if (Object.keys(peakUpdates).length > 0) {
        setPosGuards(prev => {
          const next = { ...prev };
          for (const [s, best] of Object.entries(peakUpdates)) {
            if (next[s]) next[s] = { ...next[s], bestPrice: best };
          }
          return next;
        });
      }
    }, 1000);

    return () => clearInterval(id);
  }, [closePosition]);

  // ─── P&L Guard ────────────────────────────────────────────────────

  // After a successful Set, Dhan's own GET can take several seconds to reflect
  // the change. Poll a few times before trusting a "not configured yet"
  // response — otherwise the optimistic ACTIVE badge flips back to NOT SET
  // a couple seconds later even though the guard really was applied.
  //
  // The retry recurses through a local helper rather than through the
  // useCallback binding itself, which would be a read of a component-scope
  // `const` from inside its own initialiser.
  const reconcilePnlGuardAfterSet = useCallback(() => {
    const poll = (attempt: number) => {
      setTimeout(async () => {
        try {
          const res = await fetch('/api/pnl-exit');
          const j = await res.json();
          const hasConfig = j.success && j.data && (Number(j.data.profit) > 0 || Math.abs(Number(j.data.loss)) > 0);
          if (hasConfig || attempt >= 4) {
            if (j.success) setPnlGuardStatus(j.data ?? null);
            return;
          }
          poll(attempt + 1);
        } catch {
          if (attempt < 4) poll(attempt + 1);
        }
      }, 1500);
    };
    poll(1);
  }, []);


  const handleSetPnl = async () => {
    // /api/pnl-exit is Dhan's native account-level guard only — no Zerodha
    // equivalent exists. The UI already hides these controls for Zerodha;
    // this is a defense-in-depth guard against calling it anyway.
    if (broker !== 'dhan') { addToast('error', 'P&L Guard is Dhan-only'); return; }
    // The field collects a positive loss magnitude ("exit when loss reaches ₹X"),
    // but Dhan's API rejects lossValue > 0 ("Loss Amount Cannot Be Greater Than
    // Zero") — it wants the P&L level itself, so the magnitude is sent negated.
    const p = Math.abs(parseFloat(profitTarget)) || 0;
    const l = Math.abs(parseFloat(lossLimit)) || 0;
    if (p <= 0 && l <= 0) { addToast('error', 'Enter a profit target or loss limit'); return; }
    setGuardError('');
    setSettingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitValue: p, lossValue: l > 0 ? -l : 0, productTypes: guardProductTypes, enableKillSwitch }),
      });
      const j = await res.json();
      if (j.success) {
        addToast('success', 'P&L Guard set');
        // Reflect the just-applied config immediately — Dhan's GET can lag a beat
        // behind the POST, so the ACTIVE badge shouldn't depend on winning that race.
        setPnlGuardStatus({
          pnlExitStatus: 'ACTIVE',
          profit: p > 0 ? p : undefined,
          loss: l > 0 ? l : undefined,
          productType: guardProductTypes,
          enableKillSwitch,
        });
        // Reconcile with the broker's actual state after it's had a moment to
        // persist the change, rather than racing it and clobbering the
        // optimistic ACTIVE state with a stale response.
        reconcilePnlGuardAfterSet();
      } else {
        const msg = j.error || 'Failed to set P&L Guard';
        addToast('error', 'Failed to set P&L Guard', j.error);
        setGuardError(msg);
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
      setGuardError(String(e));
    } finally {
      setSettingPnl(false);
    }
  };

  const handleClearPnl = async () => {
    if (broker !== 'dhan') { addToast('error', 'P&L Guard is Dhan-only'); return; }
    if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 3000); return; }
    setClearingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', { method: 'DELETE' });
      const j = await res.json();
      if (j.success) { addToast('success', 'P&L Guard cleared'); setPnlGuardStatus(null); }
      else addToast('error', 'Failed to clear P&L Guard', j.error);
    } catch (e) {
      addToast('error', 'Network error', String(e));
    } finally {
      setClearingPnl(false);
      setConfirmClear(false);
    }
  };

  // Stable OptionPanel callbacks — inline arrows would defeat React.memo and
  // force both panels to re-render on every quote push.
  const handleCeStrikeChange = useCallback((v: number) => { setCeStrike(v); setCeLimitPrice(''); }, []);
  const handlePeStrikeChange = useCallback((v: number) => { setPeStrike(v); setPeLimitPrice(''); }, []);
  const handleCeBuy  = useCallback(() => placeOrder('BUY',  'CE'), [placeOrder]);
  const handleCeSell = useCallback(() => placeOrder('SELL', 'CE'), [placeOrder]);
  const handlePeBuy  = useCallback(() => placeOrder('BUY',  'PE'), [placeOrder]);
  const handlePeSell = useCallback(() => placeOrder('SELL', 'PE'), [placeOrder]);
  const handleClosePosition = useCallback(
    (pos: Record<string, unknown>) => closePosition(pos, 'Manual'), [closePosition]);

  // Pre-fill the CE/PE strike selector from an existing position so the user can
  // scale in (same strike) or add a hedge (new strike) via the normal order panel.
  const handleAddLeg = useCallback((pos: Record<string, unknown>) => {
    const sym = String(pos.tradingSymbol ?? '');
    // Match on whichever identifier this broker's lookup actually supplies:
    // Dhan returns securityIds only (scalper_api.py emits ceId/peId, no
    // symbols) while every other broker returns symbols only. Keying on the
    // symbol alone meant Add Leg never matched anything on Dhan.
    const secId = String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
    for (const [strikeStr, entry] of Object.entries(strikeMap)) {
      if ((secId && entry.ceId === secId) || (sym && entry.ceSymbol === sym)) {
        handleCeStrikeChange(Number(strikeStr));
        addToast('success', `CE panel set to ${strikeStr}`, 'Pick Buy/Sell and lots to add this leg');
        return;
      }
      if ((secId && entry.peId === secId) || (sym && entry.peSymbol === sym)) {
        handlePeStrikeChange(Number(strikeStr));
        addToast('success', `PE panel set to ${strikeStr}`, 'Pick Buy/Sell and lots to add this leg');
        return;
      }
    }
    addToast('error', 'Could not match position to a strike', sym);
  }, [strikeMap, handleCeStrikeChange, handlePeStrikeChange, addToast]);

  // ─── Shift Strike Up/Down (Auto-close active position & shift to new strike) ───
  const handleShiftStrike = useCallback(async (option: 'CE' | 'PE', direction: 'UP' | 'DOWN') => {
    const currentStrike = option === 'CE' ? ceStrike : peStrike;
    if (!currentStrike || !visibleStrikes.length) return;
    if (orderInFlightRef.current.has(option)) return;

    const strikesToSearch = allStrikes.length ? allStrikes : visibleStrikes;
    const sorted = [...strikesToSearch].sort((a, b) => a - b);
    const currIdx = sorted.indexOf(currentStrike);
    let targetIdx = -1;

    if (currIdx === -1) {
      // currentStrike isn't in the list (stale/out-of-range) — fall back to a
      // direct step lookup instead of a neighbor index.
      const target = direction === 'UP' ? currentStrike + strikeStep : currentStrike - strikeStep;
      if (sorted.includes(target)) targetIdx = sorted.indexOf(target);
    } else if (direction === 'UP') {
      if (currIdx < sorted.length - 1) targetIdx = currIdx + 1;
    } else {
      if (currIdx > 0) targetIdx = currIdx - 1;
    }

    if (targetIdx === -1) {
      addToast('error', `Cannot shift ${direction.toLowerCase()}`, `No ${direction.toLowerCase()} strike available`);
      return;
    }

    const newStrike = sorted[targetIdx];

    // Check if there is an active open position for currentStrike & option side.
    // If strikeMap has no entry for the CURRENT strike, we cannot reliably tell
    // whether a live position exists there (chain still loading, strike outside
    // the fetched range, etc.) — abort rather than silently treating it as flat,
    // which would leave a real position unmanaged while the UI moves on.
    const curSecEntry = strikeMap[String(currentStrike)];
    if (!curSecEntry) {
      addToast('error', 'Cannot shift strike', `Position data for ${currentStrike} ${option} not loaded yet — try again shortly`);
      return;
    }
    const curSym = curSecEntry[option === 'CE' ? 'ceSymbol' : 'peSymbol'];
    const curSecId = curSecEntry[option === 'CE' ? 'ceId' : 'peId'];

    const activePos = enrichedPositions.find(p => {
      const netQty = Number(p.netQty);
      if (!netQty) return false;
      const pSym = String(p.tradingSymbol ?? '');
      const pSecId = String(p.securityId ?? p.security_id ?? '');
      if (curSym && pSym === curSym) return true;
      if (curSecId && pSecId === curSecId) return true;
      return false;
    });

    if (activePos && Number(activePos.netQty) !== 0) {
      // Re-opening at the new strike is sized in lots, so an unresolved lot size
      // would close the leg and then be unable to size the replacement — abort
      // before anything is closed.
      if (!lotSize || lotSize <= 0) {
        addToast('error', 'Cannot shift strike', `Lot size for ${underlying} not resolved yet — retry in a moment`);
        return;
      }
      orderInFlightRef.current.add(option);
      setOrderPending(prev => new Set([...prev, option]));

      try {
        addToast('success', `Shifting ${currentStrike} ${option} → ${newStrike} ${option}`, `Closing ${currentStrike} position first...`);

        // 1. Close active position on current strike. closePosition re-fetches
        // live positions itself, so closeResult.qty is the real quantity that
        // was open — not the possibly-stale activePos.netQty snapshot.
        const closeResult = await closePosition(activePos, 'Strike Shift', { verifyFlat: true });
        if (!closeResult.ok) {
          // Close could not be confirmed — do NOT touch the strike selector or
          // open a new leg, or we'd risk ending up with both the old and the
          // new position open at once. closePosition already toasted the error.
          addToast('error', `Shift aborted`, `${currentStrike} ${option} close was not confirmed — position left untouched`);
          return;
        }
        if (closeResult.qty === 0) {
          // Position was already flat by the time we got here (closed elsewhere
          // between poll and click) — nothing to roll, just move the selector.
          if (option === 'CE') handleCeStrikeChange(newStrike); else handlePeStrikeChange(newStrike);
          addToast('success', `${currentStrike} ${option} was already flat`, `Strike moved to ${newStrike} ${option} — no order placed`);
          return;
        }

        const sideToOpen: 'BUY' | 'SELL' = closeResult.qty < 0 ? 'SELL' : 'BUY';
        const openLots = Math.max(1, Math.round(Math.abs(closeResult.qty) / lotSize));

        // 2. Update selected strike to new strike
        if (option === 'CE') {
          handleCeStrikeChange(newStrike);
        } else {
          handlePeStrikeChange(newStrike);
        }

        // 3. Open matching position on the new strike
        const newSecEntry = strikeMap[String(newStrike)];
        let res: Response;
        if (broker !== 'dhan') {
          const symbol = newSecEntry?.[option === 'CE' ? 'ceSymbol' : 'peSymbol'];
          if (!symbol) {
            addToast('error', `Shift to ${newStrike} failed`, `Strike symbol data loading`);
            return;
          }
          res = await fetch(scalperRoute(broker, 'order'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tradingsymbol: symbol,
              quantity: openLots * lotSize,
              side: sideToOpen,
              orderType: 'MARKET',
              exchange: broker === 'kotak'
                ? (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
                : (underlying === 'SENSEX' ? 'BFO' : 'NFO'),
            }),
          });
        } else {
          const secId = newSecEntry?.[option === 'CE' ? 'ceId' : 'peId'];
          if (secId) {
            res = await fetch('/api/scalper/fast-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                securityId: secId,
                quantity: openLots * lotSize,
                side: sideToOpen,
                orderType: 'MARKET',
                exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
              }),
            });
          } else {
            res = await fetch('/api/scalper/order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                underlying, expiry, strike: newStrike, option, side: sideToOpen, lots: openLots, type: 'MARKET',
              }),
            });
          }
        }

        const j = await res.json() as { success: boolean; order_id?: string; error?: string };
        if (j.success) {
          addToast('success', `Shift complete: ${newStrike} ${option}`, `${sideToOpen} ${openLots} lot(s) placed (ID: ${j.order_id})`);
          setTimeout(fetchTabData, 1000);
        } else {
          addToast('error', `New strike order failed`, j.error ?? 'Unknown error');
        }
      } catch (e) {
        addToast('error', 'Shift failed', String(e));
      } finally {
        orderInFlightRef.current.delete(option);
        setOrderPending(prev => { const next = new Set(prev); next.delete(option); return next; });
      }
    } else {
      // No active position: simply update strike selector
      if (option === 'CE') {
        handleCeStrikeChange(newStrike);
      } else {
        handlePeStrikeChange(newStrike);
      }
      addToast('success', `Strike shifted to ${newStrike} ${option}`);
    }
  }, [ceStrike, peStrike, visibleStrikes, allStrikes, strikeStep, strikeMap, enrichedPositions, lotSize, closePosition, handleCeStrikeChange, handlePeStrikeChange, broker, underlying, expiry, addToast, fetchTabData]);

  // ─── JSX ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* Fixed toast overlay */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold
            shadow-2xl max-w-xs
            ${t.type === 'success'
              ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-900/95 border-rose-500/40 text-rose-200'}`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
        <div className="flex items-center justify-between gap-3 flex-nowrap overflow-x-auto">
          <div className="flex items-center gap-3 flex-nowrap shrink-0">
            <div className="shrink-0 whitespace-nowrap">
              <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-yellow-400" />
                {underlying} SCALPER
              </h1>
              <p className="text-xs font-bold font-mono tabular-nums text-zinc-200">
                {spot > 0
                  ? `${underlying} ${spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'Loading…'}
              </p>
            </div>
            <div className="shrink-0"><NavBar /></div>
          </div>
          <div className="flex items-center gap-2 flex-nowrap shrink-0">
            {/* Broker selector — only shown when more than one broker is authenticated */}
            {authenticatedBrokers.length > 1 && (
              <select
                value={broker}
                onChange={e => setBroker(e.target.value as Broker)}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                           rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 w-[88px] shrink-0"
              >
                {authenticatedBrokers.map(b => (
                  <option key={b} value={b}>{BROKER_LABELS[b]}</option>
                ))}
              </select>
            )}

            {/* Underlying selector — fixed width so the row layout doesn't shift
                when switching between underlyings of different name lengths
                (e.g. NIFTY vs BANKNIFTY) */}
            <select value={underlying} onChange={e => setUnderlying(e.target.value as typeof UNDERLYINGS[number])}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 w-[104px] shrink-0">
              {UNDERLYINGS.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>

            {/* Expiry selector */}
            <select value={expiry} onChange={e => setExpiry(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 shrink-0">
              {expiries.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>

            {/* Lots +/- */}
            <div className="flex items-center bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden shrink-0">
              <button onClick={() => setLots(l => Math.max(1, l - 1))} title="Reduce lots by one" aria-label="Reduce lots by one"
                className={cn('px-2.5 py-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm', FOCUS_RING)}>−</button>
              <span className="px-2 text-xs font-mono tabular-nums text-zinc-200 min-w-[3.5rem] text-center border-x border-zinc-700 whitespace-nowrap">
                {lots} lot{lots !== 1 ? 's' : ''}
              </span>
              <button onClick={() => setLots(l => l + 1)} title="Add one lot" aria-label="Add one lot"
                className={cn('px-2.5 py-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm', FOCUS_RING)}>+</button>
            </div>

            {/* MARKET / LIMIT toggle */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl shrink-0">
              {(['MARKET', 'LIMIT'] as const).map(m => (
                <button key={m} onClick={() => setOrderMode(m)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-bold rounded-lg transition-all whitespace-nowrap',
                    orderMode === m
                      ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                      : 'text-zinc-500 hover:text-zinc-300',
                    FOCUS_RING,
                  )}>
                  {m}
                </button>
              ))}
            </div>

            {/* Bridge status dot + transport badge + timestamp */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`w-2 h-2 rounded-full ${
                bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
                bridgeStatus.status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
                bridgeStatus.status === 'ERROR'    ? 'bg-rose-400'                  : 'bg-zinc-600'
              }`} />
              <span className={cn(
                TXT_LABEL, 'font-bold px-1 py-0.5 rounded border w-9 text-center',
                transport === 'ws'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700',
              )} title={transport === 'ws' ? 'Realtime WebSocket push' : 'HTTP polling fallback'}>
                {transport === 'ws' ? 'WS' : 'HTTP'}
              </span>
              {lastUpdated && <span className={cn(TXT_VALUE, 'text-zinc-500 font-mono whitespace-nowrap')}>{lastUpdated}</span>}
            </div>

            {/* Available funds chip — min-w keeps row layout stable regardless of
                the selected broker's actual balance digit-count (e.g. Dhan vs
                Zerodha accounts can differ by orders of magnitude) */}
            {fundsData && (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200 min-w-[110px] justify-center shrink-0 whitespace-nowrap"
                title="Available balance (NSE Derivatives)">
                <Wallet className="w-3 h-3 text-sky-400" />
                ₹{formatFundsValue(Number(fundsData.availabelBalance) || 0)}
              </span>
            )}



          </div>
        </div>

        {/* P&L Guard bar — always visible; controls themselves are Dhan-only (see below) */}
        <div className="mt-2 pt-2 border-t border-zinc-800">
          {(() => {
            const isActive = pnlGuardStatus?.pnlExitStatus === 'ACTIVE';
            // Dhan may echo loss back as the negative level it was stored at rather
            // than the positive magnitude we sent — compare by magnitude either way.
            const hasConfig = !!(pnlGuardStatus && (Number(pnlGuardStatus.profit) > 0 || Math.abs(Number(pnlGuardStatus.loss)) > 0));
            const guardLabel = isActive ? 'ACTIVE' : hasConfig ? 'CONFIGURED' : 'NOT SET';
            const guardChipCls = isActive
              ? 'bg-emerald-900/60 text-emerald-400 border border-emerald-500/30'
              : hasConfig
              ? 'bg-amber-900/40 text-amber-400 border border-amber-500/30'
              : 'bg-zinc-800 text-zinc-500 border border-zinc-700';
            return (
              <div className="flex items-center gap-3 flex-nowrap overflow-x-auto pb-1">
                <div className="flex items-center gap-3 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5">
                  <span className={cn('flex items-center gap-1', TXT_VALUE, 'font-bold text-zinc-500 uppercase tracking-wider shrink-0 whitespace-nowrap')}>
                    <Shield className="w-3 h-3" /> P&amp;L Guard
                  </span>

                  {broker !== 'dhan' ? (
                    // Dhan's native /pnlExit is an account-level kill switch with no
                    // Zerodha equivalent — showing live-looking controls here would
                    // silently configure Dhan's guard while this tab shows Zerodha
                    // data, so surface that plainly instead of pretending it works.
                    <span
                      className={cn(TXT_VALUE, 'px-2 py-1 rounded font-bold uppercase tracking-wider bg-zinc-800 text-zinc-500 border border-zinc-700 shrink-0 whitespace-nowrap')}
                      title="P&L Guard uses Dhan's native account-level pnlExit API, which has no Zerodha equivalent. Switch to Dhan to use it.">
                      DHAN ONLY
                    </span>
                  ) : (
                    <>
                      {/* Status chip */}
                      <span className={cn(TXT_VALUE, 'px-2 py-1 rounded font-bold uppercase tracking-wider shrink-0 whitespace-nowrap', guardChipCls)}>
                        {guardLabel}
                      </span>

                      {/* Profit target — always a positive magnitude */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={cn(TXT_VALUE, 'text-zinc-500 font-semibold whitespace-nowrap')}>TARGET ₹</span>
                        <input type="number" min="0" placeholder="e.g. 5000" value={profitTarget}
                          onChange={e => setProfitTarget(e.target.value.replace(/-/g, ''))}
                          className={cn('w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-emerald-500', FOCUS_RING)} />
                      </div>

                      {/* Loss limit — always a positive magnitude ("exit when loss reaches ₹X"); Dhan rejects a negative value */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={cn(TXT_VALUE, 'text-zinc-500 font-semibold whitespace-nowrap')}>SL ₹</span>
                        <input type="number" min="0" placeholder="e.g. 2000" value={lossLimit}
                          onChange={e => setLossLimit(e.target.value.replace(/-/g, ''))}
                          className={cn('w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-rose-500', FOCUS_RING)} />
                      </div>

                      <RiskRail totalPnl={totalPnl} target={Number(profitTarget) || null} stop={Number(lossLimit) || null} />

                      {/* Product types */}
                      <div className="flex items-center gap-1 shrink-0">
                        {['INTRADAY', 'CNC', 'MARGIN'].map(pt => (
                          <button key={pt} onClick={() => setGuardProductTypes(prev =>
                            prev.includes(pt) ? prev.filter(x => x !== pt) : [...prev, pt]
                          )}
                            className={cn(
                              TXT_VALUE, 'px-2 py-1 rounded font-bold border transition-all whitespace-nowrap',
                              guardProductTypes.includes(pt)
                                ? 'bg-violet-900/50 border-violet-500/40 text-violet-300'
                                : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300',
                              FOCUS_RING,
                            )}>
                            {pt}
                          </button>
                        ))}
                      </div>

                      {/* Kill switch */}
                      <button onClick={() => setEnableKillSwitch(v => !v)}
                        aria-pressed={enableKillSwitch}
                        className={cn(
                          'flex items-center gap-1.5 px-2.5 py-1 rounded', TXT_VALUE, 'font-bold border transition-all shrink-0 whitespace-nowrap',
                          enableKillSwitch
                            ? 'bg-rose-900/50 border-rose-500/40 text-rose-300'
                            : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300',
                          FOCUS_RING,
                        )}>
                        🔴 Kill Switch {enableKillSwitch ? 'ON' : 'OFF'}
                      </button>

                      {/* Set button */}
                      <button onClick={handleSetPnl} disabled={settingPnl}
                        className={cn('px-3 py-1.5 text-xs font-bold rounded-lg bg-violet-600 hover:bg-violet-500 text-white border border-violet-500/40 transition-all disabled:opacity-50 shrink-0 whitespace-nowrap', FOCUS_RING)}>
                        {settingPnl ? 'Setting…' : 'Set Guard'}
                      </button>

                      {/* Clear button */}
                      {hasConfig && (
                        <button onClick={handleClearPnl} disabled={clearingPnl}
                          className={cn(
                            'px-3 py-1.5 text-xs font-bold rounded-lg border transition-all disabled:opacity-50 shrink-0 whitespace-nowrap',
                            confirmClear
                              ? 'bg-rose-600 border-rose-500/40 text-oncolor'
                              : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200',
                            FOCUS_RING,
                          )}>
                          {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear Guard'}
                        </button>
                      )}
                    </>
                  )}

                  {/* Current guard values — shown whenever configured, not just when broker confirms ACTIVE */}
                  {broker === 'dhan' && hasConfig && (
                    <span className={cn(TXT_VALUE, 'text-zinc-500 font-mono shrink-0 whitespace-nowrap')}>
                      {Number(pnlGuardStatus?.profit) > 0 ? `🎯 ₹${pnlGuardStatus?.profit}` : ''}
                      {Number(pnlGuardStatus?.profit) > 0 && Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? '  ' : ''}
                      {Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? `🛑 ₹${Math.abs(Number(pnlGuardStatus?.loss))}` : ''}
                    </span>
                  )}

                  {/* Persistent error — the toast auto-dismisses, this stays until the next attempt */}
                  {broker === 'dhan' && guardError && (
                    <span className={cn(TXT_VALUE, 'text-rose-400 font-semibold shrink-0 whitespace-nowrap')}>⚠ {guardError}</span>
                  )}
                </div>

                {/* Exit ALL Positions (broker-level nuclear) — left outside any card
                    so its danger styling stays the loudest thing in the strip. */}
                <button onClick={handleExitAll} disabled={exitingAll}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg', TXT_CAPTION, 'font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap',
                    exitingAll
                      ? 'bg-red-900/40 border-red-800 text-red-400'
                      : confirmExitAll
                      ? 'bg-red-600 border-red-500 text-oncolor animate-pulse shadow-lg shadow-red-500/20'
                      : 'bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300',
                    FOCUS_RING,
                  )}
                  title="Immediately liquidate ALL positions at broker level (DELETE /positions)">
                  {exitingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
                  {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
                </button>

                {/* Client-side minimum profit lock (total P&L floor) — its own leading
                    divider is redundant now that this cluster is a card; hidden rather
                    than touched, since ProfitLockControls is shared elsewhere. */}
                <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5 [&>span:first-child]:hidden">
                  <ProfitLockControls lock={profitLock} totalPnl={totalPnl} />
                </div>

                {/* Dhan → Zerodha trade replication (arm/disarm + multiplier) — same
                    leading-divider note as ProfitLockControls above. */}
                <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5 [&>span:first-child]:hidden">
                  <CopyTradeControls copyTrade={copyTrade} />
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Centered underlying spot price strip with CE/PE Value Summary on Left */}
      {spot > 0 && (() => {
        const chg    = prevSpot > 0 ? spot - prevSpot : 0;
        const chgPct = prevSpot > 0 ? (chg / prevSpot) * 100 : 0;
        const isUp   = chg >= 0;

        return (
          <div className="flex flex-wrap justify-center items-center gap-3 px-4 pb-1 pt-0 select-none">
            {/* Real-time Total P&L Pill (Left Side of CE Value) */}
            <div className={`flex items-center gap-2 bg-zinc-900/80 border rounded-2xl px-4 py-2.5 shadow-lg font-mono text-xs ${
              totalPnl > 0
                ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300'
                : totalPnl < 0
                ? 'border-rose-500/40 bg-rose-950/40 text-rose-300'
                : 'border-zinc-800 text-zinc-400'
            }`} title="Combined Realized + Unrealized P&L across open positions">
              <span className="text-[10px] font-extrabold uppercase bg-zinc-950 border border-zinc-800 px-1.5 py-0.5 rounded text-zinc-400">
                P&amp;L
              </span>
              <span className="font-bold text-sm tabular-nums">
                {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            {/* Total CE & PE Value Summary Pill */}
            <div className="flex items-center gap-2.5 bg-zinc-900/80 border border-zinc-800 rounded-2xl px-4 py-2.5 shadow-lg font-mono text-xs">
              {/* Total CE Value */}
              <div className="flex items-center gap-1.5" title="Net Call Value = Sum(short CE Qty × Price) − Sum(long CE Qty × Price)">
                <span className="text-[10px] font-extrabold uppercase text-emerald-400 bg-emerald-950/80 border border-emerald-800/60 px-1.5 py-0.5 rounded">
                  CE Val
                </span>
                <span className="font-bold text-emerald-300 tabular-nums">
                  ₹{totalCEVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              <span className="text-zinc-700 font-sans">|</span>

              {/* Total PE Value */}
              <div className="flex items-center gap-1.5" title="Net Put Value = Sum(short PE Qty × Price) − Sum(long PE Qty × Price)">
                <span className="text-[10px] font-extrabold uppercase text-rose-400 bg-rose-950/80 border border-rose-800/60 px-1.5 py-0.5 rounded">
                  PE Val
                </span>
                <span className="font-bold text-rose-300 tabular-nums">
                  ₹{totalPEVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              <span className="text-zinc-700 font-sans">|</span>

              {/* Difference (CE - PE) */}
              <div className="flex items-center gap-1.5" title="Difference = Total CE Value - Total PE Value">
                <span className="text-[10px] font-extrabold uppercase text-zinc-400 bg-zinc-950 border border-zinc-800 px-1.5 py-0.5 rounded">
                  Diff (CE-PE)
                </span>
                <span className={`font-bold tabular-nums ${
                  cePeDiff > 0 ? 'text-emerald-400' : cePeDiff < 0 ? 'text-rose-400' : 'text-zinc-400'
                }`}>
                  {cePeDiff >= 0 ? '+' : ''}₹{cePeDiff.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Index Spot Price Pill */}
            <div className="flex items-baseline gap-3 bg-zinc-900/60 border border-zinc-800 rounded-2xl px-6 py-2">
              <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">{underlying}</span>
              <span className="text-3xl font-bold font-mono tabular-nums text-white">
                {spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {prevSpot > 0 && (
                <div className={`flex items-baseline gap-1.5 text-sm font-semibold font-mono tabular-nums ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                  <span>{isUp ? '▲' : '▼'}</span>
                  <span>{Math.abs(chg).toFixed(2)}</span>
                  <span className="text-xs opacity-80">({isUp ? '+' : ''}{chgPct.toFixed(2)}%)</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Trading panels */}
      <div className="flex flex-row justify-center gap-3 p-4 overflow-x-auto select-none">
        <div className="flex-none w-[calc(20%-0.6rem)] min-w-[300px]">
          <OptionPanel
            side="CE"
            label="CALLS"
            strike={ceStrike}
            visibleStrikes={visibleStrikes}
            atm={atm}
            ltp={ceLtp}
            pct={cePct}
            high={ceHigh}
            low={ceLow}
            buildup={ceBuildup}
            oiChgPct={ceOiChgPct}
            limitPrice={ceLimitPrice}
            orderMode={orderMode}
            onStrikeChange={handleCeStrikeChange}
            onShiftUp={() => handleShiftStrike('CE', 'UP')}
            onShiftDown={() => handleShiftStrike('CE', 'DOWN')}
            onLimitPriceChange={setCeLimitPrice}
            onBuy={handleCeBuy}
            onSell={handleCeSell}
            pending={orderPending.has('CE')}
            strikesReady={strikesReady}
          />
        </div>
        <div className="flex-none w-[calc(20%-0.6rem)] min-w-[300px]">
          <OptionPanel
            side="PE"
            label="PUTS"
            strike={peStrike}
            visibleStrikes={visibleStrikes}
            atm={atm}
            ltp={peLtp}
            pct={pePct}
            high={peHigh}
            low={peLow}
            buildup={peBuildup}
            oiChgPct={peOiChgPct}
            limitPrice={peLimitPrice}
            orderMode={orderMode}
            onStrikeChange={handlePeStrikeChange}
            onShiftUp={() => handleShiftStrike('PE', 'UP')}
            onShiftDown={() => handleShiftStrike('PE', 'DOWN')}
            onLimitPriceChange={setPeLimitPrice}
            onBuy={handlePeBuy}
            onSell={handlePeSell}
            pending={orderPending.has('PE')}
            strikesReady={strikesReady}
          />
        </div>
      </div>

      {/* Bottom tabs panel */}
      <div className="flex-1 flex flex-col mx-4 mb-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="flex items-center gap-1 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/40">
          {([
            ['positions', positionsData] as const,
            ['orders',    ordersData]    as const,
            ['trades',    tradesData]    as const,
            ['funds',     []]            as const,
          ]).map(([tab, data]) => (
            <button key={tab} onClick={() => { setActiveTab(tab as typeof activeTab); setTableSort({ key: 'none', dir: 'asc' }); }}
              className={cn(
                'px-3 py-1.5 text-xs font-semibold rounded-lg transition-all capitalize',
                activeTab === tab
                  ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                  : 'text-zinc-500 hover:text-zinc-300',
                FOCUS_RING,
              )}>
              {tab}{data.length > 0 ? ` (${data.length})` : ''}
            </button>
          ))}
          <button onClick={fetchTabData} disabled={tabLoading}
            className={cn(
              'ml-auto flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg',
              'border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200',
              'transition-all disabled:opacity-50', FOCUS_RING,
            )}>
            <RefreshCw className={`w-3 h-3 ${tabLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Table content */}
        <div className="flex-1 overflow-auto">
          {activeTab === 'funds' ? (
            <FundsView
              data={fundsData}
              realizedPnl={enrichedPositions.reduce((sum, p) => sum + (Number(p.realizedProfit) || 0), 0)}
            />
          ) : activeTab === 'positions' ? (
            <PositionsTable
              data={enrichedPositions}
              guards={posGuards}
              closingPositions={closingPositions}
              onGuardChange={handleGuardChange}
              onTrailToggle={handleTrailToggle}
              onClose={handleClosePosition}
              onAddLeg={handleAddLeg}
              sort={tableSort}
              onSort={handleTableSort}
            />
          ) : (
            <TabTable
              tab={activeTab}
              data={activeTab === 'orders' ? ordersData : tradesData}
              sort={tableSort}
              onSort={handleTableSort}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── OptionPanel ──────────────────────────────────────────────────

export interface OptionPanelProps {
  side: 'CE' | 'PE';
  label: string;
  strike: number | null;
  visibleStrikes: number[];
  atm: number;
  ltp: number;
  pct: number | null;
  /** Day high/low of the selected strike (0 or omitted hides the H/L row) */
  high?: number;
  low?: number;
  /** 4-way OI buildup label ('LB'|'SB'|'SC'|'LU'); empty/omitted hides the chip */
  buildup?: string;
  /** OI change vs prev day (%), shown alongside the buildup label */
  oiChgPct?: number;
  limitPrice: string;
  orderMode: 'MARKET' | 'LIMIT';
  onStrikeChange: (s: number) => void;
  /** Callbacks for shifting the strike up or down (auto-closing active position if any) */
  onShiftUp?: () => void;
  onShiftDown?: () => void;
  /** Fraction of the open position the shift chevrons roll. A compact ½/Full toggle renders
   *  only when this and onMoveFractionChange are both supplied; omit for the legacy full roll. */
  moveFraction?: 'HALF' | 'FULL';
  onMoveFractionChange?: (f: 'HALF' | 'FULL') => void;
  /** Greys out the ½ segment (e.g. the leg has fewer than 2 open lots) with an explanatory tooltip. */
  halfMoveDisabled?: boolean;
  halfMoveDisabledReason?: string;
  onLimitPriceChange: (p: string) => void;
  onBuy: () => void;
  onSell: () => void;
  /** Per-box lot count (defaults to shared/global lots when omitted, matching original 2-box Scalper) */
  lots?: number;
  onLotsChange?: (l: number) => void;
  /** Shows a remove ("×") control in the header when provided; used by Advanced Scalper's dynamic box list */
  onRemove?: () => void;
  canRemove?: boolean;
  /** Per-box realized+unrealized P&L, shown under the LTP tile when provided */
  pnl?: number;
  /** Turns the CE/PE badge into a toggle when provided; used by Advanced Scalper's per-box side switch */
  onSideChange?: (side: 'CE' | 'PE') => void;
  /** Disables Buy/Sell while an order for this box/side is already in flight (blocks double-fire) */
  pending?: boolean;
  /** False while the strike→securityId lookup for the current expiry hasn't loaded yet — disables
   *  Buy/Sell so an order can never silently fall back to the slow Python order path. Omit/true = ready. */
  strikesReady?: boolean;
}

export const BUILDUP_STYLES: Record<string, { text: string; cls: string }> = {
  LB: { text: 'Long Buildup',   cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  SB: { text: 'Short Buildup',  cls: 'bg-rose-500/10 text-rose-400 border-rose-500/20' },
  SC: { text: 'Short Covering', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  LU: { text: 'Long Unwinding', cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-600' },
};

/**
 * Ignores every on* callback prop on purpose: the caller (AdvancedScalper's
 * boxes.map) hands this a freshly-created closure for every one of them on
 * every render (they close over `box.id`), which would defeat memoization
 * if compared, but they're otherwise harmless to recreate. Only the data
 * props are compared — `strike`/`ltp`/`pct`/etc are the values that
 * actually change per WS tick, and `visibleStrikes` is itself a stable
 * memoized array at the call site, so this comparator is what lets an
 * option-ticket box skip re-rendering on a tick that didn't touch it.
 */
function optionPanelPropsEqual(prev: OptionPanelProps, next: OptionPanelProps): boolean {
  return prev.side === next.side && prev.label === next.label && prev.strike === next.strike
    && prev.visibleStrikes === next.visibleStrikes && prev.atm === next.atm && prev.ltp === next.ltp
    && prev.pct === next.pct && prev.high === next.high && prev.low === next.low
    && prev.buildup === next.buildup && prev.oiChgPct === next.oiChgPct
    && prev.limitPrice === next.limitPrice && prev.orderMode === next.orderMode
    && prev.moveFraction === next.moveFraction && prev.halfMoveDisabled === next.halfMoveDisabled
    && prev.halfMoveDisabledReason === next.halfMoveDisabledReason
    && prev.lots === next.lots && prev.canRemove === next.canRemove && prev.pnl === next.pnl
    && prev.pending === next.pending && prev.strikesReady === next.strikesReady;
}

export const OptionPanel = React.memo(function OptionPanel({
  side, label, strike, visibleStrikes, atm, ltp, pct, high, low, buildup, oiChgPct,
  limitPrice, orderMode, onStrikeChange, onShiftUp, onShiftDown, onLimitPriceChange, onBuy, onSell,
  lots, onLotsChange, onRemove, canRemove, pnl, onSideChange,
  moveFraction, onMoveFractionChange, halfMoveDisabled, halfMoveDisabledReason,
  pending = false, strikesReady = true,
}: OptionPanelProps) {
  const orderDisabled = !strike || pending || !strikesReady;
  const showStepper = lots !== undefined && !!onLotsChange;
  const showMoveToggle = !!moveFraction && !!onMoveFractionChange;
  const rollsHalf = moveFraction === 'HALF';
  const isPos = (v: number) => v >= 0;
  // The WS bridge (live_options_ws.py) is the single source of buildup labels.
  // Re-deriving them here with a second set of dead-bands made the same strike
  // show different labels in different panels, and an empty label from the bridge
  // means "not classifiable" (missing prev-day baseline), not "compute it yourself".
  const buildupStyle = buildup ? BUILDUP_STYLES[buildup] : undefined;

  // The "← ATM" hint only fits when the panel itself has room for it — a fixed
  // select width would either clip the hint on a narrow panel or sit mostly
  // empty on a wide one. Track the panel's actual rendered width and switch
  // between a compact (number only) and full (number + hint) layout.
  const rootRef = useRef<HTMLDivElement>(null);
  // Default to compact so an unmeasured first paint can't overflow the card;
  // ResizeObserver corrects it to the real state on the next frame.
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const COMPACT_BELOW_PX = 315;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setCompact(width < COMPACT_BELOW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4 min-w-0">
      {/* Header: badge + strike selector + shift buttons + remove */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        {onSideChange ? (
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg shrink-0">
            {(['CE', 'PE'] as const).map(s => (
              <button key={s} onClick={() => onSideChange(s)}
                className={cn(
                  'px-2.5 py-1 text-xs font-bold uppercase tracking-widest rounded-md transition-all',
                  side === s
                    ? (s === 'CE'
                        ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/20')
                    : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
                  FOCUS_RING,
                )}>
                {s}
              </button>
            ))}
          </div>
        ) : (
          <span className={`shrink-0 text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded-lg border ${
            side === 'CE'
              ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
              : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
          }`}>{label} ({side})</span>
        )}

        <div className="flex items-center gap-0.5 justify-end shrink-0">
          {onShiftUp && (
            <button
              onClick={onShiftUp}
              disabled={orderDisabled}
              title={`Shift strike up — rolls ${rollsHalf ? 'HALF of' : 'the entire'} the open position`}
              aria-label={`Shift ${side} strike up`}
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded-lg border border-emerald-500/20',
                'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-oncolor hover:border-emerald-500',
                'disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95', FOCUS_RING,
              )}
            >
              <ChevronUp size={14} strokeWidth={2.5} />
            </button>
          )}
          <select value={strike ?? ''} onChange={e => onStrikeChange(Number(e.target.value))}
            className={`shrink-0 ${compact ? 'w-[88px]' : 'w-[136px]'} bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                       rounded-lg px-1.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums transition-[width]`}>
            {!strike && <option value="">— select —</option>}
            {visibleStrikes.map(sk => (
              <option key={sk} value={sk}>
                {sk.toLocaleString('en-IN')}{sk === atm && !compact ? ' ← ATM' : ''}
              </option>
            ))}
          </select>
          {onShiftDown && (
            <button
              onClick={onShiftDown}
              disabled={orderDisabled}
              title={`Shift strike down — rolls ${rollsHalf ? 'HALF of' : 'the entire'} the open position`}
              aria-label={`Shift ${side} strike down`}
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded-lg border border-rose-500/20',
                'bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-oncolor hover:border-rose-500',
                'disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95', FOCUS_RING,
              )}
            >
              <ChevronDown size={14} strokeWidth={2.5} />
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              disabled={!canRemove}
              title={canRemove ? 'Remove box' : 'Square off position before removing'}
              aria-label="Remove box"
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded-lg border border-zinc-700',
                'bg-zinc-800 text-zinc-400 hover:text-rose-300 hover:border-rose-500/40',
                'disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm font-bold', FOCUS_RING,
              )}
            >×</button>
          )}
        </div>
      </div>

      {/* Per-box lot stepper + strike-move fraction toggle. The header row above
          is already tight (chevrons + strike select + remove, hence the compact
          ResizeObserver), so the toggle lives down here beside the stepper. */}
      {(showStepper || showMoveToggle) && (
        <div className="flex items-center justify-center gap-2 self-center">
          {lots !== undefined && onLotsChange && (
            <div className="flex items-center bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
              <button onClick={() => onLotsChange(Math.max(1, lots - 1))} title="Reduce lots by one" aria-label="Reduce lots by one"
                className={cn('px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm', FOCUS_RING)}>−</button>
              <span className="px-2 text-xs font-mono tabular-nums text-zinc-200 min-w-[3.5rem] text-center border-x border-zinc-700">
                {lots} lot{lots !== 1 ? 's' : ''}
              </span>
              <button onClick={() => onLotsChange(lots + 1)} title="Add one lot" aria-label="Add one lot"
                className={cn('px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors font-bold text-sm', FOCUS_RING)}>+</button>
            </div>
          )}
          {moveFraction && onMoveFractionChange && (
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-lg px-1.5 py-1">
              <span className={cn(TXT_LABEL, 'font-bold uppercase tracking-wider text-zinc-400')}>Move</span>
              {(['HALF', 'FULL'] as const).map(f => {
                const isHalf = f === 'HALF';
                const dis = isHalf && !!halfMoveDisabled;
                return (
                  <button
                    key={f}
                    type="button"
                    disabled={dis}
                    onClick={() => onMoveFractionChange(f)}
                    title={dis
                      ? (halfMoveDisabledReason ?? 'Needs ≥2 open lots to move half')
                      : isHalf
                        ? 'Chevrons roll HALF the open quantity (rounded down to whole lots)'
                        : 'Chevrons roll the ENTIRE open position'}
                    className={cn(
                      'px-1.5 py-0.5 rounded font-bold', TXT_LABEL, 'transition-all disabled:opacity-30 disabled:cursor-not-allowed',
                      moveFraction === f
                        ? 'bg-amber-600 border border-amber-400 text-oncolor'
                        : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200',
                      FOCUS_RING,
                    )}
                  >
                    {isHalf ? '½' : 'Full'}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* LTP + % change */}
      <div className="bg-zinc-800/50 rounded-xl p-4 text-center">
        <p className={cn(TXT_VALUE, 'font-bold text-white uppercase tracking-widest mb-1')}>LTP</p>
        <div className="flex items-center justify-center gap-2">
          <p className="text-3xl font-bold font-mono tabular-nums text-white leading-none">
            {fmtLTP(ltp)}
          </p>
          <Sparkline value={ltp} trendValue={pnl} />
        </div>
        {pct !== null ? (
          <p className={`text-sm font-semibold font-mono mt-1.5 ${isPos(pct) ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isPos(pct) ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
          </p>
        ) : (
          <p className="text-xs text-zinc-300 mt-1.5">— vs prev close</p>
        )}
        {(high ?? 0) > 0 && (low ?? 0) > 0 && (
          <p className="text-xs font-mono tabular-nums mt-1.5">
            <span className="text-zinc-500 font-bold">H </span>
            <span className="text-emerald-400">{fmtLTP(high!)}</span>
            <span className="text-zinc-600 mx-1.5">·</span>
            <span className="text-zinc-500 font-bold">L </span>
            <span className="text-rose-400">{fmtLTP(low!)}</span>
          </p>
        )}
        {buildupStyle && (
          <p className="mt-2">
            <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border font-bold', TXT_CAPTION, buildupStyle.cls)}>
              {buildupStyle.text}
              {(oiChgPct ?? 0) !== 0 && (
                <span className="font-mono tabular-nums font-semibold">
                  OI {oiChgPct! > 0 ? '+' : ''}{oiChgPct!.toFixed(1)}%
                </span>
              )}
            </span>
          </p>
        )}
        {pnl !== undefined && (
          <p className={`text-xs font-bold font-mono tabular-nums mt-2 ${pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-500'}`}>
            P&amp;L {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}
          </p>
        )}
      </div>

      {/* Limit price input (only in LIMIT mode) */}
      {orderMode === 'LIMIT' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 font-medium whitespace-nowrap">Limit ₹</span>
          <input
            type="number" step="0.05" min="0.05"
            value={limitPrice}
            onChange={e => onLimitPriceChange(e.target.value)}
            placeholder="0.00"
            className={cn(
              'flex-1 bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm font-mono',
              'rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500 tabular-nums',
              'placeholder:text-zinc-600', FOCUS_RING,
            )}
          />
        </div>
      )}

      {/* BUY / SELL buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={onBuy}
          disabled={orderDisabled}
          title={!strikesReady ? 'Loading strike IDs…' : undefined}
          className={cn(
            'py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95',
            'bg-emerald-600 hover:bg-emerald-500 text-oncolor',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'shadow-lg shadow-emerald-900/20', FOCUS_RING,
          )}
        >
          {pending ? '…' : `BUY ${side}`}
        </button>
        <button
          onClick={onSell}
          disabled={orderDisabled}
          title={!strikesReady ? 'Loading strike IDs…' : undefined}
          className={cn(
            'py-3.5 px-4 text-sm font-bold rounded-xl transition-all active:scale-95',
            'bg-rose-600 hover:bg-rose-500 text-oncolor',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'shadow-lg shadow-rose-900/20', FOCUS_RING,
          )}
        >
          {pending ? '…' : `SELL ${side}`}
        </button>
      </div>
    </div>
  );
}, optionPanelPropsEqual);

// ─── Sorting helpers ────────────────────────────────────────────────

export type SortState = { key: string; dir: 'asc' | 'desc' };

export function sortRows(data: Record<string, unknown>[], sort: SortState): Record<string, unknown>[] {
  if (sort.key === 'none') return data;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...data].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    const an = Number(av), bn = Number(bv);
    if (av !== '' && bv !== '' && av != null && bv != null && !isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
}

export function SortableTH({ children, sortKey, currentSort, onSort, align = 'left', className = '' }: {
  children: React.ReactNode;
  sortKey: string;
  currentSort: SortState;
  onSort: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const active = currentSort.key === sortKey;
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th
      className={`px-3 py-2.5 text-xs font-bold text-white ${alignCls} whitespace-nowrap cursor-pointer select-none hover:bg-zinc-700 ${className}`}
      onClick={() => onSort(sortKey)}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {children}
        {active && (currentSort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </span>
    </th>
  );
}

// ─── GuardStepper ─────────────────────────────────────────────────

export function GuardStepper({ value, onChange, colorCls, disabled }: {
  value: string;
  onChange: (v: string) => void;
  colorCls: string;
  disabled?: boolean;
}) {
  const step = (delta: number) => {
    const cur = parseFloat(value) || 0;
    const next = Math.max(0, cur + delta);
    onChange(next.toFixed(2));
  };
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => step(1)} tabIndex={-1} disabled={disabled} aria-label="Increase by 1"
        className={cn('leading-none', TXT_LABEL, 'px-1 rounded-t border border-b-0 border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed', colorCls, FOCUS_RING)}>▲</button>
      <button type="button" onClick={() => step(-1)} tabIndex={-1} disabled={disabled} aria-label="Decrease by 1"
        className={cn('leading-none', TXT_LABEL, 'px-1 rounded-b border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed', colorCls, FOCUS_RING)}>▼</button>
    </div>
  );
}

// ─── GuardInput ───────────────────────────────────────────────────
// Number input + stepper whose typed value commits only on Enter or blur.
// Keystrokes stay in a local draft so the 1s guard monitor never acts on a
// partially typed price (e.g. "1" while typing "150"). Escape reverts the
// draft; stepper clicks still commit immediately. An amber border marks an
// uncommitted draft.

export function GuardInput({ value, onCommit, colorCls, focusBorderCls, disabled }: {
  value: string;
  onCommit: (v: string) => void;
  colorCls: string;
  focusBorderCls: string;
  disabled?: boolean;
}) {
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => { draftRef.current = v; setDraftState(v); };

  const shown = draft ?? value;
  const dirty = draft !== null && draft !== value;

  const commit = () => {
    const d = draftRef.current;
    if (d !== null && d !== value) onCommit(d);
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="number" step="0.05" min="0"
        value={shown}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        placeholder="—"
        disabled={disabled}
        title="Press Enter or click away to apply"
        className={cn(
          'w-20 bg-zinc-900 border text-xs font-mono rounded px-2 py-1 focus:outline-none tabular-nums text-right placeholder:text-zinc-600 disabled:opacity-40',
          colorCls,
          dirty ? 'border-amber-400' : cn('border-zinc-700', focusBorderCls),
          FOCUS_RING,
        )}
      />
      <GuardStepper
        value={shown}
        onChange={v => { setDraft(null); onCommit(v); }}
        colorCls={colorCls}
        disabled={disabled}
      />
    </div>
  );
}

// ─── PositionsTable ───────────────────────────────────────────────

export interface PositionsTableProps {
  data: Record<string, unknown>[];
  /** Keyed by lib/positionProduct's `positionKey` — (symbol, product), NOT symbol
   *  alone. The same symbol can be open under two products, and they are separate
   *  positions with separate guards. */
  guards: Record<string, PositionGuard>;
  /** Same composite key as `guards`. */
  closingPositions: Set<string>;
  onGuardChange: (positionKey: string, field: 'target' | 'sl', value: string) => void;
  onTrailToggle: (positionKey: string) => void;
  onClose: (pos: Record<string, unknown>) => void;
  onAddLeg: (pos: Record<string, unknown>) => void;
  /** Per-row lot size for the partial square-off chips. Return null when it can't be
   *  resolved for that row (e.g. a leg from a different underlying than the terminal has
   *  loaded) — the chips then hide and only the full Close button is offered.
   *  Rows themselves carry no lot size: no broker's position shape reports one. */
  lotSizeFor?: (row: Record<string, unknown>) => number | null;
  /** Partial square-off. `units` is ABSOLUTE quantity, already rounded to whole lots. */
  onClosePartial?: (pos: Record<string, unknown>, units: number, pct: number) => void;
  sort: SortState;
  onSort: (key: string) => void;
  // Set when the last positions fetch failed (network/API error) rather than
  // genuinely returning zero positions — lets the empty state say so instead
  // of implying the account is flat.
  error?: string | null;
}

/** Quick Target / SL chips in the positions table. Percent-only by design —
 *  a mix of % and point chips read ambiguously on options priced ₹5–₹400. */
const GUARD_PRESET_PCTS = [10, 15, 20, 25, 30];

interface PositionRowProps {
  row: Record<string, unknown>;
  rowKey: string;
  guard?: PositionGuard;
  isClosing: boolean;
  onGuardChange: (positionKey: string, field: 'target' | 'sl', value: string) => void;
  onTrailToggle: (positionKey: string) => void;
  onClose: (pos: Record<string, unknown>) => void;
  onAddLeg: (pos: Record<string, unknown>) => void;
  lotSizeFor?: (row: Record<string, unknown>) => number | null;
  onClosePartial?: (pos: Record<string, unknown>, units: number, pct: number) => void;
}

/**
 * Ignores the on* callback props on purpose: PositionsTable hands this a
 * freshly-created closure for each of them on every render (they close over
 * `row`/`rowKey`), which would defeat memoization if compared, but they're
 * otherwise harmless to recreate. `row` and `guard` are what actually vary
 * per tick, and both come from AdvancedScalper's own value-diffed
 * `enrichedPositions`/`posGuards`, which keep the same object reference
 * across ticks that don't change this row's numbers — that's what makes
 * this comparator useful rather than a no-op.
 */
function positionRowPropsEqual(prev: PositionRowProps, next: PositionRowProps): boolean {
  return prev.row === next.row && prev.guard === next.guard && prev.isClosing === next.isClosing;
}

const PositionRow = React.memo(function PositionRow({
  row, rowKey, guard, isClosing, onGuardChange, onTrailToggle, onClose, onAddLeg, lotSizeFor, onClosePartial,
}: PositionRowProps) {
  const sym = String(row.tradingSymbol ?? '');
  const netQty = Number(row.netQty);
  const ltp = Number(row.lastTradedPrice);
  const isLong = netQty > 0;
  const realPnl = Number(row.realizedProfit);
  const unrealPnl = Number(row.unrealizedProfit);
  const buyAvg = Number(row.buyAvg);
  const sellAvg = Number(row.sellAvg);

  // Compute current effective trailing SL price to show below the checkbox
  const targetNum = parseFloat(guard?.target ?? '');
  const slNum = parseFloat(guard?.sl ?? '');
  const entryPrice = isLong ? buyAvg : sellAvg;
  const initialRisk = (entryPrice > 0 && !isNaN(slNum) && slNum > 0) ? Math.abs(slNum - entryPrice) : 0;
  const trailBest = guard?.bestPrice ?? 0;
  const effectiveTrailSL = (netQty !== 0 && guard?.trailEnabled && trailBest > 0 && initialRisk > 0)
    ? (isLong ? trailBest - initialRisk : trailBest + initialRisk)
    : null;

  const mult = contractMultiplier(row);
  // A flat row (netQty 0) is a closed-out leg the broker still reports for
  // the day. There is nothing left to protect, so every guard control is
  // inert — the monitoring loop skips netQty === 0 rows anyway.
  const isFlat = netQty === 0;
  const guardsDisabled = isClosing || isFlat;
  const hasGuard = !isFlat && guard && (guard.target || guard.sl || guard.trailEnabled);
  // Rupee magnitude of the Target/SL price levels, for the RiskRail —
  // same diff*qty*mult math the Target/SL subtexts below compute inline,
  // pulled up so the rail can share it without duplicating the formula.
  const targetRupeeMag = (!isFlat && !isNaN(targetNum) && targetNum > 0 && entryPrice > 0 && mult > 0)
    ? Math.abs((isLong ? targetNum - entryPrice : entryPrice - targetNum) * Math.abs(netQty) * mult) : null;
  const slRupeeMag = (!isFlat && !isNaN(slNum) && slNum > 0 && entryPrice > 0 && mult > 0)
    ? Math.abs((isLong ? entryPrice - slNum : slNum - entryPrice) * Math.abs(netQty) * mult) : null;

  return (
    <tr className={`hover:bg-zinc-800/40 transition-colors ${isClosing ? 'opacity-40' : ''} ${guard?.triggered ? 'bg-zinc-800/20' : ''}`}>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-zinc-300">
        <div className="flex items-center gap-1.5">
          {hasGuard && !guard.triggered && (
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" title="Guard active" />
          )}
          {sym}
        </div>
      </td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{netQty}</td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{buyAvg > 0 ? buyAvg.toFixed(2) : '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{sellAvg > 0 ? sellAvg.toFixed(2) : '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums text-zinc-300">{ltp > 0 ? ltp.toFixed(2) : '—'}</td>
      <td className={`px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums ${!isNaN(realPnl) && realPnl !== 0 ? (realPnl > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-400'}`}>
        {isNaN(realPnl) ? '—' : realPnl.toFixed(0)}
      </td>
      <td className={`px-3 py-2 whitespace-nowrap font-mono text-right tabular-nums ${!isNaN(unrealPnl) && unrealPnl !== 0 ? (unrealPnl > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-400'}`}>
        {isNaN(unrealPnl) ? '—' : unrealPnl.toFixed(0)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap font-mono text-zinc-300">{String(row.productType ?? '—')}</td>

      {/* Target input & quick presets */}
      <td className="px-2 py-1.5">
        <div className="flex flex-col items-center gap-1">
          <GuardInput
            value={guard?.target ?? ''}
            onCommit={v => onGuardChange(rowKey, 'target', v)}
            colorCls="text-emerald-300"
            focusBorderCls="focus:border-emerald-500"
            disabled={guardsDisabled}
          />
          {/* Preset Chips */}
          <div className={cn('flex items-center gap-0.5', TXT_LABEL, 'font-mono')}>
            {GUARD_PRESET_PCTS.map(pct => (
              <button
                key={pct}
                disabled={guardsDisabled || entryPrice <= 0}
                onClick={() => {
                  if (entryPrice <= 0) return;
                  // Target is always a move IN FAVOUR of the position:
                  // longs profit as price rises, shorts as it falls.
                  const calculated = isLong
                    ? entryPrice * (1 + pct / 100)
                    : entryPrice * (1 - pct / 100);
                  if (calculated > 0) onGuardChange(rowKey, 'target', calculated.toFixed(2));
                }}
                className={cn('px-1 py-0.5 rounded bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 hover:bg-emerald-800 hover:text-oncolor transition-all disabled:opacity-30', FOCUS_RING)}
                title={`Set Target ${pct}% in profit from entry ₹${entryPrice.toFixed(2)}`}
              >
                +{pct}%
              </button>
            ))}
          </div>
          {/* Target P&L Subtext */}
          {!isFlat && !isNaN(targetNum) && targetNum > 0 && entryPrice > 0 && mult > 0 && (() => {
            const diff = isLong ? targetNum - entryPrice : entryPrice - targetNum;
            const pctVal = (diff / entryPrice) * 100;
            const rupeeVal = diff * Math.abs(netQty) * mult;
            const isProfit = diff >= 0;
            return (
              <span className={cn(TXT_LABEL, 'font-mono tabular-nums whitespace-nowrap', isProfit ? 'text-emerald-400/90' : 'text-rose-400/90')}>
                {isProfit ? '+' : ''}{pctVal.toFixed(1)}% ({isProfit ? '+' : ''}₹{rupeeVal.toFixed(0)})
              </span>
            );
          })()}
        </div>
      </td>

      {/* SL input & quick presets */}
      <td className="px-2 py-1.5">
        <div className="flex flex-col items-center gap-1">
          <GuardInput
            value={guard?.sl ?? ''}
            onCommit={v => onGuardChange(rowKey, 'sl', v)}
            colorCls="text-rose-300"
            focusBorderCls="focus:border-rose-500"
            disabled={guardsDisabled}
          />
          {/* Preset Chips */}
          <div className={cn('flex items-center gap-0.5', TXT_LABEL, 'font-mono')}>
            {GUARD_PRESET_PCTS.map(pct => (
              <button
                key={pct}
                disabled={guardsDisabled || entryPrice <= 0}
                onClick={() => {
                  if (entryPrice <= 0) return;
                  // SL is always a move AGAINST the position.
                  const calculated = isLong
                    ? entryPrice * (1 - pct / 100)
                    : entryPrice * (1 + pct / 100);
                  if (calculated > 0) onGuardChange(rowKey, 'sl', calculated.toFixed(2));
                }}
                className={cn('px-1 py-0.5 rounded bg-rose-950/80 border border-rose-800/60 text-rose-400 hover:bg-rose-800 hover:text-oncolor transition-all disabled:opacity-30', FOCUS_RING)}
                title={`Set SL ${pct}% in loss from entry ₹${entryPrice.toFixed(2)}`}
              >
                -{pct}%
              </button>
            ))}
          </div>
          {/* SL Loss Subtext */}
          {!isFlat && !isNaN(slNum) && slNum > 0 && entryPrice > 0 && mult > 0 && (() => {
            const diff = isLong ? entryPrice - slNum : slNum - entryPrice;
            const pctVal = (diff / entryPrice) * 100;
            const rupeeVal = diff * Math.abs(netQty) * mult;
            const isLoss = diff >= 0;
            return (
              <span className={cn(TXT_LABEL, 'font-mono tabular-nums whitespace-nowrap', isLoss ? 'text-rose-400/90' : 'text-emerald-400/90')}>
                {isLoss ? '-' : '+'}{pctVal.toFixed(1)}% ({isLoss ? '-' : '+'}₹{Math.abs(rupeeVal).toFixed(0)})
              </span>
            );
          })()}
          {/* Risk rail — where this leg's unrealized P&L sits between its
              SL and Target rupee levels, at a glance rather than reading
              three disconnected numbers across two columns. */}
          {(targetRupeeMag != null || slRupeeMag != null) && (
            <RiskRail totalPnl={unrealPnl} target={targetRupeeMag} stop={slRupeeMag} />
          )}
        </div>
      </td>

      {/* Trail SL checkbox + effective SL price when active */}
      <td className="px-2 py-1.5 text-center">
        <div className="flex flex-col items-center gap-0.5">
          <input
            type="checkbox"
            checked={guard?.trailEnabled ?? false}
            onChange={() => onTrailToggle(rowKey)}
            disabled={guardsDisabled || !guard?.sl}
            title={isFlat ? 'Position is flat' : guard?.sl ? 'Trail SL 1:1 with profit' : 'Set SL first'}
            className="w-4 h-4 accent-amber-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          />
          {effectiveTrailSL !== null && (
            <span className={cn(TXT_VALUE, 'font-mono text-amber-400 tabular-nums')}>
              @{effectiveTrailSL.toFixed(1)}
            </span>
          )}
        </div>
      </td>

      {/* Manual close / add-leg buttons + partial square-off chips */}
      <td className="px-2 py-1.5 text-center">
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center justify-center gap-1.5">
            <button
              onClick={() => onAddLeg(row)}
              disabled={isClosing || netQty === 0}
              title={`Load ${sym}'s strike into the order panel to add more or hedge`}
              className={cn('px-2.5 py-1', TXT_CAPTION, 'font-bold rounded border transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-900/40 border-emerald-500/30 text-emerald-400 hover:bg-emerald-800/60 hover:text-emerald-200 active:scale-95', FOCUS_RING)}
            >
              Add
            </button>
            <button
              onClick={() => onClose(row)}
              disabled={isClosing || netQty === 0}
              title={`Market close ${sym} — 100% (${Math.abs(netQty)} qty)`}
              className={cn('px-2.5 py-1', TXT_CAPTION, 'font-bold rounded border transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-rose-900/40 border-rose-500/30 text-rose-400 hover:bg-rose-800/60 hover:text-rose-200 active:scale-95', FOCUS_RING)}
            >
              {isClosing ? '…' : 'Close'}
            </button>
          </div>
          {/* Partial square-off. 100% is the Close button above, so only the
              fractions appear here. A chip is disabled when it maps to under a
              lot, or to the same lot count as a smaller one — see lib/partialQty. */}
          {onClosePartial && lotSizeFor && netQty !== 0 && (() => {
            const ls = lotSizeFor(row);
            if (!ls || ls <= 0) return null;
            return (
              <div className={cn('flex items-center gap-0.5', TXT_LABEL, 'font-mono')}>
                {partialCloseChips(netQty, ls, [25, 50, 75]).map(c => (
                  <button
                    key={c.pct}
                    type="button"
                    disabled={isClosing || !c.enabled}
                    onClick={() => onClosePartial(row, c.units, c.pct)}
                    title={c.title}
                    className={cn('px-1 py-0.5 rounded bg-rose-950/80 border border-rose-800/60 text-rose-400 hover:bg-rose-800 hover:text-oncolor transition-all disabled:opacity-30 disabled:cursor-not-allowed', FOCUS_RING)}
                  >
                    {c.pct}%
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      </td>
    </tr>
  );
}, positionRowPropsEqual);

export const PositionsTable = React.memo(function PositionsTable({ data, guards, closingPositions, onGuardChange, onTrailToggle, onClose, onAddLeg, lotSizeFor, onClosePartial, sort, onSort, error }: PositionsTableProps) {
  // The broker positions API does not guarantee a stable row order between
  // polls, so with no explicit column sort applied ('none') the rows would
  // otherwise reshuffle on every 5s refresh. Pin each row to the order it was
  // first seen in, so the table only reorders when the user picks a sort.
  const rowOrderRef = useRef<Map<string, number>>(new Map());
  const nextOrderRef = useRef(0);
  const sortedData = useMemo(() => {
    if (sort.key !== 'none') return sortRows(data, sort);
    const order = rowOrderRef.current;
    for (const row of data) {
      const k = positionKey(row);
      if (!order.has(k)) order.set(k, nextOrderRef.current++);
    }
    return [...data].sort((a, b) => (order.get(positionKey(a))! - order.get(positionKey(b))!));
  }, [data, sort]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-sm" title={error ?? undefined}>
        {error ? (
          <span className="text-amber-500">Failed to load positions — retrying… ({error})</span>
        ) : (
          <span className="text-zinc-600">No positions data</span>
        )}
      </div>
    );
  }

  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-zinc-800 z-10">
        <tr>
          <SortableTH sortKey="tradingSymbol" currentSort={sort} onSort={onSort}>Symbol</SortableTH>
          <SortableTH sortKey="netQty" currentSort={sort} onSort={onSort} align="right">Qty</SortableTH>
          <SortableTH sortKey="buyAvg" currentSort={sort} onSort={onSort} align="right">Buy Avg</SortableTH>
          <SortableTH sortKey="sellAvg" currentSort={sort} onSort={onSort} align="right">Sell Avg</SortableTH>
          <SortableTH sortKey="lastTradedPrice" currentSort={sort} onSort={onSort} align="right">LTP</SortableTH>
          <SortableTH sortKey="realizedProfit" currentSort={sort} onSort={onSort} align="right">Real P&L</SortableTH>
          <SortableTH sortKey="unrealizedProfit" currentSort={sort} onSort={onSort} align="right">Unreal P&L</SortableTH>
          <SortableTH sortKey="productType" currentSort={sort} onSort={onSort}>Product</SortableTH>
          <th className="px-3 py-2.5 text-xs font-bold text-emerald-400 text-center whitespace-nowrap">Target ₹</th>
          <th className="px-3 py-2.5 text-xs font-bold text-rose-400 text-center whitespace-nowrap">SL ₹</th>
          <th className="px-3 py-2.5 text-xs font-bold text-amber-400 text-center whitespace-nowrap">Trail SL</th>
          <th className="px-3 py-2.5 text-xs font-bold text-white text-center whitespace-nowrap">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800/50">
        {sortedData.map(row => {
          // Guards and the closing spinner are keyed per (symbol, product): two
          // rows can share a symbol, and they are separate positions.
          const rowKey = positionKey(row);
          return (
            <PositionRow
              key={rowKey}
              row={row}
              rowKey={rowKey}
              guard={guards[rowKey]}
              isClosing={closingPositions.has(rowKey)}
              onGuardChange={onGuardChange}
              onTrailToggle={onTrailToggle}
              onClose={onClose}
              onAddLeg={onAddLeg}
              lotSizeFor={lotSizeFor}
              onClosePartial={onClosePartial}
            />
          );
        })}
      </tbody>
    </table>
  );
});

// ─── TabTable ─────────────────────────────────────────────────────

export interface TabTableProps {
  tab: 'positions' | 'orders' | 'trades';
  data: Record<string, unknown>[];
  sort: SortState;
  onSort: (key: string) => void;
}

export const COLUMNS: Record<string, { key: string; label: string; numeric?: boolean; highlight?: 'side' | 'pnl' }[]> = {
  positions: [
    { key: 'tradingSymbol',    label: 'Symbol' },
    { key: 'netQty',           label: 'Qty',          numeric: true },
    { key: 'buyAvg',           label: 'Buy Avg',      numeric: true },
    { key: 'sellAvg',          label: 'Sell Avg',     numeric: true },
    { key: 'lastTradedPrice',  label: 'LTP',          numeric: true },
    { key: 'realizedProfit',   label: 'Realized P&L', numeric: true, highlight: 'pnl' },
    { key: 'unrealizedProfit', label: 'Unreal. P&L',  numeric: true, highlight: 'pnl' },
    { key: 'productType',      label: 'Product' },
  ],
  orders: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'orderStatus',     label: 'Status' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'quantity',        label: 'Qty',    numeric: true },
    { key: 'price',           label: 'Price',  numeric: true },
    { key: 'orderType',       label: 'Type' },
    { key: 'createTime',      label: 'Time' },
  ],
  trades: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'tradedQuantity',  label: 'Qty',    numeric: true },
    { key: 'tradedPrice',     label: 'Price',  numeric: true },
    { key: 'createTime',      label: 'Time' },
  ],
};

export function TabTable({ tab, data, sort, onSort }: TabTableProps) {
  const cols = COLUMNS[tab];
  const sortedData = useMemo(() => sortRows(data, sort), [data, sort]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        No {tab} data
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-zinc-800 z-10">
        <tr>
          {cols.map(c => (
            <SortableTH key={c.key} sortKey={c.key} currentSort={sort} onSort={onSort} align={c.numeric ? 'right' : 'left'}>
              {c.label}
            </SortableTH>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800/50">
        {sortedData.map((row, i) => (
          <tr key={i} className="hover:bg-zinc-800/40 transition-colors">
            {cols.map(c => {
              const val = row[c.key] ?? (c.key === 'createTime' ? (row.updateTime || row.exchangeTime || row.ordEntTm || row.ordDtTm || row.order_timestamp) : null);
              const str = (val == null || String(val).trim() === '') ? '—' : String(val);
              let cls = `px-3 py-2 whitespace-nowrap font-mono ${c.numeric ? 'text-right tabular-nums' : ''}`;
              if (c.highlight === 'side') {
                cls += str === 'BUY' ? ' text-emerald-400 font-bold' : str === 'SELL' ? ' text-rose-400 font-bold' : ' text-zinc-300';
              } else if (c.highlight === 'pnl') {
                const n = Number(val);
                cls += !isNaN(n) && n !== 0 ? (n > 0 ? ' text-emerald-400' : ' text-rose-400') : ' text-zinc-400';
              } else {
                cls += ' text-zinc-300';
              }
              return <td key={c.key} className={cls}>{str}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── FundsView ────────────────────────────────────────────────────

export interface FundsViewProps {
  data: Record<string, any> | null;
  realizedPnl: number;
}

export function formatFundsValue(val: number): string {
  if (val === 0) return '0';
  if (Number.isInteger(val)) {
    return val.toLocaleString('en-IN');
  }
  return val.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

export function FundsView({ data, realizedPnl }: FundsViewProps) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
        No funds data available
      </div>
    );
  }

  const available = Number(data.availabelBalance) || 0;
  const used = Number(data.utilizedAmount) || 0;
  const total = available + used;

  // Collateral-aware brokers (Kotak) report how much of the balance is pledged
  // holdings rather than money. Showing only the headline invites sizing a
  // trade against Rs 9L that cannot pay a single rupee of option premium, so
  // the split is surfaced whenever the broker gives it.
  const collateral = Number(data.collateralAmount);
  const cash = Number(data.cashBalance);
  const hasCollateralSplit = Number.isFinite(collateral) && Number.isFinite(cash) && collateral > 0;

  const rows = [
    { label: 'Total Balance', value: total },
    { label: 'Used Margin', value: used },
    { label: 'Realized P&L', value: realizedPnl },
    { label: 'Available', value: available },
    ...(hasCollateralSplit
      ? [{ label: 'Collateral', value: collateral }, { label: 'Cash', value: cash }]
      : []),
  ];

  const renderSection = (title: string) => (
    <div className="flex-1 min-w-[280px] bg-zinc-900/20 border border-zinc-800/60 rounded-xl p-5">
      <h3 className="text-zinc-200 text-sm font-semibold mb-4 tracking-wide border-b border-zinc-800/80 pb-2">{title}</h3>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-zinc-800/40 text-zinc-500 font-semibold text-left">
            <th className="pb-2 font-medium">Type</th>
            <th className="pb-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/20 text-zinc-300">
          {rows.map((row) => (
            <tr key={row.label} className="hover:bg-zinc-800/10 transition-colors">
              <td className="py-3 text-left text-zinc-400">{row.label}</td>
              <td className={`py-3 text-right font-semibold ${
                row.label === 'Realized P&L' && row.value !== 0
                  ? row.value > 0 ? 'text-emerald-400' : 'text-rose-400'
                  : row.label === 'Cash' && row.value <= 0
                    ? 'text-amber-400'
                    : 'text-zinc-100'
              }`}
              title={row.label === 'Cash' && row.value <= 0
                ? 'No cash: the balance is collateral from pledged holdings. Option writes are backed by it, but any premium debit (a BUY, including buying back a short to close) may be rejected.'
                : undefined}>
                {formatFundsValue(row.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="flex flex-wrap gap-5 p-5">
      {renderSection('NSE - Derivatives')}
      {renderSection('NSE - Equity')}
    </div>
  );
}
