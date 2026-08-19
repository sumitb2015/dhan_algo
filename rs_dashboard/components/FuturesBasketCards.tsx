'use client';

import React, { useEffect, useState } from 'react';
import { TrendingUp, Landmark, Building2, TrendingDown, Loader2 } from 'lucide-react';
import type { BasketStats, FuturesOiBasketsResponse } from '@/app/api/futures-oi-baskets/route';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCr(v: number): string {
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' Cr';
}

function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

function fmtDate(d: string): string {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
}

// ─── Basket meta (icon + accent per index) ─────────────────────────────────────

const BASKET_META: Record<string, { icon: React.ElementType; accent: string; chip: string }> = {
  nifty50:   { icon: TrendingUp, accent: 'border-emerald-500/20', chip: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' },
  sensex:    { icon: Landmark,   accent: 'border-amber-500/20',   chip: 'bg-amber-500/10 text-amber-400 border-amber-500/25' },
  banknifty: { icon: Building2,  accent: 'border-sky-500/20',     chip: 'bg-sky-500/10 text-sky-400 border-sky-500/25' },
};

// ─── Card ─────────────────────────────────────────────────────────────────────

function BasketCard({ basket, dataDate }: { basket: BasketStats; dataDate: string }) {
  const meta = BASKET_META[basket.key] ?? BASKET_META.nifty50;
  const Icon = meta.icon;

  return (
    <div className={`rounded-2xl border bg-zinc-900/60 p-5 flex-1 min-w-[280px] ${meta.accent}`}>
      <div className="flex items-center justify-between mb-1">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border ${meta.chip}`}>
          <Icon className="h-3 w-3" />
          {basket.label}
        </span>
      </div>
      <p className="text-[10px] text-zinc-500 font-mono tabular-nums mb-4">{fmtDate(dataDate)}</p>

      <div className="mb-4">
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-1">Futures turnover</p>
        <p className="text-2xl font-mono font-bold text-white tabular-nums leading-none">{fmtCr(basket.turnoverCr)}</p>
        {basket.turnoverChgPct !== null && (
          <span className={`inline-flex items-center gap-1 mt-1.5 text-[10px] font-bold ${basket.turnoverChgPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {basket.turnoverChgPct >= 0 ? '↑' : '↓'} {fmtPct(Math.abs(basket.turnoverChgPct))} vs prior
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-red-500/10 text-red-400 border border-red-500/20">
          <TrendingDown className="h-3 w-3" />
          Short Buildup · {basket.shortBuildupCount}/{basket.totalScanned}
        </span>
      </div>

      <div>
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-1.5">Largest OI additions</p>
        <div className="flex flex-wrap gap-1.5">
          {basket.largestOiAdditions.length === 0 ? (
            <span className="text-[11px] text-zinc-600">—</span>
          ) : basket.largestOiAdditions.map(sym => (
            <span key={sym} className="px-2 py-0.5 rounded-md text-[10px] font-semibold font-mono bg-zinc-800 text-zinc-200 border border-zinc-700">
              {sym}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

export default function FuturesBasketCards({ refreshKey }: { refreshKey?: number }) {
  const [data, setData]       = useState<FuturesOiBasketsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/futures-oi-baskets')
      .then(res => res.json())
      .then((json: FuturesOiBasketsResponse) => { if (!cancelled) setData(json); })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-8 gap-2 text-zinc-500 text-xs">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading index basket stats…
      </div>
    );
  }

  if (!data?.success || data.baskets.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-5 py-4 text-xs text-zinc-500">
        {data?.error ?? 'No stock futures OI snapshot available yet.'}
      </div>
    );
  }

  return (
    <div className="flex gap-4 flex-wrap">
      {data.baskets.map(basket => (
        <BasketCard key={basket.key} basket={basket} dataDate={data.dataDate} />
      ))}
    </div>
  );
}
