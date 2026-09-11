import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { istToday } from './pnlAlertState';
import type { MultiLegBasket } from './multiLegFocus';

const STORE_FILE = path.join(PROJECT_ROOT, 'debug', 'multi_leg_baskets.json');

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

/** Upsert one basket — full-basket save or a smaller patch merged onto the
 *  existing record. Last-write-wins, matching focusToolRows.ts's rationale:
 *  this is a single-user local tool saving from many independent places
 *  (place, exit-leg, exit-basket), and an optimistic-concurrency reject would
 *  discard a real user action more often than it would prevent a real
 *  collision. */
export function upsertBasket(basket: Partial<MultiLegBasket> & { id?: string }): MultiLegBasket[] {
  const baskets = readBaskets();
  const now = new Date().toISOString();
  const idx = basket.id ? baskets.findIndex(b => b.id === basket.id) : -1;
  if (idx >= 0) {
    baskets[idx] = { ...baskets[idx], ...basket, updatedAt: now } as MultiLegBasket;
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
  return baskets;
}

export function deleteBasket(id: string): MultiLegBasket[] {
  const baskets = readBaskets().filter(b => b.id !== id);
  writeBaskets(baskets);
  return baskets;
}

function istDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function isFullyClosed(basket: MultiLegBasket): boolean {
  return basket.legs.length > 0 && basket.legs.every(l => l.status === 'CLOSED');
}

/** Drops any basket whose every leg is CLOSED and whose last update (the
 *  reconciliation tick that closed its final leg, or a manual exit) landed on
 *  a previous IST calendar day — a strategy exited today keeps showing all
 *  day, then is gone the next time this is called after midnight IST. Runs
 *  on every GET (see the baskets route) rather than a separate scheduled job,
 *  so the store never accumulates more than one day of finished history. A
 *  basket with any still-open/placing/closing leg is never touched here,
 *  regardless of age. */
export function pruneStaleClosedBaskets(): MultiLegBasket[] {
  const baskets = readBaskets();
  const today = istToday();
  const kept = baskets.filter(b => !(isFullyClosed(b) && istDateOf(b.updatedAt) < today));
  if (kept.length !== baskets.length) writeBaskets(kept);
  return kept;
}

let _basketSeq = 0;
export function newBasketId(): string {
  _basketSeq += 1;
  return `mlf_${Date.now().toString(36)}_${_basketSeq.toString(36)}`;
}
