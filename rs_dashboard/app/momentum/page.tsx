import MomentumPortfolio from '@/components/MomentumPortfolio';

// searchParams is a Promise in Next 16 — it must be awaited, not read synchronously.
export default async function MomentumPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const raw = params.instanceId;
  const instanceId = Array.isArray(raw) ? raw[0] : raw;
  return <MomentumPortfolio instanceId={instanceId ?? ''} />;
}
