'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import NavBar from '@/components/NavBar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Play, Square, ExternalLink, Loader2, CheckCircle2, XCircle } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

type Strategy = 'ema-crossover' | 'rsi' | 'donchian' | 'supertrend' | 'macd';
type CostProfile = 'intraday_equity' | 'delivery_equity' | 'fno_futures' | 'fno_options';
type AssetType = 'index' | 'equity';

interface RunStatus {
  running: boolean;
  done: boolean;
  percent?: number;
  stage?: string;
  error?: string;
  stopped?: boolean;
  started_at?: string;
  pid?: number;
  result?: BacktestResult | null;
}

interface ComparisonRow {
  Metric: string;
  [strategyCol: string]: string;
}

interface BacktestResult {
  strategy: string;
  strategy_name: string;
  symbol: string;
  asset_type: string;
  cost_profile: string;
  params: Record<string, number>;
  start_date: string;
  end_date: string | null;
  bars: number;
  stats: Record<string, unknown>;
  comparison: ComparisonRow[];
  tearsheet_available: boolean;
  monte_carlo_summary: string | null;
  generated_at: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STRATEGIES: { value: Strategy; label: string; desc: string }[] = [
  { value: 'ema-crossover', label: 'EMA Crossover', desc: 'Fast/slow EMA cross' },
  { value: 'rsi', label: 'RSI Reversion', desc: 'Buy oversold, sell overbought' },
  { value: 'donchian', label: 'Donchian Breakout', desc: 'Channel high/low breakout' },
  { value: 'supertrend', label: 'Supertrend', desc: 'ATR-based trend flip' },
  { value: 'macd', label: 'MACD Crossover', desc: 'MACD/signal line cross' },
];

const COST_PROFILES: { value: CostProfile; label: string }[] = [
  { value: 'delivery_equity', label: 'Delivery Equity (CNC)' },
  { value: 'intraday_equity', label: 'Intraday Equity' },
  { value: 'fno_futures', label: 'F&O Futures' },
  { value: 'fno_options', label: 'F&O Options' },
];

const inputCls = 'w-full bg-zinc-900 border border-zinc-700 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 transition-colors';
const labelCls = 'block text-[10px] font-semibold uppercase tracking-wide text-zinc-500 mb-1';

// pf.stats() ships raw float precision (e.g. 0.5697822890810784) — cap display at
// 2 decimals everywhere, with thousands separators on the integer part, and append
// "%" for keys VectorBT already suffixed "[%]" in its own scale. Non-numeric values
// (Start/End timestamps, "173 days 00:00:00" durations) pass through unchanged.
function formatStatValue(key: string, val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'number') {
    // Whole-number counts (Total Trades, Open Trade PnL=0, ...) stay integers —
    // only fractional values get padded to 2 decimals, so counts don't read "3.00".
    const isWhole = Number.isInteger(val);
    const rounded = val.toLocaleString('en-IN', {
      maximumFractionDigits: 2,
      minimumFractionDigits: isWhole ? 0 : 2,
    });
    return key.includes('[%]') ? `${rounded}%` : rounded;
  }
  return String(val);
}

