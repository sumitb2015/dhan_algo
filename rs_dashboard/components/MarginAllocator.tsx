'use client';

/**
 * Margin Allocator — Bloomberg-style capital deployment desk.
 *
 * Three questions, one screen:
 *   1. How much margin is free across every logged-in broker right now?
 *   2. What is the margin I already have blocked actually buying me — broken
 *      down by the real option structure (straddle/strangle/condor/naked/spread),
 *      not just a flat "utilized" number?
 *   3. Given the idle balance, what near-dated (≈1-2 week) premium-selling
 *      setups would put it to work at the best risk-adjusted yield, without
 *      concentrating the whole book into one trade or one risk class?
 *
 * Visual language follows the dhan-bloomberg-dashboard-page skill — this page
 * reuses MarketDashboard.tsx's exact TerminalPanel/StatTile/badge formulas
 * rather than importing them (they are private to that file by design).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock,
  Database,
  ExternalLink,
  Send,
  XCircle,
  Zap,
  Gauge,
  Layers,
  PieChart,
  RefreshCw,
  Shield,
  ShieldAlert,
  Target,
  Wallet,
} from 'lucide-react';
import type { BrokerPortfolio, DashboardPortfolioResponse } from '@/app/api/dashboard/portfolio/route';
import type { MarginAllocatorResponse, PositionGroup } from '@/app/api/margin-allocator/route';
import type { MarketTrendResponse } from '@/app/api/margin-allocator/trend/route';
import type { ScanResponse, ScannedLeg, ScannedStrategy, StrategyType, UnderlyingType } from '@/lib/ultimateScannerTypes';
import type { MultiLegBasket } from '@/lib/multiLegFocus';
import { STRESS_MOVES_PCT, bookExpiryPnl, type StressLeg } from '@/lib/marginStress';
import { useLiveTickerPoll } from '@/lib/useLiveTickerPoll';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import NavBar from './NavBar';

// ─── Poll cadences (dhan-polling-guards skill) ────────────────────────────────
const PORTFOLIO_POLL_MS = 8_000;
const ALLOCATOR_POLL_MS = 15_000;
const BROKER_ORDER: Broker[] = ['dhan', 'zerodha', 'kotak'];
// Same per-broker accent already used for the broker badge on Baskets/Multi-Leg
// Focus (MultiLegStrategyRow's BROKER_STYLE, StrategyCard.tsx, StrategyRowWide.tsx)
// — every broker label here was hardcoded amber regardless of which broker it
// named, so the Dhan and Kotak cards/rows read identically at a glance.
const BROKER_ACCENT: Record<Broker, string> = {
  dhan: 'text-emerald-400',
  zerodha: 'text-sky-400',
  kotak: 'text-amber-400',
};
// BANKNIFTY weeklies were discontinued by NSE — /api/ultimate-scanner/expiries
// (and the scanner UI itself) only supports NIFTY/SENSEX, so that's the whole
// selector here too.
const SCAN_UNDERLYINGS: UnderlyingType[] = ['NIFTY', 'SENSEX'];
// "Next 1 to 2 weeks" is a window, not just an upper bound: below MIN_DTE a
// short strangle/condor is sitting in expiry-day gamma, and annualizing a
// 1-2 day credit multiplies it by ~180x into a meaningless RoM% headline.
const MIN_DTE_FOR_YIELD = 5;
const MAX_DTE_FOR_YIELD = 16;

// ─── Formatting helpers (mirrors MarketDashboard.tsx) ─────────────────────────
function fmtINRCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}
function fmtPct(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(dp)}%`;
}
function fmtBreakevens(levels: number[]): string {
  if (!levels.length) return '—';
  return levels.map((l) => Math.round(l).toLocaleString('en-IN')).join(' / ');
}

// ─── Shared shell primitives (copied verbatim from MarketDashboard.tsx) ───────

function TerminalPanel({
  title, icon: Icon, meta, href, badge, children, className = '',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: React.ReactNode;
  href?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const heading = (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">
        <Icon className="h-3.5 w-3.5 text-amber-400" />
        {title}
      </span>
      {badge}
    </div>
  );
  return (
    <section className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3.5 py-2.5">
        {href ? (
          <Link href={href} className="flex items-center gap-1.5 transition-colors hover:text-amber-300">
            {heading}
            <ExternalLink className="h-2.5 w-2.5 text-zinc-500 hover:text-amber-400" />
          </Link>
        ) : heading}
        {meta ? <div className="font-mono text-[11px] text-zinc-400">{meta}</div> : null}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

function StatTile({
  label, value, sub, progress, tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  progress?: { percent: number; colorClass?: string };
  tone?: 'neutral' | 'up' | 'down' | 'accent';
}) {
  const valueClass =
    tone === 'up' ? 'text-emerald-400'
    : tone === 'down' ? 'text-red-400'
    : tone === 'accent' ? 'text-amber-400'
    : 'text-zinc-100';
  return (
    <div className="flex flex-col justify-between gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-3 transition-colors hover:border-zinc-700">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">{label}</span>
        {progress && (
          <span className="font-mono text-[10px] font-semibold text-zinc-400">{progress.percent.toFixed(1)}%</span>
        )}
      </div>
      <div className={`font-mono text-lg font-bold leading-none tabular-nums ${valueClass}`}>{value}</div>
      {progress && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full transition-all duration-500 ${progress.colorClass ?? 'bg-amber-400'}`}
            style={{ width: `${Math.min(Math.max(progress.percent, 0), 100)}%` }}
          />
        </div>
      )}
      {sub ? <span className="font-mono text-[10px] text-zinc-500 truncate">{sub}</span> : null}
    </div>
  );
}

// Tailwind's JIT scanner needs literal class strings — a template-interpolated
// `border-${tone}-500/30` never gets generated. Every tone is spelled out here.
const BADGE_TONE_CLASSES: Record<'emerald' | 'red' | 'amber' | 'sky' | 'zinc', string> = {
  emerald: 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  red: 'border border-red-500/30 bg-red-500/10 text-red-400',
  amber: 'border border-amber-500/30 bg-amber-500/10 text-amber-400',
  sky: 'border border-sky-500/30 bg-sky-500/10 text-sky-400',
  zinc: 'border border-zinc-700 bg-zinc-800 text-zinc-400',
};

function Badge({ tone, children }: { tone: 'emerald' | 'red' | 'amber' | 'sky' | 'zinc'; children: React.ReactNode }) {
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${BADGE_TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center px-4 py-8 text-center font-mono text-xs text-zinc-500">
      {children}
    </div>
  );
}

/** Own component: a 1 Hz tick in the parent re-rendered every table on the page. */
function IstClock() {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-bold text-amber-400 shadow-sm">
      <Clock className="h-3 w-3 text-amber-400" />
      {clock || '--:--:--'} IST
    </span>
  );
}

/** One coloured slice of the capital map. `weight` is ₹; zero-weight slices are dropped. */
interface CapitalSegment { key: string; label: string; value: number; bar: string; dot: string; hint: string }

/**
 * The page's one signature element: every rupee of the Dhan margin base in a
 * single strip — locked in live positions, proposed by the plan, deployable
 * but unallocated, held back by the panic throttle, and the preset's untouched
 * buffer. Answers "where is my capital" before any table has to be read.
 */
