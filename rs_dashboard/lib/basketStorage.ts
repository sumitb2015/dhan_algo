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
/** Client-side id for a newly-created basket, before it's ever persisted. */
export function newBasketId(): string {
  _clientBasketSeq += 1;
  return `bkt_${Date.now().toString(36)}_${_clientBasketSeq.toString(36)}`;
}

// Baskets are persisted server-side (debug/saved_baskets.json via /api/baskets)
// rather than localStorage, so the same list is shared across the Baskets page
// and the Option Strats page, and across browsers/sessions. Each basket is
// upserted/deleted by id individually (not by re-posting the whole array) so
// two tabs saving/deleting different baskets at once don't clobber each other.
export async function loadSavedBaskets(): Promise<SavedBasket[]> {
  try {
    const res = await fetch('/api/baskets');
    const json = await res.json();
    return json?.success ? (json.data as SavedBasket[]) : [];
  } catch {
    return [];
  }
}

export async function saveBasketRemote(basket: SavedBasket): Promise<SavedBasket[]> {
  const res = await fetch('/api/baskets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ basket }),
  });
  const json = await res.json().catch(() => null);
  if (!json?.success) throw new Error(json?.error ?? 'Failed to save basket');
  return json.data as SavedBasket[];
}

export async function deleteBasketRemote(id: string): Promise<SavedBasket[]> {
  const res = await fetch('/api/baskets', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const json = await res.json().catch(() => null);
  if (!json?.success) throw new Error(json?.error ?? 'Failed to delete basket');
  return json.data as SavedBasket[];
}
