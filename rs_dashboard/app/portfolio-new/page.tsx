import type { Metadata } from 'next';
import PortfolioNewDashboard from '@/components/PortfolioNewDashboard';

export const metadata: Metadata = {
  title: 'Portfolio Summary',
};

export default function PortfolioNewPage() {
  return <PortfolioNewDashboard />;
}
