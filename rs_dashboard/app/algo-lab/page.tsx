import type { Metadata } from 'next';
import AlgoLab from '@/components/algoLab/AlgoLab';

export const metadata: Metadata = {
  title: 'Algo Lab',
};

export default function AlgoLabPage() {
  return <AlgoLab />;
}
