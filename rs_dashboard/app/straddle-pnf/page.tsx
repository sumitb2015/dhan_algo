import type { Metadata } from 'next';
import StraddlePnfPage from '@/components/StraddlePnfPage';

export const metadata: Metadata = {
  title: 'Point & Figure',
  description: 'Live Point & Figure chart of an NSE index, stock, future or option (CE, PE or CE+PE straddle; NSE and MCX), with VWAP / SMA, double top and double bottom alerts',
};

export default function Page() {
  return <StraddlePnfPage />;
}
