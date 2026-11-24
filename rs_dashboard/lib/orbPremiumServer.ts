import { globalOnce } from '@/lib/globalOnce';
import { istDateIso } from '@/lib/nseHolidays';
import { istMinuteOfDay } from '@/lib/istTime';
import { hhmmToMin, rowLegsPnl, rowPnl, signalRowExit } from '@/lib/signalOrb';
import { BLIND_WARN_MS, blindSince, premiumTick, type PremiumAction, type PremiumRowIn } from '@/lib/orbFocus';
import { readOrbLedger } from '@/lib/signalOrbFile';
import { addLog, isPremiumInstrument, liveRow, patchRow, realisedToday, type OrbLeg, type OrbRow } from '@/lib/signalOrbLedger';
import { wsPrice, wsSync } from '@/lib/freshMoneyWs';
import {
  exitOneLeg, exitStructure, optionFutureKey, optionLtp, orbClientOp, orbEnterPremiumAuto, orbExitRow, orbWatcher, premiumBlind, save, serial, signalTargetOf,
} from '@/lib/signalOrbServer';

// The server loop behind the Signal Orb's short straddle / strangle. It runs with every browser tab closed (the straddle is a
// naked short: its stops cannot depend on a page being open). Every 2.5 s it (1) sells the structure at its entry time when Auto
// is on, once a day, and (2) judges an open structure with the Focus Tool's own rules (lib/orbFocus.ts -> lib/focusToolRules.ts)
// and sends the exits: a leg's SL / Trail SL / cost stop / target close that leg, the pair SL, the overall target, the daily
// loss limit and the cutoff close everything. All orders and ledger writes go through lib/signalOrbServer.ts on its one chain,
// so they never interleave with a click. A row is marked 'closing' before an exit is sent and an unknown outcome halts the engine
// (never resent). Information only from the browser's side: the page configures, arms and displays.
// It also owns the stops of a signal-driven row (futures / sold option / synthetic): the cutoff, the hard and trailing stop (one
// rule with the browser: signalRowExit) and the daily loss limit, on its own WebSocket price of the signal future, so they run with
// every tab closed. The browser still decides entries and reversals (they need the indicators); it sends a stop exit only while
// this loop's heartbeat (orbWatcher) is stale.

const TICK_MS = 2_500;
const ENTRY_RETRY_MS = 30_000;
/** A refused automatic exit of a signal row is retried after this (the browser's own retry pace). */
const EXIT_RETRY_MS = 5_000;
/** No new price of the signal future for this long = stale: the stop is not judged (the cutoff and a known loss still are). */
const FUT_STALE_MS = 30_000;
const TAG = '[orb-premium]';

const state = globalOnce('signalOrb.premiumLoop', () => ({ busy: false, started: false, entryRetryAt: 0, lastEntryMsg: '' }));
/** Signal rows: retry gate of a refused exit, and the last future price seen (books a cutoff exit on a stale feed). Its own key, so a
 * hot reload that keeps the older loop state object never reads these as undefined. */
const sig = globalOnce('signalOrb.signalWatch', () => ({ exitRetry: { id: '', at: 0 }, lastFut: { id: '', px: 0 } }));

export function startOrbPremiumLoop(): void {
  if (state.started) return;
  state.started = true;
  setInterval(() => {
    // the heartbeat says the loop is alive, even while one tick is still busy with an order (the browser must not double up)
    orbWatcher.at = Date.now();
    if (state.busy) return;
    state.busy = true;
    tick().catch(e => console.error(`${TAG} tick failed:`, e)).finally(() => { state.busy = false; });
  }, TICK_MS);
  console.log(`${TAG} watcher started`);
}

const isPremiumRow = (r: OrbRow | null | undefined): r is OrbRow & { legs: OrbLeg[] } => !!r && (r.structure === 'straddle' || r.structure === 'strangle') && !!r.legs;

