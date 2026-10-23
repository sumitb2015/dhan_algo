import { mcxSession } from '@/lib/mcxSession';
import { istDay, istHhmm, isMcxUnderlying, sessionFor } from '@/lib/priceLadder';
import { readLadderState, updateLadderState } from '@/lib/priceLadderServer';
import { timeStringToHhmm, writeLadderSettings, type PriceLadderSettings } from '@/lib/priceLadderSettings';

// The MCX (CRUDEOILM) and NSE/BSE trading cutoffs — MIS square-off and "only exits" time — set from the Price Ladder header, its
// settings modal and the global settings drawer. One server path for all three. Moving the cutoff is a real-money
// action: a time that has already passed squares off every open MCX MIS position on the next tick, so that needs an
// explicit confirmation, and the time must sit in the evening session, before the day's close.

/** Earliest cutoff accepted: nothing earlier is an end-of-session cutoff (09:00 would block MCX trading all day). */
export const MIN_MCX_CUTOFF_HHMM = 2200;

/** NSE / BSE: the cutoff must fall inside the continuous session, late enough to be an end-of-day cutoff. */
export const MIN_NSE_CUTOFF_HHMM = 1300;
export const MAX_NSE_CUTOFF_HHMM = 1539;

export type CutoffResult =
  | { ok: true; settings: PriceLadderSettings }
  | { ok: false; status: number; error: string; needsConfirm?: true };

/** Open MCX MIS positions the ladder would square off at the cutoff (single options and pairs, SIM and REAL). */
function openMcxMis(): number {
  const st = readLadderState();
  const slices = st.slices.filter(x => isMcxUnderlying(x.contract.underlying) && x.product === 'MIS' && (x.state === 'open' || x.state === 'exiting')).length;
  const pairs = (st.pairs ?? []).filter(p => isMcxUnderlying(p.legs.ce.contract.underlying) && p.product === 'MIS'
    && (p.state === 'open' || p.state === 'broken' || p.state === 'rolling' || p.state === 'exiting')).length;
  return slices + pairs;
}

export async function setMcxCutoff(raw: unknown, confirmPast: boolean, now = Date.now()): Promise<CutoffResult> {
  const time = typeof raw === 'string' ? raw.trim() : '';
  const hhmm = timeStringToHhmm(time);
  if (hhmm == null) return { ok: false, status: 400, error: 'Invalid time — expected HH:MM, e.g. 23:15' };
  const day = istDay(now);
  // The day's own close (23:30 in US summer, 23:55 in winter); on a shut day the summer close bounds it.
  const sess = mcxSession(day);
  const close = sess.open < sess.close ? sess.close : 2330;
  if (hhmm < MIN_MCX_CUTOFF_HHMM || hhmm >= close) {
    return { ok: false, status: 400, error: `The MCX cutoff must be between 22:00 and the close (${String(close).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')})` };
  }
  const nowHhmm = istHhmm(now);
  const inSession = sess.open < sess.close && nowHhmm >= sess.open && nowHhmm < sess.close;
  const n = inSession && hhmm <= nowHhmm ? openMcxMis() : 0;
  if (n > 0 && !confirmPast) {
    return {
      ok: false, status: 409, needsConfirm: true,
      error: `${time} has already passed — ${n} open MCX MIS position(s) would be squared off at MARKET on the next tick. Confirm to apply.`,
    };
  }
  const settings = writeLadderSettings({ mcxAutoExitTime: time });
  await updateLadderState(s => ({ ...s, settings: { ...s.settings, mcxAutoExitTime: settings.mcxAutoExitTime } }));
  return { ok: true, settings };
}

/** Open NSE / BSE MIS positions the ladder would square off at the cutoff (single options and pairs, SIM and REAL). */
function openNseMis(): number {
  const st = readLadderState();
  const slices = st.slices.filter(x => !isMcxUnderlying(x.contract.underlying) && x.product === 'MIS' && (x.state === 'open' || x.state === 'exiting')).length;
  const pairs = (st.pairs ?? []).filter(p => !isMcxUnderlying(p.legs.ce.contract.underlying) && p.product === 'MIS'
    && (p.state === 'open' || p.state === 'broken' || p.state === 'rolling' || p.state === 'exiting')).length;
  return slices + pairs;
}

/**
 * The NSE / BSE (Nifty, Bank Nifty, Fin Nifty, Sensex, ...) trading cutoff. Same contract as the MCX one: a time that
 * has already passed squares off every open NSE/BSE MIS position on the next tick, so it needs `confirmPast`.
 */
export async function setNseCutoff(raw: unknown, confirmPast: boolean, now = Date.now()): Promise<CutoffResult> {
  const time = typeof raw === 'string' ? raw.trim() : '';
  const hhmm = timeStringToHhmm(time);
  if (hhmm == null) return { ok: false, status: 400, error: 'Invalid time — expected HH:MM, e.g. 15:17' };
  if (hhmm < MIN_NSE_CUTOFF_HHMM || hhmm > MAX_NSE_CUTOFF_HHMM) {
    return { ok: false, status: 400, error: 'The NSE cutoff must be between 13:00 and 15:39 (the session closes at 15:40)' };
  }
  const nowHhmm = istHhmm(now);
  const open = isNseTradingNow(now, nowHhmm);
  const n = open && hhmm <= nowHhmm ? openNseMis() : 0;
  if (n > 0 && !confirmPast) {
    return {
      ok: false, status: 409, needsConfirm: true,
      error: `${time} has already passed — ${n} open NSE/BSE MIS position(s) would be squared off at MARKET on the next tick. Confirm to apply.`,
    };
  }
  const settings = writeLadderSettings({ nseAutoExitTime: time });
  await updateLadderState(s => ({ ...s, settings: { ...s.settings, nseAutoExitTime: settings.nseAutoExitTime } }));
  return { ok: true, settings };
}

function isNseTradingNow(now: number, nowHhmm: number): boolean {
  const sess = sessionFor('NIFTY', istDay(now));
  return sess.open < sess.close && nowHhmm >= sess.open && nowHhmm < sess.close;
}

/** The settings routes' one entry point: applies whichever cutoff(s) the body carries (MCX and/or NSE). */
export async function setCutoffsFromBody(body: Record<string, unknown>): Promise<CutoffResult> {
  const confirmPast = body.confirmPast === true;
  if (body.nseAutoExitTime === undefined && body.mcxAutoExitTime === undefined) {
    return { ok: false, status: 400, error: 'Send mcxAutoExitTime and/or nseAutoExitTime' };
  }
  let last: CutoffResult | null = null;
  if (body.nseAutoExitTime !== undefined) {
    last = await setNseCutoff(body.nseAutoExitTime, confirmPast);
    if (!last.ok) return last;
  }
  if (body.mcxAutoExitTime !== undefined) {
    last = await setMcxCutoff(body.mcxAutoExitTime, confirmPast);
    if (!last.ok) return last;
  }
  return last!;
}
