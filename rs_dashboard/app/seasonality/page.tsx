import type { Metadata } from 'next';
import SeasonalityHeatmap from '@/components/SeasonalityHeatmap';

export const metadata: Metadata = {
  title: 'Market Seasonality',
};

export default function SeasonalityPage() {
  return <SeasonalityHeatmap />;
}
