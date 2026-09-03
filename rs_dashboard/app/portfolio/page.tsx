import type { Metadata } from 'next';
import PortfolioDashboard from '@/components/PortfolioDashboard';

export const metadata: Metadata = {
  title: 'Portfolio Dashboard',
};

export default function PortfolioPage() {
  return <PortfolioDashboard />;
}
