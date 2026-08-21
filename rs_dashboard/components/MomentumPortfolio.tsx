'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, TrendingUp, TrendingDown, BookOpen, X } from 'lucide-react';
import NavBar from './NavBar';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

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

interface ClosedTrade {
  symbol: string;
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  pnl: number;
  pnl_pct: number;
  exit_reason: string;
  hold_days: number;
}

interface BacktestSummary {
  generatedAt: string | null;
  period: { start?: string; end?: string; years?: number } | null;
  universe: string | null;
  cagr: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  totalReturn: number | null;
  benchCagr: number | null;
  benchMaxDrawdown: number | null;
  trades: number | null;
  winRate: number | null;
  profitFactor: number | null;
  artifacts: Record<string, boolean>;
}

interface MomentumData {
  success: boolean;
  exists: boolean;
  message?: string;
  backtest: BacktestSummary | null;
  running: boolean;
  status: string;
  dryRun: boolean;
  capital: number;
  cash: number;
  invested: number;
  deployedPct: number;
  slots: number;
  realizedPnl: number;
  unrealisedPnl: number;
  totalPnl: number;
  equity: number;
  holdings: Holding[];
  topRanks: { symbol: string; rs: number }[];
  closedTrades: ClosedTrade[];
  dataDate: string | null;
  regime: boolean | null;
  regimeEnabled: boolean;
  regimeSma: number | null;
  regimeExit: boolean | null;
  lastReview: string | null;
  nextReview: string | null;
  lastUpdate: string | null;
  alert: string;
}

const rupees = (n: number) =>
  `₹${Math.round(n).toLocaleString('en-IN')}`;

const signed = (n: number) =>
  `${n >= 0 ? '+' : '−'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

const pnlColor = (n: number) =>
  n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';

/** Anything whose meaning is not self-evident gets one of these. Base UI's trigger renders a
 *  real button, so the explanation is reachable by keyboard as well as by hover. */
const Info = ({ tip, className = '', children }: {
  tip: React.ReactNode; className?: string; children: React.ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger className={`cursor-help ${className}`}>{children}</TooltipTrigger>
    {/* TooltipContent's popup is `inline-flex items-center`, so every top-level node of a
        multi-part tip becomes its own flex column — a leading <b> ends up stacked beside the
        text instead of above it. Wrapping in one block element keeps it a single flex item
        that flows as normal prose. */}
    <TooltipContent>
      <span className="block max-w-xs text-xs leading-relaxed">{tip}</span>
    </TooltipContent>
  </Tooltip>
);

const TH = ({ children, align = 'left', tip }: {
  children: React.ReactNode; align?: 'left' | 'right'; tip?: React.ReactNode;
}) => (
  <th className={`text-xs font-bold text-white px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
    {tip ? (
      <Info tip={tip} className="font-bold text-white underline decoration-dotted decoration-zinc-500 underline-offset-2">
        {children}
      </Info>
    ) : children}
  </th>
);

const TD = ({ children, align = 'left', className = '' }: {
  children: React.ReactNode; align?: 'left' | 'right'; className?: string;
}) => (
  <td className={`px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right tabular-nums' : ''} ${className}`}>
    {children}
  </td>
);

