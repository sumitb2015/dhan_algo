import OptionsBacktester from '@/components/OptionsBacktester';

// Same multi-leg options leg-builder UI as /backtest, pointed at the VectorBT
// CLI (app/api/backtest-vectorbt) instead of the plain Python engine — runs the
// identical simulation and additionally surfaces VectorBT's own Sharpe/Sortino/
// drawdown/tearsheet computed from those same trades, so the two pages can be
// compared directly. See scripts/analysis/vectorbt_engine/options_engine.py.
export default function BacktestSignalsPage() {
  return <OptionsBacktester apiBase="/api/backtest-vectorbt" pageTitle="POSITIONS (VectorBT)" />;
}
