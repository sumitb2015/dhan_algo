'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  TrendingUp, TrendingDown, RefreshCw, Briefcase, Info,
  Activity, ArrowUp, ArrowDown, Minus, ShieldAlert,
  ChevronUp, ChevronDown, ChevronsUpDown, AlertTriangle,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { getSector, SECTOR_COLORS } from '@/lib/sectors';
import NavBar from './NavBar';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Holding {
  symbol: string;
  isin: string;
  exchange: string;
  totalQty: number;
  dpQty: number;
  t1Qty: number;
  avgCostPrice: number;
  lastTradedPrice: number;
  investedValue: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  assetType: 'EQUITY' | 'ETF';
}

interface Position {
  symbol: string;
  positionType: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastPrice: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

interface Order {
  orderId: string;
  symbol: string;
  exchange: string;
  orderType: string;
  transactionType: string;
  productType: string;
  quantity: number;
  filledQty: number;
  price: number;
  triggerPrice: number;
  tradedPrice: number;
  status: string;
  validity: string;
  createTime: string;
  updateTime: string;
  remarks: string;
}

interface Trade {
  orderId: string;
  symbol: string;
  exchange: string;
  transactionType: string;
  productType: string;
  tradedQuantity: number;
  tradedPrice: number;
  tradeId: string;
  createTime: string;
  exchangeTime: string;
}

interface PortfolioData {
  success: boolean;
  available_funds: number;
  holdings: Holding[];
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  summary: {
    holdingsCount: number;
    positionsCount: number;
    ordersCount: number;
    tradesCount: number;
    totalInvested: number;
    totalCurrentValue: number;
    totalPnl: number;
    totalPnlPct: number;
    realizedPnl: number;
    unrealizedPnl: number;
  };
  error?: string;
}

interface MutualFund {
  name: string;
  amc: string;
  category: string;
  units: number;
  nav: number;
  investedValue: number;
}

interface RSInfo {
  rating: 'A' | 'B' | 'C' | 'D';
  momentum: 'rising' | 'falling' | 'neutral';
  score: number;
}

interface PerformancePoint {
  date: string;
  totalCurrentValue: number;
  equityValue: number;
  etfValue: number;
  synthetic: boolean;
}

interface RiskSummary {
  available: boolean;
  generatedAt?: string;
  totalPortfolioValue?: number;
  beta?: number;
  sharpe?: number;
  sortino?: number;
  maxDrawdown?: number;
  annualizedVolatility?: number;
  var95Pct?: number;
}

interface MAInfo {
  aboveMa20: boolean;
  aboveMa50: boolean;
  aboveMa200: boolean;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtINR(n: number, compact = false): string {
  if (compact) {
    if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
    if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
    if (Math.abs(n) >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  }
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function PnlText({ v, compact }: { v: number; compact?: boolean }) {
  return (
    <span className={cn('tabular-nums font-semibold', v >= 0 ? 'text-emerald-400' : 'text-red-400')}>
      {v >= 0 ? '+' : ''}{fmtINR(v, compact)}
    </span>
  );
}

function PctBadge({ v }: { v: number }) {
  return (
    <span className={cn(
      'inline-flex items-center px-1.5 py-px rounded text-[11px] font-semibold tabular-nums',
      v > 0 ? 'bg-emerald-500/10 text-emerald-400' : v < 0 ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500',
    )}>
      {fmtPct(v)}
    </span>
  );
}

// ─── Feature 1: RS Badge ──────────────────────────────────────────────────────

const RS_GRADE_STYLES: Record<string, string> = {
  A: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  B: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  C: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  D: 'bg-red-500/15 text-red-400 border-red-500/30',
};

function RSBadge({ info }: { info: RSInfo | undefined }) {
  if (!info) return <span className="text-zinc-700 text-[10px]">—</span>;
  return (
    <div className="inline-flex items-center gap-0.5">
      <span className={cn(
        'text-[10px] font-bold px-1 py-px rounded border leading-none',
        RS_GRADE_STYLES[info.rating] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700',
      )}>
        {info.rating}
      </span>
      {info.momentum === 'rising'
        ? <ArrowUp className="h-2.5 w-2.5 text-emerald-400" />
        : info.momentum === 'falling'
          ? <ArrowDown className="h-2.5 w-2.5 text-red-400" />
          : <Minus className="h-2.5 w-2.5 text-zinc-600" />}
    </div>
  );
}

// ─── Feature 2: MA Dots ───────────────────────────────────────────────────────

function MADots({ info }: { info: MAInfo | undefined }) {
  if (!info) return <span className="text-zinc-700 text-[10px]">—</span>;
  return (
    <div className="inline-flex items-center gap-1" title={`MA20: ${info.aboveMa20 ? '✓' : '✗'}  MA50: ${info.aboveMa50 ? '✓' : '✗'}  MA200: ${info.aboveMa200 ? '✓' : '✗'}`}>
      <span className={cn('w-1.5 h-1.5 rounded-full', info.aboveMa20 ? 'bg-emerald-400' : 'bg-red-500')} />
      <span className={cn('w-1.5 h-1.5 rounded-full', info.aboveMa50 ? 'bg-emerald-400' : 'bg-red-500')} />
      <span className={cn('w-1.5 h-1.5 rounded-full', info.aboveMa200 ? 'bg-emerald-400' : 'bg-red-500')} />
    </div>
  );
}

// ─── Table helpers ────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc';

function TH({
  children, right, sortKey, sortBy, sortDir, onSort, className,
}: {
  children: React.ReactNode;
  right?: boolean;
  sortKey?: string;
  sortBy?: string;
  sortDir?: SortDir;
  onSort?: (k: string) => void;
  className?: string;
}) {
  const active = sortKey === sortBy;
  return (
    <th
      style={{ color: '#ffffff' }}
      className={cn(
        'py-2 px-2 text-xs font-bold uppercase tracking-wide whitespace-nowrap',
        right ? 'text-right' : 'text-left',
        sortKey ? 'cursor-pointer select-none' : '',
        className,
      )}
      onClick={() => sortKey && onSort?.(sortKey)}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        {sortKey && (
          active
            ? (sortDir === 'desc' ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />)
            : <ChevronsUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn('py-[5px] px-2 text-[12px] text-zinc-200', right ? 'text-right' : 'text-left', className)}>
      {children}
    </td>
  );
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-4 py-3">
      <span className="text-[10px] text-zinc-400 uppercase tracking-wide font-medium">{label}</span>
      <span className={cn(
        'text-lg font-bold tabular-nums leading-tight',
        positive === true ? 'text-emerald-400' : positive === false ? 'text-red-400' : 'text-white',
      )}>
        {value}
      </span>
      {sub && <span className="text-[11px] text-zinc-500">{sub}</span>}
    </div>
  );
}

// ─── Feature 3: Winners / Losers Panel ───────────────────────────────────────

function WinnersLosersPanel({
  holdings, rsMap, maMap,
}: {
  holdings: Holding[];
  rsMap: Map<string, RSInfo>;
  maMap: Map<string, MAInfo>;
}) {
  if (holdings.length === 0) return null;

  const totalValue = holdings.reduce((s, h) => s + h.currentValue, 0);
  const sorted = [...holdings].filter(h => h.investedValue > 0);
  const winners = [...sorted].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 3);
  const losers = [...sorted].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 3);

  // Feature 5: P&L distribution
  const inProfit = holdings.filter(h => h.pnl > 0);
  const inLoss = holdings.filter(h => h.pnl < 0);
  const profitValue = inProfit.reduce((s, h) => s + h.currentValue, 0);
  const lossValue = inLoss.reduce((s, h) => s + h.currentValue, 0);

  // Feature 4: Concentration risks (>10%)
  const concentrated = holdings.filter(h => totalValue > 0 && h.currentValue / totalValue > 0.10);

  // MA health
  const aboveMa50Count = holdings.filter(h => maMap.get(h.symbol)?.aboveMa50).length;
  const rsLeadersCount = holdings.filter(h => {
    const r = rsMap.get(h.symbol);
    return r?.rating === 'A' || r?.rating === 'B';
  }).length;

  function HoldingCard({ h, gain }: { h: Holding; gain: boolean }) {
    return (
      <div className={cn(
        'flex items-center justify-between gap-2 px-3 py-2 rounded-lg border',
        gain
          ? 'bg-emerald-500/5 border-emerald-500/20'
          : 'bg-red-500/5 border-red-500/20',
      )}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-bold text-white truncate">{h.symbol}</span>
          <RSBadge info={rsMap.get(h.symbol)} />
        </div>
        <div className="flex flex-col items-end shrink-0">
          <span className={cn('text-[11px] font-bold tabular-nums', gain ? 'text-emerald-400' : 'text-red-400')}>
            {fmtPct(h.pnlPct)}
          </span>
          <PnlText v={h.pnl} compact />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {/* Winners */}
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3">
        <div className="flex items-center gap-1.5 mb-2.5">
          <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
          <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">Top Gainers</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {winners.map(h => <HoldingCard key={h.symbol} h={h} gain={true} />)}
        </div>
      </div>

      {/* Losers */}
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3">
        <div className="flex items-center gap-1.5 mb-2.5">
          <TrendingDown className="h-3.5 w-3.5 text-red-400" />
          <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">Top Losers</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {losers.map(h => <HoldingCard key={h.symbol} h={h} gain={false} />)}
        </div>
      </div>

      {/* Portfolio Health */}
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3 flex flex-col gap-2.5">
        <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">Portfolio Health</span>

        {/* P&L distribution */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <div className="flex items-center justify-between text-[10px] mb-0.5">
              <span className="text-zinc-400">P&amp;L split</span>
              <span className="text-zinc-500">{inProfit.length}↑ / {inLoss.length}↓</span>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden flex">
              {(profitValue + lossValue) > 0 && (
                <>
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${profitValue / (profitValue + lossValue) * 100}%` }} />
                  <div className="h-full bg-red-500 transition-all" style={{ width: `${lossValue / (profitValue + lossValue) * 100}%` }} />
                </>
              )}
            </div>
            <div className="flex items-center justify-between text-[10px] mt-0.5">
              <span className="text-emerald-400">{fmtINR(profitValue, true)}</span>
              <span className="text-red-400">{fmtINR(lossValue, true)}</span>
            </div>
          </div>
        </div>

        {/* MA health */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-400">Above MA50</span>
          <span className={cn('font-semibold', aboveMa50Count / holdings.length > 0.6 ? 'text-emerald-400' : aboveMa50Count / holdings.length > 0.4 ? 'text-amber-400' : 'text-red-400')}>
            {aboveMa50Count}/{holdings.length}
          </span>
        </div>

        {/* RS leaders */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-400">RS Leaders (A/B)</span>
          <span className={cn('font-semibold', rsLeadersCount > 0 ? 'text-blue-400' : 'text-zinc-500')}>
            {rsLeadersCount > 0 ? `${rsLeadersCount} stocks` : rsMap.size === 0 ? 'Loading…' : 'None'}
          </span>
        </div>

        {/* Feature 4: Concentration risk */}
        {concentrated.length > 0 && (
          <div className="flex items-start gap-1.5 bg-amber-500/8 border border-amber-500/20 rounded-lg px-2 py-1.5 mt-0.5">
            <ShieldAlert className="h-3 w-3 text-amber-400 mt-0.5 shrink-0" />
            <div className="text-[10px] text-amber-300 leading-tight">
              <span className="font-semibold">{concentrated.length} concentrated</span> {concentrated.length === 1 ? 'position' : 'positions'} &gt;10%
              <span className="text-amber-500 ml-1">({concentrated.map(h => h.symbol).join(', ')})</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Holdings Table (Features 1, 2, 4) ───────────────────────────────────────

type HoldingSortKey = 'symbol' | 'totalQty' | 'avgCostPrice' | 'lastTradedPrice' | 'investedValue' | 'currentValue' | 'pnl' | 'pnlPct';

function HoldingsTable({
  holdings, filter, rsMap, maMap, totalValue,
}: {
  holdings: Holding[];
  filter: 'ALL' | 'EQUITY' | 'ETF';
  rsMap: Map<string, RSInfo>;
  maMap: Map<string, MAInfo>;
  totalValue: number;
}) {
  const [sortBy, setSortBy] = useState<HoldingSortKey>('currentValue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [search, setSearch] = useState('');

  const handleSort = (key: string) => {
    if (sortBy === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(key as HoldingSortKey); setSortDir('desc'); }
  };

  const filtered = holdings
    .filter(h => filter === 'ALL' || h.assetType === filter)
    .filter(h => !search || h.symbol.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const av = a[sortBy] as number | string;
      const bv = b[sortBy] as number | string;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
      return sortDir === 'asc' ? (av - (bv as number)) : ((bv as number) - av);
    });

  if (holdings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-zinc-600 gap-2">
        <Briefcase className="h-8 w-8" />
        <p className="text-sm">No holdings found in your Dhan account.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search symbol…"
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 w-48"
        />
        {rsMap.size > 0 && (
          <span className="text-[10px] text-zinc-400">MA dots: 20/50/200</span>
        )}
        <span className="text-[11px] text-zinc-500 ml-auto">{filtered.length} holdings</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full border-collapse">
          <thead className="bg-zinc-800 sticky top-0">
            <tr>
              <TH sortKey="symbol" sortBy={sortBy} sortDir={sortDir} onSort={handleSort}>Symbol</TH>
              <TH right className="hidden lg:table-cell">RS</TH>
              <TH right className="hidden lg:table-cell">MA</TH>
              <TH sortKey="totalQty" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} right>Qty</TH>
              <TH sortKey="avgCostPrice" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} right>Avg Cost</TH>
              <TH sortKey="lastTradedPrice" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} right className="hidden sm:table-cell">CMP</TH>
              <TH sortKey="investedValue" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} right className="hidden md:table-cell">Invested</TH>
              <TH sortKey="currentValue" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} right>Value</TH>
              <TH sortKey="pnl" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} right>P&amp;L</TH>
              <TH sortKey="pnlPct" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} right>P&amp;L %</TH>
            </tr>
          </thead>
          <tbody>
            {filtered.map(h => {
              const sector = getSector(h.symbol);
              const sectorColor = SECTOR_COLORS[sector] ?? '#71717a';
              const weight = totalValue > 0 ? h.currentValue / totalValue : 0;
              const isConcentrated = weight > 0.10;
              return (
                <tr key={h.symbol} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                  <TD>
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: sectorColor }} />
                      <div className="flex flex-col leading-none gap-0.5">
                        <div className="flex items-center gap-1">
                          <span className="font-semibold text-white">{h.symbol}</span>
                          {isConcentrated && (
                            <ShieldAlert className="h-3 w-3 text-amber-400" aria-label={`${(weight * 100).toFixed(1)}% of portfolio`} />
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] text-zinc-600">{sector}</span>
                          {h.assetType === 'ETF' && (
                            <span className="text-[9px] bg-blue-500/10 text-blue-400 px-1 rounded font-medium">ETF</span>
                          )}
                          {h.t1Qty > 0 && (
                            <span className="text-[9px] bg-amber-500/10 text-amber-400 px-1 rounded font-medium">T+1:{h.t1Qty}</span>
                          )}
                          <span className="text-[9px] text-zinc-700">{(weight * 100).toFixed(1)}%</span>
                        </div>
                      </div>
                    </div>
                  </TD>
                  <TD right className="hidden lg:table-cell"><RSBadge info={rsMap.get(h.symbol)} /></TD>
                  <TD right className="hidden lg:table-cell"><MADots info={maMap.get(h.symbol)} /></TD>
                  <TD right>{h.totalQty.toLocaleString()}</TD>
                  <TD right className="text-zinc-400">{fmtINR(h.avgCostPrice)}</TD>
                  <TD right className="hidden sm:table-cell">{h.lastTradedPrice > 0 ? fmtINR(h.lastTradedPrice) : '—'}</TD>
                  <TD right className="hidden md:table-cell text-zinc-400">{fmtINR(h.investedValue, true)}</TD>
                  <TD right className="font-medium">{fmtINR(h.currentValue, true)}</TD>
                  <TD right><PnlText v={h.pnl} compact /></TD>
                  <TD right><PctBadge v={h.pnlPct} /></TD>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Allocation Chart (Feature 5: P&L distribution donut) ────────────────────

const CHART_COLORS = [
  '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
  '#84cc16', '#a78bfa', '#fb923c', '#38bdf8', '#4ade80',
];

function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const entry = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 shadow-xl">
      <p className="text-[12px] font-semibold text-white mb-1">{entry.name}</p>
      <p className="text-[12px] text-white tabular-nums">{fmtINR(entry.value, true)}</p>
      <p className="text-[11px] text-zinc-400 tabular-nums">{entry.pct}% of portfolio</p>
    </div>
  );
}

function AllocationChart({ holdings, mfData }: { holdings: Holding[]; mfData: MutualFund[] }) {
  // Sector breakdown
  const sectorMap = new Map<string, number>();
  holdings.forEach(h => {
    const sector = getSector(h.symbol);
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + h.currentValue);
  });
  const sectorTotal = Array.from(sectorMap.values()).reduce((s, v) => s + v, 0);
  const sectorData = Array.from(sectorMap.entries())
    .map(([name, value]) => ({
      name,
      value: Math.round(value),
      pct: sectorTotal > 0 ? (value / sectorTotal * 100).toFixed(1) : '0',
    }))
    .sort((a, b) => b.value - a.value);

  // Asset type breakdown
  const equityValue = holdings.filter(h => h.assetType === 'EQUITY').reduce((s, h) => s + h.currentValue, 0);
  const etfValue = holdings.filter(h => h.assetType === 'ETF').reduce((s, h) => s + h.currentValue, 0);
  const mfValue = mfData.reduce((s, m) => s + m.units * m.nav, 0);
  const assetTotal = equityValue + etfValue + mfValue;
  const assetData = [
    { name: 'Equity', value: Math.round(equityValue), pct: assetTotal > 0 ? (equityValue / assetTotal * 100).toFixed(1) : '0' },
    { name: 'ETF', value: Math.round(etfValue), pct: assetTotal > 0 ? (etfValue / assetTotal * 100).toFixed(1) : '0' },
    { name: 'Mutual Funds', value: Math.round(mfValue), pct: assetTotal > 0 ? (mfValue / assetTotal * 100).toFixed(1) : '0' },
  ].filter(d => d.value > 0);

  // Feature 5: P&L distribution donut
  const pnlDistData = (() => {
    const profitValue = holdings.filter(h => h.pnl > 0).reduce((s, h) => s + h.currentValue, 0);
    const lossValue = holdings.filter(h => h.pnl < 0).reduce((s, h) => s + h.currentValue, 0);
    const flatValue = holdings.filter(h => h.pnl === 0).reduce((s, h) => s + h.currentValue, 0);
    const pnlTotal = profitValue + lossValue + flatValue;
    return [
      { name: `In Profit (${holdings.filter(h => h.pnl > 0).length})`, value: Math.round(profitValue), pct: pnlTotal > 0 ? (profitValue / pnlTotal * 100).toFixed(1) : '0', color: '#10b981' },
      { name: `In Loss (${holdings.filter(h => h.pnl < 0).length})`, value: Math.round(lossValue), pct: pnlTotal > 0 ? (lossValue / pnlTotal * 100).toFixed(1) : '0', color: '#ef4444' },
      ...(flatValue > 0 ? [{ name: 'Flat', value: Math.round(flatValue), pct: pnlTotal > 0 ? (flatValue / pnlTotal * 100).toFixed(1) : '0', color: '#71717a' }] : []),
    ].filter(d => d.value > 0);
  })();

  if (holdings.length === 0 && mfData.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-600">
        <p className="text-sm">No portfolio data to show allocation.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Sector breakdown */}
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wide mb-4">Sector Allocation</h3>
        {sectorData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={sectorData} cx="50%" cy="50%" innerRadius={70} outerRadius={115} paddingAngle={2} dataKey="value">
                  {sectorData.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                </Pie>
                <ReTooltip content={<PieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-3 space-y-1.5 max-h-52 overflow-y-auto pr-1">
              {sectorData.map((d, idx) => (
                <div key={d.name} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }} />
                    <span className="text-zinc-200">{d.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400">{d.pct}%</span>
                    <span className="text-white tabular-nums">{fmtINR(d.value, true)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-zinc-600 text-xs text-center py-8">No equity holdings to chart.</p>
        )}
      </div>

      {/* Asset type breakdown */}
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wide mb-4">Asset Type Mix</h3>
        {assetData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={assetData} cx="50%" cy="50%" innerRadius={70} outerRadius={115} paddingAngle={2} dataKey="value">
                  {assetData.map((_, idx) => <Cell key={idx} fill={['#6366f1', '#06b6d4', '#10b981'][idx % 3]} />)}
                </Pie>
                <ReTooltip content={<PieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-3 space-y-1.5">
              {assetData.map((d, idx) => (
                <div key={d.name} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ['#6366f1', '#06b6d4', '#10b981'][idx % 3] }} />
                    <span className="text-zinc-200">{d.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400">{d.pct}%</span>
                    <span className="text-white tabular-nums">{fmtINR(d.value, true)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-zinc-600 text-xs text-center py-8">No assets to display.</p>
        )}
      </div>

      {/* Feature 5: P&L Distribution donut */}
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wide mb-4">P&amp;L Distribution</h3>
        {pnlDistData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={pnlDistData} cx="50%" cy="50%" innerRadius={70} outerRadius={115} paddingAngle={2} dataKey="value">
                  {pnlDistData.map((d, idx) => <Cell key={idx} fill={d.color} />)}
                </Pie>
                <ReTooltip content={<PieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-3 space-y-1.5">
              {pnlDistData.map(d => (
                <div key={d.name} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                    <span className="text-zinc-200">{d.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400">{d.pct}%</span>
                    <span className="text-white tabular-nums">{fmtINR(d.value, true)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-zinc-600 text-xs text-center py-8">No P&L data.</p>
        )}
      </div>

      {/* Top holdings bar */}
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wide mb-4">Top Holdings by Weight</h3>
        {holdings.length > 0 ? (() => {
          const total = holdings.reduce((s, h) => s + h.currentValue, 0);
          const top = [...holdings].sort((a, b) => b.currentValue - a.currentValue).slice(0, 10);
          return (
            <div className="space-y-2">
              {top.map((h, idx) => {
                const pct = total > 0 ? (h.currentValue / total * 100) : 0;
                return (
                  <div key={h.symbol} className="flex items-center gap-3">
                    <span className="text-[11px] text-zinc-400 w-5 text-right">{idx + 1}</span>
                    <span className="text-[11px] font-bold text-white w-28 truncate">{h.symbol}</span>
                    <div className="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }} />
                    </div>
                    <span className="text-[11px] text-zinc-400 w-10 text-right">{pct.toFixed(1)}%</span>
                    <span className="text-[11px] text-white tabular-nums w-20 text-right">{fmtINR(h.currentValue, true)}</span>
                  </div>
                );
              })}
            </div>
          );
        })() : (
          <p className="text-zinc-600 text-xs text-center py-6">No holdings data.</p>
        )}
      </div>
    </div>
  );
}

// ─── Mutual Funds Tab ─────────────────────────────────────────────────────────

function MutualFundsTab({ mfData }: { mfData: MutualFund[] | null }) {
  const totalInvested = mfData?.reduce((s, m) => s + m.investedValue, 0) ?? 0;
  const totalCurrentValue = mfData?.reduce((s, m) => s + m.units * m.nav, 0) ?? 0;
  const totalPnl = totalCurrentValue - totalInvested;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested * 100) : 0;

  if (!mfData || mfData.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-6 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 text-blue-400 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold text-zinc-200">Mutual Fund tracking is manual</p>
              <p className="text-xs text-zinc-500 leading-relaxed">
                Dhan's broker API does not expose mutual fund holdings. Create{' '}
                <code className="bg-zinc-800 px-1 rounded text-zinc-300">debug/mutual_funds.json</code>{' '}
                in the project root with your MF holdings to track them here.
              </p>
            </div>
          </div>
          <div className="mt-1 bg-zinc-950 border border-zinc-800 rounded-lg p-3">
            <p className="text-[10px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">Sample format</p>
            <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap leading-relaxed">{JSON.stringify([
              { name: "SBI Nifty 50 Index Fund - Direct Growth", amc: "SBI Mutual Fund", category: "Large Cap Index", units: 150.5, nav: 220.45, investedValue: 25000 },
              { name: "Parag Parikh Flexi Cap Fund - Direct Growth", amc: "PPFAS", category: "Flexi Cap", units: 85.2, nav: 95.30, investedValue: 50000 }
            ], null, 2)}</pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Invested" value={fmtINR(totalInvested, true)} />
        <SummaryCard label="Current Value" value={fmtINR(totalCurrentValue, true)} />
        <SummaryCard label="Total P&L" value={`${totalPnl >= 0 ? '+' : ''}${fmtINR(totalPnl, true)}`} positive={totalPnl >= 0} />
        <SummaryCard label="P&L %" value={fmtPct(totalPnlPct)} positive={totalPnlPct >= 0} />
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full border-collapse">
          <thead className="bg-zinc-800">
            <tr>
              <TH>Fund Name</TH>
              <TH className="hidden md:table-cell">AMC</TH>
              <TH className="hidden sm:table-cell">Category</TH>
              <TH right>Units</TH>
              <TH right>NAV</TH>
              <TH right>Invested</TH>
              <TH right>Value</TH>
              <TH right>P&amp;L %</TH>
            </tr>
          </thead>
          <tbody>
            {mfData.map((mf, i) => {
              const currentVal = mf.units * mf.nav;
              const pnl = currentVal - mf.investedValue;
              const pnlPct = mf.investedValue > 0 ? (pnl / mf.investedValue * 100) : 0;
              return (
                <tr key={i} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                  <TD><span className="font-medium text-white">{mf.name}</span></TD>
                  <TD className="hidden md:table-cell text-zinc-500">{mf.amc}</TD>
                  <TD className="hidden sm:table-cell">
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-px rounded">{mf.category}</span>
                  </TD>
                  <TD right className="text-zinc-400">{mf.units.toFixed(3)}</TD>
                  <TD right className="text-zinc-400">{fmtINR(mf.nav)}</TD>
                  <TD right className="text-zinc-400">{fmtINR(mf.investedValue, true)}</TD>
                  <TD right className="font-medium">{fmtINR(currentVal, true)}</TD>
                  <TD right><PctBadge v={pnlPct} /></TD>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Portfolio Value History ─────────────────────────────────────────────────

function PerformanceChart({ points, backfilled }: { points: PerformancePoint[]; backfilled: boolean }) {
  if (points.length === 0) {
    return (
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-6 flex flex-col items-center justify-center gap-2 min-h-[220px]">
        <Activity className="h-5 w-5 text-zinc-600" />
        <p className="text-xs text-zinc-500 text-center max-w-sm">
          No performance history yet. A daily snapshot of your portfolio value is recorded automatically —
          check back tomorrow to see the trend build up.
        </p>
      </div>
    );
  }

  const last = points[points.length - 1];
  const first = points[0];
  const hasSynthetic = points.some(p => p.synthetic);
  const hasSplit = points.some(p => p.equityValue > 0 || p.etfValue > 0);

  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-indigo-400" />
          <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">Portfolio Value History</span>
        </div>
        <span className="text-[10px] text-zinc-500">
          Since {first.date} · {points.length} day{points.length !== 1 ? 's' : ''}
        </span>
      </div>
      {hasSynthetic && (
        <p className="text-[10px] text-zinc-600 leading-relaxed">
          Dates before today are reconstructed from your actual buy/sell trade history (quantity held on each
          date, valued at that date's closing price) — not just today's holdings applied throughout.
        </p>
      )}
      {!backfilled && (
        <p className="text-[10px] text-zinc-600 leading-relaxed">
          Only today's snapshot is available so far. Run{' '}
          <Link href="/reports" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
            Portfolio Value History (Trade-Accurate)
          </Link>{' '}
          from Reports to backfill from April 1 using your real trade history.
        </p>
      )}
      <div className="flex items-center gap-4">
        <div className="flex flex-col">
          <span className="text-[9px] text-zinc-500 uppercase tracking-wide">Total Value</span>
          <span className="text-sm font-bold tabular-nums text-white">{fmtINR(last.totalCurrentValue, true)}</span>
        </div>
        {hasSplit && (
          <>
            <div className="flex flex-col">
              <span className="text-[9px] text-zinc-500 uppercase tracking-wide">Equity</span>
              <span className="text-sm font-bold tabular-nums text-indigo-400">{fmtINR(last.equityValue, true)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] text-zinc-500 uppercase tracking-wide">ETF</span>
              <span className="text-sm font-bold tabular-nums text-amber-400">{fmtINR(last.etfValue, true)}</span>
            </div>
          </>
        )}
      </div>
      <div className="h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#71717a' }} minTickGap={40} />
            <YAxis tick={{ fontSize: 10, fill: '#71717a' }} tickFormatter={(v: number) => fmtINR(v, true)} width={64} />
            <ReTooltip
              contentStyle={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, fontSize: 11 }}
              formatter={(v: any, name: any) => [fmtINR(Number(v)), name]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="totalCurrentValue" name="Total Portfolio" stroke="#818cf8" strokeWidth={2} dot={points.length < 2} isAnimationActive={points.length > 1} />
            {hasSplit && (
              <>
                <Line type="monotone" dataKey="equityValue" name="Equity" stroke="#10b981" strokeWidth={1.5} dot={points.length < 2} isAnimationActive={points.length > 1} />
                <Line type="monotone" dataKey="etfValue" name="ETF" stroke="#f59e0b" strokeWidth={1.5} dot={points.length < 2} isAnimationActive={points.length > 1} />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Risk Snapshot ────────────────────────────────────────────────────────────

function RiskSnapshotCard({ risk }: { risk: RiskSummary | null }) {
  if (!risk || !risk.available) {
    return (
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">Risk Snapshot</span>
        </div>
        <p className="text-xs text-zinc-500">
          Not generated yet. Run the{' '}
          <Link href="/reports" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
            Portfolio Risk Report
          </Link>{' '}
          from Reports to see Beta, Sharpe, VaR and Max Drawdown here.
        </p>
      </div>
    );
  }

  const metrics: { label: string; value: string; positive?: boolean }[] = [
    { label: 'Beta (vs Nifty)', value: risk.beta?.toFixed(2) ?? '—' },
    { label: 'Sharpe Ratio', value: risk.sharpe?.toFixed(2) ?? '—', positive: (risk.sharpe ?? 0) >= 0 },
    { label: 'Sortino Ratio', value: risk.sortino?.toFixed(2) ?? '—', positive: (risk.sortino ?? 0) >= 0 },
    { label: 'Max Drawdown', value: risk.maxDrawdown != null ? fmtPct(risk.maxDrawdown * 100) : '—', positive: false },
    { label: 'Ann. Volatility', value: risk.annualizedVolatility != null ? `${(risk.annualizedVolatility * 100).toFixed(1)}%` : '—' },
    { label: 'VaR (1-Day, 95%)', value: risk.var95Pct != null ? `${(risk.var95Pct * 100).toFixed(2)}%` : '—', positive: false },
  ];

  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">Risk Snapshot</span>
        </div>
        <span className="text-[10px] text-zinc-500">
          {risk.generatedAt ? `Generated ${new Date(risk.generatedAt).toLocaleString('en-IN')}` : ''}
          {' · '}
          <Link href="/reports" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">Regenerate</Link>
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {metrics.map(m => (
          <div key={m.label} className="flex flex-col">
            <span className="text-[9px] text-zinc-500 uppercase tracking-wide">{m.label}</span>
            <span className={cn(
              'text-sm font-bold tabular-nums',
              m.positive === true ? 'text-emerald-400' : m.positive === false ? 'text-red-400' : 'text-white',
            )}>
              {m.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Cross-links ──────────────────────────────────────────────────────────────

function RelatedLinks({ current }: { current: 'portfolio' | 'portfolio-new' | 'portfolio-trades' }) {
  const links = [
    { href: '/portfolio', label: 'Portfolio', id: 'portfolio' },
    { href: '/portfolio-new', label: 'Portfolio+ (Net Worth)', id: 'portfolio-new' },
    { href: '/portfolio/trades', label: 'Trade P&L', id: 'portfolio-trades' },
    { href: '/reports', label: 'Reports', id: 'reports' },
  ].filter(l => l.id !== current);

  return (
    <div className="w-full border-b border-zinc-900 bg-zinc-950/40 px-4 py-1.5 flex items-center gap-2 flex-wrap">
      <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Related</span>
      {links.map(l => (
        <Link
          key={l.id}
          href={l.href}
          className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/30 transition-all"
        >
          {l.label}
        </Link>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Tab = 'holdings' | 'allocation' | 'mf' | 'performance';
type AssetFilter = 'ALL' | 'EQUITY' | 'ETF';

export default function PortfolioDashboard() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [mfData, setMfData] = useState<MutualFund[] | null>(null);
  const [rsMap, setRsMap] = useState<Map<string, RSInfo>>(new Map());
  const [maMap, setMaMap] = useState<Map<string, MAInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tab, setTab] = useState<Tab>('holdings');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('ALL');
  const [performancePoints, setPerformancePoints] = useState<PerformancePoint[]>([]);
  const [performanceBackfilled, setPerformanceBackfilled] = useState(false);
  const [riskSummary, setRiskSummary] = useState<RiskSummary | null>(null);

  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    try {
      const [holdingsRes, mfRes] = await Promise.allSettled([
        fetch('/api/portfolio-holdings'),
        fetch('/api/mutual-funds'),
      ]);
      if (holdingsRes.status === 'fulfilled') {
        const d = await holdingsRes.value.json();
        if (d.success) { setData(d); setError(null); }
        else setError(d.error ?? 'Failed to fetch portfolio');
      }
      if (mfRes.status === 'fulfilled' && mfRes.value.ok) {
        const mf = await mfRes.value.json();
        if (Array.isArray(mf)) setMfData(mf);
      } else {
        setMfData([]);
      }
      setLastUpdated(new Date());
    } catch {
      setError('Network error — check that the Next.js dev server is running.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Fetch RS + MA enrichment data once on mount (heavy endpoints, 5-min server cache)
  useEffect(() => {
    async function fetchEnrich() {
      const [rsRes, maRes] = await Promise.allSettled([
        fetch('/api/stocks?index=nifty500&lookback=100'),
        fetch('/api/movers?index=nifty500'),
      ]);
      if (rsRes.status === 'fulfilled' && rsRes.value.ok) {
        const resp = await rsRes.value.json();
        const list: any[] = resp.data ?? [];
        const m = new Map<string, RSInfo>();
        list.forEach(r => m.set(r.symbol, { rating: r.rsRating, momentum: r.rsMomentum, score: r.rsScore }));
        setRsMap(m);
      }
      if (maRes.status === 'fulfilled' && maRes.value.ok) {
        const resp = await maRes.value.json();
        const list: any[] = resp.data?.allMovers ?? [];
        const m = new Map<string, MAInfo>();
        list.forEach(r => m.set(r.symbol, { aboveMa20: r.aboveMa20, aboveMa50: r.aboveMa50, aboveMa200: r.aboveMa200 }));
        setMaMap(m);
      }
    }
    fetchEnrich();
  }, []);

  // Fetch risk summary once on mount (low-frequency data)
  useEffect(() => {
    fetch('/api/portfolio-risk-summary')
      .then(r => r.ok ? r.json() : null)
      .then(resp => { if (resp) setRiskSummary(resp); })
      .catch(() => {});
  }, []);

  // Performance history: the daily-snapshot tracker accumulates going forward; the Apr 1 backfill
  // (trade-accurate reconstruction) is generated on-demand from Reports since it's not cheap. Fetch
  // once on mount.
  useEffect(() => {
    fetch('/api/portfolio-history')
      .then(r => r.json())
      .then(resp => {
        if (Array.isArray(resp.points)) setPerformancePoints(resp.points);
        setPerformanceBackfilled(!!resp.backfilled);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchData(true);
    const interval = setInterval(() => fetchData(false), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const summary = data?.summary;
  const holdings = data?.holdings ?? [];
  const totalValue = holdings.reduce((s, h) => s + h.currentValue, 0);
  const equityCount = holdings.filter(h => h.assetType === 'EQUITY').length;
  const etfCount = holdings.filter(h => h.assetType === 'ETF').length;

  const NAV_TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'holdings', label: 'Holdings', count: holdings.length },
    { id: 'allocation', label: 'Allocation' },
    { id: 'mf', label: 'Mutual Funds', count: mfData?.length },
    { id: 'performance', label: 'Performance' },
  ];

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-200">

      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 sticky top-0 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-violet-400 flex items-center justify-center shadow-md shadow-indigo-500/10 shrink-0">
            <Briefcase className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">Portfolio Analysis</h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                : 'Loading…'}
            </p>
          </div>
        </div>
        <NavBar />
        <button
          onClick={() => fetchData(false)}
          disabled={refreshing}
          className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-500 hover:text-white hover:border-zinc-700 transition-all active:scale-95 disabled:opacity-40 ml-auto"
          title="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </header>

      <RelatedLinks current="portfolio" />

      {/* Summary bar */}
      {summary && (
        <div className="w-full border-b border-zinc-900 bg-zinc-950/60 px-4 py-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          <div className="flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wide font-medium">Invested</span>
            <span className="text-sm font-bold text-white tabular-nums">{fmtINR(summary.totalInvested, true)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wide font-medium">Current Value</span>
            <span className="text-sm font-bold text-white tabular-nums">{fmtINR(summary.totalCurrentValue, true)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wide font-medium">Holdings P&L</span>
            <span className={cn('text-sm font-bold tabular-nums', summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {summary.totalPnl >= 0 ? '+' : ''}{fmtINR(summary.totalPnl, true)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wide font-medium">Return</span>
            <span className={cn('text-sm font-bold tabular-nums', summary.totalPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {fmtPct(summary.totalPnlPct)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wide font-medium">Trading P&L</span>
            <span className={cn('text-sm font-bold tabular-nums', (summary.realizedPnl + summary.unrealizedPnl) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {(summary.realizedPnl + summary.unrealizedPnl) >= 0 ? '+' : ''}
              {fmtINR(summary.realizedPnl + summary.unrealizedPnl, true)}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wide font-medium">Available Margin</span>
            <span className="text-sm font-bold text-white tabular-nums">{fmtINR(data?.available_funds ?? 0, true)}</span>
          </div>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 w-full mx-auto px-4 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[300px] gap-3">
            <RefreshCw className="h-6 w-6 text-indigo-500 animate-spin" />
            <span className="text-zinc-600 text-xs">Fetching portfolio from Dhan…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-red-500/20 bg-red-950/10 min-h-[260px] gap-2">
            <p className="text-sm font-semibold text-red-400">Failed to Load Portfolio</p>
            <p className="text-xs text-zinc-600 max-w-md text-center">{error}</p>
            {/auth|token|login/i.test(error) && (
              <div className="flex items-center gap-2 mt-1 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span className="text-xs text-amber-400">
                  Access token expired — run{' '}
                  <code className="font-mono bg-amber-500/10 px-1 rounded">venv\Scripts\python.exe login.py</code>{' '}
                  to re-login
                </span>
              </div>
            )}
            <button onClick={() => fetchData(true)} className="mt-2 px-4 py-1.5 text-xs font-semibold bg-red-950/40 border border-red-800 text-red-400 rounded-lg hover:bg-red-900/40 transition-all">
              Retry
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Feature 3: Winners / Losers + Health panel */}
            <WinnersLosersPanel holdings={holdings} rsMap={rsMap} maMap={maMap} />

            {/* Tabs */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5">
                {NAV_TABS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      'px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all flex items-center gap-1',
                      tab === t.id ? 'bg-indigo-500/10 text-indigo-400' : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    {t.label}
                    {t.count !== undefined && t.count > 0 && (
                      <span className={cn(
                        'text-[9px] px-1 rounded font-bold',
                        tab === t.id ? 'bg-indigo-500/20 text-indigo-400' : 'bg-zinc-800 text-zinc-500',
                      )}>
                        {t.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {tab === 'holdings' && (
                <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 ml-auto">
                  {(['ALL', 'EQUITY', 'ETF'] as AssetFilter[]).map(f => (
                    <button
                      key={f}
                      onClick={() => setAssetFilter(f)}
                      className={cn(
                        'px-2.5 py-1 text-[10px] font-semibold rounded transition-all',
                        assetFilter === f ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300',
                      )}
                    >
                      {f}
                      {f === 'EQUITY' && equityCount > 0 && <span className="ml-0.5 text-zinc-600">({equityCount})</span>}
                      {f === 'ETF' && etfCount > 0 && <span className="ml-0.5 text-zinc-600">({etfCount})</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Tab content */}
            {tab === 'holdings' && (
              <HoldingsTable
                holdings={holdings}
                filter={assetFilter}
                rsMap={rsMap}
                maMap={maMap}
                totalValue={totalValue}
              />
            )}
            {tab === 'allocation' && <AllocationChart holdings={holdings} mfData={mfData ?? []} />}
            {tab === 'mf' && <MutualFundsTab mfData={mfData} />}
            {tab === 'performance' && (
              <div className="flex flex-col gap-4">
                <PerformanceChart points={performancePoints} backfilled={performanceBackfilled} />
                <RiskSnapshotCard risk={riskSummary} />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
