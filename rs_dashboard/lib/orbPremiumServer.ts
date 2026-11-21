import { globalOnce } from '@/lib/globalOnce';
import { istDateIso } from '@/lib/nseHolidays';
import { istMinuteOfDay } from '@/lib/istTime';
import { hhmmToMin, rowLegsPnl } from '@/lib/signalOrb';
import { premiumTick, type PremiumAction, type PremiumRowIn } from '@/lib/orbFocus';
import { readOrbLedger } from '@/lib/signalOrbFile';
import { isPremiumInstrument, liveRow, patchRow, realisedToday, type OrbRow } from '@/lib/signalOrbLedger';
import { exitOneLeg, exitStructure, optionLtp, orbEnterPremiumAuto, save, serial } from '@/lib/signalOrbServer';

// The server loop behind the Signal Orb's short straddle / strangle. It runs with every browser tab closed (the straddle is a
// naked short: its stops cannot depend on a page being open). Every 2.5 s it (1) sells the structure at its entry time when Auto
// is on, once a day, and (2) judges an open structure with the Focus Tool's own rules (lib/orbFocus.ts -> lib/focusToolRules.ts)
// and sends the exits: a leg's SL / Trail SL / cost stop / target close that leg, the pair SL, the overall target, the daily
// loss limit and the cutoff close everything. All orders and ledger writes go through lib/signalOrbServer.ts on its one chain,
// so they never interleave with a click. A row is marked 'closing' before an exit is sent and an unknown outcome halts the engine
// (never resent). Information only from the browser's side: the page configures, arms and displays.

const TICK_MS = 2_500;
const ENTRY_RETRY_MS = 30_000;
const TAG = '[orb-premium]';

const state = globalOnce('signalOrb.premiumLoop', () => ({ busy: false, started: false, entryRetryAt: 0, lastEntryMsg: '' }));

export function startOrbPremiumLoop(): void {
  if (state.started) return;
  state.started = true;
  setInterval(() => {
    if (state.busy) return;
    state.busy = true;
    tick().catch(e => console.error(`${TAG} tick failed:`, e)).finally(() => { state.busy = false; });
  }, TICK_MS);
  console.log(`${TAG} watcher started`);
}

const isPremiumRow = (r: OrbRow | null | undefined): r is OrbRow => !!r && (r.structure === 'straddle' || r.structure === 'strangle') && !!r.legs;

async function tick(): Promise<void> {
  const now = Date.now();
  const l = readOrbLedger();
  const row = liveRow(l);
  if (isPremiumRow(row)) {
    // a row from an earlier day is not auto-managed (the broker's intraday square-off owns it); the page asks the user to resolve it
    if (row.status === 'open' && row.day === istDateIso(now)) await manage(row.id, now);
    return;
  }
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
  const rowIn: PremiumRowIn = {
    lots, unitsPerLot: row.unitsPerLot, lotUnits, peak: row.peak,
    legs: legs.map(g => ({ side: g.target.side as 'CE' | 'PE', entry: g.entry, units: g.units, status: g.status, exit: g.exit, costStop: g.costStop, trailSteps: g.trailSteps })),
  };
  const t = premiumTick({ cfg: l0.config.premium, row: rowIn, marks, minute: istMinuteOfDay(now), eodMin: hhmmToMin(l0.config.eodExit) });
  const actions: PremiumAction[] = [...t.actions];
  // the day's loss limit covers the open structure too: realised + open at or past it closes everything (the exit then halts the engine)
  const open = legs.filter(g => g.status === 'open');
  if (!actions.some(a => a.kind === 'exitAll') && open.every(g => (marks[g.target.side as 'CE' | 'PE'] ?? 0) > 0)) {
    const px = legs.map(g => (g.status === 'closed' ? g.exit ?? g.entry : marks[g.target.side as 'CE' | 'PE']));
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
