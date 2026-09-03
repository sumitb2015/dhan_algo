import type { Metadata } from 'next';
import BreadthAnalysis from '@/components/BreadthAnalysis';

export const metadata: Metadata = {
  title: 'Market Breadth Analysis',
};

export default function BreadthPage() {
  return <BreadthAnalysis />;
}
