'use client';

import React, { useState, useEffect } from 'react';
import {
  TrendingUp, RefreshCw, Award, CheckCircle2, ShieldCheck, ArrowRight,
  BarChart2, Zap, AlertTriangle
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface StrategyResult {
  Strategy: string;
  'CAGR (%)': string;
  'Max Drawdown': string;
  Sharpe: string;
  Calmar: string;
  'Win Rate': string;
  'Profit Factor': string;
  'Total Trades': number;
  'Final Value (5L)': string;
}

const Info = ({ tip, className = '', children }: {
  tip: React.ReactNode; className?: string; children: React.ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger className={`cursor-help ${className}`}>{children}</TooltipTrigger>
    <TooltipContent>
      <span className="block max-w-xs text-xs leading-relaxed">{tip}</span>
    </TooltipContent>
  </Tooltip>
);

const TH = ({ children, align = 'left', tip }: {
  children: React.ReactNode; align?: 'left' | 'right'; tip?: React.ReactNode;
}) => (
  <th className={`text-xs font-bold text-white px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
    {tip ? (
      <Info tip={tip} className="font-bold text-white underline decoration-dotted decoration-zinc-500 underline-offset-2">
        {children}
      </Info>
    ) : children}
  </th>
);

const TD = ({ children, align = 'left', className = '', title }: {
  children: React.ReactNode; align?: 'left' | 'right'; className?: string; title?: string;
}) => (
  <td className={`px-3 py-2.5 whitespace-nowrap ${align === 'right' ? 'text-right tabular-nums' : ''} ${className}`} title={title}>
    {children}
  </td>
);

// Rules as the replay engine (scripts/analysis/simulate_momentum_replay.py + lib/<model>.py) runs them. The figures
// live in the table, which is computed by backtest_strategy_comparison.py — keep numbers out of these notes, or they
// go stale on the next engine change (they did: every verdict below quoted pre-2026-11-23 numbers).
// Engine-wide: signal on the close, fill at the next open, 0.111%/side + Rs 20 + 0.05% slippage, slots sized off
// current equity (compounding), Nifty 50 weekly 200-SMA regime, max 2 per sector, data-gap exits, survivor-biased
// universe (today's Nifty 500 list).
const STRATEGY_DETAILS: Record<string, {
  key: string;
  badge: string;
  badgeColor: string;
  summary: string;
  rules: string[];
  verdict: string;
}> = {
  '1. EMA & Supertrend (Trend Follower)': {
    key: 'ema_supertrend',
    badge: 'Trend Ribbon',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    summary: 'Stacked EMA ribbon (20 > 50 > 200) with a green Supertrend (10, 3.0) as the entry filter; ranked by composite RS.',
    rules: [
      'Entry (daily): Close > EMA 20 > EMA 50 > EMA 200, Supertrend (10, 3.0) green',
      'Volume >= 80% of the 20-day average; composite-RS percentile >= 60',
      'Exit: stop 12% below entry, trailing 12% below the peak once up 15%. The Supertrend-flip and EMA-50 exits exist but are off (both whipsawed in the ablation)',
    ],
    verdict: 'Supertrend works here as an entry filter only. Read the drawdown column with the CAGR: fully invested, it is not a defensive model.',
  },
  '2. Andreas Clenow Momentum': {
    key: 'clenow',
    badge: 'Smooth-Slope Rotation',
    badgeColor: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
    summary: 'From Stocks on the Move: rank by 90-day annualized exponential regression slope x R², rotate weekly.',
    rules: [
      'Entry (daily): Close > 100 SMA and > 200 SMA, no 1-day move > 15% in 90 days, score > 0; best scores first',
      'Weekly rotation: sells holdings that fall out of the top 20% of scores (a name with no bar that day is not sold for it)',
      'Exit: Close below the 100-day SMA, or a 15% stop. Regime OFF blocks new buys but does not liquidate (as in the book)',
      'Not the book: equal 4:3 slot sizing, not ATR risk parity; 10 slots, not unlimited positions',
    ],
    verdict: 'The only model that rides a regime-OFF week instead of going to cash, so its drawdown includes the corrections the others sit out.',
  },
  '3. Minervini Trend Template': {
    key: 'minervini',
    badge: 'Quality Growth',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    summary: 'Mark Minervini’s Trend Template: daily pivot breakout with stacked SMAs and a rising 200 SMA.',
    rules: [
      'Trend: Close > 50 SMA > 150 SMA > 200 SMA, and the 200 SMA above its level 22 sessions ago',
      'Base: >= 25% above the 52W low, within 20% of the 52W high, at or <= 5% above the 20-day pivot; volume >= 20-day average',
      'Relative strength: composite-RS percentile >= 70',
      'Exit: 12% initial stop; once up 15%, trails the 50-day SMA (never loosens)',
    ],
    verdict: 'Highest win rate of the breakout models. Parameters were chosen looking at both 2020-23 and 2024-26, so treat it as lightly in-sample.',
  },
  '4. 52-Week High Breakout': {
    key: '52w_high',
    badge: '52W Proximity',
    badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    summary: 'George & Hwang (2004): stocks nearest their 52-week high outperform. Ranked by close / 52-week high.',
    rules: [
      'Entry (daily): close within 5% of the 52-week high (breakout setting 5; other settings = strict breakout, max 5% extension)',
      'Trend: Close > 50 SMA > 200 SMA; volume >= 20-day average',
      'Exit: trailing stop 12% below the peak close',
    ],
    verdict: 'Simple and close to the paper. A plain trailing stop, so it gives back more of each winner than the ladder models.',
  },
  '5. Current Turtle RS Breakout': {
    key: 'turtle_rs',
    badge: 'Live Baseline',
    badgeColor: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    summary: 'The live default: composite RS (10/21/63/126 days vs Nifty 50) with a confirmed 55-day breakout.',
    rules: [
      'Entry (daily): RS rank <= 20, Close > EMA 20 > 50 > 200, 2 consecutive closes above the 55-day high, volume > 20-day average',
      'Exit: 12% stop, breakeven at +15%, trail 25% below the peak once +25%',
      'Weekly rotation: sells after 2 consecutive weekly reviews ranked below 25 (7-day minimum hold)',
    ],
    verdict: 'What the live bot runs. Before 2026-11-23 the replay rotated daily and skipped the rank-20 gate; this row is the corrected engine.',
  },
  '5b. Turtle RS Optimised': {
    key: 'turtle_rs_opt',
    badge: 'Looser Exits',
    badgeColor: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    summary: 'Turtle RS with looser exits: rotation sells only below rank 60 (baseline 25), initial stop 20% (baseline 12%).',
    rules: [
      'Entry: unchanged (RS rank <= 20, stacked EMAs, confirmed 55-day breakout)',
      'Exit: 20% stop, breakeven at +15%, 25% trail once +25%; weekly rotation sells only below rank 60',
    ],
    verdict: 'Its walk-forward tuning ran on the old daily-rotation engine, where looser exits mostly offset churn. On the corrected engine the wider 20% stop buys a little more return for a deeper drawdown than the baseline; re-validate before switching live.',
  },
  '6. Connors RSI-2 Mean Reversion': {
    key: 'connors_rsi2',
    badge: 'Contrast: Mean Reversion',
    badgeColor: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    summary: 'Larry Connors 2-period RSI swing system: buys oversold dips (RSI < 10) in stocks above their 200 SMA.',
    rules: [
      'Trend filter: Stock > 200 SMA and Nifty 50 > 200 SMA',
      'Entry: 2-period RSI below 10; exit on a close above the 5-day SMA, 6 days max, or a 6% stop',
      'Own runner, not the replay engine: fills at the signal close',
    ],
    verdict: 'Thousands of short trades: delivery costs (STT both ways) eat the edge. Kept as a contrast, not a candidate.',
  },
  '7. RS + Supertrend (Vivek Bajaj)': {
    key: 'rs_supertrend',
    badge: 'Video Rules, Backtested',
    badgeColor: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    summary: 'Vivek Bajaj (Learn2Trade session 19): strength vs Nifty positive and rising, Supertrend green; hold with a trailing stop.',
    rules: [
      'Relative strength: (stock / stock[123 bars]) / (Nifty / Nifty[123 bars]) - 1 > 0, with its 50-bar average rising 3 bars',
      'Trend: Supertrend (10, 2.0) green and Close > 50 SMA; 20-day traded value >= Rs 2 crore',
      'Exit: 12% stop, trailing 12% below the peak once up 15%; the video’s Supertrend-flip exit is off (it whipsawed)',
      'The video gives no periods, stop or size: those are this test’s choices',
    ],
    verdict: 'Tuned on 2020-23 and checked once on 2024-26, where it earned much less. See the vault page rs-supertrend-session19.',
  },
  '8. Weinstein Stage 2': {
    key: 'weinstein',
    badge: 'Weekly Base Breakout',
    badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    summary: 'Stan Weinstein Stage 2 (The Long & The Short ep. 56 rule set): weekly breakout from a base above a rising 30-week MA.',
    rules: [
      'Entry (weekly close): prior downtrend and a base, close above the 26-week high and a rising 30-week MA, volume >= 2x the 4-week average, RS ratio above its 52-week average',
      'Exit: weekly close below a 30-week MA that is no longer rising, or a 12% stop on any daily close (the video has no stop)',
    ],
    verdict: 'Fewest trades and the highest profit factor; a handful of big winners carry it, so the result is sensitive to which names happened to break out.',
  },
};

/** Numeric value of a formatted cell such as "+28.10%", "Rs 2,734,444" or "1.90". */
const num = (v: string | number) => Number(String(v).replace(/[^0-9.+-]/g, '')) || 0;

export default function StrategyBenchmarkPanel({ onSelectStrategy }: {
  onSelectStrategy: (strategyKey: string) => void;
}) {
  const [results, setResults] = useState<StrategyResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchResults = async (force: boolean = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/momentum/comparison${force ? '?force=true' : ''}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to load comparison data');
      setResults(json.results || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchResults();
  }, []);

  // Highlight the best cell of each column, computed from the results (they used to be hardcoded string matches).
  const best = {
    cagr: Math.max(...results.map((r) => num(r['CAGR (%)']))),
    pf: Math.max(...results.map((r) => num(r['Profit Factor']))),
    dd: Math.max(...results.map((r) => num(r['Max Drawdown']))),   // drawdowns are negative: max = shallowest
  };

  return (
    <div className="space-y-6">
      {/* Overview Banner */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BarChart2 className="text-emerald-400" size={18} />
            <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wider">
              Nifty 500 Multi-Strategy Comparative Research & Backtest (2020 – 2026)
            </h2>
          </div>
          <button
            onClick={() => fetchResults(true)}
            disabled={loading}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-xs rounded font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Re-running Backtests…' : 'Re-run Comparison'}
          </button>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed max-w-4xl">
          Every momentum model runs through the same replay engine on the Nifty 500 (today&apos;s list, so survivor-biased),
          2020-01-10 to the latest data day: signal on the close, fill at the next open, 0.111% statutory cost per side
          + ₹20 per order + 0.05% slippage. <b>₹5,00,000</b> across 10 slots, each sized off current equity (compounding),
          max 2 per sector, Nifty 50 weekly 200-SMA regime. Connors RSI-2 is a contrast with its own runner.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-4 py-3 text-xs text-red-400 flex items-center gap-2">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {loading && results.length === 0 && (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <RefreshCw size={24} className="animate-spin text-emerald-400" />
          <div className="text-xs text-zinc-400 uppercase tracking-widest font-semibold">
            Loading Backtest Performance Matrix…
          </div>
        </div>
      )}

      {/* Main Comparative Matrix Table */}
      {results.length > 0 && (
        <div className="overflow-x-auto border border-zinc-800 rounded-lg bg-zinc-900/60">
          <table className="w-full text-xs text-zinc-300">
            <thead className="bg-zinc-800">
              <tr>
                <TH>Strategy Model</TH>
                <TH align="right" tip="Compound Annual Growth Rate net of costs">CAGR (%)</TH>
                <TH align="right" tip="Peak-to-trough worst portfolio drawdown">Max Drawdown</TH>
                <TH align="right" tip="Risk-adjusted return vs volatility">Sharpe</TH>
                <TH align="right" tip="CAGR divided by Max Drawdown">Calmar</TH>
                <TH align="right" tip="Percentage of profitable closed trades">Win Rate</TH>
                <TH align="right" tip="Gross Profit / Gross Loss">Profit Factor</TH>
                <TH align="right" tip="Total round-trip completed trades">Trades</TH>
                <TH align="right" tip="Growth of ₹5,00,000 starting capital">Final Value (₹5L)</TH>
                <TH align="right">Action</TH>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => {
                const details = STRATEGY_DETAILS[row.Strategy] || Object.values(STRATEGY_DETAILS).find(d => row.Strategy.toLowerCase().includes(d.key.replace('_', ' ')) || (d.key === 'ema_supertrend' && row.Strategy.toLowerCase().includes('ema')));
                const isTopCagr = num(row['CAGR (%)']) === best.cagr;
                const isBestPF = num(row['Profit Factor']) === best.pf;
                const isLowestDD = num(row['Max Drawdown']) === best.dd;

                return (
                  <tr key={row.Strategy} className="border-t border-zinc-800 hover:bg-zinc-800/40 transition-colors">
                    <TD className="font-bold text-white">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span>{row.Strategy}</span>
                          {details && (
                            <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold border ${details.badgeColor}`}>
                              {details.badge}
                            </span>
                          )}
                        </div>
                        {details && (
                          <span className="text-[11px] text-zinc-500 font-normal">
                            {details.summary}
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD align="right" className={`font-bold text-sm ${isTopCagr ? 'text-emerald-300' : 'text-emerald-400'}`}>
                      {row['CAGR (%)']}
                    </TD>
                    <TD align="right" className={isLowestDD ? 'text-emerald-400 font-bold' : 'text-red-400'}>
                      {row['Max Drawdown']}
                    </TD>
                    <TD align="right" className="text-zinc-200">{row.Sharpe}</TD>
                    <TD align="right" className="text-zinc-200">{row.Calmar}</TD>
                    <TD align="right" className="text-zinc-300">{row['Win Rate']}</TD>
                    <TD align="right" className={`font-bold ${isBestPF ? 'text-emerald-400' : 'text-zinc-200'}`}>
                      {row['Profit Factor']}
                    </TD>
                    <TD align="right" className="text-zinc-400">{row['Total Trades']}</TD>
                    <TD align="right" className="font-bold text-zinc-100 text-sm">
                      {row['Final Value (5L)']}
                    </TD>
                    <TD align="right">
                      {details && details.key !== 'connors_rsi2' && (
                        <button
                          onClick={() => onSelectStrategy(details.key)}
                          className="px-2.5 py-1 bg-emerald-600/30 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 rounded text-xs font-bold uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-colors ml-auto"
                        >
                          <span>Replay</span>
                          <ArrowRight size={12} />
                        </button>
                      )}
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Strategy Detail Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Object.entries(STRATEGY_DETAILS).map(([name, det]) => (
          <div key={name} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-zinc-100">{name}</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${det.badgeColor}`}>
                  {det.badge}
                </span>
              </div>
              <p className="text-xs text-zinc-400">{det.summary}</p>
              <div className="space-y-1 pt-1">
                <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Strategy Rules:</div>
                <ul className="text-xs text-zinc-400 space-y-1 list-disc list-inside">
                  {det.rules.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="pt-3 border-t border-zinc-800 flex items-center justify-between gap-3">
              <span className="text-[11px] text-zinc-400 font-medium">{det.verdict}</span>
              {det.key !== 'connors_rsi2' && (
                <button
                  onClick={() => onSelectStrategy(det.key)}
                  className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors"
                >
                  Select & Replay
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
