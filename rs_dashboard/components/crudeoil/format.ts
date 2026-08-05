// Formatters and pure chain maths for the Crude Oil options terminal.

import type { OptionSide, RawChainEntry } from './types';

export function fmtNum(n: number, dec = 0): string {
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  });
}

export function fmtOI(n: number): string {
  if (n === 0) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${sign}${(abs / 100_000).toFixed(1)}L`;
  if (abs >= 1_000)      return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
}

export function fmtLTP(n: number | undefined): string {
  if (!n) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

export function fmtPnl(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${n < 0 ? '-' : '+'}₹${abs}`;
}

/** Volume — same compaction as OI but 0 renders as a dash, not "0". */
export function fmtVol(n: number | undefined): string {
  if (!n) return '—';
  return fmtOI(n);
}

/** Signed OI change (oi − previous_oi), already compacted. */
export function fmtDelta(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : ''}${fmtOI(n)}`;
}

export function fmtIV(n: number | null | undefined): string {
  if (!n || n <= 0) return '—';
  return `${n.toFixed(1)}%`;
}

export function pctColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

export function pctSign(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

export function statusColor(status: string): string {
  const s = status.toUpperCase();
  if (s.includes('TRADED') || s.includes('EXECUTED') || s.includes('COMPLETE')) return 'text-emerald-400';
  if (s.includes('REJECT') || s.includes('CANCEL')) return 'text-red-400';
  if (s.includes('PENDING') || s.includes('OPEN') || s.includes('TRANSIT')) return 'text-amber-400';
  return 'text-zinc-400';
}

/** Dhan reports IV either at the top level or nested under greeks, depending on segment. */
export function sideIV(side: OptionSide | null | undefined): number | null {
  const iv = side?.implied_volatility ?? side?.greeks?.iv;
  return iv && iv > 0 ? iv : null;
}

/** oi − previous_oi, or null when the API omitted previous_oi. */
export function sideDeltaOI(side: OptionSide | null | undefined): number | null {
  if (!side || side.previous_oi === undefined || side.previous_oi === null) return null;
  return (side.oi ?? 0) - side.previous_oi;
}

export interface StrikeEntry { key: string; strike: number; entry: RawChainEntry }

export function parseStrikeEntries(oc: Record<string, RawChainEntry>): StrikeEntry[] {
  return Object.entries(oc)
    .map(([key, entry]) => ({ key, strike: Number(key), entry }))
    .filter(x => !isNaN(x.strike))
    .sort((a, b) => a.strike - b.strike);
}

export function computeMaxPain(entries: StrikeEntry[]): number {
  if (!entries.length) return 0;
  let maxPain = entries[0].strike;
  let minPayout = Infinity;
  for (const { strike: K } of entries) {
    let payout = 0;
    for (const { strike: s, entry } of entries) {
      payout += (entry.ce?.oi ?? 0) * Math.max(0, K - s);
      payout += (entry.pe?.oi ?? 0) * Math.max(0, s - K);
    }
    if (payout < minPayout) { minPayout = payout; maxPain = K; }
  }
  return maxPain;
}

/** Calendar days from today to the given ISO expiry date. Negative if past. */
export function daysToExpiry(expiry: string): number | null {
  if (!expiry) return null;
  const d = new Date(expiry);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / 86_400_000);
}

export function fmtExpiryShort(expiry: string): string {
  if (!expiry) return '—';
  const d = new Date(expiry);
  if (isNaN(d.getTime())) return expiry;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function fmtExpiryLong(expiry: string): string {
  if (!expiry) return '—';
  const d = new Date(expiry);
  if (isNaN(d.getTime())) return expiry;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Local YYYY-MM-DD — the DATA: chip every data page carries. */
export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
