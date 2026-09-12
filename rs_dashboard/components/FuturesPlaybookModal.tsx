'use client';

import React, { useState } from 'react';
import {
  X,
  BookOpen,
  TrendingUp,
  TrendingDown,
  Activity,
  Layers,
  ShieldAlert,
  HelpCircle,
  Zap,
  ArrowRight,
  ExternalLink,
  Target,
  Percent,
} from 'lucide-react';
import Link from 'next/link';

interface FuturesPlaybookModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'quadrants' | 'basis_coc' | 'rollover' | 'synthetic';

export default function FuturesPlaybookModal({ isOpen, onClose }: FuturesPlaybookModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('quadrants');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-md">
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-sky-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-500/20">
              <BookOpen className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                Futures & Open Interest Trading Playbook
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/25">
                  Actionable Execution Guide
                </span>
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Institutional tactics for trading OI buildups, basis anomalies, rollover migration, and synthetic hedging
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 px-6 py-2.5 border-b border-zinc-800/80 bg-zinc-900/40 overflow-x-auto text-xs font-semibold">
          <button
            onClick={() => setActiveTab('quadrants')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'quadrants'
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            4-Quadrant OI Matrix
          </button>
          <button
            onClick={() => setActiveTab('basis_coc')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'basis_coc'
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            <Percent className="h-3.5 w-3.5" />
            Basis & Cost of Carry (CoC)
          </button>
          <button
            onClick={() => setActiveTab('rollover')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'rollover'
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            Expiry Rollover Strategies
          </button>
          <button
            onClick={() => setActiveTab('synthetic')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'synthetic'
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
            Synthetic Futures & Low-Margin Plays
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm text-zinc-300">
          {/* TAB 1: 4-Quadrant Matrix */}
          {activeTab === 'quadrants' && (
            <div className="space-y-6">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-sky-400" />
                  The Institutional Open Interest Equation
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Price movement without Open Interest (OI) is just noise or retail churn. When price moves in tandem
                  with aggressive OI expansion, institutional participants (FIIs, DIIs, Prop desks) are committing fresh capital.
                  Here is the exact battle plan for each quadrant:
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Long Buildup */}
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                        <TrendingUp className="h-4 w-4" />
                        Long Buildup (Price ▲ · OI ▲)
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                        Bullish Trend Initiation
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 mb-3">
                      Aggressive buyers are opening new long contracts, absorbing all offers at higher prices.
                    </p>
                    <div className="space-y-2 text-xs border-t border-emerald-500/20 pt-2.5">
                      <p className="font-semibold text-emerald-300">Action Plan:</p>
                      <ul className="list-disc pl-4 space-y-1 text-zinc-300 text-[11px]">
                        <li><strong className="text-white">Entry Trigger:</strong> Wait for a pullback to 15-min VWAP or breakout above Day High.</li>
                        <li><strong className="text-white">Confirmation:</strong> Spot &gt; VWAP, Delivery Volume expanding, positive Basis.</li>
                        <li><strong className="text-white">Stop Loss:</strong> 1 tick below swing low or 1.2% below entry.</li>
                        <li><strong className="text-white">Preferred Instrument:</strong> Long Future or ATM Bull Call Spread.</li>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* Short Buildup */}
                <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-red-400 flex items-center gap-1.5">
                        <TrendingDown className="h-4 w-4" />
                        Short Buildup (Price ▼ · OI ▲)
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/20">
                        Bearish Trend Initiation
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 mb-3">
                      Institutional sellers are aggressively dumping contracts and opening short hedges, pushing prices down.
                    </p>
                    <div className="space-y-2 text-xs border-t border-red-500/20 pt-2.5">
                      <p className="font-semibold text-red-300">Action Plan:</p>
                      <ul className="list-disc pl-4 space-y-1 text-zinc-300 text-[11px]">
                        <li><strong className="text-white">Entry Trigger:</strong> Breakdown below Day Low or failure to reclaim VWAP from below.</li>
                        <li><strong className="text-white">Confirmation:</strong> Spot &lt; VWAP, Futures trading at a discount (Negative Basis).</li>
                        <li><strong className="text-white">Stop Loss:</strong> 1 tick above the day&apos;s VWAP or 1.2% above entry.</li>
                        <li><strong className="text-white">Preferred Instrument:</strong> Short Future or Bear Put Spread (ATM PE buy + OTM PE sell).</li>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* Short Covering */}
                <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-sky-400 flex items-center gap-1.5">
                        <Activity className="h-4 w-4" />
                        Short Covering (Price ▲ · OI ▼)
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20">
                        Counter-Trend / Squeeze Rally
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 mb-3">
                      Bears are panicking and squaring off existing shorts. No new buyers are entering—it is a forced short squeeze!
                    </p>
                    <div className="space-y-2 text-xs border-t border-sky-500/20 pt-2.5">
                      <p className="font-semibold text-sky-300">Action Plan:</p>
                      <ul className="list-disc pl-4 space-y-1 text-zinc-300 text-[11px]">
                        <li><strong className="text-white">Caution:</strong> Prone to sudden reversals once the short-covering exhaustion completes.</li>
                        <li><strong className="text-white">Trading Rule:</strong> Quick scalps only! Do NOT hold multi-day positional longs on pure short covering.</li>
                        <li><strong className="text-white">Setup:</strong> If price hits an established resistance zone and OI stops falling, look to short on rejection.</li>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* Long Unwinding */}
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                        <ShieldAlert className="h-4 w-4" />
                        Long Unwinding (Price ▼ · OI ▼)
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                        Bullish Liquidation / Stop Run
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 mb-3">
                      Weak longs are capitulating and dumping positions. It signifies panic closing rather than new short positioning.
                    </p>
                    <div className="space-y-2 text-xs border-t border-amber-500/20 pt-2.5">
                      <p className="font-semibold text-amber-300">Action Plan:</p>
                      <ul className="list-disc pl-4 space-y-1 text-zinc-300 text-[11px]">
                        <li><strong className="text-white">Danger Zone:</strong> Never &quot;catch a falling knife&quot; during active long liquidation.</li>
                        <li><strong className="text-white">Reversal Play:</strong> When OI contraction plateaus and price forms an intraday double bottom at key support (S1/S2), prepare for a technical bounce.</li>
                        <li><strong className="text-white">Stop Loss:</strong> Tight stop below the liquidation spike low.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Basis & Cost of Carry */}
          {activeTab === 'basis_coc' && (
            <div className="space-y-6">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                  <Percent className="h-4 w-4 text-sky-400" />
                  Understanding Basis & Cost of Carry (CoC)
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Basis is the spread between Futures and Spot: <code className="px-1.5 py-0.5 bg-zinc-800 rounded font-mono text-white">Basis = Futures Price - Spot Price</code>.
                  Cost of Carry (CoC) annualizes this spread based on Days to Expiry (DTE):
                </p>
                <div className="mt-3 p-3 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-xs text-sky-300">
                  CoC % p.a. = ((Futures - Spot) / Spot) × (365 / DTE) × 100
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <h4 className="text-xs font-bold text-emerald-400 mb-2 flex items-center gap-1.5">
                    Contango (Positive Basis · CoC &gt; 0)
                  </h4>
                  <p className="text-xs text-zinc-300 mb-2">
                    Futures trade at a premium over Spot. This is the healthy, natural state reflecting the cost of financing and interest rates (~7-10% p.a.).
                  </p>
                  <ul className="text-[11px] text-zinc-400 space-y-1.5 list-disc pl-4">
                    <li><strong className="text-zinc-200">Normal Contango (6% to 12% p.a.):</strong> Healthy market sentiment. Long positions can be held comfortably.</li>
                    <li><strong className="text-zinc-200">Euphoric Contango (&gt; 18% p.a.):</strong> Overheating. Retail is aggressively buying futures at huge premiums. Beware of a sharp mean-reversion squeeze on expiry week.</li>
                  </ul>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <h4 className="text-xs font-bold text-red-400 mb-2 flex items-center gap-1.5">
                    Backwardation (Negative Basis · CoC &lt; 0)
                  </h4>
                  <p className="text-xs text-zinc-300 mb-2">
                    Futures trade at a discount below Spot. This is an anomalous condition signaling intense institutional hedging, large upcoming dividend payouts, or extreme bearish pessimism.
                  </p>
                  <ul className="text-[11px] text-zinc-400 space-y-1.5 list-disc pl-4">
                    <li><strong className="text-zinc-200">Bearish Trend Confirmation:</strong> If prices are falling AND futures trade at a discount, institutions are paying a penalty to dump futures immediately.</li>
                    <li><strong className="text-zinc-200">The Backwardation Squeeze Trap:</strong> If an index or stock is in backwardation but refuses to break below key support, cash-and-carry arbitragers and trapped shorts trigger violent up-moves.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Rollover Strategies */}
          {activeTab === 'rollover' && (
            <div className="space-y-6">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-amber-400" />
                  Mastering the Monthly Rollover Week (DTE ≤ 5 Days)
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  In Indian markets, monthly stock and index futures expire on the last Tuesday (Bank Nifty) or Thursday (Nifty) of the month.
                  In the final 5 sessions, institutions do not close their multi-crore positions—they roll them forward to the Next Month contract.
                </p>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-emerald-400">High Rollover (&gt; 75%) + Positive Roll Spread</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300">Strong Bullish Continuation</span>
                  </div>
                  <p className="text-xs text-zinc-300">
                    Institutions are paying up to roll long positions into next month. Signals that the ongoing bullish trend is expected to accelerate in the upcoming series.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-red-400">High Rollover (&gt; 75%) + Negative / Flat Roll Spread</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-500/10 text-red-300">Aggressive Short Rollover</span>
                  </div>
                  <p className="text-xs text-zinc-300">
                    Bearish institutions are rolling short hedges forward without covering. Anticipate persistent downward pressure into the opening week of the new series.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-amber-400">Low Rollover (&lt; 65%) with Dropping Total Open Interest</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-300">Trend Exhaustion / Profit Taking</span>
                  </div>
                  <p className="text-xs text-zinc-300">
                    Both sides are closing out rather than carrying forward. The prevailing trend is running out of steam. Expect range-bound churn or a major regime shift.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Synthetic Futures & Margin */}
          {activeTab === 'synthetic' && (
            <div className="space-y-6">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                  <Zap className="h-4 w-4 text-sky-400" />
                  Trading Futures Direction with 80% Less Margin (Synthetic Plays)
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Trading 1 lot of NIFTY Future requires ~₹1,30,000 to ₹1,50,000 in margin, and stock futures require ₹1,80,000 to ₹3,00,000+.
                  You can achieve identical directional exposure with controlled risk using options synthetics:
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col justify-between">
                  <div>
                    <span className="text-xs font-bold text-sky-400 block mb-1">Pure Synthetic Future</span>
                    <span className="text-[10px] font-mono text-zinc-400 block mb-2">Delta: ±1.00 · Margin: ~₹35,000</span>
                    <p className="text-xs text-zinc-300">
                      <strong>Long Synthetic:</strong> Buy ATM Call + Sell ATM Put.<br />
                      <strong>Short Synthetic:</strong> Buy ATM Put + Sell ATM Call.<br />
                      Behaves identically to a linear future tick-for-tick with zero theta decay at ATM.
                    </p>
                  </div>
                  <Link
                    href="/synthetic-futures"
                    className="mt-4 flex items-center justify-center gap-1 text-[11px] font-semibold text-sky-400 hover:text-sky-300"
                  >
                    Open Synthetic Terminal <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col justify-between">
                  <div>
                    <span className="text-xs font-bold text-emerald-400 block mb-1">Bull Call Spread (Defined Risk)</span>
                    <span className="text-[10px] font-mono text-zinc-400 block mb-2">Delta: ~0.40 · Margin: ~₹25,000</span>
                    <p className="text-xs text-zinc-300">
                      Buy ATM Call + Sell 1 Strike OTM Call.<br />
                      Caps downside risk strictly to the net debit paid. Perfect for high-conviction Long Buildup breakouts without overnight gap-down risk.
                    </p>
                  </div>
                  <Link
                    href="/scalper"
                    className="mt-4 flex items-center justify-center gap-1 text-[11px] font-semibold text-emerald-400 hover:text-emerald-300"
                  >
                    Trade on Scalper <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col justify-between">
                  <div>
                    <span className="text-xs font-bold text-red-400 block mb-1">Bear Put Spread (Defined Risk)</span>
                    <span className="text-[10px] font-mono text-zinc-400 block mb-2">Delta: ~0.40 · Margin: ~₹25,000</span>
                    <p className="text-xs text-zinc-300">
                      Buy ATM Put + Sell 1 Strike OTM Put.<br />
                      Caps downside risk strictly to the net debit paid. Ideal vehicle for aggressive Short Buildup breakdowns.
                    </p>
                  </div>
                  <Link
                    href="/scalper"
                    className="mt-4 flex items-center justify-center gap-1 text-[11px] font-semibold text-red-400 hover:text-red-300"
                  >
                    Trade on Scalper <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-zinc-800 bg-zinc-900/60">
          <span className="text-xs text-zinc-400 flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
            Always enforce strict stop losses. Never trade naked futures without predefined risk parameters.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white transition-colors"
          >
            Close Guide
          </button>
        </div>
      </div>
    </div>
  );
}
