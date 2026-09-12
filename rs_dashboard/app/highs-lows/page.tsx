import type { Metadata } from 'next';
import HighsLowsDashboard from '@/components/HighsLowsDashboard';

export const metadata: Metadata = {
  title: '52-Week High/Low & Base Proximity | Peak Matrix',
  description: 'Categorize Nifty 500 stocks by proximity to 52-week highs, base patterns, and Net New Highs expansion.',
};

export default function HighsLowsPage() {
  return <HighsLowsDashboard />;
}
