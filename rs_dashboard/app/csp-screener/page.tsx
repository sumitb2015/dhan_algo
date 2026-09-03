import type { Metadata } from 'next';
import CspScreener from '@/components/CspScreener';

export const metadata: Metadata = {
  title: 'Cash-Secured Put Screener',
};

export default function CspScreenerPage() {
  return <CspScreener />;
}
