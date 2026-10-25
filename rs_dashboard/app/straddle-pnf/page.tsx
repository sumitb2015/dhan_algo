import type { Metadata } from 'next';
import StraddlePnfPage from '@/components/StraddlePnfPage';

export const metadata: Metadata = {
  title: 'Straddle P&F',
  description: 'Three live NIFTY straddle Point & Figure charts (ATM-200, ATM, ATM+200) with VWAP / SMA, double top and double bottom alerts',
};

export default function Page() {
  return <StraddlePnfPage />;
}