async function tick(): Promise<void> {
  const now = Date.now();
  const l = readOrbLedger();
  const row = liveRow(l);
  if (isPremiumRow(row)) {
    // a row from an earlier day is not auto-managed (the broker's intraday square-off owns it); the page asks the user to resolve it
    if (row.status === 'open' && row.day === istDateIso(now)) await manage(row.id, now);
    return;
  }
  if (row) {
    // a signal-driven row: its stops run here (an earlier day's row is the user's to resolve, as on the page)
    if (row.status === 'open' && row.day === istDateIso(now)) await manageSignal(row, now);
    else premiumBlind.since = 0;
    return;
  }
  premiumBlind.since = 0;
  if (row || !isPremiumInstrument(l.config.instrument) || !l.engineActive || l.haltReason) return;
  const day = istDateIso(now);
  if (l.premiumEntryDay === day) return;
  const minute = istMinuteOfDay(now);
  if (minute < hhmmToMin(l.config.premium.entryTime) || minute >= hhmmToMin(l.config.entryEnd)) return;
  if (now < state.entryRetryAt) return;
  const r = await orbEnterPremiumAuto();
  if (!r.body.success) {
    // a refusal that wrote no row (no price yet, margin, closed day) is retried; say it once, not every tick
    state.entryRetryAt = now + ENTRY_RETRY_MS;
    const msg = String(r.body.error ?? '');
    if (msg && msg !== state.lastEntryMsg) { state.lastEntryMsg = msg; console.log(`${TAG} entry not sent: ${msg}`); }
  }
}

/** Judges one open structure: marks from the server's own WebSocket prices, then the Focus rules, then the exits, in the chain. */
async function manage(rowId: string, now: number): Promise<void> {
  const l0 = readOrbLedger();
  const row = l0.rows.find(r => r.id === rowId);
  if (!isPremiumRow(row) || row.status !== 'open') return;
  const legs = row.legs!;
  const lots = row.lots;
  const lotUnits = lots > 0 && legs[0].units > 0 ? legs[0].units / lots : 0;
  if (!(lotUnits > 0)) return;
  const marks: { CE: number | null; PE: number | null } = { CE: null, PE: null };
  for (const g of legs) if (g.status === 'open' && (g.target.side === 'CE' || g.target.side === 'PE')) marks[g.target.side] = optionLtp(g.target, now);
  // No live premium on an open leg: its stops cannot be judged. Say so (a log line, the page's banner and chime) instead of sitting silent.
  const blind = legs.some(g => g.status === 'open' && !((marks[g.target.side as 'CE' | 'PE'] ?? 0) > 0));
  premiumBlind.since = blindSince(premiumBlind.since, blind, now);
  if (blind && now - premiumBlind.since >= BLIND_WARN_MS && now - premiumBlind.warnedAt >= 5 * 60_000) {
    premiumBlind.warnedAt = now;
    const secs = Math.round((now - premiumBlind.since) / 1000);
    await serial(async () => save(addLog(readOrbLedger(), 'warn', `No live premium for ${secs} s: this structure's stops are NOT being judged (only the cutoff). Check the price feed and the broker.`, now), now));
  }
  const rowIn: PremiumRowIn = {
    lots, unitsPerLot: row.unitsPerLot, lotUnits, peak: row.peak,
    legs: legs.map(g => ({ side: g.target.side as 'CE' | 'PE', entry: g.entry, units: g.units, status: g.status, exit: g.exit, costStop: g.costStop, trailSteps: g.trailSteps })),
  };
  const t = premiumTick({ cfg: l0.config.premium, row: rowIn, marks, minute: istMinuteOfDay(now), eodMin: hhmmToMin(l0.config.eodExit) });
  const actions: PremiumAction[] = [...t.actions];
  // the day's loss limit covers the open structure too: realised + open at or past it closes everything (the exit then halts the engine)
  const open = legs.filter(g => g.status === 'open');
  if (!actions.some(a => a.kind === 'exitAll') && open.every(g => (marks[g.target.side as 'CE' | 'PE'] ?? 0) > 0)) {
    const px = legs.map(g => (g.status === 'closed' ? g.exit ?? g.entry : g.status === 'unknown' ? g.entry : marks[g.target.side as 'CE' | 'PE']));
    const openPnl = rowLegsPnl({ lots, unitsPerLot: row.unitsPerLot, legs }, px);
    if (openPnl !== null && realisedToday(l0, l0.mode, row.day) + openPnl <= -l0.config.dailyLossLimit) {
      actions.unshift({ kind: 'exitAll', why: 'sl', reason: `Daily loss limit ₹${l0.config.dailyLossLimit}` });
    }
  }
  const stepsChanged = Object.entries(t.trailSteps).some(([i, s]) => s > (legs[Number(i)].trailSteps ?? 0));
  if (!actions.length && !stepsChanged) return;

  await serial(async () => {
    let l = readOrbLedger();
    if (stepsChanged) {
      const cur = l.rows.find(r => r.id === rowId);
      if (cur?.legs) l = save(patchRow(l, rowId, { legs: cur.legs.map((g, i) => (t.trailSteps[i] !== undefined ? { ...g, trailSteps: Math.max(g.trailSteps ?? 0, t.trailSteps[i]) } : g)) }), now);
    }
    for (const a of actions) {
      const cur = l.rows.find(r => r.id === rowId);
      if (!isPremiumRow(cur) || cur.status !== 'open') return;
      if (a.kind === 'exitAll') {
        const step = await exitStructure(l, cur, { action: 'exit', price: cur.signalEntry ?? 1, reason: a.reason, exitKind: a.why === 'eod' ? 'eod' : 'manual', auto: true }, now);
        save(step.ledger, now);
        return;
      }
      const step = await exitOneLeg(l, cur, a.index, a.why, a.reason, now);
      l = save(step.ledger, now);
      if (!step.ok) return;
    }
  });
}

