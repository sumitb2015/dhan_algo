import NiftyCoveredCallTerminal from '@/components/NiftyCoveredCall/NiftyCoveredCallTerminal';

export const metadata = {
  title: 'Nifty Covered Call | Futures + Short Call Desk',
  description: 'Short NIFTY futures + delta-sized short OTM call overwrite desk with target/SL/trailing-SL and a live fill ledger',
};

export default function NiftyCoveredCallPage() {
  return <NiftyCoveredCallTerminal />;
}
