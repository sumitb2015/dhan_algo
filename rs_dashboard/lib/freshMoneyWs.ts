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
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { DEBUG_DIR } from '@/lib/ivSnapshotFiles';
import { readJsonFile, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { bridgeRunning, startBridge } from '@/lib/bridgeSpawn';
import { expiriesFor, resolveFuture, indexSpotId } from '@/lib/pnfContracts';
import { usableQuote, pickPrevClose, WS_FILE_STALE_MS as FILE_STALE_MS, type WsPrice } from './freshMoneyWsQuote.ts';

export { usableQuote, pickPrevClose, type WsPrice };

const NAME = 'fresh_money';
const WANTED_FILE = path.join(DEBUG_DIR, `${NAME}_ws_wanted_${process.pid}.json`);
const QUOTES_FILE = path.join(DEBUG_DIR, `${NAME}_ws_quotes.json`);
const STATUS_FILE = path.join(DEBUG_DIR, `${NAME}_ws_status.json`);
const START_LOCK = path.join(DEBUG_DIR, `${NAME}_ws_start.lock`);
const LOG_FILE = path.join(DEBUG_DIR, `${NAME}_ws.log`);
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'price_ladder_ws.py');

/** An instrument nobody has asked for in this long is dropped from the wanted list. */
const WANT_TTL_MS = 30_000;
/** The bridge ignores a wanted file 60 s old: rewrite well inside that. */
const REWRITE_MS = 20_000;
const HEARTBEAT_STALE_MS = 10_000;
const START_EVERY_MS = 30_000;

interface State { want: Map<string, number>; written: string; writtenAt: number; startAt: number }
const st: State = ((globalThis as { __freshMoneyWs?: State }).__freshMoneyWs ??= { want: new Map(), written: '', writtenAt: 0, startAt: 0 });

export type WsSegment = 'IDX_I' | 'NSE_FNO' | 'MCX_COMM';

/** Ask for an instrument; returns its quote key (`SEGMENT:securityId`). Call wsSync() after a batch of asks. */
export function wsWant(segment: WsSegment, securityId: string): string {
  const k = `${segment}:${securityId}`;
  st.want.set(k, Date.now());
  return k;
}

/** Write this process's wanted file (on change and every 20 s) and start the bridge when it is not running. */
export function wsSync(): void {
  const now = Date.now();
  for (const [k, at] of st.want) if (now - at > WANT_TTL_MS) st.want.delete(k);
  const keys = [...st.want.keys()].sort();
  const sig = keys.join(',');
  try {
    if (!keys.length) {
      if (st.written) { fs.rmSync(WANTED_FILE, { force: true }); st.written = ''; }
      return;
    }
    if (sig !== st.written || now - st.writtenAt >= REWRITE_MS) {
      writeJsonAtomic(WANTED_FILE, { pid: process.pid, updated_ms: now, instruments: keys.map(k => k.split(':')) });
      st.written = sig; st.writtenAt = now;
    }
  } catch {
    return; // the next sync retries
  }
  const quotes = readJsonFile<Record<string, unknown>>(QUOTES_FILE);
  if (bridgeRunning({ quotes, statusFile: STATUS_FILE, fileStaleMs: FILE_STALE_MS, heartbeatStaleMs: HEARTBEAT_STALE_MS })) return;
  if (now - st.startAt < START_EVERY_MS) return;
  st.startAt = now;
  startBridge({ script: SCRIPT, lockFile: START_LOCK, logFile: LOG_FILE, tag: '[fresh-money]', args: ['--name', NAME] });
}


/** The bridge's quote for `key`, or null (bridge down, hub down, not subscribed long enough). */
export function wsPrice(key: string): WsPrice | null {
  return usableQuote(readJsonFile(QUOTES_FILE), key, Date.now());
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
