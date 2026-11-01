// Which instruments the P&F / Renko price bridge (scripts/tools/pnf_ws.py) should stream, as asked by every chart this server
// process serves. Pure: the live route keeps the map and writes the union to its pnf_ws_wanted_<pid>.json.
//
// Each chart polls the live route about once a second with its own instrument(s). Writing only the latest poll's instruments made
// two charts on different instruments (the dual view, or a P&F and a Renko tab) replace each other every second: the bridge kept
// dropping and re-subscribing them, and a re-subscribed price does not count until it changes again, so a chart lost its live price.

export type WantedPair = [string, string];
/** key ("SEG:ID[,SEG:ID]") -> the pairs a chart asked for and when it last asked. */
export type WantedMap = Map<string, { pairs: WantedPair[]; seenAt: number }>;

/**
 * A chart that has not polled for this long is closed. The page polls every second, but Chrome throttles the timers of a tab
 * hidden for a few minutes to about once a minute, and that tab can be the leader running AUTO / the rail: its instruments must
 * outlive a throttled minute, or each other chart's poll would drop and re-subscribe them.
 */
export const WANTED_KEEP_MS = 75_000;
/** More than this many distinct pairs is not a page's doing: the oldest asks are dropped first. */
export const WANTED_MAX_PAIRS = 40;

const pairKey = (p: WantedPair) => `${p[0]}:${p[1]}`;

/**
 * Records one poll (`key` / `pairs` at `now`), forgets charts silent for WANTED_KEEP_MS, and returns the union of what is still
 * wanted (sorted, de-duplicated, newest asks kept when over WANTED_MAX_PAIRS) plus its signature, so the caller rewrites the
 * bridge's file only when the set changes.
 */
export function noteWanted(map: WantedMap, key: string, pairs: WantedPair[], now: number): { pairs: WantedPair[]; signature: string } {
  map.set(key, { pairs, seenAt: now });
  for (const [k, v] of map) if (now - v.seenAt > WANTED_KEEP_MS) map.delete(k);
  const byPair = new Map<string, { pair: WantedPair; seenAt: number }>();
  for (const v of map.values()) for (const p of v.pairs) {
    const k = pairKey(p);
    const cur = byPair.get(k);
    if (!cur || cur.seenAt < v.seenAt) byPair.set(k, { pair: p, seenAt: v.seenAt });
  }
  const kept = [...byPair.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, WANTED_MAX_PAIRS).map(x => x.pair);
  kept.sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  return { pairs: kept, signature: kept.map(pairKey).join(',') };
}
