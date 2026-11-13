/**
 * Fresh Money "Exit all" (pure loop, the close is injected). REAL MONEY: the header button squares off EVERY open
 * position this page holds (all underlyings, all brokers — the same set the global total covers) with MARKET orders,
 * each through the page's one close path (closePositionCore: own fills only, holds, in-flight subtraction, slicing).
 *
 * Shorts are closed first; if a short's cover does not go out, no long / hedge is closed after it (the hedge stays on
 * the short). Positions the page does not own (opened elsewhere at the broker) are never touched.
 */
import type { CloseResult } from './freshMoneyExits.ts';
import { closeOrder, mustStopAfter } from './freshMoneyGlobalExit.ts';
import type { FmPosition } from './freshMoneyTrades.ts';

export type ExitAllPos = Pick<FmPosition, 'key' | 'netQty' | 'underlying' | 'strike' | 'opt' | 'broker'>;

export interface ExitAllItem { key: string; label: string; kind: CloseResult['kind'] | 'skipped'; error?: string }

export interface ExitAllResult {
  /** Every open position, in close order; `skipped` = not tried because an earlier short's cover did not go out. */
  items: ExitAllItem[];
  /** sent = every close went out; none = nothing was open; unknown = a close may or may not be live (never resend);
   *  incomplete = some went out, some did not; failed = nothing went out. */
  outcome: 'sent' | 'none' | 'unknown' | 'incomplete' | 'failed';
}

const label = (p: ExitAllPos) => `${p.underlying} ${p.strike} ${p.opt}${p.broker !== 'dhan' ? ` (${p.broker})` : ''}`;

export async function runExitAll(open: ExitAllPos[], close: (key: string) => Promise<CloseResult>): Promise<ExitAllResult> {
  const todo = closeOrder(open.filter(p => p.netQty !== 0));
  if (!todo.length) return { items: [], outcome: 'none' };
  const items: ExitAllItem[] = [];
  let stopped = false;
  for (const p of todo) {
    if (stopped) { items.push({ key: p.key, label: label(p), kind: 'skipped', error: 'not closed: a short\'s cover did not go out first' }); continue; }
    let r: CloseResult;
    try { r = await close(p.key); } catch (e) { r = { kind: 'unknown', error: String((e as Error)?.message ?? e), partial: false }; }
    items.push({ key: p.key, label: label(p), kind: r.kind, ...('error' in r ? { error: r.error } : {}) });
    if (mustStopAfter(p, r)) stopped = true;
  }
  return { items, outcome: exitAllOutcome(items) };
}

export function exitAllOutcome(items: ExitAllItem[]): ExitAllResult['outcome'] {
  if (!items.length) return 'none';
  if (items.some(i => i.kind === 'unknown' || i.kind === 'partial')) return 'unknown';
  const placed = items.filter(i => i.kind === 'placed').length;
  if (placed === items.length) return 'sent';
  return placed === 0 ? 'failed' : 'incomplete';
}
