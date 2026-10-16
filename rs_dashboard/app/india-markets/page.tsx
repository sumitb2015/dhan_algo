import type { Metadata } from 'next';
import IndiaMarkets from '@/components/india-markets/IndiaMarkets';

export const metadata: Metadata = {
  title: 'India Markets',
};

export default function IndiaMarketsPage() {
  return <IndiaMarkets />;
}
