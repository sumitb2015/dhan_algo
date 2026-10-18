// Breakdown Scalper daily backtest runner (the /breakdown-scalper "Strategy Backtest" panel).
//
// Spawned detached by app/api/breakdown-scalper/backtest/route.ts so a month of simulation never blocks the
// dashboard server. For every regular NSE session from the store's start date through today (today only after
// 15:35 IST) that the store does not hold yet, it:
//   1. builds/loads the session's 1-minute NIFTY option bars (scripts/tools/breakdown_backtest_data.py, Dhan-only);
//   2. replays them through lib/breakdownBacktest.ts simulateDay with the page's CURRENT rules (the ledger config);
//   3. appends the day to debug/breakdown_backtest/results.json (atomic write after every day).
//
// Modes: --mode catchup (append missing days; refuses if the page's rules changed since the store was built)
//        --mode rerun   (drop all days and rebuild with the current rules; --window week|month|db4, default week)
//                       db4 = the latest 4 weeks held in the local options DB, offline (no Dhan calls at all)
// Status: debug/breakdown_backtest/status.json. Stop: write debug/breakdown_backtest/stop.trigger.
// One runner at a time: debug/breakdown_backtest/run.lock (pid, created with O_EXCL; stolen only from a dead pid).
//
// Run by hand: node scripts/breakdown-backtest.ts --mode catchup   (from rs_dashboard/)

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  backfillStart,
  backtestConfigKey,
  sessionsToHold,
  simulateDay,
  type BtBar,
  type BtDayData,
  type BtStore,
  type BtWindow,
} from '../lib/breakdownBacktest.ts';
import { DEFAULT_CONFIG, istDayOf, normalizeConfig } from '../lib/breakdownLedger.ts';
import { isRegularSession } from '../lib/nseHolidays.ts';
import { PROJECT_ROOT, PYTHON_EXE } from '../lib/pyExec.ts';

const DIR = path.join(PROJECT_ROOT, 'debug', 'breakdown_backtest');
const STORE = path.join(DIR, 'results.json');
const STATUS = path.join(DIR, 'status.json');
const STOP = path.join(DIR, 'stop.trigger');
const LOCK = path.join(DIR, 'run.lock');
const LEDGER = path.join(PROJECT_ROOT, 'debug', 'breakdown_scalper_state.json');
const DATA_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'breakdown_backtest_data.py');
// A cold expiry week from Dhan's expired-options API is 42-84 calls at ~25 s each (4 in parallel): allow an hour.
const DATA_TIMEOUT_MS = 60 * 60_000;
const DATA_PROGRESS = path.join(DIR, 'data_progress.json');

const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'catchup';
if (mode !== 'catchup' && mode !== 'rerun') {
  console.error(`unknown --mode ${mode}`);
  process.exit(2);
}

const windowArg = process.argv.includes('--window') ? process.argv[process.argv.indexOf('--window') + 1] : 'week';
const btWindow: BtWindow = windowArg === 'month' ? 'month' : windowArg === 'db4' ? 'db4' : 'week';

const nowIso = () => new Date().toISOString();
const istHm = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 16);

function writeJsonAtomic(file: string, data: unknown) {
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireLock(): boolean {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    const holder = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (holder && pidAlive(holder)) return false;
    try {
      fs.unlinkSync(LOCK);
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      return false; // another runner won the steal
    }
  }
}

interface Status {
  state: 'running' | 'done' | 'error' | 'stopped';
  mode: string;
  pid: number;
  total: number;
  done: number;
  current: string | null;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  failed: string[];
}
const status: Status = {
  state: 'running',
  mode,
  pid: process.pid,
  total: 0,
  done: 0,
  current: null,
  message: 'Starting…',
  startedAt: nowIso(),
  updatedAt: nowIso(),
  finishedAt: null,
  failed: [],
};
const saveStatus = (patch: Partial<Status>) => {
  Object.assign(status, patch, { updatedAt: nowIso() });
  writeJsonAtomic(STATUS, status);
};

function stopRequested(): boolean {
  if (!fs.existsSync(STOP)) return false;
  try {
    fs.unlinkSync(STOP);
  } catch {
    /* already gone */
  }
  return true;
}

function runPy(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    execFile(PYTHON_EXE, [DATA_SCRIPT, ...args], { cwd: PROJECT_ROOT, timeout: DATA_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const line = (stdout ?? '').trim().split('\n').pop() ?? '';
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: err ? String(err.message).slice(0, 300) : line.slice(0, 200) });
      }
    });
  });
}

function runData(date: string, offline: boolean): Promise<{ ok: boolean; path?: string; source?: string; error?: string; retry?: boolean }> {
  return new Promise((resolve) => {
    execFile(
      PYTHON_EXE,
      [DATA_SCRIPT, '--date', date, ...(offline ? ['--offline'] : [])],
      { cwd: PROJECT_ROOT, timeout: DATA_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const line = (stdout ?? '').trim().split('\n').pop() ?? '';
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: err ? String(err.message).slice(0, 300) : `bad output: ${line.slice(0, 200)}`, retry: true });
        }
      },
    );
  });
}

type RawDay = Omit<BtDayData, 'contracts'> & {
  contracts: Record<string, { strike: number; option: 'CE' | 'PE'; bars: [string, number, number, number, number, number, number | null][] }>;
};

function loadDay(file: string): BtDayData {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawDay;
  const contracts: BtDayData['contracts'] = {};
  for (const [k, c] of Object.entries(raw.contracts)) {
    contracts[k] = {
      strike: c.strike,
      option: c.option,
      bars: c.bars.map(([t, o, h, l, cl, v, oi]): BtBar => ({ t: `${t}:00`, o, h, l, c: cl, v: v ?? 0, oi })),
    };
  }
  return { ...raw, contracts };
}

