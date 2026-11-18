import { ev, pushEvent, type LadderState } from './priceLadder.ts';

// Whether the copy-trade bridge (scripts/tools/copy_trade_bridge.py) mirrors what this ladder trades. The bridge is
// account-wide: it copies every REAL Dhan NIFTY-option FILL, whichever page placed it, and skips everything else. The
// note is about the contract this pane has SELECTED: an order already open or armed on a REAL Dhan NIFTY option is
// copied when it fills, whatever the pane shows now. Pure.

/** `copy` = mirrored; `off` = out of the bridge's scope (nothing wrong); `danger` = armed but not working, or a trap. */
export type CopyTone = 'copy' | 'off' | 'danger';
export interface CopyScope { tone: CopyTone; text: string; detail: string }

const SHARED = (label: string) =>
  `${label} is armed as a copy-trade child, so the server refuses new REAL ladder orders on ${label} (and cancels REAL levels armed on it). `
  + `Otherwise the copies and this ladder's own orders would net into ONE ${label} position: the ladder would read the copies as its own (or its position as closed outside the ladder), and the bridge's watchdog closes that whole ${label} position once Dhan's NIFTY options are flat. `
  + `Exits still work. Trade this ladder on Dhan, or disarm copying for ${label}.`;

export function copyScopeNote(p: {
  armed: boolean; bridgeRunning: boolean; failed: Record<string, string>;
  real: boolean; broker: string; underlying: string; isFut: boolean;
  children: { broker: string; label: string; multiplier: number }[];
}): CopyScope | null {
  if (!p.armed) return null;
  const outOfScope = (text: string): CopyScope => ({ tone: 'off', text,
    detail: 'The copy-trade bridge copies only REAL Dhan NIFTY-option fills, so orders on this selection are not mirrored to the child accounts. An order already open or armed on a REAL Dhan NIFTY option is still copied when it fills.' });
  const shared = p.children.find(c => c.broker === p.broker);
  if (p.real && shared) return { tone: 'danger', text: `${shared.label} is a copy target — REAL orders blocked`, detail: SHARED(shared.label) };
  if (!p.real) return outOfScope('SIM — not copied');
  if (p.broker !== 'dhan') return outOfScope('Not copied — only Dhan fills are copied');
  if (p.underlying.toUpperCase() !== 'NIFTY') return outOfScope(`${p.underlying} not copied — NIFTY options only`);
  if (p.isFut) return outOfScope('Futures not copied — NIFTY options only');
  if (!p.children.length) return { tone: 'danger', text: 'Copy armed with no child broker', detail: 'Copy trading is armed but no child broker is enabled — nothing is mirrored.' };
  if (!p.bridgeRunning) return { tone: 'danger', text: 'Copy bridge DOWN — not copying', detail: 'Copy trading is armed but the bridge process is not running: fills made now are NOT mirrored, and fills made while it is down are not caught up when it restarts (it baselines them). Re-arm to restart it.' };
  const down = p.children.filter(c => p.failed[c.broker] != null);
  const live = p.children.filter(c => p.failed[c.broker] == null);
  const list = (cs: typeof p.children) => cs.map(c => `${c.label} ${c.multiplier}x`).join(' + ');
  const detail = 'Each REAL Dhan NIFTY-option fill is mirrored to the child account at qty × its multiplier (an exit is copied only up to what the child holds). The copies are NOT in this ladder: its MTM guard, brackets, positions window and Exit all act on Dhan only — a Dhan exit reaches the child only because that fill is copied too. Disarming does not close child positions.';
  if (!live.length) return { tone: 'danger', text: `${down.map(c => c.label).join(' + ')} DOWN — not copying`, detail: down.map(c => `${c.label}: ${p.failed[c.broker]}`).join('\n') };
  if (down.length) return { tone: 'danger', text: `Copying → ${list(live)} · ${down.map(c => c.label).join(' + ')} DOWN`, detail: `${down.map(c => `${c.label}: ${p.failed[c.broker]}`).join('\n')}\n\n${detail}` };
  return { tone: 'copy', text: `Copying → ${list(live)}`, detail };
}

// ─── Server-side block: no REAL ladder ENTRY on a broker that is armed as a copy-trade child ───────────────────────
// The copies and the ladder's own orders would net into one position on that account: the ladder's reconcile reads the
// copies as its own (or its position as closed outside the ladder), and the bridge's watchdog closes the whole position
// on any symbol it copied once Dhan's NIFTY options are flat. Exits are never blocked (they must always work).


const NAME: Record<string, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };

/**
 * The brokers that are copy targets right now, from the parsed `debug/copy_trade_config.json`. `undefined` = the file
 * does not exist (never armed: no targets). Anything unreadable fails CLOSED: every child broker counts as a target.
 */
export function copyTargets(cfg: unknown): Set<string> {
  if (cfg === undefined) return new Set();
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return new Set(['kotak', 'zerodha']);
  const c = cfg as { armed?: unknown; children?: unknown };
  if (!c.armed) return new Set();
  if (!Array.isArray(c.children)) return new Set(['kotak', 'zerodha']);
  return new Set(c.children
    .filter((x): x is { broker: string; enabled?: unknown } => !!x && typeof x === 'object' && typeof (x as { broker?: unknown }).broker === 'string')
    .filter(x => !!x.enabled)   // the bridge copies to a child only while `enabled` is truthy
    .map(x => x.broker.toLowerCase()));
}

/** Why a NEW REAL order on `broker` is refused, or null. Dhan is the copy parent and is never a target. */
export function copyTargetBlock(broker: string, targets: Set<string>): string | null {
  if (broker === 'dhan' || !targets.has(broker)) return null;
  const n = NAME[broker] ?? broker;
  return `${n} is armed as a copy-trade child, so new REAL ladder orders on ${n} are blocked (the copies and the ladder would share one ${n} position). Trade on Dhan, or disarm copying for ${n}. Exits still work.`;
}

/**
 * Cancel every REAL level that is ARMED (nothing sent yet) on a copy-target broker — slices, pairs and baskets — so a
 * level armed before copying was armed cannot fire into the shared account. Orders already at the broker are left
 * alone (same as switching LIVE off). Pure; the watcher applies it inside its locked write.
 */
export function cancelCopyTargetLevels(s: LadderState, targets: Set<string>, now: number): LadderState {
  if (!targets.size) return s;
  const hit = (x: { mode: string; broker: string; state: string }) => x.mode === 'real' && x.state === 'armed' && copyTargetBlock(x.broker, targets) != null;
  const note = (b: string) => `${NAME[b] ?? b} is a copy-trade child`;
  let next = s;
  const ids: { id: string; broker: string }[] = [];
  if (s.slices.some(hit)) next = { ...next, slices: next.slices.map(x => (hit(x) ? (ids.push(x), { ...x, state: 'cancelled' as const, note: note(x.broker), updatedAt: now }) : x)) };
  if (s.pairs?.some(hit)) next = { ...next, pairs: next.pairs!.map(x => (hit(x) ? (ids.push(x), { ...x, state: 'cancelled' as const, note: note(x.broker), updatedAt: now }) : x)) };
  if (s.baskets?.some(hit)) next = { ...next, baskets: next.baskets!.map(x => (hit(x) ? (ids.push(x), { ...x, state: 'cancelled' as const, note: note(x.broker), updatedAt: now }) : x)) };
  for (const x of ids) next = pushEvent(next, ev('warn', `REAL level cancelled: ${note(x.broker)} — new REAL orders on it are blocked while copying is armed`, x.id));
  return next;
}
