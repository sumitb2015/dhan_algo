// Per-contract OI buildup: the four quadrants of OI change x price change, each against the
// previous session. Same rule as OptionsBuildupTab's classifyBuildup, but returns null (no
// signal) instead of a label whenever an input is missing, so a leg never shows a guess.

export type OiBuildup = 'Long Buildup' | 'Short Buildup' | 'Short Covering' | 'Long Unwinding';

export interface OiSnapshot {
  oi: number;
  prevOi: number;
  ltp: number;
  prevClose: number;
}

export function classifyOiBuildup(s: OiSnapshot | undefined | null): OiBuildup | null {
  if (!s) return null;
  const { oi, prevOi, ltp, prevClose } = s;
  // A missing baseline is "no data", never "no change" (see dhan-oi-analytics).
  if (!(prevOi > 0) || !(prevClose > 0) || !(ltp > 0) || !Number.isFinite(oi) || oi < 0) return null;
  const oiChg = oi - prevOi;
  if (oiChg === 0) return null;
  const priceUp = ltp - prevClose >= 0;
  if (oiChg > 0) return priceUp ? 'Long Buildup' : 'Short Buildup';
  return priceUp ? 'Short Covering' : 'Long Unwinding';
}

export const OI_BUILDUP_SHORT: Record<OiBuildup, string> = {
  'Long Buildup': 'LB',
  'Short Buildup': 'SB',
  'Short Covering': 'SC',
  'Long Unwinding': 'LU',
};