function CapitalMap({ segments, total }: { segments: CapitalSegment[]; total: number }) {
  const live = segments.filter((s) => s.value > 0);
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div
        className="flex h-7 w-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950"
        role="img"
        aria-label={live.map((s) => `${s.label} ${fmtINRCompact(s.value)}`).join(', ')}
      >
        {live.map((s) => (
          <div
            key={s.key}
            className={`${s.bar} h-full border-r border-zinc-950 transition-all duration-500 last:border-r-0`}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: ${fmtINRCompact(s.value)} (${((s.value / total) * 100).toFixed(1)}%)`}
          />
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {segments.map((s) => (
          <div key={s.key} className={`flex flex-col gap-0.5 ${s.value > 0 ? '' : 'opacity-50'}`}>
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
              <span className={`h-2 w-2 rounded-sm ${s.dot}`} />
              {s.label}
            </dt>
            <dd className="font-mono text-sm font-bold tabular-nums text-zinc-100">
              {fmtINRCompact(s.value)}
              <span className="ml-1.5 text-[11px] font-normal text-zinc-500">{((s.value / total) * 100).toFixed(0)}%</span>
            </dd>
            <dd className="text-[11px] leading-snug text-zinc-500">{s.hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Long explanatory prose lives behind a disclosure so the numbers stay above the fold. */
function Notes({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-zinc-800 px-3.5 py-2 text-xs text-zinc-400">
      <summary className="cursor-pointer select-none font-semibold text-zinc-300 hover:text-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400">
        {summary}
      </summary>
      <div className="mt-2 max-w-3xl space-y-2 leading-relaxed">{children}</div>
    </details>
  );
}

// ─── CSP scanner row (mirrors components/CspScreener.tsx's ScanRow) ───────────
interface CspRow {
  symbol: string;
  score: number;
  ltp: number;
  expiry: string;
  dte: number;
  lotSize: number;
  strike: number;
  premium: number;
  premiumTotal: number;
  noHitProb: number;
  iv: number;
  oi: number;
  yieldPct: number;
  annYieldPct?: number;
  capitalRequired: number;
  isPick?: boolean;
  rationale: string;
}

// ─── Unified opportunity ranking + allocation ─────────────────────────────────

type RiskClass = 'defined' | 'undefined' | 'assignment';
type MarketTrend = 'bullish' | 'bearish' | 'neutral';

interface RankedCandidate {
  key: string;
  strategyType: StrategyType | 'csp';
  label: string;
  underlying: string;
  expiry: string;
  dte: number;
  marginPerUnit: number;
  creditPerUnit: number;
  popPct: number | null;
  romAnnualizedPct: number | null;
  score: number;
  riskType: RiskClass;
  detail: string;
  /** Net position delta per unit (signed: +bullish/-bearish exposure), straight
   *  from the scan engine's own Greeks. Null for CSP rows — csp_scanner.py
   *  doesn't compute one, so they're excluded from the portfolio delta gauge
   *  below rather than silently counted as flat (0) exposure they may not have. */
  deltaNet: number | null;
  /** Max loss per unit in ₹, negative or 0. Null means unlimited (undefined-risk
   *  strangle/straddle/naked side) — never coerce this to a number, the allocation
   *  table's Max Loss column depends on the null check to render "Unlimited". */
  maxLossPerUnit: number | null;
  /** Breakeven spot/strike level(s) in index points — one for a single-sided
   *  structure (naked put/call, CSP), two for a symmetric spread/condor/straddle. */
  breakevens: number[];
  /** Scan legs + spot, kept so the plan can be stress-tested and handed to
   *  Multi-Leg Focus. Absent for CSP rows (single-stock puts, not index legs). */
  legs?: ScannedLeg[];
  spot?: number;
  strategyName?: string;
}

interface AllocatedCandidate extends RankedCandidate {
  units: number;
  marginUsed: number;
  creditExpected: number;
  /** maxLossPerUnit scaled by units. Null (unlimited) is sticky — once any unit
   *  is unlimited-risk the total is unlimited, it never becomes "unlimited plus
   *  a number." */
  maxLossTotal: number | null;
}

/**
 * Bull Put Spread and the naked-put side of a Jade Lizard both lose their
 * edge (or worse) on a sharp drop, so both are "aligned" with a bullish
 * market read; Bear Call Spread and Reverse Jade Lizard's naked call side
 * are the mirror. Iron Condor/Butterfly/Strangle/Straddle are direction-
 * neutral by construction and are deliberately absent from this map — they
 * get no directional multiplier at all, never a 1.0 default that reads as
 * "considered neutral," since they were never scored against a direction.
 */
const DIRECTIONAL_BIAS: Partial<Record<StrategyType, MarketTrend>> = {
  bull_put_spread: 'bullish',
  jade_lizard: 'bullish',
  bear_call_spread: 'bearish',
  reverse_jade_lizard: 'bearish',
};

/** >1 rewards a candidate whose bias agrees with the market's own EMA20+Supertrend
 * read; <1 penalizes one fighting it. Never a hard filter — a counter-trend
 * spread still shows up, just ranked lower, so nothing vanishes silently. */
function directionalScoreMultiplier(strategyType: RankedCandidate['strategyType'], trend: MarketTrend): number {
  const bias = DIRECTIONAL_BIAS[strategyType as StrategyType];
  if (!bias || trend === 'neutral') return 1;
  return bias === trend ? 1.15 : 0.8;
}

/**
 * Naked-risk budget tilt from India VIX Percentile (trailing 1Y from
 * MarginAllocator/trend), multiplied onto the risk preset's own naked-risk
 * ceiling — see `effectiveUndefinedCap` below, which never lets this widen
 * past that ceiling. Piecewise-linear over three zones that mirror the
 * tastytrade IV-Rank/Percentile premium-selling convention: full size above
 * the 50th percentile, half-size 30-50, avoid below 30 (thin premium doesn't
 * compensate for undefined-risk tail exposure). Kept continuous rather than
 * a hard step so a candidate at percentile 29 isn't cliff-edged against one
 * at 31 — but the floor is deliberately low (0.15, not the old 0.5) so the
 * "avoid" zone actually throttles naked selling instead of merely halving it.
 */
function interpolatePiecewise(anchors: readonly (readonly [number, number])[], x: number): number {
  const clamped = Math.min(anchors[anchors.length - 1][0], Math.max(anchors[0][0], x));
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (clamped <= x1) return y0 + (y1 - y0) * ((clamped - x0) / (x1 - x0));
  }
  return anchors[anchors.length - 1][1];
}

const VIX_TILT_ANCHORS: readonly [number, number][] = [
  [0, 0.15],
  [30, 0.35],
  [50, 0.65],
  [100, 1.0],
];
function vixPercentileToNakedTilt(percentile: number): number {
  return interpolatePiecewise(VIX_TILT_ANCHORS, percentile);
}

/**
 * Total-deployable-budget multiplier from VIX Percentile — separate lever
 * from `vixPercentileToNakedTilt` above, which only re-splits an already-
 * fixed budget between naked and defined risk. This one shrinks the budget
 * itself, and only at the extreme high end (≥85th percentile — "panic"
 * territory in the absolute-regime bucket naming below). Rationale: entering
 * FRESH option-selling positions while VIX is still actively spiking is the
 * mistake behind Volmageddon-style short-vol blowups — premium is richest
 * exactly when parameter/repricing uncertainty is highest, so a Kelly-VIX
 * hybrid sizing approach cuts total size there rather than over-betting on
 * a premium level that may still be actively repricing. Flat at 1.0 below
 * the 85th percentile — this is not a second naked-risk throttle, ordinary
 * "rich premium" territory is left alone.
 */
const VIX_DEPLOY_ANCHORS: readonly [number, number][] = [
  [0, 1.0],
  [85, 1.0],
  [100, 0.6],
];
function vixPercentileToDeployMultiplier(percentile: number): number {
  return interpolatePiecewise(VIX_DEPLOY_ANCHORS, percentile);
}

// Live India VIX chip — sourced from the same WS-hub-backed /api/scalper/top-indices
// route AdvancedScalper's header VIX pill uses (live_indices_ws.py's
// live_indices_quotes.json snapshot), polled instead of waiting on the
// mount-only /api/ultimate-scanner/scan calls below, which can go stale for
// as long as this page stays open between manual refreshes.
interface VixHubResponse {
  updated_at: string;
  quotes: Record<string, { ltp: number; prev_close: number; change_pct: number | null }>;
}
// Module scope: useLiveTickerPoll restarts its poll loop if this identity is
// unstable across renders (see that hook's own doc comment).
function pickVixHubLtp(d: VixHubResponse): Record<string, number> {
  const ltp = d?.quotes?.VIX?.ltp;
  return typeof ltp === 'number' && ltp > 0 ? { VIX: ltp } : {};
}
// Mirrors computeVixRegime's thresholds in lib/ultimateScannerDhan.ts (the
// source for the scan-based vixInfo fallback below) so the regime badge text
// stays identical regardless of which source is live. Duplicated rather than
// imported because that module pulls in server-only fs/Node APIs that can't
// go into a 'use client' bundle.
function vixRegimeForLevel(vix: number): string {
  if (vix <= 12.5) return 'Low Volatility';
  if (vix <= 16.5) return 'Normal / Ideal Volatility';
  if (vix <= 22.0) return 'Elevated Volatility';
  return 'High Volatility / Panic';
}

function fromScannedStrategy(s: ScannedStrategy, trend: MarketTrend): RankedCandidate {
  const legsSummary = s.legs.map((l) => `${l.side === 'SELL' ? '-' : '+'}${l.strike}${l.option}`).join(' / ');
  return {
    key: s.id,
    strategyType: s.type,
    label: `${s.underlying} ${s.name}`,
    underlying: s.underlying,
    expiry: s.expiry,
    dte: s.dte,
    marginPerUnit: s.estMargin,
    creditPerUnit: s.netPremium,
    popPct: s.popPct,
    romAnnualizedPct: s.romAnnualizedPct,
    score: Math.round(s.score * directionalScoreMultiplier(s.type, trend)),
    riskType: s.maxLossUnlimited ? 'undefined' : 'defined',
    detail: legsSummary,
    deltaNet: s.deltaNet,
    maxLossPerUnit: s.maxLossUnlimited ? null : s.maxLoss,
    breakevens: s.breakevens,
    legs: s.legs,
    spot: s.spot,
    strategyName: s.name,
  };
}

function fromCspRow(r: CspRow): RankedCandidate {
  return {
    key: `csp-${r.symbol}-${r.strike}-${r.expiry}`,
    strategyType: 'csp',
    label: `${r.symbol} ${r.strike}PE CSP`,
    underlying: r.symbol,
    expiry: r.expiry,
    dte: r.dte,
    marginPerUnit: r.capitalRequired,
    creditPerUnit: r.premiumTotal,
    popPct: r.noHitProb,
    romAnnualizedPct: r.annYieldPct ?? null,
    score: r.score,
    riskType: 'assignment',
    detail: r.rationale,
    deltaNet: null,
    // CSP "max loss" isn't a hard cap the way a spread's wing width is — it's
    // the textbook assignment-to-zero scenario (you're put the stock at strike,
    // it then goes to ₹0): capitalRequired is strike*lotSize (csp_scanner.py),
    // so the loss floor is that minus the premium already collected.
    maxLossPerUnit: -(r.capitalRequired - r.premiumTotal),
    breakevens: [r.strike - r.premium],
  };
}

/**
 * NIFTY and SENSEX are ~99%-correlated large-cap benchmark indices — they
 * move together on all but the rarest sessions (the same premise the trend
 * route already relies on to borrow NIFTY's read for SENSEX). A plan holding
 * 60% margin in NIFTY Bull Put Spreads and another 60% in SENSEX Bull Put
 * Spreads is not diversified — it's the same directional bet on Indian
 * large-caps, doubled. Concentration caps below therefore key off this
 * *correlation group*, not the raw underlying string, so NIFTY+SENSEX
 * exposure is capped as ONE combined bucket. Every other underlying (single
 * F&O stocks from the CSP scanner) is its own group — cross-stock
 * correlation is a separate, unaddressed concern.
 */
const CORRELATION_GROUPS: Record<string, string> = {
  NIFTY: 'INDEX_BETA',
  SENSEX: 'INDEX_BETA',
};
function correlationGroup(underlying: string): string {
  return CORRELATION_GROUPS[underlying] ?? underlying;
}

/**
 * Greedy two-pass allocator for ONE risk category's own sub-budget (see call
 * site: the deployable balance is sliced into a defined-risk / undefined-risk
 * / assignment-risk share before this ever runs, so the category-level "don't
 * put it all in naked strangles" discipline lives there, not here).
 *
 * Within a category: diversify first (one unit of every candidate the budget
 * can fit, best score first), then spend leftover budget scaling the winners.
 * Two independent concentration caps apply together:
 *  - `maxPerUnderlyingFraction` stops one *correlation group* (see
 *    `correlationGroup` above — NIFTY+SENSEX combined, everything else
 *    individually) from eating the whole category.
 *  - `maxPerTypeFraction` additionally stops one *strategy type* within one
 *    correlation group — e.g. Bear Call Spread on NIFTY plus Bear Call
 *    Spread on SENSEX, which a scan naturally returns many strike variants
 *    of on each — from filling that group's whole share by itself. Without
 *    this, the group cap alone is satisfied by ten clones of the same
 *    directional bet, which is concentration wearing a diversification
 *    costume.
 */
function buildAllocationPlan(
  candidates: RankedCandidate[],
  budget: number,
  maxPerUnderlyingFraction = 0.6,
  maxPerTypeFraction = 0.35,
): { plan: AllocatedCandidate[]; used: number } {
  const sorted = [...candidates].filter((c) => c.marginPerUnit > 0).sort((a, b) => b.score - a.score);
  const underlyingCap = budget * maxPerUnderlyingFraction;
  const typeCap = budget * maxPerTypeFraction;
  const usedByUnderlying = new Map<string, number>();
  const usedByType = new Map<string, number>();
  let used = 0;
  const plan: AllocatedCandidate[] = [];

  const tryFit = (marginPerUnit: number, underlying: string, strategyType: string) => {
    const group = correlationGroup(underlying);
    const typeKey = `${group}:${strategyType}`;
    const u = usedByUnderlying.get(group) ?? 0;
    const t = usedByType.get(typeKey) ?? 0;
    if (u + marginPerUnit > underlyingCap) return false;
    if (t + marginPerUnit > typeCap) return false;
    if (used + marginPerUnit > budget) return false;
    used += marginPerUnit;
    usedByUnderlying.set(group, u + marginPerUnit);
    usedByType.set(typeKey, t + marginPerUnit);
    return true;
  };

  for (const c of sorted) {
    if (!tryFit(c.marginPerUnit, c.underlying, c.strategyType)) continue;
    plan.push({ ...c, units: 1, marginUsed: c.marginPerUnit, creditExpected: c.creditPerUnit, maxLossTotal: c.maxLossPerUnit });
  }

  // Second pass: scale up already-selected winners with leftover budget.
  for (const item of plan) {
    if (budget - used < budget * 0.03) break;
    if (!tryFit(item.marginPerUnit, item.underlying, item.strategyType)) continue;
    item.units += 1;
    item.marginUsed += item.marginPerUnit;
    item.creditExpected += item.creditPerUnit;
    if (item.maxLossTotal !== null && item.maxLossPerUnit !== null) item.maxLossTotal += item.maxLossPerUnit;
  }

  plan.sort((a, b) => b.marginUsed - a.marginUsed);
  return { plan, used };
}

// ─── Broker mini card ──────────────────────────────────────────────────────────

function BrokerMarginCard({ b }: { b: BrokerPortfolio }) {
  const isConnected = b.connected && !b.error;
  const util = b.totalBalance && b.totalBalance > 0 && b.utilizedMargin !== null
    ? (b.utilizedMargin / b.totalBalance) * 100 : 0;
  const utilColor = util > 85 ? 'bg-red-500' : util > 65 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="flex flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 transition-colors hover:border-zinc-700">
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <CircleDot className={`h-3 w-3 ${isConnected ? 'text-emerald-500' : 'text-zinc-600'}`} />
          <span className={`text-[11px] font-bold uppercase tracking-[0.15em] ${BROKER_ACCENT[b.broker]}`}>{BROKER_LABELS[b.broker]}</span>
        </div>
        <Badge tone={isConnected ? 'emerald' : 'zinc'}>{isConnected ? 'ONLINE' : 'OFFLINE'}</Badge>
      </div>
      {!isConnected ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <p className="font-mono text-xs text-zinc-500">{b.error ?? 'Session not active'}</p>
          <Link href="/login" className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1 font-mono text-[10px] font-bold text-amber-400 hover:bg-amber-500/20">
            Authenticate {BROKER_LABELS[b.broker]}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2 pt-2.5">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-xs">
            <dt className="text-zinc-500">Available Margin</dt>
            <dd className="text-right font-bold tabular-nums text-emerald-400">{fmtINRCompact(b.availableBalance)}</dd>
            <dt className="text-zinc-500">Utilized Margin</dt>
            <dd className="text-right tabular-nums text-zinc-200">{fmtINRCompact(b.utilizedMargin)}</dd>
            <dt className="text-zinc-500">Margin Base</dt>
            <dd className="text-right tabular-nums text-zinc-400">{fmtINRCompact(b.totalBalance)}</dd>
            {b.collateralAmount !== null && (
              <>
                <dt className="text-zinc-500">Collateral</dt>
                <dd className="text-right tabular-nums text-zinc-300">{fmtINRCompact(b.collateralAmount)}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-col gap-1 pt-1">
            <div className="flex justify-between font-mono text-[10px]">
              <span className="text-zinc-500">Margin Utilization</span>
              <span className="font-semibold text-zinc-300">{util.toFixed(1)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div className={`h-full transition-all duration-500 ${utilColor}`} style={{ width: `${Math.min(util, 100)}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Position-structure row ────────────────────────────────────────────────────

function GroupRow({ g, marginBase }: { g: PositionGroup; marginBase: number | null }) {
  const legsSummary = g.legs.map((l) => `${l.side === 'SELL' ? '-' : '+'}${l.strike}${l.type}`).join('  ');
  const pctOfBase = marginBase && marginBase > 0 ? (g.marginBlocked / marginBase) * 100 : null;
  return (
    <tr className="transition-colors hover:bg-zinc-800/50">
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className={`font-mono text-[9px] font-bold uppercase tracking-[0.1em] ${BROKER_ACCENT[g.broker]}`}>{BROKER_LABELS[g.broker]}</span>
          <span className="font-mono text-xs font-bold text-zinc-100">{g.underlying}</span>
        </div>
        <div className="font-mono text-[10px] text-zinc-500">{g.expiry ?? 'unknown expiry'}{g.dte !== null ? ` · ${g.dte}d` : ''}</div>
      </td>
      <td className="px-3 py-2">
        <Badge tone={g.riskType === 'defined' ? 'emerald' : 'red'}>{g.structure}</Badge>
        <span className="ml-1.5 font-mono text-[9px] text-zinc-500">{g.riskType === 'defined' ? 'DEFINED RISK' : 'UNDEFINED RISK'}</span>
      </td>
      <td className="px-3 py-2 font-mono text-[10px] text-zinc-400">{legsSummary}</td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-emerald-400">{fmtINRCompact(g.creditCollected)}</td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-zinc-300">{fmtINRCompact(g.assignmentExposure)}</td>
      <td className="px-3 py-2 text-right">
        <div className="font-mono text-xs font-bold tabular-nums text-amber-400">{fmtINRCompact(g.marginBlocked)}</div>
        <div className="font-mono text-[9px] text-zinc-500">
          {g.marginSource === 'live' ? 'live calc' : g.marginSource === 'live-cross-broker' ? 'live via Dhan SPAN' : 'estimate'}
          {pctOfBase !== null ? ` · ${pctOfBase.toFixed(1)}%` : ''}
        </div>
      </td>
    </tr>
  );
}

// ─── Opportunity card ──────────────────────────────────────────────────────────

/** Scopes both the allocation plan and the two index opportunity tables to
 * NIFTY, SENSEX, or both — shared state so the plan and the tables it draws
 * from never show a different underlying scope than what's selected. */
function UnderlyingFilterToggle({ value, onChange }: { value: UnderlyingType | 'ALL'; onChange: (v: UnderlyingType | 'ALL') => void }) {
  return (
    <div className="flex items-center gap-1">
      {(['ALL', ...SCAN_UNDERLYINGS] as const).map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${value === u ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          {u}
        </button>
      ))}
    </div>
  );
}

function riskBadge(riskType: RiskClass) {
  if (riskType === 'defined') return <Badge tone="emerald">DEFINED RISK</Badge>;
  if (riskType === 'assignment') return <Badge tone="sky">ASSIGNMENT RISK</Badge>;
  return <Badge tone="red">UNDEFINED RISK</Badge>;
}

function OpportunityTable({ rows, emptyLabel }: { rows: RankedCandidate[]; emptyLabel: string }) {
  if (!rows.length) return <EmptyRow>{emptyLabel}</EmptyRow>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-zinc-800">
            <th className="px-3 py-2 text-xs font-bold text-white">Setup</th>
            <th className="px-3 py-2 text-xs font-bold text-white text-center">Risk</th>
            <th className="px-3 py-2 text-xs font-bold text-white text-right">DTE</th>
            <th className="px-3 py-2 text-xs font-bold text-white text-right">Credit</th>
            <th className="px-3 py-2 text-xs font-bold text-white text-right">Margin</th>
            <th className="px-3 py-2 text-xs font-bold text-white text-right">PoP</th>
            <th className="px-3 py-2 text-xs font-bold text-white text-right">Ann. RoM</th>
            <th className="px-3 py-2 text-xs font-bold text-white text-right">Score</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800 font-mono text-xs">
          {rows.map((r) => (
            <tr key={r.key} className="transition-colors hover:bg-zinc-800/50">
              <td className="px-3 py-2">
                <div className="font-bold text-zinc-100">{r.label}</div>
                <div className="text-[10px] text-zinc-500 truncate max-w-[260px]">{r.detail}</div>
              </td>
              <td className="px-3 py-2 text-center">{riskBadge(r.riskType)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{r.dte}d</td>
              <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{fmtINRCompact(r.creditPerUnit)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-200">{fmtINRCompact(r.marginPerUnit)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPct(r.popPct)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-amber-400">{fmtPct(r.romAnnualizedPct)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-bold text-zinc-100">{r.score.toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

const RISK_PRESETS = [
  { key: 'conservative', label: 'Conservative', fraction: 0.55, undefinedCap: 0.25 },
  { key: 'balanced', label: 'Balanced', fraction: 0.75, undefinedCap: 0.5 },
  { key: 'aggressive', label: 'Aggressive', fraction: 0.9, undefinedCap: 0.7 },
] as const;

export default function MarginAllocator() {
  const [portfolio, setPortfolio] = useState<DashboardPortfolioResponse | null>(null);
  const [allocator, setAllocator] = useState<MarginAllocatorResponse | null>(null);
  // Both underlyings are scanned unconditionally — real diversification across
  // NIFTY and SENSEX matters more than which one happens to score marginally
  // higher today. `displayFilter` only narrows what the two opportunity tables
  // show; the allocation plan always draws from the combined pool.
  const [scans, setScans] = useState<Partial<Record<UnderlyingType, ScanResponse>>>({});
  const [displayFilter, setDisplayFilter] = useState<UnderlyingType | 'ALL'>('ALL');
  const [scanLoading, setScanLoading] = useState(false);
  const [cspRows, setCspRows] = useState<CspRow[]>([]);
  const [cspScannedAt, setCspScannedAt] = useState<string | null>(null);
  const [cspScanning, setCspScanning] = useState(false);
  const [riskPreset, setRiskPreset] = useState<(typeof RISK_PRESETS)[number]['key']>('balanced');
  const [marketTrend, setMarketTrend] = useState<MarketTrendResponse | null>(null);
  const [dataUpdate, setDataUpdate] = useState<{
    open: boolean;
    phase: 'running' | 'done' | 'error' | 'blocked';
    log: string[];
    before: MarketTrendResponse | null;
  } | null>(null);
  const router = useRouter();
  const handoffInFlight = useRef(false);
  const [handoffKey, setHandoffKey] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [feedTab, setFeedTab] = useState<'defined' | 'undefined' | 'csp'>('defined');

  // A poll tick is skipped while the previous one is still running. Without
  // this a slow route (tens of seconds cold) gets a fresh request stacked on it
  // every interval, filling the browser's 6-connection limit for the origin and
  // starving every other request on the page.
  const portfolioBusy = useRef(false);
  const allocatorBusy = useRef(false);

  const loadPortfolio = useCallback(async () => {
    if (portfolioBusy.current) return;
    portfolioBusy.current = true;
    try {
      const res = await fetch('/api/dashboard/portfolio');
      const json = await res.json();
      if (json?.success) setPortfolio(json);
    } catch { /* transient — next poll retries */ } finally { portfolioBusy.current = false; }
  }, []);

  const loadAllocator = useCallback(async () => {
    if (allocatorBusy.current) return;
    allocatorBusy.current = true;
    try {
      const res = await fetch('/api/margin-allocator');
      const json = await res.json();
      if (json?.success) setAllocator(json);
    } catch { /* transient — next poll retries */ } finally { allocatorBusy.current = false; }
  }, []);

  const loadCsp = useCallback(async () => {
    try {
      const res = await fetch('/api/csp-scan');
      const json = await res.json();
      if (json?.success) {
        setCspRows(json.rows ?? []);
        setCspScannedAt(json.scannedAt ?? null);
        setCspScanning(Boolean(json.running));
      }
    } catch { /* transient */ }
  }, []);

  const loadTrend = useCallback(async () => {
    try {
      const res = await fetch('/api/margin-allocator/trend');
      const json = await res.json();
      setMarketTrend(json ?? null);
    } catch { /* transient — next poll retries */ }
  }, []);

  /** Poll /api/refresh until the currently-running job finishes, appending
   * its log to the running modal state as it goes. */
  const pollRefreshUntilDone = useCallback((target: string): Promise<{ error: string | null; log: string[] }> => {
    return new Promise((resolve) => {
      const tick = async () => {
        try {
          const res = await fetch('/api/refresh');
          const json = await res.json();
          const log: string[] = json.status?.log ?? [];
          setDataUpdate((prev) => (prev ? { ...prev, log: [`▶ ${target}`, ...log] } : prev));
          if (!json.running && json.status?.done) {
            resolve({ error: json.status.error ?? null, log });
            return;
          }
        } catch { /* transient — keep polling */ }
        setTimeout(tick, 1500);
      };
      tick();
    });
  }, []);

  /**
   * "Update Data" button — refreshes the two CSVs this page's Market Read
   * panel actually reads (NIFTY_50_Daily_5Y.csv via target=nifty50, and
   * Historical Data/Indices/{SENSEX,INDIA_VIX}.csv via target=indices),
   * both source=dhan since Yahoo doesn't carry sector/BSE indices. Manual,
   * on-demand only — see conversation: no OS-level scheduler for this yet.
   */
  const runDataUpdate = useCallback(async () => {
    const statusRes = await fetch('/api/refresh');
    const statusJson = await statusRes.json();
    if (statusJson.running) {
      setDataUpdate({ open: true, phase: 'blocked', log: [], before: marketTrend });
      return;
    }

    setDataUpdate({ open: true, phase: 'running', log: [], before: marketTrend });
    let hadError = false;
    const combined: string[] = [];

    for (const target of ['nifty50', 'indices'] as const) {
      try {
        const startRes = await fetch('/api/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, source: 'dhan' }),
        });
        if (!startRes.ok) {
          hadError = true;
          combined.push(`✗ [${target}] could not start`);
          continue;
        }
        const { error, log } = await pollRefreshUntilDone(target);
        combined.push(`▶ ${target}`, ...log);
        if (error) hadError = true;
      } catch {
        hadError = true;
        combined.push(`✗ [${target}] request failed`);
      }
    }

    setDataUpdate((prev) => (prev ? { ...prev, log: combined } : prev));
    await loadTrend();
    setDataUpdate((prev) => (prev ? { ...prev, phase: hadError ? 'error' : 'done' } : prev));
  }, [marketTrend, loadTrend, pollRefreshUntilDone]);

  /**
   * The scan route defaults to the underlying's nearest expiry, which can be
   * 1-2 days out right after a weekly expiry rolls — exactly the expiry-day
   * gamma window this page must NOT recommend. Pick the nearest expiry that
   * actually falls in the "1 to 2 weeks" band ourselves; fall back to the
   * nearest expiry beyond MIN_DTE if the underlying's cycle skips the band
   * entirely (e.g. a monthly-only underlying between cycles).
   */
  const pickExpiry = useCallback(async (underlying: UnderlyingType): Promise<string | undefined> => {
    try {
      const res = await fetch(`/api/ultimate-scanner/expiries?underlying=${underlying}`);
      const json = await res.json();
      const expiries: string[] = Array.isArray(json?.expiries) ? json.expiries : [];
      const today = new Date();
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const withDte = expiries.map((e) => ({ e, dte: Math.round((new Date(e).getTime() - todayMidnight) / 86_400_000) }));
      const inWindow = withDte.find((x) => x.dte >= MIN_DTE_FOR_YIELD && x.dte <= MAX_DTE_FOR_YIELD);
      if (inWindow) return inWindow.e;
      const beyondMin = withDte.find((x) => x.dte >= MIN_DTE_FOR_YIELD);
      return beyondMin?.e ?? expiries[0];
    } catch {
      return undefined;
    }
  }, []);

  const runScanFor = useCallback(async (underlying: UnderlyingType): Promise<ScanResponse | null> => {
    try {
      const expiry = await pickExpiry(underlying);
      const res = await fetch('/api/ultimate-scanner/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying,
          expiry,
          minRom: 1.0,
          minDistancePct: 0.5,
          maxDistancePct: 6.0,
          riskProfile: 'all',
          // The full credit-generating template set from the Baskets page
          // (/baskets, lib/basketStrategies.ts) — debit/directional buys
          // (Buy Call, Long Straddle, ratio backspreads, calendars, …) are
          // deliberately excluded: this page deploys idle margin for yield,
          // not directional bets, and every one of these is a strategy a
          // real trader could place from the Baskets page today.
          strategyTypes: [
            'iron_condor', 'batman', 'iron_butterfly', 'short_strangle', 'short_straddle',
            'bull_put_spread', 'bear_call_spread', 'jade_lizard', 'reverse_jade_lizard',
          ] as StrategyType[],
          maxResults: 80,
          sortBy: 'score',
        }),
      });
      return await res.json();
    } catch {
      return null;
    }
  }, [pickExpiry]);

  const runAllScans = useCallback(async () => {
    setScanLoading(true);
    try {
      const results = await Promise.all(SCAN_UNDERLYINGS.map((u) => runScanFor(u)));
      setScans(Object.fromEntries(SCAN_UNDERLYINGS.map((u, i) => [u, results[i]])) as Partial<Record<UnderlyingType, ScanResponse>>);
    } finally {
      setScanLoading(false);
    }
  }, [runScanFor]);

  const runCspScan = useCallback(async () => {
    setCspScanning(true);
    try {
      await fetch('/api/csp-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universe: 'nifty50', expiryOffset: 0 }),
      });
    } catch { /* status poll picks it up */ }
  }, []);

  useEffect(() => { loadPortfolio(); const id = setInterval(loadPortfolio, PORTFOLIO_POLL_MS); return () => clearInterval(id); }, [loadPortfolio]);
  useEffect(() => { loadAllocator(); const id = setInterval(loadAllocator, ALLOCATOR_POLL_MS); return () => clearInterval(id); }, [loadAllocator]);
  useEffect(() => { loadCsp(); }, [loadCsp]);
  useEffect(() => { loadTrend(); }, [loadTrend]);
  useEffect(() => { runAllScans(); }, [runAllScans]);
  // Poll CSP status only while a scan is actually running (10-min sweep) — avoid hammering it otherwise.
  useEffect(() => {
    if (!cspScanning) return;
    const id = setInterval(loadCsp, 8_000);
    return () => clearInterval(id);
  }, [cspScanning, loadCsp]);

  const totals = portfolio?.totals ?? null;
  const dhanFunds = allocator?.funds ?? null;
  const preset = RISK_PRESETS.find((p) => p.key === riskPreset)!;
  // Panic-zone throttle on TOTAL capital committed, on top of (not instead
  // of) the preset's own fraction — see vixPercentileToDeployMultiplier.
  const deployMultiplier = marketTrend?.vixPercentile != null ? vixPercentileToDeployMultiplier(marketTrend.vixPercentile) : 1;
  const deployableBudget = dhanFunds ? Math.max(0, dhanFunds.availableBalance * preset.fraction * deployMultiplier) : 0;
  const trend: MarketTrend = marketTrend?.trend ?? 'neutral';
  // SENSEX gets its own EMA20+Supertrend read once Historical Data/Indices/
  // SENSEX.csv exists (download_indices.py --name SENSEX); falls back to
  // NIFTY's read otherwise — see trend/route.ts header comment.
  const sensexTrend: MarketTrend = marketTrend?.sensex?.trend ?? trend;
  const trendForUnderlying = useCallback(
    (underlying: string): MarketTrend => (underlying === 'SENSEX' ? sensexTrend : trend),
    [trend, sensexTrend],
  );

  const allScanCandidates = useMemo(
    () => Object.values(scans).flatMap((s) => s?.candidates ?? []),
    [scans],
  );
  const scanVixInfo = useMemo(() => Object.values(scans).find((s) => s?.vix)?.vix ?? null, [scans]);
  // Live VIX chip: prefers the WS-hub poll over the mount-only scan result.
  // `.advice` has no hub equivalent, so it's always carried over from the
  // scan (or omitted) regardless of which source supplies `.vix`/`.regime`.
  const { data: vixHub } = useLiveTickerPoll<VixHubResponse>('/api/scalper/top-indices', pickVixHubLtp);
  const liveVixLtp = vixHub?.quotes?.VIX?.ltp;
  const vixInfo = (typeof liveVixLtp === 'number' && liveVixLtp > 0)
    ? { vix: liveVixLtp, regime: vixRegimeForLevel(liveVixLtp), advice: scanVixInfo?.advice }
    : scanVixInfo;

  // High VIX means richer absolute premium per unit of margin, so the
  // undefined-risk (naked strangle/straddle/lizard) sub-budget is allowed to
  // use its FULL share of the risk preset's own naked cap; low VIX pulls it
  // down toward defined-risk spreads instead, since thin premium isn't worth
  // undefined risk. This only ever narrows the preset's naked allowance, never
  // widens past it — the risk preset (Conservative/Balanced/Aggressive)
  // remains the hard ceiling the user chose.
  //
  // Driven by VIX PERCENTILE (trailing 252 sessions from the local India VIX
  // history) via vixPercentileToNakedTilt above, not the scan API's
  // absolute-level regime bucket — 11 VIX means something very different
  // after a year mostly above 20 than after a year mostly below 12, and a
  // fixed threshold can't tell those apart. Percentile is preferred over
  // rank here because a single old spike doesn't keep depressing it for the
  // rest of the lookback window the way rank would. Falls back to the
  // absolute-level regime only when the local VIX history hasn't loaded yet
  // — kept intentionally conservative (a 0.3 floor, not 0.5) to echo the same
  // "avoid thin premium" spirit as the percentile curve's own low end.
  const VIX_REGIME_FALLBACK_TILT: Record<string, number> = {
    'Low Volatility': 0.3,
    'Normal / Ideal Volatility': 0.85,
    'Elevated Volatility': 1.0,
    'High Volatility / Panic': 1.0,
  };
  const vixTilt = marketTrend?.vixPercentile != null
    ? vixPercentileToNakedTilt(marketTrend.vixPercentile)
    : vixInfo ? (VIX_REGIME_FALLBACK_TILT[vixInfo.regime] ?? 0.85) : 0.85;

  // A leg with no live price (ltp 0 = no quote / no liquidity) makes the
  // credit, breakevens and stress P&L meaningless, and can't be filled anyway.
  const pricedCandidates = useMemo(
    () => allScanCandidates.filter((c) => c.legs.length > 0 && c.legs.every((l) => l.ltp > 0)),
    [allScanCandidates],
  );
  const droppedUnpriced = allScanCandidates.length - pricedCandidates.length;

  const definedRiskCandidatesAll = useMemo(
    () => pricedCandidates
      .filter((c) => !c.maxLossUnlimited && c.dte >= MIN_DTE_FOR_YIELD && c.dte <= MAX_DTE_FOR_YIELD)
      .map((c) => fromScannedStrategy(c, trendForUnderlying(c.underlying))),
    [pricedCandidates, trendForUnderlying],
  );
  const undefinedRiskCandidatesAll = useMemo(
    () => pricedCandidates
      .filter((c) => c.maxLossUnlimited && c.dte >= MIN_DTE_FOR_YIELD && c.dte <= MAX_DTE_FOR_YIELD)
      .map((c) => fromScannedStrategy(c, trendForUnderlying(c.underlying))),
    [pricedCandidates, trendForUnderlying],
  );
  const cspCandidatesAll = useMemo(
    // csp_scanner.py already floors at MIN_DTE=5 server-side; the upper bound still applies here.
    () => cspRows.filter((r) => r.dte <= MAX_DTE_FOR_YIELD).map(fromCspRow),
    [cspRows],
  );

  const matchesFilter = useCallback((c: RankedCandidate) => displayFilter === 'ALL' || c.underlying === displayFilter, [displayFilter]);
  const definedRiskCandidates = useMemo(() => definedRiskCandidatesAll.filter(matchesFilter), [definedRiskCandidatesAll, matchesFilter]);
  const undefinedRiskCandidates = useMemo(() => undefinedRiskCandidatesAll.filter(matchesFilter), [undefinedRiskCandidatesAll, matchesFilter]);

  // Deployable budget splits into three risk-category sub-budgets BEFORE
  // allocation — this is what actually enforces "don't put it all in one
  // trade class," not a cap applied after the fact inside one merged pool.
  const effectiveUndefinedCap = preset.undefinedCap * vixTilt;
  const strangleBudget = deployableBudget * effectiveUndefinedCap;
  const remainingBudget = Math.max(0, deployableBudget - strangleBudget);
  const condorBudget = remainingBudget * 0.6;
  const cspBudget = remainingBudget * 0.4;

  // The plan draws from the SAME filtered pool as the two tables below it —
  // picking "NIFTY" here means the plan only ever proposes NIFTY setups, not
  // just that the tables happen to display NIFTY rows. The per-underlying
  // concentration cap only makes sense in "ALL" mode — with a single
  // underlying selected there is nothing left to diversify across, and
  // capping it anyway would just strand budget undeployed for no reason.
  const perUnderlyingCap = displayFilter === 'ALL' ? 0.6 : 1;
  const condorPlan = useMemo(() => buildAllocationPlan(definedRiskCandidates, condorBudget, perUnderlyingCap), [definedRiskCandidates, condorBudget, perUnderlyingCap]);
  const stranglePlan = useMemo(() => buildAllocationPlan(undefinedRiskCandidates, strangleBudget, perUnderlyingCap), [undefinedRiskCandidates, strangleBudget, perUnderlyingCap]);
  const cspPlan = useMemo(() => buildAllocationPlan(cspCandidatesAll, cspBudget), [cspCandidatesAll, cspBudget]);

  const allocationPlan = useMemo(
    () => [...condorPlan.plan, ...stranglePlan.plan, ...cspPlan.plan].sort((a, b) => b.marginUsed - a.marginUsed),
    [condorPlan, stranglePlan, cspPlan],
  );
  const allocationUsed = condorPlan.used + stranglePlan.used + cspPlan.used;
  const usedUndefined = stranglePlan.used;

  const totalCreditExpected = allocationPlan.reduce((a, p) => a + p.creditExpected, 0);
  const utilizationOfDeployable = deployableBudget > 0 ? (allocationUsed / deployableBudget) * 100 : 0;

  // Portfolio-level delta exposure — margin alone doesn't show this: a
  // NIFTY Bull Put Spread and a SENSEX Bull Put Spread can each fit under
  // the correlation-group margin cap yet still stack the SAME directional
  // delta bet across two ~99%-correlated indices, which margin accounting
  // can't see. Deliberately informational only (no hard cap wired into
  // buildAllocationPlan yet) — CSP legs are excluded since csp_scanner.py
  // doesn't compute a delta, not because they carry none.
  const cspInPlan = allocationPlan.some((p) => p.riskType === 'assignment');
  const netDeltaExposure = allocationPlan.reduce((a, p) => a + (p.deltaNet ?? 0) * p.units, 0);

  // Tail-hedge reserve — informational nudge, not an executed order (this
  // page recommends, it never places trades). Sized off naked-risk margin
  // specifically, since that's the book with theoretically unbounded loss on
  // a gap move; a cheap far-OTM index put is the standard convex hedge for
  // exactly this (see Volmageddon post-mortems: a cheap hedge should blunt
  // catastrophic-failure risk, not chase raw tail correlation).
  const tailHedgeReserve = usedUndefined * 0.05;

  /**
   * Saves one plan row as a DRAFT basket in Multi-Leg Focus and opens it. No
   * order is placed here — the terminal is where the trader reviews live
   * margin and confirms. Lots are the scan's lots × the plan's units, so the
   * basket matches the size the plan budgeted margin for.
   */
  const sendToMultiLegFocus = async (p: AllocatedCandidate) => {
    if (!p.legs || handoffInFlight.current) return;
    handoffInFlight.current = true;
    setHandoffKey(p.key);
    setHandoffError(null);
    try {
      const basket: Partial<MultiLegBasket> = {
        name: `${p.strategyName ?? p.label} ×${p.units}`,
        underlying: p.underlying,
        expiry: p.expiry,
        broker: 'dhan',
        presetKey: p.strategyType.replace(/_/g, '-'),
        legs: p.legs.map((leg, i) => ({
          id: String(i + 1),
          side: leg.side === 'SELL' ? 'S' : 'B',
          option: leg.option,
          strike: leg.strike,
          lots: (leg.lots || 1) * p.units,
          type: 'MARKET',
          status: 'DRAFT',
        })),
      };
      // Reuse an untouched draft of the exact same structure and size instead of
      // stacking a duplicate every time the button is pressed.
      const sig = (b: { underlying?: string; expiry?: string; legs?: { side: string; option: string; strike: number; lots: number }[] }) =>
        `${b.underlying}|${b.expiry}|${(b.legs ?? []).map((l) => `${l.side}${l.option}${l.strike}x${l.lots}`).sort().join(',')}`;
      try {
        const existing = await fetch('/api/multi-leg-focus/baskets').then((r) => r.json());
        const match = (existing?.data as MultiLegBasket[] | undefined)?.find(
          (b) => b.broker === 'dhan' && b.legs.length > 0 && b.legs.every((l) => l.status === 'DRAFT') && sig(b) === sig(basket as never),
        );
        if (match) basket.id = match.id;
      } catch { /* fall through: worst case is one extra draft */ }
      const res = await fetch('/api/multi-leg-focus/baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basket),
      });
      if (!res.ok) throw new Error(`the basket service returned ${res.status}`);
      router.push('/multi-leg-focus');
    } catch (err) {
      setHandoffError(`Could not save ${p.label} as a draft basket: ${err instanceof Error ? err.message : String(err)}. Nothing was ordered.`);
      handoffInFlight.current = false;
      setHandoffKey(null);
    }
  };

  // ── Gap stress test ────────────────────────────────────────────────────
  // Spot per underlying comes from the scan itself, so the shock is applied
  // to the same reference price the candidates were priced against.
  const stress = useMemo(() => {
    const spotBy: Record<string, number> = {};
    const spotSource: Record<string, 'live scan' | 'last close'> = {};
    // Last EOD close as the fallback, so the open book can still be stressed
    // when the scan is slow, failed, or the market is shut and it returns nothing.
    if (marketTrend?.lastClose) { spotBy.NIFTY = marketTrend.lastClose; spotSource.NIFTY = 'last close'; }
    const sx = marketTrend?.sensex?.lastClose;
    if (sx) { spotBy.SENSEX = sx; spotSource.SENSEX = 'last close'; }
    for (const c of allScanCandidates) if (c.spot > 0) { spotBy[c.underlying] = c.spot; spotSource[c.underlying] = 'live scan'; }

    const planByUnd: Record<string, StressLeg[]> = {};
    let planCovered = 0;
    for (const p of allocationPlan) {
      if (!p.legs || !spotBy[p.underlying]) continue;
      planCovered += 1;
      (planByUnd[p.underlying] ??= []).push(...p.legs.map((l): StressLeg => ({
        strike: l.strike, option: l.option, side: l.side, price: l.ltp, qty: (l.lots || 1) * l.lotSize * p.units,
      })));
    }
    const bookByUnd: Record<string, StressLeg[]> = {};
    let bookSkipped = 0;
    let bookCovered = 0;
    for (const g of allocator?.groups ?? []) {
      if (!spotBy[g.underlying]) { bookSkipped += 1; continue; }
      bookCovered += 1;
      (bookByUnd[g.underlying] ??= []).push(...g.legs.map((l): StressLeg => ({
        strike: l.strike, option: l.type, side: l.side, price: l.avgPrice, qty: Math.abs(l.qty),
      })));
    }
    const sum = (byUnd: Record<string, StressLeg[]>, move: number) =>
      Object.entries(byUnd).reduce((a, [u, legs]) => a + bookExpiryPnl(legs, spotBy[u] * (1 + move / 100)), 0);

    const rows = STRESS_MOVES_PCT.map((move) => {
      const plan = sum(planByUnd, move);
      const book = sum(bookByUnd, move);
      return { move, plan, book, total: plan + book };
    });
    return { rows, planCovered, bookCovered, bookSkipped, spots: spotBy, spotSource };
  }, [allScanCandidates, allocationPlan, allocator, marketTrend]);
  // The open-positions column covers Dhan AND Kotak, so its % is taken against
  // the consolidated margin, not Dhan's alone (which would overstate the hit).
  const stressBase = {
    total: totals?.totalBalance ?? dhanFunds?.totalBalance ?? 0,
    available: totals?.availableBalance ?? dhanFunds?.availableBalance ?? 0,
  };
  const stressWorst = stress.rows.reduce((w, r) => (r.total < w.total ? r : w), stress.rows[0]);
  const stressMaxAbs = Math.max(1, ...stress.rows.map((r) => Math.abs(r.total)));
  const cspInPlanForStress = allocationPlan.some((p) => p.riskType === 'assignment');

  // Currency of the market read that drives the plan (last EOD bar), not the
  // wall-clock date — toISOString() was also a UTC date, wrong before 05:30 IST.
  const dataDate = marketTrend?.asOf ?? '—';
  const scanFailed = !scanLoading && SCAN_UNDERLYINGS.some((u) => scans[u] === null || scans[u]?.success === false);
  const scanFailedNames = SCAN_UNDERLYINGS.filter((u) => scans[u] === null || scans[u]?.success === false);

  // Capital map — Dhan only, because the plan is sized from Dhan idle margin.
  const capitalSegments: CapitalSegment[] = dhanFunds ? (() => {
    const idle = dhanFunds.availableBalance;
    const presetShare = idle * preset.fraction;
    const throttled = Math.max(0, presetShare - deployableBudget);
    const buffer = Math.max(0, idle - presetShare);
    return [
      { key: 'blocked', label: 'Blocked in positions', value: dhanFunds.utilizedMargin, bar: 'bg-zinc-500', dot: 'bg-zinc-500', hint: 'Margin held by live Dhan positions' },
      { key: 'plan', label: 'Proposed by plan', value: allocationUsed, bar: 'bg-emerald-500', dot: 'bg-emerald-500', hint: `${allocationPlan.length} setup${allocationPlan.length === 1 ? '' : 's'} sized to the budget` },
      { key: 'free', label: 'Deployable, unallocated', value: Math.max(0, deployableBudget - allocationUsed), bar: 'bg-emerald-500/30', dot: 'bg-emerald-500/40', hint: 'Budget the caps left unspent' },
      { key: 'throttle', label: 'Held by VIX throttle', value: throttled, bar: 'bg-red-500/50', dot: 'bg-red-500/60', hint: 'Cut because VIX is above its 85th percentile' },
      { key: 'buffer', label: 'Safety buffer', value: buffer, bar: 'bg-amber-500/40', dot: 'bg-amber-500/50', hint: `${(100 - preset.fraction * 100).toFixed(0)}% of idle margin, never deployed` },
    ];
  })() : [];
  const capitalTotal = capitalSegments.reduce((a, s) => a + s.value, 0);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ─── Sticky Bloomberg header ───────────────────────────────────────── */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/20 bg-zinc-950/95 px-6 py-3 backdrop-blur shadow-md">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 shadow-inner">
            <PieChart className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">CAPITAL DEPLOYMENT DESK</span>
              <span className="text-[10px] text-zinc-600">/</span>
              <span className="font-mono text-[10px] text-zinc-400">MULTI-BROKER MARGIN</span>
            </div>
            <h1 className="text-base font-bold leading-none tracking-tight text-white">Margin Allocator</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-semibold text-zinc-400">
            DATA: {dataDate}
          </span>
          <IstClock />
          <button
            type="button"
            onClick={() => { loadPortfolio(); loadAllocator(); loadTrend(); runAllScans(); loadCsp(); }}
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-bold text-zinc-300 hover:border-zinc-700"
          >
            <RefreshCw className={`h-3 w-3 ${scanLoading ? 'animate-spin text-amber-400' : ''}`} />
            REFRESH
          </button>
          <button
            type="button"
            onClick={runDataUpdate}
            disabled={dataUpdate?.phase === 'running'}
            title="Pull fresh NIFTY/SENSEX/VIX EOD candles from Dhan into the CSVs this panel reads"
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] font-bold disabled:opacity-60 ${
              dataUpdate?.phase === 'running'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700'
            }`}
          >
            <Database className={`h-3 w-3 ${dataUpdate?.phase === 'running' ? 'animate-pulse text-amber-400' : ''}`} />
            UPDATE DATA
          </button>
          <div className="flex items-center pl-1 border-l border-zinc-800">
            <NavBar />
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-6 py-5">
        {scanFailed && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              The {scanFailedNames.join(' and ')} scan failed, so the plan below is built from the remaining data only.
              Check that your Dhan session is active, then press Refresh.
            </span>
          </div>
        )}
        {/* ─── 0. Capital map ─────────────────────────────────────────────── */}
        <TerminalPanel
          title="Where your Dhan capital sits"
          icon={PieChart}
          meta={dhanFunds ? `Margin base ${fmtINRCompact(capitalTotal)}` : undefined}
        >
          {dhanFunds && capitalTotal > 0
            ? <CapitalMap segments={capitalSegments} total={capitalTotal} />
            : <EmptyRow>Connect Dhan to see how your margin is split between positions, the plan and the safety buffer.</EmptyRow>}
        </TerminalPanel>
        {/* ─── 1. Consolidated broker margin ─────────────────────────────── */}
        <TerminalPanel title="Consolidated Broker Margin" icon={Wallet} href="/portfolio" meta={portfolio ? `Updated ${new Date(portfolio.updatedAt).toLocaleTimeString('en-IN', { hour12: false })} IST` : undefined}>
          <div className="flex flex-col gap-3 p-3.5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Total Available" value={fmtINRCompact(totals?.availableBalance ?? null)} tone="up" />
              <StatTile label="Total Utilized" value={fmtINRCompact(totals?.utilizedMargin ?? null)} tone="neutral" />
              <StatTile label="Margin Base" value={fmtINRCompact(totals?.totalBalance ?? null)} tone="accent" />
              <StatTile
                label="Blocked by Structures"
                value={fmtINRCompact(allocator?.groups.reduce((a, g) => a + g.marginBlocked, 0) ?? null)}
                tone="neutral"
                sub={`${allocator?.groups.length ?? 0} live structure${allocator?.groups.length === 1 ? '' : 's'} · Dhan + Kotak`}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {BROKER_ORDER.map((broker) => {
                const b = portfolio?.brokers.find((x) => x.broker === broker);
                return b ? <BrokerMarginCard key={broker} b={b} /> : null;
              })}
            </div>
          </div>
        </TerminalPanel>

        {/* ─── 2. Margin blocked by structure ─────────────────────────────── */}
        <TerminalPanel
          title="Margin Blocked by Position Structure"
          icon={Layers}
          meta={
            <div className="flex items-center gap-2">
              {allocator?.brokers.map((b) => (
                <Badge key={b.broker} tone={b.connected ? 'emerald' : 'zinc'}>
                  {BROKER_LABELS[b.broker]}{b.connected ? '' : ' OFFLINE'}
                </Badge>
              ))}
            </div>
          }
        >
          {!allocator?.connected ? (
            <EmptyRow>No Dhan or Kotak session active — authenticate a broker to see live position structures.</EmptyRow>
          ) : !allocator.groups.length ? (
            <EmptyRow>No open Dhan/Kotak option positions right now — full margin base is idle.</EmptyRow>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-zinc-800">
                    <th className="px-3 py-2 text-xs font-bold text-white">Broker / Underlying / Expiry</th>
                    <th className="px-3 py-2 text-xs font-bold text-white">Structure</th>
                    <th className="px-3 py-2 text-xs font-bold text-white">Legs</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Credit Collected</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Assignment Exposure</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Margin Blocked</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 font-mono text-xs">
                  {allocator.groups.map((g, i) => (
                    <GroupRow
                      key={`${g.broker}-${g.underlying}-${g.expiry}-${i}`}
                      g={g}
                      marginBase={allocator.brokers.find((b) => b.broker === g.broker)?.funds?.totalBalance ?? null}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-zinc-700 bg-zinc-950 font-bold">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-300" colSpan={3}>Total Blocked</td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-emerald-400">
                      {fmtINRCompact(allocator.groups.reduce((a, g) => a + g.creditCollected, 0))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-zinc-300">
                      {fmtINRCompact(allocator.groups.reduce((a, g) => a + g.assignmentExposure, 0))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-amber-400">
                      {fmtINRCompact(allocator.groups.reduce((a, g) => a + g.marginBlocked, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {allocator?.unparseable.length ? (
            <div className="flex items-start gap-2 border-t border-zinc-800 px-3.5 py-2.5 font-mono text-[10px] text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {allocator.unparseable.length} position{allocator.unparseable.length === 1 ? '' : 's'} could not be classified
                (equity/futures or unrecognised symbol shape) — excluded from the table above, not from margin utilized:{' '}
                {allocator.unparseable.map((u) => `${BROKER_LABELS[u.broker]} ${u.tradingSymbol}`).join(', ')}
              </span>
            </div>
          ) : null}
        </TerminalPanel>

        {/* ─── 3. Deployable capital + risk dial ──────────────────────────── */}
        <TerminalPanel title="Deployable Idle Capital" icon={Gauge}>
          <div className="flex flex-col gap-3 p-3.5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatTile label="Dhan Idle Margin" value={fmtINRCompact(dhanFunds?.availableBalance ?? null)} tone="up" />
              <StatTile
                label="Deployable Budget"
                value={fmtINRCompact(deployableBudget)}
                tone="accent"
                sub={deployMultiplier < 1
                  ? `${(preset.fraction * 100).toFixed(0)}% × ${(deployMultiplier * 100).toFixed(0)}% panic throttle · ${preset.label}`
                  : `${(preset.fraction * 100).toFixed(0)}% of idle margin · ${preset.label}`}
              />
              <StatTile
                label="Recommended Plan Uses"
                value={fmtINRCompact(allocationUsed)}
                progress={{ percent: utilizationOfDeployable, colorClass: 'bg-emerald-500' }}
                tone="neutral"
              />
              <StatTile label="Expected Credit (Plan)" value={fmtINRCompact(totalCreditExpected)} tone="up" sub={`${allocationPlan.length} setup${allocationPlan.length === 1 ? '' : 's'}`} />
              <StatTile
                label="Tail Hedge Reserve"
                value={fmtINRCompact(tailHedgeReserve)}
                tone="neutral"
                sub="suggested, not auto-placed — 5% of naked margin"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Allocation Posture</span>
              {RISK_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setRiskPreset(p.key)}
                  className={`rounded px-2.5 py-1 font-mono text-[10px] font-bold transition-colors ${
                    riskPreset === p.key
                      ? 'border border-amber-500/40 bg-amber-500/15 text-amber-300'
                      : 'border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
                  }`}
                >
                  {p.label.toUpperCase()} ({(p.fraction * 100).toFixed(0)}% deploy / {(p.undefinedCap * 100).toFixed(0)}% naked cap)
                </button>
              ))}
            </div>
            <Notes summary="How the budget is sized">
              <p>
                {(100 - preset.fraction * 100).toFixed(0)}% of idle margin is never deployed. Naked (undefined-risk) exposure is
                capped at {(preset.undefinedCap * 100).toFixed(0)}% of the deployable budget, however good one setup scores.
                The VIX read tunes usage inside that ceiling, never past it.
              </p>
              {deployMultiplier < 1 && (
                <p>
                  VIX is above its 85th percentile, so total deployable capital is cut to {(deployMultiplier * 100).toFixed(0)}%.
                  Opening fresh short-vol positions while volatility is still repricing is how blowups like Feb 2018 happen.
                </p>
              )}
              <p>
                The tail hedge reserve is 5% of naked margin used. It is a suggestion, not an order: consider a cheap far-OTM
                NIFTY or SENSEX put from Baskets sized to that amount.
              </p>
            </Notes>
          </div>
        </TerminalPanel>

        {/* ─── 3b. Market read driving the plan below ─────────────────────── */}
        <TerminalPanel title="Market Read: VIX Regime &amp; Trend" icon={Activity}>
          <div className="grid gap-3 p-3.5 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">India VIX</span>
                {vixInfo ? <Badge tone="amber">{vixInfo.regime}</Badge> : <Badge tone="zinc">LOADING</Badge>}
              </div>
              <div className="flex items-baseline gap-2 mt-2">
                <span className="font-mono text-lg font-bold leading-none tabular-nums text-amber-400">
                  {vixInfo ? vixInfo.vix.toFixed(2) : '—'}
                </span>
                {marketTrend?.vixPercentile != null && (
                  <span className="font-mono text-[10px] text-zinc-500">
                    {marketTrend.vixPercentile.toFixed(0)}th percentile · {marketTrend.vixRank?.toFixed(0)}% rank (trailing 1Y)
                  </span>
                )}
                {marketTrend?.vixPercentile != null && marketTrend.vixPercentile < 30 && <Badge tone="red">AVOID ZONE</Badge>}
              </div>
              <p className="font-mono text-[10px] text-zinc-500 mt-2">{vixInfo?.advice ?? 'Waiting on the NIFTY/SENSEX scan…'}</p>
              <p className="font-mono text-[10px] text-zinc-400 mt-1.5 border-t border-zinc-800 pt-1.5">
                Naked-risk budget dialed to <span className="text-amber-400 font-bold">{(effectiveUndefinedCap * 100).toFixed(0)}%</span> of
                deployable (of a {(preset.undefinedCap * 100).toFixed(0)}% preset ceiling), driven by{' '}
                {marketTrend?.vixPercentile != null ? "today's VIX percentile vs its own trailing year" : "today's absolute VIX regime (percentile still loading)"} — {vixTilt >= 0.9
                  ? 'richer premium relative to its own range earns close to the full naked allowance.'
                  : vixTilt <= 0.35
                    ? 'below the 30th percentile, volatility is cheap relative to its own range and naked selling is throttled hard, not just discounted — thin premium doesn’t compensate for undefined-risk tail exposure.'
                    : 'a moderate read partway up its own trailing range, so the naked allowance sits proportionally between the half-size floor and the full ceiling.'}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">NIFTY Trend (EMA20 + Supertrend)</span>
                <Badge tone={trend === 'bullish' ? 'emerald' : trend === 'bearish' ? 'red' : 'zinc'}>{trend.toUpperCase()}</Badge>
              </div>
              <div className="font-mono text-lg font-bold leading-none tabular-nums text-zinc-100 mt-2">
                {marketTrend?.lastClose ? marketTrend.lastClose.toLocaleString('en-IN') : '—'}
                {marketTrend?.ema20 ? <span className="text-zinc-500 text-xs font-normal"> vs EMA20 {marketTrend.ema20.toLocaleString('en-IN')}</span> : null}
              </div>
              <p className="font-mono text-[10px] text-zinc-500 mt-2">
                {marketTrend?.asOf ? `As of ${marketTrend.asOf} EOD.` : 'Loading NIFTY daily history…'}{' '}
                {trend === 'neutral'
                  ? 'EMA20 and Supertrend disagree right now, so no directional tilt is applied.'
                  : `Both EMA20 and Supertrend agree ${trend}.`}
              </p>
              <p className="font-mono text-[10px] text-zinc-400 mt-1.5 border-t border-zinc-800 pt-1.5">
                {trend === 'neutral'
                  ? 'NIFTY Bull Put, Bear Call, Jade Lizard and Reverse Jade Lizard score unchanged — Iron Condor/Butterfly/Strangle/Straddle are never affected, they’re direction-neutral by construction.'
                  : `NIFTY ${trend === 'bullish' ? 'Bull Put Spread and Jade Lizard' : 'Bear Call Spread and Reverse Jade Lizard'} setups are scored up (trend-aligned); the opposite-direction setups are scored down, never hidden.`}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">SENSEX Trend (EMA20 + Supertrend)</span>
                <Badge tone={sensexTrend === 'bullish' ? 'emerald' : sensexTrend === 'bearish' ? 'red' : 'zinc'}>{sensexTrend.toUpperCase()}</Badge>
              </div>
              <div className="font-mono text-lg font-bold leading-none tabular-nums text-zinc-100 mt-2">
                {marketTrend?.sensex ? marketTrend.sensex.lastClose.toLocaleString('en-IN') : marketTrend?.lastClose ? marketTrend.lastClose.toLocaleString('en-IN') : '—'}
                {marketTrend?.sensex
                  ? <span className="text-zinc-500 text-xs font-normal"> vs EMA20 {marketTrend.sensex.ema20.toLocaleString('en-IN')}</span>
                  : marketTrend?.ema20 ? <span className="text-zinc-500 text-xs font-normal"> vs EMA20 {marketTrend.ema20.toLocaleString('en-IN')} (NIFTY, borrowed)</span> : null}
              </div>
              <p className="font-mono text-[10px] text-zinc-500 mt-2">
                {marketTrend?.sensex
                  ? `As of ${marketTrend.sensex.asOf} EOD — SENSEX's own read.`
                  : `No local SENSEX daily history yet (run download_indices.py --name SENSEX) — borrowing NIFTY's ${trend} read; NSE/BSE benchmarks move together on all but the rarest sessions.`}
              </p>
              <p className="font-mono text-[10px] text-zinc-400 mt-1.5 border-t border-zinc-800 pt-1.5">
                {sensexTrend === 'neutral'
                  ? 'SENSEX Bull Put, Bear Call, Jade Lizard and Reverse Jade Lizard score unchanged.'
                  : `SENSEX ${sensexTrend === 'bullish' ? 'Bull Put Spread and Jade Lizard' : 'Bear Call Spread and Reverse Jade Lizard'} setups are scored up (trend-aligned); the opposite-direction setups are scored down, never hidden.`}
              </p>
            </div>
          </div>
        </TerminalPanel>

        {/* ─── 4. Recommended allocation plan ──────────────────────────────── */}
        <TerminalPanel
          title="Recommended Allocation Plan"
          icon={Target}
          badge={<Badge tone="amber">{riskPreset.toUpperCase()}</Badge>}
          meta={<UnderlyingFilterToggle value={displayFilter} onChange={setDisplayFilter} />}
        >
          {!dhanFunds || deployableBudget <= 0 ? (
            <EmptyRow>No deployable Dhan margin right now.</EmptyRow>
          ) : !allocationPlan.length ? (
            <EmptyRow>No qualifying setup within {MAX_DTE_FOR_YIELD} days met the margin/risk budget — widen the scan or raise the risk posture.</EmptyRow>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-zinc-800">
                    <th className="px-3 py-2 text-xs font-bold text-white">Setup</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-center">Risk</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Units</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">DTE</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Margin Used</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Credit Expected</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Max Loss</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Breakeven</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">PoP</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Ann. RoM</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Trade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 font-mono text-xs">
                  {allocationPlan.map((p) => (
                    <tr key={p.key} className="transition-colors hover:bg-zinc-800/50">
                      <td className="px-3 py-2">
                        <div className="font-bold text-zinc-100">{p.label}</div>
                        <div className="text-[10px] text-zinc-500 truncate max-w-[280px]">{p.detail}</div>
                      </td>
                      <td className="px-3 py-2 text-center">{riskBadge(p.riskType)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-zinc-100">×{p.units}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{p.dte}d</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-400">
                        {fmtINRCompact(p.marginUsed)}
                        <div className="ml-auto mt-1 h-1 w-16 overflow-hidden rounded-full bg-zinc-800">
                          <div className="h-full bg-amber-400" style={{ width: `${allocationUsed > 0 ? (p.marginUsed / allocationUsed) * 100 : 0}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{fmtINRCompact(p.creditExpected)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-400">
                        {p.maxLossTotal === null ? 'Unlimited' : fmtINRCompact(p.maxLossTotal)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtBreakevens(p.breakevens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPct(p.popPct)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-400">{fmtPct(p.romAnnualizedPct)}</td>
                      <td className="px-3 py-2 text-right">
                        {p.legs ? (
                          <button
                            type="button"
                            onClick={() => sendToMultiLegFocus(p)}
                            disabled={handoffKey !== null}
                            title="Saves a draft basket and opens Multi-Leg Focus. No order is placed."
                            aria-label={`Open ${p.label} times ${p.units} in Multi-Leg Focus as a draft`}
                            className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-sans text-[11px] font-bold text-amber-400 hover:bg-amber-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50"
                          >
                            <Send className="h-3 w-3" />
                            {handoffKey === p.key ? 'Saving…' : 'Open draft'}
                          </button>
                        ) : (
                          <span className="font-sans text-[11px] text-zinc-600" title="Single-stock puts are placed from the CSP screener">CSP screener</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-zinc-700 bg-zinc-950 font-bold">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-300" colSpan={4}>
                      Deployed {fmtINRCompact(allocationUsed)} of {fmtINRCompact(deployableBudget)} budget
                      ({utilizationOfDeployable.toFixed(0)}%) · Naked exposure {fmtINRCompact(usedUndefined)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-amber-400">{fmtINRCompact(allocationUsed)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-emerald-400">{fmtINRCompact(totalCreditExpected)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-red-400">
                      {allocationPlan.some((p) => p.maxLossTotal === null)
                        ? 'Unlimited'
                        : fmtINRCompact(allocationPlan.reduce((sum, p) => sum + (p.maxLossTotal ?? 0), 0))}
                    </td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {allocationPlan.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-3.5 py-2 font-mono text-[10px]">
              <span className="text-zinc-500">
                Net Portfolio Delta (Condor + Strangle legs{cspInPlan ? ', excl. CSP — not delta-modeled' : ''}):
              </span>
              <span className={`font-bold ${Math.abs(netDeltaExposure) < 0.15 ? 'text-zinc-300' : netDeltaExposure > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {netDeltaExposure > 0 ? '+' : ''}{netDeltaExposure.toFixed(2)} {Math.abs(netDeltaExposure) >= 0.15 && (
                  displayFilter === 'ALL'
                    ? `(${netDeltaExposure > 0 ? 'net bullish' : 'net bearish'} stack across NIFTY+SENSEX — check it's intentional, not two correlated bets read as diversified)`
                    : `(${netDeltaExposure > 0 ? 'net bullish' : 'net bearish'} stack on ${displayFilter} — check it's intentional)`
                )}
              </span>
            </div>
          )}
          <Notes summary="Risk notes and how to read this table">
            <p className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>No option-selling strategy is risk-free. PoP and annualised RoM are model estimates from live IV and OI, not guarantees.</span>
            </p>
            <p>Condors, butterflies and credit spreads have defined risk: loss is capped at the wing width. Strangles, straddles and lizards are undefined-risk: loss can grow without limit on a large move. CSP rows carry assignment risk, since you may have to buy the stock at the strike.</p>
            <p>Max loss totals the allocated units at each structure&apos;s worst case. For a CSP that is the stock going to zero, not a likely outcome. Breakeven is the underlying level where the position turns from profit to loss at expiry.</p>
            <p>Every structure here is also on the Baskets page. Net portfolio delta and the tail hedge reserve are gauges only; nothing is enforced or placed from this page.</p>
          </Notes>
        </TerminalPanel>

        {handoffError && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{handoffError}</span>
          </div>
        )}

        {/* ─── 4b. Gap stress test ──────────────────────────────────────────── */}
        <TerminalPanel
          title="Gap stress test"
          icon={Zap}
          meta={Object.entries(stress.spots).map(([u, v]) => `${u} ${Math.round(v).toLocaleString('en-IN')}${stress.spotSource[u] === 'last close' ? ' (last close)' : ''}`).join(' · ') || undefined}
        >
          {stress.planCovered === 0 && stress.bookCovered === 0 ? (
            <EmptyRow>{scanLoading ? 'Waiting for the option scan to price the plan…' : 'Nothing to stress yet. The test needs a plan or open NIFTY/SENSEX option positions.'}</EmptyRow>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-zinc-800">
                      <th className="px-3 py-2 text-xs font-bold text-white">Index gap</th>
                      <th className="px-3 py-2 text-xs font-bold text-white text-right">Open positions</th>
                      <th className="px-3 py-2 text-xs font-bold text-white text-right">Proposed plan</th>
                      <th className="px-3 py-2 text-xs font-bold text-white text-right">Combined</th>
                      <th className="px-3 py-2 text-xs font-bold text-white text-right">% of margin base</th>
                      <th className="w-40 px-3 py-2 text-xs font-bold text-white"><span className="sr-only">Combined P&amp;L bar</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800 font-mono text-xs">
                    {stress.rows.map((r) => {
                      const tone = (v: number) => (v < 0 ? 'text-red-400' : 'text-emerald-400');
                      const width = (Math.abs(r.total) / stressMaxAbs) * 50;
                      return (
                        <tr key={r.move} className={r === stressWorst && r.total < 0 ? 'bg-red-500/5' : 'hover:bg-zinc-800/50'}>
                          <td className="px-3 py-2 font-bold text-zinc-100">{r.move > 0 ? '+' : ''}{r.move}%</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${tone(r.book)}`}>{fmtINRCompact(r.book)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${tone(r.plan)}`}>{fmtINRCompact(r.plan)}</td>
                          <td className={`px-3 py-2 text-right font-bold tabular-nums ${tone(r.total)}`}>{fmtINRCompact(r.total)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                            {stressBase.total > 0 ? fmtPct((r.total / stressBase.total) * 100) : '—'}
                          </td>
                          <td className="px-3 py-2" aria-hidden="true">
                            <div className="relative h-2 w-full">
                              <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
                              <div
                                className={`absolute inset-y-0 rounded-sm ${r.total < 0 ? 'bg-red-500' : 'bg-emerald-500'}`}
                                style={r.total < 0 ? { right: '50%', width: `${width}%` } : { left: '50%', width: `${width}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-3.5 py-2.5 text-xs">
                <span className="text-zinc-400">
                  {stressWorst.total < 0 ? (
                    <>
                      Worst case here: <span className="font-mono font-bold text-red-400">{fmtINRCompact(stressWorst.total)}</span> on a{' '}
                      {stressWorst.move > 0 ? '+' : ''}{stressWorst.move}% gap
                      {stressBase.available > 0 && <> — {fmtPct((Math.abs(stressWorst.total) / stressBase.available) * 100, 0)} of idle margin</>}
                    </>
                  ) : (
                    <>No tested gap ends in a loss at expiry.</>
                  )}
                </span>
              </div>
              <Notes summary="What this test does and doesn&apos;t include">
                <p>Each row moves NIFTY and SENSEX together by the same percentage, then values every leg at its expiry payoff. Time value is ignored, so a real gap before expiry usually hurts short premium less than shown. Read it as a conservative bound.</p>
                <p>Open positions use their average entry price and net quantity. The plan uses the scan&apos;s live premiums at the planned size.</p>
                {stress.bookSkipped > 0 && <p>{stress.bookSkipped} open structure{stress.bookSkipped === 1 ? '' : 's'} on other underlyings {stress.bookSkipped === 1 ? 'is' : 'are'} not included.</p>}
                {cspInPlanForStress && <p>Cash-secured puts in the plan are not included because they are single-stock positions.</p>}
              </Notes>
            </>
          )}
        </TerminalPanel>

        {/* ─── 5. Opportunity feeds (one panel, three tabs) ───────────────── */}
        <TerminalPanel
          title="Candidate setups"
          icon={Shield}
          meta={
            <div className="flex items-center gap-2">
              {feedTab !== 'csp' && <UnderlyingFilterToggle value={displayFilter} onChange={setDisplayFilter} />}
              {feedTab === 'csp' && (
                <>
                  <span>{cspScannedAt ? `Last scan ${new Date(cspScannedAt).toLocaleString('en-IN', { hour12: false })}` : 'No scan yet'}</span>
                  <button
                    type="button"
                    onClick={runCspScan}
                    disabled={cspScanning}
                    className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-400 hover:bg-amber-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50"
                  >
                    {cspScanning ? 'Scanning…' : 'Run fresh scan'}
                  </button>
                </>
              )}
            </div>
          }
        >
          <div
            role="tablist"
            aria-label="Candidate setup type"
            className="flex gap-1 border-b border-zinc-800 px-3.5 pt-2"
            onKeyDown={(e) => {
              const order = ['defined', 'undefined', 'csp'] as const;
              const i = order.indexOf(feedTab);
              const next = e.key === 'ArrowRight' ? order[(i + 1) % 3] : e.key === 'ArrowLeft' ? order[(i + 2) % 3]
                : e.key === 'Home' ? order[0] : e.key === 'End' ? order[2] : null;
              if (!next) return;
              e.preventDefault();
              setFeedTab(next);
              document.getElementById(`feed-tab-${next}`)?.focus();
            }}
          >
            {([
              ['defined', 'Defined risk', definedRiskCandidates.length],
              ['undefined', 'Undefined risk', undefinedRiskCandidates.length],
              ['csp', 'Cash-secured puts', cspCandidatesAll.length],
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`feed-tab-${key}`}
                aria-controls="feed-tabpanel"
                tabIndex={feedTab === key ? 0 : -1}
                aria-selected={feedTab === key}
                onClick={() => setFeedTab(key)}
                className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 ${
                  feedTab === key ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {label} <span className="ml-1 font-mono text-[11px] text-zinc-500">{count}</span>
              </button>
            ))}
          </div>
          <div role="tabpanel" id="feed-tabpanel" aria-labelledby={`feed-tab-${feedTab}`}>
          {feedTab === 'defined' && (
            <OpportunityTable
              rows={definedRiskCandidates.slice(0, 12)}
              emptyLabel={scanLoading ? 'Scanning the option chain…' : `No spread, condor or butterfly within ${MIN_DTE_FOR_YIELD}-${MAX_DTE_FOR_YIELD} days met the filters.`}
            />
          )}
          {feedTab === 'undefined' && (
            <OpportunityTable
              rows={undefinedRiskCandidates.slice(0, 12)}
              emptyLabel={scanLoading ? 'Scanning the option chain…' : `No strangle, straddle or lizard within ${MIN_DTE_FOR_YIELD}-${MAX_DTE_FOR_YIELD} days met the filters.`}
            />
          )}
          {feedTab === 'csp' && (
            <OpportunityTable
              rows={cspCandidatesAll.slice(0, 12)}
              emptyLabel={cspScanning ? 'Scan running, this takes about 10 minutes…' : `No cached put candidate within ${MAX_DTE_FOR_YIELD} days. Run a fresh scan.`}
            />
          )}
          </div>
          {droppedUnpriced > 0 && feedTab !== 'csp' && (
            <p className="border-t border-zinc-800 px-3.5 py-2 text-xs text-zinc-500">
              {droppedUnpriced} setup{droppedUnpriced === 1 ? ' was' : 's were'} hidden because a leg had no live price.
            </p>
          )}
        </TerminalPanel>
      </div>
      {dataUpdate?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-md">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-amber-400" />
                <span className="text-sm font-bold text-white">Update Data</span>
              </div>
              {dataUpdate.phase !== 'running' && (
                <button
                  type="button"
                  onClick={() => setDataUpdate(null)}
                  className="text-zinc-500 hover:text-white"
                  aria-label="Close"
                >
                  ×
                </button>
              )}
            </div>

            <div className="px-4 py-3 space-y-3">
              {dataUpdate.phase === 'blocked' && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>A data refresh is already running elsewhere (e.g. the navbar&apos;s Sync Market Data panel). Wait for it to finish, then try again.</span>
                </div>
              )}

              {dataUpdate.phase === 'running' && (
                <div className="flex items-center gap-2 text-xs text-sky-400">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Pulling NIFTY, SENSEX and India VIX EOD candles from Dhan…
                </div>
              )}

              {(dataUpdate.phase === 'done' || dataUpdate.phase === 'error') && (
                <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
                  dataUpdate.phase === 'done'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-red-500/30 bg-red-500/10 text-red-400'
                }`}>
                  {dataUpdate.phase === 'done' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                  <span>{dataUpdate.phase === 'done' ? 'Data refresh complete.' : 'Refresh finished with errors — see log below.'}</span>
                </div>
              )}

              {(dataUpdate.phase === 'done' || dataUpdate.phase === 'error') && (
                <div className="grid grid-cols-1 gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">NIFTY as of</span>
                    <span className="text-zinc-200">
                      {marketTrend?.asOf ?? '—'}
                      {dataUpdate.before?.asOf && dataUpdate.before.asOf !== marketTrend?.asOf && (
                        <span className="text-zinc-600"> (was {dataUpdate.before.asOf})</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">SENSEX as of</span>
                    <span className="text-zinc-200">
                      {marketTrend?.sensex?.asOf ?? '—'}
                      {dataUpdate.before?.sensex?.asOf && dataUpdate.before.sensex.asOf !== marketTrend?.sensex?.asOf && (
                        <span className="text-zinc-600"> (was {dataUpdate.before.sensex.asOf})</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">India VIX as of</span>
                    <span className="text-zinc-200">
                      {marketTrend?.vixAsOf ?? '—'}
                      {marketTrend?.vixPercentile != null && (
                        <span className="text-zinc-500"> · {marketTrend.vixPercentile.toFixed(0)}th pct</span>
                      )}
                    </span>
                  </div>
                </div>
              )}

              {dataUpdate.log.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-2.5 space-y-0.5 font-mono text-[10px] leading-relaxed text-zinc-500">
                  {dataUpdate.log.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
                  ))}
                </div>
              )}
            </div>

            {dataUpdate.phase !== 'running' && (
              <div className="flex justify-end border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setDataUpdate(null)}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:border-zinc-600"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
