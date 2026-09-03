import type { Metadata } from 'next';
import LiveDashboard from '@/components/LiveDashboard';

export const metadata: Metadata = {
  title: 'Live Market Dashboard',
};

export default function LivePage() {
  return <LiveDashboard />;
}
