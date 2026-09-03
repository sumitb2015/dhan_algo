import type { Metadata } from 'next';
import DistributionChart from '@/components/DistributionChart';

export const metadata: Metadata = {
  title: 'Distribution Days',
};

export default function DistributionPage() {
  return <DistributionChart />;
}
