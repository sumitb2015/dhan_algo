// Which sound a Point & Figure page event deserves — the Price Ladder's chime set (lib/alertSound.ts, picked there by
// lib/priceLadderChime.ts): a trade taken = the entry chime (two rising tones), a trade closed = the exit chime (two falling),
// a problem (refused / unknown / partial / halted) = the warn buzz. Pure: the page plays it.
//
// A double-top / double-bottom signal is not a trade, so it gets the neutral alert chime, never a trade sound. On a chart
// with AUTO armed it gets none: the trade AUTO takes on it rings instead (one chime per 1.5 s is allowed, so a signal chime
// a moment earlier would swallow the trade's).

import { playAlertChime, playEntryChime, playExitChime, playWarnChime } from './alertSound.ts';

export type PnfChime = 'entry' | 'exit' | 'warn' | 'alert';

export type PnfSoundEvent =
  | { kind: 'signal'; autoArmed: boolean }
  | { kind: 'auto'; type: 'entry' | 'exit' | 'halt' | 'info' }
  /** A trade-bar order: `outcome` from the order route, `close` = a square-off. */
  | { kind: 'manual'; outcome: string | undefined; close: boolean };

export function pnfChimeFor(e: PnfSoundEvent): PnfChime | null {
  if (e.kind === 'signal') return e.autoArmed ? null : 'alert';
  if (e.kind === 'auto') return e.type === 'entry' ? 'entry' : e.type === 'exit' ? 'exit' : 'warn';
  if (e.outcome === 'placed' || e.outcome === 'flat') return e.close ? 'exit' : 'entry';
  return 'warn';                                     // refused, unknown, partial, reversed: something to look at
}

/** Play a chime (a no-op until the page has had a click, and at most one per 1.5 s, like every dashboard chime). */
export function playPnfChime(c: PnfChime | null): void {
  if (c === 'entry') playEntryChime();
  else if (c === 'exit') playExitChime();
  else if (c === 'warn') playWarnChime();
  else if (c === 'alert') playAlertChime();
}
