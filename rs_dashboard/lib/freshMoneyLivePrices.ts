/**
 * Fresh Money board — live WebSocket LTPs on the page (pure; browser and server). DISPLAY ONLY.
 *
 * The trade state (positions, P&L) is polled every 2 s and the board snapshot's PE / CE price every ~30 s; between them
 * the screen looked frozen while the WebSocket ticked. /api/fresh-money/live (polled every second) also returns the
 * WebSocket LTP of the board's strikes and of the open positions, and the page re-prices with them here. Exits,
 * targets and stop-losses never read this: they run on the server (freshMoneyExitServer.ts) from its own prices.
 */
import type { FmPosition, FmSegment } from './freshMoneyTrades.ts';

/** At most this many position contracts per live request (the page holds far fewer). */
export const LIVE_IDS_MAX = 60;

/** `NSE_FNO:45408,MCX_COMM:573423` → validated pairs (unknown segments / non-numeric ids dropped, deduplicated, capped). */
export function parseLiveIds(raw: string | null): { segment: FmSegment; id: string }[] {
  if (!raw) return [];
  const out = new Map<string, { segment: FmSegment; id: string }>();
  for (const part of raw.split(',')) {
    const [seg, id] = part.split(':');
    if ((seg !== 'NSE_FNO' && seg !== 'MCX_COMM') || !/^\d{1,12}$/.test(id ?? '')) continue;
    out.set(`${seg}:${id}`, { segment: seg, id });
    if (out.size >= LIVE_IDS_MAX) break;
  }
  return [...out.values()];
}

/** The `ids` parameter for the open positions (one entry per contract). */
export function liveIdsParam(positions: readonly FmPosition[]): string {
  const keys = new Set<string>();
  for (const p of positions) if (p.netQty !== 0 && p.priceId) keys.add(`${p.segment ?? 'NSE_FNO'}:${p.priceId}`);
  return [...keys].sort().slice(0, LIVE_IDS_MAX).join(',');
}

/**
 * Positions re-priced at the live LTPs (by `priceId`), with the same formula as buildPositions: unrealised =
 * (ltp − avg) × netQty × mult, pnl = realised + unrealised (null when either is unknown). A position without a live
 * price, or a flat one, is returned unchanged. The array (and each untouched position) is kept when nothing changed,
 * so React memos downstream do not re-run.
 */
export function withLiveLtps(positions: readonly FmPosition[], ltps: Readonly<Record<string, number>> | null): FmPosition[] {
  if (!ltps) return positions as FmPosition[];
  let changed = false;
  const out = positions.map(p => {
    const ltp = ltps[p.priceId];
    if (p.netQty === 0 || !(ltp > 0) || ltp === p.ltp) return p;
    changed = true;
    const unrealised = p.avgPrice !== null ? (ltp - p.avgPrice) * p.netQty * p.mult : null;
    const pnl = unrealised === null || p.realised === null ? null : p.realised + unrealised;
    return { ...p, ltp, unrealised, pnl };
  });
  return changed ? out : (positions as FmPosition[]);
}
