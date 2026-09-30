import type { Metadata } from 'next';
import NiftyOIProfilePage from '@/components/NiftyOIProfilePage';

export const metadata: Metadata = {
  title: 'NIFTY OI Profile',
};

export default function Page() {
  return <NiftyOIProfilePage />;
}
