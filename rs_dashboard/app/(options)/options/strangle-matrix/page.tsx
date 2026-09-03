import StrangleMatrixPage from '@/components/StrangleMatrixPage';

export const metadata = {
  title: 'Live Strangle Matrix · ATM-Offset Premiums Across Expiries',
  description: 'Live-refreshing table of ATM-offset short strangle premiums across the next expiries, with RoM% conditional formatting.',
};

export default function Page() {
  return <StrangleMatrixPage />;
}
