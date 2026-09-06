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

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Banknote,
  CircleDot,
  Clock,
  ExternalLink,
  Gauge,
  Layers,
  PieChart,
  RefreshCw,
  Shield,
  ShieldAlert,
  Sparkles,
  Target,
  Wallet,
} from 'lucide-react';
import type { BrokerPortfolio, DashboardPortfolioResponse } from '@/app/api/dashboard/portfolio/route';
import type { MarginAllocatorResponse, PositionGroup } from '@/app/api/margin-allocator/route';
import type { ScanResponse, ScannedStrategy, StrategyType, UnderlyingType } from '@/lib/ultimateScannerTypes';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import NavBar from './NavBar';

// ─── Poll cadences (dhan-polling-guards skill) ────────────────────────────────
const PORTFOLIO_POLL_MS = 8_000;
const ALLOCATOR_POLL_MS = 15_000;
const BROKER_ORDER: Broker[] = ['dhan', 'zerodha', 'kotak'];
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

interface RankedCandidate {
  key: string;
  source: 'condor' | 'strangle_straddle' | 'csp';
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
}

interface AllocatedCandidate extends RankedCandidate {
  units: number;
  marginUsed: number;
  creditExpected: number;
}

function fromScannedStrategy(s: ScannedStrategy): RankedCandidate {
  const legsSummary = s.legs.map((l) => `${l.side === 'SELL' ? '-' : '+'}${l.strike}${l.option}`).join(' / ');
  return {
    key: s.id,
    source: s.type === 'iron_condor' ? 'condor' : 'strangle_straddle',
    label: `${s.underlying} ${s.name}`,
    underlying: s.underlying,
    expiry: s.expiry,
    dte: s.dte,
    marginPerUnit: s.estMargin,
    creditPerUnit: s.netPremium,
    popPct: s.popPct,
    romAnnualizedPct: s.romAnnualizedPct,
    score: s.score,
    riskType: s.maxLossUnlimited ? 'undefined' : 'defined',
    detail: legsSummary,
  };
}

function fromCspRow(r: CspRow): RankedCandidate {
  return {
    key: `csp-${r.symbol}-${r.strike}-${r.expiry}`,
    source: 'csp',
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
  };
}

/**
 * Greedy two-pass allocator for ONE risk category's own sub-budget (see call
 * site: the deployable balance is sliced into a defined-risk / undefined-risk
 * / assignment-risk share before this ever runs, so the category-level "don't
 * put it all in naked strangles" discipline lives there, not here).
 *
 * Within a category: diversify first (one unit of every candidate the budget
 * can fit, best score first), then spend leftover budget scaling the winners.
 * `maxPerUnderlyingFraction` additionally stops one underlying's cluster of
 * near-identical strike variants (a scan naturally returns many) from eating
 * the whole category — a real allocator diversifies across underlyings too,
 * not just across strikes of the same trade.
 */
