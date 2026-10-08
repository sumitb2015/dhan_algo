import type { Metadata } from 'next';
import EquityCandlestickChart from '@/components/EquityCandlestickChart';

export const metadata: Metadata = {
  title: 'Candlestick Charts',
};

export default async function CandlestickPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string | string[] }>;
}) {
  const { symbol } = await searchParams;
  const initial = (Array.isArray(symbol) ? symbol[0] : symbol)?.trim().toUpperCase();
  return <EquityCandlestickChart initialSymbol={initial || undefined} />;
}
