// Algo Lab backtest runner (the /algo-lab Backtest tab), one strategy per run.
//
// Spawned detached by app/api/algo-lab/[strategy]/backtest/route.ts so a long simulation never blocks the dashboard
// server. For every regular NSE session of the run's range that the store does not hold yet it:
//   1. builds/loads the session's 1-minute NIFTY option bars (scripts/tools/algo_lab_backtest_data.py, options DB only);
//   2. replays them through lib/algoLab/simulator.ts with the strategy's CURRENT rules (its ledger config);
//   3. appends the day to debug/algo_lab/<key>_backtest/results.json (atomic write after every day);
// then audits the whole store (lib/algoLab/audit.ts).
//
// Modes: --mode catchup (append missing days; refuses if the rules changed since the store was built)
//        --mode rerun   (drop all days and rebuild; --window week|month|db4|3months|6months|1year|all, or --from/--to)
// Status: <dir>/status.json. Stop: write <dir>/stop.trigger. One runner per strategy: <dir>/run.lock (pid, O_EXCL).
//
// By hand (from rs_dashboard/): node scripts/algo-lab-backtest.ts --strategy vwap_momentum_buyer --mode rerun --window db4

import fs from 'node:fs';
import path from 'node:path';
import { execFile, type ChildProcess } from 'node:child_process';
import { getStrategy, strategyConfig } from '../lib/algoLab/registry.ts';
import { configKey } from '../lib/algoLab/configSchema.ts';
import { simulateDay, type BtBar, type DayData } from '../lib/algoLab/simulator.ts';
import { auditResults } from '../lib/algoLab/audit.ts';
import { BT_WINDOWS, sessionsToHold, windowFrom, type BtStore, type BtWindow } from '../lib/algoLab/runStore.ts';
import { isRegularSession } from '../lib/nseHolidays.ts';
import { PROJECT_ROOT, PYTHON_EXE } from '../lib/pyExec.ts';

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

const def = getStrategy(arg('--strategy'));
if (!def) {
  console.error(`unknown --strategy ${arg('--strategy')}`);
  process.exit(2);
}
const mode = arg('--mode') ?? 'catchup';
if (mode !== 'catchup' && mode !== 'rerun') {
  console.error(`unknown --mode ${mode}`);
  process.exit(2);
}
const fromArg = arg('--from');
const toArg = arg('--to');
const windowArg = arg('--window') ?? 'db4';
const btWindow: BtWindow = fromArg && toArg ? 'custom' : BT_WINDOWS.includes(windowArg as BtWindow) ? (windowArg as BtWindow) : 'db4';

const ROOT_DIR = path.join(PROJECT_ROOT, 'debug', 'algo_lab');
const DIR = path.join(ROOT_DIR, `${def.key}_backtest`);
const STORE = path.join(DIR, 'results.json');
const STATUS = path.join(DIR, 'status.json');
const STOP = path.join(DIR, 'stop.trigger');
const LOCK = path.join(DIR, 'run.lock');
const LEDGER = path.join(ROOT_DIR, `${def.key}_state.json`);
const DATA_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'algo_lab_backtest_data.py');
const DATA_TIMEOUT_MS = 120_000;

const nowIso = () => new Date().toISOString();
const istNow = () => new Date(Date.now() + 5.5 * 3600_000).toISOString();

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

let activeChild: ChildProcess | null = null;
function runPy(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    activeChild = execFile(
      PYTHON_EXE,
      [DATA_SCRIPT, ...args],
      { cwd: PROJECT_ROOT, timeout: DATA_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        activeChild = null;
        const line = (stdout ?? '').trim().split('\n').pop() ?? '';
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: err ? String(err.message).slice(0, 300) : `bad output: ${line.slice(0, 200)}` });
        }
      },
    );
  });
}

type RawDay = Omit<DayData, 'contracts'> & {
  contracts: Record<string, { strike: number; option: 'CE' | 'PE'; bars: [string, number, number, number, number, number, number | null][] }>;
};

