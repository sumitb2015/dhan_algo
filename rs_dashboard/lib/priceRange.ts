// Min/max price filter. A bound is `null` when its box is empty (= no limit on that side).

export interface PriceRange { min: number | null; max: number | null }

/** Empty, non-numeric or non-positive text means "no bound". */
export function parseBound(raw: string): number | null {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** If both bounds are set and reversed, swap them so the filter still means what the user typed. */
export function normalizeRange(min: number | null, max: number | null): PriceRange {
  if (min !== null && max !== null && min > max) return { min: max, max: min };
  return { min, max };
}

export function inRange(price: number, r: PriceRange): boolean {
  return (r.min === null || price >= r.min) && (r.max === null || price <= r.max);
}
