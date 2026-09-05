import type { Metadata } from 'next';
import TopMarketCapCharts from '@/components/TopMarketCapCharts';

export const metadata: Metadata = {
  title: 'Top 8 by Market Cap',
};

export default function TopMcapChartsPage() {
  return <TopMarketCapCharts />;
}
