import type { Metadata } from 'next';
import NiftyTimeAnalysis from '@/components/NiftyTimeAnalysis';

export const metadata: Metadata = {
  title: 'NIFTY Time Analysis',
};

export default function NiftyTimeAnalysisPage() {
  return <NiftyTimeAnalysis />;
}
