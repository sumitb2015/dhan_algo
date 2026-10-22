import type { Metadata } from 'next';
import PriceLadder from '@/components/priceLadder/PriceLadder';

export const metadata: Metadata = {
  title: 'Price Ladder',
};

export default function PriceLadderPage() {
  return <PriceLadder />;
}
