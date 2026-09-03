import type { Metadata } from 'next';
import EquityCandlestickChart from '@/components/EquityCandlestickChart';

export const metadata: Metadata = {
  title: 'Candlestick Charts',
};

export default function CandlestickPage() {
  return <EquityCandlestickChart />;
}
