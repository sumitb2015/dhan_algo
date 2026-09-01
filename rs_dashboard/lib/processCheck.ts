import { execSync } from 'child_process';

// tasklist/ps is a blocking child-process spawn (~50-200ms on Windows). Several routes
// poll this every 2-3s to check whether a background Python process is still alive;
// calling it unconditionally on every poll can saturate the single-threaded Node event
// loop and starve concurrent requests. Cache the result per PID.
const PID_CHECK_TTL = 3000;
const cache = new Map<number, { result: boolean; ts: number }>();

// Start times are cached by OBSERVATION CONTINUITY, not by age. Re-querying one on a
// timer is not affordable: `powershell Get-Process` measures ~4.5s on this machine
// (tasklist ~300ms) and runs through execSync, which blocks the whole event loop — a
// short TTL would leave the dashboard blocked more or less permanently while any
// strategy is polled. But a start time never needs re-reading while we have watched
// the PID continuously: process.kill(pid,0) is free, runs on every poll, and drops the
// entry the moment the process dies. So the cached value stays valid for as long as
// the watch is unbroken, and is discarded whenever the chain of observations has a gap
// longer than PID_OBSERVATION_GAP — which is the only window in which a PID could have
// died and been recycled without us noticing.
const PID_OBSERVATION_GAP = 30_000;
const pidStartTimeMap = new Map<number, { ticks: string; ts: number; lastSeen: number }>();

// Every entry here is keyed by a PID, and PIDs are never reused by this process once
// their strategy dies — so without pruning these maps grow for as long as the dashboard
// server stays up (it runs as `next start` for days). Entries are past their TTL and
// therefore worthless anyway; drop them once a map gets unexpectedly large.
const MAX_CACHE_ENTRIES = 500;
function pruneExpired(map: Map<unknown, { ts: number }>): void {
  if (map.size <= MAX_CACHE_ENTRIES) return;
  const cutoff = Date.now() - PID_CHECK_TTL;
  for (const [key, val] of map) {
    if (val.ts < cutoff) map.delete(key);
  }
}

/** Free liveness probe plus the observation bookkeeping that getPidStartTime's cache
 *  depends on. Returns false only when the OS guarantees no process holds this PID.
 *
 *  A `true` here does NOT mean "our python process" — any process could hold a recycled
 *  PID. Callers must add either the image-name check (isPidRunning) or a start-time
 *  match (isPidRunningAt) on top. */
function isPidAlive(pid: number): boolean {
  // Ultra-fast zero-cost native check (0.001ms).
  try {
    process.kill(pid, 0);
  } catch {
    cache.delete(pid);
    pidStartTimeMap.delete(pid);
    return false;
  }

  // Alive. Extend the observation chain that lets getPidStartTime trust its cache —
  // or break it, if nobody has looked at this PID recently enough to rule out that it
  // died and the OS handed the number to a different process in the meantime.
  const seen = pidStartTimeMap.get(pid);
  if (seen) {
    if (Date.now() - seen.lastSeen > PID_OBSERVATION_GAP) pidStartTimeMap.delete(pid);
    else seen.lastSeen = Date.now();
  }
  return true;
}

/** `force` bypasses the cache — use only for short-lived poll loops (e.g. waiting
 *  for a process to exit) where the 3s TTL would otherwise mask the state change. */
export function isPidRunning(pid: number, force = false): boolean {
  if (!pid || isNaN(pid)) return false;

  if (!isPidAlive(pid)) return false;

  const hit = force ? undefined : cache.get(pid);
  if (hit && Date.now() - hit.ts < PID_CHECK_TTL) {
    return hit.result;
  }

  let result: boolean;
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      const lower = out.toLowerCase();
      result = lower.includes('python') && lower.includes(pid.toString());
    } else {
      const out = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      result = out.toLowerCase().includes('python');
    }
  } catch {
    result = false;
  }

  cache.set(pid, { result, ts: Date.now() });
  pruneExpired(cache);
  return result;
}

/** Returns the process's start time (.NET ticks, as a string) or null if it can't be determined.
 *
 *  A given process's start time never changes, but a PID's does — this value exists to
 *  detect that the PID was recycled onto a different process, so caching it
 *  unconditionally forever would let a dead strategy report "running" indefinitely.
 *  The cache is therefore held only while isPidRunning() keeps confirming the PID is
 *  alive without a gap; see PID_OBSERVATION_GAP. That keeps the steady state free of
 *  the ~4.5s blocking PowerShell spawn while still forcing a fresh read after any
 *  window in which a recycle could have gone unseen. */
