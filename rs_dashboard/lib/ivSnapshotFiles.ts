/**
 * Where the IV snapshot collector's CSVs live and how they are named, shared by the routes that read them
 * (IV Charts' /api/options/iv-history and the Fresh Money board's /api/fresh-money).
 */
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

export const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

export function getPrefixesForUnderlying(underlying: string): string[] {
  const u = (underlying || 'NIFTY').toUpperCase();
  if (u === 'CRUDEOIL') {
    return ['crudeoil_oi_snapshots_', 'iv_snapshots_CRUDEOIL_'];
  }
  if (u === 'CRUDEOILM') {
    return ['crudeoilm_oi_snapshots_', 'crudeoil_oi_snapshots_', 'iv_snapshots_CRUDEOILM_'];
  }
  if (u === 'BANKNIFTY') {
    return ['iv_snapshots_BANKNIFTY_', 'banknifty_oi_snapshots_'];
  }
  if (u === 'SENSEX') {
    return ['iv_snapshots_SENSEX_', 'sensex_oi_snapshots_'];
  }
  if (u === 'NIFTY') {
    return ['iv_snapshots_NIFTY_', 'iv_snapshots_'];
  }
  return [`iv_snapshots_${u}_`];
}

/**
 * Only this underlying's own files. getPrefixesForUnderlying lets CRUDEOILM fall back to CRUDEOIL's snapshots (a
 * different contract: its OI and volume are not CRUDEOILM's), which is fine for IV Charts' history but wrong for a
 * per-contract board or for deciding which contracts may be traded (the Fresh Money board passes strict).
 */
export function strictPrefixes(underlying: string): string[] {
  const u = (underlying || 'NIFTY').toUpperCase();
  if (u === 'CRUDEOIL') return ['crudeoil_oi_snapshots_', 'iv_snapshots_CRUDEOIL_'];
  if (u === 'CRUDEOILM') return ['crudeoilm_oi_snapshots_', 'iv_snapshots_CRUDEOILM_'];
  return getPrefixesForUnderlying(u);
}

/** Snapshot dates present on disk for this underlying, newest first. */
export function listDates(underlying: string, fallbackToNifty = true, strict = false): string[] {
  if (!fs.existsSync(DEBUG_DIR)) return [];
  const prefixes = strict ? strictPrefixes(underlying) : getPrefixesForUnderlying(underlying);
  const files = fs.readdirSync(DEBUG_DIR);
  const dates = new Set<string>();

  for (const prefix of prefixes) {
    for (const f of files) {
      if (f.startsWith(prefix) && f.endsWith('.csv')) {
        const d = f.slice(prefix.length, -4);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          dates.add(d);
        }
      }
    }
  }

  // Fallback: if no date exists for this specific underlying, offer NIFTY's available dates
  // so the date picker in IV charts has valid session dates to request.
  if (fallbackToNifty && dates.size === 0 && underlying.toUpperCase() !== 'NIFTY') {
    return listDates('NIFTY');
  }

  return [...dates].sort((a, b) => b.localeCompare(a));
}

export function resolveCsvPath(underlying: string, date: string, strict = false): string | null {
  const prefixes = strict ? strictPrefixes(underlying) : getPrefixesForUnderlying(underlying);
  for (const prefix of prefixes) {
    const candidate = path.join(DEBUG_DIR, `${prefix}${date}.csv`);
    if (fs.existsSync(candidate)) {
      try {
        if (fs.statSync(candidate).size > 200) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}
