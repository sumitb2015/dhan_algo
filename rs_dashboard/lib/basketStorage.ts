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
  name: string;
  category: StrategyCategory;
  strategy: string | null;
  multiplier: number;
  underlying: string;
  legs: SavedLeg[];
}

export const SAVED_BASKETS_KEY = 'baskets_saved_v1';

/** ATM-relative offset (in strike-step units) for a strike at save time. */
export function legToOffset(strike: number, atmStrike: number, step: number): number {
  return Math.round((strike - atmStrike) / (step || 50));
}

/** Re-anchor a saved offset to the current ATM, snapping to the nearest listed strike. */
export function offsetToStrike(offset: number, atmStrike: number, allStrikes: number[], step: number): number {
  return nearestStrike(allStrikes, atmStrike + offset * step) ?? atmStrike;
}

export function loadSavedBaskets(): SavedBasket[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SAVED_BASKETS_KEY);
    return raw ? (JSON.parse(raw) as SavedBasket[]) : [];
  } catch {
    return []; // corrupt storage — start fresh rather than throwing
  }
}

export function persistSavedBaskets(baskets: SavedBasket[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SAVED_BASKETS_KEY, JSON.stringify(baskets));
  } catch {
    /* storage full or disabled — save silently fails, UI still works this session */
  }
}
