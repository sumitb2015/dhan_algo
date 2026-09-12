/**
 * Shared formatting utilities for Futures-related components.
 * Import from here — do NOT redefine locally in FuturesDashboard, FuturesActionDesk,
 * OIBuildupDashboard, or FuturesOrderModal.
 */

/** Indian locale price with 2 decimal places. e.g. 24,563.50 */
export function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Compact Indian lakh/crore formatter — NO currency prefix.
 * e.g. 1_200_000 → "12.0L"
 */
export function fmtLakh(v: number): string {
  if (v >= 10_000_000) return (v / 10_000_000).toFixed(2) + 'Cr';
  if (v >= 1_00_000)   return (v / 1_00_000).toFixed(1) + 'L';
  if (v >= 1_000)      return (v / 1_000).toFixed(1) + 'K';
  return v.toFixed(0);
}

/**
 * Compact lakh/crore formatter WITH ₹ prefix (used in order ticket summaries).
 * e.g. 1_200_000 → "₹12.00 L"
 */
export function fmtLakhRs(v: number): string {
  if (v >= 10_000_000) return '₹' + (v / 10_000_000).toFixed(2) + ' Cr';
  if (v >= 1_00_000)   return '₹' + (v / 1_00_000).toFixed(2) + ' L';
  if (v >= 1_000)      return '₹' + (v / 1_000).toFixed(1) + ' K';
  return '₹' + v.toFixed(0);
}

/** Signed percentage. e.g. 1.23 → "+1.23%", -0.5 → "-0.50%" */
export function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}
