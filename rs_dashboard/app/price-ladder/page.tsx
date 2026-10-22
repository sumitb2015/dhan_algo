import type { Metadata } from 'next';
import PriceLadder from '@/components/priceLadder/PriceLadderWorkspace';

export const metadata: Metadata = {
  title: 'Price Ladder',
};

export default function PriceLadderPage() {
  return <PriceLadder />;
}
