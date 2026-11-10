import fs from 'fs';
import { spawn } from 'child_process';
import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';
import { readJsonFile } from '@/lib/lockedJsonFile';

// Liveness check + one-shot detached spawn for a Python price bridge that writes a quotes file and a status heartbeat
// (pnf_ws.py, price_ladder_ws.py). Shared so the start-lock rules cannot drift between the two callers.

export interface BridgeLiveness {
  /** The bridge's quotes file, already parsed by the caller (null = absent / unreadable). It carries `updated_ms`. */
  quotes: Record<string, unknown> | null;
  statusFile: string;
  fileStaleMs: number;
  heartbeatStaleMs: number;
}

/** Running = the quotes file is fresh, or the status file says RUNNING with a fresh heartbeat (no instruments asked yet). */
export function bridgeRunning({ quotes, statusFile, fileStaleMs, heartbeatStaleMs }: BridgeLiveness): boolean {
  if (quotes && Date.now() - Number(quotes.updated_ms) <= fileStaleMs) return true;
  const st = readJsonFile<{ status?: string; heartbeat_ms?: number }>(statusFile);
  return !!st && st.status === 'RUNNING' && Date.now() - Number(st.heartbeat_ms) <= heartbeatStaleMs;
}

export interface BridgeSpawn {
  script: string;
  lockFile: string;
  logFile: string;
  /** Console prefix, e.g. `[price-ladder]`. */
  tag: string;
  /** Extra script arguments (the Fresh Money board runs price_ladder_ws.py with `--name fresh_money`). */
  args?: string[];
}

/**
 * Spawn the bridge once across processes: an O_EXCL start lock (stolen after a minute), released 15 s later once the bridge
 * has had time to write its heartbeat; a crash before then is retried by the caller's own start interval. The bridge itself
 * refuses to run twice.
 */
export function startBridge({ script, lockFile, logFile, tag, args = [] }: BridgeSpawn): void {
  const name = script.split(/[\\/]/).pop();
  try {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    } catch {
      if (Date.now() - fs.statSync(lockFile).mtimeMs < 60_000) return; // another process is starting it
      fs.writeFileSync(lockFile, String(process.pid));
    }
    const log = fs.openSync(logFile, 'a');
    const child = spawn(PYTHON_EXE, [script, ...args], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', err => console.warn(`${tag} price bridge failed to start:`, err.message));
    child.unref();
    fs.closeSync(log);
    setTimeout(() => { try { fs.rmSync(lockFile, { force: true }); } catch { /* best effort */ } }, 15_000).unref?.();
    console.log(`${tag} starting the price bridge (${name})`);
  } catch (err) {
    console.warn(`${tag} could not start the price bridge:`, (err as Error).message);
  }
}
