'use client';

import { useMemo } from 'react';
import { CombinedPremiumChart, type CombinedChartType } from '@/components/CombinedPremiumChart';
import { GROWW_COLORS } from '@/components/RollingStraddleChart';
import type { StraddleChartResponse } from '@/lib/optionsChartTypes';
import { spotLabel } from '@/lib/underlyings';

export type StraddleChartType = CombinedChartType;

export function StraddleChart({
  chart,
  chartType,
  showSpot = false,
  underlying = 'NIFTY',
}: {
  chart: StraddleChartResponse;
  chartType: StraddleChartType;
  showSpot?: boolean;
  underlying?: string;
}) {
  const leftAxisLine = useMemo(
    () => (showSpot ? { label: spotLabel(underlying), color: '#9aa5a0', values: chart.spot_series.map((p) => ({ time: p.time, value: p.value })) } : undefined),
    [showSpot, underlying, chart.spot_series]
  );

  const candleByTime = useMemo(() => new Map(chart.candles.map((c) => [c.time, c])), [chart.candles]);

  const extraTooltipRows = useMemo(
    () => (time: string) => {
      const candle = candleByTime.get(time);
      if (!candle) return [];
      const rows: { label: string; value: string }[] = [];
      if (candle.ce !== null) rows.push({ label: `${chart.strike} Call`, value: candle.ce.toFixed(2) });
      if (candle.pe !== null) rows.push({ label: `${chart.strike} Put`, value: candle.pe.toFixed(2) });
      return rows;
    },
    [candleByTime, chart.strike]
  );

  return (
    <CombinedPremiumChart
      candles={chart.candles}
      indicators={chart.indicators}
      legendLabel={`${underlying} ${chart.strike} Straddle`}
      seriesTitle="Straddle"
      chartType={chartType}
      colorScheme={GROWW_COLORS}
      leftAxisLine={leftAxisLine}
      extraTooltipRows={extraTooltipRows}
    />
  );
}
