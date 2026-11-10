import type { Metadata } from 'next';
import FreshMoneyBoard from '@/components/FreshMoneyBoard';

export const metadata: Metadata = { title: 'Fresh Money Board' };

export default function Page() {
  return <FreshMoneyBoard />;
}
