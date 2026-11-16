import type { Metadata } from 'next';
import MarketProfilePage from '@/components/marketProfile/MarketProfilePage';

export const metadata: Metadata = {
  title: 'Market Profile (TPO)',
};

export default function MarketProfileRoute() {
  return <MarketProfilePage />;
}
