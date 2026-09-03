import type { Metadata } from 'next';
import PortfolioTradesDashboard from '@/components/PortfolioTradesDashboard';

export const metadata: Metadata = {
  title: 'Trade Log & History',
};

export default function PortfolioTradesPage() {
  return <PortfolioTradesDashboard />;
}
