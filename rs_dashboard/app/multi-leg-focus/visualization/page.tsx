import { Suspense } from 'react';
import PositionVisualizerPage from '@/components/multiLegFocus/PositionVisualizerPage';

export const metadata = {
  title: 'Strategy Position Visualizer',
};

export default function MultiLegVisualizationPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400 text-xs font-mono">
        Loading Position Visualizer...
      </div>
    }>
      <PositionVisualizerPage />
    </Suspense>
  );
}
