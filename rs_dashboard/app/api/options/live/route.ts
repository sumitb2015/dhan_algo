import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';

const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const BRIDGE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_options_ws.py');
const ZERODHA_BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_options_ws_zerodha.py');

// Only brokers that actually run a tick bridge appear here. Kotak deliberately
// does not: an option's LTP comes from the exchange, not the broker, so it
// shares Dhan's feed (see QUOTE_CHANNEL in lib/useLiveOptionsWS.ts) and
// normalizes to 'dhan' below. Starting a second identical NIFTY feed for it
// would only duplicate the subscription.
type Broker = 'dhan' | 'zerodha';

function normalizeBroker(value: unknown): Broker {
  return String(value ?? 'dhan').toLowerCase() === 'zerodha' ? 'zerodha' : 'dhan';
}

/** Each broker's bridge is fully independent — its own quotes/status/history
 *  files and stop trigger — so starting/stopping one never touches the other. */
function filesFor(broker: Broker) {
  return {
    quotes:  path.join(DEBUG_DIR, `live_options_quotes_${broker}.json`),
    history: path.join(DEBUG_DIR, `live_options_history_${broker}.json`),
    status:  path.join(DEBUG_DIR, `live_options_status_${broker}.json`),
    stop:    path.join(DEBUG_DIR, `live_options_stop_${broker}.trigger`),
    log:     path.join(DEBUG_DIR, `live_options_log_${broker}.log`),
    extra:   path.join(DEBUG_DIR, `live_options_extra_${broker}.json`),
  };
}

async function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(findFreePort(startPort + 1));
    });
    server.listen(startPort, '127.0.0.1', () => {
      server.close(() => {
        resolve(startPort);
      });
    });
  });
}

/** Atomic cross-request start lock.
 *
 *  `wx` is O_EXCL: the OS guarantees exactly one caller creates the file, so this
 *  holds no matter how route modules are instantiated. An in-process guard is not
 *  enough here — dedupe()'s inflight Map is module-scoped, and a burst of concurrent
 *  starts was measured still spawning one bridge each, because the route module does
 *  not reliably share that state across invocations.
 *
 *  A lock older than LOCK_STALE_MS is assumed to be from a start that crashed before
 *  releasing, and is stolen — otherwise one failed start would block the bridge until
 *  someone deleted the file by hand. */
const LOCK_STALE_MS = 30_000;

function acquireStartLock(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
        return true;
      }
    } catch { /* lost the steal race to another caller — treat as not acquired */ }
    return false;
  }
}

function releaseStartLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes the stop trigger and waits (bounded, polling with a fresh PID check
 *  each time) for the process to actually exit, instead of a blind fixed sleep. */
async function stopAndWait(broker: Broker, pid: number, maxWaitMs = 3000): Promise<void> {
  fs.writeFileSync(filesFor(broker).stop, '');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid, true)) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

/** GET — return live quotes + bridge status (+ history when explicitly requested)
 *  for one broker. live_options_history_*.json holds 300 full-chain snapshots
 *  (~6MB) — reading and JSON.parse-ing it synchronously on every request blocks
 *  the event loop. Scalper polls this endpoint every 100ms and never uses
 *  `history`, so only pay that cost for callers (OptionsCharts) that ask via
 *  ?history=1. */
export async function GET(request: NextRequest) {
  const broker         = normalizeBroker(request.nextUrl.searchParams.get('broker'));
  const includeHistory = request.nextUrl.searchParams.get('history') === '1';
  const checkPid       = request.nextUrl.searchParams.get('checkPid') === '1';
  const files = filesFor(broker);

  const quotes  = readJson(files.quotes)  as Record<string, unknown> | null;
  const history = includeHistory ? (readJson(files.history) as Record<string, unknown> | null) : null;
  const status  = readJson(files.status)  as Record<string, unknown> | null;

  // If the process is dead, reset both RUNNING and ERROR to STOPPED so stale
  // error state from a previous crash doesn't persist across page loads.
  // Only when ?checkPid=1 — isPidRunning spawns a blocking `tasklist` on cache
  // miss (~50-200ms event-loop stall), so fast poll loops must not trigger it.
  // The scalper's 5s status poll passes it; the 100ms fallback poll does not.
  if (checkPid && status && status.pid && (status.status === 'RUNNING' || status.status === 'ERROR')) {
    if (!isPidRunning(Number(status.pid))) {
      (status as Record<string, unknown>).status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status:  status  ?? { status: 'STOPPED', subscribed: 0 },
    quotes:  quotes  ?? { updated_at: null, strikes: {} },
    history: history ?? { history: [] },
  });
}

/** POST — start or stop a broker's WebSocket bridge. Each broker's bridge is
 *  independent: starting/stopping one never affects the other's running
 *  process, so a broker switch in the UI never spawns/kills anything. */
