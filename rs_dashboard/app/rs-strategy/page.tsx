import type { Metadata } from 'next';
import RsStrategyPage from '@/components/RsStrategyPage';

export const metadata: Metadata = {
  title: 'RS Strategy',
  description: 'Nifty 500 relative strength (55) vs Nifty with Supertrend (10,2) buy and sell signals.',
};

export default function Page() {
  return <RsStrategyPage />;
}
