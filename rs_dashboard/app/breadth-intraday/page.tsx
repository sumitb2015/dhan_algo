import type { Metadata } from 'next';
import IntradayBreadth from '@/components/IntradayBreadth';

export const metadata: Metadata = {
  title: 'Intraday Breadth',
};

export default function BreadthIntradayPage() {
  return <IntradayBreadth />;
}
