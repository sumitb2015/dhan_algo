import VolatilitySurfacePage from '@/components/VolatilitySurfacePage';

export const metadata = {
  title: '3D Volatility Surface · Options Analysis',
  description: 'Interactive 3D implied volatility surface for NIFTY, BANKNIFTY and SENSEX options — smile, skew and calendar term structure.',
};

export default function Page() {
  return <VolatilitySurfacePage />;
}
