/**
 * Terminal Trade Store for Cyber Scalper
 *
 * Tracks orders and positions placed directly from the Cyber Scalper terminal
 * so users can isolate their scalping activity from background automated strategies.
 */

export interface TerminalOrderRecord {
  orderId?: string;
  tradingSymbol: string;
  symbol: string; // Underlying (e.g. NIFTY, CRUDEOILM)
  side: 'BUY' | 'SELL';
  qty: number;
  price?: number;
  securityId?: string;
  broker?: string;
  time?: string;
}

const STORAGE_PREFIX = 'cyber_scalper_terminal_orders_';

function getTodayKey(): string {
  const d = new Date();
  return `${STORAGE_PREFIX}${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function saveTerminalOrder(order: TerminalOrderRecord): void {
  if (typeof window === 'undefined') return;
  try {
    const key = getTodayKey();
    const existingRaw = localStorage.getItem(key);
    const existing: TerminalOrderRecord[] = existingRaw ? JSON.parse(existingRaw) : [];
    existing.push({
      ...order,
      time: order.time || new Date().toLocaleTimeString('en-IN', { hour12: false }),
    });
    localStorage.setItem(key, JSON.stringify(existing));
  } catch (err) {
    console.warn('[terminalTradeStore] Failed to save order to localStorage:', err);
  }
}

export function getTerminalOrders(): TerminalOrderRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const key = getTodayKey();
    const existingRaw = localStorage.getItem(key);
    return existingRaw ? JSON.parse(existingRaw) : [];
  } catch (err) {
    console.warn('[terminalTradeStore] Failed to get orders from localStorage:', err);
    return [];
  }
}

export function getTerminalTradingSymbols(): Set<string> {
  const orders = getTerminalOrders();
  const set = new Set<string>();
  for (const o of orders) {
    if (o.tradingSymbol) {
      set.add(o.tradingSymbol.toUpperCase().trim());
    }
  }
  return set;
}

/**
 * Checks if a tradingSymbol matches an underlying symbol.
 * Handles NIFTY without matching NIFTYBEES / BANKNIFTY / FINNIFTY,
 * and CRUDEOILM vs CRUDEOIL.
 */
export function isSymbolMatch(tradingSymbol: string | undefined, underlying: string): boolean {
  if (!tradingSymbol || !underlying) return false;
  const ts = tradingSymbol.toUpperCase().trim();
  const u = underlying.toUpperCase().trim();

  if (u === 'NIFTY') {
    // Must start with NIFTY, but NOT BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYBEES
    return /^NIFTY(?!BEES)[-_\s\d]/.test(ts) || ts === 'NIFTY';
  }
  if (u === 'BANKNIFTY') {
    return ts.startsWith('BANKNIFTY');
  }
  if (u === 'FINNIFTY') {
    return ts.startsWith('FINNIFTY');
  }
  if (u === 'SENSEX') {
    return ts.startsWith('SENSEX');
  }
  if (u === 'CRUDEOILM') {
    return ts.startsWith('CRUDEOILM');
  }
  if (u === 'CRUDEOIL') {
    return ts.startsWith('CRUDEOIL') && !ts.startsWith('CRUDEOILM');
  }
  return ts.startsWith(u);
}
