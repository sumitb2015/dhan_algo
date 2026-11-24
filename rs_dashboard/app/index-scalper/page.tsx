import IndexScalperTerminal from '@/components/indexScalper/IndexScalperTerminal';

export const metadata = {
  title: 'Index Scalper',
  description: 'TradingView-style NIFTY chart with indicators, live option chain, instant CE/PE orders and on-chart positions',
};

export default function IndexScalperPage() {
  return <IndexScalperTerminal />;
}
