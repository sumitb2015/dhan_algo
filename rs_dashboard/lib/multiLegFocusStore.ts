import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

import type { MultiLegBasket } from './multiLegFocus';
import { appendToArchive, splitStaleClosed, type ArchivedBasket } from './multiLegArchive';
import { mergeBasketWrite } from './multiLegStoreMerge';

const STORE_FILE = path.join(PROJECT_ROOT, 'debug', 'multi_leg_baskets.json');
const ARCHIVE_FILE = path.join(PROJECT_ROOT, 'debug', 'multi_leg_baskets_archive.json');

interface Store {
  baskets: MultiLegBasket[];
}

function writeJsonAtomic(file: string, data: unknown) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readBaskets(): MultiLegBasket[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as Partial<Store>;
    return Array.isArray(raw.baskets) ? raw.baskets : [];
  } catch {
    return [];
  }
}

export function writeBaskets(baskets: MultiLegBasket[]): void {
  writeJsonAtomic(STORE_FILE, { baskets });
}

export function readArchive(): ArchivedBasket[] {
  try {
    if (!fs.existsSync(ARCHIVE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf-8')) as { baskets?: ArchivedBasket[] };
    return Array.isArray(raw.baskets) ? raw.baskets : [];
  } catch (err) {
    // An unreadable archive must not be overwritten with just today's retirees.
    throw new Error(`multi_leg_baskets_archive.json unreadable: ${String(err)}`);
  }
}

/** Written BEFORE the live store drops these baskets — see appendToArchive. */
function archiveBaskets(retired: MultiLegBasket[]): void {
  if (retired.length === 0) return;
  const next = appendToArchive(readArchive(), retired, new Date().toISOString());
  writeJsonAtomic(ARCHIVE_FILE, { baskets: next });
}

/** Upsert one basket — full-basket save or a smaller patch merged onto the
 *  existing record. A full save (with `legs`) is merged per leg by revision
 *  (mergeBasketWrite), never rejected: a stale tab's copy can no longer
 *  overwrite newer legs, and no real action is thrown away wholesale — at
 *  worst one leg's same-rev change loses to the stored one and is reported
 *  back in `conflicts`. A patch without legs is shallow-merged as before. */
export function upsertBasket(
  basket: Partial<MultiLegBasket> & { id?: string },
): { baskets: MultiLegBasket[]; basket?: MultiLegBasket; conflicts: string[] } {
  const baskets = readBaskets();
  const now = new Date().toISOString();
  const idx = basket.id ? baskets.findIndex(b => b.id === basket.id) : -1;
  let conflicts: string[] = [];
  if (idx >= 0) {
    if (Array.isArray(basket.legs)) {
      const merged = mergeBasketWrite(baskets[idx], { ...baskets[idx], ...basket } as MultiLegBasket);
      baskets[idx] = { ...merged.basket, updatedAt: now };
      conflicts = merged.conflicts;
    } else {
      baskets[idx] = { ...baskets[idx], ...basket, updatedAt: now } as MultiLegBasket;
    }
  } else {
    baskets.push({
      ...basket,
      id: basket.id ?? newBasketId(),
      underlying: basket.underlying ?? 'NIFTY',
      expiry: basket.expiry ?? '',
      broker: basket.broker ?? 'dhan',
      legs: basket.legs ?? [],
      createdAt: now,
      updatedAt: now,
    } as MultiLegBasket);
  }
  writeBaskets(baskets);
  const saved = basket.id ? baskets.find(b => b.id === basket.id) : baskets[baskets.length - 1];
  return { baskets, basket: saved, conflicts };
}

/** Removes a basket from the live store; one with trade history is archived first. */
export function deleteBasket(id: string): MultiLegBasket[] {
  const all = readBaskets();
  archiveBaskets(all.filter(b => b.id === id));
  const baskets = all.filter(b => b.id !== id);
  writeBaskets(baskets);
  return baskets;
}

function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Moves any basket whose every leg is CLOSED and whose last update (the
 *  reconciliation tick that closed its final leg, or a manual exit) landed on
 *  a previous IST calendar day out of the live store and into
 *  debug/multi_leg_baskets_archive.json — a strategy exited today keeps
 *  showing all day, then leaves the page the first time this runs after
 *  midnight IST. Runs on every GET (see the baskets route) rather than a
 *  separate scheduled job. A basket with any still-open/placing/closing leg is
 *  never touched here, regardless of age. */
export function pruneStaleClosedBaskets(): MultiLegBasket[] {
  const baskets = readBaskets();
  const { keep, retire } = splitStaleClosed(baskets, istToday());
  if (retire.length === 0) return baskets;
  try {
    archiveBaskets(retire);
  } catch (err) {
    // Keep them live rather than lose them; the page still loads.
    console.error('[multiLegFocusStore] archive failed, not pruning:', err);
    return baskets;
  }
  writeBaskets(keep);
  return keep;
}

let _basketSeq = 0;
export function newBasketId(): string {
  _basketSeq += 1;
  return `mlf_${Date.now().toString(36)}_${_basketSeq.toString(36)}`;
}
