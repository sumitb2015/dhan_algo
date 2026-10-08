import type { Metadata } from 'next';
import DailyMarketTerminal from '@/components/DailyMarketTerminal';

export const metadata: Metadata = {
  title: 'Daily Market Terminal | Real-time WebSocket Equity Feeds',
  description: 'Bloomberg-style real-time equity market terminal with WebSocket feeds for Nifty 50, Bank Nifty, Nifty 500 & custom watchlists.',
};

export default function DailyMarketPage() {
  return <DailyMarketTerminal />;
}
