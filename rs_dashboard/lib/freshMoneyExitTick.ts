/**
 * Fresh Money target / stop-loss watcher — one tick, with every outside effect injected (testable without a broker).
 * REAL MONEY: `deps.close` is the page's own close path (lib/freshMoneyTradeServer.ts closePositionCore), wired by
 * lib/freshMoneyExitServer.ts. Spec: docs/superpowers/specs/2026-11-11-fresh-money-target-sl-design.md §4.
 *
 * Every tick re-reads the ledger (the route and this loop can be separate module instances; the file is the truth),
 * decides each record with nextExitAction, and writes changes under the ledger lock, re-checking there that the record
 * is the one it decided on. An exit is claimed ('firing') in the lock BEFORE the close is sent, so it goes at most once.
 */
import {
  exitAfterClose, nextExitAction, resolveExit, trailUpdate, type CloseResult, type ExitAction, type FmExit, type Streak,
} from './freshMoneyExits.ts';
import { buildPositions, contractSettling, type FmLedger, type FmPosition, type FmSegment } from './freshMoneyTrades.ts';

export interface ExitTickDeps {
  now(): number;
  readLedger(): FmLedger | Promise<FmLedger>;
  mutate<T>(fn: (l: FmLedger) => T): Promise<T>;
  /** Usable LTPs by Dhan price id; a missing id = no price this tick. */
  prices(items: { id: string; segment: FmSegment }[]): Promise<Record<string, number>>;
  /** The market is open or close-only for this position and its broker session is usable. */
  canExit(p: FmPosition): boolean;
  close(key: string, reason: string): Promise<CloseResult>;
  log(msg: string): void;
  /** Bring the ledger up to date with the brokers (order fills, down-only reconcile) — with no tab open nothing else
   *  does, and a fill nobody confirms leaves a position unguarded. Called only while some record exists. */
  refresh(): Promise<void>;
}

/** The record is still the one this tick decided on (no edit, fire or drop in between). */
const same = (a: FmExit | undefined, b: FmExit) =>
  !!a && a.state === b.state && a.openedAt === b.openedAt && a.targetPx === b.targetPx && a.slPx === b.slPx;

const px = (n: number | null) => (n === null ? '–' : n.toFixed(2));

export async function runExitTick(deps: ExitTickDeps, streaks: Map<string, Streak>): Promise<void> {
  if (!Object.keys((await deps.readLedger()).exits ?? {}).length) { streaks.clear(); return; }
  await deps.refresh().catch(err => deps.log(`broker refresh failed: ${String((err as Error)?.message ?? err)}`));
  const l = await deps.readLedger();
  const exits = l.exits ?? {};
  const keys = Object.keys(exits);
  for (const k of [...streaks.keys()]) if (!exits[k]) streaks.delete(k);
  if (!keys.length) return;

  const now = deps.now();
  const positions = new Map(buildPositions(l.orders, {}, now).map(p => [p.key, p] as const));
  const priced = keys
    .map(k => ({ x: exits[k], p: positions.get(k) }))
    .filter((e): e is { x: FmExit; p: FmPosition } => e.x.state === 'watching' && !!e.p && e.p.netQty !== 0 && deps.canExit(e.p));
  const ltps = priced.length
    ? await deps.prices([...new Map(priced.map(e => [e.p.priceId, { id: e.p.priceId, segment: e.p.segment }])).values()]).catch(() => ({}))
    : {};

  const changes: { x: FmExit; a: ExitAction }[] = [];
  const fires: { x: FmExit; level: 'target' | 'sl'; ltp: number }[] = [];
  // Trailing stops this tick has moved: written (ratchet) before any exit is claimed, and the exit decided on the moved
  // stop — a fire claims the record as it will be after that write.
  const trails: { x: FmExit; u: { trailSteps: number; slPx: number } }[] = [];
  for (const k of keys) {
    const x0 = exits[k];
    const p = positions.get(k) ?? null;
    const ltpRaw = p && deps.canExit(p) ? (ltps as Record<string, number>)[p.priceId] : undefined;
    const ltp = ltpRaw !== undefined && ltpRaw > 0 ? ltpRaw : null;
    const sameDir = !!p && Math.sign(p.netQty) === (x0.dir === 'long' ? 1 : -1);
    const u = ltp !== null && sameDir ? trailUpdate(x0, ltp) : null;
    if (u) trails.push({ x: x0, u });
    const x = u ? { ...x0, ...u } : x0;
    const a = nextExitAction(x, p, contractSettling(l.orders, k, now), ltp, streaks.get(k) ?? null, now);
    if (a.kind === 'streak') { if (a.streak) streaks.set(k, a.streak); else streaks.delete(k); }
    else if (a.kind === 'fire') fires.push({ x, level: a.level, ltp: ltp! });
    else if (a.kind !== 'none') changes.push({ x: x0, a });
  }

  if (changes.length || trails.length) {
    await deps.mutate(led => {
      const cur = { ...(led.exits ?? {}) };
      for (const { x, u } of trails) if (same(cur[x.key], x)) cur[x.key] = { ...cur[x.key], ...u };
      for (const { x, a } of changes) {
        if (!same(cur[x.key], x)) continue;
        if (a.kind === 'drop' || (a.kind === 'settle' && a.to === 'drop')) delete cur[x.key];
        else if (a.kind === 'settle') cur[x.key] = { ...x, state: 'incomplete', note: 'exit filled only part — the rest is not watched; edit to re-arm' };
        else if (a.kind === 'resolve') {
          cur[x.key] = resolveExit(x, a.basis, a.levels);
        }
        else if (a.kind === 'mark-unknown') cur[x.key] = { ...x, state: 'unknown', note: a.note };
      }
      led.exits = cur;
    });
    for (const { x, a } of changes) deps.log(`${x.key} ${a.kind}${a.kind === 'settle' ? ` → ${a.to}` : ''}`);
    for (const { x, u } of trails) deps.log(`${x.key} trailing stop → ${px(u.slPx)} (${u.trailSteps} step${u.trailSteps === 1 ? '' : 's'})`);
  }

  for (const { x, level, ltp } of fires) {
    const t = deps.now();
    const claimed = await deps.mutate(led => {
      const cur = led.exits?.[x.key];
      if (!same(cur, x)) return false;
      led.exits = { ...led.exits, [x.key]: { ...cur!, state: 'firing', firedBy: level, firedAt: t, note: undefined } };
      return true;
    });
    if (!claimed) continue;
    streaks.delete(x.key);
    const reason = level === 'target'
      ? `Target hit at ${px(ltp)} (target ${px(x.targetPx)}, basis ${px(x.basis)})`
      : (x.trailSteps ?? 0) > 0
        ? `Trailing stop-loss hit at ${px(ltp)} (stop ${px(x.slPx)}, trailed ${x.trailSteps}× from ${px(x.slBasePx ?? null)}, basis ${px(x.basis)})`
        : `Stop-loss hit at ${px(ltp)} (stop ${px(x.slPx)}, basis ${px(x.basis)})`;
    deps.log(`${x.key} ${reason} — sending the close`);
    let r: CloseResult;
    try { r = await deps.close(x.key, reason); } catch (e) { r = { kind: 'unknown', error: String((e as Error).message ?? e), partial: false }; }
    const after = exitAfterClose(r, level, deps.now());
    await deps.mutate(led => {
      const cur = led.exits?.[x.key];
      if (cur && cur.state === 'firing') led.exits = { ...led.exits, [x.key]: { ...cur, ...after } };
    });
    deps.log(`${x.key} close ${r.kind}${'error' in r ? `: ${r.error}` : ''} → ${after.state}`);
  }
}
