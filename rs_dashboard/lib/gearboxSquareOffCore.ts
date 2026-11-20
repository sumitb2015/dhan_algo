import { globalOnce } from './globalOnce.ts';
import { istDateIso } from './nseHolidays.ts';
import { istMinuteOfDay } from './istTime.ts';
import { mcxSession } from './mcxSession.ts';
import { GB_UNREADABLE, readGbLedger, readGbLedgerForWrite } from './gearboxFile.ts';
import { addLog, isLive, type GbLedger, type GbRow } from './gearboxLedger.ts';
import { OPT_FRESH_MS, closeRowNow, gbSerial, loadGbLedgerForOp, saveGbLedger, type GbDeps } from './gearboxCore.ts';

// Gearbox's server square-off: at the MCX auto-exit it closes every live row (SIM and REAL) with every tab closed.
// REAL MONEY. Each close runs inside gbSerial (never interleaves with a click) through closeRowNow, which sends only the row's own
// units and never resends an UNKNOWN outcome. Only rows whose status is 'open' are closed: a refused REAL exit puts the row back to
// 'open' (nothing was sent) and is retried at most SQ_MAX_TRIES times a day, SQ_RETRY_MS apart, never at / after the MCX close;
// after the last refusal the row goes UNKNOWN. An UNKNOWN row is left for a human, logged once a day (a 'sending' / 'closing' row
// seen at the start of a tick is an orphan and becomes UNKNOWN first). Every tick with a live row also asks for each live row's
// option price, which keeps its WebSocket subscription alive with every tab closed, and refreshes lastLtp (the SIM fallback).
// Relative imports only so lib/gearboxSquareOff.test.ts runs under `node --test`; lib/gearboxSquareOff.ts binds the real deps.

const hhmmToMinutes = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

/** REAL square-off sends per row per IST day, and the least gap between two of them. */
export const SQ_MAX_TRIES = 3;
export const SQ_RETRY_MS = 30_000;

function window(nowMs: number): { today: string; shut: boolean; open: number; close: number; autoExit: number; minute: number } {
  const today = istDateIso(nowMs);
  const s = mcxSession(today);
  return {
    today, shut: s.open === s.close, open: hhmmToMinutes(s.open), close: hhmmToMinutes(s.close), autoExit: hhmmToMinutes(s.autoExit),
    minute: istMinuteOfDay(nowMs),
  };
}

/** May the square-off send a REAL exit for `r` now? Before the MCX close, under SQ_MAX_TRIES today and SQ_RETRY_MS after the last. */
function realSendAllowed(r: GbRow, nowMs: number, w: ReturnType<typeof window>): boolean {
  if (w.minute >= w.close) return false;
  if (r.sqDay !== w.today) return true;
  return (r.sqTries ?? 0) < SQ_MAX_TRIES && nowMs - (r.sqAt ?? 0) >= SQ_RETRY_MS;
}

/** Rows that are live and unambiguous (status 'open') AND due: today's rows from the auto-exit on; an earlier day's rows once today's session is open. Nothing on a shut day. */
export function squareOffDue(nowMs: number, ledger: GbLedger): GbRow[] {
  const w = window(nowMs);
  if (w.shut) return [];
  return ledger.rows.filter(r => r.status === 'open' && (r.day < w.today ? w.minute >= w.open : w.minute >= w.autoExit));
}

/** Rows square-off must not touch (a close may be in flight or its outcome is unknown) that are past their time. */
function heldBack(nowMs: number, ledger: GbLedger): GbRow[] {
  const w = window(nowMs);
  if (w.shut) return [];
  return ledger.rows.filter(r => isLive(r) && r.status !== 'open' && (r.day < w.today ? w.minute >= w.open : w.minute >= w.autoExit));
}

const warned = globalOnce('gearbox.squareOffWarned', () => new Set<string>());
const unreadableWarned = globalOnce('gearbox.squareOffUnreadable', () => ({ at: 0 }));

