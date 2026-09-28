import { nearestStrike, type LegSide, type OptionType, type StrategyCategory } from './basketStrategies.ts';

export interface SavedLeg {
  side: LegSide;
  option: OptionType;
  offset: number;   // strike minus ATM at save time, in strike-step units
  lots: number;
  type: 'MARKET' | 'LIMIT';
  expiryRole?: 'front' | 'far';  // omitted = front; 'far' re-anchors to whatever far expiry is selected on load
}

export interface SavedBasket {
  id: string;
  name: string;
  category: StrategyCategory;
  strategy: string | null;
  multiplier: number;
  underlying: string;
  legs: SavedLeg[];
}

/** ATM-relative offset (in strike-step units) for a strike at save time. */
export function legToOffset(strike: number, atmStrike: number, step: number): number {
  return Math.round((strike - atmStrike) / (step || 50));
}

/** Re-anchor a saved offset to the current ATM, snapping to the nearest listed strike. */
export function offsetToStrike(offset: number, atmStrike: number, allStrikes: number[], step: number): number {
  return nearestStrike(allStrikes, atmStrike + offset * step) ?? atmStrike;
}

let _clientBasketSeq = 0;
export function newBasketId(): string {
  _clientBasketSeq += 1;
  return `bkt_${Date.now().toString(36)}_${_clientBasketSeq.toString(36)}`;
}

// Baskets are persisted server-side (debug/saved_baskets.json via /api/baskets) so the Baskets and
// Option Strats pages share one list. Each basket is upserted/deleted by id, never by re-posting the
// whole array, so two tabs editing different baskets can't overwrite each other.
export async function loadSavedBaskets(): Promise<SavedBasket[]> {
  try {
    const res = await fetch('/api/baskets');
    const json = await res.json();
    return json?.success ? (json.data as SavedBasket[]) : [];
  } catch {
    return [];
  }
}

async function basketRequest(method: 'POST' | 'DELETE', body: unknown, what: string): Promise<SavedBasket[]> {
  const res = await fetch('/api/baskets', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json?.success) throw new Error(json?.error ?? `Failed to ${what} basket`);
  return json.data as SavedBasket[];
}

export const saveBasketRemote = (basket: SavedBasket) => basketRequest('POST', { basket }, 'save');
export const deleteBasketRemote = (id: string) => basketRequest('DELETE', { id }, 'delete');
