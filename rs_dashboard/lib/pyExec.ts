import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = path.resolve(process.cwd(), '..');
export const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');

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
