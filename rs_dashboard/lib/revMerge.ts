/**
 * Per-item revision merge for JSON stores that several browser tabs save to.
 *
 * A whole-object last-write-wins save lets a tab holding an old copy write it
 * back over newer data (2026-10-01: Multi-Leg Focus repairs undone by an open
 * tab; the Focus Tool saves every row's fill ledger on every fill). Instead
 * each item carries a `rev` the saving tab bumps only when that item changed
 * since its last save (stampItems); the server keeps, per item, the higher
 * rev (mergeRevItems); and the tab takes the merged copy back for every item
 * it has not changed since sending (adoptItems).
 *
 * The bump is relative to what THIS tab last saved or adopted, so callers must
 * save from fresh state (a setState updater's `prev`), never from a render
 * closure: a stale copy differs from the last save and would be stamped as a
 * newer change.
 */

export interface RevItem { id: string; rev?: number }

/** JSON with sorted keys and undefined dropped, so key order can't fake a change. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** An item's content for change detection: everything but rev and updatedAt. */
export function itemBody(x: object): string {
  const rest = { ...(x as Record<string, unknown>) };
  delete rest.rev;
  delete rest.updatedAt;
  return canon(rest);
}

/**
 * Server side. Per id: the higher rev wins; at the same rev with different
 * content the stored copy wins (it was saved first) and the id is reported
 * as a conflict. Incoming items with a tombstoned id are ignored (deleted
 * elsewhere). Stored items missing from `incoming` are kept unless
 * `dropMissing` says otherwise.
 */
export function mergeRevItems<T extends RevItem>(
  stored: T[],
  incoming: T[],
  opts: { tombstones?: Set<string>; dropMissing?: (stored: T) => boolean } = {},
): { items: T[]; conflicts: string[] } {
  const byId = new Map(stored.map(s => [s.id, s]));
  const seen = new Set<string>();
  const conflicts: string[] = [];
  const items: T[] = [];
  for (const inc of incoming) {
    if (opts.tombstones?.has(inc.id) || seen.has(inc.id)) continue;
    seen.add(inc.id);
    const st = byId.get(inc.id);
    if (!st || (inc.rev ?? 0) > (st.rev ?? 0)) { items.push(inc); continue; }
    if ((inc.rev ?? 0) === (st.rev ?? 0) && itemBody(inc) !== itemBody(st)) conflicts.push(inc.id);
    items.push(st);
  }
  for (const st of stored) {
    if (seen.has(st.id)) continue;
    if (opts.dropMissing?.(st)) continue;
    items.push(st);
  }
  return { items, conflicts };
}

/** Client side: last saved rev + body per item key. */
export type RevBook = Map<string, { rev: number; body: string }>;

/** Records items as the server now holds them (on load, or from a save's response). */
export function noteItems(book: RevBook, prefix: string, items: RevItem[]): void {
  for (const it of items) book.set(`${prefix}${it.id}`, { rev: it.rev ?? 0, body: itemBody(it) });
}

/** Stamps the rev to send: unchanged items keep theirs, changed or new ones go up by one. */
export function stampItems<T extends RevItem>(book: RevBook, prefix: string, items: T[]): T[] {
  return items.map(it => {
    const key = `${prefix}${it.id}`;
    const body = itemBody(it);
    const prev = book.get(key);
    const rev = prev ? (prev.body === body ? prev.rev : prev.rev + 1) : (it.rev ?? 0) + 1;
    book.set(key, { rev, body });
    return { ...it, rev };
  });
}

/**
 * Takes the server's copy of every item this tab has NOT changed since it
 * sent `sent` (a change made while the save was in flight goes out with its
 * own save and must not be reverted), adds items only the server has, and
 * drops items the server no longer has that this tab did not just add.
 * Returns `local` itself when nothing differs.
 */
export function adoptItems<T extends RevItem>(local: T[], sent: T[], server: T[]): T[] {
  const sentBody = new Map(sent.map(s => [s.id, itemBody(s)]));
  const serverById = new Map(server.map(s => [s.id, s]));
  let changed = false;
  const out: T[] = [];
  for (const l of local) {
    const sv = serverById.get(l.id);
    const untouched = sentBody.get(l.id) === itemBody(l);
    if (!sv) {
      // Gone on the server (deleted elsewhere): drop it unless it is a local
      // change the server hasn't seen yet.
      if (untouched) { changed = true; continue; }
      out.push(l);
      continue;
    }
    if (untouched && itemBody(sv) !== itemBody(l)) { out.push(sv); changed = true; continue; }
    out.push(l);
  }
  const localIds = new Set(local.map(l => l.id));
  for (const sv of server) {
    if (!localIds.has(sv.id) && !sentBody.has(sv.id)) { out.push(sv); changed = true; }
  }
  return changed ? out : local;
}
