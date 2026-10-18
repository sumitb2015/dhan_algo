import type { Metadata } from 'next';
import WhatsNewPage from '@/components/WhatsNewPage';

export const metadata: Metadata = {
  title: "What's New",
};

export default function Page() {
  return <WhatsNewPage />;
}
