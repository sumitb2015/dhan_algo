import type { Metadata } from 'next';
import MarketDashboard from '@/components/MarketDashboard';

export const metadata: Metadata = {
  title: 'Terminal',
};

export default function Home() {
  return <MarketDashboard />;
}
