import type { Metadata } from 'next';
import SeasonalityHeatmap from '@/components/SeasonalityHeatmap';

export const metadata: Metadata = {
  title: 'Seasonality Heatmap & Calendar Patterns',
};

export default function SeasonalityPage() {
  return <SeasonalityHeatmap />;
}
