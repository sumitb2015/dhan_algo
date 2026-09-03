import type { Metadata } from 'next';
import IVChartsPage from '@/components/IVChartsPage';

export const metadata: Metadata = {
  title: 'IV Skew & Surface Charts',
};

export default function Page() {
  return <IVChartsPage />;
}
