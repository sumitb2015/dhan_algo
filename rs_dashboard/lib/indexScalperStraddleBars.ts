// Straddle (CE + PE premium) candles for the Index Scalper's Straddle pane. Pure: no React, no fetch.
// Tested in indexScalperStraddleBars.test.ts.
//
// Mirrors `combine_legs_ohlc` in scripts/tools/options_chart_fetch.py (the Live Options Charts' straddle), weight 1 per
// leg: bars join on their time (a minute only one leg traded is dropped, never priced from one leg), open / close are
// sums, and high / low are the widest of "CE high + PE low", "CE low + PE high", open and close. The two legs' highs did
// not happen at the same moment, so CE high + PE high would overstate the straddle's range.

export interface LegBar { t: number; o: number; h: number; l: number; c: number; v?: number }

export function combineStraddleBars(ce: LegBar[], pe: LegBar[]): LegBar[] {
  const peAt = new Map(pe.map(b => [b.t, b]));
  const out: LegBar[] = [];
  for (const a of ce) {
    const b = peAt.get(a.t);
    if (!b) continue;
    const o = a.o + b.o;
    const c = a.c + b.c;
    const up = a.h + b.l;
    const down = a.l + b.h;
    const bar: LegBar = { t: a.t, o, h: Math.max(up, down, o, c), l: Math.min(up, down, o, c), c };
    // Volume only when both legs report it (an option always does; a missing one would understate the VWAP weight).
    if (a.v !== undefined && b.v !== undefined) bar.v = a.v + b.v;
    out.push(bar);
  }
  return out.sort((x, y) => x.t - y.t);
}

/** Live straddle price: both legs' live prices or nothing (never one live leg plus a stale or missing one). */
export function straddleLive(ce: number | null | undefined, pe: number | null | undefined): number | null {
  if (ce === null || ce === undefined || pe === null || pe === undefined) return null;
  if (!(ce > 0) || !(pe > 0)) return null;
  return ce + pe;
}
