import type { Metadata } from 'next';
import WeeklyTargetDashboard from '@/components/WeeklyTargetDashboard';

export const metadata: Metadata = {
  title: 'Weekly P&L Targets',
};

export default function WeeklyTargetPage() {
  return <WeeklyTargetDashboard />;
}
