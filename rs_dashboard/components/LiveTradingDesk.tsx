'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Layers, ListOrdered, Loader2, Ban, Pencil, Check, XCircle } from 'lucide-react';
import { scaleBrokerPnl, contractMultiplier } from '@/lib/positionPnl';
import {
  type LedgerBasket,
  type BrokerPositionRow,
  findBrokerRow,
  liveLegQty,
  legUnrealizedPnl,
  reconcileBasket,
  basketIsFlat,
} from '@/lib/liveChartsLedger';

const POSITIONS_POLL_MS = 3000;
const ORDERS_POLL_MS = 3000;

const TERMINAL_ORDER_STATUSES = new Set(['COMPLETE', 'TRADED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED']);

interface OrderRow {
  orderId: string;
  securityId: string;
  tradingSymbol: string;
  orderStatus: string;
  transactionType: string;
  quantity: number;
  price: number;
  orderType: string;
  createTime: string;
}

function fmtRupee(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

interface LiveTradingDeskProps {
  baskets: LedgerBasket[];
  onBasketsChange: (baskets: LedgerBasket[]) => void;
  onClose: () => void;
}

export default function LiveTradingDesk({ baskets, onBasketsChange, onClose }: LiveTradingDeskProps) {
  const [positions, setPositions] = useState<BrokerPositionRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [exitingLegKey, setExitingLegKey] = useState<string | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [draftPrice, setDraftPrice] = useState('');
  const [draftQty, setDraftQty] = useState('');
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const basketsRef = useRef(baskets);
  useEffect(() => {
    basketsRef.current = baskets;
  }, [baskets]);

  // Positions poll - clamps every ledger leg's qty down to what the broker actually still
  // shows (never up, per dhan-terminal-position-ownership). Deliberately raw (not the shared
  // brokerPositionsCache) because the Exit button below sizes real orders off this same read.
  const seqRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const seq = ++seqRef.current;
      try {
        const res = await fetch('/api/scalper/positions');
        const json = await res.json();
        if (cancelled || seq !== seqRef.current) return;
        if (json.success && Array.isArray(json.data)) {
          const scaled = (json.data as BrokerPositionRow[]).map((row) => scaleBrokerPnl(row, contractMultiplier(row)));
          setPositions(scaled);
          const current = basketsRef.current;
          if (current.length > 0) {
            const reconciled = current.map((b) => reconcileBasket(b, scaled));
            const changed = reconciled.some((b, i) => JSON.stringify(b) !== JSON.stringify(current[i]));
            if (changed) onBasketsChange(reconciled);
          }
        }
      } catch {
        // Transient network/broker error - leave positions/ledger as last known.
      }
    }
    poll();
    const id = setInterval(poll, POSITIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Order book poll - filters down to orders for security IDs this page's own baskets track,
  // so the panel doesn't show unrelated orders from Scalper/strategies/manual trades.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/scalper/orders');
        const json = await res.json();
        if (cancelled) return;
        if (json.success && Array.isArray(json.data)) {
          const trackedSecIds = new Set(
            basketsRef.current.flatMap((b) => b.legs.map((l) => String(l.securityId)))
          );
          const rows: OrderRow[] = (json.data as Record<string, unknown>[])
            .filter((o) => trackedSecIds.has(String(o.securityId)))
            .map((o) => ({
              orderId: String(o.orderId ?? ''),
              securityId: String(o.securityId ?? ''),
              tradingSymbol: String(o.tradingSymbol ?? ''),
              orderStatus: String(o.orderStatus ?? ''),
              transactionType: String(o.transactionType ?? ''),
              quantity: Number(o.quantity ?? 0),
              price: Number(o.price ?? 0),
              orderType: String(o.orderType ?? ''),
              createTime: String(o.createTime ?? ''),
            }));
          setOrders(rows);
        }
      } catch {
        // Transient error - keep showing the last known order book.
      }
    }
    poll();
    const id = setInterval(poll, ORDERS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const handleExitLeg = useCallback(
    async (basket: LedgerBasket, legIdx: number) => {
      const leg = basket.legs[legIdx];
      const key = `${basket.id}:${legIdx}`;
      setExitingLegKey(key);
      try {
        // Fetch live positions right here rather than trusting the background poll's
        // `positions` state (up to POSITIONS_POLL_MS stale) - the same reasoning as
        // Scalper.tsx's closePosition ("avoids acting on stale data"). Sizing an exit off
        // a stale snapshot that's since shrunk would place too large an order and flip the
        // leg to the opposite side instead of just closing it, since these are plain orders
        // with no reduce-only flag.
        let freshRow: BrokerPositionRow | null = null;
        try {
          const posRes = await fetch('/api/scalper/positions');
          const posJson = await posRes.json();
          if (posJson.success && Array.isArray(posJson.data)) {
            const scaled = (posJson.data as BrokerPositionRow[]).map((r) => scaleBrokerPnl(r, contractMultiplier(r)));
            freshRow = findBrokerRow(scaled, leg);
          }
        } catch {
          // Fall back to the last polled snapshot below rather than refusing to exit outright.
        }
        const row = freshRow ?? findBrokerRow(positions, leg);
        const exitQty = liveLegQty(row, leg);
        if (exitQty <= 0) return;

        const res = await fetch('/api/options/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            legs: [{
              securityId: leg.securityId,
              quantity: exitQty,
              side: leg.action === 'BUY' ? 'SELL' : 'BUY',
              orderType: 'MARKET',
              exchangeSegment: leg.exchangeSegment,
            }],
            mode: leg.productType === 'MARGIN' ? 'positional' : 'intraday',
          }),
        });
        const json = await res.json();
        const orderId = json?.data?.[0]?.orderId;
        if (json.success && orderId) {
          const updated = basketsRef.current.map((b) => {
            if (b.id !== basket.id) return b;
            return {
              ...b,
              legs: b.legs.map((l, i) =>
                i === legIdx
                  ? {
                      ...l,
                      qty: Math.max(0, l.qty - exitQty),
                      exitOrderIds: [...l.exitOrderIds, String(orderId)],
                      lastOrderAt: Date.now(),
                    }
                  : l
              ),
            };
          });
          onBasketsChange(updated);
        }
      } catch {
        // Network failure - leg qty left untouched, position poll will reconcile on next tick.
      } finally {
        setExitingLegKey(null);
      }
    },
    [positions, onBasketsChange]
  );

  const handleExitBasket = useCallback(
    async (basket: LedgerBasket) => {
      for (let i = 0; i < basket.legs.length; i++) {
        if (basket.legs[i].qty > 0) {
          await handleExitLeg(basket, i);
        }
      }
    },
    [handleExitLeg]
  );

  const handleCancelOrder = useCallback(async (orderId: string) => {
    setCancelConfirmId(null);
    try {
      await fetch('/api/scalper/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, broker: 'dhan' }),
      });
    } catch {
      // Order book poll will reflect the real state on its next tick regardless.
    }
  }, []);

  const startEditOrder = (row: OrderRow) => {
    setEditingOrderId(row.orderId);
    setDraftPrice(String(row.price));
    setDraftQty(String(row.quantity));
  };

  const saveEditOrder = async (row: OrderRow) => {
    const price = parseFloat(draftPrice);
    const qty = parseInt(draftQty, 10);
    if (!(price > 0) || !(qty > 0)) return;
    try {
      await fetch('/api/scalper/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: row.orderId,
          price,
          quantity: qty,
          orderType: row.orderType,
          broker: 'dhan',
        }),
      });
    } finally {
      setEditingOrderId(null);
    }
  };

  const activeBaskets = baskets.filter((b) => !basketIsFlat(b));
  const liveOrders = orders.filter((o) => !TERMINAL_ORDER_STATUSES.has(o.orderStatus.toUpperCase()));

  let totalPnl = 0;
  for (const basket of activeBaskets) {
    for (const leg of basket.legs) {
      if (leg.qty <= 0) continue;
      const row = findBrokerRow(positions, leg);
      totalPnl += legUnrealizedPnl(row, liveLegQty(row, leg));
    }
  }

  return (
    <div className="ltd-panel">
      <div className="ltd-header">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-sky-400" />
          <span className="ltd-title">Trading Desk</span>
          {activeBaskets.length > 0 && (
            <span
              className={`ltd-pnl-chip ${totalPnl >= 0 ? 'ltd-pnl-pos' : 'ltd-pnl-neg'}`}
            >
              {fmtRupee(totalPnl)}
            </span>
          )}
        </div>
        <button type="button" onClick={onClose} className="ltd-close-btn" title="Hide trading desk">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="ltd-body">
        {/* Positions */}
        <div className="ltd-section">
          <div className="ltd-section-label">
            <Layers className="h-3 w-3" />
            Positions {activeBaskets.length > 0 && <span className="ltd-count">{activeBaskets.length}</span>}
          </div>
          {activeBaskets.length === 0 ? (
            <div className="ltd-empty">No open baskets from this page yet — use Trade / Trade ATM on a panel.</div>
          ) : (
            <div className="ltd-table-wrap">
              <table className="ltd-table">
                <thead>
                  <tr>
                    <th>Basket</th>
                    <th>Leg</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">P&amp;L</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {activeBaskets.map((basket) => {
                    const liveLegs = basket.legs.filter((l) => l.qty > 0);
                    return liveLegs.map((leg, i) => {
                      const legIdx = basket.legs.indexOf(leg);
                      const row = findBrokerRow(positions, leg);
                      const ownQty = liveLegQty(row, leg);
                      const pnl = legUnrealizedPnl(row, ownQty);
                      const key = `${basket.id}:${legIdx}`;
                      const isExiting = exitingLegKey === key;
                      return (
                        <tr key={key}>
                          {i === 0 && (
                            <td rowSpan={liveLegs.length} className="ltd-basket-cell">
                              <div className="ltd-basket-title">{basket.title}</div>
                              {liveLegs.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleExitBasket(basket)}
                                  className="ltd-exit-all-btn"
                                >
                                  Exit All
                                </button>
                              )}
                            </td>
                          )}
                          <td>
                            <span className={`ltd-badge ${leg.action === 'BUY' ? 'ltd-badge-buy' : 'ltd-badge-sell'}`}>
                              {leg.action}
                            </span>{' '}
                            {leg.strike} {leg.optionType}
                          </td>
                          <td className="text-right tabular-nums">{ownQty}</td>
                          <td className={`text-right tabular-nums font-bold ${pnl >= 0 ? 'ltd-text-pos' : 'ltd-text-neg'}`}>
                            {fmtRupee(pnl)}
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => handleExitLeg(basket, legIdx)}
                              disabled={isExiting || ownQty <= 0}
                              className="ltd-exit-btn"
                            >
                              {isExiting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Exit'}
                            </button>
                          </td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Order Book */}
        <div className="ltd-section">
          <div className="ltd-section-label">
            <ListOrdered className="h-3 w-3" />
            Order Book {liveOrders.length > 0 && <span className="ltd-count">{liveOrders.length}</span>}
          </div>
          {liveOrders.length === 0 ? (
            <div className="ltd-empty">No pending orders from this page.</div>
          ) : (
            <div className="ltd-table-wrap">
              <table className="ltd-table">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Side</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {liveOrders.map((row) => {
                    const isEditing = editingOrderId === row.orderId;
                    const isLimit = row.orderType.toUpperCase().includes('LIMIT') && !row.orderType.toUpperCase().includes('MARKET');
                    return (
                      <tr key={row.orderId}>
                        <td className="ltd-symbol">{row.tradingSymbol}</td>
                        <td>
                          <span className={`ltd-badge ${row.transactionType === 'BUY' ? 'ltd-badge-buy' : 'ltd-badge-sell'}`}>
                            {row.transactionType}
                          </span>
                        </td>
                        <td className="text-right tabular-nums">
                          {isEditing ? (
                            <input
                              type="number"
                              value={draftQty}
                              onChange={(e) => setDraftQty(e.target.value)}
                              className="ltd-input"
                            />
                          ) : row.quantity}
                        </td>
                        <td className="text-right tabular-nums">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.05"
                              value={draftPrice}
                              onChange={(e) => setDraftPrice(e.target.value)}
                              className="ltd-input"
                            />
                          ) : `₹${row.price.toFixed(2)}`}
                        </td>
                        <td>{row.orderType}</td>
                        <td>
                          <span className="ltd-status">{row.orderStatus}</span>
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-1">
                              <button type="button" onClick={() => saveEditOrder(row)} className="ltd-icon-btn ltd-icon-save" title="Save">
                                <Check className="h-3 w-3" />
                              </button>
                              <button type="button" onClick={() => setEditingOrderId(null)} className="ltd-icon-btn" title="Discard">
                                <XCircle className="h-3 w-3" />
                              </button>
                            </div>
                          ) : cancelConfirmId === row.orderId ? (
                            <div className="flex items-center justify-end gap-1">
                              <button type="button" onClick={() => handleCancelOrder(row.orderId)} className="ltd-confirm-yes">Yes</button>
                              <button type="button" onClick={() => setCancelConfirmId(null)} className="ltd-confirm-no">No</button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1">
                              {isLimit && (
                                <button type="button" onClick={() => startEditOrder(row)} className="ltd-icon-btn" title="Edit">
                                  <Pencil className="h-3 w-3" />
                                </button>
                              )}
                              <button type="button" onClick={() => setCancelConfirmId(row.orderId)} className="ltd-icon-btn ltd-icon-cancel" title="Cancel">
                                <Ban className="h-3 w-3" />
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
          )}
        </div>
      </div>

      <style>{`
        .ltd-panel {
          position: fixed;
          right: 12px;
          bottom: 12px;
          width: min(560px, calc(100vw - 24px));
          max-height: min(480px, calc(100vh - 90px));
          display: flex;
          flex-direction: column;
          background: rgba(10, 14, 26, 0.97);
          border: 1px solid rgba(99, 102, 241, 0.25);
          border-radius: 14px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.5);
          backdrop-filter: blur(14px);
          z-index: 40;
          color: #e2e8f0;
          font-family: 'Inter', system-ui, sans-serif;
        }
        :root:not(.dark) .ltd-panel {
          background: #ffffff;
          border-color: #e2e8f0;
          color: #0f172a;
          box-shadow: 0 12px 32px rgba(15, 23, 42, 0.15);
        }
        .ltd-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          border-bottom: 1px solid rgba(99, 102, 241, 0.15);
        }
        :root:not(.dark) .ltd-header { border-bottom-color: #e2e8f0; }
        .ltd-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
        .ltd-pnl-chip { font-size: 10px; font-family: monospace; font-weight: 700; padding: 2px 6px; border-radius: 6px; }
        .ltd-pnl-pos { background: rgba(16,185,129,0.15); color: #34d399; }
        .ltd-pnl-neg { background: rgba(244,63,94,0.15); color: #fb7185; }
        .ltd-close-btn { color: rgba(255,255,255,0.5); background: transparent; border: none; cursor: pointer; padding: 4px; border-radius: 6px; }
        .ltd-close-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
        :root:not(.dark) .ltd-close-btn { color: #64748b; }
        :root:not(.dark) .ltd-close-btn:hover { color: #0f172a; background: #f1f5f9; }
        .ltd-body { overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 12px; }
        .ltd-section-label { display: flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(255,255,255,0.5); margin-bottom: 6px; }
        :root:not(.dark) .ltd-section-label { color: #64748b; }
        .ltd-count { background: rgba(99,102,241,0.2); color: #a5b4fc; padding: 0 5px; border-radius: 999px; font-size: 9px; }
        .ltd-empty { font-size: 11px; color: rgba(255,255,255,0.4); padding: 8px 0; }
        :root:not(.dark) .ltd-empty { color: #94a3b8; }
        .ltd-table-wrap { overflow-x: auto; }
        .ltd-table { width: 100%; font-size: 11px; font-family: monospace; border-collapse: collapse; }
        .ltd-table thead th { text-align: left; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; background: #27272a; padding: 5px 6px; }
        :root:not(.dark) .ltd-table thead th { background: #1e293b; }
        .ltd-table tbody td { padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: middle; }
        :root:not(.dark) .ltd-table tbody td { border-bottom-color: #e2e8f0; }
        .ltd-basket-cell { vertical-align: top; }
        .ltd-basket-title { font-weight: 700; font-size: 10px; white-space: nowrap; }
        .ltd-exit-all-btn { margin-top: 3px; font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 6px; background: rgba(244,63,94,0.15); color: #fb7185; border: 1px solid rgba(244,63,94,0.3); cursor: pointer; }
        .ltd-exit-all-btn:hover { background: rgba(244,63,94,0.25); }
        .ltd-badge { padding: 1px 5px; border-radius: 4px; font-size: 9px; font-weight: 700; }
        .ltd-badge-buy { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
        .ltd-badge-sell { background: rgba(244,63,94,0.15); color: #fb7185; border: 1px solid rgba(244,63,94,0.3); }
        .ltd-text-pos { color: #34d399; }
        .ltd-text-neg { color: #fb7185; }
        .ltd-exit-btn { font-size: 9px; font-weight: 700; padding: 3px 8px; border-radius: 6px; background: rgba(99,102,241,0.15); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3); cursor: pointer; }
        .ltd-exit-btn:hover:not(:disabled) { background: rgba(99,102,241,0.25); }
        .ltd-exit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .ltd-symbol { font-weight: 700; white-space: nowrap; }
        .ltd-status { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(56,189,248,0.15); color: #7dd3fc; border: 1px solid rgba(56,189,248,0.3); }
        .ltd-input { width: 60px; text-align: center; background: #09090b; border: 1px solid rgba(56,189,248,0.5); border-radius: 4px; color: #fff; font-size: 11px; padding: 2px; }
        .ltd-icon-btn { padding: 4px; border-radius: 6px; background: #27272a; border: 1px solid #3f3f46; color: #a1a1aa; cursor: pointer; }
        .ltd-icon-btn:hover { color: #fff; }
        .ltd-icon-save { background: #059669; color: #fff; border-color: #059669; }
        .ltd-icon-cancel:hover { background: rgba(244,63,94,0.2); color: #fb7185; border-color: rgba(244,63,94,0.4); }
        .ltd-confirm-yes { font-size: 9px; font-weight: 700; padding: 3px 7px; border-radius: 6px; background: #e11d48; color: #fff; border: none; cursor: pointer; }
        .ltd-confirm-no { font-size: 9px; font-weight: 700; padding: 3px 7px; border-radius: 6px; background: #27272a; color: #d4d4d8; border: none; cursor: pointer; }
      `}</style>
    </div>
  );
}
