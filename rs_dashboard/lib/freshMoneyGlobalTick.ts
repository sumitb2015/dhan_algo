/**
 * Fresh Money GLOBAL target / stop-loss watcher — one tick, every outside effect injected (testable without a broker).
 * REAL MONEY: `deps.close` is the page's own close path (closePositionCore), wired by lib/freshMoneyExitServer.ts.
 *
 * The record is claimed ('firing') under the ledger lock BEFORE any close is sent, so the exit goes at most once. Shorts
 * are closed first, one at a time; if a short's cover does not go out, no hedge is closed after it.
 */
import type { CloseResult, Streak } from './freshMoneyExits.ts';
import {
  closeOrder, globalAfterClose, mustStopAfter, nextGlobalAction, totalPnl, type FmGlobalExit,
} from './freshMoneyGlobalExit.ts';
import { buildPositions, type FmLedger, type FmPosition, type FmSegment } from './freshMoneyTrades.ts';

export interface GlobalTickDeps {
  now(): number;
  readLedger(): FmLedger;
  mutate<T>(fn: (l: FmLedger) => T): Promise<T>;
  prices(items: { id: string; segment: FmSegment }[]): Promise<Record<string, number>>;
  /** The market is open or close-only for this position and its broker session is usable. */
  canExit(p: FmPosition): boolean;
  close(key: string, reason: string): Promise<CloseResult>;
  log(msg: string): void;
  refresh(): Promise<void>;
}

const same = (a: FmGlobalExit | undefined, b: FmGlobalExit) =>
  !!a && a.state === b.state && a.armedAt === b.armedAt && a.target === b.target && a.sl === b.sl;

/** `streak` is the one global streak, kept in the watcher's memory (null = none). */
export async function runGlobalTick(deps: GlobalTickDeps, streak: { cur: Streak | null }): Promise<void> {
  const g0 = deps.readLedger().global;
  if (!g0) { streak.cur = null; return; }
  if (g0.state === 'watching') await deps.refresh().catch(err => deps.log(`broker refresh failed: ${String((err as Error)?.message ?? err)}`));
  const l = deps.readLedger();
  const g = l.global;
  if (!g) { streak.cur = null; return; }
  const now = deps.now();

  const pre = buildPositions(l.orders, {}, now);
  const open = pre.filter(p => p.netQty !== 0);
  // An open position the watcher may not trade (market closed, broker logged out) makes the total unactionable.
  const ltps = g.state === 'watching' && open.length
    ? await deps.prices([...new Map(open.map(p => [p.priceId, { id: p.priceId, segment: p.segment }])).values()]).catch(() => ({}))
    : {};
  const positions = buildPositions(l.orders, ltps as Record<string, number>, now);
  const openNow = positions.filter(p => p.netQty !== 0);
  const total = open.every(deps.canExit) ? totalPnl(positions) : null;

  const a = nextGlobalAction(g, total, openNow.length, streak.cur, now);
  if (a.kind === 'streak') { streak.cur = a.streak; return; }
  if (a.kind === 'none') return;
  if (a.kind === 'mark-unknown') {
    await deps.mutate(led => { if (same(led.global, g) && led.global) led.global = { ...led.global, state: 'unknown', note: a.note }; });
    deps.log(`global exit ${a.kind}`);
    return;
  }

  const claimed = await deps.mutate(led => {
    if (!same(led.global, g)) return false;
    led.global = { ...g, state: 'firing', firedBy: a.level, firedAt: now, note: undefined };
    return true;
  });
  if (!claimed) return;
  streak.cur = null;
  const reason = a.level === 'target'
    ? `Global target hit: combined P&L ${total?.toFixed(0)} (target ${g.target})`
    : `Global stop-loss hit: combined P&L ${total?.toFixed(0)} (stop -${g.sl})`;
  deps.log(`${reason} — closing ${openNow.length} position(s)`);
  const results: CloseResult[] = [];
  for (const p of closeOrder(openNow)) {
    let r: CloseResult;
    try { r = await deps.close(p.key, reason); } catch (e) { r = { kind: 'unknown', error: String((e as Error).message ?? e), partial: false }; }
    results.push(r);
    deps.log(`${p.key} close ${r.kind}${'error' in r ? `: ${r.error}` : ''}`);
    if (mustStopAfter(p, r)) break;
  }
  const after = globalAfterClose(results, a.level, deps.now());
  await deps.mutate(led => { if (led.global && led.global.state === 'firing') led.global = { ...led.global, ...after }; });
  deps.log(`global exit → ${after.state}`);
}
