import type { Metadata } from 'next';
import UsMarkets from '@/components/UsMarkets';

export const metadata: Metadata = {
  title: 'US Markets',
};

export default function UsMarketsPage() {
  return <UsMarkets />;
}
