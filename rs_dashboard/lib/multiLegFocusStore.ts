import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

import type { MultiLegBasket } from './multiLegFocus';
import { appendToArchive, historyIdFor, mergeHistoryRecord, splitEarlierDayLegs, splitStaleClosed, type ArchivedBasket } from './multiLegArchive';
import { mergeBasketWrite } from './multiLegStoreMerge';
import { regroupBaskets, type RegroupRequest, type RegroupResult } from './multiLegRegroup';

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

function readArchiveSafe(): ArchivedBasket[] {
  try { return readArchive(); } catch { return []; }
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
  // A leg lives in exactly one basket. A stale tab's save of the old group must not
  // bring back a leg that regroup moved elsewhere.
  if (basket.id && Array.isArray(basket.legs)) {
    const i = baskets.findIndex(b => b.id === basket.id);
    if (i >= 0) {
      const elsewhere = new Set(baskets.flatMap((b, j) => (j === i ? [] : b.legs.map(l => l.id))));
      if (baskets[i].legs.some(l => elsewhere.has(l.id))) {
        const kept = baskets[i].legs.filter(l => !elsewhere.has(l.id));
        // The stale copy was only the moved legs: its row is gone, don't leave an empty one.
        if (kept.length === 0) baskets.splice(i, 1);
        else baskets[i] = { ...baskets[i], legs: kept };
      }
    }
  }
  // A stale tab still holds legs that were split into the history record; its full
  // save would otherwise merge them straight back in.
  if (basket.id && Array.isArray(basket.legs)) {
    const hist = readArchiveSafe().find(a => a.id === historyIdFor(basket.id!));
    const i = baskets.findIndex(b => b.id === basket.id);
    if (hist && i >= 0) {
      const gone = new Set(hist.legs.map(l => l.id));
      baskets[i] = { ...baskets[i], legs: baskets[i].legs.filter(l => !gone.has(l.id)) };
    }
  }
  writeBaskets(baskets);
  const saved = basket.id ? baskets.find(b => b.id === basket.id) : baskets[baskets.length - 1];
  return { baskets, basket: saved, conflicts };
}

/** Moves legs between baskets (group / ungroup). Keeps one backup of the file first. */
export function regroup(req: RegroupRequest): RegroupResult {
  const before = readBaskets();
  const result = regroupBaskets(before, req, newBasketId, new Date().toISOString());
  if (!result.ok) return result;
  try {
    if (fs.existsSync(STORE_FILE)) fs.copyFileSync(STORE_FILE, `${STORE_FILE}.bak_regroup`);
  } catch { /* a missing backup must not block the user */ }
  writeBaskets(result.baskets);
  return result;
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
  // Live baskets also shed their earlier-day closed legs (a converted strategy
  // must not carry the old structure's trades) — into a per-basket history record.
  const now = Date.now();
  const splits = keep.map(b => splitEarlierDayLegs(b, now));
  const anySplit = splits.some(s => s.retired.length > 0);
  if (retire.length === 0 && !anySplit) return baskets;
  try {
    archiveBaskets(retire);
    if (anySplit) {
      const archive = readArchive();
      const nowIso = new Date().toISOString();
      const records = splits.flatMap((s, i) => s.retired.length === 0 ? []
        : [mergeHistoryRecord(archive.find(a => a.id === historyIdFor(keep[i].id)), keep[i], s.retired, nowIso)]);
      const ids = new Set(records.map(r => r.id));
      writeJsonAtomic(ARCHIVE_FILE, { baskets: [...archive.filter(a => !ids.has(a.id)), ...records] });
    }
  } catch (err) {
    // Keep them live rather than lose them; the page still loads.
    console.error('[multiLegFocusStore] archive failed, not pruning:', err);
    return baskets;
  }
  const next = splits.map(s => s.keep);
  writeBaskets(next);
  return next;
}

let _basketSeq = 0;
export function newBasketId(): string {
  _basketSeq += 1;
  return `mlf_${Date.now().toString(36)}_${_basketSeq.toString(36)}`;
}
