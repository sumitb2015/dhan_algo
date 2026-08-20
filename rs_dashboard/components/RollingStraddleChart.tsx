'use client';

import { useMemo } from 'react';
import { CombinedPremiumChart, type CombinedChartType } from '@/components/CombinedPremiumChart';
import type { RollingStraddleChartResponse } from '@/lib/optionsChartTypes';
import { spotLabel } from '@/lib/underlyings';

export type RollingStraddleChartType = CombinedChartType;

// Groww-style palette (915.groww.in/straddle-chart) kept distinct from every other
// CombinedPremiumChart caller here (Straddle/Strangle/Strategy use the shared dark theme).
export const GROWW_COLORS = {
  lineColor: '#9adf4c',
  lineWidth: 2 as const,
  upColor: '#9adf4c',
  downColor: '#e5484d',
  indicatorColors: { vwap: '#f5a623' },
};

const UPSHIFT_MARKER_COLOR = '#00D09C';
const DOWNSHIFT_MARKER_COLOR = '#e5484d';

function fmt(v: number): string {
  return v.toFixed(2);
}

function daysToExpiry(expiry: string): number | null {
  const expiryDate = new Date(`${expiry}T15:30:00+05:30`);
  if (Number.isNaN(expiryDate.getTime())) return null;
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
}

export function RollingStraddleChart({
  chart,
  chartType,
  showSpot = false,
  underlying = 'NIFTY',
}: {
  chart: RollingStraddleChartResponse;
  chartType: RollingStraddleChartType;
  showSpot?: boolean;
  underlying?: string;
}) {
  const leftAxisLine = useMemo(
    () => (showSpot ? { label: spotLabel(underlying), color: '#9aa5a0', values: chart.candles.map((c) => ({ time: c.time, value: c.spot })) } : undefined),
    [showSpot, underlying, chart.candles]
  );

  const markers = useMemo(
    () =>
      chart.switches
        .filter((s) => s.from_strike !== null && s.from_strike !== s.to_strike)
        .map((s) => ({ time: s.time, color: s.to_strike > s.from_strike! ? UPSHIFT_MARKER_COLOR : DOWNSHIFT_MARKER_COLOR, size: 2 })),
    [chart.switches]
  );

  const byTime = useMemo(() => {
    const candleMap = new Map(chart.candles.map((c) => [c.time, c]));
    const switchMap = new Map(chart.switches.map((s) => [s.time, s]));
    return { candleMap, switchMap };
  }, [chart.candles, chart.switches]);

  const extraTooltipRows = useMemo(
    () => (time: string) => {
      const candle = byTime.candleMap.get(time);
      if (!candle) return [];
      const rows = [
        { label: `${candle.strike} Call`, value: fmt(candle.ce) },
        { label: `${candle.strike} Put`, value: fmt(candle.pe) },
        { label: 'Synthetic Fut', value: fmt(candle.synthetic_fut) },
        { label: 'Spot Price', value: fmt(candle.spot) },
      ];
      const switchAtBar = byTime.switchMap.get(time);
      if (switchAtBar && switchAtBar.from_strike !== null && switchAtBar.from_strike !== switchAtBar.to_strike) {
        const isUpshift = switchAtBar.to_strike > switchAtBar.from_strike;
        rows.push({ label: 'ATM Strike', value: `${switchAtBar.from_strike} → ${switchAtBar.to_strike} (${isUpshift ? 'Upshift ↑' : 'Downshift ↓'})` });
      }
      return rows;
    },
    [byTime]
  );

  const latest = chart.candles[chart.candles.length - 1];
  const dte = daysToExpiry(chart.expiry);
  const straddleWidthPct = latest && latest.spot ? (latest.close / latest.spot) * 100 : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="relative flex-1 min-h-0">
        <CombinedPremiumChart
          candles={chart.candles}
          indicators={chart.indicators}
          legendLabel={`${underlying} Rolling ATM Straddle`}
          seriesTitle="Straddle"
          chartType={chartType}
          markers={markers}
          extraTooltipRows={extraTooltipRows}
          valueLabel="Straddle Price"
          colorScheme={GROWW_COLORS}
          leftAxisLine={leftAxisLine}
        />
      </div>
      {latest && (
        <div className="flex flex-shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2 py-1 text-[11px] tabular-nums text-zinc-400">
          <span>
            Straddle Price <span style={{ color: GROWW_COLORS.lineColor }}>₹{fmt(latest.close)}</span>
          </span>
          <span>
            Spot <span className="text-zinc-100">{fmt(latest.spot)}</span>
          </span>
          <span>
            Straddle Strike <span className="text-zinc-100">{latest.strike}</span>
          </span>
          <span>
            {latest.strike} CE <span className="text-zinc-100">₹{fmt(latest.ce)}</span>
          </span>
          <span>
            {latest.strike} PE <span className="text-zinc-100">₹{fmt(latest.pe)}</span>
          </span>
          {dte !== null && (
            <span>
              Days to expiry <span className="text-zinc-100">{dte}</span>
            </span>
          )}
          {straddleWidthPct !== null && (
            <span>
              Straddle Width <span className="text-zinc-100">{straddleWidthPct.toFixed(2)}%</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
