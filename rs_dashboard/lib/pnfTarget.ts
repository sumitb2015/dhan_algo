// What the Point & Figure page charts, picked with the Index | Equity | Futures | Options switch. Pure: parsing, defaults and the
// history query are tested here. A futures / options target is only complete (loadable) once its contract is chosen.

export type Segment = 'index' | 'equity' | 'futures' | 'options';
export type OptSide = 'CE' | 'PE' | 'STRADDLE';

export type Target = {
  kind: Segment;
  /** The index / stock symbol, or the F&O underlying. */
  symbol: string;
  name: string;
  /** Futures / options: YYYY-MM-DD. */
  expiry?: string;
  /** Options. */
  strike?: number;
  side?: OptSide;
};

export const SEGMENTS: { id: Segment; label: string }[] = [
  { id: 'index', label: 'Index' }, { id: 'equity', label: 'Equity' }, { id: 'futures', label: 'Futures' }, { id: 'options', label: 'Options' },
];

/** First visit to a segment. A futures / options default has no contract yet: the pickers fill in the nearest expiry (and ATM). */
export const DEFAULT_TARGETS: Record<Segment, Target> = {
  index: { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' },
  equity: { kind: 'equity', symbol: 'RELIANCE', name: 'RELIANCE' },
  futures: { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY' },
  options: { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', side: 'CE' },
};

const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SIDES: OptSide[] = ['CE', 'PE', 'STRADDLE'];

/** A stored target (any shape) -> a valid Target, or null. Unknown / malformed fields are dropped, not trusted. */
export function parseTarget(v: unknown): Target | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'index' && kind !== 'equity' && kind !== 'futures' && kind !== 'options') return null;
  if (typeof o.symbol !== 'string' || !SYMBOL_RE.test(o.symbol)) return null;
  const t: Target = { kind, symbol: o.symbol, name: typeof o.name === 'string' ? o.name : o.symbol };
  if ((kind === 'futures' || kind === 'options') && typeof o.expiry === 'string' && DATE_RE.test(o.expiry)) t.expiry = o.expiry;
  if (kind === 'options') {
    if (typeof o.strike === 'number' && o.strike > 0 && Number.isFinite(o.strike)) t.strike = o.strike;
    t.side = SIDES.includes(o.side as OptSide) ? (o.side as OptSide) : 'CE';
  }
  return t;
}

/** The last target picked in each segment, so switching segments brings it back. Corrupt entries fall back to the defaults. */
export function readTargets(raw: string | null): Record<Segment, Target> {
  const out = { ...DEFAULT_TARGETS };
  try {
    const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === 'object') {
      for (const s of SEGMENTS) {
        const t = parseTarget((o as Record<string, unknown>)[s.id]);
        if (t && t.kind === s.id) out[s.id] = t;
      }
    }
  } catch { /* corrupt: defaults */ }
  return out;
}

/** Loadable: an index / stock always; a future once it has an expiry; an option once it has expiry, strike and side. */
export function isComplete(t: Target): boolean {
  if (t.kind === 'futures') return !!t.expiry;
  if (t.kind === 'options') return !!t.expiry && !!t.strike && !!t.side;
  return true;
}

/** The history route's query for a complete target. */
export function targetQuery(t: Target): string {
  const sym = encodeURIComponent(t.symbol);
  if (t.kind === 'index' || t.kind === 'equity') return `mode=price&kind=${t.kind}&symbol=${sym}`;
  const base = `mode=contract&kind=${t.kind}&underlying=${sym}&expiry=${t.expiry}`;
  return t.kind === 'futures' ? base : `${base}&strike=${t.strike}&type=${t.side}`;
}

/** A stable identity for "is this the same chart": a change of any field is a new instrument. */
export const targetKey = (t: Target) => [t.kind, t.symbol, t.expiry ?? '', t.strike ?? '', t.side ?? ''].join('|');

/**
 * The alert log's id for a signal: the whole contract (expiry, strike, side), the signal kind and its bar time, so two strikes, CE vs
 * PE, or two expiries signalling on the same bar are two entries, while the same signal seen twice is one.
 */
export const alertId = (t: Target, kind: string, barT: number) => `${targetKey(t)}:${kind}:${barT}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-03" -> "03 Nov 26". */
export const expiryLabel = (iso: string) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;

/** A short chart label: "NIFTY", "NIFTY FUT 24 Nov 26", "NIFTY 23000 CE 03 Nov 26", "NIFTY 23000 CE+PE 03 Nov 26". */
export function targetLabel(t: Target): string {
  if (t.kind === 'futures') return t.expiry ? `${t.symbol} FUT ${expiryLabel(t.expiry)}` : `${t.symbol} FUT`;
  if (t.kind === 'options') {
    const side = t.side === 'STRADDLE' ? 'CE+PE' : t.side ?? '';
    return [t.symbol, t.strike, side, t.expiry ? expiryLabel(t.expiry) : ''].filter(Boolean).join(' ');
  }
  return t.symbol;
}

export type ChartPicks = { targets: Record<Segment, Target>; open: Segment };

/**
 * One chart's saved picks: the last target per segment and the segment it had open. A chart with nothing saved yet
 * starts from `fallback` (chart 2's first visit copies chart 1), else from the defaults on the Index segment.
 */
export function restoreChart(rawTargets: string | null, rawSegment: string | null, fallback?: ChartPicks): ChartPicks {
  if (rawTargets === null && fallback) return { targets: { ...fallback.targets }, open: fallback.open };
  const targets = readTargets(rawTargets);
  const open = SEGMENTS.some(s => s.id === rawSegment) ? (rawSegment as Segment) : fallback?.open ?? 'index';
  return { targets, open };
}

/** The saved active chart: 2 only when it says so. */
export const parseActiveChart = (raw: string | null): 1 | 2 => (raw === '2' ? 2 : 1);
