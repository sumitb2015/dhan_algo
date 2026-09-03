import type { Metadata } from 'next';
import MarketMovers from '@/components/MarketMovers';

export const metadata: Metadata = {
  title: 'Market Movers Intelligence',
};

export default function MoversPage() {
  return <MarketMovers />;
}
