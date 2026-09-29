const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "2026-10-27" → "27 OCT" */
export function fmtExpiry(e: string): string {
  const [, m, d] = e.split('-');
  const mi = Number(m) - 1;
  return `${Number(d)} ${MONTHS[mi] ?? m}`;
}

export function fmtStrike(s: number): string {
  return Number.isInteger(s) ? s.toLocaleString('en-IN') : s.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

/** 1340 → "1.3K", 12500000 → "1.3Cr" style compact lots/volume. */
export function fmtCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return a >= 100 ? v.toFixed(0) : String(Math.round(v * 10) / 10);
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtSigned(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

export function toneClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'text-zinc-500';
  return v > 0 ? 'text-emerald-400' : 'text-red-400';
}

/** Epoch seconds → "12:06" IST. */
export function fmtIstTime(epochSec: number | null | undefined, withSeconds = false): string {
  if (!epochSec) return '—';
  return new Date(epochSec * 1000).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
    hour12: false,
  });
}

export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';
