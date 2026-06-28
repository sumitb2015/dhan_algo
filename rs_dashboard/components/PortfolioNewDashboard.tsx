'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  PlusCircle, RefreshCw, X, Edit2, Trash2,
  TrendingUp, TrendingDown, Wallet, Building2, Coins,
  Landmark, Gem, Bitcoin, PiggyBank, BarChart3, HelpCircle, Settings,
} from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip as ReTooltip, ResponsiveContainer, Legend } from 'recharts';
import NavBar from './NavBar';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

type AssetCategory =
  | 'FD' | 'PPF' | 'EPF' | 'NPS' | 'Gold' | 'SGBond'
  | 'RealEstate' | 'Crypto' | 'Savings' | 'MutualFund' | 'Other';

interface ManualInvestment {
  id: string;
  name: string;
  category: AssetCategory;
  investedAmount: number;
  currentValue: number;
  interestRate?: number;
  startDate?: string;
  maturityDate?: string;
  notes?: string;
  createdAt: string;
}

interface HoldingsSummary {
  totalInvested: number;
  totalCurrentValue: number;
  totalPnl: number;
  totalPnlPct: number;
  availableFunds: number;
}

interface MutualFund {
  name: string;
  amc?: string;
  category?: string;
  units: number;
  nav: number;
  investedValue: number;
}

interface AllocationEntry { name: string; value: number; color: string }

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<AssetCategory, string> = {
  FD: 'Fixed Deposit', PPF: 'Public Provident Fund', EPF: 'Emp. Provident Fund',
  NPS: 'National Pension Sys.', Gold: 'Gold / Jewellery', SGBond: 'Sovereign Gold Bond',
  RealEstate: 'Real Estate', Crypto: 'Cryptocurrency', Savings: 'Savings Account',
  MutualFund: 'Mutual Fund', Other: 'Other',
};

const CATEGORY_GROUP: Record<AssetCategory, string> = {
  FD: 'Fixed Income', PPF: 'Fixed Income', EPF: 'Fixed Income', NPS: 'Fixed Income',
  Savings: 'Cash & Savings', Gold: 'Alternatives', SGBond: 'Alternatives',
  RealEstate: 'Alternatives', Crypto: 'Crypto', MutualFund: 'Mutual Funds', Other: 'Other',
};

const CATEGORY_ICON: Record<AssetCategory, React.ReactNode> = {
  FD: <Landmark size={13} />, PPF: <PiggyBank size={13} />, EPF: <Wallet size={13} />,
  NPS: <BarChart3 size={13} />, Gold: <Gem size={13} />, SGBond: <Coins size={13} />,
  RealEstate: <Building2 size={13} />, Crypto: <Bitcoin size={13} />,
  Savings: <Wallet size={13} />, MutualFund: <BarChart3 size={13} />, Other: <HelpCircle size={13} />,
};

const ASSET_CLASS_COLORS: Record<string, string> = {
  'Equity': '#10b981',
  'Mutual Funds': '#6366f1',
  'Fixed Income': '#f59e0b',
  'Cash & Savings': '#64748b',
  'Alternatives': '#8b5cf6',
  'Crypto': '#ec4899',
  'Other': '#71717a',
};

