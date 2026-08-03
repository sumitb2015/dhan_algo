'use client';

import { useMemo } from 'react';
import { CombinedPremiumChart, type CombinedChartType } from '@/components/CombinedPremiumChart';
import { GROWW_COLORS } from '@/components/RollingStraddleChart';
import type { CustomStrategyChartResponse } from '@/lib/optionsChartTypes';

export type StrategyChartType = CombinedChartType;

function legToken(leg: CustomStrategyChartResponse['legs'][number]): string {
  const sign = leg.action === 'BUY' ? '+' : '-';
  return `${sign}${leg.strike}${leg.option_type}×${leg.lots}`;
}

export function StrategyChart({
  chart,
  chartType,
  initialHeight,
  showSpot = false,
}: {
  chart: CustomStrategyChartResponse;
  chartType: StrategyChartType;
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
      legendLabel={`NIFTY ${chart.legs.map(legToken).join(' / ')} Strategy${chart.net_credit ? ' (Credit)' : ' (Debit)'}`}
      seriesTitle="Strategy"
      chartType={chartType}
      initialHeight={initialHeight}
      colorScheme={GROWW_COLORS}
      valueLabel={chart.net_credit ? 'Credit Received' : 'Debit Paid'}
      leftAxisLine={leftAxisLine}
    />
  );
}
