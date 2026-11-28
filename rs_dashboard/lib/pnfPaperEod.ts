// End-of-day reset of PAPER (SIM) AUTO rows on the P&F / Renko pages. A PAPER row owns nothing at the broker, so one left open past its
// market's close (the dashboard was stopped at the end-of-day time, or the row was carried NRML) must never survive into the next session:
// an open row keeps its chart locked to that contract (no instrument switch, no manual trade, no bars for an expired contract) and raised
// a "STILL OPEN - resolve it" error on every load (2026-11-28). REAL rows are never touched here: they hold real positions.
// Pure (tested in lib/pnfPaperEod.test.ts); the server AUTO engine (lib/pnfAutoEngine.ts) applies it every tick.
import { rowMarket } from './pnfAuto.ts';
import { istMinuteOfDay, sessionWindow } from './straddlePnfLive.ts';
import { istDateIso } from './nseHolidays.ts';
import type { AutoRow } from './pnfAutoLedger.ts';

/** Why a PAPER row is reset, or null when it stays open. `nowS`: epoch seconds. */
export function paperEodReason(row: Pick<AutoRow, 'mode' | 'state' | 'day' | 'market' | 'target'>, nowS: number): string | null {
  if (row.mode !== 'PAPER' || row.state !== 'open') return null;
  const today = istDateIso(nowS * 1000);
  if (row.day < today) return `SIM position from ${row.day} reset: a SIM position never carries into another day`;
  const close = sessionWindow(rowMarket(row), nowS)[1];
  if (close > 0 && istMinuteOfDay(nowS) >= close) return 'SIM position reset at the end of the day';
  return null;
}

/** The PAPER rows to reset now, with why. */
export const paperEodRows = (rows: AutoRow[], nowS: number): { row: AutoRow; why: string }[] =>
  rows.flatMap(row => { const why = paperEodReason(row, nowS); return why ? [{ row, why }] : []; });
