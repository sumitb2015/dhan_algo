import type { Metadata } from 'next';
import CrudeInventoriesPage from '@/components/CrudeInventoriesPage';

export const metadata: Metadata = {
  title: 'Crude Inventories',
};

export default function Page() {
  return <CrudeInventoriesPage />;
}
