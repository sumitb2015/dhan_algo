import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Live Strategies Monitor',
};

export default function StrategiesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