function StatTile({ label, value, sub, tone = 'neutral', tip }: {
  label: string; value: string; sub?: string; tone?: 'neutral' | 'good' | 'bad';
  tip?: React.ReactNode;
}) {
  const valueColor =
    tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-zinc-100';
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 min-w-[140px]">
      {tip ? (
        <Info tip={tip} className="text-xs text-zinc-500 uppercase tracking-wider underline decoration-dotted decoration-zinc-600 underline-offset-2">
          {label}
        </Info>
      ) : (
        <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
      )}
      <div className={`text-lg font-bold tabular-nums ${valueColor}`}>{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

/** In-page explanation of what the strategy does and how to read this screen.
 *
 *  Written out here rather than rendering strategies/momentum_investing/strategy.md: no
 *  markdown renderer is installed in this app, and the two documents have different jobs —
 *  strategy.md is the canonical spec for whoever edits the code, this is for whoever is
 *  watching the portfolio. Keep the numbers here in step with strategy.md when they change.
 */
function ReadmeModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // Don't let the page behind scroll while the dialog is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const H = ({ children }: { children: React.ReactNode }) => (
    <h3 className="text-xs font-bold text-white uppercase tracking-wider mt-5 mb-2">{children}</h3>
  );
  const P = ({ children, className = 'text-zinc-300' }: {
    children: React.ReactNode; className?: string;
  }) => (
    <p className={`text-xs leading-relaxed mb-2 ${className}`}>{children}</p>
  );
  const Row = ({ k, v }: { k: React.ReactNode; v: React.ReactNode }) => (
    <tr className="border-t border-zinc-800">
      <td className="py-1.5 pr-4 text-zinc-400 align-top whitespace-nowrap">{k}</td>
      <td className="py-1.5 text-zinc-300">{v}</td>
    </tr>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-oncolor-dark/70 flex items-start justify-center overflow-y-auto p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Momentum portfolio guide"
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-3xl w-full my-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-900 rounded-t-lg">
          <div>
            <div className="text-sm font-bold text-zinc-100 uppercase tracking-wide">
              Nifty 500 Momentum Portfolio
            </div>
            <div className="text-xs text-zinc-500">How it works and how to read this page</div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 cursor-pointer"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 pb-5">
          <H>What it does</H>
          <P>
            It ranks every Nifty 500 stock by how strongly it is outperforming the Nifty 50,
            buys the strongest names that are also breaking out, and holds up to 10 at a time.
            Positions are sold when they hit a stop, or when they stop being among the
            strongest names. Freed cash is redeployed into the next qualifying stocks. It runs
            unattended — there is no discretion, no news and no fundamentals involved.
          </P>

          <H>When are trades actually taken?</H>
          <P>
            <b className="text-zinc-100">Buys happen once a week. Sells can happen any day.</b>{' '}
            The strategy wakes up once per trading day (15:20 IST by default) and does this:
          </P>
          <table className="w-full text-xs mb-2">
            <tbody>
              <Row
                k={<b className="text-zinc-200">Every trading day</b>}
                v={<>Re-checks every holding against its stop. A stop-loss or trailing-stop exit
                    can fire on <b>any</b> day — you are never left holding through a breach
                    until the weekend.</>}
              />
              <Row
                k={<b className="text-zinc-200">First trading day of each week</b>}
                v={<>The <i>weekly review</i>: rebuilds the rankings, sells anything that has
                    dropped out of the top 25 for two reviews running, and opens new positions
                    in the free slots.</>}
              />
              <Row
                k={<b className="text-zinc-200">Never</b>}
                v="Intraday trading. This is a delivery (CNC) strategy that holds for weeks — the average position in the backtest was held about 6 weeks."
              />
            </tbody>
          </table>
          <P>
            So on a typical Monday you may see new buys; Tuesday to Friday you will usually see
            nothing happen unless a stop is hit. That quiet is normal.
          </P>

          <H>How stocks get picked</H>
          <P>
            Every candidate must clear all of these, in order. Ranking decides <i>what</i>,
            the filters decide <i>when</i>, the regime decides <i>whether</i>.
          </P>
          <table className="w-full text-xs mb-2">
            <tbody>
              <Row k="Market regime" v="Last week's Nifty close above its 200-day average. If not, nothing is bought at all (and holdings are sold). Can be switched off — see Controls." />
              <Row k="Rank ≤ 20" v="Composite relative strength vs the Nifty 50, blending 2-week, 1-, 3- and 6-month performance, weighted toward 3 months." />
              <Row k="Trend stacked" v="Price above its 20-day average, which is above the 50-day, which is above the 200-day." />
              <Row k="Breakout" v="Closing at a new 55-day high, confirmed by two consecutive closes — this avoids one-day false breakouts." />
              <Row k="Liquidity" v="At least ₹5 crore average daily traded value, price above ₹50." />
              <Row k="Diversification" v="No more than 2 positions in any one sector." />
              <Row k="Cooldown" v="Not bought again within 10 days of being stopped out of the same stock." />
            </tbody>
          </table>
          <P>
            This is why the top-ranked stock is often <i>not</i> bought: high rank means it has
            already moved, the breakout filter asks whether it is moving <i>now</i>.
          </P>

          <H>How positions are exited</H>
          <P>The stop only ever moves up, never down:</P>
          <table className="w-full text-xs mb-2">
            <tbody>
              <Row k="At entry" v="Stop set 12% below the buy price." />
              <Row k="Once up 15%" v="Stop moves up to your entry price — the position can no longer lose money." />
              <Row k="Once up 25%" v="Stop trails 25% below the highest close it has reached, locking in profit as it climbs." />
              <Row k="Weekly review" v="Sold if it has fallen out of the top 25 for two reviews in a row (minimum 7-day hold)." />
              <Row k="Regime turns off" v="The whole book is sold and the strategy waits in cash." />
            </tbody>
          </table>
          <P>
            There is deliberately <b>no fixed profit target</b> — capping winners is what a
            momentum system can least afford. Backtested, a +30% target cut returns from 13.6%
            to 9.0% a year.
          </P>

          <H>Controls and safety</H>
          <table className="w-full text-xs mb-2">
            <tbody>
              <Row k={<span className="text-amber-400 font-mono">PAPER</span>} v="Simulated. Real prices, no broker orders, no money at risk. This is the default." />
              <Row k={<span className="text-red-400 font-mono">LIVE</span>} v="Places real CNC delivery orders in your Dhan account." />
              <Row k="Stopping it" v="Does NOT sell anything. Holdings, stops and cash are saved to disk and resume exactly where they left off when restarted. STOPPED between daily cycles is the normal state." />
              <Row k="Market filter" v={<>Switch off via Strategies → <b>⚙</b> on this strategy&apos;s card → Market Filter, then relaunch. Takes effect only at start-up.</>} />
              <Row k="Stale data" v="If the daily CSVs are more than 4 days old the strategy refuses to trade rather than rank on stale prices. Refresh with refresh_dashboard_data.py." />
            </tbody>
          </table>

          <H>Reading this page</H>
          <table className="w-full text-xs mb-2">
            <tbody>
              <Row k="Deployed 0%" v="All capital in cash. Normal when the market filter is off-regime — the strategy waits rather than forcing trades." />
              <Row k="Rank column" v="Current rank / rank when bought. Amber means it has one strike toward being rotated out; two consecutive strikes and it is sold." />
              <Row k="Stage" v="Which rung of the stop ladder a position has reached: hard stop → breakeven → trailing." />
              <Row k="Room to stop" v="How far price can fall before the stop triggers. Red means a small move would sell it." />
              <Row k="Held dot" v="A green dot in the rankings marks a name you already own." />
            </tbody>
          </table>

          <H>Worth knowing</H>
          <P>
            The backtest figures on this page come from a historical simulation of this exact
            ruleset, sharing the same code as the live strategy. Two honest caveats: the
            universe is <i>today&apos;s</i> Nifty 500 list, so results carry survivorship bias;
            and in 2023-2026 the strategy&apos;s drawdown was slightly worse than the index&apos;s.
            Treat the CAGR as an upper bound, not an expectation.
          </P>
          <P className="text-zinc-500">
            Full technical spec:{' '}
            <code className="text-zinc-400">strategies/momentum_investing/strategy.md</code>
          </P>
        </div>
      </div>
    </div>
  );
}

