'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { ClipboardList, RefreshCw, X } from 'lucide-react';
import { TabTable, type SortState, FOCUS_RING } from '../Scalper';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

export interface OrdersTradesModalProps {
  isOpen: boolean;
  onClose: () => void;
  broker: Broker;
  ordersData: Record<string, unknown>[];
  tradesData: Record<string, unknown>[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export default function OrdersTradesModal({
  isOpen,
  onClose,
  broker,
  ordersData,
  tradesData,
  isLoading,
  error,
  onRefresh,
}: OrdersTradesModalProps) {
  const [ordersTab, setOrdersTab] = useState<'orders' | 'trades'>('orders');
  const [tableSort, setTableSort] = useState<SortState>({ key: 'createTime', dir: 'desc' });
  const [filterText, setFilterText] = useState('');

  // Close modal on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const handleTableSort = useCallback((key: string) => {
    setTableSort(prev => (prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  }, []);

  // Filtered orders or trades data by search query
  const filteredData = useMemo(() => {
    const raw = ordersTab === 'orders' ? ordersData : tradesData;
    if (!filterText.trim()) return raw;
    const q = filterText.trim().toLowerCase();
    return raw.filter(item => {
      const sym = String(item.tradingSymbol ?? item.symbol ?? '').toLowerCase();
      const st = String(item.orderStatus ?? item.status ?? '').toLowerCase();
      const side = String(item.transactionType ?? item.side ?? '').toLowerCase();
      return sym.includes(q) || st.includes(q) || side.includes(q);
    });
  }, [ordersTab, ordersData, tradesData, filterText]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6 bg-oncolor-dark/80 backdrop-blur-sm"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-6xl max-h-[88vh] bg-zinc-900 border border-zinc-700 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl text-white overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-sky-400" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-100">
                Broker Orders &amp; Trades
              </h2>
            </div>
            <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-zinc-800 border border-zinc-700 text-zinc-300 uppercase">
              {BROKER_LABELS[broker]}
            </span>
            <span className="text-[11px] text-zinc-500 hidden sm:inline">
              Every order and trade on this account today
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50 cursor-pointer ${FOCUS_RING}`}
              title="Refresh order book and tradebook"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer ${FOCUS_RING}`}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs & Filter Bar */}
        <div className="flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
            <button
              type="button"
              onClick={() => {
                setOrdersTab('orders');
                setTableSort({ key: 'createTime', dir: 'desc' });
              }}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                ordersTab === 'orders'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Order Book ({ordersData.length})
            </button>
            <button
              type="button"
              onClick={() => {
                setOrdersTab('trades');
                setTableSort({ key: 'createTime', dir: 'desc' });
              }}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                ordersTab === 'trades'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Tradebook ({tradesData.length})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Filter by symbol / side / status…"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              className="h-8 bg-zinc-950 border border-zinc-800 text-zinc-200 placeholder-zinc-600 text-xs rounded-lg px-2.5 w-56 focus:outline-none focus:border-zinc-600 font-mono"
            />
            {filterText && (
              <button
                type="button"
                onClick={() => setFilterText('')}
                className="text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Table Container */}
        <div className="flex-1 overflow-auto border border-zinc-800 rounded-xl bg-zinc-950/50 min-h-[300px]">
          {error ? (
            <div className="p-4 text-xs text-rose-400 font-mono bg-rose-500/10 border border-rose-500/20 rounded-lg m-4">
              Error loading {ordersTab}: {error}
            </div>
          ) : isLoading && (ordersTab === 'orders' ? ordersData.length === 0 : tradesData.length === 0) ? (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <RefreshCw className="w-6 h-6 text-zinc-600 animate-spin" />
              <span className="text-xs text-zinc-500">
                Loading {ordersTab === 'orders' ? 'order book' : 'tradebook'} from {BROKER_LABELS[broker]}…
              </span>
            </div>
          ) : (
            <TabTable
              tab={ordersTab}
              data={filteredData}
              sort={tableSort}
              onSort={handleTableSort}
            />
          )}
        </div>
      </div>
    </div>
  );
}
