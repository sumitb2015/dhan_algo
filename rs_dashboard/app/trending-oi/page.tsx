import type { Metadata } from 'next';
import TrendingOiPage from '@/components/TrendingOiPage';

export const metadata: Metadata = {
  title: 'Trending OI & Multi-Strike OI',
};

export default function Page() {
  return <TrendingOiPage />;
}
