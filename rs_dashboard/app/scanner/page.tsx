import type { Metadata } from 'next';
import Scanner from '@/components/Scanner';

export const metadata: Metadata = {
  title: 'Relative Strength Scanner',
};

export default function ScannerPage() {
  return <Scanner />;
}
