import type { Metadata } from 'next';
import FiiDiiPage from '@/components/FiiDiiPage';

export const metadata: Metadata = {
  title: 'FII / DII Activity',
};

export default function Page() {
  return <FiiDiiPage />;
}
