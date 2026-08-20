'use client';

import React, { useState, useEffect, useMemo } from 'react';
import NavBar from '@/components/NavBar';
import dynamic from 'next/dynamic';

// Charts only render after a backtest completes — lazy-load so recharts
// stays out of the /backtest initial bundle.
const BacktestCharts = dynamic(() => import('@/components/BacktestCharts'), {
  ssr: false,
  loading: () => <div className="h-64 bg-zinc-900/60 border border-zinc-800/60 rounded-lg animate-pulse" />,
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface LegConfig {
  option_type: 'CE' | 'PE';
  position: 'sell' | 'buy';
  lots: number;
  strike: string;          // offset string, premium or delta value
  leg_sl_pct: number;      // 0 = disabled
  leg_target_pct: number;  // 0 = disabled
  strike_type?: 'offset' | 'closest_premium' | 'closest_delta';
}

interface LegResult {
  option_type: string;
  position: string;
  strike: number;
  entry_price: number | null;
  exit_price: number | null;
  pnl: number;
  exit_reason: string;
}

interface CycleResult {
  expiry_date: string;
  entry_dt: string | null;
  exit_dt: string | null;
  entry_spot: number | null;
  vix: number | null;
  net_credit: number | null;
  exit_combined: number | null;
  pnl: number;
  exit_reason: string;
  is_complete: boolean;
  legs: LegResult[];
}

interface BacktestSummary {
  total_cycles: number;
  traded_cycles: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  max_win: number;
  max_loss: number;
  avg_win: number;
  avg_loss: number;
  max_drawdown: number;
  max_drawdown_start: string;
  max_drawdown_end: string;
  max_drawdown_days: number | null;
  max_trades_in_drawdown: number;
  max_win_streak: number;
  max_loss_streak: number;
  return_maxdd_ratio: number | null;
  reward_risk_ratio: number | null;
  expectancy: number;
  expectancy_ratio: number | null;
  commission_paid: number;
}

type MonthlyPnl = Record<string, Record<string, number>>;

interface BacktestResult {
  summary: BacktestSummary;
  cycles: CycleResult[];
  equity_curve: { date: string; cumulative_pnl: number }[];
  monthly_pnl: MonthlyPnl;
  params: Record<string, unknown>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STRIKE_OPTIONS = [
  'ATM',
  ...Array.from({ length: 10 }, (_, i) => `ATM+${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `ATM-${i + 1}`),
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const EXIT_REASON_CLS: Record<string, string> = {
  TARGET:        'bg-emerald-500/10 text-emerald-300',
  LEG_TARGET:    'bg-emerald-500/10 text-emerald-400',
  EOD:           'bg-sky-500/10 text-sky-300',
  LEG_SL:        'bg-red-500/10 text-red-300',
  ALL_LEGS_DONE: 'bg-red-500/10 text-red-300',
  OVERALL_SL:    'bg-red-700/10 text-red-400',
  INCOMPLETE:    'bg-amber-500/10 text-amber-300',
  NO_ENTRY:      'bg-zinc-800 text-zinc-500',
};

const inputCls = 'w-full bg-zinc-900 border border-zinc-700 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 transition-colors';
const inputSmCls = 'w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 transition-colors';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function fmtPnl(n: number) {
  return `${n >= 0 ? '+' : '-'}₹${fmt(n)}`;
}
function fmtNum(n: number | null, decimals = 2): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}
function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}
function fmtTime(iso: string | null): string {
  return iso ? iso.slice(11, 16) : '—';
}

// Compute year-wise MDD from equity curve
function computeYearMDD(curve: { date: string; cumulative_pnl: number }[], year: string) {
  const pts = curve.filter(p => p.date.startsWith(year));
  if (!pts.length) return { mdd: 0, days: null };
  let peak = pts[0].cumulative_pnl;
  let peakIdx = 0;
  let mdd = 0;
  let mddDays: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].cumulative_pnl > peak) {
      peak = pts[i].cumulative_pnl;
      peakIdx = i;
    }
    const dd = peak - pts[i].cumulative_pnl;
    if (dd > mdd) {
      mdd = dd;
      try {
        const d1 = new Date(pts[peakIdx].date);
        const d2 = new Date(pts[i].date);
        mddDays = Math.round((d2.getTime() - d1.getTime()) / 86400000);
      } catch { mddDays = null; }
    }
  }
  return { mdd: Math.round(mdd), days: mddDays };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = '' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
      <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-base font-bold leading-tight ${color || 'text-zinc-100'}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ value, options, onChange }: {
  value: string;
  options: { label: string; value: string; activeClass: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded overflow-hidden border border-zinc-700">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 text-[10px] font-bold px-2 py-1 transition-colors ${
            value === opt.value ? opt.activeClass : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Dynamic Leg Builder ──────────────────────────────────────────────────────

function LegCard({
  index,
  leg,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number;
  leg: LegConfig;
  onChange: (l: LegConfig) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const isCall = leg.option_type === 'CE';
  const isSell = leg.position === 'sell';
  const slOn  = leg.leg_sl_pct > 0;
  const tgtOn = leg.leg_target_pct > 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col gap-2">
      {/* Row 1: label + remove */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-zinc-500">LEG {index + 1}</span>
        {canRemove && (
          <button onClick={onRemove} className="text-[10px] text-zinc-600 hover:text-red-400 font-bold transition-colors">✕</button>
        )}
      </div>

      {/* Row 2: option type + position toggles */}
      <div className="grid grid-cols-2 gap-1.5">
        <Toggle
          value={leg.option_type}
          onChange={v => onChange({ ...leg, option_type: v as 'CE' | 'PE' })}
          options={[
            { label: 'CE', value: 'CE', activeClass: 'bg-sky-600 text-oncolor' },
            { label: 'PE', value: 'PE', activeClass: 'bg-amber-600 text-oncolor' },
          ]}
        />
        <Toggle
          value={leg.position}
          onChange={v => onChange({ ...leg, position: v as 'sell' | 'buy' })}
          options={[
            { label: 'Sell', value: 'sell', activeClass: 'bg-red-700 text-oncolor' },
            { label: 'Buy',  value: 'buy',  activeClass: 'bg-emerald-700 text-oncolor' },
          ]}
        />
      </div>

      {/* Row 2.5: strike mode */}
      <div>
        <div className="text-[9px] font-bold text-zinc-600 uppercase mb-1">Strike Mode</div>
        <select
          value={leg.strike_type || 'offset'}
          onChange={e => {
            const newType = e.target.value as 'offset' | 'closest_premium' | 'closest_delta';
            let defaultStrike = leg.strike;
            if (newType === 'offset') defaultStrike = 'ATM';
            else if (newType === 'closest_premium') defaultStrike = '100';
            else if (newType === 'closest_delta') defaultStrike = '30';
            onChange({ ...leg, strike_type: newType, strike: defaultStrike });
          }}
          className={inputSmCls}
        >
          <option value="offset">ATM Offset</option>
          <option value="closest_premium">Closest Premium</option>
          <option value="closest_delta">Closest Delta</option>
        </select>
      </div>

      {/* Row 3: strike + lots */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[9px] font-bold text-zinc-600 uppercase mb-1">Strike</div>
          {(!leg.strike_type || leg.strike_type === 'offset') ? (
            <select
              value={leg.strike}
              onChange={e => onChange({ ...leg, strike: e.target.value })}
              className={inputSmCls}
            >
              {STRIKE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <input
              type="number"
              min={1}
              value={leg.strike}
              onChange={e => onChange({ ...leg, strike: e.target.value })}
              className={inputSmCls}
              placeholder={leg.strike_type === 'closest_premium' ? 'e.g. 100' : 'e.g. 30'}
            />
          )}
        </div>
        <div>
          <div className="text-[9px] font-bold text-zinc-600 uppercase mb-1">Lots</div>
          <input
            type="number" min={1} value={leg.lots}
            onChange={e => onChange({ ...leg, lots: Math.max(1, Number(e.target.value)) })}
            className={inputSmCls}
          />
        </div>
      </div>

      {/* Row 4: toggleable Leg SL */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={slOn}
            onChange={e => onChange({ ...leg, leg_sl_pct: e.target.checked ? 40 : 0 })}
            className="w-3 h-3 accent-red-500"
          />
          <span className="text-[10px] font-bold text-zinc-400">Leg SL</span>
        </label>
        {slOn && (
          <div className="flex items-center gap-1 ml-auto">
            <input
              type="number" min={1} step={1} value={leg.leg_sl_pct}
              onChange={e => onChange({ ...leg, leg_sl_pct: Number(e.target.value) })}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-100 focus:outline-none focus:border-red-500"
            />
            <span className="text-[10px] text-zinc-500">%</span>
          </div>
        )}
      </div>

      {/* Row 5: toggleable Leg Target */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={tgtOn}
            onChange={e => onChange({ ...leg, leg_target_pct: e.target.checked ? 50 : 0 })}
            className="w-3 h-3 accent-emerald-500"
          />
          <span className="text-[10px] font-bold text-zinc-400">Leg Target</span>
        </label>
        {tgtOn && (
          <div className="flex items-center gap-1 ml-auto">
            <input
              type="number" min={1} step={1} value={leg.leg_target_pct}
              onChange={e => onChange({ ...leg, leg_target_pct: Number(e.target.value) })}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
            />
            <span className="text-[10px] text-zinc-500">%</span>
          </div>
        )}
      </div>

      {/* Row 6: summary tags */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className={`text-[9px] font-bold rounded px-1.5 py-0.5 border ${
          isCall ? 'bg-sky-500/10 text-sky-300 border-sky-500/20' : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
        }`}>{leg.option_type}</span>
        <span className={`text-[9px] font-bold rounded px-1.5 py-0.5 border ${
          isSell ? 'bg-red-500/10 text-red-300 border-red-500/20' : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
        }`}>{isSell ? 'SELL' : 'BUY'}</span>
        <span className="text-[9px] font-bold bg-zinc-800 text-zinc-400 rounded px-1.5 py-0.5 border border-zinc-700">
          {leg.strike_type === 'closest_premium' ? `Prem: ${leg.strike}` : leg.strike_type === 'closest_delta' ? `Delta: ${leg.strike}` : leg.strike}
        </span>
        {slOn  && <span className="text-[9px] font-bold bg-red-500/10 text-red-400 rounded px-1.5 py-0.5 border border-red-500/20">SL {leg.leg_sl_pct}%</span>}
        {tgtOn && <span className="text-[9px] font-bold bg-emerald-500/10 text-emerald-400 rounded px-1.5 py-0.5 border border-emerald-500/20">TGT {leg.leg_target_pct}%</span>}
      </div>
    </div>
  );
}

// ─── Year-wise Returns Table ─────────────────────────────────────────────────

function YearwiseTable({ monthlyPnl, equityCurve }: {
  monthlyPnl: MonthlyPnl;
  equityCurve: { date: string; cumulative_pnl: number }[];
}) {
  const years = Object.keys(monthlyPnl).sort();
  if (!years.length) return null;

  function cellColor(v: number | undefined): string {
    if (v == null || v === 0) return 'text-zinc-500';
    return v > 0 ? 'text-emerald-400' : 'text-red-400';
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="text-xs whitespace-nowrap w-full">
          <thead>
            <tr className="bg-zinc-800">
              <th className="text-xs font-bold text-white text-left px-3 py-2">Year</th>
              {MONTHS.map(m => (
                <th key={m} className="text-xs font-bold text-white text-right px-2 py-2">{m}</th>
              ))}
              <th className="text-xs font-bold text-white text-right px-3 py-2 border-l border-zinc-700">Total</th>
              <th className="text-xs font-bold text-white text-right px-3 py-2">Max DD</th>
              <th className="text-xs font-bold text-white text-right px-3 py-2">Days</th>
              <th className="text-xs font-bold text-white text-right px-3 py-2">R/MDD</th>
            </tr>
          </thead>
          <tbody>
            {years.map((yr, i) => {
              const yData = monthlyPnl[yr] ?? {};
              const total = yData['Total'] ?? 0;
              const { mdd, days } = computeYearMDD(equityCurve, yr);
              const rMdd = mdd > 0 ? (total / mdd).toFixed(2) : '—';
              return (
                <tr key={yr} className={`border-t border-zinc-800 ${i % 2 === 0 ? '' : 'bg-zinc-950/40'}`}>
                  <td className="px-3 py-1.5 font-bold text-zinc-200">{yr}</td>
                  {MONTHS.map(m => {
                    const v = yData[m];
                    return (
                      <td key={m} className={`px-2 py-1.5 text-right font-mono ${cellColor(v)}`}>
                        {v != null && v !== 0 ? (v > 0 ? '+' : '') + Math.round(v).toLocaleString('en-IN') : '—'}
                      </td>
                    );
                  })}
                  <td className={`px-3 py-1.5 text-right font-mono font-bold border-l border-zinc-800 ${cellColor(total)}`}>
                    {total !== 0 ? (total > 0 ? '+' : '') + Math.round(total).toLocaleString('en-IN') : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-amber-400">
                    {mdd > 0 ? `₹${mdd.toLocaleString('en-IN')}` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-zinc-400">
                    {days != null ? days : '—'}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${
                    typeof rMdd === 'string' && rMdd !== '—' && Number(rMdd) >= 1
                      ? 'text-emerald-400' : 'text-zinc-400'
                  }`}>
                    {rMdd}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Full Report Table ────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function FullReportTable({ cycles, lotSize }: { cycles: CycleResult[]; lotSize: number }) {
  const [page, setPage] = useState(0);
  const traded = useMemo(() => cycles.filter(c => c.exit_reason !== 'NO_ENTRY'), [cycles]);
  const totalPages = Math.ceil(traded.length / PAGE_SIZE);
  const visible = traded.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-xs whitespace-nowrap w-full">
            <thead>
              <tr className="bg-zinc-800">
                <th className="text-xs font-bold text-white text-left px-3 py-2">#</th>
                <th className="text-xs font-bold text-white text-left px-3 py-2">Entry Date</th>
                <th className="text-xs font-bold text-white text-right px-2 py-2">Time</th>
                <th className="text-xs font-bold text-white text-left px-3 py-2 border-l border-zinc-700">Exit Date</th>
                <th className="text-xs font-bold text-white text-right px-2 py-2">Time</th>
                <th className="text-xs font-bold text-white text-center px-2 py-2 border-l border-zinc-700">Type</th>
                <th className="text-xs font-bold text-white text-right px-2 py-2">Strike</th>
                <th className="text-xs font-bold text-white text-center px-2 py-2">B/S</th>
                <th className="text-xs font-bold text-white text-right px-2 py-2">Qty</th>
                <th className="text-xs font-bold text-white text-right px-3 py-2 border-l border-zinc-700">Entry ₹</th>
                <th className="text-xs font-bold text-white text-right px-3 py-2">Exit ₹</th>
                <th className="text-xs font-bold text-white text-right px-3 py-2">VIX</th>
                <th className="text-xs font-bold text-white text-right px-3 py-2 border-l border-zinc-700">P/L</th>
                <th className="text-xs font-bold text-white text-center px-2 py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c, idx) => {
                const tradeNum = page * PAGE_SIZE + idx + 1;
                const rowBg = idx % 2 === 0 ? '' : 'bg-zinc-950/40';
                return [
                  // Parent row
                  <tr key={`${c.expiry_date}-p`} className={`border-t border-zinc-800 ${rowBg} font-medium`}>
                    <td className="px-3 py-1.5 text-zinc-300 font-bold">{tradeNum}</td>
                    <td className="px-3 py-1.5 text-zinc-300 font-mono">{fmtDate(c.entry_dt)}</td>
                    <td className="px-2 py-1.5 text-right text-zinc-400 font-mono">{fmtTime(c.entry_dt)}</td>
                    <td className="px-3 py-1.5 text-zinc-300 font-mono border-l border-zinc-800">{fmtDate(c.exit_dt)}</td>
                    <td className="px-2 py-1.5 text-right text-zinc-400 font-mono">{fmtTime(c.exit_dt)}</td>
                    <td className="px-2 py-1.5 text-center border-l border-zinc-800">—</td>
                    <td className="px-2 py-1.5 text-right text-zinc-500 font-mono">
                      {c.entry_spot != null ? Math.round(c.entry_spot).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-center">—</td>
                    <td className="px-2 py-1.5 text-right">—</td>
                    <td className="px-3 py-1.5 text-right font-mono text-zinc-200 border-l border-zinc-800">
                      {c.net_credit != null ? c.net_credit.toFixed(2) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-zinc-200">
                      {c.exit_combined != null ? Math.abs(c.exit_combined).toFixed(2) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-zinc-400">
                      {c.vix != null ? c.vix.toFixed(1) : '—'}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono font-bold border-l border-zinc-800 ${c.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmtPnl(c.pnl)}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${EXIT_REASON_CLS[c.exit_reason] ?? 'bg-zinc-800 text-zinc-400'}`}>
                        {c.exit_reason}
                      </span>
                    </td>
                  </tr>,
                  // Sub-rows per leg
                  ...c.legs.map((leg, li) => {
                    const isCall = leg.option_type === 'CE';
                    return (
                      <tr key={`${c.expiry_date}-l${li}`} className={`border-t border-zinc-800/50 ${rowBg} opacity-80`}>
                        <td className="px-3 py-1 text-zinc-600 font-mono text-[10px] pl-5">{tradeNum}.{li + 1}</td>
                        <td className="px-3 py-1 text-zinc-600">—</td>
                        <td className="px-2 py-1 text-right text-zinc-600">—</td>
                        <td className="px-3 py-1 text-zinc-600 border-l border-zinc-800">—</td>
                        <td className="px-2 py-1 text-right text-zinc-600">—</td>
                        <td className="px-2 py-1 text-center border-l border-zinc-800">
                          <span className={`text-[10px] font-bold ${isCall ? 'text-sky-400' : 'text-amber-400'}`}>
                            {leg.option_type}
                          </span>
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${isCall ? 'text-sky-300' : 'text-amber-300'}`}>
                          {leg.strike > 0 ? Math.round(leg.strike).toLocaleString('en-IN') : '—'}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <span className={`text-[10px] font-bold ${leg.position === 'sell' ? 'text-red-400' : 'text-emerald-400'}`}>
                            {leg.position === 'sell' ? 'S' : 'B'}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-zinc-400">
                          {/* lots * lot_size displayed as qty — shown as lots only, lot_size applied in P&L */}
                          {lotSize}
                        </td>
                        <td className={`px-3 py-1 text-right font-mono border-l border-zinc-800 ${isCall ? 'text-sky-300' : 'text-amber-300'}`}>
                          {fmtNum(leg.entry_price)}
                        </td>
                        <td className={`px-3 py-1 text-right font-mono ${isCall ? 'text-sky-300' : 'text-amber-300'}`}>
                          {fmtNum(leg.exit_price)}
                        </td>
                        <td className="px-3 py-1 text-right text-zinc-600">—</td>
                        <td className={`px-3 py-1 text-right font-mono border-l border-zinc-800 ${leg.pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                          {leg.pnl !== 0 ? fmtPnl(leg.pnl) : '—'}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <span className={`text-[10px] font-bold ${EXIT_REASON_CLS[leg.exit_reason] ?? 'bg-zinc-800 text-zinc-400'} rounded px-1 py-0.5`}>
                            {leg.exit_reason}
                          </span>
                        </td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-2 text-xs text-zinc-500">
          <span>{traded.length} trades · page {page + 1} of {totalPages}</span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 disabled:opacity-30 hover:border-zinc-500"
            >Prev</button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 disabled:opacity-30 hover:border-zinc-500"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const DEFAULT_LEGS: LegConfig[] = [
  { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
  { option_type: 'PE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0 },
];

export default function BacktestPage() {
  const [legs, setLegs] = useState<LegConfig[]>(DEFAULT_LEGS);
  const [lotSize, setLotSize] = useState(65);
  const [profitTargetPct, setProfitTargetPct] = useState(50);
  const [overallSlPct, setOverallSlPct] = useState(0);
  const [entryTime, setEntryTime] = useState('09:20');
  const [eodTime, setEodTime] = useState('15:15');
  const [includeCosts, setIncludeCosts] = useState(false);
  const [commissionPerLot, setCommissionPerLot] = useState(40);
  const [slippagePct, setSlippagePct] = useState(0);
  const [strategyType, setStrategyType] = useState<'intraday' | 'expiry_day' | 'first_day'>('intraday');
  const [startDate, setStartDate] = useState('2021-01-01');
  const [endDate, setEndDate] = useState('2026-06-30');

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch current NIFTY lot size on mount
  useEffect(() => {
    fetch('/api/lotsize?symbol=NIFTY')
      .then(r => r.json())
      .then(d => { if (d.lot_size) setLotSize(d.lot_size); })
      .catch(() => {/* keep default */});
  }, []);

  function addLeg() {
    setLegs(l => [...l, { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 40, leg_target_pct: 0 }]);
  }
  function updateLeg(i: number, leg: LegConfig) {
    setLegs(l => l.map((x, j) => j === i ? leg : x));
  }
  function removeLeg(i: number) {
    setLegs(l => l.filter((_, j) => j !== i));
  }

  async function runBacktest() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legs,
          lot_size: lotSize,
          profit_target_pct: profitTargetPct,
          overall_sl_pct: overallSlPct,
          entry_time: entryTime,
          eod_time: eodTime,
          commission_per_lot: includeCosts ? commissionPerLot : 0,
          slippage_pct: includeCosts ? slippagePct : 0,
          strategy_type: strategyType,
          start_date: startDate,
          end_date: endDate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Backtest failed');
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const s = result?.summary;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-zinc-950/90 backdrop-blur border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <NavBar />
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-zinc-100 tracking-wide">OPTIONS BACKTEST</span>
            {result && s && (
              <span className="text-[10px] font-bold text-zinc-500 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5">
                {s.traded_cycles} TRADES · {startDate} → {endDate}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-0 h-[calc(100vh-53px)]">
        {/* ── Left: Config panel ── */}
        <div className="w-72 shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col overflow-y-auto">
          <div className="p-3 flex flex-col gap-4">

            {/* Leg Builder */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Leg Builder</div>
                <button
                  onClick={addLeg}
                  className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-2 py-0.5 transition-colors"
                >
                  + Add Leg
                </button>
              </div>
              <div className="flex flex-col gap-2">
                {legs.map((leg, i) => (
                  <LegCard
                    key={i}
                    index={i}
                    leg={leg}
                    onChange={l => updateLeg(i, l)}
                    onRemove={() => removeLeg(i)}
                    canRemove={legs.length > 1}
                  />
                ))}
              </div>
            </div>

            {/* Strategy-level controls */}
            <div className="border-t border-zinc-800 pt-3 flex flex-col gap-3">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Strategy</div>
              <FormField label="Lot Size">
                <input type="number" min={1} className={inputCls} value={lotSize}
                  onChange={e => setLotSize(Number(e.target.value))} />
              </FormField>

              {/* Overall Target — toggleable */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer select-none mb-1">
                  <input
                    type="checkbox"
                    checked={profitTargetPct > 0}
                    onChange={e => setProfitTargetPct(e.target.checked ? 50 : 0)}
                    className="w-3 h-3 accent-emerald-500"
                  />
                  <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Overall Target %</span>
                </label>
                {profitTargetPct > 0 && (
                  <input type="number" min={1} step={5} className={inputCls} value={profitTargetPct}
                    onChange={e => setProfitTargetPct(Number(e.target.value))} />
                )}
              </div>

              {/* Overall SL — toggleable */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer select-none mb-1">
                  <input
                    type="checkbox"
                    checked={overallSlPct > 0}
                    onChange={e => setOverallSlPct(e.target.checked ? 100 : 0)}
                    className="w-3 h-3 accent-red-500"
                  />
                  <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Overall SL %</span>
                </label>
                {overallSlPct > 0 && (
                  <input type="number" min={1} step={5} className={inputCls} value={overallSlPct}
                    onChange={e => setOverallSlPct(Number(e.target.value))} />
                )}
              </div>
            </div>

            {/* Timing */}
            <div className="border-t border-zinc-800 pt-3 flex flex-col gap-3">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Timing</div>
              <FormField label="Strategy Type">
                <Toggle
                  value={strategyType}
                  onChange={v => setStrategyType(v as typeof strategyType)}
                  options={[
                    { label: 'Intraday', value: 'intraday',    activeClass: 'bg-emerald-600 text-oncolor' },
                    { label: 'Expiry Day', value: 'expiry_day', activeClass: 'bg-sky-600 text-oncolor' },
                    { label: 'First Day', value: 'first_day',   activeClass: 'bg-amber-600 text-oncolor' },
                  ]}
                />
              </FormField>
              <div className="text-[9px] text-zinc-500 bg-zinc-800/50 rounded px-2 py-1">
                {strategyType === 'intraday'   && 'Trade every day — enter at entry time, exit same day at EOD. Matches AlgoTest Intraday.'}
                {strategyType === 'expiry_day' && 'Only enter on the expiry date itself (0DTE). Matches AlgoTest Expiry Day.'}
                {strategyType === 'first_day'  && 'Enter on the first day of each expiry cycle (multi-DTE, holds until EOD same day).'}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <FormField label="Entry">
                  <input type="text" className={inputCls} value={entryTime}
                    onChange={e => setEntryTime(e.target.value)} placeholder="09:20" />
                </FormField>
                <FormField label="EOD Exit">
                  <input type="text" className={inputCls} value={eodTime}
                    onChange={e => setEodTime(e.target.value)} placeholder="15:15" />
                </FormField>
              </div>
            </div>

            {/* Costs */}
            <div className="border-t border-zinc-800 pt-3 flex flex-col gap-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeCosts}
                  onChange={e => setIncludeCosts(e.target.checked)}
                  className="w-3 h-3 accent-amber-500"
                />
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Include Costs</span>
              </label>

              {includeCosts && (
                <div className="grid grid-cols-2 gap-2">
                  <FormField label="Commission / Lot">
                    <input type="number" min={0} step={5} className={inputCls} value={commissionPerLot}
                      onChange={e => setCommissionPerLot(Number(e.target.value))} />
                  </FormField>
                  <FormField label="Slippage %">
                    <input type="number" min={0} step={0.05} className={inputCls} value={slippagePct}
                      onChange={e => setSlippagePct(Number(e.target.value))} />
                  </FormField>
                </div>
              )}
            </div>

            {/* Date range */}
            <div className="border-t border-zinc-800 pt-3 flex flex-col gap-3">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Period</div>
              <FormField label="Start Date">
                <input type="date" className={inputCls} value={startDate}
                  onChange={e => setStartDate(e.target.value)} />
              </FormField>
              <FormField label="End Date">
                <input type="date" className={inputCls} value={endDate}
                  onChange={e => setEndDate(e.target.value)} />
              </FormField>
            </div>

            <button
              onClick={runBacktest}
              disabled={loading || legs.length === 0}
              className="mt-1 w-full py-2.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-oncolor transition-colors"
            >
              {loading ? 'Running...' : 'Run Backtest'}
            </button>

            {error && (
              <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md p-2 break-words">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Results ── */}
        <div className="flex-1 overflow-y-auto">
          {!result && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-zinc-600">
              <div className="text-5xl mb-4">📊</div>
              <div className="text-sm font-bold">Configure legs and run a backtest</div>
              <div className="text-xs mt-1">Year-wise returns, stats, equity curve, and full report appear here</div>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500">
              <div className="text-sm font-bold animate-pulse">Running backtest...</div>
              <div className="text-xs mt-2">Simulating {legs.length} leg{legs.length > 1 ? 's' : ''} across expiry cycles...</div>
            </div>
          )}

          {result && s && (
            <div className="p-5 flex flex-col gap-6">

              {/* ── Enhanced Stats ── */}
              <div>
                <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Overall Performance</div>
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
                  <StatCard
                    label="Overall Profit"
                    value={fmtPnl(s.total_pnl)}
                    color={s.total_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
                  />
                  <StatCard
                    label="No. of Trades"
                    value={String(s.traded_cycles)}
                    sub={`of ${s.total_cycles} cycles`}
                  />
                  <StatCard
                    label="Avg Profit / Trade"
                    value={fmtPnl(s.avg_pnl)}
                    color={s.avg_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
                  />
                  <StatCard
                    label="Win %"
                    value={`${s.win_rate.toFixed(1)}%`}
                    sub={`${s.wins} wins`}
                    color={s.win_rate >= 50 ? 'text-emerald-400' : 'text-red-400'}
                  />
                  <StatCard
                    label="Loss %"
                    value={`${(100 - s.win_rate).toFixed(1)}%`}
                    sub={`${s.losses} losses`}
                    color="text-red-400"
                  />
                  <StatCard
                    label="Avg Winning Trade"
                    value={fmtPnl(s.avg_win)}
                    color="text-emerald-400"
                  />
                  <StatCard
                    label="Avg Losing Trade"
                    value={`-₹${fmt(s.avg_loss)}`}
                    color="text-red-400"
                  />
                  <StatCard
                    label="Max Profit (Single)"
                    value={fmtPnl(s.max_win)}
                    color="text-emerald-400"
                  />
                  <StatCard
                    label="Max Loss (Single)"
                    value={fmtPnl(s.max_loss)}
                    color="text-red-400"
                  />
                  <StatCard
                    label="Max Drawdown"
                    value={`₹${fmt(s.max_drawdown)}`}
                    sub={s.max_drawdown_days != null ? `${s.max_drawdown_days} days` : undefined}
                    color="text-amber-400"
                  />
                  <StatCard
                    label="Return / Max DD"
                    value={s.return_maxdd_ratio != null ? s.return_maxdd_ratio.toFixed(2) : '—'}
                    color={s.return_maxdd_ratio != null && s.return_maxdd_ratio >= 1 ? 'text-emerald-400' : 'text-zinc-400'}
                  />
                  <StatCard
                    label="Reward : Risk"
                    value={s.reward_risk_ratio != null ? s.reward_risk_ratio.toFixed(2) : '—'}
                    color={s.reward_risk_ratio != null && s.reward_risk_ratio >= 1 ? 'text-emerald-400' : 'text-zinc-400'}
                  />
                  <StatCard
                    label="Expectancy Ratio"
                    value={s.expectancy_ratio != null ? s.expectancy_ratio.toFixed(2) : '—'}
                    color={s.expectancy_ratio != null && s.expectancy_ratio >= 0 ? 'text-emerald-400' : 'text-red-400'}
                  />
                  <StatCard
                    label="Max Win Streak"
                    value={String(s.max_win_streak)}
                    color="text-emerald-400"
                  />
                  <StatCard
                    label="Max Loss Streak"
                    value={String(s.max_loss_streak)}
                    color="text-red-400"
                  />
                  <StatCard
                    label="Max Trades in DD"
                    value={String(s.max_trades_in_drawdown)}
                    color="text-amber-400"
                  />
                  <StatCard
                    label="Commission Paid"
                    value={`₹${fmt(s.commission_paid)}`}
                    color="text-zinc-400"
                  />
                </div>
              </div>

              {/* ── Year-wise Returns ── */}
              {Object.keys(result.monthly_pnl).length > 0 && (
                <div>
                  <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Year-wise Returns</div>
                  <YearwiseTable monthlyPnl={result.monthly_pnl} equityCurve={result.equity_curve} />
                </div>
              )}

              {/* ── Equity Curve, Underlying Value & Drawdown ── */}
              <BacktestCharts equityCurve={result.equity_curve} />

              {/* ── Full Report ── */}
              <div>
                <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
                  Full Report ({result.cycles.filter(c => c.exit_reason !== 'NO_ENTRY').length} trades)
                </div>
                <FullReportTable cycles={result.cycles} lotSize={lotSize} />
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
