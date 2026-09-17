import OptionsBacktester from '@/components/OptionsBacktester';

// This URL used to host the vectorbt EMA/RSI/Donchian/Supertrend signal
// backtester — that page moved to /backtest-signals. This route now serves
// the StockMock-style multi-leg options builder (same component as /backtest)
// since that's the URL people actually reach for the options backtester.
export default function BacktestVectorbtPage() {
  return <OptionsBacktester />;
}
