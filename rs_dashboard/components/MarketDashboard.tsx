'use client';

/**
 * Bloomberg-Style Quantitative & Execution Terminal
 *
 * Visual language: Authentic Bloomberg terminal aesthetics — near-black ground,
 * hairline amber rules, monospaced tabular figures, uppercase micro-labels,
 * high-density column spacing without awkward gaps, and saturated green/red
 * reserved exclusively for market direction.
 *
 * Comprehensive Institutional Features:
 *   - Top Bloomberg Function Keys ([F1] SCALPER, [F2] STRATEGIES, etc.)
 *   - Real-time IST Market Status (Open, Pre-Open, Post-Market, Weekend)
 *   - Ticker tape with index LTP, daily point change, and % change
 *   - Multi-Broker Portfolio Balance Sheet & Margin Utilization Meters
 *   - Algorithmic Trading Bots Telemetry (Running PIDs, strategy P&L, adjustments)
 *   - Options Volatility Regime & Expected Move Range (derived from India VIX)
 *   - Market Breadth Sentiment Gauges (Nifty 50, Bank Nifty, Nifty 500)
 *   - Zero-gap Market Movers with Volume Ratio and RSI(14)
 *   - Open Positions partitioned and displayed SEPARATELY for each broker
 *   - Instant Contract & Strike Search across open positions
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Briefcase,
  ChevronRight,
  CircleDot,
  Clock,
  Compass,
  Cpu,
  ExternalLink,
  Gauge,
  Layers,
  LayoutDashboard,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import type { MoverResult, MoversResponse } from '@/app/api/movers/route';
import type { DashboardBreadthResponse } from '@/app/api/dashboard/breadth/route';
import type { BrokerPortfolio, DashboardPortfolioResponse, DashboardPosition } from '@/app/api/dashboard/portfolio/route';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

// ─── Poll cadences (dhan-polling-guards skill) ────────────────────────────────
const INDEX_POLL_MS = 5_000;       // cheap: one batched broker quote call
const PORTFOLIO_POLL_MS = 6_000;   // funds + positions, 3 brokers, server-fanned
const STRATEGIES_POLL_MS = 10_000; // algo states + P&L
const BREADTH_POLL_MS = 60_000;    // ~500-symbol sweep behind a 60s server cache
const MOVERS_POLL_MS = 120_000;    // EOD CSVs patched with today's quotes
const HOLDINGS_POLL_MS = 300_000;  // Python spawn; delivery value barely moves

const TOP_N_MOVERS = 10;
const BROKER_ORDER: Broker[] = ['dhan', 'zerodha', 'kotak'];

// Key flagship strategies to feature on the dashboard
const FEATURED_STRATEGY_KEYS = [
  'nifty_advanced_imbalance',
  'nifty_delta_neutral',
  'nifty_spread_trend',
  'crudeoilm_supertrend',
  'nifty500_momentum',
  'nifty_oi_directional',
];

// ─── Bloomberg Function Keys ──────────────────────────────────────────────────
const FUNCTION_KEYS = [
  { key: 'F1', label: 'SCALPER', href: '/scalper' },
  { key: 'F2', label: 'STRATEGIES', href: '/strategies' },
  { key: 'F3', label: 'SCANNER', href: '/scanner' },
  { key: 'F4', label: 'PORTFOLIO', href: '/portfolio' },
  { key: 'F5', label: 'BREADTH', href: '/breadth' },
  { key: 'F6', label: 'LIVE CHARTS', href: '/options/live-charts' },
  { key: 'F7', label: 'OPTIONS', href: '/options/premium-bar' },
  { key: 'F8', label: 'DIARY', href: '/portfolio/diary' },
];

// ─── Strategy Types ───────────────────────────────────────────────────────────

interface StrategyMeta {
  key: string;
  name: string;
  underlying: string;
  logicGroup: string;
  timeframe: string;
}

interface StrategyState {
  strategy: string;
  status: string; // 'RUNNING' | 'STOPPED' | 'ERROR'
  total_pnl: number;
  realized_pnl: number;
  spot: number;
  adjustments: number;
  pid?: number;
}

interface StrategyInfo {
  meta: StrategyMeta;
  state: StrategyState;
  instances?: Record<string, StrategyState>;
}

interface StrategiesResponse {
  success: boolean;
  strategies: Record<string, StrategyInfo>;
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Compact Indian-notation rupees: 12.40L, 1.83Cr, 45.2K */
function fmtINRCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

function fmtSignedPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtSignedINR(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '-'}${fmtINRCompact(Math.abs(v))}`;
}

/** Solid text colors only — no text opacity modifiers per design guidelines */
function dirClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'text-zinc-400';
  return v > 0 ? 'text-emerald-400' : 'text-red-400';
}

// ─── Contract Parsing Helper ──────────────────────────────────────────────────

interface ParsedContract {
  underlying: string;
  expiry: string;
  strike: string;
  type: 'CE' | 'PE' | null;
  displaySymbol: string;
}

function parseContract(symbol: string): ParsedContract {
  const s = symbol.trim().toUpperCase();

  // Dhan: NIFTY-Sep2026-23300-PE
  const dhanMatch = /^([A-Z]+)-([A-Z]{3})(\d{4})-(\d+(?:\.\d+)?)-(CE|PE)$/.exec(s);
  if (dhanMatch) {
    return {
      underlying: dhanMatch[1],
      expiry: `${dhanMatch[2]} ${dhanMatch[3]}`,
      strike: dhanMatch[4],
      type: dhanMatch[5] as 'CE' | 'PE',
      displaySymbol: `${dhanMatch[1]} ${dhanMatch[4]} ${dhanMatch[5]}`,
    };
  }

  // Kotak weekly compact: NIFTY2692224600CE or NIFTY2691523350PE
  const kotakWeeklyMatch = /^([A-Z]+)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/.exec(s);
  if (kotakWeeklyMatch) {
    const monthNames: Record<string, string> = {
      '1': 'JAN', '2': 'FEB', '3': 'MAR', '4': 'APR', '5': 'MAY', '6': 'JUN',
      '7': 'JUL', '8': 'AUG', '9': 'SEP', 'O': 'OCT', 'N': 'NOV', 'D': 'DEC',
    };
    const mon = monthNames[kotakWeeklyMatch[3]] ?? kotakWeeklyMatch[3];
    return {
      underlying: kotakWeeklyMatch[1],
      expiry: `${kotakWeeklyMatch[4]} ${mon} '${kotakWeeklyMatch[2]}`,
      strike: kotakWeeklyMatch[5],
      type: kotakWeeklyMatch[6] as 'CE' | 'PE',
      displaySymbol: `${kotakWeeklyMatch[1]} ${kotakWeeklyMatch[5]} ${kotakWeeklyMatch[6]}`,
    };
  }

  // Standard compact: NIFTY + DD + MON + YY + STRIKE + CE/PE
  const compactMatch = /^([A-Z]+?)(\d{2})([A-Z]{3})(\d{2})(\d+)(CE|PE)$/.exec(s);
  if (compactMatch) {
    return {
      underlying: compactMatch[1],
      expiry: `${compactMatch[2]} ${compactMatch[3]} '20${compactMatch[4]}`,
      strike: compactMatch[5],
      type: compactMatch[6] as 'CE' | 'PE',
      displaySymbol: `${compactMatch[1]} ${compactMatch[5]} ${compactMatch[6]}`,
    };
  }

  const isCE = s.endsWith('CE');
  const isPE = s.endsWith('PE');
  return {
    underlying: s,
    expiry: '',
    strike: '',
    type: isCE ? 'CE' : isPE ? 'PE' : null,
    displaySymbol: s,
  };
}

