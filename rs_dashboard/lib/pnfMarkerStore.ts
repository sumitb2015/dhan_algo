// How the P&F / Renko page keeps its trade markers (every manual / rail / guard fill, per instrument) across a reload. They used to live
// in sessionStorage, so a new tab or a restart dropped the day's paper fills from the chart and from the Trade Book. They now live in
// localStorage stamped with the IST day, and a marker list of another day is ignored (a stale marker would otherwise draw on today's
// chart). Pure (tested in lib/pnfMarkerStore.test.ts).
import type { PnfExecutionMarker } from './straddlePnf.ts';

/** The stored form: the day the list belongs to, then the list. */
export const encodeMarkers = (day: string, list: PnfExecutionMarker[]): string => JSON.stringify({ day, list });

/**
 * The markers stored under `raw` for `day`, or []. An unreadable value, a list of another day, or the old bare-array form (written
 * with no day) gives []: nothing from before the stamp can be trusted to be today's. AUTO markers (`auto-…` ids) are drawn from the
 * ledger instead and dropped here; a marker's column is recomputed by each chart from its own box size.
 */
export function decodeMarkers(raw: string | null, day: string): PnfExecutionMarker[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as { day?: unknown; list?: unknown };
    if (!j || typeof j !== 'object' || Array.isArray(j) || j.day !== day || !Array.isArray(j.list)) return [];
    return (j.list as PnfExecutionMarker[]).filter(m => m && !String(m.id).startsWith('auto-')).map(m => ({ ...m, col: undefined }));
  } catch { return []; }
}