function loadDay(file: string): DayData {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawDay;
  const contracts: DayData['contracts'] = {};
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
    console.log(JSON.stringify({ ok: false, error: 'another backtest run of this strategy is in progress' }));
    return;
  }
  try {
    fs.unlinkSync(path.join(DIR, 'start.lock')); // the API route's spawn guard: this runner now holds run.lock
  } catch {
    /* started by hand, or already gone */
  }
  try {
    const { fields, normalize } = strategyConfig(def!);
    let stored: unknown = null;
    try {
      stored = (JSON.parse(fs.readFileSync(LEDGER, 'utf8')) as { config?: unknown }).config;
    } catch {
      /* no ledger yet: defaults */
    }
    const config = normalize(stored);
    const key = configKey(fields, config);
    let store: BtStore | null = null;
    try {
      store = JSON.parse(fs.readFileSync(STORE, 'utf8')) as BtStore;
    } catch {
      store = null;
    }

    if (store && store.configKey !== key && mode === 'catchup') {
      saveStatus({ state: 'error', message: 'The rules changed since these results were built. Use Re-run.', finishedAt: nowIso() });
      return;
    }
    if (!store || mode === 'rerun') {
      const db = await runPy(['--db-range']);
      if (!db.ok || typeof db.latest !== 'string' || !db.latest) {
        saveStatus({ state: 'error', message: `Cannot read the options DB: ${String(db.error ?? 'empty')}`, finishedAt: nowIso() });
        return;
      }
      const earliest = typeof db.earliest === 'string' ? db.earliest : db.latest;
      const from = btWindow === 'custom' ? fromArg! : windowFrom(btWindow, db.latest, earliest);
      const to = btWindow === 'custom' ? toArg! : db.latest;
      store = {
        version: 1,
        strategy: def!.key,
        underlying: 'NIFTY',
        configKey: key,
        config,
        from,
        to,
        window: btWindow,
        updatedAt: null,
        days: {},
        failures: {},
        audit: null,
      };
      writeJsonAtomic(STORE, store);
    }

    const iso = istNow();
    const sessions = sessionsToHold(store.from, iso.slice(0, 10), iso.slice(11, 16), isRegularSession, store.to);
    const missing = sessions.filter((d) => !store!.days[d]);
    saveStatus({ total: missing.length, message: missing.length ? `${missing.length} session(s) to backtest (${store.from} → ${store.to ?? 'today'})` : 'Up to date' });

    for (const date of missing) {
      if (stopRequested()) {
        if (activeChild) activeChild.kill('SIGKILL');
        saveStatus({ state: 'stopped', message: `Stopped by user after ${status.done} session(s)`, current: null, finishedAt: nowIso() });
        return;
      }
      saveStatus({ current: date, message: `Loading ${date}…` });
      const res = await runPy(['--date', date]);
      if (!res.ok || typeof res.path !== 'string') {
        store.failures[date] = { at: nowIso(), error: String(res.error ?? 'unknown error') };
        status.failed.push(date);
        writeJsonAtomic(STORE, store);
        saveStatus({ done: status.done + 1, message: `${date}: ${String(res.error)}` });
        continue;
      }
      saveStatus({ message: `Simulating ${date}…` });
      const result = simulateDay(def!, loadDay(res.path), config);
      store.days[date] = result;
      delete store.failures[date];
      store.updatedAt = nowIso();
      writeJsonAtomic(STORE, store);
      saveStatus({ done: status.done + 1, message: `${date}: ${result.trades.length} trade(s), net ₹${result.net.toFixed(0)}` });
    }

    saveStatus({ current: null, message: 'Auditing results against the bar data…' });
    store.audit = auditResults(def!, Object.values(store.days), config, key, (d) => {
      try {
        return loadDay(path.join(ROOT_DIR, 'data', `${d}.json`));
      } catch {
        return null;
      }
    });
    store.updatedAt = nowIso();
    writeJsonAtomic(STORE, store);
    saveStatus({
      state: status.failed.length ? 'error' : 'done',
      current: null,
      message: status.failed.length
        ? `Finished with ${status.failed.length} session(s) unavailable: ${status.failed.slice(0, 5).join(', ')}`
        : `Up to date through ${sessions[sessions.length - 1] ?? store.to}`,
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
