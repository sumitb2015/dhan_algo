'use client';

import { useMemo } from 'react';
import { CombinedPremiumChart, type CombinedChartType } from '@/components/CombinedPremiumChart';
import { GROWW_COLORS } from '@/components/RollingStraddleChart';
import type { StrangleChartResponse } from '@/lib/optionsChartTypes';
import { spotLabel } from '@/lib/underlyings';

export type StrangleChartType = CombinedChartType;

export function StrangleChart({
  chart,
  chartType,
  showSpot = false,
  underlying = 'NIFTY',
}: {
  chart: StrangleChartResponse;
  chartType: StrangleChartType;
  showSpot?: boolean;
  underlying?: string;
}) {
  const leftAxisLine = useMemo(
    () => (showSpot ? { label: spotLabel(underlying), color: '#9aa5a0', values: chart.spot_series.map((p) => ({ time: p.time, value: p.value })) } : undefined),
    [showSpot, underlying, chart.spot_series]
  );

  return (
    <CombinedPremiumChart
      candles={chart.candles}
      indicators={chart.indicators}
      legendLabel={`${underlying} ${chart.ce_strike}CE×${chart.ce_lots} / ${chart.pe_strike}PE×${chart.pe_lots} Strangle`}
      seriesTitle="Strangle"
      chartType={chartType}
      colorScheme={GROWW_COLORS}
      leftAxisLine={leftAxisLine}
    />
  );
}
