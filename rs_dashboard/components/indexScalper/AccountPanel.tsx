'use client';

// Bottom account panel for /index-scalper, laid out like Dhan's chart panel: account + day summary on top, tabs
// (Positions, Closed Positions, Orders, Portfolio, Funds), order-status chips, and one table per tab.
// Positions follow the page's mode (SIM paper book, or the REAL Dhan book); Orders, Portfolio and Funds are always the
// Dhan account, read-only, except that this page's own working orders can be cancelled. Exits go through the terminal's
// own-quantity exit (nothing a strategy or another terminal opened is closed from here).

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';
import {
  dayPnl, holdingPnl, orderCounts, toCsv,
  type FundsView, type HoldingRowView, type OrderBucket, type OrderRowView, type PositionRowView,
} from '@/lib/indexScalperAccount';
import { readPref, savePref } from '@/lib/localPref';
import { cn } from '@/lib/utils';

type Tab = 'positions' | 'closed' | 'orders' | 'portfolio' | 'funds';
const OPEN_KEY = 'indexScalper.accountPanel.open';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';

const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const pnlCls = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? 'text-zinc-300' : n > 0 ? 'text-emerald-400' : 'text-rose-400');
const STATUS_CLS: Record<OrderBucket, string> = {
  open: 'text-sky-400', executed: 'text-emerald-400', cancelled: 'text-rose-400', rejected: 'text-rose-400', other: 'text-zinc-400',
};

export interface AccountPanelProps {
  real: boolean;
  /** The account the panel reads (Dhan or Kotak). */
  brokerName: string;
  positions: PositionRowView[];
  /** The positions book was actually read (REAL: a successful read and no current error). Until then the day P&L is
   *  unknown, never 0.00. */
  positionsLoaded: boolean;
  /** Exit for an open row (the terminal's own-quantity exit); null when this row cannot be exited from here. */
  canExit: (row: PositionRowView) => boolean;
  onExit: (row: PositionRowView) => void;
  exitingKey: string | null;
  orders: OrderRowView[];
  onCancelOrder: (orderId: string) => void;
  cancellingId: string | null;
  holdings: HoldingRowView[];
  /** Holdings were read successfully (Holding P&L is unknown before, 0.00 for an empty demat after). */
  holdingsLoaded: boolean;
  funds: FundsView;
  errors: { positions?: string | null; orders?: string | null; holdings?: string | null };
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cn('px-3 py-1.5 text-xs font-bold text-white whitespace-nowrap', right ? 'text-right' : 'text-left')}>{children}</th>;
}
function Empty({ cols, text }: { cols: number; text: string }) {
  return <tr><td colSpan={cols} className="px-3 py-6 text-center text-xs text-zinc-500">{text}</td></tr>;
}