/** The ruleset's historical track record, with links out to the full reports.
 *  Deliberately placed next to the live numbers: it is the yardstick for judging whether the
 *  live portfolio is behaving as expected or drifting from what was validated. */
function BacktestPanel({ bt }: { bt: BacktestSummary | null }) {
  if (!bt) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-500">
        No backtest report yet. Generate one with{' '}
        <code className="text-zinc-400">
          venv\Scripts\python.exe scripts/analysis/backtest_momentum_portfolio.py
        </code>
      </div>
    );
  }

  const linkCls =
    'px-2 py-1 rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors';
  const fmt = (n: number | null, suffix = '%') =>
    n === null || n === undefined ? '—' : `${n >= 0 ? '' : ''}${n.toFixed(2)}${suffix}`;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 flex flex-wrap items-center gap-x-5 gap-y-2">
      <Info
        tip="Historical simulation of this exact ruleset — lib/momentum.py is shared by the backtest and the live strategy, so what was tested is what trades. Treat it as a reference for expected behaviour, not a promise: the universe is today's Nifty 500 list, so it carries survivorship bias."
        className="text-xs font-bold text-zinc-300 uppercase tracking-wider underline decoration-dotted decoration-zinc-600 underline-offset-2"
      >
        Backtest
      </Info>

      <span className="text-xs text-zinc-500">
        {bt.period?.start} → {bt.period?.end}
        {bt.universe ? ` · ${bt.universe}` : ''}
      </span>

      <span className="text-xs text-zinc-400">
        CAGR <b className="text-emerald-400 tabular-nums">{fmt(bt.cagr)}</b>
        <span className="text-zinc-600"> vs Nifty {fmt(bt.benchCagr)}</span>
      </span>
      <span className="text-xs text-zinc-400">
        Max DD <b className="text-red-400 tabular-nums">{fmt(bt.maxDrawdown)}</b>
        <span className="text-zinc-600"> vs Nifty {fmt(bt.benchMaxDrawdown)}</span>
      </span>
      <span className="text-xs text-zinc-400">
        Sharpe <b className="text-zinc-200 tabular-nums">{fmt(bt.sharpe, '')}</b>
      </span>
      <span className="text-xs text-zinc-400">
        {bt.trades} trades<span className="text-zinc-600">
          {bt.winRate !== null ? ` · ${bt.winRate.toFixed(1)}% win` : ''}
          {bt.profitFactor !== null ? ` · PF ${bt.profitFactor.toFixed(2)}` : ''}
        </span>
      </span>

      <span className="ml-auto flex items-center gap-2 text-xs">
        {bt.artifacts?.plot && (
          <a href="/api/momentum/report?type=plot" target="_blank" rel="noopener noreferrer"
             className={linkCls} title="Equity curve vs Nifty and an FD, drawdown, and capital deployed over time">
            Equity curve ↗
          </a>
        )}
        {bt.artifacts?.tearsheet && (
          <a href="/api/momentum/report?type=tearsheet" target="_blank" rel="noopener noreferrer"
             className={linkCls} title="Full statistical tearsheet: rolling returns, drawdown table, monthly heatmap, Monte Carlo">
            Tearsheet ↗
          </a>
        )}
        {bt.artifacts?.excel && (
          <a href="/api/momentum/report?type=excel"
             className={linkCls} title="Download the Excel workbook: summary, config, every trade, monthly P&L, equity curve">
            Excel ⤓
          </a>
        )}
        {bt.generatedAt && (
          <span className="text-zinc-600">run {bt.generatedAt.replace('T', ' ').slice(0, 16)}</span>
        )}
      </span>
    </div>
  );
}

