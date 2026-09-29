import path from 'path';
import fs from 'fs';
import type { Snapshot, SnapshotRow } from './optionsScreener';

/** Server-only reader for the collector's snapshot. Parsed once per file version (mtime),
 *  so every poll from every open tab shares one JSON.parse of a multi-MB file. */

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
export const SCREENER_DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
export const SCREENER_SNAPSHOT_FILE = path.join(SCREENER_DEBUG_DIR, 'options_screener_snapshot.json');

interface Cached { mtimeMs: number; snap: Snapshot; byId: Map<string, SnapshotRow> }
let cache: Cached | null = null;

export function readScreenerSnapshot(): { snap: Snapshot; byId: Map<string, SnapshotRow>; mtimeMs: number } | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(SCREENER_SNAPSHOT_FILE).mtimeMs;
  } catch {
    return null;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache;
  try {
    const snap = JSON.parse(fs.readFileSync(SCREENER_SNAPSHOT_FILE, 'utf8')) as Snapshot;
    if (!snap || !Array.isArray(snap.rows)) return cache;
    const byId = new Map<string, SnapshotRow>();
    for (const r of snap.rows) byId.set(r.id, r);
    cache = { mtimeMs, snap, byId };
    return cache;
  } catch {
    // Mid-replace read or a truncated file: keep serving the last good parse (never a
    // session-open/empty value) — the next poll picks up the new version.
    return cache;
  }
}
