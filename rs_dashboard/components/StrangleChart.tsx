'use client';

import { useMemo } from 'react';
import { CombinedPremiumChart, type CombinedChartType } from '@/components/CombinedPremiumChart';
import { GROWW_COLORS } from '@/components/RollingStraddleChart';
import type { StrangleChartResponse } from '@/lib/optionsChartTypes';

export type StrangleChartType = CombinedChartType;

export function StrangleChart({
  chart,
  chartType,
  initialHeight,
  showSpot = false,
}: {
  chart: StrangleChartResponse;
  chartType: StrangleChartType;
  initialHeight?: number;
  showSpot?: boolean;
}) {
  const leftAxisLine = useMemo(
    () => (showSpot ? { label: 'Spot', color: '#9aa5a0', values: chart.spot_series.map((p) => ({ time: p.time, value: p.value })) } : undefined),
    [showSpot, chart.spot_series]
  );

  return (
    <CombinedPremiumChart
      candles={chart.candles}
      indicators={chart.indicators}
      legendLabel={`NIFTY ${chart.ce_strike}CE×${chart.ce_lots} / ${chart.pe_strike}PE×${chart.pe_lots} Strangle`}
      seriesTitle="Strangle"
      chartType={chartType}
      initialHeight={initialHeight}
      colorScheme={GROWW_COLORS}
      leftAxisLine={leftAxisLine}
    />
  );
}
