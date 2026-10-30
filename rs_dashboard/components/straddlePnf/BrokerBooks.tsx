'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { BROKER_LABELS, scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import {
  daySummary, newestFirst, toOrderRow, toPositionRow, toTradeRow, type OrderRow, type OrderState, type PositionRow, type TradeRow,
} from '@/lib/pnfBooks';

// Positions, order book, trade book and the day's P&L for the page header's broker. Read-only: no order, cancel or exit
// is sent from here. Every book is read every 5 s while the panel is open and tagged with its broker, so switching
// accounts never shows the old account's rows under the new name.

type Tab = 'positions' | 'orders' | 'trades' | 'pnl';
type BookState<T> = { broker: Broker; rows: T[]; error?: string } | null;

const POLL_MS = 5_000;
const fmt = (n: number | null, d = 2) => (n === null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const inr = (n: number | null) => (n === null ? '—' : `${n < 0 ? '-' : n > 0 ? '+' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`);
const tone = (n: number | null) => (n === null || n === 0 ? 'text-zinc-300' : n > 0 ? 'text-emerald-400' : 'text-red-400');
const sideTone = (s: string) => (s === 'BUY' ? 'text-emerald-400' : s === 'SELL' ? 'text-red-400' : 'text-zinc-400');
const STATE_TONE: Record<OrderState, string> = {
  done: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  open: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  rejected: 'text-red-400 border-red-500/30 bg-red-500/10',
  cancelled: 'text-zinc-400 border-zinc-700 bg-zinc-800',
};

/** One book's rows from a route reply, or the error to show. */
async function readBook<T>(url: string, pick: (j: Record<string, unknown>) => unknown, shape: (r: Record<string, unknown>) => T): Promise<{ rows: T[]; error?: string }> {
  try {
    const res = await fetch(url);
    const j = await res.json() as Record<string, unknown>;
    const rows = pick(j);
    if (!Array.isArray(rows)) return { rows: [], error: String(j.positionsError ?? j.error ?? `HTTP ${res.status}`) };
    return { rows: (rows as Record<string, unknown>[]).map(shape) };
  } catch (e) {
    return { rows: [], error: (e as Error).message || 'Unreadable' };
  }
}

export default function BrokerBooks({ broker }: { broker: Broker }) {
  const [tab, setTab] = useState<Tab>('positions');
  const [positions, setPositions] = useState<BookState<PositionRow>>(null);
  const [orders, setOrders] = useState<BookState<OrderRow>>(null);
  const [trades, setTrades] = useState<BookState<TradeRow>>(null);

  useEffect(() => {
    let dead = false;
    const read = async () => {
      const [p, o, t] = await Promise.all([
        readBook(`${scalperRoute(broker, 'poll')}?only=positions`, j => (j.positionsError ? null : j.positions), toPositionRow),
        readBook(scalperRoute(broker, 'orders'), j => (j.success === false ? null : j.data), toOrderRow),
        readBook(scalperRoute(broker, 'trades'), j => (j.success === false ? null : j.data), toTradeRow),
      ]);
      if (dead) return;
      setPositions({ broker, ...p });
      setOrders({ broker, ...o });
      setTrades({ broker, ...t });
    };
    void read();
    const id = setInterval(read, POLL_MS);
    return () => { dead = true; clearInterval(id); };
  }, [broker]);

  const mine = <T,>(b: BookState<T>) => (b && b.broker === broker ? b : null);
  const pos = mine(positions), ord = mine(orders), trd = mine(trades);
  const posRows = pos ? [...pos.rows].sort((a, b) => Number(b.open) - Number(a.open)) : [];
  const ordRows = ord ? newestFirst(ord.rows) : [];
  const trdRows = trd ? newestFirst(trd.rows) : [];
  const summary = daySummary(pos?.rows ?? [], ord?.rows ?? [], trd?.rows ?? []);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'positions', label: 'Positions', count: pos ? summary.open : undefined },
    { id: 'orders', label: 'Order Book', count: ord ? summary.orders.total : undefined },
    { id: 'trades', label: 'Trade Book', count: trd ? summary.trades : undefined },
    { id: 'pnl', label: 'P&L' },
  ];
  const book = tab === 'positions' ? pos : tab === 'orders' ? ord : tab === 'trades' ? trd : pos;

  return (
    <section data-testid="pnf-books" className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 flex flex-col h-64 min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800">
        <div role="tablist" aria-label="Account books" className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                    className={`px-2.5 h-6 rounded text-[11px] font-bold transition-colors ${tab === t.id ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
              {t.label}{t.count !== undefined && <span className="ml-1 font-mono text-zinc-400">{t.count}</span>}
            </button>
          ))}
        </div>
        <span className="text-[11px] font-bold text-zinc-300">{BROKER_LABELS[broker]}</span>
        <span className="ml-auto flex items-center gap-3 text-[11px] font-mono">
          <span className="text-zinc-400">Day P&L <span data-testid="pnf-books-total" className={`font-bold ${tone(pos ? summary.total : null)}`}>{pos ? inr(summary.total) : '—'}</span>
            {summary.unpriced > 0 && <span className="text-amber-400" title={`${summary.unpriced} open leg(s) without a live price: their unrealised P&L is not included`}> *</span>}</span>
          <span className="text-zinc-500">read-only · refreshes every 5 s</span>
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {book?.error ? (
          <p role="alert" className="m-3 text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">
            {BROKER_LABELS[broker]} {tab === 'pnl' ? 'positions' : tab}: {book.error}
          </p>
        ) : !book ? (
          <p className="m-3 text-xs text-zinc-500">Loading {BROKER_LABELS[broker]}…</p>
        ) : tab === 'positions' ? (
          <Table empty="No positions today" head={['Symbol', 'Product', 'Net qty', 'Avg', 'LTP', 'Realised', 'Unrealised', 'Total']} right={[2, 3, 4, 5, 6, 7]}>
            {posRows.map((p, i) => (
              <tr key={`${p.symbol}|${p.product}|${i}`} className={`border-b border-zinc-800/60 ${p.open ? '' : 'text-zinc-500'}`}>
                <td className="px-2 py-1 font-sans text-zinc-100">{p.symbol}</td>
                <td className="px-2 py-1">{p.product || '—'}</td>
                <td className={`px-2 py-1 text-right font-bold ${p.net > 0 ? 'text-emerald-400' : p.net < 0 ? 'text-red-400' : ''}`}>{p.net}</td>
                <td className="px-2 py-1 text-right">{fmt(p.avg)}</td>
                <td className="px-2 py-1 text-right">{fmt(p.ltp)}</td>
                <td className={`px-2 py-1 text-right ${tone(p.realised)}`}>{inr(p.realised)}</td>
                <td className={`px-2 py-1 text-right ${tone(p.unrealised)}`} title={p.open && p.unrealised === null ? 'No live price for this leg' : undefined}>{inr(p.unrealised)}</td>
                <td className={`px-2 py-1 text-right font-bold ${tone((p.realised ?? 0) + (p.unrealised ?? 0))}`}>{p.open && p.unrealised === null ? '—' : inr((p.realised ?? 0) + (p.unrealised ?? 0))}</td>
              </tr>
            ))}
          </Table>
        ) : tab === 'orders' ? (
          <Table empty="No orders today" head={['Time', 'Symbol', 'Side', 'Type', 'Product', 'Qty', 'Filled', 'Price', 'Avg', 'Status']} right={[5, 6, 7, 8]}>
            {ordRows.map((o, i) => (
              <tr key={o.id || i} className="border-b border-zinc-800/60">
                <td className="px-2 py-1 text-zinc-400">{o.time || '—'}</td>
                <td className="px-2 py-1 font-sans text-zinc-100">{o.symbol}</td>
                <td className={`px-2 py-1 font-bold ${sideTone(o.side)}`}>{o.side || '—'}</td>
                <td className="px-2 py-1">{o.type || '—'}</td>
                <td className="px-2 py-1">{o.product || '—'}</td>
                <td className="px-2 py-1 text-right">{o.qty}</td>
                <td className="px-2 py-1 text-right">{o.filled ?? '—'}</td>
                <td className="px-2 py-1 text-right">{o.price === null ? (o.type === 'MARKET' ? 'MKT' : '—') : fmt(o.price)}</td>
                <td className="px-2 py-1 text-right">{fmt(o.avg)}</td>
                <td className="px-2 py-1">
                  <span title={o.reason || undefined} className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold ${STATE_TONE[o.state]}`}>{o.status || '—'}</span>
                  {o.reason && o.state === 'rejected' && <span className="ml-2 text-[10px] text-red-400 font-sans">{o.reason}</span>}
                </td>
              </tr>
            ))}
          </Table>
        ) : tab === 'trades' ? (
          <Table empty="No trades today" head={['Time', 'Symbol', 'Side', 'Product', 'Qty', 'Price', 'Value', 'Order']} right={[4, 5, 6]}>
            {trdRows.map((t, i) => (
              <tr key={t.id || `${t.orderId}-${i}`} className="border-b border-zinc-800/60">
                <td className="px-2 py-1 text-zinc-400">{t.time || '—'}</td>
                <td className="px-2 py-1 font-sans text-zinc-100">{t.symbol}</td>
                <td className={`px-2 py-1 font-bold ${sideTone(t.side)}`}>{t.side || '—'}</td>
                <td className="px-2 py-1">{t.product || '—'}</td>
                <td className="px-2 py-1 text-right">{t.qty}</td>
                <td className="px-2 py-1 text-right">{fmt(t.price)}</td>
                <td className="px-2 py-1 text-right">{t.price === null ? '—' : fmt(t.qty * t.price, 0)}</td>
                <td className="px-2 py-1 text-zinc-500">{t.orderId || '—'}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <div data-testid="pnf-books-pnl" className="flex gap-4 p-3 min-h-0">
            <div className="grid grid-cols-4 gap-2 content-start shrink-0 w-[36rem]">
              <Stat label="Day P&L" value={inr(summary.total)} cls={tone(summary.total)} big />
              <Stat label="Realised" value={inr(summary.realised)} cls={tone(summary.realised)} />
              <Stat label="Unrealised" value={inr(summary.unrealised) + (summary.unpriced ? ' *' : '')} cls={tone(summary.unrealised)}
                    title={summary.unpriced ? `${summary.unpriced} open leg(s) without a live price are not included` : undefined} />
              <Stat label="Open / closed" value={`${summary.open} / ${summary.closed}`} />
              <Stat label="Won / lost" value={`${summary.winners} / ${summary.losers}`} />
              <Stat label="Orders done/open" value={ord ? `${summary.orders.done} / ${summary.orders.open}` : '—'} />
              <Stat label="Rejected/cxl" value={`${summary.orders.rejected} / ${summary.orders.cancelled}`} cls={summary.orders.rejected ? 'text-red-400' : undefined} />
              <Stat label="Turnover" value={`₹${Math.round(summary.buyValue + summary.sellValue).toLocaleString('en-IN')}`} />
            </div>
            <div className="flex-1 min-w-0 overflow-auto">
              <Table empty="No P&L yet today" head={['Symbol', 'Realised', 'Unrealised', 'Total']} right={[1, 2, 3]}>
                {summary.bySymbol.map(s => (
                  <tr key={s.symbol} className="border-b border-zinc-800/60">
                    <td className="px-2 py-1 font-sans text-zinc-100">{s.symbol}{s.open && <span className="ml-1.5 text-[10px] text-amber-400">open</span>}</td>
                    <td className={`px-2 py-1 text-right ${tone(s.realised)}`}>{inr(s.realised)}</td>
                    <td className={`px-2 py-1 text-right ${tone(s.unrealised)}`}>{inr(s.unrealised)}</td>
                    <td className={`px-2 py-1 text-right font-bold ${tone(s.total)}`}>{inr(s.total)}</td>
                  </tr>
                ))}
              </Table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Table({ head, right, empty, children }: { head: string[]; right: number[]; empty: string; children: ReactNode[] }) {
  return (
    <table className="w-full text-[11px] font-mono tabular-nums text-zinc-300">
      <thead className="sticky top-0 z-10">
        <tr className="bg-zinc-800">
          {head.map((h, i) => <th key={h} className={`px-2 py-1 text-xs font-bold text-white whitespace-nowrap ${right.includes(i) ? 'text-right' : 'text-left'}`}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {children.length ? children : <tr><td colSpan={head.length} className="px-2 py-4 text-center text-zinc-500 font-sans">{empty}</td></tr>}
      </tbody>
    </table>
  );
}

function Stat({ label, value, cls = 'text-zinc-100', big = false, title }: { label: string; value: string; cls?: string; big?: boolean; title?: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5" title={title}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`font-mono font-bold tabular-nums ${big ? 'text-base leading-5' : 'text-sm leading-5'} ${cls}`}>{value}</p>
    </div>
  );
}
