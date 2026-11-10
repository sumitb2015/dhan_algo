/**
 * One parse per snapshot-file change, shared by /api/fresh-money (the board) and /api/fresh-money/trade (which strikes
 * and expiry may be traded). Server-only (fs). Today's file is re-parsed when the collector appends (mtime/size key);
 * a past day is parsed once.
 *
 * Only files the board must show keep their snapshots in memory (`keepSnaps`); history days keep just their small
 * per-minute summary — 14 days x 5 underlyings of full snapshots would be well over 100 MB.
 */
import fs from 'fs';
import {
  parseSnapshotCsv, latestExpiry, hasCumulativeVolume, summarizeDay, type DaySummary, type Snapshot,
} from './freshMoney.ts';

export interface ParsedDay {
  key: string;
  expiry: string;
  /** False for a 1-minute backfill (per-candle volume): unusable for a fresh share, never shown or traded from. */
  cumulative: boolean;
  summary: DaySummary | null;
  /** Snapshots of the latest expiry, oldest first (only when asked to keep them). */
  snaps: Snapshot[] | null;
}

const g = globalThis as unknown as { __fmParsed?: Map<string, ParsedDay> };
const cache = (g.__fmParsed ??= new Map<string, ParsedDay>());
const MAX_ENTRIES = 120;

export async function parsedDay(file: string, keepSnaps: boolean): Promise<ParsedDay | null> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key && (!keepSnaps || hit.snaps)) return hit;
  let text: string;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch { return null; }
  const all = parseSnapshotCsv(text);
  const expiry = latestExpiry(all);
  const snaps = all.filter(s => s.expiry === expiry);
  const cumulative = hasCumulativeVolume(snaps);
  const entry: ParsedDay = { key, expiry, cumulative, summary: cumulative ? summarizeDay(snaps) : null, snaps: keepSnaps ? snaps : null };
  cache.delete(file);
  cache.set(file, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  return entry;
}
