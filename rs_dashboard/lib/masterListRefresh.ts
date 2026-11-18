/**
 * Keeps master_list.csv current while the dashboard runs, so pages that read it directly (Renko / P&F contract pickers,
 * equity search, order tickets) never sit on a months-old file whose futures have all expired and that may have lost MCX.
 * The rules and the download live in Python (lib/master_list_refresh.py via scripts/tools/refresh_master_list.py); this
 * only decides when to ask. Readers already re-parse on a changed mtime (e.g. lib/pnfContracts.ts), so nothing restarts.
 *
 * Checks every CHECK_MS; spawns the script when the file was written on an earlier IST day, at most once per RETRY_MS
 * (a failed download or no Dhan session must not retry every check). The script itself never logs in, so with no
 * current session it reports `no-session` and the next attempt waits for RETRY_MS. Instrument lists only — no orders.
 */
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import { globalOnce } from '@/lib/globalOnce';
import { shouldRefreshMasterList } from '@/lib/masterListRefreshRules';

const MASTER = path.join(PROJECT_ROOT, 'master_list.csv');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'refresh_master_list.py');
const CHECK_MS = 10 * 60_000;
const TIMEOUT_MS = 5 * 60_000;

type Shared = { started: boolean; inFlight: boolean; lastAttempt: number | null };
const state = () => globalOnce<Shared>('__masterListRefresh', () => ({ started: false, inFlight: false, lastAttempt: null }));

function mtimeOf(): number | null {
  try { return fs.statSync(MASTER).mtimeMs; } catch { return null; }
}

async function tick(): Promise<void> {
  const s = state();
  const now = Date.now();
  if (!shouldRefreshMasterList(mtimeOf(), now, s.lastAttempt, s.inFlight)) return;
  s.inFlight = true;
  s.lastAttempt = now;
  try {
    const r = await runPythonJson<{ status: string; reason?: string; rows?: number }>(SCRIPT, [], TIMEOUT_MS);
    console.log(`[master-list] ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.rows ? `, ${r.rows} rows` : ''}`);
  } catch (err) {
    // non-zero exit = failed / no-session; its JSON line is in the error's stdout
    const out = (err as { stdout?: string }).stdout?.trim().split('\n').pop();
    console.warn(`[master-list] refresh did not complete: ${out || (err as Error).message}`);
  } finally {
    s.inFlight = false;
  }
}

export function startMasterListRefreshScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  setTimeout(() => { void tick(); }, 15_000);   // let the server finish starting first
  setInterval(() => { void tick(); }, CHECK_MS).unref?.();
}
