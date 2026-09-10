import type { Metadata } from 'next';
import StockDashboard from '@/components/StockDashboard';

export const metadata: Metadata = {
  title: 'Relative Strength Scanner',
};

export default function RsScannerPage() {
  return <StockDashboard />;
}
