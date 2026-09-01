import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
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
      id: basket.id ?? newBasketId(),
      underlying: basket.underlying ?? 'NIFTY',
      expiry: basket.expiry ?? '',
      broker: basket.broker ?? 'dhan',
      presetKey: basket.presetKey,
      legs: basket.legs ?? [],
      createdAt: now,
      updatedAt: now,
    });
  }
  writeBaskets(baskets);
  return baskets;
}

export function deleteBasket(id: string): MultiLegBasket[] {
  const baskets = readBaskets().filter(b => b.id !== id);
  writeBaskets(baskets);
  return baskets;
}

let _basketSeq = 0;
export function newBasketId(): string {
  _basketSeq += 1;
  return `mlf_${Date.now().toString(36)}_${_basketSeq.toString(36)}`;
}
