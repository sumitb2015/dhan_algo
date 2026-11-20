import { globalOnce } from './globalOnce.ts';
import { istDateIso } from './nseHolidays.ts';
import { istMinuteOfDay } from './istTime.ts';
import { mcxSession } from './mcxSession.ts';
import { readGbLedger } from './gearboxFile.ts';
import { addLog, isLive, type GbLedger, type GbRow } from './gearboxLedger.ts';
import { closeRowNow, gbSerial, saveGbLedger, type GbDeps } from './gearboxCore.ts';

// Gearbox's server square-off: at the MCX auto-exit it closes every live row (SIM and REAL) with every tab closed.
// REAL MONEY. Each close runs inside gbSerial (never interleaves with a click) through closeRowNow, which sends only the row's own
// units and never resends an UNKNOWN outcome. Only rows whose status is 'open' are closed: a refused REAL exit puts the row back to
// 'open' (nothing was sent), so the next tick retries it; an UNKNOWN / sending / closing row is left for a human, logged once a day.
// Relative imports only so lib/gearboxSquareOff.test.ts runs under `node --test`; lib/gearboxSquareOff.ts binds the real deps.

const hhmmToMinutes = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

type Due = { kind: 'none' } | { kind: 'day'; today: string; open: number; autoExit: number };

function window(nowMs: number): { today: string; shut: boolean; open: number; autoExit: number; minute: number } {
  const today = istDateIso(nowMs);
  const s = mcxSession(today);
  return { today, shut: s.open === s.close, open: hhmmToMinutes(s.open), autoExit: hhmmToMinutes(s.autoExit), minute: istMinuteOfDay(nowMs) };
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

export async function gearboxSquareOffTickCore(deps: GbDeps): Promise<void> {
  // Cheap idle check outside the chain: nothing live = nothing to do.
  if (!readGbLedger().rows.some(isLive)) return;
  await gbSerial(async () => {
    const now = deps.now();
    let l = readGbLedger();
    const w = window(now);
    const held = heldBack(now, l).filter(r => !warned.has(`${r.id}|${w.today}`));
    for (const r of held) {
      warned.add(`${r.id}|${w.today}`);
      l = addLog(l, 'error', `square-off skipped: row ${r.id} is ${r.status.toUpperCase()} - check the order book`, now);
    }
    const due = squareOffDue(now, l);
    let attempted = 0;
    for (const row of due) {
      const cur = l.rows.find(r => r.id === row.id);
      if (!cur || cur.status !== 'open') continue;
      const q = deps.optionPrice(cur.target);
      if (cur.mode === 'SIM' && !(q && q.ageMs <= 10_000)) l = addLog(l, 'warn', `square-off at last price: ${cur.id} (no fresh option price)`, now);
      try {
        l = (await closeRowNow(l, cur, 'square-off', deps)).ledger;
      } catch (err) {
        // A throw before / during the send: the REAL row is 'closing' (saved before the send) and is left for a human.
        l = readGbLedger();
        l = addLog(l, 'error', `square-off of ${cur.id} threw: ${err instanceof Error ? err.message : String(err)}`, now);
      }
      attempted++;
      l = saveGbLedger(l, deps.now());
    }
    if (attempted > 0 && w.minute >= w.autoExit && l.lastSquareOffDay !== w.today) l = { ...l, lastSquareOffDay: w.today };
    if (held.length > 0 || attempted > 0 || l.lastSquareOffDay !== readGbLedger().lastSquareOffDay) saveGbLedger(l, deps.now());
  });
}
