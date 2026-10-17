// The order ids the Focus Tool placed on a broker that does not tag orders (Kotak). Dhan tags every order with a
// correlationId prefix (FTS_ORDER_SOURCE), which is how a close made OUTSIDE the tool is told apart from the tool's own;
// Kotak has nothing to tag, so the ids are remembered here instead. Persisted for the day, so a reload does not turn the
// tool's own earlier fills into "outside" trades.

export interface OwnOrderStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

const KEY = 'focus_tool_own_orders_v1';

interface Saved { date: string; ids: string[] }

function read(store: OwnOrderStore, broker: string, today: string): string[] {
  try {
    const raw = store.getItem(`${KEY}_${broker}`);
    if (!raw) return [];
    const saved = JSON.parse(raw) as Saved;
    return saved.date === today && Array.isArray(saved.ids) ? saved.ids.map(String) : [];
  } catch { return []; }
}

export function loadOwnOrders(store: OwnOrderStore, broker: string, today: string): Set<string> {
  return new Set(read(store, broker, today));
}

/** Remembers one order id for today. Storage failures are swallowed: the in-memory set still works for the session. */
export function rememberOwnOrder(store: OwnOrderStore, broker: string, today: string, orderId: string): void {
  if (!orderId) return;
  const ids = read(store, broker, today);
  if (ids.includes(orderId)) return;
  try { store.setItem(`${KEY}_${broker}`, JSON.stringify({ date: today, ids: [...ids, orderId].slice(-500) })); } catch { /* best effort */ }
}