const STAGE_LABEL: Record<string, string> = {
  starting: 'Starting…',
  loading_data: 'Loading Dhan price data…',
  computing_signals: 'Computing signals…',
  running_backtest: 'Running VectorBT simulation…',
  comparing_benchmark: 'Comparing to benchmark…',
  generating_tearsheet: 'Generating OpenStatz tearsheet…',
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function BacktestVectorbtPage() {
  const [strategy, setStrategy] = useState<Strategy>('ema-crossover');
  const [assetType, setAssetType] = useState<AssetType>('index');
  const [symbol, setSymbol] = useState('NIFTY');
  const [startDate, setStartDate] = useState('2021-01-01');
  const [endDate, setEndDate] = useState('');
  const [costProfile, setCostProfile] = useState<CostProfile>('delivery_equity');

  const [fast, setFast] = useState(20);
  const [slow, setSlow] = useState(50);
  const [rsiLength, setRsiLength] = useState(14);
  const [rsiBuy, setRsiBuy] = useState(30);
  const [rsiSell, setRsiSell] = useState(70);
  const [donchianLength, setDonchianLength] = useState(20);
  const [supertrendLength, setSupertrendLength] = useState(10);
  const [supertrendMultiplier, setSupertrendMultiplier] = useState(3.0);
  const [macdFast, setMacdFast] = useState(12);
  const [macdSlow, setMacdSlow] = useState(26);
  const [macdSignal, setMacdSignal] = useState(9);

  const [status, setStatus] = useState<RunStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest-vectorbt');
      const data: RunStatus = await res.json();
      setStatus(data);
      if (!data.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch { /* ignore transient poll failure */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/backtest-vectorbt')
      .then(r => r.json())
      .then((data: RunStatus) => { if (!cancelled) setStatus(data); })
      .catch(() => { /* ignore transient poll failure */ });
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(poll, 1500);
  }, [poll]);

  const handleStart = async () => {
    setStarting(true);
    try {
      const body: Record<string, unknown> = {
        strategy, symbol, asset_type: assetType,
        start_date: startDate, end_date: endDate || undefined,
        cost_profile: costProfile,
      };
      if (strategy === 'ema-crossover') { body.fast = fast; body.slow = slow; }
      if (strategy === 'rsi') { body.rsi_length = rsiLength; body.rsi_buy = rsiBuy; body.rsi_sell = rsiSell; }
      if (strategy === 'donchian') { body.donchian_length = donchianLength; }
      if (strategy === 'supertrend') { body.supertrend_length = supertrendLength; body.supertrend_multiplier = supertrendMultiplier; }
      if (strategy === 'macd') { body.macd_fast = macdFast; body.macd_slow = macdSlow; body.macd_signal = macdSignal; }

      const res = await fetch('/api/backtest-vectorbt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ running: false, done: true, error: data.error ?? 'Failed to start' });
        return;
      }
      setStatus({ running: true, done: false, percent: 0, stage: 'starting' });
      startPolling();
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    await fetch('/api/backtest-vectorbt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    poll();
  };

  const result = status?.result ?? null;
  const isRunning = Boolean(status?.running);

  return (
    <div className="min-h-screen">
      <NavBar />
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-bold text-zinc-100">VectorBT Backtester</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Vectorized signal backtests on Dhan-sourced data — Indian cost models, OpenStatz tearsheet.{' '}
              <span className="text-amber-300 font-bold uppercase tracking-wide">
                Data: Historical Data/ &amp; Daily_Historical_Data_Fresh/ (Dhan)
              </span>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5">
          {/* ── Config panel ── */}
          <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4 space-y-4 h-fit">
            <div>
              <label className={labelCls}>Strategy</label>
              <Select value={strategy} onValueChange={(v) => v && setStrategy(v as Strategy)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STRATEGIES.map(s => (
                    <SelectItem key={s.value} value={s.value}>{s.label} — {s.desc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Asset Type</label>
                <Select value={assetType} onValueChange={(v) => v && setAssetType(v as AssetType)}>
                  <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="index">Index/Futures</SelectItem>
                    <SelectItem value="equity">Equity</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className={labelCls}>Symbol</label>
                <input className={inputCls} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                       onBlur={(e) => setSymbol(e.target.value.trim().toUpperCase())} placeholder="NIFTY" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Start Date</label>
                <input type="date" className={inputCls} value={startDate}
                       onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>End Date (optional)</label>
                <input type="date" className={inputCls} value={endDate}
                       onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>

            <div>
              <label className={labelCls}>Cost Profile</label>
              <Select value={costProfile} onValueChange={(v) => v && setCostProfile(v as CostProfile)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COST_PROFILES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="border-t border-zinc-800 pt-3" key={strategy}>
              <label className={labelCls}>Strategy Parameters</label>
              {strategy === 'ema-crossover' && (
                <div className="grid grid-cols-2 gap-3">
                  <NumField label="Fast EMA" value={fast} onCommit={setFast} />
                  <NumField label="Slow EMA" value={slow} onCommit={setSlow} />
                </div>
              )}
              {strategy === 'rsi' && (
                <div className="grid grid-cols-3 gap-3">
                  <NumField label="Length" value={rsiLength} onCommit={setRsiLength} />
                  <NumField label="Buy Below" value={rsiBuy} onCommit={setRsiBuy} />
                  <NumField label="Sell Above" value={rsiSell} onCommit={setRsiSell} />
                </div>
              )}
              {strategy === 'donchian' && (
                <div className="grid grid-cols-2 gap-3">
                  <NumField label="Channel Length" value={donchianLength} onCommit={setDonchianLength} />
                </div>
              )}
              {strategy === 'supertrend' && (
                <div className="grid grid-cols-2 gap-3">
                  <NumField label="Length" value={supertrendLength} onCommit={setSupertrendLength} />
                  <NumField label="Multiplier" value={supertrendMultiplier} step={0.5} onCommit={setSupertrendMultiplier} />
                </div>
              )}
              {strategy === 'macd' && (
                <div className="grid grid-cols-3 gap-3">
                  <NumField label="Fast" value={macdFast} onCommit={setMacdFast} />
                  <NumField label="Slow" value={macdSlow} onCommit={setMacdSlow} />
                  <NumField label="Signal" value={macdSignal} onCommit={setMacdSignal} />
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-2">
              {!isRunning ? (
                <Button onClick={handleStart} disabled={starting} className="flex-1 gap-1.5">
                  {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Run Backtest
                </Button>
              ) : (
                <Button onClick={handleStop} variant="destructive" className="flex-1 gap-1.5">
                  <Square className="h-3.5 w-3.5" /> Stop
                </Button>
              )}
            </div>

            {isRunning && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-[11px] text-zinc-400">
                  <span>{STAGE_LABEL[status?.stage ?? ''] ?? 'Running…'}</span>
                  <span>{status?.percent ?? 0}%</span>
                </div>
                <Progress value={status?.percent ?? 0} className="h-1.5" />
              </div>
            )}

            {status?.error && (
              <div className="flex items-start gap-1.5 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
                <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{status.error}</span>
              </div>
            )}
            {status?.stopped && (
              <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
                Stopped by user.
              </div>
            )}
          </div>

          {/* ── Results panel ── */}
          <div className="space-y-4">
            {!result && !isRunning && !status?.error && (
              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-8 text-center text-zinc-500 text-sm">
                Configure a strategy and click Run Backtest.
              </div>
            )}

            {result && (
              <>
                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      <h2 className="text-sm font-bold text-zinc-100">{result.strategy_name} — {result.symbol}</h2>
                      <Badge className="bg-zinc-800 text-zinc-300 border-zinc-700 text-[10px]">{result.bars} bars</Badge>
                    </div>
                    {result.tearsheet_available && (
                      <a href="/api/backtest-vectorbt/report" target="_blank" rel="noopener noreferrer">
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                          <ExternalLink className="h-3.5 w-3.5" /> Open OpenStatz Tearsheet
                        </Button>
                      </a>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs tabular-nums">
                      <thead>
                        <tr className="bg-zinc-800">
                          {result.comparison[0] && Object.keys(result.comparison[0]).map(col => (
                            <th key={col} className="text-left font-bold text-white px-3 py-1.5 first:rounded-l last:rounded-r">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.comparison.map((row, i) => (
                          <tr key={i} className="border-b border-zinc-800/60 last:border-0">
                            {Object.entries(row).map(([col, val]) => (
                              <td key={col} className="px-3 py-1.5 text-zinc-300">{String(val)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {result.monte_carlo_summary && (
                    <p className="text-[11px] text-zinc-500 mt-3">{result.monte_carlo_summary}</p>
                  )}
                </div>

                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4">
                  <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wide mb-3">Full VectorBT Stats</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
                    {Object.entries(result.stats).map(([key, val]) => (
                      <div key={key} className="flex justify-between border-b border-zinc-800/40 py-1">
                        <span className="text-zinc-500">{key.replace(' [%]', '')}</span>
                        <span className="text-zinc-200 tabular-nums">{formatStatValue(key, val)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function NumField({ label, value, onCommit, step = 1 }: {
  label: string; value: number; onCommit: (v: number) => void; step?: number;
}) {
  // No effect syncing draft from value: this field is remounted (see `key={strategy}`
  // at the call site) whenever the parent strategy switch would otherwise require a
  // programmatic reset — React's own "reset state with a key" pattern instead of an
  // effect that re-derives state from props.
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const n = parseFloat(draft);
    if (!Number.isNaN(n)) onCommit(n);
    else setDraft(String(value));
  };

  return (
    <div>
      <label className="block text-[10px] text-zinc-500 mb-1">{label}</label>
      <input
        type="number"
        step={step}
        className={inputCls}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}
