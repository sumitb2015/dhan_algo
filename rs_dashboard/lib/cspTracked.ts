import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

const TRACKED_FILE = path.join(PROJECT_ROOT, 'debug', 'csp_tracked.json');

export type TrackedStatus = 'OPEN' | 'CLOSED' | 'ROLLED';

export interface TrackedCsp {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  qty: number;
  lotSize: number;
  entrySpot: number;
  entryDate: string;
  avgPrice: number;
  /** Present only when the row came from a real order placed through the dashboard. */
  orderId?: string;
  securityId?: string;
  exchangeSegment?: string;
  productType?: string;
  status: TrackedStatus;
  exitPrice?: number;
  exitDate?: string;
  realizedPnl?: number;
  rolledFromId?: string;
  rolledToId?: string;
  createdAt: string;
  updatedAt: string;
}

export function readTracked(): TrackedCsp[] {
  try {
    if (!fs.existsSync(TRACKED_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(TRACKED_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Write-then-rename: this file is re-read on every dashboard poll, and a torn
 *  read parses as "no positions". */
function writeJsonAtomic(file: string, data: unknown) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function writeTracked(rows: TrackedCsp[]) {
  writeJsonAtomic(TRACKED_FILE, rows);
}

const SYNC_FILE = path.join(PROJECT_ROOT, 'debug', 'csp_sync_cache.json');

export interface SyncRow {
  id: string;
  spot?: number;
  peLtp?: number;
  iv?: number;
  dte?: number;
  /** Omitted when IV or spot is unavailable — the model would otherwise
   *  degenerate to a fabricated 100%. */
  noHitProb?: number;
  /** Set instead of the marks when this row could not be priced. */
  error?: string;
}

export interface SyncCache {
  asOf: string;
  rows: SyncRow[];
}

/** Last sync marks. Persisted because a sync costs ~3s per symbol+expiry (the
 *  option-chain throttle), so the P&L columns would otherwise be blank on every
 *  page load until the user manually re-synced. */
export function readSyncCache(): SyncCache | null {
  try {
    if (!fs.existsSync(SYNC_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf-8'));
    return Array.isArray(data?.rows) ? data : null;
  } catch {
    return null;
  }
}

export function writeSyncCache(cache: SyncCache) {
  writeJsonAtomic(SYNC_FILE, cache);
}

let _seq = 0;
export function newTrackedId(): string {
  _seq += 1;
  return `csp_${Date.now().toString(36)}_${_seq.toString(36)}`;
}
