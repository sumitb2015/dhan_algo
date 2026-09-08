'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Activity, ArrowUpRight, RefreshCw } from 'lucide-react';
import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';

type TabKey = 'positions' | 'orders' | 'trades';

interface ActivityData {
  positions: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  trades: Record<string, unknown>[];
}

interface ColumnDef {
  key: string;
  label: string;
  numeric?: boolean;
  highlight?: 'side' | 'pnl';
}

const POLL_MS = 3_000;

const COLUMNS: Record<TabKey, ColumnDef[]> = {
  positions: [
    { key: 'tradingSymbol',    label: 'Symbol' },
    { key: 'netQty',           label: 'Qty',          numeric: true },
    { key: 'buyAvg',           label: 'Buy Avg',      numeric: true },
    { key: 'sellAvg',          label: 'Sell Avg',     numeric: true },
    { key: 'lastTradedPrice',  label: 'LTP',          numeric: true },
    { key: 'realizedProfit',   label: 'Realized P&L', numeric: true, highlight: 'pnl' },
    { key: 'unrealizedProfit', label: 'Unreal. P&L',  numeric: true, highlight: 'pnl' },
    { key: 'productType',      label: 'Product' },
  ],
  orders: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'orderStatus',     label: 'Status' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'quantity',        label: 'Qty',    numeric: true },
    { key: 'price',           label: 'Price',  numeric: true },
    { key: 'orderType',       label: 'Type' },
    { key: 'createTime',      label: 'Time' },
  ],
  trades: [
    { key: 'tradingSymbol',   label: 'Symbol' },
    { key: 'transactionType', label: 'Side',   highlight: 'side' },
    { key: 'tradedQuantity',  label: 'Qty',    numeric: true },
    { key: 'tradedPrice',     label: 'Price',  numeric: true },
    { key: 'createTime',      label: 'Time' },
  ],
};

const TAB_LABELS: Record<TabKey, string> = {
  positions: 'POSITIONS',
  orders: 'WORKING ORDERS',
  trades: 'TRADE LOG',
};

function fmtCell(col: ColumnDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (col.numeric) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
  }
  return String(value);
}

function cellClass(col: ColumnDef, value: unknown): string {
  if (col.highlight === 'side') {
    return String(value) === 'BUY'
      ? 'text-emerald-400 font-bold'
      : 'text-red-400 font-bold';
  }
  if (col.highlight === 'pnl') {
    const n = Number(value);
    return n > 0 ? 'text-emerald-400 font-bold' : n < 0 ? 'text-red-400 font-bold' : 'text-zinc-300';
  }
  return 'text-zinc-300';
}

