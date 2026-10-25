import type { Metadata } from 'next';
import StraddleSimulatorPage from '@/components/StraddleSimulatorPage';

export const metadata: Metadata = {
  title: 'Straddle Simulator',
  description: 'Replay past NIFTY straddle sessions (ATM-200, ATM, ATM+200) through the Point & Figure engine at 1X to 200X with double top / double bottom alerts',
};

export default function Page() {
  return <StraddleSimulatorPage />;
}
