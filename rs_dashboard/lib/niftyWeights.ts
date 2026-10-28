import fs from 'fs';
import path from 'path';
import { parseWeightsCsv, type SeedRow } from './niftyContribution';

// index_constituents/nifty50_weights.csv, written by scripts/tools/refresh_nifty_weights.py. Reference data,
// not market data: a weight snapshot plus the close it was taken at (see niftyContribution.ts).
const FILE = path.join(path.resolve(process.cwd(), '..'), 'index_constituents', 'nifty50_weights.csv');

let cache: { mtime: number; rows: SeedRow[]; asOf: string | null } | null = null;

/** Parsed on mtime so the refresh script's atomic replace is picked up without a restart. */
export function readNiftyWeights(): { rows: SeedRow[]; asOf: string | null } {
  try {
    const mtime = fs.statSync(FILE).mtimeMs;
    if (cache && cache.mtime === mtime) return cache;
    const { rows, asOf } = parseWeightsCsv(fs.readFileSync(FILE, 'utf8'));
    cache = { mtime, rows, asOf };
    return cache;
  } catch {
    return { rows: [], asOf: null };
  }
}
