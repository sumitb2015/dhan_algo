import type { Metadata } from 'next';
import StockRanking from '@/components/StockRanking';

export const metadata: Metadata = {
  title: 'Stock Ranking',
};

export default function StockRankingPage() {
  return <StockRanking />;
}
