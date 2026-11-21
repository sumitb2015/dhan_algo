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
    badge: 'Highest Profit Factor & Sharpe Ratio',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    summary: 'Textbook multi-timeframe moving average ribbon (EMA 20 > 50 > 200) coupled with ATR volatility trailing bands (Supertrend 10, 3.0).',
    rules: [
      'Trend alignment: Close > EMA 20 > EMA 50 > EMA 200 (stacked moving average ribbon)',
      'Volatility confirmation: Supertrend (10, 3.0) is Green (st_dir == +1, close > Supertrend)',
      'Volume & Strength: Volume >= 80% of 20-day average; RS percentile >= 60 (top 40% strongest)',
      'Exit: Supertrend turns Bearish (Red) or Close drops below EMA 50; 12% disaster trailing stop',
    ],
    verdict: '+21.5% CAGR with lowest Max Drawdown (-12.4%), highest Sharpe (1.59), and highest Profit Factor (2.29). Outstanding risk-adjusted compounding.',
  },
  '2. Andreas Clenow Momentum': {
    key: 'clenow',
    badge: 'Aggressive Compounder',
    badgeColor: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
    summary: 'From Andreas Clenow’s Stocks on the Move: weekly momentum rotation ranking by 90-day annualized exponential slope × R².',
    rules: [
      '15% Gap Filter: Disqualifies any stock with a 1-day move > 15% in past 90 days (eliminates pumps & takeover noise)',
      'Trend gate: Close > 100 SMA and Close > 200 SMA, momentum score > 0',
      'Weekly rank rotation: Rotates out holdings falling out of the top 20% into top leaders',
      'Exit: Close below 100-day SMA, or 15% disaster stop',
    ],
    verdict: '+36.4% CAGR and 2.19 Profit Factor. Turned ₹5 Lakhs into ₹42.00 Lakhs over 6.9 years with gap filtering containing drawdowns.',
  },
  '3. Minervini Trend Template': {
    key: 'minervini',
    badge: 'Best Win Rate & Quality Growth',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    summary: 'Mark Minervini’s Trend Template from Trade Like a Stock Market Wizard. Daily pivot breakout with stacked MAs and rising 200-SMA.',
    rules: [
      'Trend Template: Close > 50 SMA > 150 SMA > 200 SMA, and 200 SMA must be rising (> 22 bars ago)',
      'Base & Extension: Close >= 25% above 52W low, within 20% of 52W high, and <= 5% above 20d pivot',
      'Relative Strength: Universe RS percentile >= 70 (top 30% strongest leaders)',
      'Exit: 12% initial stop; once gain >= 15%, trails 50-day SMA (never loosens)',
    ],
    verdict: '+25.4% CAGR with highest Win Rate (54.8%) and 2.13 Profit Factor. Strict quality filters deliver pristine risk-adjusted returns.',
  },
  '4. 52-Week High Breakout': {
    key: '52w_high',
    badge: 'High Consistency & Clean Breakouts',
    badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    summary: 'George & Hwang (2004) Journal of Finance 52-Week High Anomaly: daily breakout above the 52-week ceiling with zero overhead supply.',
    rules: [
      'Breakout trigger: Daily scan for true 52-week (250-day) high breakout; max 5% extension',
      'Trend filter: Close > 50 SMA > 200 SMA and volume >= 20-day average',
      'Exit: Trailing stop 12% below running peak close; market regime on Nifty 200 SMA',
    ],
    verdict: '+19.4% CAGR with -28.1% max drawdown and 1.76 Profit Factor. Solid, dependable compounding on genuine new 52W peaks.',
  },
  '5. Current Turtle RS Breakout': {
    key: 'turtle_rs',
    badge: 'Defensive Baseline',
    badgeColor: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    summary: 'Our baseline model: mid-weighted composite relative strength (10d, 21d, 63d, 126d) with 55-day Donchian channel breakout.',
    rules: [
      'Composite RS: Outperformance vs Nifty 50 over 2-week, 1-mo, 3-mo, and 6-mo',
      'Entry: 2 consecutive closes at new 55-day high with stacked EMAs (20 > 50 > 200)',
      'Exit: 3-stage ratchet (12% stop → breakeven at +15% → trailing 25% from peak) + rank rotation exits',
    ],
    verdict: '+14.9% CAGR with the lowest drawdown of all models (-14.3%) and highest Sharpe (1.21). Maximum downside protection.',
  },
  '6. Connors RSI-2 Mean Reversion': {
    key: 'connors_rsi2',
    badge: 'High Frequency Dip Buyer',
    badgeColor: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    summary: 'Larry Connors 2-period RSI swing system: buys deep oversold washouts (RSI < 10) in stocks above their 200 SMA.',
    rules: [
      'Trend filter: Stock > 200 SMA and Nifty 50 > 200 SMA',
      'Entry: 2-period RSI drops below 10',
      'Exit: Close crosses above 5-day SMA or 6 days max hold',
    ],
    verdict: '-1.05% CAGR despite 58.3% win rate. 4,639 trades caused statutory delivery taxes (STT 0.1% both ways) to eat all profits.',
  },
};

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
          Side-by-side performance across <b>486 liquid Nifty 500 stocks</b> over 6.9 years.
          All tests run on historical daily data incorporating full Indian statutory delivery costs
          (0.10% Securities Transaction Tax on buy & sell, exchange turnover, stamp duty, SEBI fees) and 0.05% slippage.
          Initial capital: <b>₹5,00,000</b> deployed across 10 concurrent slots.
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
                const isTopCagr = row['CAGR (%)'].includes('35.') || row['CAGR (%)'].includes('40.');
                const isBestPF = row['Profit Factor'].includes('2.29');
                const isLowestDD = row['Max Drawdown'].includes('12.43');

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
