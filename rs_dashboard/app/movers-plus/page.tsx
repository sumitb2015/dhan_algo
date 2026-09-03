import type { Metadata } from 'next';
import MoversPlusDashboard from '@/components/MoversPlusDashboard';

export const metadata: Metadata = {
  title: 'Movers+ Persistence Tracker',
};

export default function MoversPlusPage() {
  return <MoversPlusDashboard />;
}
