import type { Metadata } from 'next';
import BreakdownScalper from '@/components/BreakdownScalper';

export const metadata: Metadata = {
  title: 'Breakdown Auto-Scalper',
};

export default function BreakdownScalperPage() {
  return <BreakdownScalper />;
}
