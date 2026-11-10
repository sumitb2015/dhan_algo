/**
 * When the dashboard should start an MCX OI collector by itself (pure). The collector (scripts/tools/crudeoil_oi_collector.py)
 * waits for the open and exits at the close on its own, so this only decides "should one be running now and is none".
 */

/** Start this many minutes before the MCX open (the collector waits, showing WAITING). */
export const AUTO_LEAD_MIN = 10;
/** Do not (re)start in the last minutes of the session: nothing left worth a fresh ATM window. */
export const AUTO_TAIL_MIN = 5;
/** At most one automatic start per underlying in this long (a start that fails, e.g. no futures price, retries slowly). */
export const AUTO_RETRY_MS = 5 * 60_000;

export interface AutoStartInput {
  /** Today's MCX session in IST hhmm (lib/mcxSession.ts); open === close = no session today. */
  open: number;
  close: number;
  /** IST minutes since midnight now. */
  nowMin: number;
  /** A collector for this underlying is alive (RUNNING or WAITING with a live pid). */
  running: boolean;
  /** The user pressed Stop today (IST date of that press equals today). */
  stoppedToday: boolean;
  /** ms since the last automatic start attempt (Infinity when none). */
  sinceLastAttemptMs: number;
}

const toMin = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

export function shouldAutoStart(i: AutoStartInput): boolean {
  if (i.open >= i.close) return false;                 // weekend / MCX holiday
  if (i.running || i.stoppedToday) return false;
  if (i.sinceLastAttemptMs < AUTO_RETRY_MS) return false;
  return i.nowMin >= toMin(i.open) - AUTO_LEAD_MIN && i.nowMin < toMin(i.close) - AUTO_TAIL_MIN;
}
