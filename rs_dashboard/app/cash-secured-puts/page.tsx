import type { Metadata } from 'next';
import CashSecuredPuts from '@/components/CashSecuredPuts';

export const metadata: Metadata = {
  title: 'Cash-Secured Puts Tracked',
};

export default function CashSecuredPutsPage() {
  return <CashSecuredPuts />;
}
