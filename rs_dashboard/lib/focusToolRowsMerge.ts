import type { FocusIndexGroup, FocusRow, FocusToolConfig } from './focusToolRows.ts';
import { mergeRevItems } from './revMerge.ts';
import { legacyStopToSigned } from './focusToolRules.ts';

/** How many deleted row ids are remembered. */
export const DELETED_ROW_CAP = 200;

/** A save body. `deleteRowIds` asks for rows to be removed; `deletedRowIds`
 *  (the stored tombstone list) is server-owned and ignored if a client sends it. */
export type FocusConfigWrite = Partial<FocusToolConfig> & {
  deleteRowIds?: string[];
  /** The ONLY way a save changes an index group (Start / Stop, product, ATM BY, book-exit levels): one index, only the
   *  fields the user changed. A whole `groups` array in a save is ignored — every row save used to carry the tab's
   *  copy of all four groups, so a second or stale tab switched an index off again behind the user's back (2026-11-09:
   *  NIFTY stopped mid-trade, a stopped CE leg was not re-entered and PE was left naked). */
  groupPatch?: { underlying: FocusIndexGroup['underlying']; patch: Partial<FocusIndexGroup> };
};

function holdsPosition(r: FocusRow): boolean {
  return (Number(r.fill?.ceQty) || 0) > 0 || (Number(r.fill?.peQty) || 0) > 0;
}

/**
 * Merges one Focus Tool save into the stored config.
 *
 * Rows hold the fill ledger every exit is sized from, and every fill change
 * saves the whole config — so with plain last-write-wins, a second or stale
 * tab rolled back other rows' ledgers (2026-10-01 audit). Rows now merge per
 * row by `rev` (lib/revMerge.ts). A row missing from a save is kept: rows are
 * removed only through `deleteRowIds`, remembered in `deletedRowIds` so a stale tab
 * can't bring a deleted row back, and never for a row that still holds a
 * position. Every other field (risk bar, groups, live arm) is still
 * last-write-wins, and only when the save carries it.
 */
export function mergeFocusConfigWrite(
  stored: FocusToolConfig,
  body: FocusConfigWrite,
): { config: FocusToolConfig; conflicts: string[]; refusedDeletes: string[]; refusedGroupStops: string[] } {
  const { rows: incomingRows, deleteRowIds: incomingDeleted, deletedRowIds: _clientTombs, groups: _clientGroups, groupPatch, ...rest } = body;
  void _clientTombs; void _clientGroups;
  // A save from a tab that predates the signed Stop carries a loss magnitude and no flag; stored as-is next to a
  // `stopSigned: true` it would turn a 5000 loss stop into a +5000 profit stop. Convert it on the way in.
  if (rest.stopRupees !== undefined && rest.stopSigned !== true) {
    rest.stopRupees = legacyStopToSigned({ stopRupees: rest.stopRupees });
    rest.stopSigned = true;
  }
  const refusedDeletes: string[] = [];
  const toDelete = new Set<string>();
  for (const id of incomingDeleted ?? []) {
    const row = stored.rows.find(r => r.id === id);
    if (row && holdsPosition(row)) refusedDeletes.push(id);
    else toDelete.add(id);
  }
  const tombs = [...(stored.deletedRowIds ?? []).filter(id => !toDelete.has(id)), ...toDelete].slice(-DELETED_ROW_CAP);
  const tombstones = new Set(tombs);

  let rows = stored.rows;
  let conflicts: string[] = [];
  if (Array.isArray(incomingRows)) {
    const merged = mergeRevItems(stored.rows, incomingRows, { tombstones });
    rows = merged.items;
    conflicts = merged.conflicts;
  }
  rows = rows.filter(r => !toDelete.has(r.id));

  let groups = stored.groups;
  const refusedGroupStops: string[] = [];
  if (groupPatch?.underlying && groupPatch.patch && typeof groupPatch.patch === 'object') {
    // `underlying` is the key, never patched; an index missing from the stored list is left alone (the defaults add it).
    const { underlying: _u, ...patch } = groupPatch.patch;
    void _u;
    // Never stop an index that holds positions: a stopped index places no RE on SL / Tgt, so a leg that stops out
    // stays flat and the other leg is left naked (2026-11-09). Enforced here too, so no tab (stale bundle, second
    // window) can do it. The rest of the patch still applies.
    if (patch.enabled === false && rows.some(r => r.underlying === groupPatch.underlying && holdsPosition(r))) {
      delete patch.enabled;
      refusedGroupStops.push(groupPatch.underlying);
    }
    groups = stored.groups.map(g => (g.underlying === groupPatch.underlying ? { ...g, ...patch } : g));
  }
  const config: FocusToolConfig = { ...stored, ...rest, groups, rows, deletedRowIds: tombs };
  delete (config as { rev?: number }).rev;
  return { config, conflicts, refusedDeletes, refusedGroupStops };
}