async function main() {
  if (!acquireLock()) {
    console.log(JSON.stringify({ ok: false, error: 'another backtest run is in progress' }));
    return;
  }
  try {
    fs.unlinkSync(path.join(DIR, 'start.lock')); // the API route's spawn guard: this runner now holds run.lock
  } catch {
    /* started by hand, or already gone */
  }
  try {
    let ledgerConfig: unknown = DEFAULT_CONFIG;
    try {
      ledgerConfig = (JSON.parse(fs.readFileSync(LEDGER, 'utf8')) as { config?: unknown }).config;
    } catch {
      /* no ledger yet: defaults */
    }
    let store: BtStore | null = null;
    try {
      store = JSON.parse(fs.readFileSync(STORE, 'utf8')) as BtStore;
    } catch {
      store = null;
    }
    const offline = mode === 'rerun' ? btWindow === 'db4' : !!store?.offline;

    // Dhan's expired-options endpoint is slow and its rate limit is account-wide: never run alongside the options
    // downloader (scripts/downloader/download_expired_options.py, status in debug/options_refresh_status.json).
    // An offline (DB-only) run makes no Dhan calls and may run at any time.
    if (!offline) try {
      const dl = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'debug', 'options_refresh_status.json'), 'utf8')) as {
        done?: boolean;
        pid?: number;
      };
      if (dl.done === false && dl.pid && pidAlive(dl.pid)) {
        saveStatus({
          state: 'stopped',
          message: 'Waiting: the expired-options download is running (same Dhan API). Run again once it finishes.',
          finishedAt: nowIso(),
        });
        return;
      }
    } catch {
      /* no downloader status: not running */
    }
    const config = normalizeConfig(ledgerConfig);
    const key = backtestConfigKey(config);
    const today = istDayOf(Date.now());

    if (store && store.configKey !== key && mode === 'catchup') {
      saveStatus({
        state: 'error',
        message: 'The page rules changed since this backtest was built. Use "Re-run month" to rebuild with the current rules.',
        finishedAt: nowIso(),
      });
      return;
    }
    if (!store || mode === 'rerun') {
      let from = backfillStart(today, btWindow);
      let to: string | null = null;
      if (btWindow === 'db4') {
        const latest = await runPy(['--db-latest']);
        if (!latest.ok || typeof latest.latest !== 'string' || !latest.latest) {
          saveStatus({ state: 'error', message: `Cannot read the options DB: ${String(latest.error ?? 'empty')}`, finishedAt: nowIso() });
          return;
        }
        to = latest.latest;
        const d = new Date(`${to}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 28);
        from = d.toISOString().slice(0, 10);
      }
      store = {
        version: 1,
        underlying: 'NIFTY',
        configKey: key,
        config,
        from,
        to,
        offline,
        window: btWindow,
        updatedAt: null,
        days: {},
        failures: {},
      };
      writeJsonAtomic(STORE, store);
    }

    const sessions = sessionsToHold(store.from, today, istHm(), isRegularSession, store.to ?? null);
    const missing = sessions.filter((d) => !store!.days[d]);
    saveStatus({ total: missing.length, message: missing.length ? `${missing.length} session(s) to backtest` : 'Up to date' });

    for (const date of missing) {
      if (stopRequested()) {
        saveStatus({ state: 'stopped', message: `Stopped by user after ${status.done} session(s)`, current: null, finishedAt: nowIso() });
        return;
      }
      saveStatus({ current: date, message: `Loading data for ${date}…` });
      // Relay the data script's own progress (slow expired-options fetches) into the status the panel shows.
      const relay = setInterval(() => {
        try {
          const p = JSON.parse(fs.readFileSync(DATA_PROGRESS, 'utf8')) as { date: string; step: string; done: number; total: number };
          if (p.date === date) saveStatus({ message: `Loading ${date}: ${p.step}${p.total ? ` (${p.done}/${p.total} calls)` : ''}…` });
        } catch {
          /* no progress yet */
        }
      }, 2000);
      const res = await runData(date, offline).finally(() => clearInterval(relay));
      if (!res.ok || !res.path) {
        store.failures[date] = { at: nowIso(), error: res.error ?? 'unknown error' };
        writeJsonAtomic(STORE, store);
        status.failed.push(date);
        saveStatus({ done: status.done + 1, message: `${date}: ${res.error}` });
        // A Dhan-side failure (login, rate limit) will hit every later day too: stop and retry on the next catch-up.
        if (res.retry && /login|token|rate|DH-9|429|805/i.test(res.error ?? '')) {
          saveStatus({ state: 'error', current: null, message: `Stopped: ${res.error}`, finishedAt: nowIso() });
          return;
        }
        continue;
      }
      saveStatus({ message: `Simulating ${date} (${res.source})…` });
      const result = simulateDay(loadDay(res.path), config);
      store.days[date] = result;
      delete store.failures[date];
      store.updatedAt = nowIso();
      writeJsonAtomic(STORE, store);
      saveStatus({ done: status.done + 1, message: `${date}: ${result.trades.length} trade(s), net ₹${result.net.toFixed(0)}` });
    }
    saveStatus({
      state: status.failed.length ? 'error' : 'done',
      current: null,
      message: status.failed.length
        ? `Finished with ${status.failed.length} session(s) unavailable: ${status.failed.join(', ')}`
        : `Up to date through ${sessions[sessions.length - 1] ?? today}`,
      finishedAt: nowIso(),
    });
  } catch (e) {
    saveStatus({ state: 'error', current: null, message: `Runner crashed: ${String((e as Error).message ?? e)}`, finishedAt: nowIso() });
    throw e;
  } finally {
    try {
      if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK);
    } catch {
      /* lock already gone */
    }
  }
}

void main();