/** How far price sits between the stop and the current mark — the "how much room is left" bar. */
function StopBar({ h }: { h: Holding }) {
  const span = h.ltp - h.stop_price;
  const pct = h.ltp > 0 ? Math.max(0, Math.min(100, (span / h.ltp) * 100)) : 0;
  const tone = pct < 5 ? 'bg-red-500' : pct < 12 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-2 justify-end">
      <span className="text-zinc-400 tabular-nums">{pct.toFixed(1)}%</span>
      <div className="w-16 h-1.5 bg-zinc-800 rounded overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(pct * 4, 100)}%` }} />
      </div>
    </div>
  );
}

export default function MomentumPortfolio({ instanceId = '' }: { instanceId?: string }) {
  const [data, setData] = useState<MomentumData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showReadme, setShowReadme] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
      const res = await fetch(`/api/momentum${qs}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Request failed');
      setData(json);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    fetchData();
    // The strategy writes once per daily cycle, so polling hard would be pure waste.
    const t = setInterval(fetchData, 60_000);
    return () => clearInterval(t);
  }, [fetchData]);

  return (
    <div className="bg-zinc-950 min-h-screen flex flex-col">
      {showReadme && <ReadmeModal onClose={() => setShowReadme(false)} />}
      <header className="bg-zinc-900 border-b border-zinc-800 px-4 py-3 flex items-center gap-4 sticky top-0 z-30 flex-wrap">
        <div>
          <div className="text-sm font-bold text-zinc-100 tracking-wide uppercase">Momentum Portfolio</div>
          <div className="text-xs text-zinc-500 tracking-widest">
            Nifty 500 · Composite RS · Positional{instanceId && ` · ${instanceId}`}
          </div>
        </div>
        <NavBar />
        <div className="ml-auto flex items-center gap-3">
          {data?.exists && (
            <Info
              tip={data.dryRun
                ? 'PAPER: simulated trading. The strategy tracks a portfolio using real prices but places NO orders with the broker — no real money is at risk.'
                : 'LIVE: the strategy places real CNC (delivery) orders in your Dhan account. Real money is at risk.'}
              className={`font-mono text-xs px-2 py-1 rounded border ${
                data.dryRun
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/40'
                  : 'bg-red-500/10 text-red-400 border-red-500/40'}`}
            >
              {data.dryRun ? 'PAPER' : 'LIVE'}
            </Info>
          )}
          {data?.exists && !data.regimeEnabled && (
            <Info
              tip={
                <>
                  <b>Market filter DISABLED</b>
                  <br />
                  The strategy is not checking whether the market is in an uptrend — it stays
                  eligible to be invested at all times and will hold through downturns.
                  <br /><br />
                  Backtested 2019-2026, disabling it barely changes return (13.35% vs 13.63%
                  CAGR) but deepens the worst drawdown from −13.1% to −18.1%.
                  <br /><br />
                  To change it: <b>Strategies</b> page → the <b>⚙</b> on the Nifty 500 Momentum
                  card → <b>Market Filter</b>, then relaunch. It only takes effect at start-up.
                </>
              }
              className="font-mono text-xs px-2 py-1 rounded border bg-zinc-800 text-zinc-300 border-zinc-600"
            >
              NO REGIME FILTER
            </Info>
          )}
          {data?.exists && data.regimeEnabled && data.regime !== null && (
            <Info
              tip={
                <>
                  <b>Market regime filter</b>
                  <br />
                  ON when last week&apos;s Nifty 50 close was above its {data.regimeSma ?? 200}-day
                  average, OFF when below.
                  <br /><br />
                  {data.regime
                    ? 'ON — the strategy may open new positions at the weekly review.'
                    : data.regimeExit === false
                      ? 'OFF — no new positions will be opened, but existing holdings are kept. This is the strategy sitting out a downtrend, not an error.'
                      : 'OFF — no new positions will be opened, and existing holdings are sold at the review. This is the strategy sitting out a downtrend, not an error.'}
                  <br /><br />
                  The filter itself can be switched off: <b>Strategies</b> page → the <b>⚙</b> on
                  the Nifty 500 Momentum card → <b>Market Filter</b>, then relaunch.
                </>
              }
              className={`font-mono text-xs px-2 py-1 rounded border ${
                data.regime
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/40'
                  : 'bg-red-500/10 text-red-400 border-red-500/40'}`}
            >
              REGIME {data.regime ? 'ON' : 'OFF'}
            </Info>
          )}
          {data?.dataDate && (
            <Info
              tip="Date of the most recent daily bar the ranking was computed from. If this lags the last trading day, run refresh_dashboard_data.py — the strategy refuses to trade on data more than 4 days stale."
              className="font-mono text-xs bg-zinc-800 text-zinc-400 px-2 py-1 rounded border border-zinc-700"
            >
              DATA: {data.dataDate}
            </Info>
          )}
          {lastUpdated && (
            <span className="text-xs text-zinc-500">
              {lastUpdated.toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })} IST
            </span>
          )}
          <button
            onClick={() => setShowReadme(true)}
            className="h-8 px-2.5 flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-500 hover:text-white text-zinc-300 text-xs font-bold uppercase tracking-wider cursor-pointer"
            title="How this strategy works, when it trades, and how to read this page"
          >
            <BookOpen size={13} /> Readme
          </button>
          <button
            onClick={fetchData}
            className="w-8 h-8 flex items-center justify-center bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-600 text-zinc-400 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin text-amber-400' : ''} />
          </button>
        </div>
      </header>

      {loading && !data && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <RefreshCw size={20} className="animate-spin text-zinc-400" />
          <div className="text-sm text-zinc-400 uppercase tracking-widest">Loading Portfolio…</div>
        </div>
      )}

      {error && (
        <div className="m-4 bg-red-500/10 border border-red-500/40 rounded px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {data && !data.exists && (
        <main className="flex-1 w-full mx-auto px-4 py-4 space-y-4">
          <BacktestPanel bt={data.backtest} />
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="text-sm text-zinc-300 uppercase tracking-widest">No portfolio yet</div>
            <div className="text-sm text-zinc-400 max-w-2xl">{data.message}</div>
          </div>
        </main>
      )}

      {data?.exists && (
        // Uncapped by design — matches the repo-wide convention set in e8840c6, where every
        // page wrapper dropped its max-w so pages line up with each other on a wide monitor.
        <main className="flex-1 w-full mx-auto px-4 py-4 space-y-4">
          {data.alert && (
            <div className="bg-amber-500/10 border border-amber-500/40 rounded px-4 py-2 text-sm text-amber-400 flex items-center gap-2">
              <AlertTriangle size={14} /> {data.alert}
            </div>
          )}

          {/* Summary */}
          <div className="flex flex-wrap gap-2">
            <StatTile label="Equity" value={rupees(data.equity)} sub={`from ${rupees(data.capital)}`}
                      tip="Total portfolio value: uninvested cash plus the current market value of every holding. Compare it to the starting capital below to see overall progress." />
            <StatTile label="Total P&L" value={signed(data.totalPnl)}
                      tone={data.totalPnl >= 0 ? 'good' : 'bad'}
                      sub={data.capital ? `${((data.totalPnl / data.capital) * 100).toFixed(2)}%` : undefined}
                      tip="Realized plus unrealised profit since inception, after trading costs. The percentage is against starting capital." />
            <StatTile label="Realized" value={signed(data.realizedPnl)}
                      tone={data.realizedPnl >= 0 ? 'good' : 'bad'}
                      tip="Profit actually banked from positions that have been closed, net of brokerage, STT and slippage. This number can only change when a position is sold." />
            <StatTile label="Unrealised" value={signed(data.unrealisedPnl)}
                      tone={data.unrealisedPnl >= 0 ? 'good' : 'bad'}
                      tip="Paper profit on positions still open — it moves with the market every day and is not yours until the position is closed." />
            <StatTile label="Deployed" value={`${data.deployedPct.toFixed(0)}%`}
                      sub={`${data.holdings.length}/${data.slots} slots · cash ${rupees(data.cash)}`}
                      tip="Share of capital currently invested in stocks. The rest sits in cash. It is normal for this to be 0% while the market regime is OFF — the strategy waits in cash rather than forcing trades." />
            <StatTile label="Status" value={data.running ? data.status : 'STOPPED'}
                      tone={data.running ? 'good' : 'neutral'}
                      sub={data.running ? undefined : 'holdings still tracked'}
                      tip="Whether the strategy process is currently running. This is a positional strategy that only acts once a day, so STOPPED is normal between cycles — your holdings and stops are saved to disk and resume untouched on the next start. Stopping it does NOT sell anything." />
          </div>

          <div className="text-xs text-zinc-500">
            <Info
              tip="The strategy reviews rankings and opens new positions only on the first trading day of each week. Stops and targets are still checked every day in between."
              className="text-xs text-zinc-500 underline decoration-dotted decoration-zinc-600 underline-offset-2"
            >
              Last review: {data.lastReview ?? '—'} · Next review: {data.nextReview ?? '—'}
            </Info>
            {data.lastUpdate && <span> · Updated {data.lastUpdate}</span>}
          </div>

          <BacktestPanel bt={data.backtest} />

          {/* Holdings */}
          <div>
            <div className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2">
              Holdings ({data.holdings.length})
            </div>
            <div className="overflow-x-auto border border-zinc-800 rounded">
              <table className="w-full text-xs text-zinc-300">
                <thead className="bg-zinc-800">
                  <tr>
                    <TH>Symbol</TH>
                    <TH tip="Industry group from the Nifty 500 list. The strategy holds at most 2 positions per sector so the book cannot concentrate in one theme.">Sector</TH>
                    <TH align="right" tip="Current relative-strength rank / rank when it was bought. Rising numbers mean the stock is weakening versus the market. Amber means it has already spent a review outside the top 25 — two in a row and it is sold.">Rank</TH>
                    <TH align="right">Qty</TH>
                    <TH align="right" tip="Average price paid per share.">Entry</TH>
                    <TH align="right" tip="Last traded price, refreshed from Dhan on each cycle.">LTP</TH>
                    <TH align="right" tip="Unrealised rupee profit on this position at the current price.">P&L</TH>
                    <TH align="right" tip="Unrealised profit as a percentage of the entry price.">P&L %</TH>
                    <TH align="right" tip="The price at which this position will be sold. It only ever moves up, never down.">Stop</TH>
                    <TH tip={<><b>Which rung of the exit ladder this position has reached.</b><br /><br /><b>hard stop</b> — the initial 12% stop below entry; a loss if hit.<br /><b>breakeven</b> — it gained 15%, so the stop moved up to the entry price: the position can no longer lose money.<br /><b>trailing</b> — it gained 25%, so the stop now follows 25% below its highest close, locking in profit as it rises.</>}>Stage</TH>
                    <TH align="right" tip="How far the price can fall before the stop triggers, as a percentage of the current price. Green is comfortable, amber is getting close, red means a small move would sell it.">Room to stop</TH>
                    <TH align="right" tip="Calendar days held. Positions are not rotated out on rank before 7 days.">Days</TH>
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.length === 0 && (
                    <tr><td colSpan={12} className="px-3 py-6 text-center text-zinc-500">
                      No open positions — all capital in cash.
                    </td></tr>
                  )}
                  {data.holdings.map((h) => (
                    <tr key={h.symbol} className="border-t border-zinc-800 hover:bg-zinc-900">
                      <TD className="font-bold text-zinc-100">{h.symbol}</TD>
                      <TD className="text-zinc-500">{h.industry}</TD>
                      <TD align="right">
                        <span className={h.rank_strikes > 0 ? 'text-amber-400' : 'text-zinc-400'}>
                          {h.rank ?? '—'}
                        </span>
                        <span className="text-zinc-600"> / {h.rank_at_entry}</span>
                      </TD>
                      <TD align="right">{h.qty}</TD>
                      <TD align="right">{h.entry_price.toFixed(2)}</TD>
                      <TD align="right" className="text-zinc-100">{h.ltp.toFixed(2)}</TD>
                      <TD align="right" className={pnlColor(h.unrealised)}>{signed(h.unrealised)}</TD>
                      <TD align="right" className={pnlColor(h.unrealised_pct)}>
                        {h.unrealised_pct >= 0 ? '+' : ''}{h.unrealised_pct.toFixed(2)}%
                      </TD>
                      <TD align="right">{h.stop_price.toFixed(2)}</TD>
                      <TD>
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          h.stage === 'trailing' ? 'bg-emerald-500/10 text-emerald-400'
                            : h.stage === 'breakeven' ? 'bg-sky-500/10 text-sky-400'
                            : 'bg-zinc-800 text-zinc-400'}`}>
                          {h.stage}
                        </span>
                      </TD>
                      <TD align="right"><StopBar h={h} /></TD>
                      <TD align="right" className="text-zinc-400">{h.hold_days}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Ranking */}
            <div>
              <div className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2">
                <Info
                  tip="The strongest 25 stocks in the Nifty 500 right now, ranked by how much they are outperforming the index. This is the shortlist the strategy buys from — being ranked highly is necessary but not sufficient, the stock must also be breaking out."
                  className="text-xs font-bold text-zinc-300 uppercase tracking-wider underline decoration-dotted decoration-zinc-600 underline-offset-2"
                >
                  Top 25 by Composite RS
                </Info>
              </div>
              <div className="overflow-x-auto border border-zinc-800 rounded max-h-96 overflow-y-auto">
                <table className="w-full text-xs text-zinc-300">
                  <thead className="bg-zinc-800 sticky top-0">
                    <tr>
                      <TH align="right" tip="Rank by composite relative strength. Only the top 20 are eligible to buy.">#</TH>
                      <TH>Symbol</TH>
                      <TH align="right" tip={<><b>Composite relative strength versus the Nifty 50</b>, blending 4 lookbacks (2 weeks, 1, 3 and 6 months, weighted toward 3 months).<br /><br />0 means it moved exactly with the index. +0.30 means it outperformed by about 30%. Negative means it lagged.</>}>RS</TH>
                      <TH tip="A green dot marks a name currently held in the portfolio. A high-ranked name with no dot failed an entry filter — usually it has not broken out to a new 55-day high yet.">Held</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topRanks.length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                        Ranking appears after the next cycle.
                      </td></tr>
                    )}
                    {data.topRanks.map((r, i) => {
                      const held = data.holdings.some((h) => h.symbol === r.symbol);
                      return (
                        <tr key={r.symbol} className="border-t border-zinc-800 hover:bg-zinc-900">
                          <TD align="right" className="text-zinc-500">{i + 1}</TD>
                          <TD className={held ? 'font-bold text-emerald-400' : 'text-zinc-100'}>{r.symbol}</TD>
                          <TD align="right" className={r.rs >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {r.rs >= 0 ? '+' : ''}{r.rs.toFixed(4)}
                          </TD>
                          <TD>{held && <span className="text-emerald-400">●</span>}</TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent trades */}
            <div>
              <div className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2">
                Recent Closed Trades
              </div>
              <div className="overflow-x-auto border border-zinc-800 rounded max-h-96 overflow-y-auto">
                <table className="w-full text-xs text-zinc-300">
                  <thead className="bg-zinc-800 sticky top-0">
                    <tr>
                      <TH>Symbol</TH>
                      <TH tip="Date the position was closed.">Exit</TH>
                      <TH align="right" tip="Realized rupee profit, net of costs on both the buy and the sell.">P&L</TH>
                      <TH align="right">%</TH>
                      <TH tip={<><b>Why the position was closed.</b><br /><br /><b>stop</b> — price fell to the stop.<br /><b>rebalance</b> — it dropped out of the top 25 for two consecutive weekly reviews, so stronger names took the slot.<br /><b>regime</b> — the market turned down and the whole book was moved to cash.<br /><b>target</b> — a fixed profit target was hit (disabled by default).</>}>Reason</TH>
                      <TH align="right" tip="Calendar days the position was held.">Days</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {data.closedTrades.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                        No closed trades yet.
                      </td></tr>
                    )}
                    {[...data.closedTrades].reverse().map((t, i) => (
                      <tr key={`${t.symbol}-${t.exit_date}-${i}`} className="border-t border-zinc-800 hover:bg-zinc-900">
                        <TD className="font-bold text-zinc-100">{t.symbol}</TD>
                        <TD className="text-zinc-500">{t.exit_date}</TD>
                        <TD align="right" className={pnlColor(t.pnl)}>{signed(t.pnl)}</TD>
                        <TD align="right" className={pnlColor(t.pnl_pct)}>
                          <span className="inline-flex items-center gap-1">
                            {t.pnl_pct >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                            {t.pnl_pct >= 0 ? '+' : ''}{t.pnl_pct.toFixed(2)}%
                          </span>
                        </TD>
                        <TD>
                          <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{t.exit_reason}</span>
                        </TD>
                        <TD align="right" className="text-zinc-400">{t.hold_days}</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
