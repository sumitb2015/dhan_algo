import type { Metadata } from 'next';
import SectorBreadthDashboard from '@/components/SectorBreadthDashboard';

export const metadata: Metadata = {
  title: 'Sector Depth & Participation Heatmap | Breadth Divergence',
  description: 'Track percentage of stocks above 20, 50, and 200 DMA across all 27 NSE sectors with internal thrust detection.',
};

export default function SectorBreadthPage() {
  return <SectorBreadthDashboard />;
}