// ─── Market Status & Volatility Regime ────────────────────────────────────────

function getMarketSessionInfo() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 3600000);
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  const hour = ist.getHours();
  const minute = ist.getMinutes();
  const timeNum = hour * 60 + minute;

  const isWeekend = day === 0 || day === 6;
  if (isWeekend) {
    return { status: 'CLOSED', label: 'WEEKEND CLOSED', tone: 'neutral' as const, isWeekend: true };
  }
  if (timeNum >= 540 && timeNum < 555) {
    return { status: 'PRE-OPEN', label: 'PRE-OPEN SESSION', tone: 'accent' as const, isWeekend: false };
  }
  if (timeNum >= 555 && timeNum <= 930) {
    return { status: 'OPEN', label: 'MARKET LIVE', tone: 'live' as const, isWeekend: false };
  }
  if (timeNum > 930 && timeNum <= 940) {
    return { status: 'POST', label: 'POST-CLOSING', tone: 'neutral' as const, isWeekend: false };
  }
  return { status: 'EOD', label: 'AFTER-HOURS / EOD', tone: 'neutral' as const, isWeekend: false };
}

function getVixRegime(vix: number | null | undefined) {
  if (!vix || vix <= 0) {
    return {
      label: 'NORMAL VOLATILITY',
      regime: 'EQUILIBRIUM',
      strategy: 'Balanced credit spreads / strangles',
      tone: 'neutral' as const,
      bias: 'NEUTRAL',
    };
  }
  if (vix < 12.0) {
    return {
      label: 'LOW VOLATILITY',
      regime: 'THETA HARVEST REGIME',
      strategy: 'High decay edge — ideal for ATM straddles & premium selling',
      tone: 'emerald' as const,
      bias: 'PREMIUM SELLER FAVORED',
    };
  }
  if (vix <= 16.0) {
    return {
      label: 'NORMAL VOLATILITY',
      regime: 'BALANCED EQUILIBRIUM',
      strategy: 'Standard delta-neutral straddles, iron condors & spread trend',
      tone: 'amber' as const,
      bias: 'BALANCED STRATEGIES',
    };
  }
  return {
    label: 'HIGH VOLATILITY',
    regime: 'VOLATILITY EXPANSION',
    strategy: 'Wide intraday swings — use defined-risk spreads or long hedges',
    tone: 'red' as const,
    bias: 'DEFINED-RISK / HEDGED',
  };
}

// ─── Shared Bloomberg Terminal Chrome ─────────────────────────────────────────

function TerminalPanel({
  title,
  icon: Icon,
  meta,
  href,
  badge,
  children,
  className = '',
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
        ) : (
          heading
        )}
        {meta ? <div className="font-mono text-[11px] text-zinc-400">{meta}</div> : null}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

function StatTile({
  label,
  value,
  sub,
  progress,
  tone = 'neutral',
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
          <span className="font-mono text-[10px] font-semibold text-zinc-400">
            {progress.percent.toFixed(1)}%
          </span>
        )}
      </div>

      <div className={`font-mono text-lg font-bold leading-none tabular-nums ${valueClass}`}>
        {value}
      </div>

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

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center px-4 py-8 text-center font-mono text-xs text-zinc-500">
      {children}
    </div>
  );
}

// ─── Index Strip (Bloomberg Ticker Tape) ──────────────────────────────────────

interface IndexQuote { ltp: number; prev_close: number; change_pct: number | null; source: string }
interface TopIndicesResponse {
  success: boolean;
  updated_at: string;
  order: { key: string; label: string }[];
  quotes: Record<string, IndexQuote>;
  errors: string[];
}

