import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { isPidRunning } from '@/lib/processCheck';
import type { TerminalOrder, TerminalPayload, TerminalState } from '@/lib/terminalTypes';
import { STRATEGY_KEY } from '@/lib/terminalTypes';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const STATE_FILE = path.join(DEBUG_DIR, `${STRATEGY_KEY}_state.json`);
const ORDERS_FILE = path.join(DEBUG_DIR, `${STRATEGY_KEY}_orders.jsonl`);
const MANIFEST = path.join(PROJECT_ROOT, 'Intraday_Historical_Data', 'manifest.json');

/** Orders kept in the response. The .jsonl is append-only and grows all day. */
const MAX_ORDERS = 120;

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Tail the append-only order log.
 *
 * Read the whole file and slice: a day's orders is a few hundred lines at most,
 * and partial-line handling on a file the strategy may be appending to right now
 * is not worth the risk of dropping a record.
 */
function readOrders(): TerminalOrder[] {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];
    const today = new Date().toISOString().slice(0, 10);
    const lines = fs.readFileSync(ORDERS_FILE, 'utf8').split('\n');
    const out: TerminalOrder[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const o = JSON.parse(trimmed) as TerminalOrder;
        // The log is never truncated, so filter to today rather than showing
        // last week's fills as if they were live.
        if (typeof o.ts === 'string' && o.ts.slice(0, 10) === today) out.push(o);
      } catch {
        /* a torn final line while the strategy is mid-append — skip it */
      }
    }
    return out.slice(-MAX_ORDERS).reverse();
  } catch {
    return [];
  }
}

function readStore() {
  const m = readJson<Record<string, { last?: string; sessions?: number }>>(MANIFEST);
  if (!m) return null;
  const entries = Object.entries(m).filter(([k]) => k !== 'NIFTY_50');
  if (!entries.length) return null;
  let last: string | null = null;
  let minSessions = Number.POSITIVE_INFINITY;
  for (const [, v] of entries) {
    if (v?.last && (!last || v.last > last)) last = v.last;
    if (typeof v?.sessions === 'number') minSessions = Math.min(minSessions, v.sessions);
  }
  return {
    last,
    // The SHALLOWEST symbol bounds what the backtest can actually replay.
    sessions: Number.isFinite(minSessions) ? minSessions : 0,
    symbols: entries.length,
  };
}

export async function GET() {
  const state = readJson<TerminalState>(STATE_FILE);

  // A crashed process leaves its last state file behind saying RUNNING. Without
  // this PID cross-check the terminal would show a live-looking book for a
  // strategy that is no longer running — the single most dangerous stale read here.
  let running = false;
  if (state?.pid) {
    running = isPidRunning(Number(state.pid));
    if (!running && state.status !== 'STOPPED') {
      state.status = 'STOPPED';
      state.halt_reason = state.halt_reason ?? 'Process is no longer running';
    }
  }

  const payload: TerminalPayload = {
    success: true,
    running,
    state,
    orders: readOrders(),
    store: readStore(),
  };
  return NextResponse.json(payload);
}
