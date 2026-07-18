'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Receipt, RefreshCw, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useTradeSync } from '@/lib/useTradeSync';
import NavBar from './NavBar';

// ─── Types ────────────────────────────────────────────────────────────────────

type Segment = 'EQUITY' | 'FNO' | 'COMMODITY';
const SEGMENTS: Segment[] = ['EQUITY', 'FNO', 'COMMODITY'];
const SEGMENT_LABEL: Record<Segment, string> = { EQUITY: 'Equity', FNO: 'F&O', COMMODITY: 'Commodity' };

interface SegmentTotals {
  realizedPnl: number;
  charges: number;
  statutoryCharges: number;
  netRealizedPnl: number;
  openPositionsUnrealized: number;
  openPositionsCount: number;
  tradeCount: number;
  symbolCount: number;
  preWindowGapSymbols: number;
}

interface SymbolRow {
  securityId: string;
  symbol: string;
  segment: Segment;
  tradeCount: number;
  realizedPnl: number;
  charges: number;
  statutoryCharges: number;
  netRealizedPnl: number;
  openQty: number;
  openAvgPrice: number | null;
  openUnrealizedPnl: number | null;
  preWindowGap: boolean;
}

interface TradeRow {
  date: string;
  time: string;
  segment: Segment;
  symbol: string;
  securityId: string;
  transactionType: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  charges: number;
  statutoryCharges: number;
  productType: string;
  optionType: string | null;
  strikePrice: number | null;
  expiryDate: string | null;
}

