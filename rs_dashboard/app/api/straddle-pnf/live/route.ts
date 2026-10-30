import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { writeJsonAtomic } from '@/lib/lockedJsonFile';

// Live price for the Point & Figure page, from the WebSocket bridge scripts/tools/pnf_ws.py (a consumer of the shared Market Data
// Hub: ONE Dhan connection). This route only asks the bridge for the page's instrument and reads its quotes file: read-only, no orders.
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const WANTED_FILE = path.join(DEBUG_DIR, `pnf_ws_wanted_${process.pid}.json`);
const QUOTES_FILE = path.join(DEBUG_DIR, 'pnf_ws_quotes.json');
const STATUS_FILE = path.join(DEBUG_DIR, 'pnf_ws_status.json');
const START_LOCK = path.join(DEBUG_DIR, 'pnf_ws_start.lock');
const LOG_FILE = path.join(DEBUG_DIR, 'pnf_ws.log');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'pnf_ws.py');

const SEGMENTS = new Set(['IDX_I', 'NSE_EQ', 'MCX_COMM']);
/** The bridge ignores a wanted file 60 s old: the page polls every second, so this is rewritten well inside that. */
const REWRITE_MS = 15_000;
const FILE_STALE_MS = 3_000;
const HEARTBEAT_STALE_MS = 10_000;
const START_EVERY_MS = 30_000;

const state = ((globalThis as { __pnfWs?: { key: string; writtenAt: number; startAt: number } }).__pnfWs ??= { key: '', writtenAt: 0, startAt: 0 });

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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const segment = searchParams.get('segment') ?? '';
  const id = searchParams.get('id') ?? '';
  if (!SEGMENTS.has(segment) || !/^\d{1,9}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Use segment=IDX_I|NSE_EQ|MCX_COMM&id=<security id>' }, { status: 400 });
  }
  const key = `${segment}:${id}`;
  const now = Date.now();
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    if (key !== state.key || now - state.writtenAt >= REWRITE_MS) {
      writeJsonAtomic(WANTED_FILE, { pid: process.pid, updated_ms: now, instruments: [[segment, id]] });
      state.key = key; state.writtenAt = now;
    }
  } catch (err) {
    return NextResponse.json({ success: false, error: `could not ask the bridge: ${(err as Error).message}` }, { status: 500 });
  }
  const running = bridgeRunning();
  if (!running && now - state.startAt >= START_EVERY_MS) { state.startAt = now; startBridge(); }

  const f = readJson(QUOTES_FILE);
  const fresh = !!f && now - Number(f.updated_ms) <= FILE_STALE_MS && f.hub_alive !== false;
  const q = fresh ? (f!.quotes as Record<string, { ltp: number; changed_ms: number | null; prev_close?: number; volume?: number }> | undefined)?.[key] : undefined;
  // A price counts only once its content has CHANGED since the bridge started asking: the hub replays the last packet on subscribe.
  const live = q && Number(q.ltp) > 0 && q.changed_ms ? q : null;
  return NextResponse.json({
    success: true, bridge: running, hub: fresh,
    quote: live ? { ltp: live.ltp, changedMs: live.changed_ms, prevClose: live.prev_close ?? null, volume: live.volume ?? null } : null,
    // The last known price even before it has ticked, for a header that would otherwise be empty.
    last: q && Number(q.ltp) > 0 ? { ltp: q.ltp, prevClose: q.prev_close ?? null } : null,
  });
}
