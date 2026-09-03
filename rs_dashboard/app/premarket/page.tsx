import type { Metadata } from 'next';
import PremarketDashboard from '@/components/PremarketDashboard';

export const metadata: Metadata = {
  title: 'Pre-Market Intelligence',
};

export default function PremarketPage() {
  return <PremarketDashboard />;
}
