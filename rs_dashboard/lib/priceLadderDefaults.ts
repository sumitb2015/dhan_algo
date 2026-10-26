import { MAX_LADDER_LOTS, MCX_LADDER_UNDERLYINGS } from './priceLadder.ts';
import { PIVOT_FORMULAS, type PivotFormula } from './pivotLevels.ts';

/** The form values a ladder starts with. Every field is optional: an unset one keeps its built-in value. */
export interface LadderDefaults {
  mode?: 'xy' | 'plain' | 'pair' | 'basket';
  product?: 'NRML' | 'MIS';
  underlying?: string;
  zones?: 'classic' | 'anywhere';
  orderType?: 'LIMIT' | 'SL';
  style?: 'Single' | 'Bracket' | 'Cover';
  tgtPts?: number;
  slPts?: number;
  trailOn?: boolean;
  trailPts?: number;
  lots?: number;
  /** Which option each ladder starts on: ladder 1 and ladder 2 are independent. */
  opt1?: 'CE' | 'PE';
  opt2?: 'CE' | 'PE';
  /** Where the XY ladder's OI bars sit: on the outer edges (call OI from the far left, put OI from the far right; the default) or beside the Price column. */
  oiPlace?: 'center' | 'edges';
  /** Index ladder: the previous day's CPR (P / TC / BC) and R1-R4 / S1-S4 marks in the Price column, each on or off, and the R3 / R4 / S3 / S4 formula. */
  cprOn?: boolean;
  pivotsOn?: boolean;
  pivotFormula?: PivotFormula;
}

export const LADDER_UNDERLYINGS: readonly string[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', ...MCX_LADDER_UNDERLYINGS];
export const LADDER_DEFAULTS_KEY = 'price-ladder-defaults';
/** Built-in values: what the ladder used before defaults existed. */
export const BUILT_IN_DEFAULTS: Required<LadderDefaults> = {
  mode: 'xy', product: 'MIS', underlying: 'NIFTY', zones: 'classic', orderType: 'LIMIT', style: 'Bracket',
  tgtPts: 40, slPts: 30, trailOn: false, trailPts: 30, lots: 1, opt1: 'CE', opt2: 'PE', oiPlace: 'edges',
  cprOn: true, pivotsOn: true, pivotFormula: 'traditional',
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);
const pts = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100000 ? Math.round(v * 100) / 100 : undefined);

/** Keeps only valid fields of an untrusted value (storage is hand-editable); anything else is dropped, never guessed. */
export function sanitizeDefaults(raw: unknown): LadderDefaults {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const lots = typeof r.lots === 'number' && Number.isInteger(r.lots) && r.lots >= 1 && r.lots <= MAX_LADDER_LOTS ? r.lots : undefined;
  const out: LadderDefaults = {
    mode: oneOf(r.mode, ['xy', 'plain', 'pair', 'basket'] as const),
    product: oneOf(r.product, ['NRML', 'MIS'] as const),
    underlying: oneOf(r.underlying, LADDER_UNDERLYINGS as readonly string[]),
    zones: oneOf(r.zones, ['classic', 'anywhere'] as const),
    orderType: oneOf(r.orderType, ['LIMIT', 'SL'] as const),
    style: oneOf(r.style, ['Single', 'Bracket', 'Cover'] as const),
    tgtPts: pts(r.tgtPts), slPts: pts(r.slPts), trailPts: pts(r.trailPts),
    trailOn: typeof r.trailOn === 'boolean' ? r.trailOn : undefined,
    lots,
    opt1: oneOf(r.opt1, ['CE', 'PE'] as const),
    opt2: oneOf(r.opt2, ['CE', 'PE'] as const),
    oiPlace: oneOf(r.oiPlace, ['center', 'edges'] as const),
    cprOn: typeof r.cprOn === 'boolean' ? r.cprOn : undefined,
    pivotsOn: typeof r.pivotsOn === 'boolean' ? r.pivotsOn : undefined,
    pivotFormula: oneOf(r.pivotFormula, PIVOT_FORMULAS),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as LadderDefaults;
}

/** The saved defaults laid over the built-in ones. */
export function resolveDefaults(saved: LadderDefaults): Required<LadderDefaults> {
  return { ...BUILT_IN_DEFAULTS, ...saved };
}

export function loadDefaults(): LadderDefaults {
  try { const s = localStorage.getItem(LADDER_DEFAULTS_KEY); return s ? sanitizeDefaults(JSON.parse(s)) : {}; } catch { return {}; }
}
export function saveDefaults(d: LadderDefaults): void {
  try { localStorage.setItem(LADDER_DEFAULTS_KEY, JSON.stringify(sanitizeDefaults(d))); } catch { /* best effort */ }
}
export function clearDefaults(): void {
  try { localStorage.removeItem(LADDER_DEFAULTS_KEY); } catch { /* best effort */ }
}
