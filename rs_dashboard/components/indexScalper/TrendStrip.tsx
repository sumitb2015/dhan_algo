'use client';

// Trend strip + multi-timeframe check above the /index-scalper charts (rules: lib/indexScalperTrend.ts). Display only:
// nothing here prices, sends or blocks an order.
//
// Reads the UNDERLYING (NIFTY / SENSEX index, the crude future) on 3m / 5m / 15m / 1h, each from useChartBars (the
// candles route's own session-anchored bars + live ticks, the same bars a chart on that timeframe draws), on the LAST
// CLOSED bar. It owns those four hooks, so feed pushes re-render this row only, and the reads recompute once per bar
// close (keyed on closedKey), not per tick.

import { memo, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { readPref, savePref } from '@/lib/localPref';
import { closedBars, closedKey, mtfSummary, mtfText, trendRead, TREND_PARAMS, type Dir, type TrendRead } from '@/lib/indexScalperTrend';
import { inMarketSession } from '@/lib/indexScalperSession';
import type { Underlying } from '@/lib/indexScalperInstrument';
import type { ResolvedSource } from '@/lib/indexScalperChartSource';
import type { Bar } from '@/lib/indexScalperIndicators';
import { useChartBars, type Interval } from './useChartBars';
import type { IndexScalperFeed } from './useIndexScalperFeed';

export const TREND_TFS = ['3', '5', '15', '60'] as const;
type TrendTf = (typeof TREND_TFS)[number];
const TF_KEY = 'indexScalper.trendTf';
const tfLabel = (tf: TrendTf) => (tf === '60' ? '1h' : `${tf}m`);
const tfName = (tf: TrendTf) => (tf === '60' ? '1 hour' : `${tf} minute`);

const UNDERLYING_SRC: ResolvedSource = { kind: 'underlying', type: null, strike: null, dhanId: null, kotakSymbol: null, tick: 0 };

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const hhmm = (t: number) => {
  const d = new Date((t + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

const arrow = (d: Dir | null) => (d === 1 ? '▲' : d === -1 ? '▼' : d === 0 ? '■' : '—');
const dirTone = (d: Dir | null) => (d === 1 ? 'text-emerald-400' : d === -1 ? 'text-rose-400' : 'text-zinc-500');
const biasWord = (r: TrendRead | null) => (r?.bias === 'bull' ? 'bullish' : r?.bias === 'bear' ? 'bearish' : r?.bias === 'mixed' ? 'mixed' : 'no read');

/** The read on a timeframe's last closed bar, recomputed only when the closed tail changes. */
function useTrendRead(bars: Bar[], tf: TrendTf, nowSec: number, underlying: Underlying): TrendRead | null {
  // Outside the session every bar is closed (the 15:15 1h bar must not wait until 16:15).
  const closed = closedBars(bars, Number(tf), inMarketSession(underlying, nowSec * 1000) ? nowSec : Infinity);
  const key = closedKey(closed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => trendRead(closed), [key]);
}

function Light({ label, dir, title, testId }: { label: string; dir: Dir | null; title: string; testId: string }) {
  return (
    <span data-testid={testId} data-dir={dir ?? ''} title={title} className="flex items-center gap-1 px-1.5 shrink-0">
      <span className="text-zinc-400">{label}</span>
      <span className={cn('font-bold', dirTone(dir))}>{arrow(dir)}</span>
    </span>
  );
}

interface Props { underlying: Underlying; feed: IndexScalperFeed; days: number; refreshTick: number }

function TrendStrip({ underlying, feed, days, refreshTick }: Props) {
  const b3 = useChartBars(underlying, UNDERLYING_SRC, '3' as Interval, days, refreshTick, feed);
  const b5 = useChartBars(underlying, UNDERLYING_SRC, '5' as Interval, days, refreshTick, feed);
  const b15 = useChartBars(underlying, UNDERLYING_SRC, '15' as Interval, days, refreshTick, feed);
  const b60 = useChartBars(underlying, UNDERLYING_SRC, '60' as Interval, days, refreshTick, feed);

  // A clock for "is the last bar closed yet": a bar closes on time, not on a tick.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(t);
  }, []);

  const r3 = useTrendRead(b3.bars, '3', nowSec, underlying);
  const r5 = useTrendRead(b5.bars, '5', nowSec, underlying);
  const r15 = useTrendRead(b15.bars, '15', nowSec, underlying);
  const r60 = useTrendRead(b60.bars, '60', nowSec, underlying);
  const reads: Record<TrendTf, TrendRead | null> = { '3': r3, '5': r5, '15': r15, '60': r60 };
  const loading = b3.loading || b5.loading || b15.loading || b60.loading;

  const [tf, setTf] = useState<TrendTf>('5');
  useEffect(() => {
    const saved = readPref(TF_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && (TREND_TFS as readonly string[]).includes(saved)) setTf(saved as TrendTf);
  }, []);
  const pick = (t: TrendTf) => { setTf(t); savePref(TF_KEY, t); };

  const r = reads[tf];
  const sum = mtfSummary(TREND_TFS.map(t => reads[t]));
  const P = TREND_PARAMS;

  return (
    <div data-testid="trend-strip" className="flex items-center h-7 px-2 gap-1 border-b border-zinc-800 bg-zinc-950 text-[11px] font-mono shrink-0 overflow-x-auto"
      title="Trend on the underlying, read on each timeframe's last CLOSED candle (display only)">
      <span className="font-sans font-bold text-zinc-300 shrink-0">TREND</span>
      <span data-testid="trend-tf" className="font-bold text-white shrink-0">{tfLabel(tf)}</span>
      <span className="text-zinc-500 shrink-0" title="Time of the closed candle read: the strip lags the forming candle by up to one bar">
        {r ? `· ${hhmm(r.t)}` : loading ? '· loading' : '· —'}
      </span>
      <span className="w-px h-4 bg-zinc-800 mx-1 shrink-0" />
      <Light testId="trend-vwap" label="VWAP" dir={r?.vwap.dir ?? null}
        title={r ? `Close ${fmt(r.close)} vs session VWAP ${fmt(r.vwap.value)}` : 'No closed candle yet'} />
      <Light testId="trend-ema" label={`EMA ${P.emaFast}/${P.emaSlow}`} dir={r?.ema.dir ?? null}
        title={r ? `EMA ${P.emaFast} ${fmt(r.ema.fast)} vs EMA ${P.emaSlow} ${fmt(r.ema.slow)}` : 'No closed candle yet'} />
      <Light testId="trend-st" label="ST" dir={r?.st.dir ?? null}
        title={r ? `Supertrend (${P.stPeriod}, ${P.stMult}) ${fmt(r.st.line)}: ${r.st.dir === 1 ? 'up' : r.st.dir === -1 ? 'down' : 'warming up'}` : 'No closed candle yet'} />
      <span data-testid="trend-adx" className="flex items-center gap-1 px-1.5 shrink-0"
        title={r?.adx.adx != null
          ? `ADX(${P.adxPeriod}) ${r.adx.adx.toFixed(1)}, +DI ${r.adx.plusDi?.toFixed(1)} / −DI ${r.adx.minusDi?.toFixed(1)}. Choppy below ${P.choppyBelow}; Strong from ${P.strongFrom} with the DI pointing with the bias`
          : 'ADX warming up'}>
        <span className="text-zinc-400">ADX</span>
        <span className="font-bold text-zinc-200">{r?.adx.adx != null ? r.adx.adx.toFixed(0) : '—'}</span>
        {r?.strength === 'choppy' && <span data-testid="trend-strength" className="font-sans font-bold text-amber-400">Choppy</span>}
        {r?.strength === 'strong' && <span data-testid="trend-strength" className="font-sans font-bold text-white">Strong</span>}
      </span>
      <span data-testid="trend-bias" data-bias={r?.bias ?? ''}
        title="Bullish / Bearish when VWAP, EMA 9/20 and Supertrend all agree; Mixed when they do not"
        className={cn('ml-1 px-2 h-5 leading-5 rounded font-sans font-bold text-[10px] tracking-wide shrink-0',
          r?.bias === 'bull' ? 'bg-emerald-600 text-oncolor' : r?.bias === 'bear' ? 'bg-rose-600 text-oncolor' : 'bg-zinc-800 text-zinc-300')}>
        {r?.bias === 'bull' ? 'BULLISH' : r?.bias === 'bear' ? 'BEARISH' : r?.bias === 'mixed' ? 'MIXED' : '—'}
      </span>

      <span className="w-px h-4 bg-zinc-700 mx-2 shrink-0" />
      <span className="font-sans font-bold text-zinc-300 shrink-0">MTF</span>
      <div role="group" aria-label="Multi-timeframe trend" className="flex items-center gap-0.5 shrink-0">
        {TREND_TFS.map(t => {
          const rr = reads[t];
          const d: Dir | null = rr?.bias === 'bull' ? 1 : rr?.bias === 'bear' ? -1 : null;
          return (
            <button key={t} type="button" data-testid={`mtf-chip-${t}`} data-bias={rr?.bias ?? ''} aria-pressed={tf === t}
              aria-label={`${tfName(t)} trend: ${biasWord(rr)}`}
              title={`${tfName(t)}: ${biasWord(rr)}${rr?.strength ? ` (${rr.strength})` : ''}${rr ? ` · closed ${hhmm(rr.t)}` : ''}. Click to show its lights`}
              onClick={() => pick(t)}
              className={cn('h-5 px-1.5 rounded flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                tf === t ? 'bg-zinc-700 text-white' : 'text-zinc-300 hover:bg-zinc-800')}>
              <span>{tfLabel(t)}</span>
              <span className={cn('font-bold', rr?.bias === 'mixed' ? 'text-zinc-400' : dirTone(d))}>{rr?.bias === 'mixed' ? '≈' : arrow(d)}</span>
            </button>
          );
        })}
      </div>
      <span data-testid="mtf-summary" className={cn('ml-1 font-sans font-bold shrink-0',
        sum.aligned === 'bull' ? 'text-emerald-400' : sum.aligned === 'bear' ? 'text-rose-400' : 'text-zinc-400')}
        title="Trade with the trend when every timeframe agrees (ALIGNED)">
        {mtfText(sum)}
      </span>
    </div>
  );
}

export default memo(TrendStrip);
