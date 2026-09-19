import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import fs from 'fs';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = path.resolve(process.cwd(), '..');

function resolvePythonExe(): string {
  const candidates = process.platform === 'win32'
    ? [
        path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe'),
        path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(PROJECT_ROOT, 'venv', 'bin', 'python3'),
        path.join(PROJECT_ROOT, 'venv', 'bin', 'python'),
        path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe'),
        path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe'),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

export const PYTHON_EXE = resolvePythonExe();

/**
 * Run a Python script asynchronously (never blocks the Node event loop,
 * unlike spawnSync) and parse the last stdout line as JSON.
 * Rejects on spawn failure, non-zero exit, or timeout.
 */
export async function runPythonJson<T>(script: string, args: string[], timeoutMs: number): Promise<T> {
  const { stdout } = await execFileAsync(PYTHON_EXE, [script, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
  return JSON.parse(jsonLine) as T;
}

// In-flight request dedup: concurrent requests for the same key share one
// Python spawn instead of stacking processes.
const inflight = new Map<string, Promise<unknown>>();

export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Cross-route pacing: Dhan's option-chain/OHLC REST endpoints are rate-limited
// per account (~1 call/3s), but DhanHelper's in-process spacing only protects
// calls within a single spawned Python process. Two routes (chain, spot) can
// each spawn a fresh process for the same underlying at the same moment and
// race the same rate limit. This serializes those spawns per key.
const paceChains = new Map<string, Promise<unknown>>();
const MIN_GAP_MS = 3_500;

export function spaced<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = paceChains.get(key) ?? Promise.resolve();
  const run = prior.then(() => fn());
  // The lane stays reserved for MIN_GAP_MS after fn settles, so consecutive
  // spawns are spaced exactly as before. The gap used to sit inside `run`,
  // which made every caller wait it out before receiving a result it already
  // had; now only the NEXT caller in the lane waits. Errors still release the
  // lane (after the gap) without wedging it, and still flow to `run`.
  paceChains.set(
    key,
    run.then(() => undefined, () => undefined).then(() => new Promise<void>(resolve => setTimeout(resolve, MIN_GAP_MS))),
  );
  return run;
}
