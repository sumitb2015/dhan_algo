import type { Metadata } from 'next';
import InstitutionalMarketRegimePage from '@/components/InstitutionalMarketRegimePage';

export const metadata: Metadata = {
  title: 'Market Regime & Distribution Days | Institutional Timing',
  description: "Track O'Neil Institutional Distribution Days and Follow-Through Days on Nifty 50 and Nifty 500.",
};

export default function MarketRegimePage() {
  return <InstitutionalMarketRegimePage />;
}
