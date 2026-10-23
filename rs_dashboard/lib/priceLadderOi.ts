// Open-interest bars on an XY ladder's rows. A strike is a level on the ladder's index / futures axis, so the chain's OI
// per strike draws as an OI profile: put OI (support) to the left of the Price column, call OI (resistance) to the right.
// Pure; the chain comes from /api/options/chain (the page already loads it for the strike list). OI is shown exactly as
// Dhan's chain reports it (contracts for index options; CRUDEOILM's unit is not confirmed), so bars carry no unit label.

export interface OiStrike { strike: number; ceOi: number; peOi: number; cePrev: number | null; pePrev: number | null }

type ChainSide = { oi?: unknown; previous_oi?: unknown; [k: string]: unknown } | null | undefined;
type ChainOc = Record<string, { ce?: ChainSide; pe?: ChainSide }>;

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** A previous-day OI of 0 / missing is "no baseline", never a real zero: a change % off it would be made up. */
const prev = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** The chain's per-strike OI, ascending by strike. Strikes with no OI on either side are dropped. */
export function oiStrikesFromChain(oc: ChainOc | null | undefined): OiStrike[] {
  const out: OiStrike[] = [];
  for (const [k, row] of Object.entries(oc ?? {})) {
    if (!row || typeof row !== 'object') continue;     // a strike with no data (or a partial stale payload)
    const strike = Number(k);
    if (!(strike > 0)) continue;
    const ceOi = Math.max(0, num(row.ce?.oi)), peOi = Math.max(0, num(row.pe?.oi));
    if (ceOi <= 0 && peOi <= 0) continue;
    out.push({ strike, ceOi, peOi, cePrev: prev(row.ce?.previous_oi), pePrev: prev(row.pe?.previous_oi) });
  }
  return out.sort((a, b) => a.strike - b.strike);
}

/** The largest single-side OI on the whole chain: the 100 % of every bar, so bars do not jump while the ladder scrolls. */
export const maxOi = (rows: readonly OiStrike[]): number => rows.reduce((m, r) => Math.max(m, r.ceOi, r.peOi), 0);

/** The strike whose level is this ladder row (within half a tick), or null. */
export function oiAtRow(rows: readonly OiStrike[], price: number, tick: number): OiStrike | null {
  // The NEAREST strike inside the window: with a tick as wide as the strike gap two strikes can fall in it.
  let best: OiStrike | null = null, gap = tick / 2;
  for (const r of rows) {
    const d = Math.abs(r.strike - price);
    if (d < gap) { best = r; gap = d; }
  }
  return best;
}

/** A bar's width as a whole percent of the maximum (0 when there is no OI or no maximum). */
export const barPct = (oi: number, max: number): number => (max > 0 && oi > 0 ? Math.max(2, Math.min(100, Math.round((oi / max) * 100))) : 0);

/** OI change vs the previous day in %, or null when there is no previous-day baseline. */
export const oiChangePct = (oi: number, previous: number | null): number | null => (previous ? ((oi - previous) / previous) * 100 : null);

/** 1,23,456 -> 1.2L, 12,34,567 -> 12.3L, 4,50,00,000 -> 4.5Cr, small numbers as they are. */
export function compactOi(n: number): string {
  // Round at the printed precision first, so 99,99,950 reads 1.0Cr and 999,960 reads 10.0L, never 100.0L / 1000.0K.
  const r = (v: number) => Math.round(v * 10) / 10;
  if (r(n / 1e5) >= 100) return `${r(n / 1e7).toFixed(1)}Cr`;
  if (r(n / 1e3) >= 100) return `${r(n / 1e5).toFixed(1)}L`;
  if (r(n) >= 1000) return `${r(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** The parse-and-filter both chain reads share: strikes the ladder offers, with their OI. */
export function oiRowsFor(oc: ChainOc | null | undefined, offered: (strike: number) => boolean): OiStrike[] {
  return oiStrikesFromChain(oc).filter(r => offered(r.strike));
}
