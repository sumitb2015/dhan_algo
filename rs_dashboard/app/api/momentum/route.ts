import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { isStrategyRunning, isValidInstanceId, stateKeyFor, DEBUG_DIR } from '@/lib/strategyRegistry';

// Read-only view of the momentum portfolio. Two files back it:
//   debug/<key>_state.json     — written every cycle by save_strategy_state()
//   debug/<key>_portfolio.json — the durable book, written on every mutation
// The state file is the richer of the two (it carries live LTPs and ranks), but it only
// exists while the strategy has run at least once. The portfolio file survives the process,
// so it is the fallback that lets this page show holdings for a STOPPED strategy — which is
// the normal condition for a positional strategy that only wakes once a day.

const BASE_KEY = 'nifty500_momentum';

interface Holding {
  symbol: string;
  industry: string;
  qty: number;
  entry_price: number;
  ltp: number;
  unrealised: number;
  unrealised_pct: number;
  stop_price: number;
  stage: string;
  entry_date: string;
  hold_days: number;
  rank: number | null;
  rank_at_entry: number;
  rank_strikes: number;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Rebuild holdings from the durable portfolio file when no state file exists yet. */
function holdingsFromPortfolio(portfolio: Record<string, any>): Holding[] {
  const positions: any[] = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const today = Date.now();
  return positions.map((p) => {
    const entry = Number(p.entry_price) || 0;
    // No live price available from this file — last_close is the most recent mark the
    // strategy itself recorded, so unrealised here is as-of the last cycle, not real time.
    const ltp = Number(p.last_close) || entry;
    const qty = Number(p.qty) || 0;
    const entryDate = new Date(p.entry_date);
    return {
      symbol: p.symbol,
      industry: p.industry ?? '',
      qty,
      entry_price: entry,
      ltp,
      unrealised: (ltp - entry) * qty,
      unrealised_pct: entry ? (ltp / entry - 1) * 100 : 0,
      stop_price: Number(p.stop_price) || 0,
      stage: ['hard stop', 'breakeven', 'trailing'][Number(p.stage) || 0],
      entry_date: p.entry_date,
      hold_days: Number.isNaN(entryDate.getTime())
        ? 0
        : Math.floor((today - entryDate.getTime()) / 86_400_000),
      rank: null,
      rank_at_entry: Number(p.rank_at_entry) || 0,
      rank_strikes: Number(p.rank_strikes) || 0,
    };
  });
}

export async function GET(request: NextRequest) {
  const instanceId = request.nextUrl.searchParams.get('instanceId') ?? '';
  if (instanceId && !isValidInstanceId(instanceId)) {
    return NextResponse.json({ success: false, error: 'Invalid instanceId' }, { status: 400 });
  }
  const stateKey = stateKeyFor(BASE_KEY, instanceId || undefined);

  const state = readJson(path.join(DEBUG_DIR, `${stateKey}_state.json`));
  const portfolio = readJson(path.join(DEBUG_DIR, `${stateKey}_portfolio.json`));

  // Backtest artifacts are not per-instance — one run describes the ruleset itself, which
  // every instance shares. Attached to every response so the page can show what the live
  // portfolio is expected to do, next to what it is actually doing.
  const bt = readJson(path.join(DEBUG_DIR, 'momentum_backtest_summary.json')) as
    | { generated_at?: string; period?: Record<string, unknown>; stats?: Record<string, number>;
        artifacts?: Record<string, boolean>; universe?: string }
    | null;
  const backtest = bt
    ? {
        generatedAt: bt.generated_at ?? null,
        period: bt.period ?? null,
        universe: bt.universe ?? null,
        cagr: bt.stats?.cagr_pct ?? null,
        maxDrawdown: bt.stats?.max_drawdown_pct ?? null,
        sharpe: bt.stats?.sharpe ?? null,
        totalReturn: bt.stats?.total_return_pct ?? null,
        benchCagr: bt.stats?.bench_cagr_pct ?? null,
        benchMaxDrawdown: bt.stats?.bench_max_drawdown_pct ?? null,
        trades: bt.stats?.trades ?? null,
        winRate: bt.stats?.win_rate_pct ?? null,
        profitFactor: bt.stats?.profit_factor ?? null,
        artifacts: bt.artifacts ?? {},
      }
    : null;

  if (!state && !portfolio) {
    return NextResponse.json({
      success: true,
      exists: false,
      backtest,   // the ruleset's track record is worth showing even before it has ever run
      message: 'The momentum strategy has not been run yet. Start it from the Strategies page, '
        + 'or run it once with: venv\\Scripts\\python.exe strategies/momentum_investing/nifty500_momentum.py --once',
    });
  }

  const pid = Number(state?.pid ?? 0);
  const running = pid > 0 && isStrategyRunning(pid, stateKey);

  const holdings: Holding[] = Array.isArray(state?.holdings) && (state!.holdings as Holding[]).length
    ? (state!.holdings as Holding[])
    : portfolio
      ? holdingsFromPortfolio(portfolio)
      : [];

  const invested = holdings.reduce((s, h) => s + h.entry_price * h.qty, 0);
  const unrealised = holdings.reduce((s, h) => s + h.unrealised, 0);
  const cash = Number(state?.cash ?? portfolio?.cash ?? 0);
  const capital = Number(state?.capital ?? portfolio?.capital ?? 0);
  const realized = Number(state?.realized_pnl ?? portfolio?.realized_pnl ?? 0);

  return NextResponse.json({
    success: true,
    exists: true,
    // A positional strategy is STOPPED most of the time by design; the book is still live.
    // Surfacing both prevents "stopped" reading as "flat".
    running,
    status: running ? (state?.status ?? 'RUNNING') : 'STOPPED',
    dryRun: Boolean(state?.dry_run ?? portfolio?.dry_run ?? true),
    capital,
    cash,
    invested,
    deployedPct: capital ? (invested / capital) * 100 : 0,
    slots: Number(state?.slots ?? portfolio?.slots ?? 0),
    realizedPnl: realized,
    unrealisedPnl: unrealised,
    totalPnl: realized + unrealised,
    equity: cash + invested + unrealised,
    holdings,
    topRanks: state?.top_ranks ?? [],
    closedTrades: (state?.closed_trades as unknown[]) ?? (portfolio?.closed_trades as unknown[])?.slice(-20) ?? [],
    dataDate: state?.data_date ?? null,
    regime: state?.regime ?? null,
    // `regime` is always true when the filter is off, so the UI needs this to avoid showing
    // a reassuring "REGIME ON" for a strategy that simply is not checking.
    regimeEnabled: state?.regime_enabled ?? true,
    regimeSma: state?.regime_sma ?? null,
    regimeExit: state?.regime_exit ?? null,
    lastReview: state?.last_review ?? portfolio?.last_review_date ?? null,
    nextReview: state?.next_review ?? null,
    lastUpdate: state?.last_update ?? portfolio?.updated_at ?? null,
    alert: state?.alert ?? '',
    backtest,
  });
}
