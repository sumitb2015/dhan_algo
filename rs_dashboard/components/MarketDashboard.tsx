'use client';

/**
 * The terminal landing page — what you see immediately after login.
 *
 * Visual language is deliberately "Bloomberg": near-black ground, amber chrome,
 * monospaced tabular figures, uppercase micro-labels, hairline rules, and
 * saturated green/red reserved exclusively for direction. Amber is the accent
 * (not the emerald used by the analytics pages) so the terminal reads as its own
 * surface; everything structural still goes through the zinc ramp, so the page
 * flips correctly in white mode. See CLAUDE.md's theming section.
 *
 * Data sources, all existing routes except the two `dashboard/*` ones added
 * with this page:
 *   /api/scalper/top-indices  — index LTP + % vs yesterday's close (Kite-primary;
 *                               it is the only source that survives the closing
 *                               bell without collapsing every row to 0.00%)
 *   /api/movers?index=nifty500 — today's gainers/losers
 *   /api/dashboard/breadth     — live adv/decl for Nifty 50 / Bank Nifty / Nifty 500
 *   /api/dashboard/portfolio   — funds + positions for every connected broker
 *   /api/portfolio-holdings    — Dhan delivery holdings, for total portfolio value
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Briefcase,
  CircleDot,
  Gauge,
  LayoutDashboard,
  Layers,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import type { MoverResult, MoversResponse } from '@/app/api/movers/route';
import type { DashboardBreadthResponse } from '@/app/api/dashboard/breadth/route';
import type { BrokerPortfolio, DashboardPortfolioResponse, DashboardPosition } from '@/app/api/dashboard/portfolio/route';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

// ─── Poll cadences ───────────────────────────────────────────────────────────
// Split by how fast the underlying number actually moves and how expensive it is
// to fetch, rather than putting everything on one timer — see the
// dhan-polling-guards skill (guard 11).
const INDEX_POLL_MS = 5_000;      // cheap: one batched broker quote call
const PORTFOLIO_POLL_MS = 6_000;  // funds + positions, 3 brokers, server-fanned
const BREADTH_POLL_MS = 60_000;   // ~500-symbol sweep behind a 60s server cache
const MOVERS_POLL_MS = 120_000;   // EOD CSVs patched with today's quotes
const HOLDINGS_POLL_MS = 300_000; // Python spawn; delivery value barely moves

const TOP_N_MOVERS = 8;
const TOP_N_POSITIONS = 12;

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Compact Indian-notation rupees: 12.4L, 1.83Cr. Terminal tiles have no room
 *  for a full ₹1,23,45,678 and the magnitude is what matters at a glance. */
function fmtINRCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function fmtSignedPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtSignedINR(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '-'}${fmtINRCompact(Math.abs(v))}`;
}

/** Direction colour. Solid steps only — CLAUDE.md forbids text opacity modifiers. */
function dirClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'text-zinc-400';
  return v > 0 ? 'text-emerald-400' : 'text-red-400';
}

// ─── Shared chrome ───────────────────────────────────────────────────────────

/** Panel shell. One amber rule under a micro-label header is the whole motif —
 *  every block on this page uses it so the grid reads as one instrument. */
function Panel({
  title,
  icon: Icon,
  meta,
  href,
  children,
  className = '',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: React.ReactNode;
  href?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const heading = (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">
      <Icon className="h-3 w-3" />
      {title}
    </span>
  );
  return (
    <section className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/30 px-3 py-2">
        {href ? (
          <Link href={href} className="hover:text-amber-400 transition-colors">
            {heading}
          </Link>
        ) : (
          heading
        )}
        {meta ? <span className="font-mono text-[10px] text-zinc-500">{meta}</span> : null}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

/** Big-number tile used by the portfolio summary strip. */
function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'neutral' | 'up' | 'down' | 'accent';
}) {
  const valueClass =
    tone === 'up' ? 'text-emerald-400'
    : tone === 'down' ? 'text-red-400'
    : tone === 'accent' ? 'text-amber-400'
    : 'text-zinc-100';
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
      <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">{label}</span>
      <span className={`font-mono text-lg font-semibold leading-none tabular-nums ${valueClass}`}>{value}</span>
      {sub ? <span className="font-mono text-[10px] text-zinc-500">{sub}</span> : null}
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-6 text-center font-mono text-[11px] text-zinc-600">{children}</div>;
}

// ─── Index strip ─────────────────────────────────────────────────────────────

interface IndexQuote { ltp: number; prev_close: number; change_pct: number | null; source: string }
interface TopIndicesResponse {
  success: boolean;
  updated_at: string;
  order: { key: string; label: string }[];
  quotes: Record<string, IndexQuote>;
  errors: string[];
}

function IndexStrip({ data }: { data: TopIndicesResponse | null }) {
  if (!data) {
    return (
      <div className="flex h-[62px] items-center rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 font-mono text-[11px] text-zinc-600">
        Loading indices…
      </div>
    );
  }
  const rows = data.order.filter(o => data.quotes[o.key]);
  if (rows.length === 0) {
    return (
      <div className="flex h-[62px] items-center rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 font-mono text-[11px] text-zinc-600">
        No index quotes — {data.errors[0] ?? 'broker feed unavailable'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="flex min-w-max divide-x divide-zinc-800">
        {rows.map(({ key, label }) => {
          const q = data.quotes[key];
          const pct = q.change_pct;
          const abs = q.prev_close > 0 ? q.ltp - q.prev_close : null;
          const up = (pct ?? 0) > 0;
          const down = (pct ?? 0) < 0;
          return (
            <div key={key} className="flex min-w-[150px] flex-col gap-1 px-3.5 py-2.5">
              <span className="truncate text-[9px] font-bold uppercase tracking-[0.16em] text-amber-400">
                {label}
              </span>
              <span className="font-mono text-base font-semibold leading-none tabular-nums text-zinc-100">
                {fmtNum(q.ltp, 2)}
              </span>
              {/* A null change_pct means the upstream route could not establish
                  yesterday's close — Dhan flips that field to TODAY's close at
                  the bell, and the route rejects the flipped value rather than
                  reporting a confident 0.00%. Say so instead of printing two
                  dashes, which reads as a broken tile. */}
              {pct === null || abs === null ? (
                <span
                  className="font-mono text-[11px] text-zinc-600"
                  title="Previous close unavailable — sign in to Zerodha from the login page to restore % change outside market hours."
                >
                  prev close n/a
                </span>
              ) : (
                <span className={`flex items-center gap-1 font-mono text-[11px] font-semibold tabular-nums ${dirClass(pct)}`}>
                  {up && <ArrowUpRight className="h-3 w-3" />}
                  {down && <ArrowDownRight className="h-3 w-3" />}
                  {`${abs >= 0 ? '+' : ''}${fmtNum(abs, 2)}`}
                  <span className="text-zinc-600">|</span>
                  {fmtSignedPct(pct)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Breadth ─────────────────────────────────────────────────────────────────

const BREADTH_BASKETS: { key: string; label: string }[] = [
  { key: 'nifty50', label: 'Nifty 50' },
  { key: 'banknifty', label: 'Bank Nifty' },
  { key: 'nifty500', label: 'Nifty 500' },
];

function BreadthBar({ basket }: { basket: DashboardBreadthResponse['baskets'][string] }) {
  const { advancing, declining, unchanged, total, advDecRatio, breadthPct } = basket;
  const pctOf = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xl font-semibold leading-none tabular-nums text-emerald-400">
          {advancing}
        </span>
        <span className="font-mono text-[10px] text-zinc-500">
          A/D {advDecRatio === null ? '—' : advDecRatio.toFixed(2)}
        </span>
        <span className="font-mono text-xl font-semibold leading-none tabular-nums text-red-400">
          {declining}
        </span>
      </div>
      {/* Advance/decline split. Colours are data, not chrome, so they stay
          saturated in both themes. */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="bg-emerald-500" style={{ width: `${pctOf(advancing)}%` }} />
        <div className="bg-zinc-600" style={{ width: `${pctOf(unchanged)}%` }} />
        <div className="bg-red-500" style={{ width: `${pctOf(declining)}%` }} />
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
        <span>{breadthPct === null ? '—' : `${breadthPct.toFixed(1)}% adv`}</span>
        <span>{unchanged} unch</span>
        <span>{total} scanned</span>
      </div>
    </div>
  );
}

function BreadthPanel({ data, loading }: { data: DashboardBreadthResponse | null; loading: boolean }) {
  return (
    <Panel
      title="Live Breadth"
      icon={Gauge}
      href="/breadth"
      meta={data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : undefined}
    >
      {data?.error ? (
        <EmptyRow>Breadth sweep failed — {data.error}</EmptyRow>
      ) : !data ? (
        <EmptyRow>{loading ? 'Sweeping constituents…' : 'No breadth data'}</EmptyRow>
      ) : (
        <div className="grid gap-3 p-3 sm:grid-cols-3">
          {BREADTH_BASKETS.map(({ key, label }) => {
            const basket = data.baskets[key];
            return (
              <div key={key} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
                <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">{label}</p>
                {basket ? <BreadthBar basket={basket} /> : <p className="font-mono text-[11px] text-zinc-600">—</p>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ─── Movers ──────────────────────────────────────────────────────────────────

function MoverTable({ rows, direction }: { rows: MoverResult[]; direction: 'up' | 'down' }) {
  if (rows.length === 0) return <EmptyRow>No data — run Sync Data to refresh quotes</EmptyRow>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-zinc-800 text-left">
            <th className="w-full px-3 py-1.5 text-xs font-bold text-white">Symbol</th>
            <th className="px-3 py-1.5 text-right text-xs font-bold text-white">LTP</th>
            <th className="px-3 py-1.5 text-right text-xs font-bold text-white">Chg %</th>
            <th className="hidden px-3 py-1.5 text-right text-xs font-bold text-white sm:table-cell">Vol x</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map(row => (
            <tr key={row.symbol} className="hover:bg-zinc-800/40">
              <td className="px-3 py-1.5">
                <span className="font-mono text-[11px] font-semibold text-zinc-200">{row.symbol}</span>
                <span className="ml-2 text-[10px] text-zinc-600">{row.sector}</span>
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-zinc-300">
                {fmtNum(row.latestClose, 2)}
              </td>
              <td
                className={`px-3 py-1.5 text-right font-mono text-[11px] font-semibold tabular-nums ${
                  direction === 'up' ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {fmtSignedPct(row.priceChange1D)}
              </td>
              <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-zinc-400 sm:table-cell">
                {row.volumeRatio > 0 ? `${row.volumeRatio.toFixed(1)}x` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

const BROKER_ORDER: Broker[] = ['dhan', 'zerodha', 'kotak'];

function BrokerCard({ b, holdingsValue }: { b: BrokerPortfolio; holdingsValue: number | null }) {
  // "Portfolio value" = the account's total margin base plus any delivery
  // holdings we can price. Holdings are only available for Dhan (the primary
  // account), so the other cards show the margin base alone rather than a
  // number that silently means something different per broker.
  const portfolioValue =
    b.totalBalance === null ? null : b.totalBalance + (holdingsValue ?? 0);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-amber-400">
          <CircleDot className={`h-3 w-3 ${b.connected && !b.error ? 'text-emerald-500' : 'text-zinc-600'}`} />
          {BROKER_LABELS[b.broker]}
        </span>
        <span className={`font-mono text-xs font-semibold tabular-nums ${dirClass(b.totalPnl)}`}>
          {b.connected ? fmtSignedINR(b.totalPnl) : 'OFFLINE'}
        </span>
      </div>

      {!b.connected ? (
        <p className="py-3 text-center font-mono text-[10px] text-zinc-600">
          {b.error ?? 'Not connected'}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
            <dt className="text-zinc-500">Portfolio Val</dt>
            <dd className="text-right font-semibold tabular-nums text-amber-400">{fmtINRCompact(portfolioValue)}</dd>

            <dt className="text-zinc-500">Available</dt>
            <dd className="text-right tabular-nums text-zinc-200">{fmtINRCompact(b.availableBalance)}</dd>

            <dt className="text-zinc-500">Margin Used</dt>
            <dd className="text-right tabular-nums text-zinc-200">{fmtINRCompact(b.utilizedMargin)}</dd>

            {/* Deliberately no separate "margin available" row: every broker here
                reports one free-balance figure, which is `Available` above — a
                second row repeating it would read as a different number. The
                margin base it is drawn from is shown instead. */}
            <dt className="text-zinc-500">Margin Base</dt>
            <dd className="text-right tabular-nums text-zinc-200">{fmtINRCompact(b.totalBalance)}</dd>

            {holdingsValue !== null && (
              <>
                <dt className="text-zinc-500">Holdings</dt>
                <dd className="text-right tabular-nums text-zinc-200">{fmtINRCompact(holdingsValue)}</dd>
              </>
            )}
            {b.collateralAmount !== null && (
              <>
                <dt className="text-zinc-500">Collateral</dt>
                <dd className="text-right tabular-nums text-zinc-200">{fmtINRCompact(b.collateralAmount)}</dd>
              </>
            )}
            {b.cashBalance !== null && (
              <>
                <dt className="text-zinc-500">Cash</dt>
                <dd
                  className={`text-right tabular-nums ${b.cashBalance <= 0 ? 'text-amber-400' : 'text-zinc-200'}`}
                  title={
                    b.cashBalance <= 0
                      ? 'No cash: the balance is collateral from pledged holdings. Option writes are backed by it, but any premium debit may be rejected.'
                      : undefined
                  }
                >
                  {fmtINRCompact(b.cashBalance)}
                </dd>
              </>
            )}
          </dl>

          <div className="mt-1 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2 font-mono text-[10px]">
            <div>
              <p className="text-zinc-500">Open</p>
              <p className="tabular-nums text-zinc-200">{b.openPositions}</p>
            </div>
            <div>
              <p className="text-zinc-500">Unrealized</p>
              <p className={`tabular-nums ${dirClass(b.unrealizedPnl)}`}>{fmtSignedINR(b.unrealizedPnl)}</p>
            </div>
            <div>
              <p className="text-zinc-500">Realized</p>
              <p className={`tabular-nums ${dirClass(b.realizedPnl)}`}>{fmtSignedINR(b.realizedPnl)}</p>
            </div>
          </div>

          {b.unpricedPositions > 0 && (
            <p
              className="font-mono text-[10px] text-amber-400"
              title="This broker's positions payload carries no last-traded price, so these legs are excluded from the P&L above rather than marked against their strike."
            >
              {b.unpricedPositions} leg{b.unpricedPositions === 1 ? '' : 's'} unmarked — P&amp;L excludes them
            </p>
          )}
          {b.error && <p className="font-mono text-[10px] text-amber-400">{b.error}</p>}
        </>
      )}
    </div>
  );
}

function PositionsTable({ positions }: { positions: DashboardPosition[] }) {
  if (positions.length === 0) return <EmptyRow>No open positions</EmptyRow>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-zinc-800 text-left">
            <th className="px-3 py-1.5 text-xs font-bold text-white">Broker</th>
            {/* Symbol absorbs the slack so the numeric block stays a tight,
                right-aligned column group rather than drifting apart. */}
            <th className="w-full px-3 py-1.5 text-xs font-bold text-white">Symbol</th>
            <th className="hidden px-3 py-1.5 text-xs font-bold text-white lg:table-cell">Segment</th>
            <th className="px-3 py-1.5 text-right text-xs font-bold text-white">Qty</th>
            <th className="hidden px-3 py-1.5 text-right text-xs font-bold text-white md:table-cell">Avg</th>
            <th className="hidden px-3 py-1.5 text-right text-xs font-bold text-white md:table-cell">LTP</th>
            <th className="hidden px-3 py-1.5 text-right text-xs font-bold text-white lg:table-cell">Unreal</th>
            <th className="hidden px-3 py-1.5 text-right text-xs font-bold text-white lg:table-cell">Real</th>
            <th className="px-3 py-1.5 text-right text-xs font-bold text-white">P&amp;L</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {positions.slice(0, TOP_N_POSITIONS).map(p => (
            <tr key={`${p.broker}:${p.tradingSymbol}:${p.productType}`} className="hover:bg-zinc-800/40">
              <td className="px-3 py-1.5 font-mono text-[10px] uppercase text-zinc-500">{p.broker}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <span className="font-mono text-[11px] font-semibold text-zinc-200">{p.tradingSymbol}</span>
                {p.productType && <span className="ml-2 text-[10px] text-zinc-600">{p.productType}</span>}
              </td>
              <td className="hidden px-3 py-1.5 font-mono text-[10px] text-zinc-500 lg:table-cell">{p.exchange}</td>
              <td
                className={`px-3 py-1.5 text-right font-mono text-[11px] font-semibold tabular-nums ${
                  p.netQty > 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {p.netQty > 0 ? `+${p.netQty}` : p.netQty}
              </td>
              <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-zinc-400 md:table-cell">
                {fmtNum(p.avgPrice, 2)}
              </td>
              <td
                className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-zinc-400 md:table-cell"
                title={p.lastPrice > 0 ? undefined : 'This broker reports no last-traded price for the position; the leg is excluded from P&L rather than marked against its strike.'}
              >
                {p.lastPrice > 0 ? fmtNum(p.lastPrice, 2) : '—'}
              </td>
              <td className={`hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums lg:table-cell ${dirClass(p.unrealizedPnl)}`}>
                {fmtSignedINR(p.unrealizedPnl)}
              </td>
              <td className={`hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums lg:table-cell ${dirClass(p.realizedPnl)}`}>
                {fmtSignedINR(p.realizedPnl)}
              </td>
              <td className={`px-3 py-1.5 text-right font-mono text-[11px] font-semibold tabular-nums ${dirClass(p.totalPnl)}`}>
                {fmtSignedINR(p.totalPnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {positions.length > TOP_N_POSITIONS && (
        <p className="px-3 py-2 font-mono text-[10px] text-zinc-600">
          +{positions.length - TOP_N_POSITIONS} more — open Portfolio for the full book
        </p>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MarketDashboard() {
  const [indices, setIndices] = useState<TopIndicesResponse | null>(null);
  const [movers, setMovers] = useState<MoversResponse | null>(null);
  const [breadth, setBreadth] = useState<DashboardBreadthResponse | null>(null);
  const [breadthLoading, setBreadthLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<DashboardPortfolioResponse | null>(null);
  const [holdingsValue, setHoldingsValue] = useState<number | null>(null);
  const [clock, setClock] = useState('');

  // Every poller below carries the same two guards: `stopped` (set by the
  // effect's cleanup, so an in-flight fetch that lands after unmount does not
  // setState) and a monotonic `seq` (so a slow response can never overwrite a
  // newer one). See the dhan-polling-guards skill, guard 4.
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('en-IN', {
          hour12: false,
          timeZone: 'Asia/Kolkata',
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/scalper/top-indices');
        const json = (await res.json()) as TopIndicesResponse;
        if (stopped || mine !== seq) return;
        if (json?.success) setIndices(json);
      } catch {
        /* transient — the next tick retries; keep the last good strip on screen */
      }
    }
    load();
    const id = setInterval(load, INDEX_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/movers?index=nifty500');
        const json = (await res.json()) as { success: boolean; data: MoversResponse };
        if (stopped || mine !== seq) return;
        if (json?.success && json.data) setMovers(json.data);
      } catch {
        /* keep the last good list */
      }
    }
    load();
    const id = setInterval(load, MOVERS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/dashboard/breadth');
        const json = (await res.json()) as DashboardBreadthResponse;
        if (stopped || mine !== seq) return;
        setBreadth(json);
      } catch {
        /* keep the last good counts */
      } finally {
        if (!stopped) setBreadthLoading(false);
      }
    }
    load();
    const id = setInterval(load, BREADTH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/dashboard/portfolio');
        const json = (await res.json()) as DashboardPortfolioResponse;
        if (stopped || mine !== seq) return;
        if (json?.success) setPortfolio(json);
      } catch {
        /* keep the last good book */
      }
    }
    load();
    const id = setInterval(load, PORTFOLIO_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let seq = 0;
    let stopped = false;
    async function load() {
      const mine = ++seq;
      try {
        const res = await fetch('/api/portfolio-holdings');
        const json = (await res.json()) as {
          success?: boolean;
          summary?: { totalCurrentValue?: number };
        };
        if (stopped || mine !== seq) return;
        if (json?.success && Number.isFinite(Number(json.summary?.totalCurrentValue))) {
          setHoldingsValue(Number(json.summary!.totalCurrentValue));
        }
      } catch {
        /* holdings are optional context, not a required figure */
      }
    }
    load();
    const id = setInterval(load, HOLDINGS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const gainers = (movers?.gainers ?? []).slice(0, TOP_N_MOVERS);
  const losers = (movers?.losers ?? []).slice(0, TOP_N_MOVERS);
  const brokers = BROKER_ORDER.map(
    key => portfolio?.brokers.find(b => b.broker === key) ?? null,
  ).filter((b): b is BrokerPortfolio => b !== null);

  const allPositions = brokers
    .flatMap(b => b.positions)
    .sort((a, b) => a.totalPnl - b.totalPnl);

  const totals = portfolio?.totals;
  const portfolioValue =
    totals ? totals.totalBalance + (holdingsValue ?? 0) : null;

  // The data-currency chip: movers/breadth ride on the daily CSVs, so the chip
  // reports the date those carry (CLAUDE.md requires it on any page showing
  // dated market data), not "now".
  const dataDate = movers?.dataDate ?? '—';

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/10">
            <LayoutDashboard className="h-[15px] w-[15px] text-amber-400" />
          </div>
          <div>
            <p className="mb-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-amber-400">
              Dhan Algo · Live Terminal
            </p>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">Market Dashboard</h1>
            <p className="mt-1 text-[10px] font-medium text-zinc-500">
              Indices, movers, breadth and multi-broker portfolio in one screen
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[10px] font-semibold text-zinc-400">
            DATA: {dataDate}
          </span>
          <span className="flex items-center gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1 font-mono text-[10px] font-semibold text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            {clock || '--:--:--'} IST
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-6 py-5">
        <IndexStrip data={indices} />

        <BreadthPanel data={breadth} loading={breadthLoading} />

        <Panel
          title="Portfolio"
          icon={Briefcase}
          href="/portfolio"
          meta={portfolio?.updatedAt ? new Date(portfolio.updatedAt).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : undefined}
        >
          <div className="flex flex-col gap-3 p-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <StatTile
                label="Portfolio Value"
                value={fmtINRCompact(portfolioValue)}
                sub={holdingsValue !== null ? `incl. ${fmtINRCompact(holdingsValue)} holdings` : 'margin base'}
                tone="accent"
              />
              <StatTile
                label="Available Funds"
                value={fmtINRCompact(totals?.availableBalance)}
                sub="cash + collateral, all brokers"
              />
              <StatTile
                label="Margin Utilized"
                value={fmtINRCompact(totals?.utilizedMargin)}
                sub={
                  totals && totals.totalBalance > 0
                    ? `${((totals.utilizedMargin / totals.totalBalance) * 100).toFixed(1)}% of base`
                    : 'blocked'
                }
              />
              {/* Same figure as Available Funds — every supported broker reports a
                  single free-balance number, and margin is drawn from it. Shown
                  separately because it is the number sized against before a trade;
                  the sub-label names the base so the two are not read as
                  independent pools. */}
              <StatTile
                label="Margin Available"
                value={fmtINRCompact(totals?.availableBalance)}
                sub={`of ${fmtINRCompact(totals?.totalBalance)} base`}
              />
              <StatTile
                label="Open P&L"
                value={fmtSignedINR(totals?.unrealizedPnl)}
                sub={
                  totals && totals.unpricedPositions > 0
                    ? `${totals.openPositions} pos · ${totals.unpricedPositions} unmarked`
                    : `${totals?.openPositions ?? 0} positions`
                }
                tone={(totals?.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}
              />
              <StatTile
                label="Day P&L"
                value={fmtSignedINR(totals?.totalPnl)}
                sub={`realized ${fmtSignedINR(totals?.realizedPnl)}`}
                tone={(totals?.totalPnl ?? 0) >= 0 ? 'up' : 'down'}
              />
            </div>

            {brokers.length === 0 ? (
              <EmptyRow>Loading broker accounts…</EmptyRow>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {brokers.map(b => (
                  <BrokerCard
                    key={b.broker}
                    b={b}
                    holdingsValue={b.broker === 'dhan' ? holdingsValue : null}
                  />
                ))}
              </div>
            )}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Top Gainers"
            icon={TrendingUp}
            href="/movers"
            meta={movers?.liveQuotesMeta ? `live ${movers.liveQuotesMeta.count}` : 'Nifty 500'}
          >
            <MoverTable rows={gainers} direction="up" />
          </Panel>
          <Panel
            title="Top Losers"
            icon={TrendingDown}
            href="/movers"
            meta={movers?.liveQuotesMeta ? `live ${movers.liveQuotesMeta.count}` : 'Nifty 500'}
          >
            <MoverTable rows={losers} direction="down" />
          </Panel>
        </div>

        <Panel
          title="Open Positions"
          icon={Layers}
          href="/portfolio"
          meta={`${allPositions.length} legs · ${fmtSignedINR(totals?.unrealizedPnl)}`}
        >
          <PositionsTable positions={allPositions} />
        </Panel>

        <p className="flex items-center gap-1.5 pb-2 font-mono text-[10px] text-zinc-600">
          <Activity className="h-3 w-3" />
          Indices {INDEX_POLL_MS / 1000}s · portfolio {PORTFOLIO_POLL_MS / 1000}s · breadth{' '}
          {BREADTH_POLL_MS / 1000}s · movers {MOVERS_POLL_MS / 1000}s
          <Wallet className="ml-2 h-3 w-3" />
          holdings {HOLDINGS_POLL_MS / 60000}m
        </p>
      </div>
    </div>
  );
}
