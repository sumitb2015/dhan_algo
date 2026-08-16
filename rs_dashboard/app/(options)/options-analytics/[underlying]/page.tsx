import { notFound } from 'next/navigation';
import PositionsAnalysis from '@/components/PositionsAnalysis';
import { ANALYTICS_UNDERLYINGS, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';

export function generateStaticParams() {
  return ANALYTICS_UNDERLYINGS.map((underlying) => ({ underlying }));
}

/**
 * Only the generated params are routable. Without this, an unknown segment is
 * rendered on demand and Next caches the resulting not-found page as a static
 * hit — which is served with HTTP **200**, so /options-analytics/BANKNIFTY looked
 * like a real page to anything reading the status code.
 */
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ underlying: string }> }) {
  const { underlying } = await params;
  return { title: `${underlying.toUpperCase()} Analysis` };
}

export default async function UnderlyingAnalysisPage({
  params,
}: {
  params: Promise<{ underlying: string }>;
}) {
  const { underlying } = await params;
  const upper = underlying.toUpperCase() as AnalyticsUnderlying;

  // Only the underlyings whose chain, lot size and strike step are all verified
  // are routable. A typo'd segment must 404 rather than render a page that
  // silently analyses nothing.
  if (!ANALYTICS_UNDERLYINGS.includes(upper)) notFound();

  return <PositionsAnalysis underlying={upper} />;
}
