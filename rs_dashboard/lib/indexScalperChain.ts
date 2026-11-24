// Option chain SNAPSHOT for /index-scalper when the live tick bridge has nothing to show (holiday, weekend, before the
// bridge is up, bridge down). Pure: turns /api/options/chain's Dhan REST response into the bridge's LiveQuotes shape so
// the chain panel draws it the same way. It is display data only: the page never prices or fills an order from it.

import type { LiveQuotes, OptionSide, StrikeData } from '@/components/Scalper';
import { classifyBuildup } from './breakdownBacktest.ts';

interface RestSide {
  last_price?: number;
  oi?: number;
  volume?: number;
  previous_close_price?: number;
  previous_oi?: number;
}

export interface RestChain {
  chain?: { oc?: Record<string, { ce?: RestSide; pe?: RestSide }> };
  spot?: number;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function side(s: RestSide | undefined): OptionSide {
  const ltp = finite(s?.last_price) ?? 0;
  const oi = finite(s?.oi) ?? 0;
  // Dhan's field is previous_close_price (docs/API_GOTCHAS.md); 0 / missing means "no previous close", not a 0 price.
  const pc = finite(s?.previous_close_price);
  const poi = finite(s?.previous_oi);
  const change_pct = pc && pc > 0 && ltp > 0 ? ((ltp - pc) / pc) * 100 : undefined;
  const oi_chg_pct = poi && poi > 0 ? ((oi - poi) / poi) * 100 : undefined;
  return {
    ltp, oi, volume: finite(s?.volume) ?? 0,
    prev_close: pc ?? undefined, change_pct, oi_chg_pct, prev_oi: poi && poi > 0 ? poi : undefined,
    // the live bridge's own rule (same dead-bands), so a strike reads the same label live and in a snapshot
    buildup: change_pct !== undefined && oi_chg_pct !== undefined ? classifyBuildup(change_pct, oi_chg_pct) : undefined,
  };
}

/** LiveQuotes-shaped snapshot, or null when the response has no strikes or no spot. `asOfMs` is when the route's data
 *  was fetched (its `as_of` when it served a stale copy). */
export function chainSnapshot(resp: RestChain, underlying: string, expiry: string, asOfMs: number): LiveQuotes | null {
  const oc = resp.chain?.oc;
  const spot = finite(resp.spot) ?? finite((resp.chain as Record<string, unknown> | undefined)?.last_price);
  if (!oc || !spot || spot <= 0) return null;
  const strikes: Record<string, StrikeData> = {};
  // Dhan keys strikes as "25350.000000": key by the number, as the bridge does.
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    strikes[String(strike)] = { strike, ce: side(v.ce), pe: side(v.pe) };
  }
  const list = Object.values(strikes);
  if (list.length === 0) return null;
  const atm = list.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), list[0].strike);
  const a = strikes[String(atm)];
  return {
    updated_at: new Date(asOfMs).toISOString(), underlying, expiry, spot, atm,
    straddle_premium: (a?.ce.ltp ?? 0) + (a?.pe.ltp ?? 0),
    strikes,
  };
}
