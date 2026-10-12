import type { Metadata } from 'next';
import MarketPulse from '@/components/MarketPulse';

export const metadata: Metadata = {
  title: 'Market Pulse',
};

export default function MarketPulsePage() {
  return <MarketPulse />;
}