function buildAllocationPlan(
  candidates: RankedCandidate[],
  budget: number,
  maxPerUnderlyingFraction = 0.6,
): { plan: AllocatedCandidate[]; used: number } {
  const sorted = [...candidates].filter((c) => c.marginPerUnit > 0).sort((a, b) => b.score - a.score);
  const underlyingCap = budget * maxPerUnderlyingFraction;
  const usedByUnderlying = new Map<string, number>();
  let used = 0;
  const plan: AllocatedCandidate[] = [];

  const tryFit = (marginPerUnit: number, underlying: string) => {
    const u = usedByUnderlying.get(underlying) ?? 0;
    if (u + marginPerUnit > underlyingCap) return false;
    if (used + marginPerUnit > budget) return false;
    used += marginPerUnit;
    usedByUnderlying.set(underlying, u + marginPerUnit);
    return true;
  };

  for (const c of sorted) {
    if (!tryFit(c.marginPerUnit, c.underlying)) continue;
    plan.push({ ...c, units: 1, marginUsed: c.marginPerUnit, creditExpected: c.creditPerUnit });
  }

  // Second pass: scale up already-selected winners with leftover budget.
  for (const item of plan) {
    if (budget - used < budget * 0.03) break;
    if (!tryFit(item.marginPerUnit, item.underlying)) continue;
    item.units += 1;
    item.marginUsed += item.marginPerUnit;
    item.creditExpected += item.creditPerUnit;
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
          <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-amber-400">{BROKER_LABELS[b.broker]}</span>
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
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-amber-400">{BROKER_LABELS[g.broker]}</span>
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
  const [clock, setClock] = useState('');

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const loadPortfolio = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/portfolio');
      const json = await res.json();
      if (json?.success) setPortfolio(json);
    } catch { /* transient — next poll retries */ }
  }, []);

  const loadAllocator = useCallback(async () => {
    try {
      const res = await fetch('/api/margin-allocator');
      const json = await res.json();
      if (json?.success) setAllocator(json);
    } catch { /* transient — next poll retries */ }
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
          strategyTypes: ['iron_condor', 'short_strangle', 'short_straddle'] as StrategyType[],
          maxResults: 50,
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
  const deployableBudget = dhanFunds ? Math.max(0, dhanFunds.availableBalance * preset.fraction) : 0;

  const allScanCandidates = useMemo(
    () => Object.values(scans).flatMap((s) => s?.candidates ?? []),
    [scans],
  );
  const vixInfo = useMemo(() => Object.values(scans).find((s) => s?.vix)?.vix ?? null, [scans]);

  const condorCandidatesAll = useMemo(
    () => allScanCandidates
      .filter((c) => c.type === 'iron_condor' && c.dte >= MIN_DTE_FOR_YIELD && c.dte <= MAX_DTE_FOR_YIELD)
      .map(fromScannedStrategy),
    [allScanCandidates],
  );
  const strangleCandidatesAll = useMemo(
    () => allScanCandidates
      .filter((c) => (c.type === 'short_strangle' || c.type === 'short_straddle') && c.dte >= MIN_DTE_FOR_YIELD && c.dte <= MAX_DTE_FOR_YIELD)
      .map(fromScannedStrategy),
    [allScanCandidates],
  );
  const cspCandidatesAll = useMemo(
    // csp_scanner.py already floors at MIN_DTE=5 server-side; the upper bound still applies here.
    () => cspRows.filter((r) => r.dte <= MAX_DTE_FOR_YIELD).map(fromCspRow),
    [cspRows],
  );

  const matchesFilter = useCallback((c: RankedCandidate) => displayFilter === 'ALL' || c.underlying === displayFilter, [displayFilter]);
  const condorCandidates = useMemo(() => condorCandidatesAll.filter(matchesFilter), [condorCandidatesAll, matchesFilter]);
  const strangleCandidates = useMemo(() => strangleCandidatesAll.filter(matchesFilter), [strangleCandidatesAll, matchesFilter]);

  // Deployable budget splits into three risk-category sub-budgets BEFORE
  // allocation — this is what actually enforces "don't put it all in one
  // trade class," not a cap applied after the fact inside one merged pool.
  const strangleBudget = deployableBudget * preset.undefinedCap;
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
  const condorPlan = useMemo(() => buildAllocationPlan(condorCandidates, condorBudget, perUnderlyingCap), [condorCandidates, condorBudget, perUnderlyingCap]);
  const stranglePlan = useMemo(() => buildAllocationPlan(strangleCandidates, strangleBudget, perUnderlyingCap), [strangleCandidates, strangleBudget, perUnderlyingCap]);
  const cspPlan = useMemo(() => buildAllocationPlan(cspCandidatesAll, cspBudget), [cspCandidatesAll, cspBudget]);

  const allocationPlan = useMemo(
    () => [...condorPlan.plan, ...stranglePlan.plan, ...cspPlan.plan].sort((a, b) => b.marginUsed - a.marginUsed),
    [condorPlan, stranglePlan, cspPlan],
  );
  const allocationUsed = condorPlan.used + stranglePlan.used + cspPlan.used;
  const usedUndefined = stranglePlan.used;

  const totalCreditExpected = allocationPlan.reduce((a, p) => a + p.creditExpected, 0);
  const utilizationOfDeployable = deployableBudget > 0 ? (allocationUsed / deployableBudget) * 100 : 0;

  const dataDate = new Date().toISOString().split('T')[0];

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
              <span className="font-mono text-[9px] text-zinc-400">MULTI-BROKER MARGIN</span>
            </div>
            <h1 className="text-base font-bold leading-none tracking-tight text-white">Margin Allocator</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-semibold text-zinc-400">
            DATA: {dataDate}
          </span>
          <span className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-bold text-amber-400 shadow-sm">
            <Clock className="h-3 w-3 text-amber-400" />
            {clock || '--:--:--'} IST
          </span>
          <button
            type="button"
            onClick={() => { loadPortfolio(); loadAllocator(); runAllScans(); loadCsp(); }}
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-bold text-zinc-300 hover:border-zinc-700"
          >
            <RefreshCw className={`h-3 w-3 ${scanLoading ? 'animate-spin text-amber-400' : ''}`} />
            REFRESH
          </button>
          <div className="flex items-center pl-1 border-l border-zinc-800">
            <NavBar />
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-6 py-5">
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Dhan Idle Margin" value={fmtINRCompact(dhanFunds?.availableBalance ?? null)} tone="up" />
              <StatTile
                label="Deployable Budget"
                value={fmtINRCompact(deployableBudget)}
                tone="accent"
                sub={`${(preset.fraction * 100).toFixed(0)}% of idle margin · ${preset.label}`}
              />
              <StatTile
                label="Recommended Plan Uses"
                value={fmtINRCompact(allocationUsed)}
                progress={{ percent: utilizationOfDeployable, colorClass: 'bg-emerald-500' }}
                tone="neutral"
              />
              <StatTile label="Expected Credit (Plan)" value={fmtINRCompact(totalCreditExpected)} tone="up" sub={`${allocationPlan.length} setup${allocationPlan.length === 1 ? '' : 's'}`} />
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
            <p className="font-mono text-[10px] text-zinc-500">
              A buffer is deliberately left un-deployed ({(100 - preset.fraction * 100).toFixed(0)}% of idle margin) and
              undefined-risk (naked straddle/strangle) exposure is capped at {(preset.undefinedCap * 100).toFixed(0)}% of the
              deployable budget — no single-trade or single-risk-class concentration, regardless of how attractive one setup scores.
            </p>
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
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">PoP</th>
                    <th className="px-3 py-2 text-xs font-bold text-white text-right">Ann. RoM</th>
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
                      <td className="px-3 py-2 text-right tabular-nums text-amber-400">{fmtINRCompact(p.marginUsed)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{fmtINRCompact(p.creditExpected)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPct(p.popPct)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-400">{fmtPct(p.romAnnualizedPct)}</td>
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
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="flex items-start gap-2 border-t border-zinc-800 px-3.5 py-2.5 font-mono text-[10px] text-zinc-500">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>
              No option-selling strategy is risk-free. &quot;Iron Condor&quot; rows are defined-risk (loss capped at the wing width);
              &quot;Short Strangle/Straddle&quot; rows are undefined-risk (loss theoretically unbounded on a large adverse move) and are
              exactly what CLAUDE.md&apos;s straddle/strangle inversion guard and the 15:17 IST auto-exit exist to contain if run live;
              &quot;CSP&quot; rows carry assignment risk (you may be required to buy the stock at the strike). PoP and Ann. RoM are model
              estimates from live IV/OI, not guarantees.
            </span>
          </div>
        </TerminalPanel>

        {/* ─── 5. Opportunity feeds ─────────────────────────────────────────── */}
        <TerminalPanel
          title="Defined-Risk: Iron Condors"
          icon={Shield}
          href="/ultimate-scanner"
          meta={
            <div className="flex items-center gap-2">
              <UnderlyingFilterToggle value={displayFilter} onChange={setDisplayFilter} />
              {vixInfo ? <span className="text-zinc-500">VIX {vixInfo.vix.toFixed(2)} · {vixInfo.regime}</span> : null}
            </div>
          }
        >
          <OpportunityTable
            rows={condorCandidates.slice(0, 12)}
            emptyLabel={scanLoading ? 'Scanning chain…' : `No Iron Condor setup within ${MIN_DTE_FOR_YIELD}-${MAX_DTE_FOR_YIELD} days met the filters.`}
          />
        </TerminalPanel>

        <TerminalPanel title="Undefined-Risk: Short Strangles / Straddles" icon={Sparkles} href="/ultimate-scanner">
          <OpportunityTable
            rows={strangleCandidates.slice(0, 12)}
            emptyLabel={scanLoading ? 'Scanning chain…' : `No Short Strangle/Straddle setup within ${MIN_DTE_FOR_YIELD}-${MAX_DTE_FOR_YIELD} days met the filters.`}
          />
        </TerminalPanel>

        <TerminalPanel
          title="Assignment-Risk: Cash-Secured Puts"
          icon={Banknote}
          href="/csp-screener"
          meta={
            <div className="flex items-center gap-2">
              {cspScannedAt ? <span>Last scan {new Date(cspScannedAt).toLocaleString('en-IN', { hour12: false })}</span> : <span>No scan yet</span>}
              <button
                type="button"
                onClick={runCspScan}
                disabled={cspScanning}
                className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-400 hover:bg-amber-500/20 disabled:opacity-50"
              >
                {cspScanning ? 'SCANNING…' : 'RUN FRESH SCAN'}
              </button>
            </div>
          }
        >
          <OpportunityTable
            rows={cspCandidatesAll.slice(0, 12)}
            emptyLabel={cspScanning ? 'Scan running (~10 min sweep)…' : `No cached CSP candidate within ${MAX_DTE_FOR_YIELD} days — run a fresh scan.`}
          />
        </TerminalPanel>
      </div>
    </div>
  );
}
