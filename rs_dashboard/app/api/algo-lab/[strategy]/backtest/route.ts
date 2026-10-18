import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';
import { isRegularSession } from '@/lib/nseHolidays';
import { getStrategy, strategyConfig } from '@/lib/algoLab/registry';
import { configKey } from '@/lib/algoLab/configSchema';
import { BT_WINDOWS, sessionsToHold, type BtStore, type BtWindow } from '@/lib/algoLab/runStore';

// Algo Lab backtest of one strategy: GET = stored results + run status + what is missing; POST = start a run
// (scripts/algo-lab-backtest.ts, detached) or stop one. Market data only: the runner reads the local options DB.

const ROOT_DIR = path.join(PROJECT_ROOT, 'debug', 'algo_lab');
const RUNNER = path.join(process.cwd(), 'scripts', 'algo-lab-backtest.ts');
const DATA_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'algo_lab_backtest_data.py');
/** Covers the gap between spawn and the runner taking its own run.lock (node start-up). */
const START_LOCK_STALE_MS = 20_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const readJson = <T,>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

const paths = (key: string) => {
  const dir = path.join(ROOT_DIR, `${key}_backtest`);
  return {
    dir,
    store: path.join(dir, 'results.json'),
    status: path.join(dir, 'status.json'),
    stop: path.join(dir, 'stop.trigger'),
    runLock: path.join(dir, 'run.lock'),
    startLock: path.join(dir, 'start.lock'),
    log: path.join(dir, 'runner.log'),
    ledger: path.join(ROOT_DIR, `${key}_state.json`),
  };
};

function runnerPid(runLock: string): number | null {
  try {
    const pid = Number(fs.readFileSync(runLock, 'utf8').trim());
    return pid && isPidRunning(pid, true, /(node|tsx)/i) ? pid : null;
  } catch {
    return null;
  }
}

let dbRangeCache: { at: number; v: { earliest: string; latest: string } | null } = { at: 0, v: null };
async function dbRange(): Promise<{ earliest: string; latest: string } | null> {
  if (Date.now() - dbRangeCache.at < 10 * 60_000) return dbRangeCache.v;
  const r = await dedupe('algo-lab-db-range', () =>
    runPythonJson<{ ok?: boolean; earliest?: string; latest?: string }>(DATA_SCRIPT, ['--db-range'], 20_000).catch(() => null),
  );
  const v = r?.ok && r.earliest && r.latest ? { earliest: r.earliest, latest: r.latest } : null;
  dbRangeCache = { at: Date.now(), v };
  return v;
}

const istNow = () => new Date(Date.now() + 5.5 * 3600_000).toISOString();

export async function GET(request: NextRequest, { params }: { params: Promise<{ strategy: string }> }) {
  const { strategy } = await params;
  const def = getStrategy(strategy);
  if (!def) return NextResponse.json({ success: false, error: 'unknown strategy' }, { status: 404 });
  const p = paths(def.key);
  const { fields, normalize } = strategyConfig(def);
  const store = readJson<BtStore>(p.store);
  // The page sends the version it holds (store.updatedAt): while that is current the reply carries status only.
  const known = new URL(request.url).searchParams.get('known');
  const unchanged = !!store?.updatedAt && known === store.updatedAt;
  const status = readJson<Record<string, unknown>>(p.status);
  const pid = runnerPid(p.runLock);
  const isStarting = !pid && fs.existsSync(p.startLock) && Date.now() - fs.statSync(p.startLock).mtimeMs < START_LOCK_STALE_MS;
  const running = pid != null || isStarting;
  const config = normalize(readJson<{ config?: unknown }>(p.ledger)?.config);
  const key = configKey(fields, config);
  const now = istNow();
  const missing = store
    ? sessionsToHold(store.from, now.slice(0, 10), now.slice(11, 16), isRegularSession, store.to).filter((d) => !store.days[d])
    : [];
  // A status left at "running" by a runner that died (killed, machine slept) is reported as interrupted.
  const runStatus = status && status.state === 'running' && !running ? { ...status, state: 'interrupted' } : status;
  return NextResponse.json({
    success: true,
    unchanged,
    running,
    status: isStarting && (!status || status.state !== 'running') ? { state: 'starting', message: 'Starting backtest…' } : runStatus,
    dbRange: await dbRange(),
    missing,
    configKey: key,
    rulesChanged: store ? store.configKey !== key : false,
    store: store
      ? {
          from: store.from,
          to: store.to,
          window: store.window,
          updatedAt: store.updatedAt,
          config: store.config,
          failures: store.failures ?? {},
          audit: store.audit ?? null,
          days: unchanged ? null : Object.values(store.days ?? {}).sort((a, b) => b.date.localeCompare(a.date)),
        }
      : null,
  });
}

