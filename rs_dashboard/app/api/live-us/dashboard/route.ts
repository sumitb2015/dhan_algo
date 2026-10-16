import { NextResponse } from 'next/server';
import { buildUsRow, US_SUBSCRIBE_MAX } from '@/lib/usStocks';
import { getUsMaster, readUniverseFile, readUsBridgeHealth, readUsQuotes } from '@/lib/usStocksServer';
import { US_GROUPS, US_UNIVERSE_AS_OF, resolveUniverse } from '@/lib/usUniverse';
import { groupStats, movers, tagRows, universeBreadth } from '@/lib/usDashboard';

export const dynamic = 'force-dynamic';

// GET /api/live-us/dashboard - the US Markets dashboard view: every catalog symbol (lib/usUniverse.ts) with its latest quote,
// per-group breadth (sectors, AI themes, index/macro proxies), universe-wide breadth and movers. READ-ONLY.
// Quotes come from the bridge's snapshot file; a symbol is only live while the universe is enabled (or it is on the user's
// watchlist) and the bridge is running - otherwise its fields are the last saved values or null.
export async function GET(): Promise<NextResponse> {
  let master;
  try { master = await getUsMaster(); } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'US instrument list unavailable' }, { status: 502 });
  }
  const now = Date.now();
  const resolved = resolveUniverse(new Map(master.list.map(i => [i.symbol, i.id])));
  const quotes = readUsQuotes();
  const baseRows = [...resolved.idBySymbol.values()].flatMap(id => {
    const inst = master.byId.get(id);
    return inst ? [buildUsRow(inst, quotes?.quotes?.[id], now)] : [];
  });
  const rows = tagRows(US_GROUPS, baseRows);
  const bySymbol = new Map(rows.map(r => [r.symbol, r]));
  const h = readUsBridgeHealth();
  const u = readUniverseFile();
  return NextResponse.json({
    success: true,
    health: h.health, status: h.status,
    quotesAgeMs: typeof quotes?.updated_at === 'number' ? Math.max(0, now - quotes.updated_at) : null,
    serverTime: now,
    universe: { enabled: u.enabled, count: u.enabled ? u.ids.length : 0, subscribeMax: US_SUBSCRIBE_MAX, asOf: US_UNIVERSE_AS_OF },
    unresolved: resolved.unresolved,
    groups: groupStats(US_GROUPS, bySymbol),
    rows,
    breadth: universeBreadth(rows),
    ...movers(rows, 10),
  });
}
