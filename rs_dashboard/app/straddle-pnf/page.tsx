import type { Metadata } from 'next';
import StraddlePnfPage from '@/components/StraddlePnfPage';

export const metadata: Metadata = {
  title: 'Point & Figure',
  description: 'Live Point & Figure chart of an NSE index, NSE stock or the nearest CRUDEOILM future, with VWAP / SMA, double top and double bottom alerts',
};

export default function Page() {
  return <StraddlePnfPage />;
}
