import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';
import { isRegularSession } from '@/lib/nseHolidays';
import { istDayOf, normalizeConfig, DEFAULT_CONFIG } from '@/lib/breakdownLedger';
import { backfillStart, backtestConfigKey, sessionsToHold, type BtStore } from '@/lib/breakdownBacktest';

// Breakdown Scalper daily backtest: GET = stored results + run status + what is missing; POST = start a run
// (scripts/breakdown-backtest.ts, detached so a month of simulation never blocks this server) or stop one.
// Read-only towards the broker: the runner only fetches market data.

const DIR = path.join(PROJECT_ROOT, 'debug', 'breakdown_backtest');
const STORE = path.join(DIR, 'results.json');
const STATUS = path.join(DIR, 'status.json');
const STOP = path.join(DIR, 'stop.trigger');
const RUN_LOCK = path.join(DIR, 'run.lock');
const START_LOCK = path.join(DIR, 'start.lock');
const LOG = path.join(DIR, 'runner.log');
const LEDGER = path.join(PROJECT_ROOT, 'debug', 'breakdown_scalper_state.json');
const RUNNER = path.join(process.cwd(), 'scripts', 'breakdown-backtest.ts');
/** Covers the gap between spawn and the runner taking its own run.lock (node start-up). */
const START_LOCK_STALE_MS = 20_000;

const readJson = <T,>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

function runnerPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(RUN_LOCK, 'utf8').trim());
    return pid && isPidRunning(pid, true, /(node|tsx)/i) ? pid : null;
  } catch {
    return null;
  }
}

function currentConfig() {
  return normalizeConfig(readJson<{ config?: unknown }>(LEDGER)?.config ?? DEFAULT_CONFIG);
}

const istHm = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 16);

export async function GET(request: NextRequest) {
  const store = readJson<BtStore>(STORE);
  // The page caches the day results and sends the version it holds (the store's updatedAt): while that is still
  // current, the reply carries status only, so a poll never re-sends the whole trade log.
  const known = new URL(request.url).searchParams.get('known');
  const unchanged = !!store && !!store.updatedAt && known === store.updatedAt;
  const status = readJson<Record<string, unknown>>(STATUS);
  const pid = runnerPid();
  const isStarting = !pid && fs.existsSync(START_LOCK) && (Date.now() - fs.statSync(START_LOCK).mtimeMs < START_LOCK_STALE_MS);
  const isRunning = pid != null || isStarting;
  const config = currentConfig();
  const configKey = backtestConfigKey(config);
  const today = istDayOf(Date.now());
  const from = store?.from ?? backfillStart(today, 'week');
  const sessions = sessionsToHold(from, today, istHm(), isRegularSession, store?.to ?? null);
  const missing = sessions.filter((d) => !store?.days?.[d]);
  // A status left at "running" by a runner that died (killed, machine slept) is reported as interrupted.
  const runStatus = status && status.state === 'running' && !isRunning ? { ...status, state: 'interrupted' } : status;
  const DB_RANGE = { earliest: '2020-12-31', latest: '2026-10-13' };
  return NextResponse.json({
    success: true,
    unchanged,
    running: isRunning,
    status: isStarting && (!status || status.state !== 'running')
      ? { state: 'starting', message: 'Starting backtest engine…' }
      : runStatus,
    from,
    dbRange: DB_RANGE,
    missing,
    configKey,
    config,
    rulesChanged: store ? store.configKey !== configKey : false,
    store: store
      ? {
          from: store.from,
          window: store.window ?? 'db4',
          to: store.to ?? null,
          offline: !!store.offline,
          updatedAt: store.updatedAt,
          config: store.config,
          configKey: store.configKey,
          failures: store.failures ?? {},
          days: unchanged ? null : Object.values(store.days ?? {}).sort((a, b) => b.date.localeCompare(a.date)),
        }
      : null,
  });
}

function acquireStartLock(): boolean {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    fs.writeFileSync(START_LOCK, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(START_LOCK).mtimeMs > START_LOCK_STALE_MS) {
        fs.unlinkSync(START_LOCK);
        fs.writeFileSync(START_LOCK, String(Date.now()), { flag: 'wx' });
        return true;
      }
    } catch {
      /* lost the steal race */
    }
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    window?: string;
    from?: string;
    to?: string;
  } | null;
  const action = body?.action;
  const window = body?.window ?? 'db4';
  const from = body?.from;
  const to = body?.to;

  if (action === 'stop') {
    const pid = runnerPid();
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(STOP, String(Date.now()));

    if (pid) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
        } else {
          try {
            execSync(`kill -9 -${pid}`, { stdio: 'ignore' });
          } catch {
            try { execSync(`pkill -P ${pid}`, { stdio: 'ignore' }); } catch {}
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      } catch (err) {
        console.error('Failed to kill backtest runner process', err);
      }
    }

    try { fs.unlinkSync(RUN_LOCK); } catch {}
    try { fs.unlinkSync(START_LOCK); } catch {}
    try { fs.unlinkSync(STOP); } catch {}

    const curStatus = readJson<Record<string, unknown>>(STATUS);
    const updatedStatus = {
      ...(curStatus ?? {}),
      state: 'stopped',
      message: `Stopped by user after ${curStatus?.done ?? 0} session(s)`,
      current: null,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(STATUS, JSON.stringify(updatedStatus));
    } catch {}

    return NextResponse.json({ success: true, stopping: true, running: false, status: updatedStatus });
  }

  if (action !== 'catchup' && action !== 'rerun') {
    return NextResponse.json({ success: false, error: 'action must be catchup, rerun or stop' }, { status: 400 });
  }
  if (runnerPid()) return NextResponse.json({ success: true, already: true });
  if (!acquireStartLock()) return NextResponse.json({ success: true, already: true });

  try {
    if (fs.existsSync(STOP)) fs.unlinkSync(STOP);
    const logFd = fs.openSync(LOG, 'w');
    const runnerArgs = [RUNNER, '--mode', action, '--window', window];
    if (from && to) {
      runnerArgs.push('--from', from, '--to', to);
    }
    const child = spawn(process.execPath, runnerArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    fs.closeSync(logFd);
    child.unref();
    // Keep the start lock until the runner holds run.lock (or the stale window passes), so a second click or tab
    // in the start-up gap cannot spawn a second runner. The runner's own O_EXCL lock is the final guard either way.
    return NextResponse.json({ success: true, started: true, pid: child.pid });
  } catch (err) {
    try {
      fs.unlinkSync(START_LOCK);
    } catch {
      /* already gone */
    }
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
