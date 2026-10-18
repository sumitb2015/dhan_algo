/** Dhan F&O option charges per executed order (same table as the Breakdown Scalper backtest). */

import type { Side } from './types.ts';

export const DHAN_OPTION_COSTS = {
  gstPct: 18,
  sttSellPct: 0.1,
  exchangePct: 0.05,
  sebiPerCrore: 10,
  stampBuyPct: 0.003,
} as const;

export function orderCost(side: Side, premium: number, qty: number, brokeragePerOrder: number, c = DHAN_OPTION_COSTS): number {
  const turnover = premium * qty;
  const exchange = (turnover * c.exchangePct) / 100;
  const sebi = (turnover * c.sebiPerCrore) / 1e7;
  const gst = ((brokeragePerOrder + exchange + sebi) * c.gstPct) / 100;
  const stt = side === 'SELL' ? (turnover * c.sttSellPct) / 100 : 0;
  const stamp = side === 'BUY' ? (turnover * c.stampBuyPct) / 100 : 0;
  return brokeragePerOrder + exchange + sebi + gst + stt + stamp;
}
