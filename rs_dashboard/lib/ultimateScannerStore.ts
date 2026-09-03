import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import type { WatchlistItem, ScannedStrategy } from './ultimateScannerTypes';

const WATCHLIST_FILE = path.join(PROJECT_ROOT, 'debug', 'ultimate_scanner_watchlist.json');

interface WatchlistStore {
  items: WatchlistItem[];
  lastUpdated: string;
}

function writeJsonAtomic(file: string, data: unknown) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readWatchlist(): WatchlistItem[] {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8')) as Partial<WatchlistStore>;
    return Array.isArray(raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

export function writeWatchlist(items: WatchlistItem[]): void {
  writeJsonAtomic(WATCHLIST_FILE, {
    items,
    lastUpdated: new Date().toISOString(),
  });
}

// Serializes read-modify-write mutations against WATCHLIST_FILE so concurrent
// requests (two tabs, a rapid double-click) can't both read the pre-mutation
// array and have the second write silently clobber the first's change.
let writeQueue: Promise<unknown> = Promise.resolve();

function mutateWatchlist<T>(mutator: (items: WatchlistItem[]) => { items: WatchlistItem[]; result: T }): Promise<T> {
  const run = writeQueue.then(() => {
    const { items, result } = mutator(readWatchlist());
    writeWatchlist(items);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

/**
 * Add a scanned candidate strategy into the watchlist with default entry/exit rules.
 */
export function addToWatchlist(
  candidate: ScannedStrategy,
  options?: Partial<Omit<WatchlistItem, keyof ScannedStrategy>>,
): Promise<WatchlistItem[]> {
  return mutateWatchlist(items => {
    const now = new Date().toISOString();

    // Check if identical setup already exists
    const existingIndex = items.findIndex(
      item => item.underlying === candidate.underlying &&
              item.expiry === candidate.expiry &&
              item.type === candidate.type &&
              JSON.stringify(item.legs.map(l => ({ s: l.strike, o: l.option, d: l.side }))) ===
              JSON.stringify(candidate.legs.map(l => ({ s: l.strike, o: l.option, d: l.side })))
    );

    const watchlistItem: WatchlistItem = {
      ...candidate,
      id: candidate.id || `us_watch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      targetProfitPct: options?.targetProfitPct ?? 50,
      stopLossPct: options?.stopLossPct ?? 100,
      trailingSl: options?.trailingSl ?? false,
      trailingSlOffsetPct: options?.trailingSlOffsetPct ?? 20,
      expiryAutoExitTime: options?.expiryAutoExitTime ?? '15:15',
      orderType: options?.orderType ?? 'MARKET',
      status: options?.status ?? 'WATCHING',
      currentNetPremium: candidate.netPremium,
      currentPnl: 0,
      currentPnlPct: 0,
      notes: options?.notes ?? '',
      addedAt: now,
      lastUpdated: now,
    };

    if (existingIndex >= 0) {
      items[existingIndex] = { ...items[existingIndex], ...watchlistItem, lastUpdated: now };
    } else {
      items.unshift(watchlistItem);
    }

    return { items, result: items };
  });
}

export function updateWatchlistItem(
  id: string,
  patch: Partial<WatchlistItem>,
): Promise<WatchlistItem[]> {
  return mutateWatchlist(items => {
    const idx = items.findIndex(item => item.id === id);
    if (idx >= 0) {
      items[idx] = {
        ...items[idx],
        ...patch,
        lastUpdated: new Date().toISOString(),
      };
    }
    return { items, result: items };
  });
}

export function deleteWatchlistItem(id: string): Promise<WatchlistItem[]> {
  return mutateWatchlist(items => {
    const filtered = items.filter(item => item.id !== id);
    return { items: filtered, result: filtered };
  });
}
