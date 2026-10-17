'use client';

import React, { useState, useMemo } from 'react';
import { toast } from 'sonner';
import {
  X,
  ShieldCheck,
  ListOrdered,
  FileText,
  RefreshCw,
  Pencil,
  Trash2,
  Check,
  Search,
  Maximize2,
  AlertCircle,
  TrendingDown,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { legPnl, type BreakdownPosition } from '@/lib/breakdownLedger';

export interface PositionsTableProps {
  positions: BreakdownPosition[];
  quotes: Record<string, { ltp?: number | null }>;
  onClosePosition: (id: string, currentLtp: number) => void;
  // Broker Order Book, Trade Book & Positions
  broker: 'dhan' | 'kotak';
  ordersData: Record<string, unknown>[];
  tradesData: Record<string, unknown>[];
  brokerPositionsData: Record<string, unknown>[];
  isBookLoading: boolean;
  bookError: string | null;
  onRefreshBook: () => void;
  onOpenBookModal: () => void;
}

type MainTab = 'positions' | 'orderbook' | 'tradebook';

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

export function PositionsTable({
  positions,
  quotes,
  onClosePosition,
  broker,
  ordersData,
  tradesData,
  brokerPositionsData,
  isBookLoading,
  bookError,
  onRefreshBook,
  onOpenBookModal,
}: PositionsTableProps) {
  const [mainTab, setMainTab] = useState<MainTab>('positions');
  const [positionsSubTab, setPositionsSubTab] = useState<'STRATEGY_OPEN' | 'STRATEGY_CLOSED' | 'BROKER_NET'>('STRATEGY_OPEN');
  const [filterText, setFilterText] = useState('');

  // Inline order editing state for pending orders
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState<string>('');
  const [editQty, setEditQty] = useState<string>('');
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const openStrategyPositions = useMemo(() => positions.filter((p) => p.status === 'OPEN'), [positions]);
  const closedStrategyPositions = useMemo(() => positions.filter((p) => p.status === 'CLOSED'), [positions]);

  const pendingOrdersCount = useMemo(() => {
    return ordersData.filter((o) => isOrderPending(o.orderStatus ?? o.status)).length;
  }, [ordersData]);

  // Formatter helpers
  const formatMoney = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return '—';
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
  };

  const formatPct = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
  };

  const pnlColor = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return 'text-zinc-500';
    return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
  };

  // ── Inline Order Modification ────────────────────────────────────
  const startEditOrder = (order: Record<string, unknown>) => {
    const id = getOrderId(order);
    const p = Number(order.price ?? 0);
    const q = Number(order.quantity ?? order.qty ?? 0);
    setEditingOrderId(id);
    setEditPrice(p > 0 ? p.toFixed(2) : '');
    setEditQty(q > 0 ? String(q) : '');
  };

  const cancelEditOrder = () => {
    setEditingOrderId(null);
    setEditPrice('');
    setEditQty('');
  };

  const submitModifyOrder = async (order: Record<string, unknown>) => {
    const id = getOrderId(order);
    const p = parseFloat(editPrice);
    const q = parseInt(editQty, 10);
    if (isNaN(p) || p <= 0) {
      toast.error('Please enter a valid price > 0');
      return;
    }
    if (isNaN(q) || q <= 0) {
      toast.error('Please enter a valid quantity > 0');
      return;
    }

    setActionLoadingId(id);
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
      const j = (await res.json()) as { success: boolean; error?: string; detail?: string };
      if (j.success) {
        toast.success(`Order ${id} modified to ₹${p.toFixed(2)} (${q} qty)`);
        setEditingOrderId(null);
        onRefreshBook();
      } else {
        toast.error(j.detail || j.error || 'Failed to modify order');
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActionLoadingId(null);
    }
  };

  const cancelOrder = async (order: Record<string, unknown>) => {
    const id = getOrderId(order);
    const sym = String(order.tradingSymbol ?? order.symbol ?? id);
    if (!confirm(`Cancel pending order for ${sym}?`)) return;

    setActionLoadingId(id);
    try {
      const res = await fetch(
        `/api/scalper/orders?orderId=${encodeURIComponent(id)}&broker=${encodeURIComponent(broker)}`,
        { method: 'DELETE' },
      );
      const j = (await res.json()) as { success: boolean; error?: string; detail?: string };
      if (j.success) {
        toast.success(`Order ${id} cancelled successfully`);
        onRefreshBook();
      } else {
        toast.error(j.detail || j.error || 'Failed to cancel order');
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActionLoadingId(null);
    }
  };

  // Filtered lists
  const filteredOrders = useMemo(() => {
    if (!filterText.trim()) return ordersData;
    const q = filterText.trim().toLowerCase();
    return ordersData.filter((row) => {
      const sym = String(row.tradingSymbol ?? row.symbol ?? '').toLowerCase();
      const status = String(row.orderStatus ?? row.status ?? '').toLowerCase();
      const side = String(row.transactionType ?? row.side ?? '').toLowerCase();
      const id = getOrderId(row).toLowerCase();
      return sym.includes(q) || status.includes(q) || side.includes(q) || id.includes(q);
    });
  }, [ordersData, filterText]);

  const filteredTrades = useMemo(() => {
    if (!filterText.trim()) return tradesData;
    const q = filterText.trim().toLowerCase();
    return tradesData.filter((row) => {
      const sym = String(row.tradingSymbol ?? row.symbol ?? '').toLowerCase();
      const side = String(row.transactionType ?? row.side ?? '').toLowerCase();
      const id = String(row.tradeId ?? row.orderId ?? '').toLowerCase();
      return sym.includes(q) || side.includes(q) || id.includes(q);
    });
  }, [tradesData, filterText]);

  const filteredBrokerPositions = useMemo(() => {
    if (!filterText.trim()) return brokerPositionsData;
    const q = filterText.trim().toLowerCase();
    return brokerPositionsData.filter((row) => {
      const sym = String(row.tradingSymbol ?? row.symbol ?? '').toLowerCase();
      return sym.includes(q);
    });
  }, [brokerPositionsData, filterText]);

  return (
    <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/70 backdrop-blur">
      {/* Top Header Strip with Primary Tabs */}
      <div className="flex flex-wrap items-center justify-between border-b border-zinc-800 px-4 py-3 gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Layers className="h-4 w-4 text-emerald-400" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-white">
              Trades &amp; Orders Desk
            </h2>
          </div>

          {/* Primary Navigation Tabs */}
          <div className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-0.5">
            <button
              type="button"
              onClick={() => setMainTab('positions')}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all',
                mainTab === 'positions'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/80'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              <span>Positions</span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.2 text-[10px] font-mono font-bold',
                  openStrategyPositions.length > 0
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-zinc-800 text-zinc-400',
                )}
              >
                {openStrategyPositions.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setMainTab('orderbook')}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all',
                mainTab === 'orderbook'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/80'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              <ListOrdered className="h-3.5 w-3.5 text-sky-400" />
              <span>Order Book</span>
              {pendingOrdersCount > 0 ? (
                <span className="rounded-full bg-amber-500/20 text-amber-400 px-1.5 py-0.2 text-[10px] font-mono font-bold animate-pulse">
                  {pendingOrdersCount} OPEN
                </span>
              ) : (
                <span className="rounded-full bg-zinc-800 text-zinc-400 px-1.5 py-0.2 text-[10px] font-mono font-bold">
                  {ordersData.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setMainTab('tradebook')}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all',
                mainTab === 'tradebook'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/80'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              <FileText className="h-3.5 w-3.5 text-teal-400" />
              <span>Trade Book</span>
              <span className="rounded-full bg-zinc-800 text-zinc-400 px-1.5 py-0.2 text-[10px] font-mono font-bold">
                {tradesData.length}
              </span>
            </button>
          </div>
        </div>

        {/* Right Action Tools: Filter, Refresh, Popout */}
        <div className="flex items-center gap-2 flex-wrap">
          {mainTab !== 'positions' && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Filter symbol / side / status…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className="h-7.5 w-48 sm:w-56 rounded-lg border border-zinc-800 bg-zinc-900/90 pl-8 pr-2.5 text-xs font-mono text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
              />
              {filterText && (
                <button
                  type="button"
                  onClick={() => setFilterText('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={onRefreshBook}
            disabled={isBookLoading}
            className="flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-zinc-800 bg-zinc-900 text-xs font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 transition disabled:opacity-50"
            title="Refresh order book, tradebook and positions from broker"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isBookLoading && 'animate-spin text-emerald-400')} />
            <span className="hidden sm:inline">Sync</span>
          </button>

          <button
            type="button"
            onClick={onOpenBookModal}
            className="flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-xs font-bold text-sky-400 hover:bg-sky-500/20 transition"
            title="Open Full Orders, Trades &amp; Positions Modal"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Full Book</span>
          </button>
        </div>
      </div>

      {/* Sub-Header for Positions Tab */}
      {mainTab === 'positions' && (
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2 bg-zinc-900/40 text-xs">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPositionsSubTab('STRATEGY_OPEN')}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-bold transition-all',
                positionsSubTab === 'STRATEGY_OPEN'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/60'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              ACTIVE BREAKDOWN LEGS ({openStrategyPositions.length})
            </button>
            <button
              type="button"
              onClick={() => setPositionsSubTab('STRATEGY_CLOSED')}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-bold transition-all',
                positionsSubTab === 'STRATEGY_CLOSED'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/60'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              CLOSED LEGS ({closedStrategyPositions.length})
            </button>
            <button
              type="button"
              onClick={() => setPositionsSubTab('BROKER_NET')}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-bold transition-all',
                positionsSubTab === 'BROKER_NET'
                  ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/60'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              BROKER NET POSITIONS ({brokerPositionsData.length})
            </button>
          </div>

          {positionsSubTab === 'STRATEGY_OPEN' && openStrategyPositions.length > 0 && (
            <p className="text-[11px] text-zinc-500 hidden md:inline">
              Trailing SL ratchets down automatically as premium falls (never loosens)
            </p>
          )}
        </div>
      )}

      {/* Book Error Notification */}
      {bookError && (
        <div className="mx-4 mt-3 p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-400 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>Broker sync warning: {bookError}</span>
          </div>
          <button type="button" onClick={onRefreshBook} className="underline font-bold">
            Retry
          </button>
        </div>
      )}

      {/* ── TAB 1: POSITIONS ───────────────────────────────────────── */}
      {mainTab === 'positions' && (
        <div className="overflow-x-auto">
          {positionsSubTab === 'STRATEGY_OPEN' ? (
            openStrategyPositions.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <ShieldCheck className="h-8 w-8 text-zinc-600 mb-2" />
                <p className="text-xs font-bold text-zinc-400">No active breakdown short positions</p>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  Eligible breakdown signals will be auto-shorted when Auto-Trader is active.
                </p>
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-800 bg-zinc-900/80 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5">Contract</th>
                    <th className="px-3 py-2.5">Mode / Broker</th>
                    <th className="px-3 py-2.5 text-right">Size</th>
                    <th className="px-3 py-2.5 text-right">Entry</th>
                    <th className="px-3 py-2.5 text-right">LTP</th>
                    <th className="px-3 py-2.5 text-right">Lowest</th>
                    <th className="px-3 py-2.5 text-right">Initial SL</th>
                    <th className="px-3 py-2.5 text-right">Trailing SL</th>
                    <th className="px-3 py-2.5 text-right">Target</th>
                    <th className="px-3 py-2.5 text-right">Floating P&amp;L</th>
                    <th className="px-4 py-2.5 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 font-medium text-zinc-200">
                  {openStrategyPositions.map((pos) => {
                    const key = `${pos.strike}${pos.option}`;
                    const quoteLtp = quotes[key]?.ltp ?? null;
                    const currentLtp = quoteLtp ?? pos.entryPrice;
                    const pnl = legPnl(pos, quoteLtp);
                    const pnlPct =
                      currentLtp > 0 ? ((pos.entryPrice - currentLtp) / pos.entryPrice) * 100 : 0;
                    const trailDistance = Number((pos.trailingSl - currentLtp).toFixed(1));

                    return (
                      <tr key={pos.id} className="hover:bg-zinc-900/40 transition-colors">
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[10px] font-extrabold',
                                pos.option === 'PE'
                                  ? 'bg-emerald-500/20 text-emerald-400'
                                  : 'bg-red-500/20 text-red-400',
                              )}
                            >
                              SHORT {pos.strike} {pos.option}
                            </span>
                            <span className="text-[10px] text-zinc-500 font-mono">
                              {pos.underlying}
                            </span>
                          </div>
                        </td>

                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <span
                              className={cn(
                                'rounded px-1 py-0.2 font-bold uppercase',
                                pos.mode === 'REAL' ? 'text-red-400' : 'text-emerald-400',
                              )}
                            >
                              {pos.mode}
                            </span>
                            <span className="text-zinc-500 uppercase">{pos.broker}</span>
                          </div>
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {pos.qty}{' '}
                          <span className="text-[10px] text-zinc-500">
                            ({pos.qty / pos.lotSize}L)
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-300 whitespace-nowrap">
                          ₹{pos.entryPrice.toFixed(1)}
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-white whitespace-nowrap">
                          ₹{currentLtp.toFixed(1)}
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-emerald-400/90 whitespace-nowrap">
                          ₹{pos.lowestPrice.toFixed(1)}
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-400 whitespace-nowrap">
                          ₹{pos.initialSl.toFixed(1)}
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                          <span
                            className={cn(
                              'font-bold',
                              pos.trailingSl < pos.entryPrice
                                ? 'text-emerald-400'
                                : 'text-amber-400',
                            )}
                          >
                            ₹{pos.trailingSl.toFixed(1)}
                          </span>
                          <span className="ml-1 text-[10px] text-zinc-500">
                            ({trailDistance >= 0 ? `+${trailDistance}` : trailDistance})
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-sky-400 whitespace-nowrap">
                          {pos.targetPrice ? `₹${pos.targetPrice.toFixed(1)}` : '—'}
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap font-bold">
                          <span className={pnlColor(pnl)}>{formatMoney(pnl)}</span>
                          <span className={cn('ml-1 text-[10px]', pnlColor(pnlPct))}>
                            ({formatPct(pnlPct)})
                          </span>
                        </td>

                        <td className="px-4 py-2.5 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onClosePosition(pos.id, currentLtp)}
                            className="inline-flex items-center gap-1 rounded bg-red-500/10 px-2.5 py-1 text-[10px] font-bold text-red-400 border border-red-500/20 hover:bg-red-500/20 transition"
                            title="Manually close this short leg"
                          >
                            <X className="h-3 w-3" />
                            <span>CLOSE</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : positionsSubTab === 'STRATEGY_CLOSED' ? (
            closedStrategyPositions.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <FileText className="h-8 w-8 text-zinc-600 mb-2" />
                <p className="text-xs font-bold text-zinc-400">No closed positions today</p>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  Completed trades and stop-loss exits will be cataloged here.
                </p>
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-800 bg-zinc-900/80 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5">Contract</th>
                    <th className="px-3 py-2.5">Mode</th>
                    <th className="px-3 py-2.5 text-right">Size</th>
                    <th className="px-3 py-2.5 text-right">Entry</th>
                    <th className="px-3 py-2.5 text-right">Exit</th>
                    <th className="px-3 py-2.5 text-right">Realized P&amp;L</th>
                    <th className="px-4 py-2.5">Exit Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 font-medium text-zinc-200">
                  {closedStrategyPositions.map((pos) => (
                    <tr key={pos.id} className="hover:bg-zinc-900/40 transition-colors">
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-bold',
                              pos.option === 'PE'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-red-500/10 text-red-400',
                            )}
                          >
                            SHORT {pos.strike} {pos.option}
                          </span>
                          <span className="text-[10px] text-zinc-500 font-mono">
                            {pos.underlying}
                          </span>
                        </div>
                      </td>

                      <td className="px-3 py-2.5 text-[10px] uppercase text-zinc-400 font-bold whitespace-nowrap">
                        {pos.mode}
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                        {pos.qty}
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-400 whitespace-nowrap">
                        ₹{pos.entryPrice.toFixed(1)}
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-white whitespace-nowrap">
                        ₹{pos.exitPrice?.toFixed(1) ?? '—'}
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold whitespace-nowrap">
                        <span className={pnlColor(pos.realized)}>{formatMoney(pos.realized)}</span>
                      </td>

                      <td className="px-4 py-2.5 text-[11px] text-zinc-400 whitespace-nowrap">
                        {pos.exitReason || 'Closed'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            /* Broker Net Positions */
            filteredBrokerPositions.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <ShieldCheck className="h-8 w-8 text-zinc-600 mb-2" />
                <p className="text-xs font-bold text-zinc-400">No broker positions found</p>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  Whole-account net positions from {broker.toUpperCase()} will appear here.
                </p>
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-800 bg-zinc-900/80 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5">Symbol</th>
                    <th className="px-3 py-2.5">Product</th>
                    <th className="px-3 py-2.5 text-right">Net Qty</th>
                    <th className="px-3 py-2.5 text-right">Buy Avg</th>
                    <th className="px-3 py-2.5 text-right">Sell Avg</th>
                    <th className="px-3 py-2.5 text-right">LTP</th>
                    <th className="px-3 py-2.5 text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 font-medium text-zinc-200">
                  {filteredBrokerPositions.map((row, idx) => {
                    const sym = String(row.tradingSymbol ?? row.symbol ?? `pos-${idx}`);
                    const netQty = Number(row.netQty ?? row.net_quantity ?? row.quantity ?? 0);
                    const product = String(row.productType ?? row.product ?? '—');
                    const buyAvg = Number(row.buyAvg ?? row.buy_avg ?? 0);
                    const sellAvg = Number(row.sellAvg ?? row.sell_avg ?? 0);
                    const ltp = Number(row.ltp ?? row.last_price ?? 0);
                    const pnl = Number(row.realizedProfit ?? row.pnl ?? row.unrealizedProfit ?? 0);

                    return (
                      <tr key={idx} className="hover:bg-zinc-900/40 transition-colors">
                        <td className="px-4 py-2.5 font-mono text-zinc-200 whitespace-nowrap">
                          {sym}
                        </td>
                        <td className="px-3 py-2.5 uppercase text-zinc-400 font-mono text-[11px] whitespace-nowrap">
                          {product}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold whitespace-nowrap">
                          <span
                            className={
                              netQty > 0
                                ? 'text-emerald-400'
                                : netQty < 0
                                ? 'text-rose-400'
                                : 'text-zinc-500'
                            }
                          >
                            {netQty}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-400 whitespace-nowrap">
                          {buyAvg > 0 ? `₹${buyAvg.toFixed(2)}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-400 whitespace-nowrap">
                          {sellAvg > 0 ? `₹${sellAvg.toFixed(2)}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-white whitespace-nowrap">
                          ₹{ltp.toFixed(2)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold whitespace-nowrap">
                          <span className={pnlColor(pnl)}>{formatMoney(pnl)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
        </div>
      )}

      {/* ── TAB 2: ORDER BOOK ──────────────────────────────────────── */}
      {mainTab === 'orderbook' && (
        <div className="overflow-x-auto">
          {filteredOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <ListOrdered className="h-8 w-8 text-zinc-600 mb-2" />
              <p className="text-xs font-bold text-zinc-400">No orders found</p>
              <p className="text-[11px] text-zinc-600 mt-0.5">
                Orders placed through auto-scalper or broker will be tracked here.
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800 bg-zinc-900/80 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5">Order ID</th>
                  <th className="px-3 py-2.5">Contract / Symbol</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Side</th>
                  <th className="px-3 py-2.5 text-right">Quantity</th>
                  <th className="px-3 py-2.5 text-right">Price</th>
                  <th className="px-3 py-2.5">Type</th>
                  <th className="px-3 py-2.5">Time</th>
                  <th className="px-4 py-2.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 font-medium text-zinc-200">
                {filteredOrders.map((row, idx) => {
                  const id = getOrderId(row) || `order-${idx}`;
                  const sym = String(row.tradingSymbol ?? row.symbol ?? '—');
                  const statusStr = String(row.orderStatus ?? row.status ?? '—').toUpperCase();
                  const isPending = isOrderPending(statusStr);
                  const isEditing = editingOrderId === id;
                  const side = String(row.transactionType ?? row.side ?? '').toUpperCase();
                  const qty = Number(row.quantity ?? row.qty ?? 0);
                  const price = Number(row.price ?? 0);
                  const orderType = String(row.orderType ?? row.order_type ?? '—');
                  const time = String(
                    row.createTime ?? row.exchangeTime ?? row.order_timestamp ?? '—',
                  );

                  return (
                    <tr
                      key={id}
                      className={cn(
                        'hover:bg-zinc-900/40 transition-colors',
                        isEditing
                          ? 'bg-sky-950/20'
                          : isPending
                          ? 'bg-amber-950/10'
                          : '',
                      )}
                    >
                      <td className="px-4 py-2.5 font-mono text-zinc-400 text-[11px] whitespace-nowrap">
                        {id}
                      </td>

                      <td className="px-3 py-2.5 font-mono text-white font-bold whitespace-nowrap">
                        {sym}
                      </td>

                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span
                          className={cn(
                            'px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
                            isPending
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse'
                              : statusStr === 'TRADED' || statusStr === 'COMPLETE'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : statusStr === 'REJECTED'
                              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                              : 'bg-zinc-800 text-zinc-400 border border-zinc-700',
                          )}
                        >
                          {statusStr}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 whitespace-nowrap font-bold">
                        <span className={side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>
                          {side || '—'}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                        {isEditing ? (
                          <input
                            type="number"
                            min={1}
                            value={editQty}
                            onChange={(e) => setEditQty(e.target.value)}
                            className="w-16 bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-xs rounded px-1.5 py-0.5 text-right focus:outline-none focus:border-sky-500"
                          />
                        ) : (
                          qty
                        )}
                      </td>

                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {isEditing ? (
                          <div className="flex items-center gap-1 justify-end">
                            <input
                              type="number"
                              step="0.05"
                              value={editPrice}
                              onChange={(e) => setEditPrice(e.target.value)}
                              className="w-20 bg-zinc-950 border border-sky-500 text-sky-300 font-mono text-xs rounded px-1.5 py-0.5 text-right focus:outline-none"
                            />
                          </div>
                        ) : (
                          <span className="font-mono tabular-nums text-zinc-200">
                            {price > 0 ? `₹${price.toFixed(2)}` : 'MKT'}
                          </span>
                        )}
                      </td>

                      <td className="px-3 py-2.5 font-mono text-zinc-400 uppercase text-[11px] whitespace-nowrap">
                        {orderType}
                      </td>

                      <td className="px-3 py-2.5 font-mono text-zinc-500 text-[11px] whitespace-nowrap">
                        {time}
                      </td>

                      <td className="px-4 py-2.5 text-center whitespace-nowrap">
                        {isEditing ? (
                          <div className="flex items-center gap-1.5 justify-center">
                            <button
                              type="button"
                              onClick={() => submitModifyOrder(row)}
                              disabled={actionLoadingId === id}
                              className="px-2 py-0.5 text-[10px] font-bold rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1 disabled:opacity-50 transition"
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
                              onClick={cancelEditOrder}
                              disabled={actionLoadingId === id}
                              className="px-2 py-0.5 text-[10px] font-semibold rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : isPending ? (
                          <div className="flex items-center gap-1.5 justify-center">
                            <button
                              type="button"
                              onClick={() => startEditOrder(row)}
                              className="px-2 py-0.5 text-[10px] font-bold rounded border border-sky-500/40 text-sky-400 hover:bg-sky-500/10 transition flex items-center gap-1"
                              title="Modify order price &amp; qty"
                            >
                              <Pencil className="w-3 h-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelOrder(row)}
                              disabled={actionLoadingId === id}
                              className="px-2 py-0.5 text-[10px] font-bold rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 transition flex items-center gap-1 disabled:opacity-50"
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
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TAB 3: TRADE BOOK ──────────────────────────────────────── */}
      {mainTab === 'tradebook' && (
        <div className="overflow-x-auto">
          {filteredTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <FileText className="h-8 w-8 text-zinc-600 mb-2" />
              <p className="text-xs font-bold text-zinc-400">No executed trades today</p>
              <p className="text-[11px] text-zinc-600 mt-0.5">
                Every completed buy or sell fill will be cataloged here with execution prices.
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800 bg-zinc-900/80 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5">Trade ID</th>
                  <th className="px-3 py-2.5">Order ID</th>
                  <th className="px-3 py-2.5">Contract / Symbol</th>
                  <th className="px-3 py-2.5">Side</th>
                  <th className="px-3 py-2.5 text-right">Executed Qty</th>
                  <th className="px-3 py-2.5 text-right">Traded Price</th>
                  <th className="px-3 py-2.5 text-right">Turnover</th>
                  <th className="px-4 py-2.5">Execution Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 font-medium text-zinc-200">
                {filteredTrades.map((row, idx) => {
                  const tradeId = String(row.tradeId ?? row.nTrdNo ?? `trd-${idx}`);
                  const orderId = String(row.orderId ?? row.nOrdNo ?? '—');
                  const sym = String(row.tradingSymbol ?? row.symbol ?? '—');
                  const side = String(row.transactionType ?? row.side ?? '').toUpperCase();
                  const qty = Number(row.tradedQuantity ?? row.quantity ?? row.qty ?? 0);
                  const price = Number(row.tradedPrice ?? row.price ?? 0);
                  const turnover = qty * price;
                  const time = String(
                    row.exchangeTime ?? row.createTime ?? row.order_timestamp ?? '—',
                  );

                  return (
                    <tr key={tradeId} className="hover:bg-zinc-900/40 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-zinc-400 text-[11px] whitespace-nowrap">
                        {tradeId}
                      </td>

                      <td className="px-3 py-2.5 font-mono text-zinc-500 text-[11px] whitespace-nowrap">
                        {orderId}
                      </td>

                      <td className="px-3 py-2.5 font-mono text-white font-bold whitespace-nowrap">
                        {sym}
                      </td>

                      <td className="px-3 py-2.5 whitespace-nowrap font-bold">
                        <span className={side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>
                          {side || '—'}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-white whitespace-nowrap font-bold">
                        {qty}
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-200 whitespace-nowrap">
                        ₹{price.toFixed(2)}
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-400 whitespace-nowrap">
                        ₹{Math.round(turnover).toLocaleString('en-IN')}
                      </td>

                      <td className="px-4 py-2.5 font-mono text-zinc-500 text-[11px] whitespace-nowrap">
                        {time}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
