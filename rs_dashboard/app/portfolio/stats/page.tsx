import type { Metadata } from 'next';
import PortfolioStatsDashboard from '@/components/PortfolioStatsDashboard';

export const metadata: Metadata = {
  title: 'Portfolio Statistics',
};

export default function PortfolioStatsPage() {
  return <PortfolioStatsDashboard />;
}
