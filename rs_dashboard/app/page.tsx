import type { Metadata } from 'next';
import StockDashboard from '@/components/StockDashboard';

export const metadata: Metadata = {
  title: 'Relative Strength Dashboard',
};

export default function Home() {
  return <StockDashboard />;
}
