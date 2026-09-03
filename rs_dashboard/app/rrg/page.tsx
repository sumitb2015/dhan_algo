import type { Metadata } from 'next';
import RRGDashboard from '@/components/RRGDashboard';

export const metadata: Metadata = {
  title: 'Relative Rotation Graphs (RRG)',
};

export default function RRGPage() {
  return <RRGDashboard />;
}
