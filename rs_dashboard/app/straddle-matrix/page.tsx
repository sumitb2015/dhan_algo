import type { Metadata } from 'next';
import StraddleLiveMatrix from '@/components/StraddleLiveMatrix';

export const metadata: Metadata = {
  title: 'ATM Straddle Matrix & Stop Loss Analytics',
  description: 'Live and historical ATM short straddle performance matrix across intraday timestamps and leg-wise Stop Loss percentages',
};

export default function StraddleMatrixPage() {
  return <StraddleLiveMatrix />;
}
