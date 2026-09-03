import type { Metadata } from 'next';
import NormalizedChart from '@/components/NormalizedChart';

export const metadata: Metadata = {
  title: 'Normalized Intraday Charts',
};

export default function NormalizedPage() {
  return <NormalizedChart />;
}