export async function POST(request: NextRequest) {
  const body   = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // ── Stop ─────────────────────────────────────────────────────────────────
  if (action === 'stop') {
    const brokers: Broker[] = Array.isArray(body.brokers)
      ? (body.brokers as unknown[]).map(normalizeBroker)
      : [normalizeBroker(body.broker)];
    for (const broker of brokers) {
      fs.writeFileSync(filesFor(broker).stop, '');
    }
    return NextResponse.json({ success: true, message: 'Stop trigger written', brokers });
  }

  // ── Start ────────────────────────────────────────────────────────────────
  if (action === 'start') {
    const underlying = String(body.underlying ?? 'NIFTY').toUpperCase();
    const expiry     = String(body.expiry ?? '');
    const numStrikes = Number(body.numStrikes ?? 10);
    const broker     = normalizeBroker(body.broker);
    const files      = filesFor(broker);

    if (!expiry) {
      return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
    }

    // Everything below is a check-then-act on the status file, and a freshly
    // spawned bridge needs a second or two before it writes one. Concurrent starts
    // (page mount under StrictMode, a second tab, a fast broker/expiry toggle) each
    // saw "not running" and each spawned — that stranded 30 processes across one
    // afternoon, all subscribed to the feed and all writing the same files.
    // findFreePort compounded it: it binds, closes, then returns, so racing callers
    // are handed the SAME port. The lock serializes the whole sequence.
    const lockPath = path.join(DEBUG_DIR, `live_options_start_${broker}.lock`);
    if (!acquireStartLock(lockPath)) {
      return NextResponse.json({ success: true, message: 'Bridge start already in progress' });
    }

    try {
      // Prevent duplicate bridge for this broker. STARTING counts as live: it is
      // the provisional record written below, before Python reports RUNNING.
      const status = readJson(files.status) as Record<string, unknown> | null;
      const active = status && status.pid &&
        (status.status === 'RUNNING' || status.status === 'STARTING') &&
        isPidRunning(Number(status.pid));

      if (active && status.underlying === underlying && status.expiry === expiry) {
        return NextResponse.json({ success: true, message: 'Bridge already running', pid: status.pid });
      }

      // Stop this broker's existing bridge first (different underlying/expiry) —
      // the OTHER broker's bridge, if any, is never touched.
      if (active) {
        await stopAndWait(broker, Number(status!.pid));
      }

      if (fs.existsSync(files.stop)) fs.unlinkSync(files.stop);

      const freePort = await findFreePort(broker === 'zerodha' ? 8865 : 8765);
      const scriptPath = broker === 'zerodha' ? ZERODHA_BRIDGE_SCRIPT : BRIDGE_SCRIPT;

      // Truncate per run: pythonw.exe has no console, so an unhandled crash
      // (e.g. before the script's own try/except-wrapped write_status calls
      // run) previously left zero trace under stdio:'ignore'. A stale error
      // from a prior run would otherwise be indistinguishable from a fresh
      // one's — always start from an empty file.
      const logFd = fs.openSync(files.log, 'w');
      const child = spawn(
        PYTHON_EXE,
        [scriptPath, '--underlying', underlying, '--expiry', expiry,
         '--num-strikes', String(numStrikes), '--ws-port', String(freePort)],
        { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true },
      );
      fs.closeSync(logFd);
      child.unref();

      // Claim the slot before releasing the lock. The lock only covers callers that
      // overlap; a request arriving a second later would otherwise still find no
      // status file and spawn a second bridge. Python overwrites this with RUNNING
      // and its own pid once up. child.pid is the venv launcher stub rather than the
      // worker, but the launcher waits on the worker for its whole life, so
      // isPidRunning on it answers the only question this record has to answer.
      try {
        fs.writeFileSync(files.status, JSON.stringify({
          status: 'STARTING',
          broker,
          pid: child.pid,
          underlying,
          expiry,
          subscribed: 0,
          ws_port: freePort,
          started_at: new Date().toISOString(),
          last_update: new Date().toISOString(),
        }));
      } catch { /* Python writes the real record moments later */ }

      return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
    } finally {
      releaseStartLock(lockPath);
    }
  }

  // ── Watch extra (off-selected-expiry) contracts ─────────────────────────
  // Lets a page ask the bridge to also track contracts outside the expiry it
  // was started with — e.g. an open Kotak position whose own expiry isn't
  // the one currently selected in the scalper UI. Kotak's positions payload
  // never carries an LTP at all (see kotakShape.ts), so without this the leg
  // has no live price until the user manually switches the expiry dropdown.
  if (action === 'watchExtra') {
    // Always the Dhan bridge: Kotak has no tick bridge of its own (see
    // normalizeBroker above) and an option's LTP is exchange-set, not
    // broker-set, so Dhan's feed answers for any broker's position.
    const broker = 'dhan' as Broker;
    const underlying = String(body.underlying ?? 'NIFTY').toUpperCase();
    const requests = Array.isArray(body.requests) ? body.requests : [];

    const clean: { underlying: string; expiry: string; strike: number; side: 'CE' | 'PE' }[] = [];
    for (const r of requests) {
      if (!r || typeof r !== 'object') continue;
      const req = r as Record<string, unknown>;
      // Each leg carries its own underlying (a caller can watch legs across
      // several underlyings in one call) — fall back to the top-level default
      // only when a leg omits it, rather than overwriting every leg with it.
      const reqUnderlying = req.underlying ? String(req.underlying).toUpperCase() : underlying;
      const expiry = String(req.expiry ?? '');
      const strike = Number(req.strike);
      const side = String(req.side ?? '').toUpperCase();
      if (!expiry || !Number.isFinite(strike) || (side !== 'CE' && side !== 'PE')) continue;
      clean.push({ underlying: reqUnderlying, expiry, strike, side });
    }

    // Full replace, not an incremental add: the caller sends its complete
    // current need every call, so a leg that's since closed drops out on the
    // page's own next poll instead of this file only ever growing. The
    // Python side separately remembers what it already resolved, so a
    // request that reappears a moment later doesn't re-trigger a lookup.
    try {
      fs.writeFileSync(filesFor(broker).extra, JSON.stringify({ requests: clean }));
    } catch (err) {
      return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
    }
    return NextResponse.json({ success: true, count: clean.length });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
