import type { Metadata } from 'next';
import OrbSettings from '@/components/signalOrb/OrbSettings';

export const metadata: Metadata = {
  title: 'Signal Orb Rules',
  description: 'The Signal Orb rules on a full page: market, indicators, timing, risk and the straddle / strangle rules',
};

export default function Page() {
  return <OrbSettings />;
}
