// Strike maths for the Straddle P&F page (50-point strikes, charts at ATM-200 / ATM / ATM+200 by default).

/** Underlyings the page can chart. CRUDEOILM options are on MCX; its ATM comes from the nearest future (options_data_fetch.py ltp). */
export const PNF_UNDERLYINGS = ['NIFTY', 'CRUDEOILM'] as const;
export type PnfUnderlying = (typeof PNF_UNDERLYINGS)[number];
export const isPnfUnderlying = (u: string): u is PnfUnderlying => (PNF_UNDERLYINGS as readonly string[]).includes(u);


export const STRIKE_STEP = 50;
export const STRIKE_OFFSET = 200;

export function roundToStep(price: number, step = STRIKE_STEP): number {
  return Math.round(price / step) * step;
}

export type Offsets = [number, number, number];
export const DEFAULT_OFFSETS: Offsets = [-STRIKE_OFFSET, 0, STRIKE_OFFSET];
export const MAX_OFFSET = 1000;

export function strikesFor(atm: number, offsets: Offsets = DEFAULT_OFFSETS): Offsets {
  return [atm + offsets[0], atm + offsets[1], atm + offsets[2]];
}

/** One offset: "-200", "+300", "0" or "ATM" -> a whole multiple of the strike step inside +-MAX_OFFSET; anything else -> null. */
export function parseOffset(text: string): number | null {
  const t = text.trim();
  if (/^atm$/i.test(t)) return 0;
  if (!/^[+-]?\d+$/.test(t.replace('−', '-'))) return null;
  const n = Number(t.replace('−', '-'));
  return n % STRIKE_STEP === 0 && Math.abs(n) <= MAX_OFFSET ? n + 0 : null;
}

/** `offsets=-200,0,200`: exactly three distinct valid offsets; anything else -> null. */
export function parseOffsetsParam(raw: string | null): Offsets | null {
  if (raw === null) return null;
  const parts = raw.split(',').map(parseOffset);
  if (parts.length !== 3 || parts.some(p => p === null) || new Set(parts).size !== 3) return null;
  return parts as Offsets;
}

export function offsetLabel(o: number): string {
  return o === 0 ? 'ATM' : `ATM ${o < 0 ? '−' : '+'}${Math.abs(o)}`;
}

/** `atm=auto` or a positive number (snapped to the strike step); anything else is invalid. */
export function parseAtmParam(raw: string | null): { auto: true } | { auto: false; atm: number } | null {
  if (raw === 'auto') return { auto: true };
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? { auto: false, atm: roundToStep(n) } : null;
}
