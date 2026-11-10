/**
 * When a WebSocket quote from the Fresh Money price bridge may be used (pure; see lib/freshMoneyWs.ts). The Market Data
 * Hub keeps an instrument's last tick after an unsubscribe and Dhan replays the last packet on (re)subscribe, so a value
 * merely being present proves nothing about its age: it counts once its subscription has settled (the replay is in) or it
 * has changed since we asked — the Price Ladder's rule.
 */

/** The bridge's quotes file older than this = the bridge is not running. */
export const WS_FILE_STALE_MS = 3_000;
/** A subscription this old has had the hub's replay of the current last packet (the hub scans every 3 s). */
export const WS_SETTLED_MS = 8_000;

export interface WsPrice { ltp: number; changedMs: number | null; sinceMs: number }

export function usableQuote(
  file: { updated_ms?: unknown; hub_alive?: unknown; quotes?: unknown } | null, key: string, now: number,
): WsPrice | null {
  if (!file || !(now - Number(file.updated_ms) <= WS_FILE_STALE_MS) || file.hub_alive === false) return null;
  const q = (file.quotes as Record<string, { ltp?: unknown; changed_ms?: unknown; since_ms?: unknown }> | undefined)?.[key];
  const ltp = Number(q?.ltp);
  if (!q || !(ltp > 0)) return null;
  const changedMs = q.changed_ms == null ? null : Number(q.changed_ms);
  const sinceMs = Number(q.since_ms);
  if (changedMs === null && !(now - sinceMs >= WS_SETTLED_MS)) return null;
  return { ltp, changedMs, sinceMs };
}
