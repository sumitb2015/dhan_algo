// Indian-locale number formatting shared across dashboard pages.
//
// Only formatters that were byte-identical across files live here. The many
// local fmtNum/fmtOI copies elsewhere differ in default precision (0 vs 2
// decimals), null handling and compact-unit style (" Cr" vs "Cr", 1 vs 2
// decimals on L), so swapping them for one function would silently change
// on-screen numbers — migrate those deliberately, one call site at a time.

/** en-IN grouping with exactly `dec` decimals. e.g. 1234567 → "12,34,567" */
export function fmtNum(n: number, dec = 0): string {
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  });
}
