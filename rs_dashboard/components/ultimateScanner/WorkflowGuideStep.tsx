'use client';

import React from 'react';
import {
  Search,
  Eye,
  Zap,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  TrendingUp,
  Sliders,
  PlayCircle,
  HelpCircle,
} from 'lucide-react';

interface WorkflowGuideStepProps {
  onNavigateToScanner: () => void;
  onNavigateToWatchlist: () => void;
}

export default function WorkflowGuideStep({
  onNavigateToScanner,
  onNavigateToWatchlist,
}: WorkflowGuideStepProps) {
  const steps = [
    {
      num: '01',
      title: 'Step 1: Ultimate Option Chain Scanner',
      desc: 'Scan the complete Nifty 50 and Sensex option chains in real time. Filter by Return on Margin (RoM %), safety distance from spot (% OTM), and risk profile (POP & Delta) to discover high-probability setups.',
      icon: Search,
      accent: 'emerald',
      actions: [
        'Select Index (NIFTY / SENSEX)',
        'Adjust RoM % slider (e.g. >= 2.5% per cycle)',
        'Set Distance Threshold (e.g. 1.5% - 4.0% OTM)',
        'Filter by Strategy Types (Bull Put, Bear Call, Iron Condor)',
      ],
      cta: 'Go to Scanner',
      onClick: onNavigateToScanner,
    },
    {
      num: '02',
      title: 'Step 2: Watchlist & Entry/Exit Rules',
      desc: 'Shortlist top candidates into your Watchlist. Configure precise entry triggers (Market / Limit) and risk-controlled exit rules like automated Target Profit %, Stop Loss %, and Trailing SL.',
      icon: Eye,
      accent: 'cyan',
      actions: [
        'Monitor live net premium decay & P&L',
        'Configure Target Profit (e.g. 50% max profit)',
        'Set Stop Loss % (e.g. 100% initial credit)',
        'Set Expiry Auto-Squareoff time (e.g. 15:15 IST)',
      ],
      cta: 'Go to Watchlist',
      onClick: onNavigateToWatchlist,
    },
    {
      num: '03',
      title: 'Step 3: Multi-Leg Focus Trade Execution',
      desc: 'Seamlessly transfer shortlisted baskets directly to the Multi-Leg Focus terminal. Review live portfolio Greeks, span margin benefit, and execute 1-click orders with Dhan / Zerodha / Kotak.',
      icon: Zap,
      accent: 'amber',
      actions: [
        '1-Click transfer from Watchlist to Multi-Leg Focus',
        'Analyze live portfolio Delta, Theta & margin netting',
        'Execute multi-leg orders safely with slippage caps',
        'Real-time P&L tracking and automated risk guards',
      ],
      cta: 'Open Multi-Leg Focus',
      onClick: () => {
        window.location.href = '/multi-leg-focus';
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto py-4">
      <div className="text-center space-y-2">
        <span className="px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-bold border border-emerald-500/20">
          Standardized Process Architecture
        </span>
        <h2 className="text-xl font-bold text-white tracking-tight">
          How the Ultimate Scanner Workflow Operates
        </h2>
        <p className="text-xs text-zinc-400 max-w-xl mx-auto">
          A disciplined, 3-step options trading workflow engineered to discover, filter, monitor, and execute high-probability F&amp;O setups.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-4">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          return (
            <div
              key={idx}
              className="bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 flex flex-col justify-between gap-6 shadow-xl relative overflow-hidden group hover:border-zinc-700 transition-all"
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div
                    className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                      step.accent === 'emerald'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : step.accent === 'cyan'
                        ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                        : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    }`}
                  >
                    <Icon className="w-6 h-6" />
                  </div>
                  <span className="text-2xl font-extrabold text-zinc-700 font-mono">
                    {step.num}
                  </span>
                </div>

                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-white">{step.title}</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">{step.desc}</p>
                </div>

                <div className="space-y-2 pt-2 border-t border-zinc-800/80">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                    Core Capabilities
                  </p>
                  <ul className="space-y-1.5 text-xs text-zinc-300">
                    {step.actions.map((act, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{act}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <button
                onClick={step.onClick}
                className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold transition-all border border-zinc-700"
              >
                <span>{step.cta}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