function IndexStrip({ data }: { data: TopIndicesResponse | null }) {
  if (!data) {
    return (
      <div className="flex h-[64px] items-center rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 font-mono text-xs text-zinc-500">
        <Activity className="mr-2 h-4 w-4 animate-spin text-amber-400" />
        Connecting to index feed…
      </div>
    );
  }

  const rows = data.order.filter(o => data.quotes[o.key]);
  if (rows.length === 0) {
    return (
      <div className="flex h-[64px] items-center rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 font-mono text-xs text-zinc-500">
        No index quotes — {data.errors[0] ?? 'broker feed unavailable'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm">
      <div className="flex min-w-max divide-x divide-zinc-800">
        {rows.map(({ key, label }) => {
          const q = data.quotes[key];
          const pct = q.change_pct;
          const abs = q.prev_close > 0 ? q.ltp - q.prev_close : null;
          const up = (pct ?? 0) > 0;
          const down = (pct ?? 0) < 0;

          return (
            <div
              key={key}
              className="flex min-w-[155px] flex-col justify-between gap-1 px-3.5 py-2.5 transition-colors hover:bg-zinc-800/30"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-amber-400">
                  {label}
                </span>
                <span className="font-mono text-[9px] text-zinc-600">
                  {key}
                </span>
              </div>

              <span className="font-mono text-base font-bold leading-none tabular-nums text-zinc-100">
                {fmtNum(q.ltp, 2)}
              </span>

              {pct === null || abs === null ? (
                <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
                  <span>EOD MARK</span>
                  <span className="text-zinc-600">PREV N/A</span>
                </div>
              ) : (
                <span className={`flex items-center gap-1 font-mono text-[11px] font-semibold tabular-nums ${dirClass(pct)}`}>
                  {up && <ArrowUpRight className="h-3.5 w-3.5" />}
                  {down && <ArrowDownRight className="h-3.5 w-3.5" />}
                  <span>{`${abs >= 0 ? '+' : ''}${fmtNum(abs, 2)}`}</span>
                  <span className="text-zinc-600">|</span>
                  <span>{fmtSignedPct(pct)}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Options Volatility & Market Regime Intelligence ──────────────────────────

function OptionsVolatilityIntelligence({
  niftyLtp,
  vixLtp,
}: {
  niftyLtp: number | null | undefined;
  vixLtp: number | null | undefined;
}) {
  const currentVix = vixLtp && vixLtp > 0 ? vixLtp : 10.68;
  const spot = niftyLtp && niftyLtp > 0 ? niftyLtp : 23897.7;
  const regime = getVixRegime(currentVix);

  // Daily 1-Sigma Expected Move derived from VIX (annualized / sqrt(252))
  const dailySigmaPct = currentVix / Math.sqrt(252);
  const expectedPoints = spot * (dailySigmaPct / 100);
  const rangeLow = spot - expectedPoints;
  const rangeHigh = spot + expectedPoints;

  return (
    <TerminalPanel
      title="Options Volatility Regime & Expected Move"
      icon={Radar}
      href="/options/premium-bar"
      badge={
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${
            regime.tone === 'emerald'
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : regime.tone === 'amber'
              ? 'border border-amber-500/30 bg-amber-500/10 text-amber-400'
              : 'border border-red-500/30 bg-red-500/10 text-red-400'
          }`}
        >
          {regime.bias}
        </span>
      }
      meta={
        <div className="flex items-center gap-3 font-mono text-xs">
          <span>INDIA VIX: <strong className="text-amber-400">{currentVix.toFixed(2)}</strong></span>
          <span className="text-zinc-700">|</span>
          <span className="text-zinc-400">AUTO-EXIT: <strong className="text-zinc-200">15:17 IST</strong></span>
        </div>
      }
    >
      <div className="grid gap-3 p-3.5 md:grid-cols-3">
        {/* Metric 1: VIX Regime Status */}
        <div className="flex flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
              VIX PRICING REGIME
            </span>
            <span className="font-mono text-xs font-bold text-amber-400">
              {currentVix.toFixed(2)}
            </span>
          </div>

          <div className="my-1.5 flex items-baseline gap-2">
            <span
              className={`font-mono text-base font-bold ${
                regime.tone === 'emerald' ? 'text-emerald-400' : regime.tone === 'amber' ? 'text-amber-400' : 'text-red-400'
              }`}
            >
              {regime.regime}
            </span>
          </div>

          <p className="font-mono text-[10px] text-zinc-400">
            {regime.strategy}
          </p>
        </div>

        {/* Metric 2: 1-Day Expected Move */}
        <div className="flex flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
              DAILY 1-SIGMA EXPECTED MOVE
            </span>
            <span className="font-mono text-[10px] text-zinc-400">
              ±{dailySigmaPct.toFixed(2)}%
            </span>
          </div>

          <div className="my-1.5 flex items-baseline gap-2">
            <span className="font-mono text-base font-bold text-zinc-100">
              ±{fmtNum(expectedPoints, 1)} PTS
            </span>
            <span className="font-mono text-[10px] text-zinc-500">
              (Nifty Spot: {fmtNum(spot, 0)})
            </span>
          </div>

          <div className="flex items-center justify-between font-mono text-[10px] text-zinc-400">
            <span>IMPLIED EXPIRY BAND:</span>
            <span className="font-semibold text-zinc-200">
              {fmtNum(rangeLow, 0)} – {fmtNum(rangeHigh, 0)}
            </span>
          </div>
        </div>

        {/* Metric 3: Institutional Risk Controls */}
        <div className="flex flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
              EXECUTION GUARDS
            </span>
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
          </div>

          <div className="my-1 flex flex-col gap-1 font-mono text-[10px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">Intraday Auto-Squareoff</span>
              <span className="font-bold text-amber-400">15:17 IST</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Inversion Guard</span>
              <span className="font-bold text-emerald-400">CE Strike &gt; PE Strike</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Bulk Exit Protection</span>
              <span className="font-bold text-zinc-300">FNO Only (Scope Clamped)</span>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <Link
              href="/options/premium-bar"
              className="font-mono text-[10px] font-bold text-amber-400 hover:text-amber-300"
            >
              VOLATILITY SMILE &amp; PREMIUM BAR →
            </Link>
          </div>
        </div>
      </div>
    </TerminalPanel>
  );
}

// ─── Algo Trading Bots Execution Desk ─────────────────────────────────────────

function AlgoStrategiesDesk({
  data,
}: {
  data: StrategiesResponse | null;
}) {
  const allStrategies = Object.values(data?.strategies ?? {});
  const runningBots = allStrategies.filter(s => s.state?.status === 'RUNNING');
  const runningCount = runningBots.length;

  const totalAlgoPnl = allStrategies.reduce((acc, s) => acc + (s.state?.total_pnl ?? 0), 0);
  const featured = FEATURED_STRATEGY_KEYS.map(k => data?.strategies?.[k]).filter(Boolean) as StrategyInfo[];

  return (
    <TerminalPanel
      title="Automated Algo Execution Desk"
      icon={Bot}
      href="/strategies"
      badge={
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${
            runningCount > 0
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : 'border border-zinc-700 bg-zinc-800 text-zinc-400'
          }`}
        >
          {runningCount > 0 ? `${runningCount} BOTS ACTIVE` : 'ALL STANDBY'}
        </span>
      }
      meta={
        <div className="flex items-center gap-3 font-mono text-xs">
          <span className="text-zinc-400">
            TOTAL ALGO P&amp;L:{' '}
            <strong className={dirClass(totalAlgoPnl)}>{fmtSignedINR(totalAlgoPnl)}</strong>
          </span>
          <span className="text-zinc-700">|</span>
          <Link href="/strategies" className="text-amber-400 hover:underline">
            MANAGE ALL {allStrategies.length} STRATEGIES →
          </Link>
        </div>
      }
    >
      <div className="grid gap-3 p-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {featured.map(strat => {
          const isRunning = strat.state?.status === 'RUNNING';
          const pnl = strat.state?.total_pnl ?? 0;

          return (
            <div
              key={strat.meta.key}
              className="flex flex-col justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3 transition-colors hover:border-zinc-700"
            >
              <div className="flex items-center justify-between gap-1 border-b border-zinc-800/80 pb-1.5">
                <span className="truncate text-[10px] font-bold uppercase tracking-wider text-amber-400">
                  {strat.meta.name.replace('Nifty ', '').replace('Crude Oil ', '')}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.2 font-mono text-[8px] font-bold ${
                    isRunning
                      ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : 'border border-zinc-800 bg-zinc-900 text-zinc-500'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'
                    }`}
                  />
                  {isRunning ? 'RUN' : 'IDLE'}
                </span>
              </div>

              <div className="flex flex-col">
                <span className={`font-mono text-sm font-bold tabular-nums ${dirClass(pnl)}`}>
                  {fmtSignedINR(pnl)}
                </span>
                <span className="font-mono text-[9px] text-zinc-500">
                  {strat.meta.underlying} · {strat.meta.logicGroup}
                </span>
              </div>

              <div className="flex items-center justify-between border-t border-zinc-900 pt-1 font-mono text-[9px] text-zinc-500">
                <span>Adj: {strat.state?.adjustments ?? 0}</span>
                <Link
                  href="/strategies"
                  className="font-bold text-amber-400 hover:text-amber-300"
                >
                  BOT →
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </TerminalPanel>
  );
}

// ─── Market Breadth Visualizer ────────────────────────────────────────────────

const BREADTH_BASKETS: { key: string; label: string }[] = [
  { key: 'nifty50', label: 'NIFTY 50' },
  { key: 'banknifty', label: 'BANK NIFTY' },
  { key: 'nifty500', label: 'NIFTY 500' },
];

function BreadthBar({ basket }: { basket: DashboardBreadthResponse['baskets'][string] }) {
  const { advancing, declining, unchanged, total, advDecRatio, breadthPct } = basket;
  const pctOf = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  const advPct = pctOf(advancing);
  const decPct = pctOf(declining);

  let regime = 'NEUTRAL / UNCHANGED';
  let regimeColor = 'text-zinc-400 border-zinc-700 bg-zinc-800/40';
  if (advancing > declining * 1.5 && advancing > 0) {
    regime = 'STRONG BULLISH';
    regimeColor = 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
  } else if (declining > advancing * 1.5 && declining > 0) {
    regime = 'STRONG BEARISH';
    regimeColor = 'text-red-400 border-red-500/30 bg-red-500/10';
  } else if (advancing > declining && advancing > 0) {
    regime = 'MILD ADVANCE';
    regimeColor = 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5';
  } else if (declining > advancing && declining > 0) {
    regime = 'MILD DECLINE';
    regimeColor = 'text-red-400 border-red-500/20 bg-red-500/5';
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold ${regimeColor}`}>
          {regime}
        </span>
        <span className="font-mono text-[10px] text-zinc-400">
          A/D RATIO:{' '}
          <strong className="text-zinc-200">
            {advDecRatio === null ? '—' : advDecRatio.toFixed(2)}
          </strong>
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-xl font-bold leading-none tabular-nums text-emerald-400">
            {advancing}
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            ({advPct.toFixed(0)}%)
          </span>
        </div>

        <span className="font-mono text-[10px] text-zinc-500">
          {unchanged} unch
        </span>

        <div className="flex items-baseline gap-1.5 text-right">
          <span className="font-mono text-[10px] text-zinc-500">
            ({decPct.toFixed(0)}%)
          </span>
          <span className="font-mono text-xl font-bold leading-none tabular-nums text-red-400">
            {declining}
          </span>
        </div>
      </div>

      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className="bg-emerald-500 transition-all duration-500"
          style={{ width: `${advPct}%` }}
          title={`Advancing: ${advancing}`}
        />
        <div
          className="bg-zinc-600 transition-all duration-500"
          style={{ width: `${pctOf(unchanged)}%` }}
          title={`Unchanged: ${unchanged}`}
        />
        <div
          className="bg-red-500 transition-all duration-500"
          style={{ width: `${decPct}%` }}
          title={`Declining: ${declining}`}
        />
      </div>

      <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
        <span>ADVANCE: {breadthPct === null ? '—' : `${breadthPct.toFixed(1)}%`}</span>
        <span>TOTAL: {total} SCANNED</span>
      </div>
    </div>
  );
}

function BreadthPanel({ data, loading }: { data: DashboardBreadthResponse | null; loading: boolean }) {
  return (
    <TerminalPanel
      title="Market Breadth & Regime"
      icon={Gauge}
      href="/breadth"
      badge={
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-400">
          SWEEP
        </span>
      }
      meta={
        data?.updatedAt
          ? new Date(data.updatedAt).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) + ' IST'
          : undefined
      }
    >
      {data?.error ? (
        <EmptyRow>Breadth sweep failed — {data.error}</EmptyRow>
      ) : !data ? (
        <EmptyRow>{loading ? 'Sweeping constituents…' : 'No breadth data'}</EmptyRow>
      ) : (
        <div className="grid gap-3 p-3.5 sm:grid-cols-3">
          {BREADTH_BASKETS.map(({ key, label }) => {
            const basket = data.baskets[key];
            return (
              <div key={key} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="mb-2 flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                    {label}
                  </span>
                  <span className="font-mono text-[9px] text-zinc-600">INDEX BASKET</span>
                </div>
                {basket ? <BreadthBar basket={basket} /> : <p className="font-mono text-xs text-zinc-600">—</p>}
              </div>
            );
          })}
        </div>
      )}
    </TerminalPanel>
  );
}

// ─── Zero-Gap Market Movers Tables ────────────────────────────────────────────

function MoverTable({
  rows,
  direction,
  loading,
}: {
  rows: MoverResult[];
  direction: 'up' | 'down';
  loading?: boolean;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="p-4 space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-8 w-full bg-zinc-800/40 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyRow>No mover records available for this index</EmptyRow>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-zinc-800">
            <th className="w-8 px-2 py-2 text-center text-xs font-bold text-white">#</th>
            <th className="px-3 py-2 text-xs font-bold text-white">Symbol &amp; Sector</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">LTP</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">Chg %</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">Vol Ratio</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">RSI (14)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800 font-mono text-xs">
          {rows.map((row, idx) => {
            const volHigh = row.volumeRatio >= 2.0;
            const rsiOverbought = (row.rsi14 ?? 0) >= 70;
            const rsiOversold = (row.rsi14 ?? 0) <= 30 && (row.rsi14 ?? 0) > 0;

            return (
              <tr key={row.symbol} className="transition-colors hover:bg-zinc-800/50">
                <td className="w-8 px-2 py-2 text-center font-mono text-[11px] font-semibold text-zinc-500">
                  {idx + 1}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col">
                    <span className="font-bold text-zinc-100">{row.symbol}</span>
                    <span className="text-[10px] text-zinc-500 truncate max-w-[150px]">
                      {row.sector || 'Equities'}
                    </span>
                  </div>
                </td>

                <td className="px-3 py-2 text-right tabular-nums text-zinc-200 font-semibold">
                  {fmtNum(row.latestClose, 2)}
                </td>

                <td className="px-3 py-2 text-right">
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-bold tabular-nums ${
                      direction === 'up'
                        ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border border-red-500/30 bg-red-500/10 text-red-400'
                    }`}
                  >
                    {direction === 'up' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {fmtSignedPct(row.priceChange1D)}
                  </span>
                </td>

                <td className="px-3 py-2 text-right tabular-nums">
                  <span className={volHigh ? 'font-bold text-amber-400' : 'text-zinc-400'}>
                    {row.volumeRatio > 0 ? `${row.volumeRatio.toFixed(1)}x` : '—'}
                  </span>
                </td>

                <td className="px-3 py-2 text-right tabular-nums">
                  {row.rsi14 ? (
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        rsiOverbought
                          ? 'border border-amber-500/30 bg-amber-500/15 text-amber-400'
                          : rsiOversold
                          ? 'border border-sky-500/30 bg-sky-500/15 text-sky-400'
                          : 'text-zinc-400'
                      }`}
                    >
                      {row.rsi14.toFixed(1)}
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Broker Capital & Exposure Card ───────────────────────────────────────────

function BrokerAccountCard({
  b,
  holdingsValue,
}: {
  b: BrokerPortfolio;
  holdingsValue: number | null;
}) {
  const isConnected = b.connected && !b.error;
  const portfolioValue =
    b.totalBalance === null ? null : b.totalBalance + (holdingsValue ?? 0);

  const marginUtilPercent =
    b.totalBalance && b.totalBalance > 0 && b.utilizedMargin !== null
      ? (b.utilizedMargin / b.totalBalance) * 100
      : 0;

  const utilColor =
    marginUtilPercent > 85
      ? 'bg-red-500'
      : marginUtilPercent > 65
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  const scalperPath =
    b.broker === 'dhan'
      ? '/scalper?broker=dhan'
      : b.broker === 'kotak'
      ? '/scalper?broker=kotak'
      : '/scalper?broker=zerodha';

  return (
    <div className="flex flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 transition-colors hover:border-zinc-700">
      <div className="flex flex-col gap-2 border-b border-zinc-800 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CircleDot className={`h-3 w-3 ${isConnected ? 'text-emerald-500' : 'text-zinc-600'}`} />
            <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-amber-400">
              {BROKER_LABELS[b.broker]}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${
                isConnected
                  ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border border-zinc-700 bg-zinc-800 text-zinc-500'
              }`}
            >
              {isConnected ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>

          <div className="text-right">
            <span className={`font-mono text-xs font-bold tabular-nums ${dirClass(b.totalPnl)}`}>
              {isConnected ? fmtSignedINR(b.totalPnl) : '—'}
            </span>
            <span className="block font-mono text-[9px] text-zinc-500">DAY P&amp;L</span>
          </div>
        </div>

        {isConnected && b.totalBalance !== null && (
          <div className="flex flex-col gap-1 pt-1">
            <div className="flex justify-between font-mono text-[10px]">
              <span className="text-zinc-500">Margin Utilization</span>
              <span className="font-semibold text-zinc-300">{marginUtilPercent.toFixed(1)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full transition-all duration-500 ${utilColor}`}
                style={{ width: `${Math.min(marginUtilPercent, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {!isConnected ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <p className="font-mono text-xs text-zinc-500">{b.error ?? 'Session not active'}</p>
          <Link
            href="/login"
            className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1 font-mono text-[10px] font-bold text-amber-400 hover:bg-amber-500/20"
          >
            Authenticate {BROKER_LABELS[b.broker]}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-3 pt-3">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-xs">
            <dt className="text-zinc-500">Total Valuation</dt>
            <dd className="text-right font-bold tabular-nums text-amber-400">
              {fmtINRCompact(portfolioValue)}
            </dd>

            <dt className="text-zinc-500">Available Margin</dt>
            <dd className="text-right tabular-nums text-zinc-200">
              {fmtINRCompact(b.availableBalance)}
            </dd>

            <dt className="text-zinc-500">Utilized Margin</dt>
            <dd className="text-right tabular-nums text-zinc-200">
              {fmtINRCompact(b.utilizedMargin)}
            </dd>

            <dt className="text-zinc-500">Margin Base</dt>
            <dd className="text-right tabular-nums text-zinc-400">
              {fmtINRCompact(b.totalBalance)}
            </dd>

            {holdingsValue !== null && (
              <>
                <dt className="text-zinc-500">Delivery Holdings</dt>
                <dd className="text-right tabular-nums text-zinc-300">
                  {fmtINRCompact(holdingsValue)}
                </dd>
              </>
            )}

            {b.collateralAmount !== null && (
              <>
                <dt className="text-zinc-500">Collateral Margin</dt>
                <dd className="text-right tabular-nums text-zinc-300">
                  {fmtINRCompact(b.collateralAmount)}
                </dd>
              </>
            )}

            {b.cashBalance !== null && (
              <>
                <dt className="text-zinc-500">Spendable Cash</dt>
                <dd
                  className={`text-right tabular-nums ${b.cashBalance <= 0 ? 'text-amber-400' : 'text-zinc-300'}`}
                >
                  {fmtINRCompact(b.cashBalance)}
                </dd>
              </>
            )}
          </dl>

          <div className="grid grid-cols-3 gap-2 rounded border border-zinc-800/80 bg-zinc-900/60 p-2 font-mono text-[10px]">
            <div>
              <p className="text-zinc-500">Open Legs</p>
              <p className="font-bold text-zinc-200">{b.openPositions}</p>
            </div>
            <div>
              <p className="text-zinc-500">Unrealized</p>
              <p className={`font-semibold tabular-nums ${dirClass(b.unrealizedPnl)}`}>
                {fmtSignedINR(b.unrealizedPnl)}
              </p>
            </div>
            <div>
              <p className="text-zinc-500">Realized</p>
              <p className={`font-semibold tabular-nums ${dirClass(b.realizedPnl)}`}>
                {fmtSignedINR(b.realizedPnl)}
              </p>
            </div>
          </div>

          {b.unpricedPositions > 0 && (
            <p
              className="font-mono text-[10px] text-amber-400"
              title="Kotak positions payload carries no LTP; prices excluded to prevent marking against strike (Rule 3)."
            >
              ⚠ {b.unpricedPositions} leg{b.unpricedPositions === 1 ? '' : 's'} unpriced (no LTP in broker payload)
            </p>
          )}

          <div className="flex justify-end pt-1">
            <Link
              href={scalperPath}
              className="inline-flex items-center gap-1 font-mono text-[10px] font-bold text-amber-400 hover:text-amber-300"
            >
              LAUNCH SCALPER
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dedicated Broker Positions Table (Separated by Broker) ───────────────────

function BrokerPositionsTable({
  broker,
  positions,
  brokerSummary,
}: {
  broker: Broker;
  positions: DashboardPosition[];
  brokerSummary?: BrokerPortfolio;
}) {
  if (positions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-6 text-center font-mono text-xs text-zinc-500">
        <p>No active positions held in {BROKER_LABELS[broker]}.</p>
        <Link
          href={`/scalper?broker=${broker}`}
          className="mt-2 text-[11px] font-bold text-amber-400 hover:underline"
        >
          Open {BROKER_LABELS[broker]} Scalper to place orders →
        </Link>
      </div>
    );
  }

  // Calculate broker-level subtotals
  const totalQty = positions.reduce((acc, p) => acc + p.netQty, 0);
  const totalUnrealized = positions.reduce((acc, p) => acc + p.unrealizedPnl, 0);
  const totalRealized = positions.reduce((acc, p) => acc + p.realizedPnl, 0);
  const totalPnl = positions.reduce((acc, p) => acc + p.totalPnl, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-zinc-800">
            <th className="px-3 py-2 text-center text-xs font-bold text-white">Side</th>
            <th className="px-3 py-2 text-left text-xs font-bold text-white">Contract / Strike</th>
            <th className="px-3 py-2 text-center text-xs font-bold text-white">Product</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">Qty</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">Avg Price</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">LTP</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">Unrealized</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">Realized</th>
            <th className="px-3 py-2 text-right text-xs font-bold text-white">Total P&amp;L</th>
            <th className="px-3 py-2 text-center text-xs font-bold text-white">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800 font-mono text-xs">
          {positions.map(p => {
            const parsed = parseContract(p.tradingSymbol);
            const isBuy = p.netQty > 0;
            const hasLtp = p.lastPrice > 0;

            return (
              <tr
                key={`${p.broker}:${p.tradingSymbol}:${p.productType}`}
                className="transition-colors hover:bg-zinc-800/40"
              >
                {/* Side Tag */}
                <td className="px-3 py-2 text-center">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      isBuy
                        ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border border-red-500/30 bg-red-500/10 text-red-400'
                    }`}
                  >
                    {isBuy ? 'BUY' : 'SELL'}
                  </span>
                </td>

                {/* Contract / Strike */}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-zinc-100">{parsed.displaySymbol}</span>
                    {parsed.type && (
                      <span
                        className={`rounded px-1.5 py-0.2 text-[9px] font-bold ${
                          parsed.type === 'CE'
                            ? 'bg-sky-500/15 text-sky-400 border border-sky-500/25'
                            : 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
                        }`}
                      >
                        {parsed.type}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    {parsed.expiry && <span>{parsed.expiry}</span>}
                    <span className="uppercase">{p.exchange}</span>
                  </div>
                </td>

                {/* Product */}
                <td className="px-3 py-2 text-center">
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                    {p.productType || 'MARGIN'}
                  </span>
                </td>

                {/* Qty */}
                <td
                  className={`px-3 py-2 text-right font-bold tabular-nums ${
                    isBuy ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {isBuy ? `+${p.netQty}` : p.netQty}
                </td>

                {/* Avg Price */}
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                  ₹{fmtNum(p.avgPrice, 2)}
                </td>

                {/* LTP */}
                <td
                  className="px-3 py-2 text-right tabular-nums text-zinc-200"
                  title={
                    hasLtp
                      ? undefined
                      : 'Broker returns no LTP. Excluded from P&L to prevent strike-marking distortion.'
                  }
                >
                  {hasLtp ? `₹${fmtNum(p.lastPrice, 2)}` : <span className="text-zinc-600">—</span>}
                </td>

                {/* Unrealized P&L */}
                <td className={`px-3 py-2 text-right tabular-nums ${dirClass(p.unrealizedPnl)}`}>
                  {hasLtp || p.unrealizedPnl !== 0 ? fmtSignedINR(p.unrealizedPnl) : <span className="text-zinc-600">—</span>}
                </td>

                {/* Realized P&L */}
                <td className={`px-3 py-2 text-right tabular-nums ${dirClass(p.realizedPnl)}`}>
                  {fmtSignedINR(p.realizedPnl)}
                </td>

                {/* Total P&L */}
                <td className={`px-3 py-2 text-right font-bold tabular-nums ${dirClass(p.totalPnl)}`}>
                  {hasLtp || p.totalPnl !== 0 ? fmtSignedINR(p.totalPnl) : <span className="text-zinc-600">—</span>}
                </td>

                {/* Action Link */}
                <td className="px-3 py-2 text-center">
                  <Link
                    href={`/scalper?broker=${p.broker}&symbol=${parsed.underlying}`}
                    className="inline-flex items-center rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-300 transition-colors hover:border-amber-500/40 hover:text-amber-400"
                  >
                    TRADE
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700 bg-zinc-950 font-mono text-xs font-bold">
            <td colSpan={3} className="px-3 py-2 text-zinc-400">
              SUBTOTAL ({positions.length} LEGS)
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
              {totalQty}
            </td>
            <td colSpan={2} className="px-3 py-2 text-right text-zinc-500">
              {brokerSummary?.unpricedPositions && brokerSummary.unpricedPositions > 0 ? (
                <span className="text-amber-400">
                  {brokerSummary.unpricedPositions} leg(s) unpriced
                </span>
              ) : null}
            </td>
            <td className={`px-3 py-2 text-right tabular-nums ${dirClass(totalUnrealized)}`}>
              {fmtSignedINR(totalUnrealized)}
            </td>
            <td className={`px-3 py-2 text-right tabular-nums ${dirClass(totalRealized)}`}>
              {fmtSignedINR(totalRealized)}
            </td>
            <td className={`px-3 py-2 text-right tabular-nums ${dirClass(totalPnl)}`}>
              {fmtSignedINR(totalPnl)}
            </td>
            <td className="px-3 py-2 text-center text-zinc-500">
              <Link
                href={`/scalper?broker=${broker}`}
                className="text-[10px] font-bold text-amber-400 hover:underline"
              >
                SCALPER →
              </Link>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Main Open Positions Partitioned Section ──────────────────────────────────

function SeparatedPositionsSection({
  brokers,
  portfolioTotals,
}: {
  brokers: BrokerPortfolio[];
  portfolioTotals?: DashboardPortfolioResponse['totals'];
}) {
  const [activeTab, setActiveTab] = useState<'all' | Broker>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Extract all positions count
  const allPositions = useMemo(() => {
    return brokers.flatMap(b => b.positions);
  }, [brokers]);

  return (
    <TerminalPanel
      title="Open Positions (Per Broker)"
      icon={Layers}
      href="/portfolio"
      badge={
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-400">
          SEPARATE BOOKS
        </span>
      }
      meta={
        <div className="flex items-center gap-3">
          <span>{allPositions.length} TOTAL LEGS</span>
          <span className="text-zinc-600">|</span>
          <span className={`font-bold tabular-nums ${dirClass(portfolioTotals?.unrealizedPnl)}`}>
            OPEN: {fmtSignedINR(portfolioTotals?.unrealizedPnl)}
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-3.5">
        {/* Controls Bar: Broker Selector Tabs + Search Box */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setActiveTab('all')}
              className={`rounded-lg px-3 py-1.5 font-mono text-xs font-bold transition-colors ${
                activeTab === 'all'
                  ? 'border border-amber-500/40 bg-amber-500/15 text-amber-400'
                  : 'border border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              ALL BROKERS ({allPositions.length})
            </button>

            {BROKER_ORDER.map(key => {
              const b = brokers.find(item => item.broker === key);
              const count = b?.positions.length ?? 0;
              const isSelected = activeTab === key;

              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-xs font-bold transition-colors ${
                    isSelected
                      ? 'border border-amber-500/40 bg-amber-500/15 text-amber-400'
                      : 'border border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <CircleDot
                    className={`h-2.5 w-2.5 ${b?.connected ? 'text-emerald-400' : 'text-zinc-600'}`}
                  />
                  <span>{BROKER_LABELS[key].toUpperCase()}</span>
                  <span className="rounded bg-zinc-800 px-1 py-0.2 text-[10px] text-zinc-300">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative min-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder="Search strike, CE/PE, symbol…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-1.5 pl-8 pr-3 font-mono text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500/50 focus:outline-none"
            />
          </div>
        </div>

        {/* Tab 1: All Brokers View (Dedicated Separate Section for each Broker) */}
        {activeTab === 'all' && (
          <div className="flex flex-col gap-6">
            {BROKER_ORDER.map(brokerKey => {
              const brokerData = brokers.find(b => b.broker === brokerKey);
              const brokerPositions = (brokerData?.positions ?? []).filter(p =>
                searchQuery
                  ? p.tradingSymbol.toUpperCase().includes(searchQuery.trim().toUpperCase())
                  : true
              );

              return (
                <div
                  key={brokerKey}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/80 overflow-hidden shadow-sm"
                >
                  {/* Broker Section Header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-6 w-6 items-center justify-center rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 font-bold font-mono text-xs">
                        {brokerKey[0].toUpperCase()}
                      </div>
                      <div>
                        <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-100">
                          {BROKER_LABELS[brokerKey]} Book
                        </span>
                        <span className="ml-2 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.2 font-mono text-[9px] font-semibold text-zinc-400">
                          {brokerPositions.length} LEGS
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 font-mono text-xs">
                      {brokerData?.connected ? (
                        <>
                          <span className="text-zinc-400">
                            Available:{' '}
                            <strong className="text-zinc-200">
                              {fmtINRCompact(brokerData.availableBalance)}
                            </strong>
                          </span>
                          <span className="text-zinc-600">|</span>
                          <span className="text-zinc-400">
                            P&amp;L:{' '}
                            <strong className={dirClass(brokerData.totalPnl)}>
                              {fmtSignedINR(brokerData.totalPnl)}
                            </strong>
                          </span>
                        </>
                      ) : (
                        <span className="text-zinc-500">OFFLINE / NO SESSION</span>
                      )}

                      <Link
                        href={`/scalper?broker=${brokerKey}`}
                        className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold text-amber-400 hover:bg-amber-500/20"
                      >
                        OPEN SCALPER
                      </Link>
                    </div>
                  </div>

                  {/* Broker Positions Table */}
                  <BrokerPositionsTable
                    broker={brokerKey}
                    positions={brokerPositions}
                    brokerSummary={brokerData}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Tab 2, 3, 4: Individual Broker Focused View */}
        {activeTab !== 'all' && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 overflow-hidden shadow-sm">
            {(() => {
              const brokerData = brokers.find(b => b.broker === activeTab);
              const brokerPositions = (brokerData?.positions ?? []).filter(p =>
                searchQuery
                  ? p.tradingSymbol.toUpperCase().includes(searchQuery.trim().toUpperCase())
                  : true
              );

              return (
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold uppercase tracking-wider text-amber-400">
                        {BROKER_LABELS[activeTab]} Dedicated Book
                      </span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.2 font-mono text-[9px] font-bold text-zinc-400">
                        {brokerPositions.length} LEGS
                      </span>
                    </div>

                    <div className="flex items-center gap-3 font-mono text-xs">
                      <span className="text-zinc-400">
                        Net P&amp;L:{' '}
                        <strong className={dirClass(brokerData?.totalPnl)}>
                          {fmtSignedINR(brokerData?.totalPnl)}
                        </strong>
                      </span>
                      <Link
                        href={`/scalper?broker=${activeTab}`}
                        className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold text-amber-400 hover:bg-amber-500/20"
                      >
                        LAUNCH ORDER TICKET →
                      </Link>
                    </div>
                  </div>

                  <BrokerPositionsTable
                    broker={activeTab}
                    positions={brokerPositions}
                    brokerSummary={brokerData}
                  />
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </TerminalPanel>
  );
}

// ─── Main Terminal Page ───────────────────────────────────────────────────────

export default function MarketDashboard() {
  const [indices, setIndices] = useState<TopIndicesResponse | null>(null);
  const [movers, setMovers] = useState<MoversResponse | null>(null);
  const [moversIndex, setMoversIndex] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [moversLoading, setMoversLoading] = useState(true);
  const [moversSyncing, setMoversSyncing] = useState(false);
  const [breadth, setBreadth] = useState<DashboardBreadthResponse | null>(null);
  const [breadthLoading, setBreadthLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<DashboardPortfolioResponse | null>(null);
  const [holdingsValue, setHoldingsValue] = useState<number | null>(null);
  const [strategies, setStrategies] = useState<StrategiesResponse | null>(null);
  const [clock, setClock] = useState('');
  const [marketSession, setMarketSession] = useState(getMarketSessionInfo());

  // Real-time IST Clock & Market Status
  useEffect(() => {
    const tick = () => {
      setClock(
        new Date().toLocaleTimeString('en-IN', {
          hour12: false,
          timeZone: 'Asia/Kolkata',
        })
      );
      setMarketSession(getMarketSessionInfo());
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Pollers with standard monotonic guard (dhan-polling-guards skill)
  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/scalper/top-indices');
        const json = (await res.json()) as TopIndicesResponse;
        if (stopped || mine !== seq) return;
        if (json?.success) setIndices(json);
      } catch {}
    }
    load();
    const id = setInterval(load, INDEX_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const fetchMovers = useCallback(async (bust = false) => {
    if (bust) setMoversSyncing(true);
    else setMoversLoading(true);
    try {
      const url = bust ? `/api/movers?index=${moversIndex}&bust` : `/api/movers?index=${moversIndex}`;
      const res = await fetch(url);
      const json = (await res.json()) as { success: boolean; data: MoversResponse };
      if (json?.success && json.data) setMovers(json.data);
    } catch {} finally {
      setMoversLoading(false);
      setMoversSyncing(false);
    }
  }, [moversIndex]);

  useEffect(() => {
    fetchMovers(false);
    const id = setInterval(() => fetchMovers(false), MOVERS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchMovers]);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/dashboard/breadth');
        const json = (await res.json()) as DashboardBreadthResponse;
        if (stopped || mine !== seq) return;
        setBreadth(json);
      } catch {} finally {
        if (!stopped) setBreadthLoading(false);
      }
    }
    load();
    const id = setInterval(load, BREADTH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/dashboard/portfolio');
        const json = (await res.json()) as DashboardPortfolioResponse;
        if (stopped || mine !== seq) return;
        if (json?.success) setPortfolio(json);
      } catch {}
    }
    load();
    const id = setInterval(load, PORTFOLIO_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/strategies');
        const json = (await res.json()) as StrategiesResponse;
        if (stopped || mine !== seq) return;
        if (json?.success) setStrategies(json);
      } catch {}
    }
    load();
    const id = setInterval(load, STRATEGIES_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/portfolio-holdings');
        const json = (await res.json()) as {
          success?: boolean;
          summary?: { totalCurrentValue?: number };
        };
        if (stopped || mine !== seq) return;
        if (json?.success && Number.isFinite(Number(json.summary?.totalCurrentValue))) {
          setHoldingsValue(Number(json.summary!.totalCurrentValue));
        }
      } catch {}
    }
    load();
    const id = setInterval(load, HOLDINGS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const gainers = (movers?.gainers ?? []).slice(0, TOP_N_MOVERS);
  const losers = (movers?.losers ?? []).slice(0, TOP_N_MOVERS);

  const brokers = BROKER_ORDER.map(
    key => portfolio?.brokers.find(b => b.broker === key) ?? null
  ).filter((b): b is BrokerPortfolio => b !== null);

  const totals = portfolio?.totals;
  const portfolioValue =
    totals ? totals.totalBalance + (holdingsValue ?? 0) : null;

  const connectedCount = brokers.filter(b => b.connected && !b.error).length;
  const dataDate = movers?.dataDate ?? '—';

  // Overall margin utilization percentage
  const totalMarginUtilPercent =
    totals && totals.totalBalance > 0
      ? (totals.utilizedMargin / totals.totalBalance) * 100
      : 0;

  // Collateral combined across brokers
  const totalCollateral = brokers.reduce((acc, b) => acc + (b.collateralAmount ?? 0), 0);

  // VIX and Nifty spot for Options Volatility Regime
  const vixLtp = indices?.quotes?.['VIX']?.ltp;
  const niftyLtp = indices?.quotes?.['NIFTY']?.ltp;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      {/* ─── Top Bloomberg Function Key Command Ribbon ─────────────────────────── */}
      <div className="hidden border-b border-zinc-800 bg-zinc-950 px-6 py-1.5 md:block">
        <div className="flex items-center justify-between gap-2 overflow-x-auto text-[10px] font-mono">
          <div className="flex items-center gap-2">
            <span className="text-amber-500 font-bold uppercase tracking-wider">TERMINAL COMMANDS:</span>
            {FUNCTION_KEYS.map(fk => (
              <Link
                key={fk.key}
                href={fk.href}
                className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 text-zinc-300 transition-colors hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-400"
              >
                <span className="text-amber-400 font-bold">{fk.key}</span>
                <span>{fk.label}</span>
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-2 text-zinc-500">
            <span>DHAN ALGO QUANT DESK</span>
            <span className="text-zinc-700">|</span>
            <span className="text-amber-400 font-semibold">{connectedCount} OF 3 BROKERS LIVE</span>
          </div>
        </div>
      </div>

      {/* ─── Sticky Bloomberg Header ─────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/20 bg-zinc-950/95 px-6 py-3 backdrop-blur shadow-md">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 shadow-inner">
            <LayoutDashboard className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">
                BLOOMBERG TERMINAL · PRO DUAL FEED
              </span>
              <span className="text-[10px] text-zinc-600">/</span>
              <span className="font-mono text-[9px] text-zinc-400">DESK v2.6</span>
            </div>
            <h1 className="text-base font-bold leading-none tracking-tight text-white">
              Institutional Market Dashboard
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Market Session Status */}
          <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-semibold">
            <span
              className={`h-2 w-2 rounded-full ${
                marketSession.tone === 'live'
                  ? 'bg-emerald-400 animate-pulse'
                  : marketSession.tone === 'accent'
                  ? 'bg-amber-400'
                  : 'bg-zinc-500'
              }`}
            />
            <span className={marketSession.tone === 'live' ? 'text-emerald-400' : 'text-zinc-300'}>
              {marketSession.label}
            </span>
          </div>

          {/* Data Date Chip */}
          <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-semibold text-zinc-400">
            DATA: {dataDate}
          </span>

          {/* Live IST Clock */}
          <span className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-bold text-amber-400 shadow-sm">
            <Clock className="h-3 w-3 text-amber-400" />
            {clock || '--:--:--'} IST
          </span>
        </div>
      </div>

      {/* ─── Main Content Canvas ─────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-4 px-6 py-5">
        {/* 1. Real-time Ticker Ribbon */}
        <IndexStrip data={indices} />

        {/* 2. Portfolio Balance Sheet & Institutional Tiles */}
        <TerminalPanel
          title="Consolidated Portfolio Balance Sheet"
          icon={Briefcase}
          href="/portfolio"
          badge={
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-400">
              MULTI-BROKER
            </span>
          }
          meta={
            portfolio?.updatedAt
              ? 'SYNCED: ' +
                new Date(portfolio.updatedAt).toLocaleTimeString('en-IN', {
                  hour12: false,
                  timeZone: 'Asia/Kolkata',
                }) +
                ' IST'
              : undefined
          }
        >
          <div className="flex flex-col gap-4 p-3.5">
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <StatTile
                label="Total Portfolio Value"
                value={fmtINRCompact(portfolioValue)}
                sub={holdingsValue !== null ? `incl. ${fmtINRCompact(holdingsValue)} delivery` : 'margin base'}
                tone="accent"
              />
              <StatTile
                label="Available Capital"
                value={fmtINRCompact(totals?.availableBalance)}
                sub="free spendable buffer"
              />
              <StatTile
                label="Margin Utilized"
                value={fmtINRCompact(totals?.utilizedMargin)}
                sub={`${totalMarginUtilPercent.toFixed(1)}% of total margin base`}
                progress={{
                  percent: totalMarginUtilPercent,
                  colorClass: totalMarginUtilPercent > 80 ? 'bg-red-500' : 'bg-amber-400',
                }}
              />
              <StatTile
                label="Collateral Base"
                value={fmtINRCompact(totalCollateral)}
                sub="pledged backing option writes"
              />
              <StatTile
                label="Open Unrealized P&L"
                value={fmtSignedINR(totals?.unrealizedPnl)}
                sub={
                  totals && totals.unpricedPositions > 0
                    ? `${totals.openPositions} legs · ${totals.unpricedPositions} unpriced`
                    : `${totals?.openPositions ?? 0} active legs`
                }
                tone={(totals?.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}
              />
              <StatTile
                label="Net Day P&L"
                value={fmtSignedINR(totals?.totalPnl)}
                sub={`realized ${fmtSignedINR(totals?.realizedPnl)}`}
                tone={(totals?.totalPnl ?? 0) >= 0 ? 'up' : 'down'}
              />
            </div>

            {/* Broker Accounts Grid */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between border-t border-zinc-800 pt-3">
                <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">
                  CONNECTED BROKER CAPITALS &amp; MARGIN RATIOS
                </span>
                <span className="font-mono text-[10px] text-zinc-500">
                  {connectedCount} of 3 brokers connected
                </span>
              </div>

              {brokers.length === 0 ? (
                <EmptyRow>Loading broker account balances…</EmptyRow>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {brokers.map(b => (
                    <BrokerAccountCard
                      key={b.broker}
                      b={b}
                      holdingsValue={b.broker === 'dhan' ? holdingsValue : null}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </TerminalPanel>

        {/* 3. Algorithmic Trading Bots Execution Desk */}
        <AlgoStrategiesDesk data={strategies} />

        {/* 4. Options Volatility & Market Regime Intelligence */}
        <OptionsVolatilityIntelligence niftyLtp={niftyLtp} vixLtp={vixLtp} />

        {/* 5. Market Breadth Visualizer */}
        <BreadthPanel data={breadth} loading={breadthLoading} />

        {/* 6. Market Movers: Top Gainers & Top Losers */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-amber-400">
                MARKET MOVERS
              </span>
              <span className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-[10px] font-bold text-zinc-300">
                {moversIndex === 'nifty50' ? 'NIFTY 50' : 'NIFTY 500'}
              </span>
              {movers?.dataDate && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                  DATA: {movers.dataDate}
                </span>
              )}
              <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                {marketSession.isWeekend ? 'WEEKEND (EOD CLOSE)' : movers?.liveQuotesMeta ? `LIVE INTRADAY (${movers.liveQuotesMeta.count} QUOTES)` : 'EOD CLOSE'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* Segmented index toggle */}
              <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-0.5 font-mono text-xs">
                <button
                  type="button"
                  onClick={() => setMoversIndex('nifty50')}
                  className={`rounded px-3 py-1 text-[11px] font-bold transition-colors ${
                    moversIndex === 'nifty50'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                  }`}
                >
                  NIFTY 50
                </button>
                <button
                  type="button"
                  onClick={() => setMoversIndex('nifty500')}
                  className={`rounded px-3 py-1 text-[11px] font-bold transition-colors ${
                    moversIndex === 'nifty500'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                  }`}
                >
                  NIFTY 500
                </button>
              </div>

              {/* Sync / Refresh Button */}
              <button
                type="button"
                onClick={() => fetchMovers(true)}
                disabled={moversLoading || moversSyncing}
                className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1 font-mono text-[11px] font-semibold text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-400 transition-colors disabled:opacity-50"
                title="Force refresh movers from underlying data"
              >
                <RefreshCw className={`h-3 w-3 ${moversSyncing || moversLoading ? 'animate-spin text-emerald-400' : 'text-zinc-400'}`} />
                <span>{moversSyncing ? 'SYNCING...' : 'SYNC'}</span>
              </button>

              <Link
                href="/movers"
                className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1 font-mono text-[11px] font-bold text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
                title="Open Advanced Market Movers Screener & Analytics"
              >
                <span>SCREENER</span>
                <ChevronRight className="h-3 w-3 text-zinc-400" />
              </Link>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <TerminalPanel
              title={`Top Gainers (${moversIndex === 'nifty50' ? 'Nifty 50' : 'Nifty 500'})`}
              icon={TrendingUp}
              href="/movers"
              badge={
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-400">
                  MOMENTUM
                </span>
              }
              meta={movers?.dataDate ? `SESSION: ${movers.dataDate}` : 'EOD'}
            >
              <MoverTable rows={gainers} direction="up" loading={moversLoading} />
            </TerminalPanel>

            <TerminalPanel
              title={`Top Losers (${moversIndex === 'nifty50' ? 'Nifty 50' : 'Nifty 500'})`}
              icon={TrendingDown}
              href="/movers"
              badge={
                <span className="rounded bg-red-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-red-400">
                  PULLBACK
                </span>
              }
              meta={movers?.dataDate ? `SESSION: ${movers.dataDate}` : 'EOD'}
            >
              <MoverTable rows={losers} direction="down" loading={moversLoading} />
            </TerminalPanel>
          </div>
        </div>

        {/* 7. Separated Open Positions Section (Dedicated Per Broker) */}
        <SeparatedPositionsSection brokers={brokers} portfolioTotals={totals} />

        {/* ─── Terminal Footer Telemetry ───────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800/80 pt-3 font-mono text-[10px] text-zinc-500">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-amber-400" />
            <span>POLLING INTERVALS:</span>
            <span>Indices {INDEX_POLL_MS / 1000}s</span>
            <span className="text-zinc-700">·</span>
            <span>Portfolio {PORTFOLIO_POLL_MS / 1000}s</span>
            <span className="text-zinc-700">·</span>
            <span>Algos {STRATEGIES_POLL_MS / 1000}s</span>
            <span className="text-zinc-700">·</span>
            <span>Breadth {BREADTH_POLL_MS / 1000}s</span>
            <span className="text-zinc-700">·</span>
            <span>Movers {MOVERS_POLL_MS / 1000}s</span>
          </div>

          <div className="flex items-center gap-2 text-zinc-500">
            <Wallet className="h-3.5 w-3.5 text-zinc-400" />
            <span>Holdings sync cadence: {HOLDINGS_POLL_MS / 60000}m</span>
          </div>
        </div>
      </div>
    </div>
  );
}
