import type { Metadata } from 'next';
import ScalpCockpit from '@/components/ScalpCockpit';

export const metadata: Metadata = {
  title: 'Scalp Cockpit',
  description: 'Tight multi-window scalping terminal: Cumulative OI, India VIX, Trending OI snapshot & Multi-Leg Focus execution',
};

export default function Page() {
  return <ScalpCockpit />;
}
