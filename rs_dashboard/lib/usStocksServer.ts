// Server-only: the US instrument master, cached on disk (debug/us_stock_scrip_master.csv) and in memory.
// Parsing/search is pure and lives in lib/usStocks.ts.
import fs from 'fs';
import path from 'path';
import { bridgeHealth, parseUsScripMaster, type BridgeHealth, type BridgeStatus, type RawUsQuote, type UsInstrument } from '@/lib/usStocks';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const MASTER_FILE = path.join(DEBUG_DIR, 'us_stock_scrip_master.csv');
const MASTER_URL = 'https://api-global-stocks.dhan.co/api-data/us-stock-scrip-master.csv';
const MAX_AGE_MS = 24 * 3600_000;

export interface UsMaster { list: UsInstrument[]; byId: Map<string, UsInstrument>; ids: Set<string>; loadedFrom: 'disk' | 'download' | 'stale-disk' }

let mem: { mtimeMs: number; master: UsMaster } | null = null;
let downloading: Promise<void> | null = null;
// A failed refresh is remembered so a poll every 1.5 s does not retry a (possibly 30 s) download on every call.
let lastFail: { at: number; message: string } | null = null;
const RETRY_AFTER_FAIL_MS = 10 * 60_000;      // a good cache exists: try again in the background after this
const FIRST_RUN_RETRY_MS = 30_000;            // no cache at all: fail fast for this long, then try again

async function download(): Promise<void> {
  const res = await fetch(MASTER_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`US instrument list HTTP ${res.status}`);
  const text = await res.text();
  // Refuse to overwrite a good cache with an error page or a truncated body.
  if (parseUsScripMaster(text).length < 1000) throw new Error('US instrument list looked empty or malformed - kept the cached copy');
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const tmp = `${MASTER_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, MASTER_FILE);
}

function startDownload(): Promise<void> {
  if (!downloading) {
    downloading = download()
      .then(() => { lastFail = null; })
      .catch(err => { lastFail = { at: Date.now(), message: err instanceof Error ? err.message : 'US instrument list unavailable' }; throw err; })
      .finally(() => { downloading = null; });
  }
  return downloading;
}

function fromDisk(source: UsMaster['loadedFrom']): UsMaster | null {
  try {
    const st = fs.statSync(MASTER_FILE);
    if (mem && mem.mtimeMs === st.mtimeMs) return { ...mem.master, loadedFrom: source };
    const list = parseUsScripMaster(fs.readFileSync(MASTER_FILE, 'utf8'));
    if (list.length === 0) return null;
    const master: UsMaster = { list, byId: new Map(list.map(i => [i.id, i])), ids: new Set(list.map(i => i.id)), loadedFrom: source };
    mem = { mtimeMs: st.mtimeMs, master };
    return master;
  } catch { return null; }
}

/** The instrument master. Stale-while-revalidate: any cached file is returned immediately; one older than a day also starts
 *  a background refresh (shared between callers, and not retried for 10 minutes after a failure). Only a machine with NO cached
 *  copy waits for the download, and a failure there is remembered for 30 s so polling does not queue 30 s hangs. A caller on
 *  the 1.5 s live-quote poll therefore never waits on Dhan's CDN once a copy exists. */
export async function getUsMaster(): Promise<UsMaster> {
  let age = Infinity;
  try { age = Date.now() - fs.statSync(MASTER_FILE).mtimeMs; } catch { /* no cache yet */ }

  const cached = fromDisk(age < MAX_AGE_MS ? 'disk' : 'stale-disk');
  if (cached) {
    if (age >= MAX_AGE_MS && !(lastFail && Date.now() - lastFail.at < RETRY_AFTER_FAIL_MS)) startDownload().catch(() => { /* recorded in lastFail */ });
    return cached;
  }

  if (!downloading && lastFail && Date.now() - lastFail.at < FIRST_RUN_RETRY_MS) throw new Error(lastFail.message);
  await startDownload();
  const fresh = fromDisk('download');
  if (fresh) return fresh;
  throw new Error('US instrument list unavailable');
}

const UNIVERSE_FILE = path.join(DEBUG_DIR, 'live_us_universe.json');

export interface UniverseFile { enabled: boolean; ids: string[] }

/** debug/live_us_universe.json - read by scripts/tools/live_us_ws.py (subscribed only while enabled). Missing = off. */
export function readUniverseFile(): UniverseFile {
  try {
    const j = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8')) as { enabled?: unknown; ids?: unknown };
    const ids = Array.isArray(j.ids) ? j.ids.map(String).filter(s => /^\d{1,9}$/.test(s)) : [];
    return { enabled: j.enabled === true, ids };
  } catch { return { enabled: false, ids: [] }; }
}

export function writeUniverseFile(u: UniverseFile): void {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const tmp = `${UNIVERSE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ enabled: u.enabled, ids: u.ids, updated_at: Date.now() }));
  fs.renameSync(tmp, UNIVERSE_FILE);
}

function readJsonFile<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

export interface UsQuotesFile { updated_at?: number; connected?: boolean; market_status?: unknown; quotes?: Record<string, RawUsQuote> }

/** The bridge's last quotes snapshot (may be from an earlier session - judge it by `updated_at` and the bridge health). */
export function readUsQuotes(): UsQuotesFile | null {
  return readJsonFile<UsQuotesFile>(path.join(DEBUG_DIR, 'live_us_quotes.json'));
}

/** Bridge health from its status file + a pid check (the same rule the /api/live-us route uses). */
export function readUsBridgeHealth(): { status: BridgeStatus | null; health: BridgeHealth } {
  const status = readJsonFile<BridgeStatus>(path.join(DEBUG_DIR, 'live_us_status.json'));
  const alive = typeof status?.pid === 'number' ? isPidRunning(status.pid) : false;
  return { status, health: bridgeHealth(status, alive, Date.now()) };
}

export { DEBUG_DIR as US_DEBUG_DIR };
