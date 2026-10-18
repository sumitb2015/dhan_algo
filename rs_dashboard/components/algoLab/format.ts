import type { CellValue, Col } from '@/lib/algoLab/types';

export const inr = (n: number | null | undefined, sign = true) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = sign ? (n > 0 ? '+' : n < 0 ? '-' : '') : n < 0 ? '-' : '';
  return `${s}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
};
export const px = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(2));
export const pnlTone = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-red-400';

/** A strategy-defined cell (StrategyDefinition.columns). */
export function fmtCell(col: Col, v: CellValue | undefined): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  switch (col.fmt) {
    case 'int':
      return String(Math.round(v));
    case 'pct':
      return `${v.toFixed(col.digits ?? 1)}%`;
    case 'text':
      return String(v);
    default:
      return v.toFixed(col.digits ?? 2);
  }
}

const EXIT_TONES: Record<string, string> = {
  TARGET: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  TRAIL_STOP: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  STOP: 'bg-red-500/10 text-red-400 border-red-500/30',
  EOD: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  SESSION_END: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  MANUAL: 'bg-zinc-800 text-zinc-300 border-zinc-700',
};
/** Generic exits have fixed tones; strategy-defined exits (RECOVERY, MOMENTUM_LOST, ...) are amber. */
export const exitTone = (kind: string) => EXIT_TONES[kind] ?? 'bg-amber-500/10 text-amber-400 border-amber-500/30';
export const exitLabel = (kind: string) => kind.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
