import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import type { SavedBasket } from './basketStorage';

const STORE_FILE = path.join(PROJECT_ROOT, 'debug', 'saved_baskets.json');

/** Reads the store, assigning a stable id (derived from name) to any legacy
 *  record saved before ids existed, and persisting that assignment back so
 *  it only happens once. */
export function readBaskets(): SavedBasket[] {
  let baskets: SavedBasket[];
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    baskets = Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }

  let migrated = false;
  const withIds = baskets.map(b => {
    if (b.id) return b;
    migrated = true;
    return { ...b, id: `bkt_legacy_${b.name}` };
  });
  if (migrated) writeJsonAtomic(STORE_FILE, withIds, { pretty: true });
  return withIds;
}

export function writeBaskets(baskets: SavedBasket[]): void {
  writeJsonAtomic(STORE_FILE, baskets, { pretty: true });
}

/** Upsert one basket by id — last-write-wins, matching multiLegFocusStore's
 *  rationale: single-user local tool, an optimistic-concurrency reject would
 *  discard a real user action more often than it would prevent a real
 *  collision. Applying it per-basket (rather than re-posting the whole list)
 *  is what actually fixes the two-tab clobber case. */
export function upsertBasket(basket: SavedBasket): SavedBasket[] {
  const baskets = readBaskets();
  const idx = baskets.findIndex(b => b.id === basket.id);
  if (idx >= 0) baskets[idx] = basket;
  else baskets.push(basket);
  writeBaskets(baskets);
  return baskets;
}

export function deleteBasket(id: string): SavedBasket[] {
  const baskets = readBaskets().filter(b => b.id !== id);
  writeBaskets(baskets);
  return baskets;
}
