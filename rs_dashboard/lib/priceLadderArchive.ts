import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './lockedJsonFile.ts';
import type { LadderEvent, LadderSlice, LadderState } from './priceLadder.ts';
import type { LadderPair } from './priceLadderPair.ts';

// The Price Ladder's permanent trade record, one file per IST day: debug/price_ladder_archive_<YYYY-MM-DD>.json.
// The live ledger forgets finished trades at the day roll and on Clear; everything it is about to forget is merged into
// the day's archive FIRST (lib/priceLadderServer.ts updateLadderState). Merging is by id and idempotent, so a crash
// between the two writes just repeats the same merge (the pattern of lib/multiLegArchive.ts). Pure parts here, IO below.

export interface DayArchive {
  date: string;
  archivedAt: number;
  slices: LadderSlice[];
  pairs: LadderPair[];
  events: LadderEvent[];
  guards?: LadderState['guards'];
}

export interface ArchivePart {
  slices?: LadderSlice[];
  pairs?: LadderPair[];
  events?: LadderEvent[];
  guards?: LadderState['guards'];
}

const byId = <T extends { id: string }>(old: readonly T[], add: readonly T[]): T[] => {
  const ids = new Set(add.map(x => x.id));
  return [...old.filter(x => !ids.has(x.id)), ...add];
};

/** `existing` + `add`: slices and pairs by id (the later copy wins), events de-duplicated and in time order, guards = latest. */
export function mergeDayArchive(existing: DayArchive | null, date: string, add: ArchivePart, now: number): DayArchive {
  const seen = new Set<string>();
  const events = [...(existing?.events ?? []), ...(add.events ?? [])]
    .filter(e => { const k = `${e.at}|${e.msg}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.at - b.at);
  return {
    date,
    archivedAt: now,
    slices: byId(existing?.slices ?? [], add.slices ?? []),
    pairs: byId(existing?.pairs ?? [], add.pairs ?? []),
    events,
    ...((add.guards ?? existing?.guards) ? { guards: add.guards ?? existing?.guards } : {}),
  };
}

/**
 * What one ledger write is about to drop, as `{date, part}` (null when nothing):
 *  - the day rolled (`base !== raw`): the WHOLE pre-roll ledger of `raw.date`, carried positions included (they appear as
 *    they stood at day end; their later life is archived under the day they finish);
 *  - same day: any slice / pair in `base` that `next` no longer has (the Clear button).
 */
export function partsToArchive(raw: LadderState, base: LadderState, next: LadderState): { date: string; part: ArchivePart } | null {
  if (base !== raw) {
    if (!raw.slices.length && !(raw.pairs ?? []).length && !raw.events.length && !Object.keys(raw.guards ?? {}).length) return null;
    return { date: raw.date, part: { slices: raw.slices, pairs: raw.pairs ?? [], events: raw.events, guards: raw.guards } };
  }
  if (next === base) return null;
  const keepS = new Set(next.slices.map(x => x.id)), keepP = new Set((next.pairs ?? []).map(x => x.id));
  const slices = base.slices.filter(x => !keepS.has(x.id));
  const pairs = (base.pairs ?? []).filter(x => !keepP.has(x.id));
  return slices.length || pairs.length ? { date: base.date, part: { slices, pairs } } : null;
}

// The date comes from the ledger file: only a plain YYYY-MM-DD may reach a file name (anything else is filed as 'undated').
export const archiveFile = (dir: string, date: string) => path.join(dir, `price_ladder_archive_${/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'undated'}.json`);

/** Merge `part` into the day's archive file (created if absent). Throws on an IO error; the caller decides what that means. */
export function archiveDay(dir: string, date: string, part: ArchivePart, now = Date.now()): void {
  const file = archiveFile(dir, date);
  let existing: DayArchive | null = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) as DayArchive; } catch (err) {
    // A missing file is a first write. An unreadable one holds earlier trades, so it is kept aside (never overwritten) and
    // today's part is written to a fresh file: failing here would drop the part at the day roll.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') fs.renameSync(file, `${file}.corrupt_${now}`);
  }
  writeJsonAtomic(file, mergeDayArchive(existing, date, part, now));
}
