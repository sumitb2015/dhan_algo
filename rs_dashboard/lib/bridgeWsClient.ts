/**
 * A server-side client of scripts/tools/price_ladder_ws.py run under its own `--name` (one shared Market Data Hub
 * connection, no REST quotes). Extracted from lib/freshMoneyWs.ts so the Fresh Money board and Price Alerts each keep
 * their own wanted list and quotes file while sharing one implementation:
 *
 *   this process -> debug/<name>_ws_wanted_<pid>.json   {"instruments": [["MCX_COMM", "573423"], ...]}
 *   bridge       -> debug/<name>_ws_quotes.json        {"updated_ms", "hub_alive", "quotes": {"MCX_COMM:573423": {...}}}
 *
 * Freshness is judged per quote by usableQuote (changed since asked, or subscription settled), never by file write time.
 * State lives on globalThis (`stateKey`), so every Next bundle in the process shares one wanted list.
 */
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { DEBUG_DIR } from '@/lib/ivSnapshotFiles';
import { readJsonFile, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { bridgeRunning, startBridge } from '@/lib/bridgeSpawn';
import { usableQuote, WS_FILE_STALE_MS as FILE_STALE_MS, type WsPrice } from './freshMoneyWsQuote.ts';

export type WsSegment = 'IDX_I' | 'NSE_FNO' | 'MCX_COMM';

/** An instrument nobody has asked for in this long is dropped from the wanted list. */
const WANT_TTL_MS = 30_000;
/** The bridge ignores a wanted file 60 s old: rewrite well inside that. */
const REWRITE_MS = 20_000;
const HEARTBEAT_STALE_MS = 10_000;
const START_EVERY_MS = 30_000;
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'price_ladder_ws.py');

interface State { want: Map<string, number>; written: string; writtenAt: number; startAt: number }

export interface BridgeWsClient {
  /** Ask for an instrument; returns its quote key (`SEGMENT:securityId`). Call sync() after a batch of asks. */
  want(segment: WsSegment, securityId: string): string;
  /** Write this process's wanted file (on change and every 20 s) and start the bridge when it is not running. Returns the
   *  quotes file it read for the running check (pass it to prices() to skip a second parse), or null when it read none. */
  sync(): Record<string, unknown> | null;
  /** The bridge's quote for `key`, or null (bridge down, hub down, not subscribed long enough). Reads the file. */
  price(key: string): WsPrice | null;
  /** Several quotes from ONE read of the quotes file (or from `file`, what sync() just read). */
  prices(keys: string[], file?: Record<string, unknown> | null): Map<string, WsPrice | null>;
}

/** `name`: lowercase letters / underscore (the bridge's file names). `stateKey`: the globalThis slot for this client. */
export function createBridgeWsClient(name: string, stateKey: string, tag: string): BridgeWsClient {
  const wantedFile = path.join(DEBUG_DIR, `${name}_ws_wanted_${process.pid}.json`);
  const quotesFile = path.join(DEBUG_DIR, `${name}_ws_quotes.json`);
  const statusFile = path.join(DEBUG_DIR, `${name}_ws_status.json`);
  const startLock = path.join(DEBUG_DIR, `${name}_ws_start.lock`);
  const logFile = path.join(DEBUG_DIR, `${name}_ws.log`);
  const g = globalThis as unknown as Record<string, State | undefined>;
  const st: State = (g[stateKey] ??= { want: new Map(), written: '', writtenAt: 0, startAt: 0 });

  return {
    want(segment, securityId) {
      const k = `${segment}:${securityId}`;
      st.want.set(k, Date.now());
      return k;
    },
    sync() {
      const now = Date.now();
      for (const [k, at] of st.want) if (now - at > WANT_TTL_MS) st.want.delete(k);
      const keys = [...st.want.keys()].sort();
      const sig = keys.join(',');
      try {
        if (!keys.length) {
          if (st.written) { fs.rmSync(wantedFile, { force: true }); st.written = ''; }
          return null;
        }
        if (sig !== st.written || now - st.writtenAt >= REWRITE_MS) {
          writeJsonAtomic(wantedFile, { pid: process.pid, updated_ms: now, instruments: keys.map(k => k.split(':')) });
          st.written = sig; st.writtenAt = now;
        }
      } catch {
        return null; // the next sync retries
      }
      const quotes = readJsonFile<Record<string, unknown>>(quotesFile);
      if (bridgeRunning({ quotes, statusFile, fileStaleMs: FILE_STALE_MS, heartbeatStaleMs: HEARTBEAT_STALE_MS })) return quotes;
      if (now - st.startAt >= START_EVERY_MS) {
        st.startAt = now;
        startBridge({ script: SCRIPT, lockFile: startLock, logFile, tag, args: ['--name', name] });
      }
      return quotes;
    },
    price(key) {
      return usableQuote(readJsonFile(quotesFile), key, Date.now());
    },
    prices(keys, read) {
      const file = read !== undefined ? read : readJsonFile<Record<string, unknown>>(quotesFile);
      const now = Date.now();
      return new Map(keys.map(k => [k, usableQuote(file, k, now)]));
    },
  };
}
