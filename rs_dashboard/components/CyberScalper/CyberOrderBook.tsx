'use client';

import React, { useState, useRef } from 'react';
import { ListOrdered, Pencil, Check, X as XIcon, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cyberAudio } from '@/lib/cyberAudio';

export interface OrderBookRow {
  orderId: string;
  tradingSymbol: string;
  orderStatus: string;
  transactionType: string; // 'BUY' | 'SELL'
  quantity: number;
  price: number;
  orderType: string; // 'LIMIT' | 'MARKET'
  createTime: string;
}

// Orders in one of these states are done — nothing left to edit or cancel.
// Anything else (Dhan's PENDING/TRANSIT, Kotak's open/pending spellings) is
// treated as live, since the broker vocabulary isn't identical and a false
// negative here (hiding a genuinely live order) is worse than a false
// positive (showing action buttons on an order that's about to settle).
const TERMINAL_STATUSES = new Set(['COMPLETE', 'TRADED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED']);

function isLive(status: string): boolean {
  return !TERMINAL_STATUSES.has(status.toUpperCase());
}

interface CyberOrderBookProps {
  orders: OrderBookRow[];
  isExecuting: boolean;
  onCancelOrder: (orderId: string) => Promise<void>;
  onModifyOrder: (orderId: string, price: number, quantity: number) => Promise<void>;
}

export default function CyberOrderBook({ orders, isExecuting, onCancelOrder, onModifyOrder }: CyberOrderBookProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftPrice, setDraftPrice] = useState('');
  const [draftQty, setDraftQty] = useState('');
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const savingRef = useRef(false);

  const liveOrders = orders.filter((o) => isLive(o.orderStatus));

  const startEdit = (row: OrderBookRow) => {
    cyberAudio.click();
    setEditingId(row.orderId);
    setDraftPrice(String(row.price));
    setDraftQty(String(row.quantity));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftPrice('');
    setDraftQty('');
  };

  const saveEdit = async (row: OrderBookRow) => {
    const price = parseFloat(draftPrice);
    const qty = parseInt(draftQty, 10);
    if (!(price > 0) || !(qty > 0) || savingRef.current) return;
    savingRef.current = true;
    try {
      await onModifyOrder(row.orderId, price, qty);
      cancelEdit();
    } finally {
      savingRef.current = false;
    }
  };

  const confirmCancel = async (orderId: string) => {
    setCancelConfirmId(null);
    cyberAudio.exit();
    await onCancelOrder(orderId);
  };

  if (liveOrders.length === 0) return null;

  return (
    <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-xl p-3 lg:p-4 backdrop-blur-md shadow-xl">
      <div className="flex items-center gap-2 pb-2 mb-2 border-b border-zinc-800">
        <div className="p-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
          <ListOrdered className="w-3.5 h-3.5" />
        </div>
        <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
          Order Book
        </h3>
        <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-cyan-500/30 text-cyan-200">
          {liveOrders.length}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead>
            <tr className="border-b border-zinc-700 bg-zinc-800 text-[11px] font-bold text-white uppercase tracking-wider">
              <th className="py-2 px-3">Contract</th>
              <th className="py-2 px-2">Side</th>
              <th className="py-2 px-2 text-right">Qty</th>
              <th className="py-2 px-2 text-right">Price</th>
              <th className="py-2 px-2">Type</th>
              <th className="py-2 px-2">Status</th>
              <th className="py-2 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {liveOrders.map((row) => {
              const isBuy = row.transactionType.toUpperCase() === 'BUY';
              const isEditing = editingId === row.orderId;
              const isLimit = row.orderType.toUpperCase() === 'LIMIT';

              return (
                <tr key={row.orderId} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="py-2 px-3 text-white font-bold whitespace-nowrap">{row.tradingSymbol}</td>
                  <td className="py-2 px-2">
                    <span
                      className={cn(
                        'px-2 py-0.5 rounded text-[10px] font-bold tracking-wide',
                        isBuy
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      )}
                    >
                      {row.transactionType.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right">
                    {isEditing ? (
                      <input
                        type="number"
                        value={draftQty}
                        onChange={(e) => setDraftQty(e.target.value)}
                        className="w-16 py-0.5 px-1 text-center rounded bg-zinc-950 border border-cyan-500/60 text-white text-xs focus:outline-none"
                      />
                    ) : (
                      <span className="text-zinc-200 font-bold tabular-nums">{row.quantity}</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right">
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.05"
                        value={draftPrice}
                        onChange={(e) => setDraftPrice(e.target.value)}
                        className="w-20 py-0.5 px-1 text-center rounded bg-zinc-950 border border-cyan-500/60 text-white text-xs focus:outline-none"
                      />
                    ) : (
                      <span className="text-zinc-200 font-bold tabular-nums">₹{row.price.toFixed(2)}</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-zinc-400">{row.orderType.toUpperCase()}</td>
                  <td className="py-2 px-2">
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                      {row.orderStatus.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">
                    {isEditing ? (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => saveEdit(row)}
                          disabled={isExecuting}
                          className="p-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-all active:scale-95 disabled:opacity-50"
                          title="Save changes"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-all active:scale-95"
                          title="Discard changes"
                        >
                          <XIcon className="w-3 h-3" />
                        </button>
                      </div>
                    ) : cancelConfirmId === row.orderId ? (
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-[10px] text-rose-400 mr-1">Cancel order?</span>
                        <button
                          onClick={() => confirmCancel(row.orderId)}
                          disabled={isExecuting}
                          className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50"
                        >
                          YES
                        </button>
                        <button
                          onClick={() => setCancelConfirmId(null)}
                          className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-bold transition-all active:scale-95"
                        >
                          NO
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        {isLimit && (
                          <button
                            onClick={() => startEdit(row)}
                            disabled={isExecuting}
                            className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-cyan-500/20 hover:text-cyan-400 hover:border-cyan-500/50 border border-zinc-700 text-zinc-300 text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                            title="Edit price/quantity"
                          >
                            <Pencil className="w-3 h-3" />
                            EDIT
                          </button>
                        )}
                        <button
                          onClick={() => setCancelConfirmId(row.orderId)}
                          disabled={isExecuting}
                          className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-500/50 border border-zinc-700 text-zinc-300 text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                          title="Cancel order"
                        >
                          <Ban className="w-3 h-3" />
                          CANCEL
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
