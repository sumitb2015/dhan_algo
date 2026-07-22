'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { brokerRoute, type Broker } from '@/hooks/useBrokerSelector';

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
  positions: 'Positions',
  orders: 'Orders',
  trades: 'Trades',
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
      ? 'text-emerald-400 font-semibold'
      : 'text-red-400 font-semibold';
  }
  if (col.highlight === 'pnl') {
    const n = Number(value);
    return n > 0 ? 'text-emerald-400 font-semibold' : n < 0 ? 'text-red-400 font-semibold' : 'text-zinc-300';
  }
  return 'text-zinc-300';
}

function DataTable({ tab, rows }: { tab: TabKey; rows: Record<string, unknown>[] }) {
  const cols = COLUMNS[tab];
  const thCls = 'text-xs font-bold text-white bg-zinc-800 px-3 py-2 whitespace-nowrap';

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
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
              {cols.map(col => (
                <td
                  key={col.key}
                  className={`px-3 py-2 tabular-nums ${col.numeric ? 'text-right' : 'text-left'} ${cellClass(col, row[col.key])}`}
                >
                  {fmtCell(col, row[col.key])}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="px-3 py-8 text-center text-zinc-600">
                No {TAB_LABELS[tab].toLowerCase()}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Broker-aware Positions/Orders/Trades tabs — reuses the same /api/scalper
 *  (Dhan) and /api/scalper/zerodha (Zerodha) endpoints and response shape as
 *  Scalper.tsx, so a basket's fills show up here immediately after placement. */
export default function BasketActivityTabs({ broker }: { broker: Broker }) {
  const [activeTab, setActiveTab] = useState<TabKey>('positions');
  const [data, setData] = useState<ActivityData>({ positions: [], orders: [], trades: [] });
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);

  // Full pull (funds/pnl_guard included but unused here) on mount/broker switch.
  const fetchAll = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    fetch(brokerRoute(broker, '/api/scalper/all', '/api/scalper/zerodha/all'))
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
      .finally(() => { inFlightRef.current = false; });
  }, [broker]);

  // Lighter recurring poll (no funds/pnl_guard round-trip).
  const pollLight = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    fetch(brokerRoute(broker, '/api/scalper/poll', '/api/scalper/zerodha/poll'))
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

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
        {(['positions', 'orders', 'trades'] as TabKey[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
              activeTab === tab
                ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            }`}
          >
            {TAB_LABELS[tab]} ({data[tab].length})
          </button>
        ))}
        {stale && (
          <span className="text-[10px] text-amber-400 font-semibold ml-auto">Stale data</span>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border-b border-red-500/30 px-4 py-2">
          {error}
        </div>
      )}

      <DataTable tab={activeTab} rows={rows} />
    </div>
  );
}
