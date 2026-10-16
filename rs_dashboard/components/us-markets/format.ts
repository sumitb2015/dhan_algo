// Shared formatting for the US Markets page. Display only.
import type { UsQuoteRow } from '@/lib/usStocks';

export const usd = (v: number | null, dec = 2) => (v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
export const compact = (v: number | null) => (v == null ? '–' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v));
export const signCls = (v: number | null) => (v == null || v === 0 ? 'text-zinc-300' : v > 0 ? 'text-emerald-400' : 'text-red-400');
export const pctText = (v: number | null, dec = 2) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(dec)}%`);

/** Seconds below a minute, then minutes/hours - a tick feed needs the seconds that fmtAge drops. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** The US trading date of the newest quote, in New York time - the date the numbers belong to. */
export function usDataDate(rows: readonly UsQuoteRow[], serverTime: number): string | null {
  let ageMin: number | null = null;
  for (const r of rows) if (r.tradeAgeMs != null && (ageMin == null || r.tradeAgeMs < ageMin)) ageMin = r.tradeAgeMs;
  if (ageMin == null) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(serverTime - ageMin);
}

/** Heatmap fill for a % change. Literal class strings (Tailwind cannot see built ones); null = not quoted yet. */
export function heatCls(pct: number | null): string {
  if (pct == null) return 'bg-zinc-900 border-zinc-800';
  if (pct >= 3) return 'bg-emerald-500/60 border-emerald-500/60';
  if (pct >= 1.5) return 'bg-emerald-500/40 border-emerald-500/40';
  if (pct >= 0.5) return 'bg-emerald-500/25 border-emerald-500/30';
  if (pct > 0.05) return 'bg-emerald-500/10 border-emerald-500/20';
  if (pct >= -0.05) return 'bg-zinc-800 border-zinc-700';
  if (pct > -0.5) return 'bg-red-500/10 border-red-500/20';
  if (pct > -1.5) return 'bg-red-500/25 border-red-500/30';
  if (pct > -3) return 'bg-red-500/40 border-red-500/40';
  return 'bg-red-500/60 border-red-500/60';
}
