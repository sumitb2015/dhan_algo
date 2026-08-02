'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { CandleData } from '@/app/api/nifty-oi-profile/route';

interface Props {
  candles: CandleData[];
  symbolName?: string;
}

export default function FuturesCandleChart({ candles, symbolName = 'NIFTY FUT' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const [hoverData, setHoverData] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    change: number;
    changePct: number;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a1a1aa',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#3f3f46', scaleMargins: { top: 0.08, bottom: 0.25 } },
      timeScale: {
        borderColor: '#3f3f46',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
      autoSize: true,
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#52525b',
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;
    volumeSeriesRef.current = volumeSeries;

    // Crosshair move handler
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || param.seriesData.size === 0) {
        setHoverData(null);
        return;
      }
      const data = param.seriesData.get(candlestickSeries) as {
        open: number;
        high: number;
        low: number;
        close: number;
      } | undefined;
      const volData = param.seriesData.get(volumeSeries) as { value: number } | undefined;

      if (data) {
        const change = data.close - data.open;
        const changePct = (change / data.open) * 100;
        
        let dateStr = '';
        if (typeof param.time === 'number') {
          const dt = new Date(param.time * 1000);
          dateStr = dt.toLocaleString('en-IN', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
        } else {
          dateStr = String(param.time);
        }

        setHoverData({
          time: dateStr,
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          volume: volData?.value ?? 0,
          change,
          changePct,
        });
      }
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !volumeSeriesRef.current || candles.length === 0) return;

    // Transform candle data into sorted Lightweight Charts items
    const parsedData = candles
      .map((c) => {
        let ts = 0;
        const val = parseFloat(c.time);
        if (!isNaN(val) && val > 1000000000) {
          ts = Math.floor(val);
        } else {
          ts = Math.floor(Date.parse(c.time) / 1000);
        }
        return {
          time: ts as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        };
      })
      .filter((c) => !isNaN(c.time) && c.time > 0)
      .sort((a, b) => (a.time as number) - (b.time as number));

    // Deduplicate by time if needed
    const deduped: typeof parsedData = [];
    let lastTime = 0;
    for (const item of parsedData) {
      if (item.time !== lastTime) {
        deduped.push(item);
        lastTime = item.time as number;
      }
    }

    seriesRef.current.setData(
      deduped.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    volumeSeriesRef.current.setData(
      deduped.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)',
      }))
    );

    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;

  return (
    <div className="relative w-full h-full flex flex-col bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3 shadow-inner">
      {/* Chart Legend / Tooltip Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 pb-2 border-b border-zinc-800/60 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-100 tracking-wide">{symbolName}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800/50">
            5M Intraday
          </span>
        </div>

        {hoverData ? (
          <div className="flex items-center gap-3 text-[11px] font-mono">
            <span className="text-zinc-400">{hoverData.time}</span>
            <span className="text-zinc-300">O: <strong className="text-zinc-100">{hoverData.open.toFixed(2)}</strong></span>
            <span className="text-zinc-300">H: <strong className="text-zinc-100">{hoverData.high.toFixed(2)}</strong></span>
            <span className="text-zinc-300">L: <strong className="text-zinc-100">{hoverData.low.toFixed(2)}</strong></span>
            <span className="text-zinc-300">C: <strong className="text-zinc-100">{hoverData.close.toFixed(2)}</strong></span>
            <span className={hoverData.change >= 0 ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
              {hoverData.change >= 0 ? '+' : ''}{hoverData.change.toFixed(2)} ({hoverData.changePct.toFixed(2)}%)
            </span>
          </div>
        ) : lastCandle ? (
          <div className="flex items-center gap-3 text-[11px] font-mono">
            <span className="text-zinc-400">Latest:</span>
            <span className="text-zinc-300">C: <strong className="text-zinc-100">{lastCandle.close.toFixed(2)}</strong></span>
            <span className="text-zinc-400">Vol: <strong className="text-zinc-200">{lastCandle.volume.toLocaleString()}</strong></span>
          </div>
        ) : null}
      </div>

      {/* Chart Canvas Container */}
      <div ref={containerRef} className="w-full flex-1 min-h-[420px]" />
    </div>
  );
}
