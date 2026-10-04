import TripleStraddlePage from '@/components/TripleStraddlePage';

export const metadata = {
  title: 'Triple Straddle',
  description: 'Three parallel live straddle charts: ATM, plus selectable lower and higher ATM-offset straddles.',
};

export default function Page() {
  return <TripleStraddlePage />;
}
