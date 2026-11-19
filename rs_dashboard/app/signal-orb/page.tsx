import type { Metadata } from 'next';
import SignalOrb from '@/components/SignalOrb';

export const metadata: Metadata = {
  title: 'Signal Orb',
  description: 'CRUDEOILM futures auto-trader: one orb that turns green / red when every active indicator (EMA, Supertrend, EMA cross, RSI, Stoch RSI) agrees on closed bars',
};

export default function Page() {
  return <SignalOrb />;
}
