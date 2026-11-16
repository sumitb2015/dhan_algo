/**
 * Fresh Money: which sound (and which toasts) a trade-state change deserves — pure, no sound, no I/O.
 *
 * The page diffs each trade-state poll against the previous one (dhan-alert-sound): the component plays the chime and
 * shows the toasts; this module only decides. Priority inside one poll: a problem (warn) beats an exit beats an entry,
 * so a burst never hides a rejection behind a friendly sound.
 */
import type { FmPosition } from './freshMoneyTrades.ts';
import type { FmExit } from './freshMoneyExits.ts';
import type { FmGlobalExit } from './freshMoneyGlobalExit.ts';
import { entryLabel, type FmEntry } from './freshMoneyEntries.ts';

export type ChimeKind = 'warn' | 'exit' | 'entry';

export interface TradeSnapshot {
  positions: FmPosition[];
  exits: Record<string, FmExit>;
  global: FmGlobalExit | null;
  /** Level entries (absent from an older server = none). */
  entries?: FmEntry[];
}

export interface ChimeToast { kind: 'success' | 'error'; title: string; detail?: string }

export interface TradeEvents { sound: ChimeKind | null; toasts: ChimeToast[] }

const PROBLEM = new Set(['unknown', 'incomplete', 'rejected']);
const RANK: Record<ChimeKind, number> = { entry: 1, exit: 2, warn: 3 };

const label = (p: Pick<FmPosition, 'underlying' | 'strike' | 'opt'> | undefined, key: string) =>
  (p ? `${p.underlying} ${p.strike} ${p.opt}` : key);

/** What changed between two trade-state polls. `prev === null` (the first poll after load) is silent: history never
 *  chimes. Positions are compared by key on |netQty| (grown = entry, reduced or flat = exit); exit records and the
 *  global exit by a change of `state` (sent = exit + toast; unknown / incomplete / rejected = warn + toast). */
export function tradeEvents(prev: TradeSnapshot | null, cur: TradeSnapshot): TradeEvents {
  if (!prev) return { sound: null, toasts: [] };
  let sound: ChimeKind | null = null;
  const toasts: ChimeToast[] = [];
  const bump = (k: ChimeKind) => { if (!sound || RANK[k] > RANK[sound]) sound = k; };

  const before = new Map(prev.positions.map(p => [p.key, p]));
  const after = new Map(cur.positions.map(p => [p.key, p]));
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = Math.abs(before.get(key)?.netQty ?? 0), b = Math.abs(after.get(key)?.netQty ?? 0);
    if (b > a) bump('entry');
    else if (b < a) bump('exit');
  }

  for (const [key, x] of Object.entries(cur.exits ?? {})) {
    const was = prev.exits?.[key]?.state;
    if (x.state === was) continue;
    const name = label(after.get(key) ?? before.get(key), key);
    if (x.state === 'sent') {
      bump('exit');
      toasts.push({ kind: 'success', title: `${x.firedBy === 'sl' ? 'Stop-loss' : 'Target'} hit — ${name} closed` });
    } else if (PROBLEM.has(x.state)) {
      bump('warn');
      toasts.push({ kind: 'error', title: `${name}: exit ${x.state.toUpperCase()}`, detail: x.note });
    }
  }

  // Level entries the SERVER fired or ended (the page never sends them): sent = a toast (its fill sounds as an entry);
  // unknown / rejected / expired = warn + toast. Cancelled by a click is silent.
  const wasEntry = new Map((prev.entries ?? []).map(e => [e.id, e.state]));
  for (const e of cur.entries ?? []) {
    const was = wasEntry.get(e.id);
    if (was === undefined || was === e.state) continue;
    const name = `${e.underlying} ${e.strike} ${e.opt} ${entryLabel(e)}`;
    if (e.state === 'sent') {
      toasts.push({ kind: 'success', title: `Level hit — ${e.side} ${e.lots} lot${e.lots === 1 ? '' : 's'} ${e.underlying} ${e.strike} ${e.opt} sent at market`, detail: `${entryLabel(e)} · ${e.underlying} at ${e.spotAtFire ?? '–'}` });
    } else if (e.state === 'unknown' || e.state === 'rejected' || e.state === 'expired') {
      bump('warn');
      toasts.push({ kind: 'error', title: `${name}: level ${e.state.toUpperCase()}`, detail: e.reason });
    }
  }

  const g = cur.global, gw = prev.global?.state;
  if (g && g.state !== gw) {
    if (g.state === 'sent') {
      bump('exit');
      toasts.push({ kind: 'success', title: `Total ${g.firedBy === 'sl' ? 'stop-loss' : 'target'} hit — all positions closed` });
    } else if (PROBLEM.has(g.state)) {
      bump('warn');
      toasts.push({ kind: 'error', title: `Total exit ${g.state.toUpperCase()}`, detail: g.note });
    }
  }
  return { sound, toasts };
}

/** A board-wide (Σ totals) streak worth a chime: a run of 3+ that has just started, or just turned the other way.
 *  Growing ▲3 → ▲4 does not ring again. */
export function streakStart(prev: { dir: 1 | -1 } | null, cur: { dir: 1 | -1; n: number } | null, min = 3): boolean {
  if (!cur || cur.n < min) return false;
  return !prev || prev.dir !== cur.dir;
}
