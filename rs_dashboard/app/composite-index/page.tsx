import type { Metadata } from 'next';
import IndexCompositePage from '@/components/IndexCompositePage';

export const metadata: Metadata = {
  title: 'Composite Index',
  description: 'Weighted sum of live NSE index prices from the indices WebSocket, as a line or 1/3/5-minute candles',
};

export default function Page() {
  return <IndexCompositePage />;
}
