import type { Metadata } from 'next';
import NiftyContribution from '@/components/niftyContribution/NiftyContribution';

export const metadata: Metadata = {
  title: 'Nifty Contribution',
};

export default function NiftyContributionPage() {
  return <NiftyContribution />;
}
