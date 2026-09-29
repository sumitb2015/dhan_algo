import type { Metadata } from 'next';
import OptionsScreener from '@/components/OptionsScreener';

export const metadata: Metadata = {
  title: 'Options Screener',
};

export default function OptionsScreenerPage() {
  return <OptionsScreener />;
}
