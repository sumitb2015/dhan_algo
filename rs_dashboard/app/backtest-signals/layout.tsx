import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'VectorBT Signal Backtester',
};

export default function BacktestSignalsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
