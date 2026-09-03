import type { Metadata } from 'next';
import EquityWatchlist from '@/components/EquityWatchlist';

export const metadata: Metadata = {
  title: 'Equity Watchlist',
};

export default function EquityWatchlistPage() {
  return <EquityWatchlist />;
}
