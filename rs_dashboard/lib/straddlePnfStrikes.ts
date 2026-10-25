// Strike maths for the Straddle P&F page (NIFTY: 50-point strikes, charts at ATM-200 / ATM / ATM+200).

export const STRIKE_STEP = 50;
export const STRIKE_OFFSET = 200;

export function roundToStep(price: number, step = STRIKE_STEP): number {
  return Math.round(price / step) * step;
}

export function strikesFor(atm: number): [number, number, number] {
  return [atm - STRIKE_OFFSET, atm, atm + STRIKE_OFFSET];
}

/** `atm=auto` or a positive number (snapped to the strike step); anything else is invalid. */
export function parseAtmParam(raw: string | null): { auto: true } | { auto: false; atm: number } | null {
  if (raw === 'auto') return { auto: true };
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? { auto: false, atm: roundToStep(n) } : null;
}
