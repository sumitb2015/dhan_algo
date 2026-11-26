/**
 * Fresh Money board — live WebSocket prices (server only). Read-only: no orders.
 *
 * The board's spot (a CRUDEOIL / CRUDEOILM option month's own futures, or the NSE index) and the LTPs of the options
 * this page holds come from Dhan's WebSocket through the shared Market Data Hub, not from REST quotes (the account-wide
 * quote lane slows to a crawl after a 429; the crude collector's REST price fell back to stale values every other poll).
 *
 * Same mechanism and rules as the Price Ladder (lib/priceLadderServer.ts "WebSocket prices"):
 *   this process -> debug/fresh_money_ws_wanted_<pid>.json   {"instruments": [["MCX_COMM", "573423"], ...]}
 *   scripts/tools/price_ladder_ws.py --name fresh_money  (started on demand; ONE shared hub connection)
 *   bridge -> debug/fresh_money_ws_quotes.json   {"updated_ms", "hub_alive", "quotes": {"MCX_COMM:573423": {"ltp", "changed_ms", "since_ms"}}}
 * The hub keeps an instrument's last tick after an unsubscribe and Dhan replays the last packet on subscribe, so a value
 * being present proves nothing about its age: a price counts once its subscription has settled or it has changed since.
 * No fresh WebSocket price = null; callers fall back (REST for P&L, the snapshot for the board) and say which they used.
 */
import { expiriesFor, resolveFuture, indexSpotId } from '@/lib/pnfContracts';
import { createBridgeWsClient, type WsSegment } from '@/lib/bridgeWsClient';
import { usableQuote, pickPrevClose, type WsPrice } from './freshMoneyWsQuote.ts';

export { usableQuote, pickPrevClose, type WsPrice, type WsSegment };

// The shared bridge client (lib/bridgeWsClient.ts) under this board's own name; `__freshMoneyWs` is the globalThis slot it
// has always used, so a hot reload keeps the same wanted list.
const client = createBridgeWsClient('fresh_money', '__freshMoneyWs', '[fresh-money]');

/** Ask for an instrument; returns its quote key (`SEGMENT:securityId`). Call wsSync() after a batch of asks. */
export function wsWant(segment: WsSegment, securityId: string): string {
  return client.want(segment, securityId);
}

/** Write this process's wanted file (on change and every 20 s) and start the bridge when it is not running. */
export function wsSync(): void {
  client.sync();
}

/** The bridge's quote for `key`, or null (bridge down, hub down, not subscribed long enough). */
export function wsPrice(key: string): WsPrice | null {
  return client.price(key);
}

/** SENSEX's IDX_I id (BSE: not among master_list's NSE INDEX rows); same id as iv_snapshot_collector.py. */
const BSE_INDEX_IDS: Record<string, string> = { SENSEX: '51' };

/**
 * What the board's spot is for this underlying and option expiry: an MCX option month's OWN futures (the first FUTCOM
 * expiring on or after the option — CRUDEOILM Nov-17 options sit on the Nov-19 future, dhan-crudeoil-trading), or the
 * NSE / BSE index. Null when the master list has no such contract.
 */
export function spotInstrument(underlying: string, optionExpiry: string, mcx: boolean): { segment: WsSegment; securityId: string; label: string } | null {
  if (mcx) {
    const exp = expiriesFor('futures', underlying).find(e => e >= optionExpiry);
    const fut = exp ? resolveFuture(underlying, exp) : null;
    return fut ? { segment: 'MCX_COMM', securityId: fut.securityId, label: fut.displayName || `${underlying} FUT` } : null;
  }
  const id = indexSpotId(underlying) ?? BSE_INDEX_IDS[underlying];
  return id ? { segment: 'IDX_I', securityId: id, label: underlying } : null;
}
