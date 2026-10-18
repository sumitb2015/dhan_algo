'use client';

import React, { useState } from 'react';
import {
  X,
  BookOpen,
  TrendingDown,
  ShieldCheck,
  Award,
  ArrowDownRight,
  Activity,
  Sliders,
  AlertTriangle,
  CheckCircle2,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface BreakdownDocModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = 'overview' | 'rules' | 'ranking' | 'trailing' | 'params' | 'safety';

export default function BreakdownDocModal({ isOpen, onClose }: BreakdownDocModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-oncolor-dark/70 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="flex flex-col bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
              <BookOpen className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                Breakdown Auto-Scalper Strategy Playbook
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  v1.0
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Multi-strike option-premium breakdown selling engine with NIFTY trend bias & trailing SL
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close playbook"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-5 pt-3 border-b border-zinc-800 bg-zinc-900/60 overflow-x-auto no-scrollbar">
          {[
            { key: 'overview', label: 'Overview & Logic', icon: Activity },
            { key: 'rules', label: '6 Golden Rules', icon: ShieldCheck },
            { key: 'ranking', label: 'Signal Ranking', icon: Award },
            { key: 'trailing', label: 'Trailing SL Math', icon: ArrowDownRight },
            { key: 'params', label: 'Parameters', icon: Sliders },
            { key: 'safety', label: 'Safety & Risk', icon: AlertTriangle },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key as TabKey)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-bold whitespace-nowrap border-b-2 transition-all',
                  isActive
                    ? 'border-emerald-400 text-emerald-400 bg-emerald-500/5'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Modal Scrollable Content */}
        <div className="p-5 sm:p-6 overflow-y-auto max-h-[calc(90vh-130px)] space-y-6 text-zinc-300">
          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-5">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-2 mb-2">
                  <TrendingDown className="w-4 h-4" />
                  Core Strategy Thesis
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Option sellers earn rapid positive Theta (time decay) and volatility collapse when option premiums break down.
                  When an option premium drops below its <strong className="text-white">Supertrend (10, 2)</strong>,{' '}
                  <strong className="text-white">Session VWAP</strong>, and <strong className="text-white">EMA 20</strong> on a completed closed candle,
                  institutional sellers are heavily in control.
                </p>
              </div>

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4" />
                  The Critical Flaw of Naive Multi-Strike Scanning
                </h3>
                <ul className="space-y-2 text-xs text-zinc-300">
                  <li className="flex items-start gap-2">
                    <span className="text-amber-400 font-bold">•</span>
                    <span>
                      <strong className="text-white">Correlated Risk:</strong> During a strong rally, 5–6 Put strikes will qualify simultaneously. Shorting all 6 is not diversification; it is a single massive directional bet.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-amber-400 font-bold">•</span>
                    <span>
                      <strong className="text-white">Sharp Reversals:</strong> If the index snaps back 50 points, all 6 short puts blow up together, causing catastrophic drawdowns.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-amber-400 font-bold">•</span>
                    <span>
                      <strong className="text-white">Sideways Whipsaw:</strong> Range-bound markets trigger repeated false breakdowns through choppy indicators.
                    </span>
                  </li>
                </ul>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-sky-400 flex items-center gap-2 mb-3">
                  <Zap className="w-4 h-4" />
                  How the Engineered Strategy Solves This
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div className="p-3 rounded-lg border border-zinc-800/80 bg-zinc-900/50">
                    <p className="font-bold text-white mb-1">1. Market Direction Bias</p>
                    <p className="text-zinc-400">Underlying NIFTY must confirm direction (Bullish = PEs only, Bearish = CEs only, Sideways = Zero trades).</p>
                  </div>
                  <div className="p-3 rounded-lg border border-zinc-800/80 bg-zinc-900/50">
                    <p className="font-bold text-white mb-1">2. Fresh Breakdown Crossover</p>
                    <p className="text-zinc-400">Current closed bar must be below all 3; previous bar was NOT. Never triggers on stale or mid-candle bars.</p>
                  </div>
                  <div className="p-3 rounded-lg border border-zinc-800/80 bg-zinc-900/50">
                    <p className="font-bold text-white mb-1">3. Signal Ranking Engine</p>
                    <p className="text-zinc-400">Ranks candidates on 100-point matrix (Freshness, ATM proximity, Volume, and OI buildup) to pick the #1 contract.</p>
                  </div>
                  <div className="p-3 rounded-lg border border-zinc-800/80 bg-zinc-900/50">
                    <p className="font-bold text-white mb-1">4. Ratchet Trailing SL</p>
                    <p className="text-zinc-400">Down-only ratchet moves lower as premium falls, locking in profits and preventing givebacks.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 6 GOLDEN RULES */}
          {activeTab === 'rules' && (
            <div className="space-y-4">
              {[
                {
                  step: 'RULE 1',
                  title: 'Underlying Market Direction Filter',
                  color: 'text-emerald-400',
                  border: 'border-emerald-500/25',
                  bg: 'bg-emerald-500/5',
                  body: 'Option charts alone are never trusted. NIFTY 50 spot price relative to Session VWAP and EMA 9/20 determines what is allowed: BULLISH trend allows PE shorts only; BEARISH trend allows CE shorts only; SIDEWAYS or unaligned halts all new entries.',
                },
                {
                  step: 'RULE 2',
                  title: 'Triple Indicator Breakdown on Closed Candles',
                  color: 'text-sky-400',
                  border: 'border-sky-500/25',
                  bg: 'bg-sky-500/5',
                  body: 'The option must close below Supertrend(10, 2), Session VWAP, and EMA 20 on a completed candle. Intrabay ticks are folded into live candles, but signals require a finalized bar. The previous bar must NOT have been below all three (fresh crossover).',
                },
                {
                  step: 'RULE 3',
                  title: 'Signal Ranking & Position Limits',
                  color: 'text-purple-400',
                  border: 'border-purple-500/25',
                  bg: 'bg-purple-500/5',
                  body: 'If 4 PEs qualify at the same time, the strategy does NOT short all 4. It scores them based on freshness, delta proximity, traded volume, and OI expansion, entering only the highest-ranked contract. Portfolio limit caps open trades at 2 total and 1 per side.',
                },
                {
                  step: 'RULE 4',
                  title: 'Lock & Trail Stop-Loss Engine',
                  color: 'text-amber-400',
                  border: 'border-amber-500/25',
                  bg: 'bg-amber-500/5',
                  body: 'Trades initiate with an Initial SL (e.g. +25% above entry) to give full breathing room. Once profit reaches the trigger threshold (e.g. 15%), SL locks to cost (breakeven). For every X points gain beyond trigger, SL ratchets down by Y points. Crucially, the stop-loss NEVER loosens or ratchets upward.',
                },
                {
                  step: 'RULE 5',
                  title: 'Scalp Target & Indicator Recovery Exit',
                  color: 'text-teal-400',
                  border: 'border-teal-500/25',
                  bg: 'bg-teal-500/5',
                  body: 'A scalp profit floor (e.g. 50% decay) locks in rapid gains. If the option breaks back out above its Supertrend line or EMA 20, an early recovery exit closes the trade before the full stop-loss is hit.',
                },
                {
                  step: 'RULE 6',
                  title: 'Session Cutoffs & Circuit Breaker',
                  color: 'text-red-400',
                  border: 'border-red-500/25',
                  bg: 'bg-red-500/5',
                  body: 'All trades are strictly intraday with a mandatory square-off at 15:15 IST. A hard daily loss circuit breaker (e.g. -₹5,000) pauses the automated engine permanently for the rest of the day if triggered.',
                },
              ].map((r, i) => (
                <div key={i} className={cn('p-4 rounded-xl border', r.border, r.bg)}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={cn('text-[11px] font-extrabold uppercase tracking-wider', r.color)}>
                      {r.step}
                    </span>
                    <span className="text-zinc-600">·</span>
                    <h4 className="text-xs font-bold text-white">{r.title}</h4>
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed">{r.body}</p>
                </div>
              ))}
            </div>
          )}

          {/* TAB 3: SIGNAL RANKING */}
          {activeTab === 'ranking' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-2">
                  100-Point Scoring Matrix
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed mb-4">
                  When market momentum pushes multiple strikes into breakdown territory, candidates are ranked so that capital is deployed only into the single strongest setup:
                </p>

                <div className="space-y-3">
                  <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-white">1. Freshness (40 Points Max)</span>
                      <span className="text-xs font-mono font-bold text-emerald-400">40 Pts</span>
                    </div>
                    <p className="text-xs text-zinc-400">
                      40 points awarded if the breakdown occurred on the most recent completed bar. Decays by 10 points for each prior candle to prevent entering extended, lagging setups.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-white">2. Proximity to ATM (30 Points Max)</span>
                      <span className="text-xs font-mono font-bold text-sky-400">30 Pts</span>
                    </div>
                    <p className="text-xs text-zinc-400">
                      Peak points awarded to strikes 1–3 steps OTM/ATM (0.35–0.50 delta). Deep OTM contracts (&lt; ₹20) receive heavy penalties due to poor risk-to-reward and high fixed brokerage friction.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-white">3. Liquidity & Volume (15 Points Max)</span>
                      <span className="text-xs font-mono font-bold text-amber-400">15 Pts</span>
                    </div>
                    <p className="text-xs text-zinc-400">
                      Ensures ample market depth so market orders fill instantaneously with zero slippage during fast intraday action.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-white">4. Short Buildup Confirmation (15 Points Max)</span>
                      <span className="text-xs font-mono font-bold text-teal-400">15 Pts</span>
                    </div>
                    <p className="text-xs text-zinc-400">
                      Bonus awarded if Open Interest (OI) is increasing as premium declines, confirming institutional supply over mere retail profit-booking.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: TRAILING SL MATH */}
          {activeTab === 'trailing' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-2">
                  Step-by-Step Lock & Trail Example
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed mb-4">
                  Assume you short a NIFTY 24500 PE at <strong className="text-white">₹100.00</strong> with a{' '}
                  <strong className="text-amber-400">25% Initial SL</strong>, a{' '}
                  <strong className="text-emerald-400">15% Lock Trigger</strong>, and a{' '}
                  <strong className="text-sky-400">Step: 5 pts / Trail by: 2 pts</strong> configuration:
                </p>

                <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-zinc-800 text-white font-bold">
                      <tr>
                        <th className="px-3 py-2">Event</th>
                        <th className="px-3 py-2">Market Price</th>
                        <th className="px-3 py-2">Lowest Price</th>
                        <th className="px-3 py-2">Active Stop-Loss</th>
                        <th className="px-3 py-2">Lock-In Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 font-mono text-[11px]">
                      <tr>
                        <td className="px-3 py-2 text-zinc-300 font-sans">1. Trade Entry</td>
                        <td className="px-3 py-2 text-white">₹100.00</td>
                        <td className="px-3 py-2 text-zinc-400">₹100.00</td>
                        <td className="px-3 py-2 text-red-400 font-bold">₹125.00 (Initial)</td>
                        <td className="px-3 py-2 text-zinc-500 font-sans">Full breathing room (no early trail)</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 text-zinc-300 font-sans">2. Premium drops to ₹90</td>
                        <td className="px-3 py-2 text-white">₹90.00</td>
                        <td className="px-3 py-2 text-emerald-400 font-bold">₹90.00 (10% profit)</td>
                        <td className="px-3 py-2 text-red-400 font-bold">₹125.00 (Initial)</td>
                        <td className="px-3 py-2 text-zinc-400 font-sans">&lt; 15% trigger: SL stays untouched</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 text-zinc-300 font-sans">3. Premium hits ₹85 (15% profit)</td>
                        <td className="px-3 py-2 text-white">₹85.00</td>
                        <td className="px-3 py-2 text-emerald-400 font-bold">₹85.00</td>
                        <td className="px-3 py-2 text-emerald-400 font-bold">₹100.00 (LOCKED TO COST)</td>
                        <td className="px-3 py-2 text-emerald-400 font-sans font-bold">
                          DOWNSIDE RISK ELIMINATED!
                        </td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 text-zinc-300 font-sans">4. Further drop to ₹80 (+5 pts gain)</td>
                        <td className="px-3 py-2 text-white">₹80.00</td>
                        <td className="px-3 py-2 text-emerald-400 font-bold">₹80.00</td>
                        <td className="px-3 py-2 text-sky-400 font-bold">₹98.00 (100 - 1×2)</td>
                        <td className="px-3 py-2 text-emerald-400 font-sans font-bold">+₹2 PROFIT LOCKED!</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 text-zinc-300 font-sans">5. Further drop to ₹75 (+10 pts gain)</td>
                        <td className="px-3 py-2 text-white">₹75.00</td>
                        <td className="px-3 py-2 text-emerald-400 font-bold">₹75.00</td>
                        <td className="px-3 py-2 text-sky-400 font-bold">₹96.00 (100 - 2×2)</td>
                        <td className="px-3 py-2 text-emerald-400 font-sans font-bold">+₹4 PROFIT LOCKED!</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 text-zinc-300 font-sans">6. Pullback / reversal hits ₹96</td>
                        <td className="px-3 py-2 text-red-400">₹96.00</td>
                        <td className="px-3 py-2 text-emerald-400">₹75.00</td>
                        <td className="px-3 py-2 text-red-400 font-bold">₹96.00 (TRIGGERED)</td>
                        <td className="px-3 py-2 text-emerald-400 font-sans font-bold">
                          Exited safely with +₹4 gain
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: PARAMETERS */}
          {activeTab === 'params' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-sky-400 mb-3">
                  Configurable Strategy Parameters
                </h3>
                <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-zinc-800 text-white font-bold">
                      <tr>
                        <th className="px-3 py-2">Parameter</th>
                        <th className="px-3 py-2">Default</th>
                        <th className="px-3 py-2">Recommended</th>
                        <th className="px-3 py-2">Operational Role</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 text-[11px]">
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">timeframe</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">5m</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">3m – 5m</td>
                        <td className="px-3 py-2 text-zinc-300">Candle interval for option indicator calculations</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">slPct</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">25%</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">15% – 35%</td>
                        <td className="px-3 py-2 text-zinc-300">Initial Stop-Loss percentage above entry price</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">trailStartPct</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">15%</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">10% – 25%</td>
                        <td className="px-3 py-2 text-zinc-300">Profit threshold to lock SL to cost and begin trailing</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">trailStepPts</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">5 pts</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">1 – 10 pts</td>
                        <td className="px-3 py-2 text-zinc-300">Option gain step (pts) to advance trailing SL</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">trailByPts</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">2 pts</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">1 – 5 pts</td>
                        <td className="px-3 py-2 text-zinc-300">Points to ratchet trailing SL downward per step</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">targetPct</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">50%</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">40% – 60%</td>
                        <td className="px-3 py-2 text-zinc-300">Scalp profit target (0 = disabled, let trail run)</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">maxPositions</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">2</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">1 – 3</td>
                        <td className="px-3 py-2 text-zinc-300">Maximum portfolio-wide concurrent open legs</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">maxSameSide</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">1</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">1</td>
                        <td className="px-3 py-2 text-zinc-300">Prevents opening multiple simultaneous PE or CE legs</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">dailyLossLimit</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">₹5,000</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">2% of capital</td>
                        <td className="px-3 py-2 text-zinc-300">Hard stop circuit breaker that halts auto-trading</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">hardCircuitBreaker</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">true</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">true / false</td>
                        <td className="px-3 py-2 text-zinc-300">Emergency squares off all open positions immediately on daily loss breach</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 font-mono font-bold text-white">eodExit</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">15:15</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">15:15</td>
                        <td className="px-3 py-2 text-zinc-300">Mandatory intraday square-off before market close</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: SAFETY & RISK */}
          {activeTab === 'safety' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-red-400 flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4" />
                  Real Money Execution Checklist
                </h3>
                <ul className="space-y-2 text-xs text-zinc-300">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-white">SIM Mode Forward Testing:</strong> Always validate execution in SIM (paper) mode for at least 5 sessions across trending and choppy days before switching to REAL mode.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-white">Broker Session Token:</strong> Ensure your Dhan / Kotak access token has been generated after 06:00 AM IST today to prevent unauthorized rejection during market hours.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-white">Margin Capacity:</strong> Option shorting requires exchange span + exposure margin (~₹1.2L per lot of Nifty). Ensure sufficient unencumbered capital.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-white">Emergency Flattening:</strong> The header contains a dedicated <strong className="text-red-400 font-bold">EXIT ALL</strong> button that will immediately fire market orders to close all open positions.
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-zinc-800 bg-zinc-950/80">
          <p className="text-[11px] text-zinc-500">
            Strategy Spec: <code className="text-zinc-400 font-mono">strategies/breakdown_scalper/strategy.md</code>
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-xs font-bold text-white hover:bg-zinc-800 transition"
          >
            Close Playbook
          </button>
        </div>
      </div>
    </div>
  );
}
