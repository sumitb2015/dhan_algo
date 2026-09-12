import type { Metadata } from 'next';
import StageScreenerPage from '@/components/StageScreenerPage';

export const metadata: Metadata = {
  title: 'Minervini Stage 2 & VCP Screener | 8-Point Trend Template',
  description: 'Filter Nifty 500 stocks with Mark Minervini 8-point trend template and Stan Weinstein Stage 2 criteria.',
};

export default function ScreenerPage() {
  return <StageScreenerPage />;
}
