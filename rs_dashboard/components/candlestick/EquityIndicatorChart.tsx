'use client';

// The /candlestick page's chart: daily / weekly / monthly EOD candles with the Index Scalper's indicator engine
// (lib/indexScalperIndicators.ts: TradingView-matched EMA / SMA / Supertrend (Pine) / Bollinger / RSI / Stoch RSI /
// MACD / ADX / EMA Cross / Market structure), oscillators in their own panes, volume + Volume MA on a hidden scale,
// a TradingView-style OHLC + indicator legend that follows the crosshair, and 52-week high / low lines.
// Static EOD data, so every change is a full setData (no tick fast path is needed here).

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Settings2, X } from 'lucide-react';
import {
  createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, LineStyle,
  PriceScaleMode,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type SeriesType,
  type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { useChartChrome } from '@/lib/chartTheme';
import {
  computeIndicator, indicatorLabel, pointColor, volumeMa,
  type Bar, type IndicatorInstance, type IndicatorOutput, type OutSeries,
} from '@/lib/indexScalperIndicators';
import { fmtVolume, legendAt } from '@/lib/equityChart';
import { cn } from '@/lib/utils';

const UP = '#34d399';
const DOWN = '#f87171';
const VOL_UP = 'rgba(52, 211, 153, 0.45)';
const VOL_DOWN = 'rgba(248, 113, 113, 0.45)';
const VOL_MA = '#38bdf8';
const W52 = '#f59e0b';

const toTime = (t: number) => t as UTCTimestamp;
const px = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function seriesData(s: OutSeries, bars: Bar[]) {
  return s.values.map((v, i) => {
    if (v === null || !Number.isFinite(v)) return { time: toTime(bars[i].t) };
    const color = pointColor(s, i);
    return color ? { time: toTime(bars[i].t), value: v, color } : { time: toTime(bars[i].t), value: v };
  });
}

interface Props {
  bars: Bar[];
  indicators: IndicatorInstance[];
  /** Trailing bars to frame (null = all); re-applied on every `viewToken` bump. */
  initialBars: number | null;
  viewToken: number;
  logScale: boolean;
  week52: { high: number; low: number } | null;
  onToggle: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}

function EquityIndicatorChart({ bars, indicators, initialBars, viewToken, logScale, week52, onToggle, onEdit, onRemove }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const volMaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const indRef = useRef<ISeriesApi<SeriesType>[]>([]);
  const markerRef = useRef<ISeriesMarkersPluginApi<Time>[]>([]);
  const w52Ref = useRef<IPriceLine[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const chrome = useChartChrome();

  // One output per visible indicator; Volume is drawn by the chart itself (computeIndicator returns no series for it).
  const outputs = useMemo(
    () => indicators.filter(i => i.visible && i.kind !== 'volume').map(ind => ({ ind, out: computeIndicator(bars, ind) as IndicatorOutput })),
    [bars, indicators],
  );
  const volInd = indicators.find(i => i.kind === 'volume');
  const volOn = !!volInd?.visible && bars.some(b => b.v !== undefined);
  const volMaLen = volInd ? volInd.params.ma ?? 20 : 0;

  // chart lifecycle
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const chart = createChart(box, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: chrome.textSecondary, fontSize: 11, panes: { separatorColor: chrome.baseline } },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: chrome.baseline },
      timeScale: { borderColor: chrome.baseline, timeVisible: false, rightOffset: 6 },
      autoSize: true,
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const volMa = chart.addSeries(LineSeries, { priceScaleId: 'vol', color: VOL_MA, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chart.subscribeCrosshairMove(p => {
      const l = p.logical;
      setHover(p.point && l !== undefined && l !== null ? Math.round(l) : null);
    });
    chartRef.current = chart; candleRef.current = candles; volRef.current = vol; volMaRef.current = volMa;
    return () => {
      chart.remove();
      chartRef.current = null; candleRef.current = null; volRef.current = null; volMaRef.current = null;
      // the series, panes, markers and price lines went with the chart
      indRef.current = []; markerRef.current = []; w52Ref.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme (a canvas: colours are JS options, re-applied when the theme flips)
  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { textColor: chrome.textSecondary, panes: { separatorColor: chrome.baseline } },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      rightPriceScale: { borderColor: chrome.baseline },
      timeScale: { borderColor: chrome.baseline },
    });
  }, [chrome]);

  // candles + indicator series (full rebuild: EOD data changes only on a new symbol / timeframe / indicator edit)
  useEffect(() => {
    const chart = chartRef.current, candles = candleRef.current;
    if (!chart || !candles) return;
    candles.setData(bars.map(b => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    for (const m of markerRef.current) { try { m.detach(); } catch { /* gone */ } }
    markerRef.current = [];
    for (const s of indRef.current) { try { chart.removeSeries(s); } catch { /* gone */ } }
    indRef.current = [];
    for (let i = chart.panes().length - 1; i > 0; i--) { try { chart.removePane(i); } catch { /* gone */ } }
    if (bars.length === 0) return;
    let pane = 0;
    for (const { out } of outputs) {
      const paneIdx = out.pane === 'sub' ? ++pane : 0;
      for (const s of out.series) {
        let api: ISeriesApi<SeriesType>;
        if (s.style === 'histogram') {
          api = chart.addSeries(HistogramSeries, { color: s.color, priceLineVisible: false, lastValueVisible: false, title: '' }, paneIdx);
        } else {
          const thick = s.lineWidth ?? (paneIdx === 0 ? (s.colors ? 3 : 2) : 1);
          api = chart.addSeries(LineSeries, {
            color: s.color, lineWidth: thick as 1 | 2 | 3 | 4, priceLineVisible: false,
            lastValueVisible: !s.shadow && !s.noLabel, title: s.shadow || s.noLabel ? '' : s.axisLabel, crosshairMarkerVisible: false,
            ...(s.shadow ? { autoscaleInfoProvider: () => null } : {}),
          }, paneIdx);
          for (const g of s.guides ?? []) api.createPriceLine({ price: g, color: chrome.baseline, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
        }
        api.setData(seriesData(s, bars) as never);
        if (s.markers?.length) {
          const plugin = createSeriesMarkers(api, s.markers.filter(m => bars[m.i]).map(m => {
            const position = m.position ?? 'atPriceMiddle';
            const atPrice = position === 'atPriceMiddle' || position === 'atPriceTop' || position === 'atPriceBottom';
            return {
              time: toTime(bars[m.i].t), position, ...(atPrice ? { price: m.price } : {}), shape: m.shape ?? 'circle',
              color: m.color, size: m.size ?? 1, ...(m.text ? { text: m.text } : {}),
            } as SeriesMarker<Time>;
          }));
          markerRef.current.push(plugin);
        }
        indRef.current.push(api);
      }
    }
    try {
      const panes = chart.panes();
      panes[0]?.setStretchFactor(pane > 0 ? 3 : 1);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    } catch { /* sizing is cosmetic */ }
  }, [bars, outputs, chrome.baseline]);

  // volume bars + Volume MA; the candles keep out of the bottom band while they show
  useEffect(() => {
    const vol = volRef.current, ma = volMaRef.current, candles = candleRef.current;
    if (!vol || !ma || !candles) return;
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: volOn ? 0.22 : 0.06 } });
    if (!volOn) { vol.setData([]); ma.setData([]); return; }
    vol.setData(bars.map(b => ({ time: toTime(b.t), value: b.v ?? 0, color: b.c >= b.o ? VOL_UP : VOL_DOWN })));
    const m = volumeMa(bars, volMaLen);
    ma.setData(volMaLen >= 1 ? bars.map((b, i) => (m[i] === null ? { time: toTime(b.t) } : { time: toTime(b.t), value: m[i] as number })) : []);
  }, [bars, volOn, volMaLen]);

  // 52-week high / low price lines on the candle series
  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    for (const l of w52Ref.current) { try { candles.removePriceLine(l); } catch { /* gone */ } }
    w52Ref.current = [];
    if (!week52) return;
    w52Ref.current = [
      candles.createPriceLine({ price: week52.high, color: W52, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '52W H' }),
      candles.createPriceLine({ price: week52.low, color: W52, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '52W L' }),
    ];
  }, [week52]);

  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale]);

  // Frame the period (and turn price auto-scale back on after a hand drag) on a period / symbol / timeframe change or
  // the Reset button. Theme flips and indicator edits never move the view.
  const n = bars.length;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || n === 0) return;
    chart.priceScale('right').applyOptions({ autoScale: true });
    const ts = chart.timeScale();
    if (initialBars === null || initialBars >= n) ts.fitContent();
    else ts.setVisibleLogicalRange({ from: n - initialBars, to: n - 1 + 6 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewToken, n]);

  const idx = hover !== null && hover >= 0 && hover < n ? hover : n - 1;
  const lg = legendAt(bars, idx);
  const date = bars[idx] ? new Date(bars[idx].t * 1000).toISOString().slice(0, 10) : '';
  const tone = lg && lg.chg !== null ? (lg.chg >= 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-300';
  const valueAt = (s: OutSeries) => {
    const v = s.values[idx];
    return v === null || v === undefined || !Number.isFinite(v) ? '—' : px(v);
  };

  return (
    <div className="relative w-full h-full">
      <div ref={boxRef} className="w-full h-full" data-testid="equity-chart" />
      {lg && (
        <div className="absolute top-1 left-2 z-10 flex flex-col gap-0.5 text-[11px] tabular-nums pointer-events-none max-w-[70%]" data-testid="chart-legend">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <span className="text-zinc-400">{date}</span>
            <span className="text-zinc-500">O <span className={tone}>{px(lg.o)}</span></span>
            <span className="text-zinc-500">H <span className={tone}>{px(lg.h)}</span></span>
            <span className="text-zinc-500">L <span className={tone}>{px(lg.l)}</span></span>
            <span className="text-zinc-500">C <span className={tone}>{px(lg.c)}</span></span>
            {lg.chg !== null && (
              <span className={tone}>{lg.chg >= 0 ? '+' : ''}{px(lg.chg)} ({lg.chgPct !== null ? `${lg.chgPct >= 0 ? '+' : ''}${lg.chgPct.toFixed(2)}%` : '—'})</span>
            )}
            {volOn && lg.v !== null && <span className="text-zinc-500">Vol <span className="text-zinc-200">{fmtVolume(lg.v)}</span></span>}
          </div>
          {indicators.map(ind => {
            const out = outputs.find(o => o.ind.id === ind.id)?.out;
            const shown = (out?.series ?? []).filter(s => !s.shadow && !s.noLabel);
            return (
              <div key={ind.id} className="group flex items-center gap-1.5 pointer-events-auto w-fit rounded px-1 -mx-1 hover:bg-zinc-900/80">
                <span className={cn('font-semibold', ind.visible ? 'text-zinc-200' : 'text-zinc-500')}>{indicatorLabel(ind)}</span>
                {ind.visible && shown.map(s => (
                  <span key={s.key} style={{ color: s.colors?.[idx] ?? s.color }}>{valueAt(s)}</span>
                ))}
                {ind.visible && ind.kind === 'volume' && volMaLen >= 1 && (() => {
                  const m = volumeMa(bars, volMaLen)[idx];
                  return <span style={{ color: VOL_MA }}>{m === null || m === undefined ? '—' : fmtVolume(m)}</span>;
                })()}
                <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button type="button" onClick={() => onToggle(ind.id)} aria-label={`${ind.visible ? 'Hide' : 'Show'} ${indicatorLabel(ind)}`}
                    className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                    {ind.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  </button>
                  <button type="button" onClick={() => onEdit(ind.id)} aria-label={`Settings for ${indicatorLabel(ind)}`}
                    className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                    <Settings2 className="w-3 h-3" />
                  </button>
                  <button type="button" onClick={() => onRemove(ind.id)} aria-label={`Remove ${indicatorLabel(ind)}`}
                    className="p-0.5 rounded text-zinc-400 hover:text-rose-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(EquityIndicatorChart);
