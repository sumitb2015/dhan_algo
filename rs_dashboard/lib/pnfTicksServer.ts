import fs from 'fs';
import path from 'path';
import type { TickRow } from './pnfTicks.ts';

// Reads the price bridge's tick log (scripts/tools/pnf_ws.py -> debug/pnf_ticks/<IST date>/<SEG>_<sid>.jsonl) for Renko Tick mode.
// Each file is append-only, so it is read once and then only its new bytes on each poll; a file that shrank (a new day's file
// recreated, a manual delete) is read again from the start. Read-only.

const TICKS_DIR = path.join(path.resolve(process.cwd(), '..'), 'debug', 'pnf_ticks');   // PROJECT_ROOT, as lib/pnfAutoServer.ts
/** Rows stamped within this of now are not served yet: both legs of one bridge pass are then always served together. */
export const SETTLE_MS = 400;

type Cached = { size: number; rest: string; rows: TickRow[] };
const cache = ((globalThis as { __pnfTicks?: Map<string, Cached> }).__pnfTicks ??= new Map());

export const istDate = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(0, 10);
export const tickFile = (day: string, seg: string, sid: string) => path.join(TICKS_DIR, day, `${seg}_${sid}.jsonl`);

function parseLines(text: string, out: TickRow[]): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (Array.isArray(r) && r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1])) out.push([r[0], r[1], Number.isFinite(r[2]) ? r[2] : 0]);
    } catch { /* a torn line: skipped */ }
  }
}

/** Every row in `file` (cached; only new bytes are read). Empty when the file does not exist. */
export function readTickFile(file: string): TickRow[] {
  let size: number;
  try { size = fs.statSync(file).size; } catch { cache.delete(file); return []; }
  let c = cache.get(file);
  if (!c || size < c.size) c = { size: 0, rest: '', rows: [] };
  if (size > c.size) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - c.size);
      const n = fs.readSync(fd, buf, 0, buf.length, c.size);
      const text = c.rest + buf.subarray(0, n).toString('utf8');
      const cut = text.lastIndexOf('\n');
      parseLines(cut >= 0 ? text.slice(0, cut) : '', c.rows);
      c.rest = cut >= 0 ? text.slice(cut + 1) : text;    // a line still being written waits for the next read
      c.size += n;
    } finally { fs.closeSync(fd); }
  }
  cache.set(file, c);
  return c.rows;
}

/** Rows with since < ms <= upTo (rows are time-ordered: the bridge appends with its own clock). */
export function rowsBetween(rows: TickRow[], since: number, upTo: number): TickRow[] {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= since) lo = mid + 1; else hi = mid; }
  let end = lo;
  while (end < rows.length && rows[end][0] <= upTo) end++;
  return rows.slice(lo, end);
}

/** Drops cached files of other days (called on each read, so a long-running server does not keep last week's ticks). */
export function forgetOtherDays(day: string): void {
  for (const k of cache.keys()) if (!k.includes(`${path.sep}${day}${path.sep}`)) cache.delete(k);
}
