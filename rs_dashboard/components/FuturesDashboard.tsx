'use client';

import React, { useState, useEffect, useCallback } from 'react';
import NavBar from '@/components/NavBar';
import { Activity, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import type { ContractStats, FuturesResponse } from '@/app/api/futures/route';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtLakh(v: number): string {
  if (v >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
  if (v >= 100000) return (v / 100000).toFixed(1) + 'L';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtChange(v: number): string {
  return (v >= 0 ? '+' : '-') + fmtLakh(Math.abs(v));
}

function fmtBasis(v: number | null): string {
  if (v === null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function oiChangeColor(v: number): string {
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-400';
}

function basisColor(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function dteColor(days: number): string {
  if (days <= 5) return 'text-red-400 font-bold';
  if (days <= 15) return 'text-amber-400';
  return 'text-zinc-300';
}

// ─── OI Sparkline ─────────────────────────────────────────────────────────────

function OISparkline({ data }: { data: { time: string; oi: number }[] }) {
  if (data.length < 2) return (
    <div className="h-20 flex items-center justify-center text-[11px] text-zinc-600">
      Not enough data for sparkline
    </div>
  );

  const W = 500;
  const H = 80;
  const pad = 6;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;

  const oiVals = data.map(d => d.oi);
  const minOI = Math.min(...oiVals);
  const maxOI = Math.max(...oiVals);
  const range = maxOI - minOI || 1;

  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * innerW;
    const y = pad + innerH - ((d.oi - minOI) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: 80 }}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Contract card ────────────────────────────────────────────────────────────

function ContractCard({
  name,
  contracts,
}: {
  name: string;
  contracts: ContractStats[];
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const contract = contracts[activeIdx] ?? contracts[0];

  if (!contract) {
    return (
      <div className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 flex items-center justify-center text-zinc-500 text-sm">
        No {name} data
      </div>
    );
  }

  const tabLabels = ['Near', 'Mid', 'Far'];

  return (
    <div className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 min-w-[320px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-base font-bold text-zinc-100">{name}</span>
        {/* Contract tabs */}
        <div className="flex items-center gap-1 p-0.5 bg-zinc-950/60 border border-zinc-800 rounded-xl">
          {contracts.map((c, i) => (
            <button
              key={c.expiry}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 text-[11px] font-semibold rounded-lg transition-all ${
                activeIdx === i
                  ? 'bg-sky-500/15 text-sky-400 border border-sky-500/25'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {c.label}
              <span className="ml-1 opacity-50 text-[10px]">{tabLabels[i] ?? ''}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Price — prominent */}
      <div className="mb-4">
        <div className="text-3xl font-bold text-white tracking-tight">
          {fmtPrice(contract.price)}
        </div>
        <div className={`text-[11px] mt-0.5 ${dteColor(contract.daysToExpiry)}`}>
          Expiry {contract.expiry} · {contract.daysToExpiry}d left
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5">
        <StatRow label="Open" value={fmtPrice(contract.open)} />
        <StatRow label="High" value={fmtPrice(contract.high)} valueClass="text-emerald-300" />
        <StatRow label="Low" value={fmtPrice(contract.low)} valueClass="text-red-400" />
        <StatRow label="Volume" value={fmtLakh(contract.volume)} />
        <StatRow
          label="OI"
          value={contract.oiHasData ? fmtLakh(contract.oi) : '—'}
          valueClass={contract.oiHasData ? 'text-zinc-100' : 'text-zinc-600'}
        />
        <StatRow
          label="OI Change"
          value={contract.oiHasData ? fmtChange(contract.oiChange) : '—'}
          valueClass={contract.oiHasData ? oiChangeColor(contract.oiChange) : 'text-zinc-600'}
        />
        <StatRow
          label="Basis"
          value={fmtBasis(contract.basis)}
          valueClass={basisColor(contract.basis)}
        />
        <StatRow
          label="Expiry"
          value={contract.expiry}
          valueClass="text-zinc-300"
        />
      </div>

      {/* OI Sparkline */}
      <div className="border-t border-zinc-800 pt-3">
        <div className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-1.5">
          Intraday OI
        </div>
        {contract.oiHasData ? (
          <OISparkline data={contract.sparkline} />
        ) : (
          <div className="h-20 flex items-center justify-center text-[11px] text-zinc-600 text-center px-4">
            OI data not available — re-run <code className="text-zinc-500 mx-1">download_futures_manual.py</code> to fetch OI
          </div>
        )}
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  valueClass = 'text-zinc-100',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-zinc-500 shrink-0">{label}</span>
      <span className={`text-[12px] font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function FuturesDashboard() {
  const [data, setData] = useState<FuturesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/futures');
      const json: FuturesResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'API error');
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">

      {/* Header */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/10">
            <Activity className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Futures Monitor
            </h1>
            {data?.dataDate && (
              <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
                DATA: {data.dataDate}
              </p>
            )}
          </div>
        </div>

        <NavBar />

        <button
          onClick={fetchData}
          disabled={loading}
          className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 disabled:opacity-40 ml-auto"
          title="Reload data"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {/* Body */}
      <main className="flex-1 px-5 py-6 max-w-screen-xl mx-auto w-full">
        {loading ? (
          <div className="flex items-center justify-center py-32 gap-2 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading futures data…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-32 gap-3 text-red-400">
            <AlertCircle className="h-8 w-8" />
            <span className="text-sm text-center max-w-md">{error}</span>
          </div>
        ) : data ? (
          <div className="flex gap-5 flex-wrap">
            <ContractCard name="NIFTY" contracts={data.instruments.NIFTY} />
            <ContractCard name="BANKNIFTY" contracts={data.instruments.BANKNIFTY} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
