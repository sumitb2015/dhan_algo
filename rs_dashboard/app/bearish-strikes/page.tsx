import type { Metadata } from 'next';
import BearishStrikes from '@/components/BearishStrikes';

export const metadata: Metadata = {
  title: 'Bearish Strikes',
};

export default function BearishStrikesPage() {
  return <BearishStrikes />;
}
