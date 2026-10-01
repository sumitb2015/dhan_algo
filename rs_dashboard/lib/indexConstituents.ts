import fs from 'fs';
import path from 'path';
import { parseConstituentSymbols, readNifty500List } from './dataLoader';

// NSE index constituent lists, saved by scripts/download_index_constituents.py into
// index_constituents/ (verbatim NSE CSVs + manifest.json). Reference data, not market data.
// Only members that are also in the Nifty 500 scanner universe are returned, because that is all
// the RS Strategy page can show; `total` keeps NSE's own count so a partial overlap is visible.

const DIR = path.join(path.resolve(process.cwd(), '..'), 'index_constituents');

export interface IndexInfo {
  key: string;
  label: string;
  total: number; // constituents in NSE's file
  count: number; // of those, in the Nifty 500 universe
  downloaded: string; // YYYY-MM-DD
  symbols: string[]; // universe members only
}

interface Manifest { order?: string[]; indices: Record<string, { label: string; file: string; count: number; downloaded: string }> }

let cache: { mtime: number; data: IndexInfo[] } | null = null;

export function readIndexConstituents(): IndexInfo[] {
  let mtime: number;
  try { mtime = fs.statSync(path.join(DIR, 'manifest.json')).mtimeMs; } catch { return []; }
  if (cache && cache.mtime === mtime) return cache.data;

  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as Manifest;
  const universe = new Set(readNifty500List());
  const data: IndexInfo[] = [];
  for (const key of manifest.order ?? Object.keys(manifest.indices)) {
    const m = manifest.indices[key];
    if (!m) continue;
    try {
      const all = parseConstituentSymbols(fs.readFileSync(path.join(DIR, path.basename(m.file)), 'utf8'));
      data.push({ key, label: m.label, total: all.length, count: all.filter((s) => universe.has(s)).length, downloaded: m.downloaded, symbols: all.filter((s) => universe.has(s)) });
    } catch { /* a missing or unreadable list just drops that index from the menu */ }
  }
  cache = { mtime, data };
  return data;
}