function acquireStartLock(dir: string, startLock: string): boolean {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(startLock, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(startLock).mtimeMs > START_LOCK_STALE_MS) {
        fs.unlinkSync(startLock);
        fs.writeFileSync(startLock, String(Date.now()), { flag: 'wx' });
        return true;
      }
    } catch {
      /* lost the steal race */
    }
    return false;
  }
}

function killTree(pid: number) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    else {
      try {
        process.kill(-pid, 'SIGKILL'); // detached runner leads its own process group (it and its Python child)
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* already gone */
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ strategy: string }> }) {
  const { strategy } = await params;
  const def = getStrategy(strategy);
  if (!def) return NextResponse.json({ success: false, error: 'unknown strategy' }, { status: 404 });
  const p = paths(def.key);
  const body = (await request.json().catch(() => null)) as { action?: string; window?: string; from?: string; to?: string } | null;
  const action = body?.action;

  if (action === 'stop') {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.stop, String(Date.now()));
    const pid = runnerPid(p.runLock);
    if (pid) killTree(pid);
    for (const f of [p.runLock, p.startLock, p.stop]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* gone */
      }
    }
    const cur = readJson<Record<string, unknown>>(p.status) ?? {};
    const next = { ...cur, state: 'stopped', message: `Stopped by user after ${cur.done ?? 0} session(s)`, current: null, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    try {
      fs.writeFileSync(p.status, JSON.stringify(next));
    } catch {
      /* best effort */
    }
    return NextResponse.json({ success: true, running: false, status: next });
  }

  if (action !== 'catchup' && action !== 'rerun') {
    return NextResponse.json({ success: false, error: 'action must be catchup, rerun or stop' }, { status: 400 });
  }
  const window = (BT_WINDOWS.includes(body?.window as BtWindow) ? body!.window : 'db4') as BtWindow;
  const from = body?.from;
  const to = body?.to;
  if (window === 'custom' && !(from && to && ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to)) {
    return NextResponse.json({ success: false, error: 'custom range needs from <= to (YYYY-MM-DD)' }, { status: 400 });
  }
  if (runnerPid(p.runLock)) return NextResponse.json({ success: true, already: true });
  if (!acquireStartLock(p.dir, p.startLock)) return NextResponse.json({ success: true, already: true });

  try {
    if (fs.existsSync(p.stop)) fs.unlinkSync(p.stop);
    const logFd = fs.openSync(p.log, 'w');
    const args = [RUNNER, '--strategy', def.key, '--mode', action, '--window', window];
    if (window === 'custom') args.push('--from', from!, '--to', to!);
    const child = spawn(process.execPath, args, { cwd: process.cwd(), detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
    fs.closeSync(logFd);
    child.unref();
    // The start lock stays until the runner holds run.lock (or goes stale), so a second click cannot spawn twice.
    return NextResponse.json({ success: true, started: true, pid: child.pid });
  } catch (err) {
    try {
      fs.unlinkSync(p.startLock);
    } catch {
      /* gone */
    }
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
