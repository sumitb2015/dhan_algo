'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { ClipboardList, RefreshCw, X, Pencil, Trash2, Check, AlertCircle, CheckCircle2 } from 'lucide-react';
import { TabTable, SortableTH, sortRows, type SortState, FOCUS_RING } from '../Scalper';
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

function isOrderPending(status: unknown): boolean {
  const s = String(status ?? '').trim().toUpperCase();
  return [
    'PENDING',
    'OPEN',
    'TRANSIT',
    'TRIGGER_PENDING',
    'TRIGGER PENDING',
    'TRIGGERPENDING',
    'AFTER_MARKET_ORDER_REQ_RECEIVED',
    'MODIFY_PENDING',
  ].includes(s);
}

function getOrderId(order: Record<string, unknown>): string {
  return String(order.orderId ?? order.order_id ?? order.nOrdNo ?? '');
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

  // ── Edit & Cancel State ───────────────────────────────────────────
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState<string>('');
  const [editQty, setEditQty] = useState<string>('');
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Close modal on Escape key (unless currently editing an order)
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingOrderId) {
          setEditingOrderId(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, editingOrderId]);

  // Auto-dismiss action messages after 5 seconds
  useEffect(() => {
    if (!actionMsg) return;
    const timer = setTimeout(() => setActionMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [actionMsg]);

  const handleTableSort = useCallback((key: string) => {
    setTableSort(prev => (prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  }, []);

  const startEdit = (order: Record<string, unknown>) => {
    const id = getOrderId(order);
    const p = Number(order.price ?? 0);
    const q = Number(order.quantity ?? order.qty ?? 0);
    setEditingOrderId(id);
    setEditPrice(p > 0 ? p.toFixed(2) : '');
    setEditQty(q > 0 ? String(q) : '');
    setActionMsg(null);
  };

  const cancelEdit = () => {
    setEditingOrderId(null);
    setEditPrice('');
    setEditQty('');
  };

  const submitModify = async (order: Record<string, unknown>) => {
    const id = getOrderId(order);
    const p = parseFloat(editPrice);
    const q = parseInt(editQty, 10);
    if (isNaN(p) || p <= 0) {
      setActionMsg({ type: 'error', text: 'Please enter a valid price > 0' });
      return;
    }
    if (isNaN(q) || q <= 0) {
      setActionMsg({ type: 'error', text: 'Please enter a valid quantity > 0' });
      return;
    }

    setActionLoadingId(id);
    setActionMsg(null);
    try {
      const res = await fetch('/api/scalper/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: id,
          price: p,
          quantity: q,
          orderType: String(order.orderType ?? order.order_type ?? 'LIMIT'),
          triggerPrice: Number(order.triggerPrice ?? order.trigger_price ?? 0),
          validity: String(order.validity ?? 'DAY'),
          legName: String(order.legName ?? 'ENTRY_LEG'),
          broker,
        }),
      });
      const j = await res.json() as { success: boolean; error?: string; detail?: string };
      if (j.success) {
        setActionMsg({ type: 'success', text: `Order ${id} modified to ₹${p.toFixed(2)} (${q} qty)` });
        setEditingOrderId(null);
        onRefresh();
      } else {
        setActionMsg({ type: 'error', text: j.detail || j.error || 'Failed to modify order' });
      }
    } catch (err) {
      setActionMsg({ type: 'error', text: (err as Error).message });
    } finally {
      setActionLoadingId(null);
    }
  };

  const cancelOrder = async (order: Record<string, unknown>) => {
    const id = getOrderId(order);
    const sym = String(order.tradingSymbol ?? order.symbol ?? id);
    if (!confirm(`Cancel pending order for ${sym}?`)) return;

    setActionLoadingId(id);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(id)}&broker=${encodeURIComponent(broker)}`, {
        method: 'DELETE',
      });
      const j = await res.json() as { success: boolean; error?: string; detail?: string };
      if (j.success) {
        setActionMsg({ type: 'success', text: `Order ${id} cancelled successfully` });
        onRefresh();
      } else {
        setActionMsg({ type: 'error', text: j.detail || j.error || 'Failed to cancel order' });
      }
    } catch (err) {
      setActionMsg({ type: 'error', text: (err as Error).message });
    } finally {
      setActionLoadingId(null);
    }
  };

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

  const sortedOrders = useMemo(() => {
    if (ordersTab !== 'orders') return [];
    return sortRows(filteredData, tableSort);
  }, [ordersTab, filteredData, tableSort]);

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
              Modify pending limit orders or track fills in real-time
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

        {/* Action Status Feedback Banner */}
        {actionMsg && (
          <div
            className={`px-3 py-2 rounded-lg text-xs font-medium flex items-center justify-between gap-2 border shrink-0 ${
              actionMsg.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
            }`}
          >
            <div className="flex items-center gap-2">
              {actionMsg.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <span>{actionMsg.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setActionMsg(null)}
              className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

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
          ) : ordersTab === 'trades' ? (
            <TabTable
              tab="trades"
              data={filteredData}
              sort={tableSort}
              onSort={handleTableSort}
            />
          ) : (
            /* Enhanced Interactive Orders Table with Pending Order Price Modification */
            <table className="w-full text-xs text-left border-collapse">
              <thead className="sticky top-0 bg-zinc-800 z-10">
                <tr>
                  <SortableTH sortKey="tradingSymbol" currentSort={tableSort} onSort={handleTableSort}>Symbol</SortableTH>
                  <SortableTH sortKey="orderStatus" currentSort={tableSort} onSort={handleTableSort}>Status</SortableTH>
                  <SortableTH sortKey="transactionType" currentSort={tableSort} onSort={handleTableSort}>Side</SortableTH>
                  <SortableTH sortKey="quantity" currentSort={tableSort} onSort={handleTableSort} align="right">Qty</SortableTH>
                  <SortableTH sortKey="price" currentSort={tableSort} onSort={handleTableSort} align="right">Price ₹</SortableTH>
                  <SortableTH sortKey="orderType" currentSort={tableSort} onSort={handleTableSort}>Type</SortableTH>
                  <SortableTH sortKey="createTime" currentSort={tableSort} onSort={handleTableSort}>Time</SortableTH>
                  <th className="px-3 py-2.5 text-xs font-bold text-white text-center whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {sortedOrders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-zinc-500">
                      No orders found
                    </td>
                  </tr>
                ) : (
                  sortedOrders.map((row, idx) => {
                    const id = getOrderId(row) || `order-${idx}`;
                    const sym = String(row.tradingSymbol ?? row.symbol ?? '—');
                    const statusStr = String(row.orderStatus ?? row.status ?? '—');
                    const isPending = isOrderPending(statusStr);
                    const isEditing = editingOrderId === id;
                    const side = String(row.transactionType ?? row.side ?? '').toUpperCase();
                    const qty = Number(row.quantity ?? row.qty ?? 0);
                    const price = Number(row.price ?? 0);
                    const orderType = String(row.orderType ?? row.order_type ?? '—');
                    const time = String(row.createTime ?? row.exchangeTime ?? row.order_timestamp ?? '—');

                    return (
                      <tr
                        key={id}
                        className={`hover:bg-zinc-800/30 transition-colors ${
                          isEditing ? 'bg-sky-950/20' : isPending ? 'bg-amber-950/10' : ''
                        }`}
                      >
                        {/* Symbol */}
                        <td className="px-3 py-2 font-mono text-zinc-200 whitespace-nowrap">
                          {sym}
                        </td>

                        {/* Status Badge */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                              isPending
                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse'
                                : statusStr === 'TRADED' || statusStr === 'COMPLETE'
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : statusStr === 'REJECTED'
                                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                            }`}
                          >
                            {statusStr}
                          </span>
                        </td>

                        {/* Side */}
                        <td className="px-3 py-2 whitespace-nowrap font-bold">
                          <span className={side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>
                            {side || '—'}
                          </span>
                        </td>

                        {/* Qty */}
                        <td className="px-3 py-2 text-right font-mono text-zinc-200 whitespace-nowrap">
                          {isEditing ? (
                            <input
                              type="number"
                              min={1}
                              value={editQty}
                              onChange={e => setEditQty(e.target.value)}
                              className="w-16 bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-xs rounded px-1.5 py-0.5 text-right focus:outline-none focus:border-sky-500"
                              title="Modify quantity"
                            />
                          ) : (
                            qty
                          )}
                        </td>

                        {/* Price (Editable for pending orders) */}
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {isEditing ? (
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  setEditPrice(prev => {
                                    const v = Math.max(0.05, (parseFloat(prev) || 0) - 0.05);
                                    return v.toFixed(2);
                                  })
                                }
                                className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-xs cursor-pointer"
                                title="Decrease price by 0.05"
                              >
                                −
                              </button>
                              <input
                                type="number"
                                step="0.05"
                                value={editPrice}
                                onChange={e => setEditPrice(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') submitModify(row);
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                autoFocus
                                className="w-20 bg-zinc-950 border border-sky-500 text-zinc-100 font-mono text-xs rounded px-2 py-0.5 text-right focus:outline-none"
                                title="Press Enter to submit modification"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setEditPrice(prev => {
                                    const v = (parseFloat(prev) || 0) + 0.05;
                                    return v.toFixed(2);
                                  })
                                }
                                className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-xs cursor-pointer"
                                title="Increase price by 0.05"
                              >
                                +
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 justify-end">
                              <span className="font-mono text-zinc-200 font-semibold tabular-nums">
                                {price > 0 ? `₹${price.toFixed(2)}` : 'MKT'}
                              </span>
                              {isPending && (
                                <button
                                  type="button"
                                  onClick={() => startEdit(row)}
                                  className="p-1 rounded text-zinc-400 hover:text-sky-400 hover:bg-zinc-800 transition-colors cursor-pointer"
                                  title="Click to edit limit price"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Type */}
                        <td className="px-3 py-2 font-mono text-zinc-400 whitespace-nowrap">
                          {orderType}
                        </td>

                        {/* Time */}
                        <td className="px-3 py-2 font-mono text-zinc-400 whitespace-nowrap">
                          {time}
                        </td>

                        {/* Actions */}
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          {isEditing ? (
                            <div className="flex items-center gap-1.5 justify-center">
                              <button
                                type="button"
                                onClick={() => submitModify(row)}
                                disabled={actionLoadingId === id}
                                className="px-2.5 py-1 text-[11px] font-bold rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1 cursor-pointer disabled:opacity-50 transition-colors"
                                title="Submit price change to broker"
                              >
                                {actionLoadingId === id ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Check className="w-3 h-3" />
                                )}
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                disabled={actionLoadingId === id}
                                className="px-2 py-1 text-[11px] font-semibold rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white cursor-pointer transition-colors"
                                title="Cancel editing"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ) : isPending ? (
                            <div className="flex items-center gap-1.5 justify-center">
                              <button
                                type="button"
                                onClick={() => startEdit(row)}
                                className="px-2 py-0.5 text-[11px] font-bold rounded border border-sky-500/40 text-sky-400 hover:bg-sky-500/10 transition-colors flex items-center gap-1 cursor-pointer"
                                title="Modify pending order price"
                              >
                                <Pencil className="w-3 h-3" />
                                Edit Price
                              </button>
                              <button
                                type="button"
                                onClick={() => cancelOrder(row)}
                                disabled={actionLoadingId === id}
                                className="px-2 py-0.5 text-[11px] font-bold rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                title="Cancel pending order"
                              >
                                {actionLoadingId === id ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3 h-3" />
                                )}
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

