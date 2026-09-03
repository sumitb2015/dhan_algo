import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'NIFTY OI Profile',
};

export default function NiftyOiProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
