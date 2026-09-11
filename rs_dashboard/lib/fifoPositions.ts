/**
 * FIFO Trade Matching for Scalper Terminals
 *
 * Resolves exact active open-position average prices (excluding already-closed round trips)
 * and generates detailed exited-position records with true entry, exit, points, and realized P&L.
 */

export interface RawTrade {
  tradingSymbol?: string;
  symbol?: string;
  transactionType?: string;
  side?: string;
  tradedQuantity?: number | string;
  quantity?: number | string;
  qty?: number | string;
  tradedPrice?: number | string;
  price?: number | string;
  createTime?: string;
  tradeTime?: string;
  time?: string;
}

export interface FifoOpenPosition {
  tradingSymbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number;
}

export interface ExitedPositionItem {
  id: string;
  tradingSymbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  points: number;
  pnl: number;
  entryTime?: string;
  exitTime?: string;
}

interface FifoLot {
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  time: string;
}

export function matchTradesFifo(
  trades: RawTrade[],
  multipliers: Record<string, number> = {}
): {
  openMap: Record<string, FifoOpenPosition>;
  exitedList: ExitedPositionItem[];
} {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { openMap: {}, exitedList: [] };
  }

  // Group trades by trading symbol
  const bySymbol: Record<string, RawTrade[]> = {};
  for (const t of trades) {
    const sym = String(t.tradingSymbol || t.symbol || '').trim();
    if (!sym) continue;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(t);
  }

  const openMap: Record<string, FifoOpenPosition> = {};
  const exitedList: ExitedPositionItem[] = [];

  for (const [sym, symTrades] of Object.entries(bySymbol)) {
    // Sort chronologically
    const sorted = [...symTrades].sort((a, b) => {
      const timeA = String(a.createTime || a.tradeTime || a.time || '');
      const timeB = String(b.createTime || b.tradeTime || b.time || '');
      return timeA.localeCompare(timeB);
    });

    const queue: FifoLot[] = [];
    const mult = multipliers[sym] ?? (sym.includes('CRUDE') ? 1 : 1);

    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const sideRaw = String(t.transactionType || t.side || 'BUY').toUpperCase();
      const side: 'BUY' | 'SELL' = sideRaw === 'S' || sideRaw === 'SELL' ? 'SELL' : 'BUY';
      const qty = Math.abs(Number(t.tradedQuantity || t.quantity || t.qty || 0));
      const price = Number(t.tradedPrice || t.price || 0);
      const time = String(t.createTime || t.tradeTime || t.time || '');

      if (qty <= 0 || price <= 0) continue;

      if (queue.length === 0 || queue[0].side === side) {
        queue.push({ side, qty, price, time });
      } else {
        // Opposite side: match FIFO
        let remQty = qty;
        while (remQty > 0 && queue.length > 0) {
          const front = queue[0];
          const matched = Math.min(remQty, front.qty);
          front.qty -= matched;
          remQty -= matched;

          const points = front.side === 'BUY' ? price - front.price : front.price - price;
          const pnl = points * matched * mult;

          exitedList.push({
            id: `exit-${sym}-${i}-${front.time}-${time}`,
            tradingSymbol: sym,
            side: front.side,
            qty: matched,
            entryPrice: front.price,
            exitPrice: price,
            points,
            pnl,
            entryTime: front.time,
            exitTime: time,
          });

          if (front.qty <= 0) {
            queue.shift();
          }
        }

        if (remQty > 0) {
          queue.push({ side, qty: remQty, price, time });
        }
      }
    }

    const totalOpenQty = queue.reduce((sum, item) => sum + item.qty, 0);
    if (totalOpenQty > 0) {
      const totalCost = queue.reduce((sum, item) => sum + item.qty * item.price, 0);
      openMap[sym] = {
        tradingSymbol: sym,
        side: queue[0].side,
        qty: totalOpenQty,
        avgPrice: totalCost / totalOpenQty,
      };
    }
  }

  // Consolidate partial fills: merge slices with identical symbol, side, and exitTime
  const consolidatedExited: ExitedPositionItem[] = [];
  for (const ex of exitedList) {
    const last = consolidatedExited[consolidatedExited.length - 1];
    if (
      last &&
      last.tradingSymbol === ex.tradingSymbol &&
      last.side === ex.side &&
      last.exitTime === ex.exitTime
    ) {
      const newQty = last.qty + ex.qty;
      const newEntryPrice = (last.entryPrice * last.qty + ex.entryPrice * ex.qty) / newQty;
      const newExitPrice = (last.exitPrice * last.qty + ex.exitPrice * ex.qty) / newQty;
      const newPoints = last.side === 'BUY' ? newExitPrice - newEntryPrice : newEntryPrice - newExitPrice;
      const newPnl = last.pnl + ex.pnl;

      last.qty = newQty;
      last.entryPrice = Number(newEntryPrice.toFixed(2));
      last.exitPrice = Number(newExitPrice.toFixed(2));
      last.points = Number(newPoints.toFixed(2));
      last.pnl = Number(newPnl.toFixed(2));
    } else {
      consolidatedExited.push({ ...ex });
    }
  }

  // Sort exited list latest first
  consolidatedExited.reverse();

  return { openMap, exitedList: consolidatedExited };
}

