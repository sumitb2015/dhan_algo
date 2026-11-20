import type { Metadata } from 'next';
import GearboxPage from '@/components/gearbox/GearboxPage';

export const metadata: Metadata = {
  title: 'Gearbox Drive',
  description: 'Drive the live CRUDEOIL / CRUDEOILM future as a road: EMA gears, VWAP and Supertrend lamps on closed bars; ↑ / ↓ buy the mapped option (SIM, or REAL on Dhan, 1 lot)',
};

export default function Page() {
  return <GearboxPage />;
}
