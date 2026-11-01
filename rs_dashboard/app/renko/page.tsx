import type { Metadata } from 'next';
import StraddlePnfPage from '@/components/StraddlePnfPage';

export const metadata: Metadata = {
  title: 'Renko',
  description: 'Live Renko chart (TradingView Traditional box, close source) of an NSE index, stock, future or option (CE, PE or CE+PE straddle; NSE and MCX), with VWAP / SMA, N-brick confirmation alerts and the Point & Figure page\'s trade bar, rail and AUTO',
};

export default function Page() {
  return <StraddlePnfPage chart="renko" />;
}
