import NiftyCoveredCallTerminal from '@/components/NiftyCoveredCall/NiftyCoveredCallTerminal';

export const metadata = {
  title: 'Nifty Covered Call | NIFTYBEES + Short Call Desk',
  description: 'Covered calls written against the NIFTYBEES holding: combined P&L, net Greeks, coverage and a call fill ledger',
};

export default function NiftyCoveredCallPage() {
  return <NiftyCoveredCallTerminal />;
}
