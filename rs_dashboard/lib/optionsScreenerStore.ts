import path from 'path';
import fs from 'fs';
import type { ScreenerFilters, Snapshot, SnapshotRow } from './optionsScreener';

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

// ---------------------------------------------------------------------------
// Scan scope — which underlyings the collector should fetch
// ---------------------------------------------------------------------------
//
// Each open tab's segment + symbols (a watchlist arrives already expanded to symbols) is
// recorded here on every scan poll. The collector (read_scope() in
// scripts/tools/options_screener_collector.py) scans the union over tabs seen in the last
// 2 minutes, or the most recent selection when no tab is polling. Written only when a
// selection changes, or as a 30 s heartbeat so an open tab stays "active".

export const SCREENER_SCOPE_FILE = path.join(SCREENER_DEBUG_DIR, 'options_screener_scope.json');
const HEARTBEAT_MS = 30_000;
const TAB_FORGET_MS = 10 * 60_000;

interface TabScope { at: number; segment: ScreenerFilters['segment']; symbols: string[] }
interface ScopeState { tabs: Record<string, TabScope>; last: TabScope | null; writtenAt: number; sig: string }

const scopeGlobal = globalThis as { __screenerScope?: ScopeState };

function loadScope(): ScopeState {
  if (scopeGlobal.__screenerScope) return scopeGlobal.__screenerScope;
  // Seed from disk so a dev-server restart doesn't forget the last selection.
  let last: TabScope | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(SCREENER_SCOPE_FILE, 'utf8')) as { last?: TabScope };
    if (raw.last && typeof raw.last === 'object') last = raw.last;
  } catch { /* no scope yet */ }
  return (scopeGlobal.__screenerScope = { tabs: {}, last, writtenAt: 0, sig: '' });
}

/** Record what `tabId` is looking at; returns nothing, never throws. */
export function recordScreenerScope(tabId: string, filters: Pick<ScreenerFilters, 'segment' | 'symbols'>): void {
  if (!/^[a-z0-9]{6,24}$/i.test(tabId)) return;
  const st = loadScope();
  const now = Date.now();
  const entry: TabScope = { at: now, segment: filters.segment, symbols: [...filters.symbols].sort() };
  st.tabs[tabId] = entry;
  st.last = entry;
  for (const [id, t] of Object.entries(st.tabs)) if (now - t.at > TAB_FORGET_MS) delete st.tabs[id];

  const sig = JSON.stringify(Object.entries(st.tabs).map(([id, t]) => [id, t.segment, t.symbols]).sort());
  if (sig === st.sig && now - st.writtenAt < HEARTBEAT_MS) return;
  try {
    fs.mkdirSync(SCREENER_DEBUG_DIR, { recursive: true });
    const tmp = `${SCREENER_SCOPE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tabs: st.tabs, last: st.last }));
    fs.renameSync(tmp, SCREENER_SCOPE_FILE);
    st.sig = sig;
    st.writtenAt = now;
  } catch { /* the collector keeps its previous scope */ }
}
