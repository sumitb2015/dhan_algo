/**
 * Shared client for the multi-leg options margin summary (/api/options/margin,
 * backed by DhanHelper.get_multi_leg_margin_summary). Reused by any dashboard
 * page that shows Funds & Margins so the fetch/parse shape isn't re-hand-rolled.
 */

export interface MarginLegInput {
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  qtyLots: number;
  price: number;
}

export interface MarginSummary {
  /** Portfolio-netted margin the position actually blocks (Dhan's "Final Margin"). */
  total_margin: number;
  span_margin: number;
  exposure_margin: number;
  /** Sum of each leg's standalone margin, no netting (Dhan's "Overall Margin"). */
  overall_margin: number;
  /** overall_margin − total_margin. */
  hedge_benefit: number;
  available_funds: number;
}

/**
 * Fetch the margin summary for a set of option legs. Returns null on any
 * failure (network, auth, empty legs) so callers can render a neutral "—".
 * Margin is always computed against Dhan regardless of any order-placement
 * broker selection — the backend script is Dhan-only.
 */
export async function fetchMarginSummary(
  underlying: string,
  expiry: string,
  legs: MarginLegInput[],
  signal?: AbortSignal,
): Promise<MarginSummary | null> {
  if (!expiry || legs.length === 0) return null;
  try {
    const res = await fetch('/api/options/margin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ underlying, expiry, legs }),
      signal,
    });
    const json = await res.json();
    if (!json?.success || !json.data) return null;
    const d = json.data;
    return {
      total_margin: d.total_margin ?? 0,
      span_margin: d.span_margin ?? 0,
      exposure_margin: d.exposure_margin ?? 0,
      overall_margin: d.overall_margin ?? 0,
      hedge_benefit: d.hedge_benefit ?? 0,
      available_funds: d.available_funds ?? 0,
    };
  } catch {
    return null;
  }
}