export function getPidStartTime(pid: number): string | null {
  if (process.platform !== 'win32' || !pid) return null;

  const cached = pidStartTimeMap.get(pid);
  if (cached) return cached.ticks;

  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.Ticks"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
    const ticks = out.trim();
    if (ticks) {
      const now = Date.now();
      pidStartTimeMap.set(pid, { ticks, ts: now, lastSeen: now });
      pruneExpired(pidStartTimeMap);
      return ticks;
    }
    pidStartTimeMap.delete(pid);
    return null;
  } catch {
    pidStartTimeMap.delete(pid);
    return null;
  }
}

const startTimeCache = new Map<string, { result: boolean; ts: number }>();

/**
 * Like isPidRunning, but also verifies the live process's start time matches
 * expectedStartTime (from getPidStartTime() captured when the process was spawned).
 * Windows recycles PIDs — without this check, a crashed/killed process whose PID gets
 * reassigned to an unrelated python(w).exe would look "still running" forever, leaving
 * a dashboard Stop button that writes a shutdown trigger nobody reads. If expectedStartTime
 * is null/undefined (not recorded), falls back to plain PID+image-name matching.
 *
 * Deliberately uses isPidAlive rather than isPidRunning: the ~300ms `tasklist` spawn only
 * establishes that the PID belongs to *a* python process, which a start-time match already
 * implies and more strictly — a recycled PID has a different start time whether or not the
 * new occupant is python. Skipping it removes the last per-poll blocking spawn from this
 * path. isPidRunning keeps the image-name check for callers that have no start time.
 */
export function isPidRunningAt(pid: number, expectedStartTime?: string | null, force = false): boolean {
  if (!expectedStartTime) return isPidRunning(pid, force);
  if (!pid || isNaN(pid)) return false;

  const key = `${pid}:${expectedStartTime}`;
  const hit = force ? undefined : startTimeCache.get(key);
  if (hit && Date.now() - hit.ts < PID_CHECK_TTL) {
    return hit.result;
  }

  const running = isPidAlive(pid);
  const result = running && getPidStartTime(pid) === expectedStartTime;
  startTimeCache.set(key, { result, ts: Date.now() });
  pruneExpired(startTimeCache);
  return result;
}

/** Lowest-numbered child PID of `parentPid`, or null.
 *
 *  Uses Get-CimInstance rather than wmic: WMIC is deprecated and is absent by default on
 *  Windows 11 24H2 and newer, where every call would throw and cost a wasted spawn inside
 *  resolveWorkerPid's retry loop. Sorted so repeated calls return the same child. */
function firstChildPid(parentPid: number): number | null {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Sort-Object ProcessId | Select-Object -First 1 -ExpandProperty ProcessId)"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    ).trim();
    if (!out) return null;
    const pidVal = parseInt(out, 10);
    return !isNaN(pidVal) && pidVal > 0 ? pidVal : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the PID that actually corresponds to a just-spawned strategy process, plus its
 * start time. On Windows, venv's Scripts\pythonw.exe (venvlauncher.exe) is a launcher stub
 * that spawns a SEPARATE real interpreter process and just waits on it — so the PID returned
 * by child_process.spawn() is the launcher, not the one that calls os.getpid() and shows up
 * in the strategy's own state file. Without resolving the real child, PID-identity checks
 * compare the launcher's start time against the worker's PID and never match, making every
 * freshly-launched strategy look immediately "stopped" even though it's running fine.
 * Retries briefly since the child may not be visible to WMI for a few hundred ms after spawn.
 */
export async function resolveWorkerPid(launcherPid: number, timeoutMs = 3000): Promise<{ pid: number; startTime: string } | null> {
  if (process.platform !== 'win32') {
    return { pid: launcherPid, startTime: '' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const childPid = firstChildPid(launcherPid);
    if (childPid) {
      const startTime = getPidStartTime(childPid);
      if (startTime) return { pid: childPid, startTime };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // No child found within the window (e.g. a venv without the launcher stub) — the
  // launcher process itself is the real worker.
  const startTime = getPidStartTime(launcherPid);
  return startTime ? { pid: launcherPid, startTime } : { pid: launcherPid, startTime: '' };
}
