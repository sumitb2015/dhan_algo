import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import type { RsSignal } from './rsStrategyCore';

export interface RsWatchlistItem {
  symbol: string;
  addedAt: string;         // ISO timestamp
  addedPrice: number;      // price at time of add
  addedSignal: RsSignal;   // signal at time of add (BUY, HOLD, SELL, WAIT)
  addedRs: number;         // RS ratio at time of add
  notes?: string;
  highlighted?: boolean;
}

const WATCHLIST_FILE = path.join(PROJECT_ROOT, 'debug', 'rs_strategy_watchlist.json');

interface WatchlistStore {
  items: RsWatchlistItem[];
  lastUpdated: string;
}

function writeJsonAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readRsWatchlist(): RsWatchlistItem[] {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8')) as Partial<WatchlistStore> | RsWatchlistItem[];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.items)) return raw.items;
    return [];
  } catch {
    return [];
  }
}

export function writeRsWatchlist(items: RsWatchlistItem[]): void {
  writeJsonAtomic(WATCHLIST_FILE, {
    items,
    lastUpdated: new Date().toISOString(),
  });
}

// Serializes read-modify-write mutations against WATCHLIST_FILE to avoid concurrent write clobbering
let writeQueue: Promise<unknown> = Promise.resolve();

function mutateWatchlist<T>(mutator: (items: RsWatchlistItem[]) => { items: RsWatchlistItem[]; result: T }): Promise<T> {
  const run = writeQueue.then(() => {
    const { items, result } = mutator(readRsWatchlist());
    writeRsWatchlist(items);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

export function addToRsWatchlist(
  newItems: RsWatchlistItem | RsWatchlistItem[],
): Promise<RsWatchlistItem[]> {
  const toAdd = Array.isArray(newItems) ? newItems : [newItems];
  return mutateWatchlist((items) => {
    const map = new Map<string, RsWatchlistItem>();
    // Existing items preserve their order
    for (const item of items) {
      map.set(item.symbol.toUpperCase(), item);
    }
    // New items added or updated
    for (const item of toAdd) {
      const sym = item.symbol.toUpperCase();
      const existing = map.get(sym);
      if (existing) {
        // Keep original addedAt/addedPrice if already set, update signal/notes/highlighted
        map.set(sym, {
          ...existing,
          ...item,
          addedAt: existing.addedAt || item.addedAt,
          addedPrice: existing.addedPrice > 0 ? existing.addedPrice : item.addedPrice,
        });
      } else {
        map.set(sym, {
          ...item,
          symbol: sym,
          addedAt: item.addedAt || new Date().toISOString(),
        });
      }
    }
    const updated = Array.from(map.values());
    return { items: updated, result: updated };
  });
}

export function removeFromRsWatchlist(
  symbolsToRemove: string | string[],
): Promise<RsWatchlistItem[]> {
  const toRemove = new Set(
    (Array.isArray(symbolsToRemove) ? symbolsToRemove : [symbolsToRemove]).map((s) => s.toUpperCase()),
  );
  return mutateWatchlist((items) => {
    const filtered = items.filter((item) => !toRemove.has(item.symbol.toUpperCase()));
    return { items: filtered, result: filtered };
  });
}

export function updateRsWatchlistItem(
  symbol: string,
  patch: Partial<RsWatchlistItem>,
): Promise<RsWatchlistItem[]> {
  const sym = symbol.toUpperCase();
  return mutateWatchlist((items) => {
    const updated = items.map((item) => {
      if (item.symbol.toUpperCase() === sym) {
        return { ...item, ...patch };
      }
      return item;
    });
    return { items: updated, result: updated };
  });
}
