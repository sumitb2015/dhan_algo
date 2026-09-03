import type { Metadata } from 'next';
import PortfolioDiaryDashboard from '@/components/PortfolioDiaryDashboard';

export const metadata: Metadata = {
  title: "Trader's Diary & Journal",
};

export default function PortfolioDiaryPage() {
  return <PortfolioDiaryDashboard />;
}
