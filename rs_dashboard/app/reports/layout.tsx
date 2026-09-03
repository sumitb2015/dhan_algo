import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Daily Market Reports',
};

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