export default function AccountPanel(p: AccountPanelProps) {
  const [open, setOpen] = useState(true);
  // Saved collapsed state is read after mount: reading it during render would differ from the server render.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (readPref(OPEN_KEY) === '0') setOpen(false);
    } catch { /* per-viewer only */ }
  }, []);
  const [tab, setTab] = useState<Tab>('positions');
  const [orderFilter, setOrderFilter] = useState<'all' | OrderBucket>('all');

  const openRows = useMemo(() => p.positions.filter(r => r.netQty !== 0), [p.positions]);
  const closedRows = useMemo(() => p.positions.filter(r => r.netQty === 0), [p.positions]);
  const counts = useMemo(() => orderCounts(p.orders), [p.orders]);
  const shownOrders = orderFilter === 'all' ? p.orders : p.orders.filter(o => o.bucket === orderFilter);
  const today = dayPnl(p.positions, p.positionsLoaded);
  const holdPnl = holdingPnl(p.holdings, p.holdingsLoaded);

  const toggle = () => setOpen(v => { const n = !v; try { savePref(OPEN_KEY, n ? '1' : '0'); } catch { /* per-viewer only */ } return n; });

  const download = () => {
    let csv = '';
    if (tab === 'positions') csv = toCsv(['Symbol', 'Product', 'Qty', 'Avg', 'LTP', 'P&L'], openRows.map(r => [r.symbol, r.product, r.netQty, r.avg, r.ltp, r.pnl]));
    else if (tab === 'closed') csv = toCsv(['Symbol', 'Product', 'Buy Qty', 'Buy Avg', 'Sell Qty', 'Sell Avg', 'Realized P&L'], closedRows.map(r => [r.symbol, r.product, r.buyQty, r.buyAvg, r.sellQty, r.sellAvg, r.realized]));
    else if (tab === 'orders') csv = toCsv(['Symbol', 'Exchange', 'Time', 'Buy/Sell', 'Order Type', 'Product', 'Qty', 'Traded Qty', 'Price', 'Trigger Price', 'Status', 'Order no', 'Reason'],
      shownOrders.map(o => [o.symbol, o.exchange, o.time, o.side, o.orderType, o.product, o.qty, o.tradedQty, o.price, o.trigger, o.status, o.id, o.reason]));
    else if (tab === 'portfolio') csv = toCsv(['Symbol', 'Qty', 'Avg', 'LTP', 'Invested', 'Current', 'P&L', 'P&L %'], p.holdings.map(h => [h.symbol, h.qty, h.avg, h.ltp, h.invested, h.value, h.pnl, h.pnlPct]));
    else csv = toCsv(['Item', 'Amount'], fundItems(p.funds).map(([k, v]) => [k, v]));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `index-scalper-${tab}-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`;
    a.click();
    // released after the browser has taken the download (revoking at once can cancel it, e.g. in Firefox)
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const tabs: { key: Tab; label: string; n?: number }[] = [
    { key: 'positions', label: 'Positions', n: openRows.length || undefined },
    { key: 'closed', label: 'Closed Positions', n: closedRows.length || undefined },
    { key: 'orders', label: 'Orders' },
    { key: 'portfolio', label: 'Portfolio', n: p.holdings.length || undefined },
    { key: 'funds', label: 'Funds' },
  ];

  return (
    <div data-testid="account-panel" className="shrink-0 border-t border-zinc-800 bg-zinc-900 text-[11px]">
      {/* account + day summary */}
      <div className="flex items-start justify-between gap-4 px-3 pt-2">
        <div className="flex items-center gap-2 pt-1">
          <span className="font-bold text-zinc-100 text-xs">{p.brokerName.toUpperCase()}</span>
          <span className={cn('text-[9px] font-bold px-1.5 py-px rounded border', p.real ? 'text-rose-400 border-rose-500/40 bg-rose-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10')}>
            {p.real ? `REAL · ${p.brokerName}` : 'SIM · paper positions'}
          </span>
          <button type="button" aria-label="Download this table as CSV" title="Download CSV" onClick={download}
            className={cn('p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800', FOCUS)}><Download className="w-3.5 h-3.5" /></button>
          <button type="button" aria-label={open ? 'Collapse account panel' : 'Expand account panel'} aria-expanded={open} onClick={toggle}
            className={cn('p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800', FOCUS)}>{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}</button>
        </div>
        <div className="flex items-stretch divide-x divide-zinc-800 tabular-nums">
          <Stat label={p.real ? "Today's Position P&L" : "Today's Position P&L (SIM)"} value={fmt(today.pnl)} cls={pnlCls(today.pnl)} testId="day-pnl"
            note={today.unpriced > 0 ? `partial · ${today.unpriced} unpriced` : undefined}
            noteTitle="Open positions with no price (e.g. an expiry other than the chain's) are not in this total" />
          <Stat label="Holding P&L" value={fmt(holdPnl)} cls={pnlCls(holdPnl)} />
          <Stat label="Available Margin" value={fmt(p.funds.available)} cls="text-sky-400" />
          <Stat label="Used Margin" value={fmt(p.funds.used)} cls="text-zinc-300" />
        </div>
      </div>

      {open && (
        <>
          <div role="tablist" aria-label="Account" className="flex items-center gap-5 px-3 mt-1 border-b border-zinc-800">
            {tabs.map(t => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                className={cn('py-1.5 -mb-px border-b-2 text-xs', FOCUS, tab === t.key ? 'border-zinc-100 text-white font-semibold' : 'border-transparent text-zinc-400 hover:text-zinc-200')}>
                {t.label}{t.n !== undefined && <span className="ml-1.5 text-[10px] text-zinc-500">{t.n}</span>}
              </button>
            ))}
          </div>

          {tab === 'orders' && (
            <div role="group" aria-label="Order status" className="flex items-center gap-1 px-3 pt-2">
              {counts.map(c => (
                <button key={c.key} type="button" aria-pressed={orderFilter === c.key} onClick={() => setOrderFilter(c.key)}
                  className={cn('px-2 py-0.5 rounded text-xs', FOCUS, orderFilter === c.key ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200')}>
                  {c.label} {c.n}
                </button>
              ))}
            </div>
          )}

          <div className="h-[200px] overflow-auto px-1 pb-1">
            <table className="w-full tabular-nums">
              {tab === 'positions' && (
                <>
                  <thead className="sticky top-0 bg-zinc-800"><tr><Th>Symbol</Th><Th>Product</Th><Th right>Qty</Th><Th right>Avg</Th><Th right>LTP</Th><Th right>P&amp;L</Th><Th right>{''}</Th></tr></thead>
                  <tbody>
                    {p.errors.positions && <Empty cols={7} text={`Positions: ${p.errors.positions}`} />}
                    {!p.errors.positions && openRows.length === 0 && <Empty cols={7} text="No open positions" />}
                    {openRows.map(r => (
                      <tr key={r.key} data-testid="panel-position-row" className="border-t border-zinc-800/70 hover:bg-zinc-800/40">
                        <td className="px-3 py-1.5 text-zinc-100 font-medium">{r.symbol}</td>
                        <td className="px-3 text-zinc-300">{r.product}</td>
                        <td className={cn('px-3 text-right font-semibold', r.netQty > 0 ? 'text-sky-400' : 'text-rose-400')}>{r.netQty}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(r.avg)}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(r.ltp)}</td>
                        <td className={cn('px-3 text-right font-semibold', pnlCls(r.pnl))}>{fmt(r.pnl)}</td>
                        <td className="px-3 text-right">
                          {p.canExit(r) ? (
                            <button type="button" disabled={p.exitingKey !== null} onClick={() => p.onExit(r)} aria-label={`Exit ${r.symbol}`}
                              className={cn('px-2 py-0.5 rounded border border-rose-500/60 text-rose-300 hover:bg-rose-500/10 text-[11px] font-bold disabled:opacity-40', FOCUS)}>
                              {p.exitingKey === r.key ? '…' : 'Exit'}
                            </button>
                          ) : <span className="text-[10px] text-zinc-600" title="Not a NIFTY option this page can exit">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}

              {tab === 'closed' && (
                <>
                  <thead className="sticky top-0 bg-zinc-800"><tr><Th>Symbol</Th><Th>Product</Th><Th right>Buy Qty</Th><Th right>Buy Avg</Th><Th right>Sell Qty</Th><Th right>Sell Avg</Th><Th right>Realized P&amp;L</Th></tr></thead>
                  <tbody>
                    {closedRows.length === 0 && <Empty cols={7} text="No closed positions today" />}
                    {closedRows.map(r => (
                      <tr key={r.key} className="border-t border-zinc-800/70 hover:bg-zinc-800/40">
                        <td className="px-3 py-1.5 text-zinc-100 font-medium">{r.symbol}</td>
                        <td className="px-3 text-zinc-300">{r.product}</td>
                        <td className="px-3 text-right text-zinc-200">{r.buyQty ?? '—'}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(r.buyAvg)}</td>
                        <td className="px-3 text-right text-zinc-200">{r.sellQty ?? '—'}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(r.sellAvg)}</td>
                        <td className={cn('px-3 text-right font-semibold', pnlCls(r.realized))}>{fmt(r.realized)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}

              {tab === 'orders' && (
                <>
                  <thead className="sticky top-0 bg-zinc-800">
                    <tr><Th>Symbol</Th><Th>Exchange</Th><Th>Time</Th><Th>Buy/Sell</Th><Th>Order Type</Th><Th>Product</Th><Th right>Qty</Th><Th right>Traded Qty</Th><Th right>Price</Th><Th right>Trigger Price</Th><Th>Status</Th><Th>Order no</Th><Th>Reason</Th></tr>
                  </thead>
                  <tbody>
                    {p.errors.orders && <Empty cols={13} text={`Orders: ${p.errors.orders}`} />}
                    {!p.errors.orders && shownOrders.length === 0 && <Empty cols={13} text="No orders today" />}
                    {shownOrders.map(o => (
                      <tr key={o.id} data-testid="panel-order-row" className="group border-t border-zinc-800/70 hover:bg-zinc-800/40">
                        <td className="px-3 py-1.5 text-zinc-100 font-medium whitespace-nowrap">{o.symbol}</td>
                        <td className="px-3 text-zinc-300">{o.exchange}</td>
                        <td className="px-3 text-zinc-300 whitespace-nowrap">{o.time}</td>
                        <td className={cn('px-3 font-semibold', o.side === 'BUY' ? 'text-sky-400' : 'text-rose-400')}>{o.side === 'BUY' ? 'Buy' : o.side === 'SELL' ? 'Sell' : '—'}</td>
                        <td className="px-3 text-zinc-300">{o.orderType}</td>
                        <td className="px-3 text-zinc-300">{o.product}</td>
                        <td className="px-3 text-right text-zinc-200">{o.qty ?? '—'}</td>
                        <td className="px-3 text-right text-zinc-200">{o.tradedQty ?? '—'}</td>
                        <td className="px-3 text-right text-zinc-200" title={o.avgTraded ? `Avg traded ${fmt(o.avgTraded)}` : undefined}>{o.price !== null ? fmt(o.price) : o.avgTraded !== null ? fmt(o.avgTraded) : '—'}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(o.trigger)}</td>
                        <td className={cn('px-3 font-semibold whitespace-nowrap', STATUS_CLS[o.bucket])}>
                          {o.status}
                          {o.cancellable && (
                            <button type="button" disabled={p.cancellingId !== null} onClick={() => p.onCancelOrder(o.id)} aria-label={`Cancel order ${o.id}`}
                              className={cn('ml-2 px-1.5 py-px rounded border border-zinc-600 text-zinc-300 hover:text-white hover:bg-zinc-700 text-[10px] font-bold disabled:opacity-40', FOCUS)}>
                              {p.cancellingId === o.id ? '…' : 'Cancel'}
                            </button>
                          )}
                        </td>
                        <td className="px-3 text-zinc-300">{o.id}</td>
                        <td className="px-3 text-zinc-400 max-w-[260px] truncate" title={o.reason}>{o.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}

              {tab === 'portfolio' && (
                <>
                  <thead className="sticky top-0 bg-zinc-800"><tr><Th>Symbol</Th><Th right>Qty</Th><Th right>Avg</Th><Th right>LTP</Th><Th right>Invested</Th><Th right>Current</Th><Th right>P&amp;L</Th><Th right>P&amp;L %</Th></tr></thead>
                  <tbody>
                    {p.errors.holdings && <Empty cols={8} text={`Portfolio: ${p.errors.holdings}`} />}
                    {!p.errors.holdings && p.holdings.length === 0 && <Empty cols={8} text="No holdings" />}
                    {p.holdings.map(h => (
                      <tr key={h.key} className="border-t border-zinc-800/70 hover:bg-zinc-800/40">
                        <td className="px-3 py-1.5 text-zinc-100 font-medium">{h.symbol}</td>
                        <td className="px-3 text-right text-zinc-200">{h.qty}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(h.avg)}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(h.ltp)}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(h.invested)}</td>
                        <td className="px-3 text-right text-zinc-200">{fmt(h.value)}</td>
                        <td className={cn('px-3 text-right font-semibold', pnlCls(h.pnl))}>{fmt(h.pnl)}</td>
                        <td className={cn('px-3 text-right', pnlCls(h.pnl))}>{h.pnlPct === null ? '—' : `${fmt(h.pnlPct)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}

              {tab === 'funds' && (
                <>
                  <thead className="sticky top-0 bg-zinc-800"><tr><Th>Funds</Th><Th right>Amount</Th></tr></thead>
                  <tbody>
                    {fundItems(p.funds).map(([k, v]) => (
                      <tr key={k} className="border-t border-zinc-800/70">
                        <td className="px-3 py-1.5 text-zinc-300">{k}</td>
                        <td className="px-3 text-right text-zinc-100 font-semibold">{fmt(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, cls, testId, note, noteTitle }: { label: string; value: string; cls: string; testId?: string; note?: string; noteTitle?: string }) {
  return (
    <div className="px-4 first:pl-0 last:pr-0">
      <div className="text-[11px] text-zinc-400 whitespace-nowrap">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span data-testid={testId} className={cn('text-xs font-semibold', cls)}>{value}</span>
        {note && <span data-testid={testId ? `${testId}-partial` : undefined} title={noteTitle} className="text-[10px] text-amber-300 whitespace-nowrap">{note}</span>}
      </div>
    </div>
  );
}

function fundItems(f: FundsView): [string, number | null][] {
  return [
    ['Available Margin', f.available], ['Used Margin', f.used], ['Opening Balance (SOD)', f.sodLimit], ['Collateral', f.collateral],
    ['Receivable', f.receivable], ['Blocked Payout', f.blockedPayout], ['Withdrawable', f.withdrawable],
  ];
}