/** Asks for every live row's option price (keeps its WebSocket want alive) and books a fresh one as lastLtp. */
function refreshLastLtp(l: GbLedger, deps: GbDeps): GbLedger {
  let changed = false;
  const rows = l.rows.map(r => {
    if (!isLive(r)) return r;
    const q = deps.optionPrice(r.target);
    if (!q || q.ageMs > OPT_FRESH_MS || q.ltp === r.lastLtp) return r;
    changed = true;
    return { ...r, lastLtp: q.ltp };
  });
  return changed ? { ...l, rows } : l;
}

export async function gearboxSquareOffTickCore(deps: GbDeps): Promise<void> {
  // Cheap idle check outside the chain: nothing live = nothing to do. An unreadable file is never written (reported every 10 min).
  if (readGbLedgerForWrite() === null) {
    const t = deps.now();
    if (t - unreadableWarned.at >= 600_000) { unreadableWarned.at = t; console.error(`[gearbox-squareoff] ${GB_UNREADABLE} - square-off is not running`); }
    return;
  }
  if (!readGbLedger().rows.some(isLive)) return;
  await gbSerial(async () => {
    const now = deps.now();
    const loaded = loadGbLedgerForOp(now);
    if (!loaded) return;
    const start = refreshLastLtp(loaded, deps);
    let l = start;
    let dirty = start !== loaded;
    const w = window(now);
    const held = heldBack(now, l).filter(r => !warned.has(`${r.id}|${w.today}`));
    for (const r of held) {
      warned.add(`${r.id}|${w.today}`);
      l = addLog(l, 'error', `square-off skipped: row ${r.id} is ${r.status.toUpperCase()} - check the order book`, now);
    }
    const due = squareOffDue(now, l);
    let attempted = 0;
    for (const row of due) {
      let cur = l.rows.find(r => r.id === row.id);
      if (!cur || cur.status !== 'open') continue;
      if (cur.mode === 'REAL') {
        if (!realSendAllowed(cur, now, w)) continue;
        // the attempt is counted before the send, so a throw or a restart mid-send still uses it up
        const tries = (cur.sqDay === w.today ? cur.sqTries ?? 0 : 0) + 1;
        l = { ...l, rows: l.rows.map(r => (r.id === cur!.id ? { ...r, sqDay: w.today, sqTries: tries, sqAt: now } : r)) };
        cur = l.rows.find(r => r.id === row.id)!;
      } else {
        const q = deps.optionPrice(cur.target);
        if (!(q && q.ageMs <= OPT_FRESH_MS)) l = addLog(l, 'warn', `square-off at last price: ${cur.id} (no fresh option price)`, now);
      }
      try {
        l = (await closeRowNow(l, cur, 'square-off', deps)).ledger;
      } catch (err) {
        // A throw before / during the send: the REAL row is 'closing' on disk; the next tick turns it UNKNOWN (never resent).
        l = readGbLedgerForWrite() ?? l;
        l = addLog(l, 'error', `square-off of ${cur.id} threw: ${err instanceof Error ? err.message : String(err)}`, now);
      }
      const after = l.rows.find(r => r.id === row.id);
      if (after && after.mode === 'REAL' && after.status === 'open' && (after.sqTries ?? 0) >= SQ_MAX_TRIES) {
        const note = `square-off failed ${SQ_MAX_TRIES} times`;
        l = addLog({ ...l, rows: l.rows.map(r => (r.id === after.id ? { ...r, status: 'unknown' as const, note } : r)) },
          'error', `${note}: row ${after.id} is now UNKNOWN - close it at Dhan and resolve it`, now);
      }
      attempted++;
      l = saveGbLedger(l, deps.now());
      dirty = false;
    }
    if (attempted > 0 && w.minute >= w.autoExit && l.lastSquareOffDay !== w.today) { l = { ...l, lastSquareOffDay: w.today }; dirty = true; }
    if (held.length > 0 || dirty) saveGbLedger(l, deps.now());
  });
}
