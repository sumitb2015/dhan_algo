import type { Metadata } from 'next';
import MarketsOverviewGrid from '@/components/MarketsOverviewGrid';

export const metadata: Metadata = {
  title: 'Markets Overview',
};

export default function MarketsPage() {
  return <MarketsOverviewGrid />;
}
