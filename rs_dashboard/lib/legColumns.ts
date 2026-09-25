// Which optional columns the Multi-leg Focus legs table shows. A per-viewer
// convenience only: kept in localStorage, always readable without it.

export type LegColumnKey = 'avg' | 'exit' | 'pnlPct' | 'qty' | 'iv' | 'otm';
export type LegColumns = Record<LegColumnKey, boolean>;

export const LEG_COLUMN_STORAGE_KEY = 'mlf_leg_cols_v1';

export const DEFAULT_LEG_COLUMNS: LegColumns = {
  avg: true, exit: true, pnlPct: true, qty: false, iv: false, otm: false,
};

export const LEG_COLUMN_LABELS: { key: LegColumnKey; label: string; hint: string }[] = [
  { key: 'avg',    label: 'Avg price',  hint: 'Average entry price' },
  { key: 'exit',   label: 'Exit price', hint: 'Closing fill price (closed legs; hidden when none are closed)' },
  { key: 'pnlPct', label: 'P&L %',      hint: 'P&L as a % of the entry premium' },
  { key: 'qty',    label: 'Qty',        hint: 'Quantity in units (lots x lot size), as recorded for this leg' },
  { key: 'iv',     label: 'IV',         hint: 'Live implied volatility from the option chain' },
  { key: 'otm',    label: 'OTM %',      hint: 'Distance of the strike from spot (negative = in the money)' },
];

/** Merge whatever was stored over the defaults; anything unrecognised or malformed is ignored. */
export function parseLegColumns(raw: string | null | undefined): LegColumns {
  const out: LegColumns = { ...DEFAULT_LEG_COLUMNS };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(out) as LegColumnKey[]) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'boolean') out[key] = v;
      }
    }
  } catch { /* corrupt value: fall back to defaults */ }
  return out;
}

export function loadLegColumns(): LegColumns {
  try { return parseLegColumns(localStorage.getItem(LEG_COLUMN_STORAGE_KEY)); } catch { return { ...DEFAULT_LEG_COLUMNS }; }
}

export function saveLegColumns(cols: LegColumns): void {
  try { localStorage.setItem(LEG_COLUMN_STORAGE_KEY, JSON.stringify(cols)); } catch { /* storage blocked: choice lasts this session only */ }
}