const CATEGORIES: AssetCategory[] = ['FD', 'MutualFund', 'PPF', 'EPF', 'NPS', 'Gold', 'SGBond', 'RealEstate', 'Crypto', 'Savings', 'Other'];

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtINR(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  if (Math.abs(n) >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

function fmtINRFull(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

// ─── Empty Form State ─────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: '', category: 'FD' as AssetCategory, investedAmount: '',
  currentValue: '', interestRate: '', startDate: '', maturityDate: '', notes: '',
};

// Quarterly compounding: A = P × (1 + r/(4×100))^(4×years)
function computeFDMaturity(principal: number, ratePercent: number, startDate: string, maturityDate: string): number | null {
  const p = principal;
  const r = ratePercent;
  const start = new Date(startDate);
  const end = new Date(maturityDate);
  const years = (end.getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (p <= 0 || r <= 0 || years <= 0) return null;
  return p * Math.pow(1 + r / 400, 4 * years);
}

// Current accrued value of an FD as of today
function computeFDCurrentAccrued(principal: number, ratePercent: number, startDate: string, maturityDate: string): number | null {
  const start = new Date(startDate);
  const end = new Date(maturityDate);
  const today = new Date();
  const clampedEnd = today < end ? today : end;
  const years = (clampedEnd.getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (principal <= 0 || ratePercent <= 0 || years < 0) return null;
  return principal * Math.pow(1 + ratePercent / 400, 4 * Math.max(0, years));
}

// ─── Add/Edit Panel ───────────────────────────────────────────────────────────

function InvestmentPanel({
  editing, onSave, onClose,
}: {
  editing: ManualInvestment | null;
  onSave: (inv: ManualInvestment) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [fdComputed, setFdComputed] = useState<{ maturity: number; accrued: number } | null>(null);

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name,
        category: editing.category,
        investedAmount: String(editing.investedAmount),
        currentValue: String(editing.currentValue),
        interestRate: String(editing.interestRate ?? ''),
        startDate: editing.startDate ?? '',
        maturityDate: editing.maturityDate ?? '',
        notes: editing.notes ?? '',
      });
    } else {
      setForm({ ...EMPTY_FORM });
    }
  }, [editing]);

  // Auto-compute FD maturity value whenever relevant fields change
  useEffect(() => {
    if (form.category !== 'FD') { setFdComputed(null); return; }
    const p = parseFloat(form.investedAmount);
    const r = parseFloat(form.interestRate);
    if (!form.startDate || !form.maturityDate || !p || !r) { setFdComputed(null); return; }
    const maturity = computeFDMaturity(p, r, form.startDate, form.maturityDate);
    const accrued = computeFDCurrentAccrued(p, r, form.startDate, form.maturityDate);
    if (maturity !== null && accrued !== null) {
      setFdComputed({ maturity, accrued });
      setForm(prev => ({ ...prev, currentValue: maturity.toFixed(2) }));
    } else {
      setFdComputed(null);
    }
  }, [form.category, form.investedAmount, form.interestRate, form.startDate, form.maturityDate]);

  const isFD = form.category === 'FD';
  const isMF = form.category === 'MutualFund';
  const isSavings = form.category === 'Savings';

  function handleSave() {
    const inv: ManualInvestment = {
      id: editing?.id ?? crypto.randomUUID(),
      name: form.name.trim(),
      category: form.category,
      currentValue: parseFloat(form.currentValue) || 0,
      investedAmount: isSavings ? (parseFloat(form.currentValue) || 0) : (parseFloat(form.investedAmount) || 0),
      interestRate: form.interestRate ? parseFloat(form.interestRate) : undefined,
      startDate: form.startDate || undefined,
      maturityDate: form.maturityDate || undefined,
      notes: form.notes.trim() || undefined,
      createdAt: editing?.createdAt ?? new Date().toISOString(),
    };
    if (!inv.name) return;
    onSave(inv);
  }

  const field = (label: string, key: keyof typeof form, type = 'text', placeholder = '') => (
    <div className="space-y-1">
      <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{label}</label>
      <input
        type={type}
        value={form[key] as string}
        onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
        placeholder={placeholder}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="w-80 bg-zinc-950 border-l border-zinc-800 flex flex-col h-full overflow-y-auto">
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900">
          <span className="text-xs font-bold uppercase tracking-widest text-amber-400">
            {editing ? 'Edit Investment' : 'Add Investment'}
          </span>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-3 flex-1">
          {field('Name', 'name', 'text', 'e.g. SBI FD 2025')}

          {/* Category */}
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Category</label>
            <select
              value={form.category}
              onChange={e => setForm(p => ({ ...p, category: e.target.value as AssetCategory }))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-amber-500/60"
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
              ))}
            </select>
          </div>

          {!isSavings && field('Invested Amount (₹)', 'investedAmount', 'number', '0')}

          {/* FD-only fields */}
          {isFD && field('Interest Rate (% p.a.)', 'interestRate', 'number', 'e.g. 7.5')}
          {isFD && (
            <>
              {field('Start Date', 'startDate', 'date')}
              {field('Maturity Date', 'maturityDate', 'date')}
            </>
          )}

          {/* Current Value — auto-filled for FD */}
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
              {isFD ? 'Maturity Value (₹)' : 'Current Value (₹)'}
            </label>
            <input
              type="number"
              value={form.currentValue}
              onChange={e => setForm(p => ({ ...p, currentValue: e.target.value }))}
              readOnly={isFD && fdComputed !== null}
              placeholder="0"
              className={cn(
                'w-full bg-zinc-800 border rounded px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none',
                isFD && fdComputed !== null
                  ? 'border-amber-500/50 text-amber-300 cursor-default focus:border-amber-500/50'
                  : 'border-zinc-700 focus:border-amber-500/60',
              )}
            />
            {isFD && fdComputed !== null && (
              <div className="space-y-0.5 pt-0.5">
                <div className="text-[10px] font-mono text-amber-400">
                  Maturity: {fmtINRFull(fdComputed.maturity)} · Interest: {fmtINRFull(fdComputed.maturity - parseFloat(form.investedAmount))}
                </div>
                <div className="text-[10px] font-mono text-zinc-500">
                  Accrued today: {fmtINRFull(fdComputed.accrued)}
                </div>
              </div>
            )}
            {isFD && !fdComputed && (
              <div className="text-[10px] text-zinc-600">Fill in principal, rate, start & maturity date to auto-compute</div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              rows={2}
              placeholder="Optional notes..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60 resize-none"
            />
          </div>
        </div>

        <div className="p-4 border-t border-zinc-800 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-xs font-semibold rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!form.name.trim()}
            className="flex-1 px-3 py-2 text-xs font-bold rounded bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {editing ? 'Update' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Metric Tile ──────────────────────────────────────────────────────────────

function MetricTile({
  label, value, pct, subLabel, color, icon,
}: {
  label: string; value: string; pct?: number; subLabel?: string; color: string; icon?: React.ReactNode;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span style={{ color }} className="opacity-80">{icon}</span>
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{label}</span>
      </div>
      <span className="font-mono text-lg font-bold text-zinc-100 leading-tight">{value}</span>
      {pct !== undefined && (
        <span className={cn('text-[11px] font-semibold font-mono', pct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {fmtPct(pct)}
        </span>
      )}
      {subLabel && <span className="text-[10px] text-zinc-600">{subLabel}</span>}
    </div>
  );
}

// ─── Custom Pie Tooltip ───────────────────────────────────────────────────────

function PieTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const { name, value, payload: d } = payload[0];
  const total = d?.total ?? 1;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs font-mono shadow-xl">
      <div className="font-bold text-zinc-100">{name}</div>
      <div className="text-amber-400">{fmtINR(value)}</div>
      <div className="text-zinc-500">{((value / total) * 100).toFixed(1)}%</div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function PortfolioNewDashboard() {
  const [equity, setEquity] = useState<HoldingsSummary | null>(null);
  const [mutualFunds, setMutualFunds] = useState<MutualFund[]>([]);
  const [investments, setInvestments] = useState<ManualInvestment[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [editing, setEditing] = useState<ManualInvestment | null>(null);
  const [now, setNow] = useState(new Date());

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ─── Fetch ────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [holdingsRes, mfRes, settingsRes] = await Promise.allSettled([
        fetch('/api/portfolio-holdings').then(r => r.json()),
        fetch('/api/mutual-funds').then(r => r.json()),
        fetch('/api/portfolio-settings').then(r => r.json()),
      ]);

      if (holdingsRes.status === 'fulfilled' && holdingsRes.value?.success) {
        const d = holdingsRes.value;
        setEquity({
          totalInvested: d.summary?.totalInvested ?? 0,
          totalCurrentValue: d.summary?.totalCurrentValue ?? 0,
          totalPnl: d.summary?.totalPnl ?? 0,
          totalPnlPct: d.summary?.totalPnlPct ?? 0,
          availableFunds: d.available_funds ?? 0,
        });
      }

      if (mfRes.status === 'fulfilled' && Array.isArray(mfRes.value)) {
        setMutualFunds(mfRes.value);
      }

      if (settingsRes.status === 'fulfilled' && Array.isArray(settingsRes.value)) {
        setInvestments(settingsRes.value);
      }

      setLastUpdated(new Date());
    } catch (e) {
      console.error('Fetch error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ─── Persist Investments ─────────────────────────────────────────────────

  const persistInvestments = useCallback(async (list: ManualInvestment[]) => {
    setInvestments(list);
    await fetch('/api/portfolio-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list),
    });
  }, []);

  function handleSave(inv: ManualInvestment) {
    const updated = editing
      ? investments.map(x => x.id === inv.id ? inv : x)
      : [...investments, inv];
    persistInvestments(updated);
    setShowPanel(false);
    setEditing(null);
  }

  function handleDelete(id: string) {
    persistInvestments(investments.filter(x => x.id !== id));
  }

  // ─── Computed Aggregates ──────────────────────────────────────────────────

  const equityValue = equity?.totalCurrentValue ?? 0;
  const equityInvested = equity?.totalInvested ?? 0;

  const mfValue = mutualFunds.reduce((sum, mf) => {
    const cv = mf.nav > 0 ? mf.units * mf.nav : mf.investedValue;
    return sum + cv;
  }, 0);
  const mfInvested = mutualFunds.reduce((s, mf) => s + mf.investedValue, 0);

  // Group manual investments by asset class
  const manualByClass: Record<string, { invested: number; current: number }> = {};
  for (const inv of investments) {
    const grp = CATEGORY_GROUP[inv.category];
    if (!manualByClass[grp]) manualByClass[grp] = { invested: 0, current: 0 };
    manualByClass[grp].invested += inv.investedAmount;
    manualByClass[grp].current += inv.currentValue;
  }

  const manualCurrentTotal = Object.values(manualByClass).reduce((s, g) => s + g.current, 0);
  const manualInvestedTotal = Object.values(manualByClass).reduce((s, g) => s + g.invested, 0);

  const EXCLUDED_FROM_ALT = new Set(['Fixed Income', 'Mutual Funds']);
  const altCurrent = Object.entries(manualByClass)
    .filter(([grp]) => !EXCLUDED_FROM_ALT.has(grp))
    .reduce((s, [, v]) => s + v.current, 0);
  const altInvested = Object.entries(manualByClass)
    .filter(([grp]) => !EXCLUDED_FROM_ALT.has(grp))
    .reduce((s, [, v]) => s + v.invested, 0);

  const totalCurrentValue = equityValue + mfValue + manualCurrentTotal;
  const totalInvested = equityInvested + mfInvested + manualInvestedTotal;
  const totalPnl = totalCurrentValue - totalInvested;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  // Allocation chart data — merge auto-fetched MF + any manually added MutualFund entries
  const manualMFValue = manualByClass['Mutual Funds']?.current ?? 0;
  const combinedMFValue = mfValue + manualMFValue;
  const allocationData: AllocationEntry[] = [];
  if (equityValue > 0) allocationData.push({ name: 'Equity', value: equityValue, color: ASSET_CLASS_COLORS['Equity'] });
  if (combinedMFValue > 0) allocationData.push({ name: 'Mutual Funds', value: combinedMFValue, color: ASSET_CLASS_COLORS['Mutual Funds'] });
  for (const [grp, vals] of Object.entries(manualByClass)) {
    if (grp === 'Mutual Funds') continue; // already merged above
    if (vals.current > 0) allocationData.push({ name: grp, value: vals.current, color: ASSET_CLASS_COLORS[grp] ?? '#71717a' });
  }
  const allocationTotal = allocationData.reduce((s, d) => s + d.value, 0);
  // Inject total for tooltip percentage
  const allocationWithTotal = allocationData.map(d => ({ ...d, total: allocationTotal }));

  // Group manual investments by category for the table
  const investmentsByGroup: Record<string, ManualInvestment[]> = {};
  for (const inv of investments) {
    const grp = CATEGORY_GROUP[inv.category];
    if (!investmentsByGroup[grp]) investmentsByGroup[grp] = [];
    investmentsByGroup[grp].push(inv);
  }

  const pnlPositive = totalPnl >= 0;
  const availableCash = equity?.availableFunds ?? 0;

  // ─── Clock display ────────────────────────────────────────────────────────

  const timeStr = now.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Top nav */}
      <div className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2 flex items-center gap-3">
        <NavBar />
      </div>

      {/* Terminal header */}
      <div className="border-b border-zinc-800 bg-zinc-900 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold tracking-widest text-amber-500 uppercase font-mono">
            PORTFOLIO TERMINAL
          </span>
          <span className="w-px h-3 bg-zinc-700" />
          <span className="text-[10px] font-mono text-zinc-500">{dateStr}</span>
          <span className="text-[10px] font-mono text-amber-500/70">{timeStr}</span>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-600 font-mono">
              UPD {lastUpdated.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400 hover:text-amber-300 border border-amber-500/30 rounded hover:bg-amber-500/5 transition-all"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
            {loading ? 'LOADING' : 'REFRESH'}
          </button>
          <button
            onClick={() => { setEditing(null); setShowPanel(true); }}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400 hover:text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-500/5 transition-all"
          >
            <PlusCircle size={10} />
            ADD INVESTMENT
          </button>
        </div>
      </div>

      {/* Net Worth Hero */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-4">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-0.5">TOTAL NET WORTH</div>
            <div className="font-mono text-3xl font-bold text-amber-400 leading-none">
              {fmtINR(totalCurrentValue)}
            </div>
            <div className="text-[11px] font-mono text-zinc-500 mt-1">{fmtINRFull(totalCurrentValue)}</div>
          </div>
          <div className="pb-1">
            <div className={cn(
              'flex items-center gap-1 text-sm font-mono font-bold',
              pnlPositive ? 'text-emerald-400' : 'text-red-400',
            )}>
              {pnlPositive ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
              {pnlPositive ? '+' : ''}{fmtINR(totalPnl)} ({fmtPct(totalPnlPct)})
            </div>
            <div className="text-[10px] text-zinc-600 font-mono mt-0.5">vs invested {fmtINR(totalInvested)}</div>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">

        {/* Summary Tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricTile
            label="Equity Holdings"
            value={fmtINR(equityValue)}
            pct={equityInvested > 0 ? ((equityValue - equityInvested) / equityInvested) * 100 : 0}
            subLabel={`inv ${fmtINR(equityInvested)}`}
            color="#10b981"
            icon={<TrendingUp size={12} />}
          />
          <MetricTile
            label="Mutual Funds"
            value={fmtINR(combinedMFValue)}
            pct={(mfInvested + (manualByClass['Mutual Funds']?.invested ?? 0)) > 0 ? ((combinedMFValue - mfInvested - (manualByClass['Mutual Funds']?.invested ?? 0)) / (mfInvested + (manualByClass['Mutual Funds']?.invested ?? 0))) * 100 : 0}
            subLabel={`inv ${fmtINR(mfInvested + (manualByClass['Mutual Funds']?.invested ?? 0))}`}
            color="#6366f1"
            icon={<BarChart3 size={12} />}
          />
          <MetricTile
            label="Fixed Income"
            value={fmtINR(manualByClass['Fixed Income']?.current ?? 0)}
            pct={
              manualByClass['Fixed Income']?.invested
                ? ((manualByClass['Fixed Income'].current - manualByClass['Fixed Income'].invested) / manualByClass['Fixed Income'].invested) * 100
                : undefined
            }
            subLabel="FD · PPF · EPF · NPS"
            color="#f59e0b"
            icon={<Landmark size={12} />}
          />
          <MetricTile
            label="Alternatives"
            value={fmtINR(altCurrent)}
            pct={altInvested > 0 ? ((altCurrent - altInvested) / altInvested) * 100 : undefined}
            subLabel="Gold · RE · Crypto · Other"
            color="#8b5cf6"
            icon={<Gem size={12} />}
          />
        </div>

        {/* Middle Row: Allocation + Group Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

          {/* Donut chart */}
          <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">Allocation Split</span>
            </div>

            {allocationData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={allocationWithTotal}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={85}
                      strokeWidth={2}
                      stroke="#09090b"
                    >
                      {allocationWithTotal.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <ReTooltip content={<PieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>

                {/* Legend */}
                <div className="mt-2 space-y-1.5">
                  {allocationData.map(d => (
                    <div key={d.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
                        <span className="text-[11px] text-zinc-400">{d.name}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] font-mono">
                        <span className="text-zinc-300">{fmtINR(d.value)}</span>
                        <span className="text-zinc-600 w-9 text-right">
                          {allocationTotal > 0 ? ((d.value / allocationTotal) * 100).toFixed(1) : '0.0'}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="h-48 flex items-center justify-center text-zinc-600 text-xs">
                No data — refresh or add investments
              </div>
            )}
          </div>

          {/* Asset Class Breakdown */}
          <div className="lg:col-span-3 bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-amber-400 mb-3">Asset Class Breakdown</div>

            <div className="space-y-3">
              {allocationData.map(d => {
                const pct = allocationTotal > 0 ? (d.value / allocationTotal) * 100 : 0;
                return (
                  <div key={d.name}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-zinc-300 font-medium">{d.name}</span>
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-xs text-zinc-300">{fmtINR(d.value)}</span>
                        <span className="text-[11px] text-zinc-500 w-9 text-right">{pct.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: d.color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Quick stats */}
            {equity && (
              <div className="mt-4 pt-3 border-t border-zinc-800 grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">Equity P&amp;L</div>
                  <div className={cn('text-xs font-mono font-semibold', equity.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {equity.totalPnl >= 0 ? '+' : ''}{fmtINR(equity.totalPnl)}
                  </div>
                  <div className={cn('text-[10px] font-mono', equity.totalPnlPct >= 0 ? 'text-emerald-500/70' : 'text-red-500/70')}>
                    {fmtPct(equity.totalPnlPct)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">MF Value</div>
                  <div className="text-xs font-mono font-semibold text-indigo-400">{fmtINR(mfValue)}</div>
                  <div className={cn('text-[10px] font-mono', mfValue >= mfInvested ? 'text-emerald-500/70' : 'text-red-500/70')}>
                    {mfInvested > 0 ? fmtPct(((mfValue - mfInvested) / mfInvested) * 100) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">Manual Inv.</div>
                  <div className={cn('text-xs font-mono font-semibold', manualCurrentTotal >= manualInvestedTotal ? 'text-emerald-400' : 'text-red-400')}>
                    {fmtINR(manualCurrentTotal)}
                  </div>
                  <div className={cn('text-[10px] font-mono', manualCurrentTotal >= manualInvestedTotal ? 'text-emerald-500/70' : 'text-red-500/70')}>
                    {manualInvestedTotal > 0 ? fmtPct(((manualCurrentTotal - manualInvestedTotal) / manualInvestedTotal) * 100) : '—'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Manual Investments Table */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
            <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
              Manual Investments
            </span>
            <button
              onClick={() => { setEditing(null); setShowPanel(true); }}
              className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              <PlusCircle size={11} /> ADD
            </button>
          </div>

          {investments.length === 0 ? (
            <div className="px-4 py-8 text-center text-zinc-600 text-xs">
              No investments added yet. Click <span className="text-amber-400">ADD INVESTMENT</span> to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-zinc-800 border-b border-zinc-700">
                    {['Name', 'Category', 'Invested', 'Current Value', 'Gain / Loss', 'Rate', 'Maturity', ''].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-[10px] font-bold text-white uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {investments.map((inv, i) => {
                    const gain = inv.currentValue - inv.investedAmount;
                    const gainPct = inv.investedAmount > 0 ? (gain / inv.investedAmount) * 100 : 0;
                    // For FD: compute current accrued value (value today if broken prematurely)
                    const fdAccrued = inv.category === 'FD' && inv.startDate && inv.maturityDate && inv.interestRate
                      ? computeFDCurrentAccrued(inv.investedAmount, inv.interestRate, inv.startDate, inv.maturityDate)
                      : null;
                    const isMature = inv.category === 'FD' && inv.maturityDate
                      ? new Date(inv.maturityDate) <= new Date()
                      : false;
                    return (
                      <tr
                        key={inv.id}
                        className={cn(
                          'border-b border-zinc-800/60 hover:bg-zinc-800/40 transition-colors',
                          i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-900/50',
                        )}
                      >
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-zinc-100">{inv.name}</div>
                          {inv.notes && <div className="text-zinc-600 text-[10px]">{inv.notes}</div>}
                          {inv.category === 'FD' && isMature && (
                            <div className="text-[10px] text-amber-400">Matured</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1 text-zinc-400">
                            <span className="opacity-70">{CATEGORY_ICON[inv.category]}</span>
                            <span className="whitespace-nowrap">{CATEGORY_LABEL[inv.category]}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-zinc-300 whitespace-nowrap">{fmtINR(inv.investedAmount)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="font-mono font-semibold text-zinc-100">{fmtINR(inv.currentValue)}</div>
                          {fdAccrued !== null && !isMature && (
                            <div className="text-[10px] font-mono text-zinc-500">
                              accrued {fmtINR(fdAccrued)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className={cn('font-mono font-semibold', gain >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {gain >= 0 ? '+' : ''}{fmtINR(gain)}
                          </div>
                          <div className={cn('text-[10px] font-mono', gain >= 0 ? 'text-emerald-500/70' : 'text-red-500/70')}>
                            {fmtPct(gainPct)}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-zinc-400 whitespace-nowrap">
                          {inv.interestRate ? `${inv.interestRate}% p.a.` : '—'}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-zinc-400 whitespace-nowrap text-[11px]">
                          {inv.maturityDate
                            ? new Date(inv.maturityDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                            : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => { setEditing(inv); setShowPanel(true); }}
                              className="text-zinc-600 hover:text-amber-400 transition-colors"
                            >
                              <Edit2 size={12} />
                            </button>
                            <button
                              onClick={() => handleDelete(inv.id)}
                              className="text-zinc-600 hover:text-red-400 transition-colors"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {investments.length > 0 && (
                  <tfoot>
                    <tr className="bg-zinc-800/60 border-t border-zinc-700">
                      <td colSpan={2} className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">TOTAL</td>
                      <td className="px-3 py-2 font-mono font-bold text-zinc-300 whitespace-nowrap">{fmtINR(manualInvestedTotal)}</td>
                      <td className="px-3 py-2 font-mono font-bold text-zinc-100 whitespace-nowrap">{fmtINR(manualCurrentTotal)}</td>
                      <td className="px-3 py-2">
                        <div className={cn('font-mono font-bold whitespace-nowrap', manualCurrentTotal >= manualInvestedTotal ? 'text-emerald-400' : 'text-red-400')}>
                          {manualCurrentTotal >= manualInvestedTotal ? '+' : ''}{fmtINR(manualCurrentTotal - manualInvestedTotal)}
                        </div>
                        <div className={cn('text-[10px] font-mono', manualCurrentTotal >= manualInvestedTotal ? 'text-emerald-500/70' : 'text-red-500/70')}>
                          {manualInvestedTotal > 0 ? fmtPct(((manualCurrentTotal - manualInvestedTotal) / manualInvestedTotal) * 100) : '—'}
                        </div>
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>

        {/* Bottom: Mutual Funds Summary */}
        {mutualFunds.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-zinc-800">
              <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">Mutual Funds</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-zinc-800 border-b border-zinc-700">
                    {['Fund Name', 'Category', 'Units', 'NAV', 'Current Value', 'Invested', 'Gain / Loss'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-[10px] font-bold text-white uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mutualFunds.map((mf, i) => {
                    const cv = mf.nav > 0 ? mf.units * mf.nav : mf.investedValue;
                    const gain = cv - mf.investedValue;
                    const gainPct = mf.investedValue > 0 ? (gain / mf.investedValue) * 100 : 0;
                    return (
                      <tr
                        key={i}
                        className={cn(
                          'border-b border-zinc-800/60 hover:bg-zinc-800/40 transition-colors',
                          i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-900/50',
                        )}
                      >
                        <td className="px-3 py-2.5 font-medium text-zinc-100 max-w-48">
                          <div className="truncate">{mf.name}</div>
                          {mf.amc && <div className="text-zinc-600 text-[10px]">{mf.amc}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-zinc-400">{mf.category ?? '—'}</td>
                        <td className="px-3 py-2.5 font-mono text-zinc-300">{mf.units.toFixed(3)}</td>
                        <td className="px-3 py-2.5 font-mono text-zinc-300">{mf.nav > 0 ? `₹${mf.nav.toFixed(2)}` : '—'}</td>
                        <td className="px-3 py-2.5 font-mono font-semibold text-zinc-100 whitespace-nowrap">{fmtINR(cv)}</td>
                        <td className="px-3 py-2.5 font-mono text-zinc-400 whitespace-nowrap">{fmtINR(mf.investedValue)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className={cn('font-mono font-semibold', gain >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {gain >= 0 ? '+' : ''}{fmtINR(gain)}
                          </div>
                          <div className={cn('text-[10px] font-mono', gain >= 0 ? 'text-emerald-500/70' : 'text-red-500/70')}>
                            {fmtPct(gainPct)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Settings Slide-in Panel */}
      {showPanel && (
        <InvestmentPanel
          editing={editing}
          onSave={handleSave}
          onClose={() => { setShowPanel(false); setEditing(null); }}
        />
      )}
    </div>
  );
}
