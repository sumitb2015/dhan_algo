import MarketDetail from '@/components/MarketDetail';

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return { title: `${key.toUpperCase()} — Markets Overview` };
}

export default async function MarketDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const marketKey = key.toUpperCase();
  return <MarketDetail key={marketKey} marketKey={marketKey} />;
}
