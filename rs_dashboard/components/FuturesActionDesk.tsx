'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Zap,
  Target,
  Shield,
  TrendingUp,
  TrendingDown,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
  Flame,
  Check,
  Copy,
  SlidersHorizontal,
  ChevronRight,
  BarChart3,
  Layers,
} from 'lucide-react';
import type { ContractStats } from '@/app/api/futures/route';
import type { OIRow } from '@/app/api/futures-oi/route';

interface FuturesActionDeskProps {
  niftyNear?: ContractStats;
  bankniftyNear?: ContractStats;
  longBuildup: OIRow[];
  shortBuildup: OIRow[];
  shortCovering: OIRow[];
  longUnwinding: OIRow[];
  onOpenPlaybook: () => void;
}

interface ActionableSetup {
  id: string;
  symbol: string;
  category: 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING';
  title: string;
  direction: 'BULLISH' | 'BEARISH';
  price: number;
  priceChgPct: number;
  oi: number;
  oiChgPct: number;
  conviction: 'HIGH' | 'MODERATE';
  action: string;
  entryTrigger: string;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: string;
  optionsPlay: string;
  accent: string;
  badgeCls: string;
}

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

function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ─── Index Intraday Command Card ──────────────────────────────────────────────

function IndexCommandCard({
  name,
  contract,
}: {
  name: 'NIFTY' | 'BANKNIFTY';
  contract?: ContractStats;
}) {
  if (!contract) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col justify-center items-center text-zinc-500">
        <p className="text-xs">No active contract data for {name}</p>
      </div>
    );
  }

  const { price, open, high, low, basis, coc, oiChange } = contract;

  // Compute Pivots:
  const pp = (high + low + price) / 3;
  const r1 = 2 * pp - low;
  const s1 = 2 * pp - high;
  const r2 = pp + (high - low);
  const s2 = pp - (high - low);
  const dayRange = high - low;
  const rangePosPct = dayRange > 0 ? Math.max(0, Math.min(100, ((price - low) / dayRange) * 100)) : 50;

  // Algorithmic Bias Assessment:
  const isPriceUp = price >= open;
  const isOiBuilding = oiChange > 0;
  const isContango = basis !== null && basis > 0;

  let bias: { label: string; cls: string; desc: string; dir: 'BULLISH' | 'BEARISH' | 'NEUTRAL' } = {
    label: 'Rangebound Chop',
    cls: 'bg-zinc-800 text-zinc-300 border-zinc-700',
    desc: 'Price oscillating within intraday pivot range. Await breakout confirmation.',
    dir: 'NEUTRAL',
  };

  if (isPriceUp && isOiBuilding && isContango) {
    bias = {
      label: 'Strong Bullish (Long Buildup)',
      cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
      desc: 'Price expanding with fresh institutional long additions and healthy contango.',
      dir: 'BULLISH',
    };
  } else if (!isPriceUp && isOiBuilding) {
    bias = {
      label: 'Bearish Breakdown (Short Buildup)',
      cls: 'bg-red-500/10 text-red-400 border-red-500/25',
      desc: 'Aggressive institutional shorting pushing price below intraday pivot.',
      dir: 'BEARISH',
    };
  } else if (isPriceUp && !isOiBuilding) {
    bias = {
      label: 'Short Covering Squeeze',
      cls: 'bg-sky-500/10 text-sky-400 border-sky-500/25',
      desc: 'Bears unwinding shorts. Fast upward momentum; protect profits near resistance.',
      dir: 'BULLISH',
    };
  } else if (!isPriceUp && !isOiBuilding) {
    bias = {
      label: 'Long Liquidation Fade',
      cls: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
      desc: 'Longs dumping positions. Watch for stabilization near key support levels.',
      dir: 'BEARISH',
    };
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col justify-between relative overflow-hidden">
      <div className="pointer-events-none absolute top-0 right-0 w-48 h-48 bg-sky-500/[0.04] blur-2xl rounded-full" />

      {/* Card Header */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white tracking-wide">{name} NEAR FUTURES</span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
              {contract.label}
            </span>
          </div>
          <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${bias.cls}`}>
            {bias.label}
          </span>
        </div>

        {/* Current Price & Basis Stats */}
        <div className="flex items-baseline gap-4 mb-4">
          <span className="text-2xl font-mono font-bold text-white tabular-nums">
            {fmtPrice(price)}
          </span>
          <span className={`text-xs font-mono font-semibold ${price >= open ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmtPct(((price - open) / open) * 100)} vs Open
          </span>
          {basis !== null && (
            <span className="text-xs text-zinc-400 font-mono">
              Basis: <strong className={basis >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {basis >= 0 ? '+' : ''}{basis.toFixed(1)} pts
              </strong>{' '}
              ({coc !== null ? `${coc.toFixed(1)}% p.a.` : ''})
            </span>
          )}
        </div>

        {/* Intraday Range Meter */}
        <div className="mb-4">
          <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1 font-mono">
            <span>Low: ₹{fmtPrice(low)}</span>
            <span className="text-zinc-300 font-semibold">{rangePosPct.toFixed(0)}% of Day Range</span>
            <span>High: ₹{fmtPrice(high)}</span>
          </div>
          <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden relative">
            <div
              className={`h-full transition-all rounded-full ${
                rangePosPct >= 70 ? 'bg-emerald-400' : rangePosPct <= 30 ? 'bg-red-400' : 'bg-sky-400'
              }`}
              style={{ width: `${rangePosPct}%` }}
            />
          </div>
        </div>

        {/* Reference Execution Levels */}
        <div className="grid grid-cols-5 gap-1.5 text-center mb-4 p-2 rounded-xl bg-zinc-950/60 border border-zinc-800/80 font-mono text-[11px]">
          <div>
            <span className="text-[9px] text-red-400 font-bold block">S2</span>
            <span className="text-zinc-300 font-semibold">{s2.toFixed(0)}</span>
          </div>
          <div>
            <span className="text-[9px] text-red-300 font-bold block">S1</span>
            <span className="text-zinc-300 font-semibold">{s1.toFixed(0)}</span>
          </div>
          <div className="bg-zinc-800/60 rounded px-1">
            <span className="text-[9px] text-sky-400 font-bold block">PIVOT</span>
            <span className="text-white font-bold">{pp.toFixed(0)}</span>
          </div>
          <div>
            <span className="text-[9px] text-emerald-300 font-bold block">R1</span>
            <span className="text-zinc-300 font-semibold">{r1.toFixed(0)}</span>
          </div>
          <div>
            <span className="text-[9px] text-emerald-400 font-bold block">R2</span>
            <span className="text-zinc-300 font-semibold">{r2.toFixed(0)}</span>
          </div>
        </div>

        {/* Actionable Trigger Description */}
        <div className="text-xs text-zinc-300 p-2.5 rounded-xl border border-zinc-800 bg-zinc-950/40 mb-4">
          <p className="font-semibold text-white mb-1 flex items-center gap-1.5">
            <Target className="h-3.5 w-3.5 text-sky-400" />
            Execution Triggers:
          </p>
          <p className="text-[11px] text-zinc-400">
            • <strong className="text-emerald-400">Long Trigger:</strong> Breakout & close above R1 ({r1.toFixed(0)}) → Targets: {r2.toFixed(0)}, {(r2 + 40).toFixed(0)}. SL: {pp.toFixed(0)}.
          </p>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            • <strong className="text-red-400">Short Trigger:</strong> Breakdown below S1 ({s1.toFixed(0)}) → Targets: {s2.toFixed(0)}, {(s2 - 40).toFixed(0)}. SL: {pp.toFixed(0)}.
          </p>
        </div>
      </div>

      {/* 1-Click Execution Action Buttons */}
      <div className="flex items-center gap-2 pt-3 border-t border-zinc-800/80">
        <Link
          href={`/scalper?symbol=${name}`}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-oncolor transition-colors shadow-sm cursor-pointer"
        >
          <TrendingUp className="h-3.5 w-3.5" />
          Trade Long (Scalper)
        </Link>
        <Link
          href={`/scalper?symbol=${name}`}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg bg-rose-600 hover:bg-rose-500 text-oncolor transition-colors shadow-sm cursor-pointer"
        >
          <TrendingDown className="h-3.5 w-3.5" />
          Trade Short (Scalper)
        </Link>
        <Link
          href={`/synthetic-futures?underlying=${name}`}
          className="flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 transition-colors"
          title="Open low-margin Synthetic Futures Terminal"
        >
          <Zap className="h-3.5 w-3.5" />
          Synthetic
        </Link>
      </div>
    </div>
  );
}

// ─── Setup Card Component ─────────────────────────────────────────────────────

function SetupCard({ setup }: { setup: ActionableSetup }) {
  const [copied, setCopied] = useState(false);

  const copyDetails = () => {
    const text = `[${setup.action}] ${setup.symbol} Future\nLTP: ₹${setup.price} (${fmtPct(setup.priceChgPct)})\nTrigger: ${setup.entryTrigger}\nSL: ₹${setup.stopLoss}\nT1: ₹${setup.target1} | T2: ₹${setup.target2}\nR:R: ${setup.riskReward}\nOptions Alt: ${setup.optionsPlay}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isBullish = setup.direction === 'BULLISH';

  return (
    <div className={`rounded-2xl border bg-zinc-900/60 p-4 flex flex-col justify-between transition-all hover:border-zinc-700 ${setup.accent}`}>
      <div>
        {/* Top Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white font-mono">{setup.symbol}</span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${setup.badgeCls}`}>
              {setup.title}
            </span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-amber-300 font-semibold">
            {setup.conviction === 'HIGH' ? '★★★ HIGH' : '★★ MODERATE'}
          </span>
        </div>

        {/* Price & Change */}
        <div className="flex items-baseline justify-between mb-3">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-mono font-bold text-white tabular-nums">
              ₹{fmtPrice(setup.price)}
            </span>
            <span className={`text-xs font-mono font-semibold ${setup.priceChgPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {fmtPct(setup.priceChgPct)}
            </span>
          </div>
          <span className="text-xs text-zinc-400 font-mono">
            OI: <strong className={setup.oiChgPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {fmtPct(setup.oiChgPct)}
            </strong> ({fmtLakh(setup.oi)})
          </span>
        </div>

        {/* Execution Strategy Box */}
        <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-zinc-800/80 mb-3 space-y-1.5 text-xs font-mono">
          <div className="flex justify-between items-center">
            <span className="text-zinc-400">Trigger Entry:</span>
            <span className="text-white font-bold">{setup.entryTrigger}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-zinc-400">Stop Loss:</span>
            <span className="text-red-400 font-semibold">₹{fmtPrice(setup.stopLoss)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-zinc-400">Targets (T1 / T2):</span>
            <span className="text-emerald-400 font-semibold">
              ₹{fmtPrice(setup.target1)} / ₹{fmtPrice(setup.target2)}
            </span>
          </div>
          <div className="flex justify-between items-center pt-1 border-t border-zinc-800/60 text-[11px]">
            <span className="text-zinc-500 font-sans">Risk-to-Reward:</span>
            <span className="text-sky-300 font-bold">{setup.riskReward}</span>
          </div>
        </div>

        {/* Synthetic Options Play recommendation */}
        <div className="text-[11px] text-zinc-400 mb-3 px-1 flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-sky-400 shrink-0" />
          <span>Option Play: <strong className="text-zinc-200">{setup.optionsPlay}</strong></span>
        </div>
      </div>

      {/* Action Footer */}
      <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/80">
        <Link
          href={`/scalper?symbol=${setup.symbol}`}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
            isBullish
              ? 'bg-emerald-600 hover:bg-emerald-500 text-oncolor'
              : 'bg-rose-600 hover:bg-rose-500 text-oncolor'
          }`}
        >
          {isBullish ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          Trade on Scalper
        </Link>
        <button
          onClick={copyDetails}
          className="p-2 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white transition-colors"
          title="Copy trade plan to clipboard"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// ─── Main Action Desk ─────────────────────────────────────────────────────────

export default function FuturesActionDesk({
  niftyNear,
  bankniftyNear,
  longBuildup,
  shortBuildup,
  shortCovering,
  longUnwinding,
  onOpenPlaybook,
}: FuturesActionDeskProps) {
  const [filterMode, setFilterMode] = useState<'ALL' | 'BULLISH' | 'BEARISH'>('ALL');

  // Compute top actionable stock setups:
  const actionableSetups = useMemo<ActionableSetup[]>(() => {
    const list: ActionableSetup[] = [];

    // 1. Top Long Buildup plays:
    const topLongs = [...longBuildup]
      .filter(r => r.priceChgPct > 0.8 && r.oiChgPct > 2.5)
      .sort((a, b) => (b.oiChgPct * b.priceChgPct) - (a.oiChgPct * a.priceChgPct))
      .slice(0, 3);

    for (const r of topLongs) {
      const entryPrice = r.price;
      const slDist = entryPrice * 0.012; // 1.2% risk
      const sl = entryPrice - slDist;
      const t1 = entryPrice + (slDist * 1.5);
      const t2 = entryPrice + (slDist * 2.5);
      const isHigh = r.oiChgPct >= 5 && r.priceChgPct >= 1.5;

      list.push({
        id: `long-${r.symbol}`,
        symbol: r.symbol,
        category: 'LONG_BUILDUP',
        title: 'Breakout Long',
        direction: 'BULLISH',
        price: r.price,
        priceChgPct: r.priceChgPct,
        oi: r.oi,
        oiChgPct: r.oiChgPct,
        conviction: isHigh ? 'HIGH' : 'MODERATE',
        action: 'BUY FUTURE',
        entryTrigger: `Above ₹${fmtPrice(entryPrice)}`,
        entryPrice,
        stopLoss: sl,
        target1: t1,
        target2: t2,
        riskReward: '1 : 2.0',
        optionsPlay: 'ATM Call or Bull Call Spread',
        accent: 'border-emerald-500/25',
        badgeCls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      });
    }

    // 2. Top Short Buildup plays:
    const topShorts = [...shortBuildup]
      .filter(r => r.priceChgPct < -0.8 && r.oiChgPct > 2.5)
      .sort((a, b) => (b.oiChgPct * Math.abs(b.priceChgPct)) - (a.oiChgPct * Math.abs(a.priceChgPct)))
      .slice(0, 3);

    for (const r of topShorts) {
      const entryPrice = r.price;
      const slDist = entryPrice * 0.012;
      const sl = entryPrice + slDist;
      const t1 = entryPrice - (slDist * 1.5);
      const t2 = entryPrice - (slDist * 2.5);
      const isHigh = r.oiChgPct >= 5 && r.priceChgPct <= -1.5;

      list.push({
        id: `short-${r.symbol}`,
        symbol: r.symbol,
        category: 'SHORT_BUILDUP',
        title: 'Breakdown Short',
        direction: 'BEARISH',
        price: r.price,
        priceChgPct: r.priceChgPct,
        oi: r.oi,
        oiChgPct: r.oiChgPct,
        conviction: isHigh ? 'HIGH' : 'MODERATE',
        action: 'SELL FUTURE',
        entryTrigger: `Below ₹${fmtPrice(entryPrice)}`,
        entryPrice,
        stopLoss: sl,
        target1: t1,
        target2: t2,
        riskReward: '1 : 2.0',
        optionsPlay: 'ATM Put or Bear Put Spread',
        accent: 'border-red-500/25',
        badgeCls: 'bg-red-500/10 text-red-400 border-red-500/20',
      });
    }

    // 3. Top Short Covering squeeze:
    const topCovering = [...shortCovering]
      .filter(r => r.priceChgPct > 1.0 && r.oiChgPct < -2.0)
      .sort((a, b) => (Math.abs(b.oiChgPct) * b.priceChgPct) - (Math.abs(a.oiChgPct) * a.priceChgPct))
      .slice(0, 2);

    for (const r of topCovering) {
      const entryPrice = r.price;
      const slDist = entryPrice * 0.01;
      const sl = entryPrice - slDist;
      const t1 = entryPrice + (slDist * 1.5);
      const t2 = entryPrice + (slDist * 2.2);

      list.push({
        id: `cov-${r.symbol}`,
        symbol: r.symbol,
        category: 'SHORT_COVERING',
        title: 'Short Squeeze Scalp',
        direction: 'BULLISH',
        price: r.price,
        priceChgPct: r.priceChgPct,
        oi: r.oi,
        oiChgPct: r.oiChgPct,
        conviction: 'MODERATE',
        action: 'SCALP BUY',
        entryTrigger: `Momentum above ₹${fmtPrice(entryPrice)}`,
        entryPrice,
        stopLoss: sl,
        target1: t1,
        target2: t2,
        riskReward: '1 : 1.8',
        optionsPlay: 'Quick ATM Call Scalp (Intraday only)',
        accent: 'border-sky-500/25',
        badgeCls: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
      });
    }

    // 4. Top Long Unwinding:
    const topUnwinding = [...longUnwinding]
      .filter(r => r.priceChgPct < -1.0 && r.oiChgPct < -2.0)
      .sort((a, b) => (Math.abs(b.oiChgPct) * Math.abs(b.priceChgPct)) - (Math.abs(a.oiChgPct) * Math.abs(a.priceChgPct)))
      .slice(0, 2);

    for (const r of topUnwinding) {
      const entryPrice = r.price;
      const slDist = entryPrice * 0.01;
      const sl = entryPrice + slDist;
      const t1 = entryPrice - (slDist * 1.5);
      const t2 = entryPrice - (slDist * 2.2);

      list.push({
        id: `unw-${r.symbol}`,
        symbol: r.symbol,
        category: 'LONG_UNWINDING',
        title: 'Liquidation Breakdown',
        direction: 'BEARISH',
        price: r.price,
        priceChgPct: r.priceChgPct,
        oi: r.oi,
        oiChgPct: r.oiChgPct,
        conviction: 'MODERATE',
        action: 'FADE SHORT',
        entryTrigger: `Below ₹${fmtPrice(entryPrice)}`,
        entryPrice,
        stopLoss: sl,
        target1: t1,
        target2: t2,
        riskReward: '1 : 1.8',
        optionsPlay: 'ATM Put Scalp or OTM Put Buying',
        accent: 'border-amber-500/25',
        badgeCls: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      });
    }

    return list;
  }, [longBuildup, shortBuildup, shortCovering, longUnwinding]);

  const filteredSetups = useMemo(() => {
    if (filterMode === 'BULLISH') return actionableSetups.filter(s => s.direction === 'BULLISH');
    if (filterMode === 'BEARISH') return actionableSetups.filter(s => s.direction === 'BEARISH');
    return actionableSetups;
  }, [actionableSetups, filterMode]);

  return (
    <div className="space-y-6">
      {/* ─── Index Execution Command Header ───────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="h-5 border-l-2 border-sky-500" />
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                Index Futures Execution Command
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/30">
                  REAL-TIME ACTION
                </span>
              </h2>
              <p className="text-[10px] text-zinc-400">
                Pivots, basis alignment, intraday bias, and 1-click execution routing
              </p>
            </div>
          </div>

          <button
            onClick={onOpenPlaybook}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition-all shadow-sm"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            Trading Playbook &amp; Rules
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <IndexCommandCard name="NIFTY" contract={niftyNear} />
          <IndexCommandCard name="BANKNIFTY" contract={bankniftyNear} />
        </div>
      </section>

      {/* ─── Top High-Conviction Stock Setups Scanner ─────────────────────── */}
      <section className="border-t border-zinc-800 pt-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="h-5 border-l-2 border-emerald-500" />
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                High-Conviction Stock Futures Setups
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {filteredSetups.length} ACTIVE PLAYS
                </span>
              </h2>
              <p className="text-[10px] text-zinc-400">
                Institutional OI &amp; price momentum confluence with calculated Entry, SL &amp; Targets
              </p>
            </div>
          </div>

          {/* Direction Filter */}
          <div className="flex items-center gap-1.5 bg-zinc-900/80 p-1 rounded-xl border border-zinc-800 text-xs">
            <button
              onClick={() => setFilterMode('ALL')}
              className={`px-3 py-1 rounded-lg font-semibold transition-colors ${
                filterMode === 'ALL'
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              All Setups ({actionableSetups.length})
            </button>
            <button
              onClick={() => setFilterMode('BULLISH')}
              className={`px-3 py-1 rounded-lg font-semibold transition-colors ${
                filterMode === 'BULLISH'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-emerald-400'
              }`}
            >
              Bullish Only
            </button>
            <button
              onClick={() => setFilterMode('BEARISH')}
              className={`px-3 py-1 rounded-lg font-semibold transition-colors ${
                filterMode === 'BEARISH'
                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                  : 'text-zinc-400 hover:text-red-400'
              }`}
            >
              Bearish Only
            </button>
          </div>
        </div>

        {filteredSetups.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 py-12 text-center text-xs text-zinc-500">
            No actionable high-conviction setups matching the current filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSetups.map(setup => (
              <SetupCard key={setup.id} setup={setup} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