interface TradeHistoryResponse {
  success: boolean;
  available: boolean;
  generatedAt?: string;
  fromDate?: string;
  equityFromDate?: string;
  toDate?: string;
  totalTrades?: number;
  totalTradesFetched?: number;
  segments?: Partial<Record<Segment, SegmentTotals>>;
  symbols?: SymbolRow[];
  trades?: TradeRow[];
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtINR(n: number, compact = false): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
    if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}₹${abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PnlText({ v, compact }: { v: number; compact?: boolean }) {
  return (
    <span className={cn('tabular-nums font-bold', v >= 0 ? 'text-emerald-400' : 'text-red-400')}>
      {v >= 0 ? '+' : ''}{fmtINR(v, compact)}
    </span>
  );
}

const SEGMENT_COLOR: Record<Segment, string> = {
  EQUITY: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  FNO: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
  COMMODITY: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
};

function SegmentBadge({ segment }: { segment: Segment }) {
  return (
    <span className={cn('text-[10px] font-bold px-1.5 py-px rounded border', SEGMENT_COLOR[segment])}>
      {SEGMENT_LABEL[segment]}
    </span>
  );
}

// ─── Segment Card ─────────────────────────────────────────────────────────────

function SegmentCard({ segment, totals }: { segment: Segment; totals: SegmentTotals | undefined }) {
  if (!totals) {
    return (
      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <SegmentBadge segment={segment} />
        </div>
        <span className="text-xs text-zinc-600 mt-2">No trades in this segment</span>
      </div>
    );
  }
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <SegmentBadge segment={segment} />
        <span className="text-[10px] text-zinc-500">{totals.tradeCount} trades · {totals.symbolCount} symbols</span>
      </div>
      <div>
        <span className="text-[9px] text-zinc-500 uppercase tracking-wide">Net P&L (after charges)</span>
        <div className="text-lg leading-tight"><PnlText v={totals.netRealizedPnl} compact /></div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <span className="text-zinc-500">Realized</span>
          <div><PnlText v={totals.realizedPnl} compact /></div>
        </div>
        <div>
          <span className="text-zinc-500">Charges</span>
          <div className="text-red-400/80 font-semibold tabular-nums">-{fmtINR(totals.statutoryCharges, true)}</div>
        </div>
      </div>
      {totals.openPositionsCount > 0 && (
        <div className="text-[10px] text-zinc-500 pt-1 border-t border-zinc-800/60">
          {totals.openPositionsCount} still-open position{totals.openPositionsCount !== 1 ? 's' : ''}:{' '}
          <PnlText v={totals.openPositionsUnrealized} compact /> unrealized (not counted above)
        </div>
      )}
      {totals.preWindowGapSymbols > 0 && (
        <div className="text-[10px] text-amber-500/90 pt-1 border-t border-zinc-800/60 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
          <span>
            {totals.preWindowGapSymbols} symbol{totals.preWindowGapSymbols !== 1 ? 's' : ''} had inventory from
            before this window sold during it — that exit P&amp;L is understated below (marked with ⚠).
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PortfolioTradesDashboard() {
  const [data, setData] = useState<TradeHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [segmentFilter, setSegmentFilter] = useState<Segment | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const fetchData = useCallback(() => {
    fetch('/api/portfolio-trades')
      .then(r => r.json())
      .then(resp => setData(resp))
      .catch(() => setData({ success: false, available: false }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const { syncing, syncError, startSync } = useTradeSync(fetchData);

  const filteredTrades = useMemo(() => {
    let trades = data?.trades ?? [];
    if (segmentFilter !== 'ALL') trades = trades.filter(t => t.segment === segmentFilter);
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      trades = trades.filter(t => t.symbol.toUpperCase().includes(q));
    }
    // trades come sorted ascending by time from the backend — show most recent first
    return [...trades].reverse();
  }, [data, segmentFilter, search]);

  const visibleTrades = showAll || search.trim() ? filteredTrades : filteredTrades.slice(0, 300);

  const filteredSymbols = useMemo(() => {
    let symbols = data?.symbols ?? [];
    if (segmentFilter !== 'ALL') symbols = symbols.filter(s => s.segment === segmentFilter);
    return symbols;
  }, [data, segmentFilter]);

  const totalNetPnl = SEGMENTS.reduce((sum, seg) => sum + (data?.segments?.[seg]?.netRealizedPnl ?? 0), 0);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-200">
      <header className="w-full border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 sticky top-0 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-violet-400 flex items-center justify-center shadow-md shadow-indigo-500/10 shrink-0">
            <Receipt className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">Trade P&amp;L by Segment</h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {data?.generatedAt ? `Generated ${new Date(data.generatedAt).toLocaleString('en-IN')}` : 'Loading…'}
            </p>
          </div>
        </div>
        <NavBar />
        <button
          onClick={startSync}
          disabled={syncing || !data?.available}
          title="Fetch new days' trades and update totals (incremental — a few seconds)"
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </header>

      {syncError && (
        <div className="w-full border-b border-red-900/40 bg-red-950/20 px-4 py-1.5 text-[11px] text-red-400">
          {syncError}
        </div>
      )}

      <div className="w-full border-b border-zinc-900 bg-zinc-950/40 px-4 py-1.5 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Related</span>
        <Link href="/portfolio" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/30 transition-all">
          Portfolio
        </Link>
        <Link href="/portfolio-new" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/30 transition-all">
          Portfolio+ (Net Worth)
        </Link>
        <Link href="/portfolio/diary" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/30 transition-all">
          Trader's Diary
        </Link>
        <Link href="/reports" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/30 transition-all">
          Reports
        </Link>
      </div>

      <main className="flex-1 w-full max-w-[1400px] mx-auto px-4 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[300px] gap-3">
            <RefreshCw className="h-6 w-6 text-indigo-500 animate-spin" />
            <span className="text-zinc-600 text-xs">Loading trade history…</span>
          </div>
        ) : !data?.available ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[260px] gap-3">
            <Receipt className="h-8 w-8 text-zinc-700" />
            <p className="text-sm font-semibold text-zinc-300">No trade history generated yet</p>
            <p className="text-xs text-zinc-600 max-w-md text-center">
              This report fetches your full trade history and FIFO-matches realized P&amp;L by segment —
              it makes many paginated API calls and takes about a minute.
            </p>
            <Link
              href="/reports"
              className="mt-1 px-4 py-1.5 text-xs font-semibold bg-indigo-950/40 border border-indigo-800 text-indigo-400 rounded-lg hover:bg-indigo-900/40 transition-all"
            >
              Run "Trade P&amp;L by Segment" from Reports
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-[11px] text-zinc-500">
                Reporting period: {data.fromDate} → {data.toDate}
                {' · '}{data.totalTrades?.toLocaleString('en-IN')} trades
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Overall Net P&amp;L</span>
                <PnlText v={totalNetPnl} compact />
              </div>
            </div>
            <p className="text-[10px] text-zinc-600 -mt-2">
              All three segments report on the same period ({data.fromDate} → {data.toDate}). Equity trade
              history is additionally fetched back to {data.equityFromDate} — used only to resolve the correct
              entry price for positions bought before {data.fromDate} and sold during this period, not to
              extend what counts as "recent" P&amp;L. "Charges" shown below is statutory fees only (STT, SEBI,
              GST, exchange, stamp duty) — brokerage is still subtracted in Net P&amp;L, just not broken out
              separately, matching how Dhan's own trade P&amp;L displays it.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {SEGMENTS.map(seg => (
                <SegmentCard key={seg} segment={seg} totals={data.segments?.[seg]} />
              ))}
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5">
                {(['ALL', ...SEGMENTS] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setSegmentFilter(s)}
                    className={cn(
                      'px-2.5 py-1 text-[10px] font-semibold rounded transition-all',
                      segmentFilter === s ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    {s === 'ALL' ? 'All' : SEGMENT_LABEL[s]}
                  </button>
                ))}
              </div>
              <input
                type="text"
                placeholder="Search symbol…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="px-2.5 py-1 text-[11px] bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/40 w-48"
              />
            </div>

            {/* Symbol breakdown */}
            <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
              <table className="w-full border-collapse">
                <thead className="bg-zinc-800">
                  <tr>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Symbol</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Segment</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Trades</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Realized</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Charges</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Net P&amp;L</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Open Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSymbols.slice(0, 100).map(s => (
                    <tr key={s.securityId} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                      <td className="py-[5px] px-2 text-[12px] text-white font-medium">
                        {s.symbol}
                        {s.preWindowGap && (
                          <span title="Had inventory before this window sold during it — realized P&L here is understated">
                            <AlertTriangle className="inline h-3 w-3 text-amber-500 ml-1 -mt-0.5" />
                          </span>
                        )}
                      </td>
                      <td className="py-[5px] px-2 text-[12px]"><SegmentBadge segment={s.segment} /></td>
                      <td className="py-[5px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{s.tradeCount}</td>
                      <td className="py-[5px] px-2 text-[12px] text-right"><PnlText v={s.realizedPnl} compact /></td>
                      <td className="py-[5px] px-2 text-[12px] text-right text-red-400/80 tabular-nums">-{fmtINR(s.statutoryCharges, true)}</td>
                      <td className="py-[5px] px-2 text-[12px] text-right"><PnlText v={s.netRealizedPnl} compact /></td>
                      <td className="py-[5px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">
                        {Math.abs(s.openQty) > 0.0001 ? s.openQty : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredSymbols.length > 100 && (
                <div className="px-2 py-1.5 text-[10px] text-zinc-600 border-t border-zinc-900">
                  Showing top 100 of {filteredSymbols.length} symbols by |net P&amp;L| — use search to find a specific one.
                </div>
              )}
            </div>

            {/* Trade log */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">Trade Log</span>
              {!showAll && !search.trim() && filteredTrades.length > 300 && (
                <button
                  onClick={() => setShowAll(true)}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300"
                >
                  Show all {filteredTrades.length.toLocaleString('en-IN')} trades
                </button>
              )}
            </div>
            <div className="overflow-x-auto rounded-xl border border-zinc-800/60 max-h-[600px] overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="bg-zinc-800 sticky top-0">
                  <tr>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Time</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Segment</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Symbol</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Type</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Qty</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Price</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Charges</th>
                    <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Product</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTrades.map((t, i) => (
                    <tr key={i} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                      <td className="py-[5px] px-2 text-[11px] text-zinc-500 tabular-nums whitespace-nowrap">{t.time.replace('T', ' ')}</td>
                      <td className="py-[5px] px-2 text-[12px]"><SegmentBadge segment={t.segment} /></td>
                      <td className="py-[5px] px-2 text-[12px] text-white">{t.symbol}</td>
                      <td className="py-[5px] px-2 text-[12px]">
                        <span className={cn('inline-flex items-center gap-0.5 font-bold', t.transactionType === 'BUY' ? 'text-emerald-400' : 'text-red-400')}>
                          {t.transactionType === 'BUY' ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
                          {t.transactionType}
                        </span>
                      </td>
                      <td className="py-[5px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{t.quantity}</td>
                      <td className="py-[5px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(t.price)}</td>
                      <td className="py-[5px] px-2 text-[12px] text-right text-red-400/70 tabular-nums">-{fmtINR(t.statutoryCharges)}</td>
                      <td className="py-[5px] px-2 text-[11px] text-zinc-500">{t.productType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!showAll && !search.trim() && filteredTrades.length > 300 && (
                <div className="px-2 py-1.5 text-[10px] text-zinc-600 border-t border-zinc-900">
                  Showing most recent 300 of {filteredTrades.length.toLocaleString('en-IN')} trades.
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