function DataTable({ tab, rows, onAddLeg }: {
  tab: TabKey; rows: Record<string, unknown>[]; onAddLeg?: (pos: Record<string, unknown>) => void;
}) {
  const cols = COLUMNS[tab];
  const thCls = 'text-xs font-bold text-white bg-zinc-800 px-3 py-2 whitespace-nowrap uppercase tracking-wider';
  const showActions = tab === 'positions' && !!onAddLeg;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            {cols.map(col => (
              <th key={col.key} className={`${thCls} ${col.numeric ? 'text-right' : 'text-left'}`}>
                {col.label}
              </th>
            ))}
            {showActions && <th className={`${thCls} text-center`}>Stage</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60 font-mono text-xs">
          {rows.map((row, i) => {
            const netQty = Number(row.netQty) || 0;
            return (
              <tr key={i} className="hover:bg-zinc-800/40 transition-colors">
                {cols.map(col => (
                  <td
                    key={col.key}
                    className={`px-3 py-2 tabular-nums ${col.numeric ? 'text-right' : 'text-left'} ${cellClass(col, row[col.key])}`}
                  >
                    {fmtCell(col, row[col.key])}
                  </td>
                ))}
                {showActions && (
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => onAddLeg!(row)}
                      disabled={netQty === 0}
                      title="Stage this position's strike into basket builder"
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-bold rounded border transition-all disabled:opacity-40 disabled:cursor-not-allowed border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 active:scale-95 cursor-pointer"
                    >
                      <span>ADD</span>
                      <ArrowUpRight className="w-2.5 h-2.5" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length + (showActions ? 1 : 0)} className="px-3 py-12 text-center text-zinc-500 font-mono">
                No active {TAB_LABELS[tab].toLowerCase()} reported by broker
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function BasketActivityTabs({ broker, onAddLeg }: { broker: Broker; onAddLeg?: (pos: Record<string, unknown>) => void }) {
  const [activeTab, setActiveTab] = useState<TabKey>('positions');
  const [data, setData] = useState<ActivityData>({ positions: [], orders: [], trades: [] });
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);

  // Full pull (funds/pnl_guard included but unused here) on mount/broker switch.
  const fetchAll = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    fetch(scalperRoute(broker, 'all'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; error?: string }) => {
        if (j.success) {
          setData({ positions: j.positions ?? [], orders: j.orders ?? [], trades: j.trades ?? [] });
          setError('');
          setStale(false);
        } else {
          setError(j.error ?? 'Failed to load activity');
          setStale(true);
        }
      })
      .catch(e => { setError(String(e)); setStale(true); })
      .finally(() => {
        inFlightRef.current = false;
        setRefreshing(false);
      });
  }, [broker]);

  // Lighter recurring poll (no funds/pnl_guard round-trip).
  const pollLight = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    fetch(scalperRoute(broker, 'poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setData({ positions: j.positions ?? [], orders: j.orders ?? [], trades: j.trades ?? [] });
          setError('');
          setStale(false);
        }
      })
      .catch(() => { setStale(true); })
      .finally(() => { inFlightRef.current = false; });
  }, [broker]);

  useEffect(() => {
    fetchAll();
    intervalRef.current = setInterval(pollLight, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [broker, fetchAll, pollLight]);

  const rows = data[activeTab];

  // Quick Blotter Summary KPIs
  const blotterKpis = useMemo(() => {
    let realized = 0;
    let unrealized = 0;
    let openCount = 0;
    for (const p of data.positions) {
      realized += Number(p.realizedProfit) || 0;
      unrealized += Number(p.unrealizedProfit) || 0;
      if (Math.abs(Number(p.netQty) || 0) > 0) openCount += 1;
    }
    return { realized, unrealized, total: realized + unrealized, openCount };
  }, [data.positions]);

  return (
    <section className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm overflow-hidden">
      {/* Terminal Header */}
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3.5 py-2.5 flex-wrap shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">
            <Activity className="h-3.5 w-3.5 text-amber-400" />
            EXECUTION BLOTTER & POSITION MONITOR
          </span>
          <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-300 uppercase">
            {broker}
          </span>
        </div>

        {/* Tab Controls & Telemetry */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950/80">
            {(['positions', 'orders', 'trades'] as TabKey[]).map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`px-2.5 py-1 text-[10px] font-mono font-bold uppercase rounded-md transition-all cursor-pointer ${
                  activeTab === tab
                    ? 'border border-amber-500/40 bg-amber-500/15 text-amber-300 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                {TAB_LABELS[tab]} ({data[tab].length})
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-800">
            <button
              type="button"
              onClick={fetchAll}
              title="Force full refresh"
              disabled={refreshing}
              className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin text-sky-400' : ''}`} />
            </button>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" title="Live poll active (3s)" />
            {stale && (
              <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold border border-amber-500/30 bg-amber-500/10 text-amber-400">
                STALE
              </span>
            )}
          </div>
        </div>
      </header>

      {/* KPI Ribbon Strip */}
      {data.positions.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-zinc-800/80 border-b border-zinc-800 bg-zinc-950/50">
          <div className="px-3.5 py-2">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">Open Scrips</p>
            <p className="font-mono text-xs font-bold text-zinc-200 tabular-nums mt-0.5">
              {blotterKpis.openCount} / {data.positions.length}
            </p>
          </div>
          <div className="px-3.5 py-2">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">Realized P&L</p>
            <p className={`font-mono text-xs font-bold tabular-nums mt-0.5 ${blotterKpis.realized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {blotterKpis.realized >= 0 ? '+' : ''}₹{blotterKpis.realized.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="px-3.5 py-2">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">Unrealized P&L</p>
            <p className={`font-mono text-xs font-bold tabular-nums mt-0.5 ${blotterKpis.unrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {blotterKpis.unrealized >= 0 ? '+' : ''}₹{blotterKpis.unrealized.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="px-3.5 py-2">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">Net Portfolio MTM</p>
            <p className={`font-mono text-xs font-bold tabular-nums mt-0.5 ${blotterKpis.total >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {blotterKpis.total >= 0 ? '+' : ''}₹{blotterKpis.total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border-b border-red-500/30 px-4 py-2 font-mono">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <DataTable tab={activeTab} rows={rows} onAddLeg={onAddLeg} />
      </div>
    </section>
  );
}
