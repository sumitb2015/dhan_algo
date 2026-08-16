import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';

/**
 * Historical win rate and payoff ratio backing the Kelly card on the
 * positions-analytics page.
 *
 * Source is debug/portfolio_trade_history.json -> dailyPnlBySegment.FNO, written
 * by scripts/tools/get_trade_pnl_by_segment.py from the Dhan tradebook and
 * already served (whole) by /api/portfolio-trades. This route exists so the
 * analytics page fetches a few numbers instead of a multi-megabyte trade array.
 *
 * IMPORTANT — this is a DAY-level statistic, not a per-trade one. A "win" is a
 * profitable trading day across the whole F&O book, which mixes strategies and
 * is serially correlated. The response says so in `basis`, and the UI must
 * repeat it: presenting a day-level f* as a per-trade Kelly fraction would
 * materially overstate how much size the history justifies.
 */

const HISTORY_FILE = path.join(PROJECT_ROOT, 'debug', 'portfolio_trade_history.json');

/** Below this, the ratio is noise rather than an estimate. */
const MIN_DAYS = 20;

interface DayRow { date: string; netPnl: number }

export interface KellyStats {
  available: boolean;
  reason?: string;
  basis: string;
  fromDate?: string;
  toDate?: string;
  generatedAt?: string;
  days?: number;
  wins?: number;
  losses?: number;
  winRate?: number;      // fraction 0..1
  avgWin?: number;       // rupees
  avgLoss?: number;      // rupees, positive magnitude
  payoffRatio?: number;  // avgWin / avgLoss
  bestDay?: number;
  worstDay?: number;
}

export async function GET() {
  const basis = 'Day-level net P&L, F&O segment (Dhan tradebook)';

  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return NextResponse.json<KellyStats>({
        available: false, basis,
        reason: 'No trade history yet — run scripts/tools/get_trade_pnl_by_segment.py',
      });
    }

    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    const rows: DayRow[] = (raw?.dailyPnlBySegment?.FNO ?? [])
      .filter((r: DayRow) => r && Number.isFinite(Number(r.netPnl)));

    if (rows.length < MIN_DAYS) {
      return NextResponse.json<KellyStats>({
        available: false, basis, days: rows.length,
        reason: `Only ${rows.length} F&O trading days on record — need at least ${MIN_DAYS}`,
      });
    }

    const pnls = rows.map((r) => Number(r.netPnl));
    // A flat day is neither a win nor a loss; counting zeros as losses would drag
    // the win rate down on days the book simply did not trade.
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);

    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
    const decided = wins.length + losses.length;

    if (!decided || !avgLoss) {
      return NextResponse.json<KellyStats>({
        available: false, basis, days: rows.length,
        reason: losses.length === 0
          // No losing day means f* is unbounded, not infinite edge — say so rather
          // than emitting a number that would justify unlimited size.
          ? 'No losing F&O day on record — the payoff ratio is undefined'
          : 'Not enough decided days to estimate a payoff ratio',
      });
    }

    return NextResponse.json<KellyStats>({
      available: true,
      basis,
      fromDate: raw?.fromDate,
      toDate: raw?.toDate,
      generatedAt: raw?.generatedAt,
      days: decided,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / decided,
      avgWin,
      avgLoss,
      payoffRatio: avgWin / avgLoss,
      bestDay: Math.max(...pnls),
      worstDay: Math.min(...pnls),
    });
  } catch (err) {
    console.error('[/api/options/kelly-stats]', err);
    return NextResponse.json<KellyStats>({
      available: false, basis, reason: 'Could not read trade history',
    });
  }
}
