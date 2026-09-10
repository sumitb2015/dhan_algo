import type { Metadata } from 'next';
import MarginAllocator from '@/components/MarginAllocator';

export const metadata: Metadata = {
  title: 'Margin Allocator',
};

export default function MarginAllocatorPage() {
  return <MarginAllocator />;
}
