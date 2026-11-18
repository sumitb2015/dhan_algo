// Whether the copy-trade bridge (scripts/tools/copy_trade_bridge.py) mirrors what this ladder trades. The bridge is
// account-wide: it copies every REAL Dhan NIFTY-option FILL, whichever page placed it, and skips everything else. The
// note is about the contract this pane has SELECTED: an order already open or armed on a REAL Dhan NIFTY option is
// copied when it fills, whatever the pane shows now. Pure.

/** `copy` = mirrored; `off` = out of the bridge's scope (nothing wrong); `danger` = armed but not working, or a trap. */
export type CopyTone = 'copy' | 'off' | 'danger';
export interface CopyScope { tone: CopyTone; text: string; detail: string }

const SHARED = (label: string) =>
  `${label} is a copy-trade child, and this ladder trades REAL on ${label} too: the copies and this ladder's own orders net into ONE ${label} position on a shared contract. `
  + `The ladder then reads the copies as its own (or its position as closed outside the ladder), and the bridge's watchdog closes that whole ${label} position once Dhan's NIFTY options are flat — including this ladder's part. `
  + `Trade this ladder on Dhan, or disarm copying for ${label}.`;

export function copyScopeNote(p: {
  armed: boolean; bridgeRunning: boolean; failed: Record<string, string>;
  real: boolean; broker: string; underlying: string; isFut: boolean;
  children: { broker: string; label: string; multiplier: number }[];
}): CopyScope | null {
  if (!p.armed) return null;
  const outOfScope = (text: string): CopyScope => ({ tone: 'off', text,
    detail: 'The copy-trade bridge copies only REAL Dhan NIFTY-option fills, so orders on this selection are not mirrored to the child accounts. An order already open or armed on a REAL Dhan NIFTY option is still copied when it fills.' });
  const shared = p.children.find(c => c.broker === p.broker);
  if (p.real && shared) return { tone: 'danger', text: `${shared.label} is a copy target — shared account`, detail: SHARED(shared.label) };
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
