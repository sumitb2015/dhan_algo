import type { Metadata } from 'next';
import TrendConfluenceBlotter from '@/components/TrendConfluenceBlotter';

export const metadata: Metadata = {
  title: 'Multi-Timeframe Trend Confluence Blotter | Trend Alignment',
  description: 'Multi-timeframe trend alignment and momentum filter across Weekly 10/40 EMA, Daily 50/200 EMA, 20 EMA momentum, ADX trend strength, and Mansfield Relative Strength.',
};

export default function TrendConfluencePage() {
  return <TrendConfluenceBlotter />;
}
