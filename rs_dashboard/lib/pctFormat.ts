// Shared % formatting/colouring helpers for performance-style tables
// (Performance page, Stock Ranking, and similar). Keeping one copy avoids the
// rounding/colour-threshold convention drifting between pages that show the
// same underlying % values.

export function pctFrom(close: number, ma: number): number | null {
  if (!ma) return null;
  return ((close - ma) / ma) * 100;
}

export function pctFmt(v: number | null | undefined, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
}

export function pctColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'text-zinc-400';
  if (v > 0) return 'text-emerald-300';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}
