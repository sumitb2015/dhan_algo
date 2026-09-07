import BatmanMatrixPage from '@/components/BatmanMatrixPage';

export const metadata = {
  title: 'Live Batman Matrix · Double Ratio Spreads Across Expiries',
  description: 'Live-refreshing table of ATM-offset Batman double ratio spread premiums, dual profit peaks (ears), and safety corridors across expiries.',
};

export default function Page() {
  return <BatmanMatrixPage />;
}
