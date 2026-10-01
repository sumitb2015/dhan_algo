import type { FocusRow, FocusToolConfig } from './focusToolRows.ts';
import { mergeRevItems } from './revMerge.ts';

/** How many deleted row ids are remembered. */
export const DELETED_ROW_CAP = 200;

/** A save body. `deleteRowIds` asks for rows to be removed; `deletedRowIds`
 *  (the stored tombstone list) is server-owned and ignored if a client sends it. */
export type FocusConfigWrite = Partial<FocusToolConfig> & { deleteRowIds?: string[] };

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
): { config: FocusToolConfig; conflicts: string[]; refusedDeletes: string[] } {
  const { rows: incomingRows, deleteRowIds: incomingDeleted, deletedRowIds: _clientTombs, ...rest } = body;
  void _clientTombs;
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

  const config: FocusToolConfig = { ...stored, ...rest, rows, deletedRowIds: tombs };
  delete (config as { rev?: number }).rev;
  return { config, conflicts, refusedDeletes };
}
