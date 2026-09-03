import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Performance Table',
};

export default function PerformanceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
