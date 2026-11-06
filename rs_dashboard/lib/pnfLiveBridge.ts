import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { noteWanted, type WantedMap, type WantedPair } from '@/lib/pnfWanted';

// The P&F / Renko price bridge (scripts/tools/pnf_ws.py, a consumer of the shared Market Data Hub: ONE Dhan connection): asking it
// for instruments, starting it, and reading its quotes file. Shared by the live route (the page's prices) and the server-side AUTO
// watcher (lib/autoServerWatcher.ts), which needs the same prices with every tab closed. Read-only: no orders.
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const WANTED_FILE = path.join(DEBUG_DIR, `pnf_ws_wanted_${process.pid}.json`);
const QUOTES_FILE = path.join(DEBUG_DIR, 'pnf_ws_quotes.json');
const STATUS_FILE = path.join(DEBUG_DIR, 'pnf_ws_status.json');
const START_LOCK = path.join(DEBUG_DIR, 'pnf_ws_start.lock');
const LOG_FILE = path.join(DEBUG_DIR, 'pnf_ws.log');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'pnf_ws.py');

export const SEGMENTS = new Set(['IDX_I', 'NSE_EQ', 'NSE_FNO', 'MCX_COMM']);
/** The bridge ignores a wanted file 60 s old: the page polls every second, so this is rewritten well inside that. */
const REWRITE_MS = 15_000;
const FILE_STALE_MS = 3_000;
const HEARTBEAT_STALE_MS = 10_000;
const START_EVERY_MS = 30_000;

// `wanted`: every chart's instruments asked for in the last few seconds (lib/pnfWanted.ts); the bridge streams their union.
const state = ((globalThis as { __pnfWs?: { key: string; writtenAt: number; startAt: number; wanted?: WantedMap } }).__pnfWs ??= { key: '', writtenAt: 0, startAt: 0 });

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function bridgeRunning(): boolean {
  const q = readJson(QUOTES_FILE);
  if (q && Date.now() - Number(q.updated_ms) <= FILE_STALE_MS) return true;
  const st = readJson(STATUS_FILE);
  return !!st && st.status === 'RUNNING' && Date.now() - Number(st.heartbeat_ms) <= HEARTBEAT_STALE_MS;
}

/** Spawn the bridge once (O_EXCL lock, stolen after a minute); the bridge itself refuses to run twice. */
function startBridge(): void {
  try {
    try {
      fs.writeFileSync(START_LOCK, String(process.pid), { flag: 'wx' });
    } catch {
      if (Date.now() - fs.statSync(START_LOCK).mtimeMs < 60_000) return; // another process is starting it
      fs.writeFileSync(START_LOCK, String(process.pid));
    }
    const log = fs.openSync(LOG_FILE, 'a');
    const child = spawn(PYTHON_EXE, [SCRIPT], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', err => console.warn('[straddle-pnf/live] bridge failed to start:', err.message));
    child.unref();
    fs.closeSync(log);
    setTimeout(() => { try { fs.rmSync(START_LOCK, { force: true }); } catch { /* best effort */ } }, 15_000).unref?.();
    console.log('[straddle-pnf/live] starting the price bridge (pnf_ws.py)');
  } catch (err) {
    console.warn('[straddle-pnf/live] could not start the price bridge:', (err as Error).message);
  }
}


export type Q = { ltp: number; changed_ms: number | null; prev_close?: number; volume?: number };

/** Records one chart's (or the watcher's) instruments and rewrites the bridge's wanted file when the union changed or is due. Throws if it cannot. */
export function askBridge(key: string, pairs: WantedPair[], now: number): void {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  // The union of every asker in this process, not just this one: two charts on different instruments (the dual view, a P&F and a
  // Renko tab) must not replace each other in the bridge's subscription on alternate polls.
  const union = noteWanted(state.wanted ??= new Map(), key, pairs, now);
  if (union.signature !== state.key || now - state.writtenAt >= REWRITE_MS) {
    writeJsonAtomic(WANTED_FILE, { pid: process.pid, updated_ms: now, instruments: union.pairs });
    state.key = union.signature; state.writtenAt = now;
  }
}

/** Starts the bridge when it is not running (at most every START_EVERY_MS); returns whether it is running now. */
export function ensureBridge(now: number): boolean {
  const running = bridgeRunning();
  if (!running && now - state.startAt >= START_EVERY_MS) { state.startAt = now; startBridge(); }
  return running;
}

/** The bridge's quotes book when its file is fresh (and the hub alive), else undefined. `hub`: whether it was fresh. */
export function readBridgeBook(now: number): { hub: boolean; book: Record<string, Q> | undefined } {
  const f = readJson(QUOTES_FILE);
  const fresh = !!f && now - Number(f.updated_ms) <= FILE_STALE_MS && f.hub_alive !== false;
  return { hub: fresh, book: fresh ? (f!.quotes as Record<string, Q> | undefined) : undefined };
}

/** One instrument's read-back: `quote` once its price has CHANGED since the bridge started asking, `last` as soon as it has one. */
export function readBack(q: Q | undefined) {
  // A price counts only once its content has CHANGED since the bridge started asking: the hub replays the last packet on subscribe.
  const live = q && Number(q.ltp) > 0 && q.changed_ms ? q : null;
  return {
    quote: live ? { ltp: live.ltp, changedMs: live.changed_ms!, prevClose: live.prev_close ?? null, volume: live.volume ?? null } : null,
    // The last known price even before it has ticked, for a header that would otherwise be empty.
    last: q && Number(q.ltp) > 0 ? { ltp: q.ltp, prevClose: q.prev_close ?? null } : null,
  };
}