/**
 * Judges one open signal-driven row: the signal future's price from the server WebSocket, the peak ratcheted into the ledger, the
 * row's open P&L on its own instrument, then signalRowExit. An exit goes through orbExitRow (same row, still open, in the chain).
 */
async function manageSignal(row: OrbRow, now: number): Promise<void> {
  const l = readOrbLedger();
  const key = optionFutureKey(signalTargetOf(row));
  if (key) wsSync();
  const q = key ? wsPrice(key) : null;
  const fresh = q && q.ltp > 0 && now - (q.changedMs ?? q.sinceMs) <= FUT_STALE_MS ? q.ltp : null;
  if (q && q.ltp > 0) sig.lastFut = { id: row.id, px: q.ltp };

  // no fresh price: the stop cannot be judged - say so (the page's banner and chime), as for a straddle
  premiumBlind.since = blindSince(premiumBlind.since, fresh === null, now);
  if (fresh === null && now - premiumBlind.since >= BLIND_WARN_MS && now - premiumBlind.warnedAt >= 5 * 60_000) {
    premiumBlind.warnedAt = now;
    const secs = Math.round((now - premiumBlind.since) / 1000);
    await serial(async () => save(addLog(readOrbLedger(), 'warn', `No live ${row.target.symbol} future price for ${secs} s: the stop is NOT being judged (only the cutoff). Check the price feed.`, now), now));
  }

  // the trailing stop's peak lives in the ledger (only an improvement is kept: the op ratchets)
  const better = fresh !== null && (row.bestPrice === undefined || (row.side === 'LONG' ? fresh > row.bestPrice : fresh < row.bestPrice));
  if (better) await orbClientOp({ op: 'peak', id: row.id, price: fresh });
  const best = better ? fresh! : row.bestPrice;

  // open P&L on the row's own instrument (unknown = null: only the stop and the cutoff can act)
  let openPnl: number | null = null;
  if (row.legs) openPnl = rowLegsPnl({ lots: row.lots, unitsPerLot: row.unitsPerLot, legs: row.legs }, row.legs.map(g => (g.status === 'closed' ? g.exit ?? g.entry : optionLtp(g.target, now))));
  else if (row.target.kind === 'options') { const m = optionLtp(row.target, now); openPnl = m !== null && m > 0 ? rowPnl(row, m) : null; }
  else openPnl = fresh !== null ? rowPnl(row, fresh) : null;

  const cfg = l.config;
  const x = signalRowExit({
    side: row.side, entry: row.signalEntry ?? row.entry, bestPrice: best, price: fresh, minute: istMinuteOfDay(now), times: cfg,
    stopPts: cfg.stopPts, trailStartPts: cfg.trailStartPts, trailGapPts: cfg.trailGapPts,
    openPnl, realised: realisedToday(l, l.mode, row.day), dailyLossLimit: cfg.dailyLossLimit,
  });
  if (!x) return;
  if (sig.exitRetry.id === row.id && now < sig.exitRetry.at) return;
  sig.exitRetry = { id: row.id, at: now + EXIT_RETRY_MS };
  const px = fresh ?? (sig.lastFut.id === row.id ? sig.lastFut.px : 0);
  const r = await orbExitRow(row.id, { action: 'exit', price: px > 0 ? px : row.signalEntry ?? row.entry, reason: `${x.reason} (server)`, exitKind: x.kind, auto: true });
  if (!r.body.success) console.log(`${TAG} signal exit not done (${row.id}): ${String(r.body.error ?? '')}`);
}
