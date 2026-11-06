// The P&F AUTO ledger: every position the AUTO engine opened, owned by the ledger (not read off the broker's netted book).
// Pure: ops in, new state out; the route (app/api/straddle-pnf/auto) serialises them and writes the file atomically.
// Safety properties live here so the browser cannot bypass them: one live row per chart, state moves forward only,
// an unknown order outcome stays unknown until the user resolves it, and every op bumps `rev`.
//
// REAL orders are reserved BEFORE they are sent: an entry is written `entering`, an exit `exiting`. If the tab dies with the
// order on the wire the row stays reserved, so it blocks that chart and asks the user, and is never lost or sent twice.
//   entering → open (confirmEntry) | closed (voidEntry: refused, nothing open) | unknownEntry (markUnknown)
//   open → exiting (beginExit) → closed (close) | open (abortExit: cleanly refused) | unknownExit (markUnknown)
//   unknown* / a stale entering / exiting → open | closed by the user (resolve). PAPER rows open as `open` and close directly.
//   Pyramid adds (Renko, opt-in): open → adding (beginAdd) → open (confirmAdd | voidAdd) | unknownAdd (markUnknown) → open (resolve
//   'added' | 'notAdded'). PAPER adds in one step (addPaper). `entryPrice` is the AVERAGE entry and lots / unitsPerPoint / legs the
//   TOTALS, so every P&L reader (rowPnl) and every exit (sized by legs[].units) covers the whole position.
import { parseTarget, targetKey, type Target } from './pnfTarget.ts';
import { MAX_PNF_LOTS } from './pnfOrderLogic.ts';
import type { Market } from './straddlePnfLive.ts';
import type { AutoProduct } from './pnfOrderLogic.ts';
import { PYRAMID_EVERY_MAX, TRAIL_BOXES_MAX } from './pnfAuto.ts';
import { readSettings, type PnfSettings } from './straddlePnfSettings.ts';

export type AutoMode = 'PAPER' | 'REAL';
export type AutoRowState = 'entering' | 'open' | 'exiting' | 'closed' | 'unknownEntry' | 'unknownExit' | 'adding' | 'unknownAdd';

export interface AutoLeg { label: string; /** The broker's key (Dhan security id / trading symbol), REAL only. */ key: string | null; units: number }

/** One pyramid add: a lot added to an open position on a new best brick (lib/pnfAuto.ts decideAdd). */
export interface AutoAdd {
  id: string;
  /** Decision time (epoch s). */
  t: number;
  /** The bar whose brick triggered it (one add per bar). */
  barT: number;
  /** The brick close it was decided on (PAPER books it; the chart marker sits on it). */
  box?: number;
  lots: number;
  /** Units added per leg, in the row's leg order. */
  units: number[];
  unitsPerPoint: number;
  /** Booked price (REAL: the live price at the decision, replaced by the broker's fill once read). */
  price: number;
  decision?: number;
  orderIds?: string[];
  filled?: boolean;
  /** 'pending' while its order is out (state adding / unknownAdd); confirmed adds are in the totals. */
  status: 'pending' | 'done';
}

export interface AutoRow {
  id: string;
  /** IST date of the entry. */
  day: string;
  chart: 1 | 2;
  target: Target;
  targetKey: string;
  /** The market the contract trades in, saved at entry: its end-of-day exit time comes from this, not from whatever chart is on screen. */
  market?: Market;
  /**
   * The product it was opened with: 'MARGIN' = NRML (NSE end-of-day exit 15:35, lib/pnfAuto.ts autoWindow); absent = 'INTRADAY' (MIS,
   * 15:15). Adds and exits use the row's product, never the page's current choice.
   */
  product?: AutoProduct;
  mode: AutoMode;
  broker: string;
  side: 'BUY' | 'SELL';
  lots: number;
  /** Rupees per point for the whole position (all legs, all lots). */
  unitsPerPoint: number;
  legs: AutoLeg[];
  entryT: number;
  /** Time of the bar whose signal opened it: the reversal is looked for after this. */
  entryBarT: number;
  /** Two-back rows: the protective stop (one brick beyond the pullback); the exit is this level, not a reversal brick. */
  stop?: number;
  /** Supertrend-rule rows: the exit is the Supertrend line flipping against the position (kept on the row so a reload cannot change it). */
  exitBy?: 'supertrend';
  /**
   * PAPER: the confirmed box the signal bar reached (where the trade is booked). REAL: the chart's live price at the decision
   * (an estimate of the market fill).
   */
  entryPrice: number;
  /** The confirmed box the signal reached: where the chart marker sits (REAL books the live price, this is still the box). */
  entryBox?: number;
  /**
   * REAL fills. `entryPrice` / `exitPrice` start as the chart's price at the DECISION; once the broker reports the orders final, the
   * `fillPrice` op replaces them with the broker's average traded price (summed over a straddle's legs), keeps the decision price in
   * `entryDecision` / `exitDecision`, and recomputes `pnl`. The order ids are what lets any open tab do that, after a reload too.
   */
  entryOrderIds?: string[];
  exitOrderIds?: string[];
  entryFilled?: boolean;
  exitFilled?: boolean;
  entryDecision?: number;
  exitDecision?: number;
  state: AutoRowState;
  exitT?: number;
  /** Time of the bar that triggered the exit (the reversal column's first bar), for the chart marker; absent on older rows. */
  exitBarT?: number;
  exitPrice?: number;
  /** The confirmed box the reversal reached (none for an EOD exit): where the exit marker sits. */
  exitBox?: number;
  /** A `trail` exit: the best brick close the trade reached (fixed at the exit, so a later box change cannot move the re-entry level). */
  trailBest?: number;
  reason?: string;
  pnl?: number;
  note?: string;
  /** When the REAL entry / exit was reserved (entering / exiting): a reservation much older than an order takes is stale. */
  pendingSince?: number;
  /**
   * Pyramid: an exit begun while an add was unresolved (`beginExit` with `withPendingAdd`, the server's stuck-add exit). The state the row
   * goes back to on `abortExit`; `close` then settles the pending add from `pendingAdded`.
   */
  preExitState?: 'adding' | 'unknownAdd';
  /** Pyramid: the cap on total lots, saved at entry (absent = no adds for this row). */
  pyramidMax?: number;
  /** Pyramid: add a lot every this many bricks of progress past the last add (saved at entry; absent = 1, every new best brick). */
  pyramidEvery?: number;
  /** Pyramid trailing SL in boxes (saved at entry; absent = off): once a lot was added, exit on a brick this many boxes back from the best. */
  trailBoxes?: number;
  /** Pyramid: the first tranche, saved by the first add (entryPrice then becomes the average). */
  base?: { lots: number; unitsPerPoint: number; price: number; legUnits: number[] };
  adds?: AutoAdd[];
}

/** `kind`: an entry / exit / halt / info line the dashboard SERVER's engine wrote, which the page also toasts (absent on plain lines). */
export type AutoLogKind = 'entry' | 'exit' | 'halt' | 'info';
export interface AutoLogEntry { t: number; chart: 1 | 2; text: string; kind?: AutoLogKind }

/**
 * The chart the dashboard SERVER's AUTO engine (lib/pnfAutoEngine.ts) builds and trades, saved at arming: its target, its settings (locked
 * on the page while armed) and the times its box is measured from (lib/straddlePnfModel.ts anchorT / boxBaseT), so the server's bricks
 * are the page's. `volume`: false for an index (no VWAP).
 */
export interface ArmRun { target: Target; settings: PnfSettings; anchorT?: number; boxBaseT?: number; volume: boolean }

/**
 * A chart's AUTO switch as last set by a page (arming is in the browser, but it is SAVED here): a reload, a rebuild or another tab of the
 * same page reads it back, the server engine trades from it (lib/pnfAutoEngine.ts), and a stop in one tab disarms every tab. Before this
 * a reload silently left AUTO off while its open position still exited by its rule - an exit with no re-entry (2026-11-04).
 */
export interface AutoArmRecord {
  mode: AutoMode;
  broker: string;
  /** The chart's contract when it was armed: a different contract on screen is never resumed. */
  targetKey: string;
  /** IST date it was armed: an arm never carries into another day. */
  day: string;
  /** Epoch s of the arming (its identity: a tab follows a different `t` as a new arming). */
  t: number;
  /** The bar time signals had to be newer than when it was armed. */
  watermarkT: number;
  lots: number;
  /** Renko AUTO rule / side filter it was armed with (restored with it; absent on the P&F page). */
  rule?: string;
  side?: string;
  /** Renko pyramid it was armed with: present = add one lot every `every` (absent = 1) new bricks, up to `max` total lots. */
  /** `trail`: the trailing SL boxes it was armed with, 0 = armed with it OFF; absent = armed before the setting existed (resumed ON). */
  pyramid?: { max: number; every?: number; trail?: number };
  /** 'MARGIN' = armed to trade NRML; absent = MIS. */
  product?: 'MARGIN';
  /** What the server engine trades (absent on an arming saved before the server ran AUTO: the engine then disarms it). */
  run?: ArmRun;
}

export interface AutoLedger { rev: number; rows: AutoRow[]; log: AutoLogEntry[]; arms?: Partial<Record<'1' | '2', AutoArmRecord>> }

export const EMPTY_LEDGER: AutoLedger = { rev: 0, rows: [], log: [] };
/** A broker fill further than this from the decision price is refused as a bad read (a leg missing, a wrong scale). */
export const FILL_BAND = 0.2;
const MAX_ROWS = 500;
const MAX_LOG = 200;

/** A row still owning a position at the broker (or possibly owning one): it blocks a new entry on that chart. */
export const isLive = (r: AutoRow) => r.state !== 'closed';

/**
 * The ledger keeps at most MAX_ROWS rows by dropping the OLDEST CLOSED ones. A live row is never dropped: a Tick-interval PAPER chart can
 * close hundreds of trades a day, and a plain slice would forget the other chart's open REAL position (no exit, guard or end of day after).
 */
export function capRows(rows: AutoRow[], max = MAX_ROWS): AutoRow[] {
  let drop = rows.length - max;
  if (drop <= 0) return rows;
  return rows.filter(r => (drop > 0 && !isLive(r) ? (drop--, false) : true));
}

/** An open position (a pyramid add on the wire or unresolved included): its confirmed units are held and it has a live P&L. */
export const holdsPosition = (r: Pick<AutoRow, 'state'>) => r.state === 'open' || r.state === 'adding' || r.state === 'unknownAdd';

/** The units per leg of the row's unresolved add (zero when none): reserved like the row's own units while the outcome is open. */
export const pendingAddUnits = (r: Pick<AutoRow, 'adds' | 'legs'>): number[] => {
  const p = (r.adds ?? []).find(a => a.status === 'pending');
  return r.legs.map((_, k) => (p ? p.units[k] ?? 0 : 0));
};

export const rowPnl = (side: 'BUY' | 'SELL', entry: number, exit: number, unitsPerPoint: number) =>
  (side === 'BUY' ? exit - entry : entry - exit) * unitsPerPoint;

export type AutoOp =
  | { op: 'open'; row: Omit<AutoRow, 'state' | 'targetKey'> & { state?: 'open' | 'entering' } }
  | { op: 'confirmEntry'; id: string; legs: AutoLeg[]; orderIds?: string[] }
  | { op: 'voidEntry'; id: string; t: number; note: string }
  /**
   * `withPendingAdd`: an exit of a row whose add is unresolved (adding / unknownAdd) - the confirmed units plus the pending add's, capped by
   * what the broker shows (the server's exit for a stuck add, so the confirmed lots are never left without a guard or end-of-day exit).
   */
  | { op: 'beginExit'; id: string; t: number; withPendingAdd?: boolean }
  | { op: 'abortExit'; id: string; note: string }
  | { op: 'markUnknown'; id: string; note: string }
  /** `pendingAdded`: a row exited with a pending add - whether the exit found the added lot at the broker (it is then counted at its decision price). */
  | { op: 'close'; id: string; exitT: number; exitPrice: number; reason: string; note?: string; exitBarT?: number; exitBox?: number; trailBest?: number; orderIds?: string[]; pendingAdded?: boolean }
  | { op: 'fillPrice'; id: string; which: 'entry' | 'exit' | 'add'; price: number; /** how many orders were summed: must be one per leg */ legCount: number; /** which === 'add' */ addId?: string }
  | { op: 'resolve'; id: string; as: 'open' | 'flat' | 'added' | 'notAdded'; exitPrice?: number; t: number }
  /** Pyramid: reserve a REAL add (open → adding) before its order is sent. */
  | { op: 'beginAdd'; id: string; add: { id: string; t: number; barT: number; box?: number; lots: number; price: number } }
  /** Pyramid: the add's order was placed; `units` per leg as placed. */
  | { op: 'confirmAdd'; id: string; units: number[]; orderIds?: string[] }
  /** Pyramid: the add was cleanly refused, nothing was opened. */
  | { op: 'voidAdd'; id: string; note: string }
  /** Pyramid, PAPER: add a lot at once (booked at the brick). */
  | { op: 'addPaper'; id: string; add: { id: string; t: number; barT: number; box?: number; lots: number; price: number } }
  | { op: 'log'; chart: 1 | 2; t: number; text: string; kind?: AutoLogKind }
  /** Save (arm) or clear (null) a chart's AUTO switch, with the log line that says why - one op, so the two never disagree. */
  | { op: 'setArm'; chart: 1 | 2; arm: AutoArmRecord | null; t: number; text: string }
  | { op: 'resetPaper' };

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
/** The order ids of an op: non-empty strings only, at most 8; undefined when none. */
const cleanIds = (v: unknown): string[] | undefined => {
  const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40).slice(0, 8) : [];
  return ids.length ? ids : undefined;
};

export function parseLedger(raw: unknown): AutoLedger {
  if (!raw || typeof raw !== 'object') return EMPTY_LEDGER;
  const o = raw as Partial<AutoLedger>;
  const arms: Partial<Record<'1' | '2', AutoArmRecord>> = {};
  if (o.arms && typeof o.arms === 'object') for (const k of ['1', '2'] as const) { const a = armOk((o.arms as Record<string, unknown>)[k]); if (a) arms[k] = a; }
  return { rev: finite(o.rev) ? o.rev! : 0, rows: Array.isArray(o.rows) ? o.rows : [], log: Array.isArray(o.log) ? o.log : [], ...(Object.keys(arms).length ? { arms } : {}) };
}

/** A well-formed arm record, or null (a bad one is dropped: it can only ever mean "not armed"). */
function armOk(v: unknown): AutoArmRecord | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Partial<AutoArmRecord>;
  if (a.mode !== 'PAPER' && a.mode !== 'REAL') return null;
  if (typeof a.broker !== 'string' || !a.broker || typeof a.targetKey !== 'string' || !a.targetKey || typeof a.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) return null;
  if (!finite(a.t) || !finite(a.watermarkT) || !Number.isInteger(a.lots) || a.lots! < 1 || a.lots! > MAX_PNF_LOTS) return null;
  const str = (s: unknown) => (typeof s === 'string' && s.length > 0 && s.length <= 20 ? s : undefined);
  const rule = str(a.rule), side = str(a.side);
  const pm = a.pyramid && typeof a.pyramid === 'object' ? (a.pyramid as { max?: unknown }).max : undefined;
  const pe = a.pyramid && typeof a.pyramid === 'object' ? (a.pyramid as { every?: unknown }).every : undefined;
  const everyOk = Number.isInteger(pe) && (pe as number) > 1 && (pe as number) <= PYRAMID_EVERY_MAX;
  const pt = a.pyramid && typeof a.pyramid === 'object' ? (a.pyramid as { trail?: unknown }).trail : undefined;
  const trailOk = Number.isInteger(pt) && (pt as number) >= 0 && (pt as number) <= TRAIL_BOXES_MAX;   // 0 = armed with the trail off
  const pyramid = Number.isInteger(pm) && (pm as number) >= 1 && (pm as number) <= PYRAMID_HARD_MAX
    ? { max: pm as number, ...(everyOk ? { every: pe as number } : {}), ...(trailOk ? { trail: pt as number } : {}) } : undefined;
  const run = runOk(a.run, a.targetKey);
  return { mode: a.mode, broker: a.broker, targetKey: a.targetKey, day: a.day, t: a.t!, watermarkT: a.watermarkT!, lots: a.lots!, ...(rule ? { rule } : {}), ...(side ? { side } : {}), ...(pyramid ? { pyramid } : {}), ...(a.product === 'MARGIN' ? { product: 'MARGIN' as const } : {}), ...(run ? { run } : {}) };
}

/** A well-formed run snapshot whose target IS the arming's contract, or undefined. Settings out of range fall back per field (readSettings). */
function runOk(v: unknown, armKey: string): ArmRun | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<ArmRun>;
  const target = parseTarget(r.target);
  if (!target || targetKey(target) !== armKey || !r.settings || typeof r.settings !== 'object') return undefined;
  const settings = readSettings(JSON.stringify(r.settings));
  const time = (n: unknown) => (finite(n) && (n as number) > 0 ? (n as number) : undefined);
  const anchorT = time(r.anchorT), boxBaseT = time(r.boxBaseT);
  return { target, settings, ...(anchorT ? { anchorT } : {}), ...(boxBaseT ? { boxBaseT } : {}), volume: r.volume !== false };
}

/** Hard cap on an AUTO row's lots, pyramid adds included: the order route's own lot cap (one source for the ledger, the page and the UI). */
export const PYRAMID_HARD_MAX = MAX_PNF_LOTS;

/** A row's first tranche: saved on the row by its first add, read off the row before that. */
export const baseOf = (r: AutoRow): NonNullable<AutoRow['base']> =>
  r.base ?? { lots: r.lots, unitsPerPoint: r.unitsPerPoint, price: r.entryPrice, legUnits: r.legs.map(l => l.units) };

/** The row with its totals (lots, units per point, leg units) and AVERAGE entry price rebuilt from its first tranche and its confirmed adds. */
export function withTranches(r: AutoRow, base: NonNullable<AutoRow['base']>, adds: AutoAdd[]): AutoRow {
  const done = adds.filter(a => a.status === 'done');
  const upp = base.unitsPerPoint + done.reduce((n, a) => n + a.unitsPerPoint, 0);
  const avg = upp > 0 ? (base.price * base.unitsPerPoint + done.reduce((n, a) => n + a.price * a.unitsPerPoint, 0)) / upp : base.price;
  return {
    ...r, base, adds, lots: base.lots + done.reduce((n, a) => n + a.lots, 0), unitsPerPoint: upp, entryPrice: avg,
    legs: r.legs.map((l, k) => ({ ...l, units: (base.legUnits[k] ?? 0) + done.reduce((n, a) => n + (a.units[k] ?? 0), 0) })),
  };
}

/** A new add for `r` (expected units / rupees per point scaled from the first tranche's per-lot size), or why it is refused. */
function newAdd(r: AutoRow, a: { id: string; t: number; barT: number; box?: number; lots: number; price: number }, status: AutoAdd['status']): AutoAdd | string {
  if (!r.pyramidMax) return 'This row was not opened with adds on';
  if (!a || typeof a.id !== 'string' || !a.id || ![a.t, a.barT, a.price].every(finite) || !(a.price > 0)) return 'Invalid add';
  if (!Number.isInteger(a.lots) || a.lots < 1) return 'Invalid add lots';
  if (r.lots + a.lots > Math.min(r.pyramidMax, PYRAMID_HARD_MAX)) return `Adding ${a.lots} would take the position past ${Math.min(r.pyramidMax, PYRAMID_HARD_MAX)} lots`;
  if ((r.adds ?? []).some(x => x.barT === a.barT || x.id === a.id)) return 'Already added on this bar';
  const base = baseOf(r);
  if (!(base.lots > 0)) return 'Invalid row size';
  const k = a.lots / base.lots;
  return {
    id: a.id, t: a.t, barT: a.barT, ...(finite(a.box) ? { box: a.box } : {}), lots: a.lots,
    units: base.legUnits.map(u => Math.round(u * k)), unitsPerPoint: base.unitsPerPoint * k, price: a.price, status,
  };
}

/** Apply one op. Returns the new ledger, or an error with an HTTP status (the file is left as it was). */
export function applyAutoOp(led: AutoLedger, op: AutoOp): { ok: true; ledger: AutoLedger } | { ok: false; status: number; error: string } {
  const bump = (rows: AutoRow[], log = led.log, arms = led.arms): { ok: true; ledger: AutoLedger } =>
    ({ ok: true, ledger: { rev: led.rev + 1, rows: capRows(rows), log: log.slice(-MAX_LOG), ...(arms && Object.keys(arms).length ? { arms } : {}) } });
  const find = (id: string) => led.rows.findIndex(r => r.id === id);

  switch (op.op) {
    case 'open': {
      const r = op.row;
      const target = parseTarget(r.target);
      if (!target || target.kind === 'index') return { ok: false, status: 400, error: 'An AUTO row needs a tradable chart target' };
      if (r.chart !== 1 && r.chart !== 2) return { ok: false, status: 400, error: 'chart must be 1 or 2' };
      if (r.side !== 'BUY' && r.side !== 'SELL') return { ok: false, status: 400, error: 'side must be BUY or SELL' };
      if (r.mode !== 'PAPER' && r.mode !== 'REAL') return { ok: false, status: 400, error: 'mode must be PAPER or REAL' };
      if (!Number.isInteger(r.lots) || r.lots < 1 || r.lots > MAX_PNF_LOTS) return { ok: false, status: 400, error: `lots must be 1-${MAX_PNF_LOTS}` };
      if (![r.entryT, r.entryBarT, r.entryPrice, r.unitsPerPoint].every(finite) || !r.id) return { ok: false, status: 400, error: 'Invalid row' };
      if (r.stop !== undefined && (!finite(r.stop) || (r.side === 'BUY' ? r.stop >= r.entryPrice : r.stop <= r.entryPrice))) return { ok: false, status: 400, error: 'stop must be beyond the entry, on the losing side' };
      if (r.exitBy !== undefined && r.exitBy !== 'supertrend') return { ok: false, status: 400, error: 'Invalid exitBy' };
      if (r.market !== undefined && !(['NSE', 'NSE_CAS', 'NSE_FNO', 'MCX'] as const).includes(r.market)) return { ok: false, status: 400, error: 'Invalid market' };
      if (r.product !== undefined && r.product !== 'INTRADAY' && r.product !== 'MARGIN') return { ok: false, status: 400, error: 'product must be INTRADAY or MARGIN' };
      if (r.product === 'MARGIN' && target.kind === 'equity') return { ok: false, status: 400, error: 'A stock is traded MIS by AUTO (NRML is for futures and options)' };
      if (r.pyramidMax !== undefined && (!Number.isInteger(r.pyramidMax) || r.pyramidMax < r.lots || r.pyramidMax > PYRAMID_HARD_MAX)) return { ok: false, status: 400, error: `pyramidMax must be ${r.lots}-${PYRAMID_HARD_MAX}` };
      if (r.pyramidEvery !== undefined && (!Number.isInteger(r.pyramidEvery) || r.pyramidEvery < 1 || r.pyramidEvery > PYRAMID_EVERY_MAX)) return { ok: false, status: 400, error: `pyramidEvery must be 1-${PYRAMID_EVERY_MAX}` };
      if (r.trailBoxes !== undefined && (!Number.isInteger(r.trailBoxes) || r.trailBoxes < 1 || r.trailBoxes > TRAIL_BOXES_MAX)) return { ok: false, status: 400, error: `trailBoxes must be 1-${TRAIL_BOXES_MAX}` };
      if (r.base !== undefined || r.adds !== undefined) return { ok: false, status: 400, error: 'A new row has no adds' };
      if (led.rows.some(x => x.id === r.id)) return { ok: false, status: 409, error: 'Row already exists' };
      const live = led.rows.find(x => x.chart === r.chart && isLive(x));
      if (live) return { ok: false, status: 409, error: `Chart ${r.chart} already holds an AUTO position (${live.state})` };
      if (r.mode === 'REAL' && r.state !== 'entering') return { ok: false, status: 400, error: 'A REAL row is reserved as entering before its order is sent' };
      // The broker nets a contract: a REAL long on one chart and a REAL short on the other would read flat at the broker (the reconcile
      // would close both as flat) and each exit would open a position the other owns. One direction per contract and broker.
      const tk = targetKey(target);
      const against = r.mode === 'REAL' && led.rows.find(x => x.mode === 'REAL' && isLive(x) && x.broker === r.broker && x.targetKey === tk && x.side !== r.side);
      if (against) return { ok: false, status: 409, error: `Chart ${against.chart} holds a REAL ${against.side} on this contract: an opposite AUTO position would net against it at the broker` };
      return bump([...led.rows, { ...r, target, targetKey: targetKey(target), state: r.mode === 'REAL' ? 'entering' : 'open', pendingSince: r.mode === 'REAL' ? r.entryT : undefined }]);
    }
    case 'confirmEntry':
    case 'voidEntry':
    case 'beginExit':
    case 'abortExit':
    case 'markUnknown': {
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      const need: Record<string, AutoRowState[]> = {
        confirmEntry: ['entering'], voidEntry: ['entering'], beginExit: op.op === 'beginExit' && op.withPendingAdd ? ['adding', 'unknownAdd'] : ['open'],
        abortExit: ['exiting'], markUnknown: ['entering', 'exiting', 'adding'],
      };
      if (!need[op.op].includes(r.state)) return { ok: false, status: 409, error: `Row is ${r.state}` };
      const rows = [...led.rows];
      if (op.op === 'confirmEntry') {
        if (!Array.isArray(op.legs) || !op.legs.length || !op.legs.every(l => Number.isInteger(l.units) && l.units > 0)) return { ok: false, status: 400, error: 'Invalid legs' };
        // Exactly the units reserved, leg by leg (as confirmAdd): the row's P&L, guard and exits are sized off them.
        if (op.legs.length !== r.legs.length || op.legs.some((l, j) => l.units !== r.legs[j].units)) {
          return { ok: false, status: 409, error: `Placed ${JSON.stringify(op.legs.map(l => l.units))} but the entry reserved ${JSON.stringify(r.legs.map(l => l.units))}` };
        }
        rows[i] = { ...r, state: 'open', legs: op.legs, ...(cleanIds(op.orderIds) ? { entryOrderIds: cleanIds(op.orderIds) } : {}) };
      } else if (op.op === 'voidEntry') rows[i] = { ...r, state: 'closed', exitT: op.t, exitPrice: r.entryPrice, reason: 'refused', pnl: 0, note: op.note };
      else if (op.op === 'beginExit') {
        const pre = r.state === 'adding' || r.state === 'unknownAdd' ? r.state : undefined;
        rows[i] = { ...r, state: 'exiting', pendingSince: finite(op.t) ? op.t : r.entryT, ...(pre ? { preExitState: pre } : {}) };
      } else if (op.op === 'abortExit') rows[i] = { ...r, state: r.preExitState ?? 'open', preExitState: undefined, note: op.note };
      else rows[i] = { ...r, state: r.state === 'entering' ? 'unknownEntry' : r.state === 'adding' ? 'unknownAdd' : 'unknownExit', note: op.note };
      return bump(rows);
    }
    case 'beginAdd':
    case 'addPaper': {
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      if (r.state !== 'open') return { ok: false, status: 409, error: `Row is ${r.state}` };
      if (r.mode !== (op.op === 'addPaper' ? 'PAPER' : 'REAL')) return { ok: false, status: 409, error: `${op.op} is for a ${op.op === 'addPaper' ? 'PAPER' : 'REAL'} row` };
      const add = newAdd(r, op.add, op.op === 'addPaper' ? 'done' : 'pending');
      if (typeof add === 'string') return { ok: false, status: 409, error: add };
      const rows = [...led.rows];
      const base = baseOf(r);
      const adds = [...(r.adds ?? []), add];
      rows[i] = op.op === 'addPaper' ? withTranches(r, base, adds) : { ...r, base, adds, state: 'adding', pendingSince: add.t };
      return bump(rows);
    }
    case 'confirmAdd':
    case 'voidAdd': {
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      if (r.state !== 'adding') return { ok: false, status: 409, error: `Row is ${r.state}` };
      const adds = r.adds ?? [];
      const k = adds.findIndex(a => a.status === 'pending');
      if (k < 0) return { ok: false, status: 409, error: 'No add is pending' };
      const rows = [...led.rows];
      if (op.op === 'voidAdd') {
        rows[i] = { ...r, adds: adds.filter((_, j) => j !== k), state: 'open', pendingSince: undefined, note: op.note };
        return bump(rows);
      }
      const want = adds[k].units;
      // Exactly the units reserved, leg by leg: anything else (a partial, a leg missing) is not this add and must be resolved by the user.
      if (!Array.isArray(op.units) || op.units.length !== want.length || op.units.some((u, j) => u !== want[j])) {
        return { ok: false, status: 409, error: `Placed ${JSON.stringify(op.units)} but the add reserved ${JSON.stringify(want)}` };
      }
      const ids = cleanIds(op.orderIds);
      const next = adds.map((a, j) => (j === k ? { ...a, status: 'done' as const, ...(ids ? { orderIds: ids } : {}) } : a));
      rows[i] = { ...withTranches(r, baseOf(r), next), state: 'open', pendingSince: undefined };
      return bump(rows);
    }
    case 'close': {
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      // PAPER closes from open; REAL only after its exit was reserved (beginExit) and sent.
      if (r.state !== (r.mode === 'REAL' ? 'exiting' : 'open')) return { ok: false, status: 409, error: `Row is ${r.state}` };
      if (!finite(op.exitPrice) || !finite(op.exitT)) return { ok: false, status: 400, error: 'Invalid exit' };
      const rows = [...led.rows];
      // An exit begun with an unresolved add settles it: the added lot was found at the broker (counted) or it was not (dropped).
      const pending = (r.adds ?? []).some(a => a.status === 'pending');
      const settled = pending
        ? { ...withTranches(r, baseOf(r), (r.adds ?? []).filter(a => a.status === 'done' || op.pendingAdded === true).map(a => (a.status === 'pending' ? { ...a, status: 'done' as const } : a))), preExitState: undefined }
        : r;
      rows[i] = {
        ...settled, state: 'closed', exitT: op.exitT, exitPrice: op.exitPrice, reason: op.reason, pnl: rowPnl(r.side, settled.entryPrice, op.exitPrice, settled.unitsPerPoint),
        note: op.note ?? r.note, ...(finite(op.exitBarT) ? { exitBarT: op.exitBarT } : {}), ...(finite(op.exitBox) ? { exitBox: op.exitBox } : {}),
        ...(finite(op.trailBest) ? { trailBest: op.trailBest } : {}),
        ...(cleanIds(op.orderIds) ? { exitOrderIds: cleanIds(op.orderIds) } : {}),
      };
      return bump(rows);
    }
    case 'fillPrice': {
      // The broker's average traded price replaces a REAL row's decision price (idempotent: a price already filled stays).
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      if (r.mode !== 'REAL') return { ok: false, status: 409, error: 'Only a REAL row has broker fills' };
      if (!finite(op.price) || !(op.price > 0)) return { ok: false, status: 400, error: 'Invalid fill price' };
      // A price summed over fewer orders than the row has legs (a leg that was already flat, a slice) is a fraction of the price, not the price.
      if (op.legCount !== r.legs.length) return { ok: false, status: 409, error: `Fill covers ${op.legCount} order(s) but the row has ${r.legs.length} leg(s)` };
      // A row closed without an AUTO order (flat at the broker, resolved by the user, refused) has no real exit to price against.
      if (r.state === 'closed' && (r.reason === 'flat at broker' || r.reason === 'resolved' || r.reason === 'refused')) return { ok: false, status: 409, error: `Row was closed as ${r.reason}: nothing to re-price` };
      // One wrong sum (a missing leg, a wrong scale, the wrong order) must not be locked in: a fill is within FILL_BAND of its decision price.
      if (op.which === 'add') {
        const k = (r.adds ?? []).findIndex(a => a.id === op.addId);
        if (k < 0) return { ok: false, status: 404, error: 'No such add' };
        const a = r.adds![k];
        if (a.status !== 'done') return { ok: false, status: 409, error: 'The add is not confirmed' };
        if (a.filled) return { ok: true, ledger: led };
        const aref = a.decision ?? a.price;
        if (aref > 0 && Math.abs(op.price / aref - 1) > FILL_BAND) return { ok: false, status: 422, error: `Fill ${op.price} is more than ${FILL_BAND * 100}% from the decision price ${aref}` };
        const adds = r.adds!.map((x, j) => (j === k ? { ...x, decision: x.decision ?? x.price, price: op.price, filled: true } : x));
        const next = withTranches(r, baseOf(r), adds);
        const rows = [...led.rows];
        rows[i] = r.state === 'closed' && r.exitPrice !== undefined ? { ...next, pnl: rowPnl(r.side, next.entryPrice, r.exitPrice, next.unitsPerPoint) } : next;
        return bump(rows);
      }
      // With adds, entryPrice is the average: the entry fill is the first tranche's.
      const ref = op.which === 'entry' ? (r.entryDecision ?? (r.base ? r.base.price : r.entryPrice)) : (r.exitDecision ?? r.exitPrice);
      if (finite(ref) && ref! > 0 && Math.abs(op.price / ref! - 1) > FILL_BAND) return { ok: false, status: 422, error: `Fill ${op.price} is more than ${FILL_BAND * 100}% from the decision price ${ref}` };
      const rows = [...led.rows];
      if (op.which === 'entry') {
        if (r.state === 'entering' || r.state === 'unknownEntry') return { ok: false, status: 409, error: `Row is ${r.state}` };
        if (r.entryFilled) return { ok: true, ledger: led };
        const next = r.base
          ? withTranches({ ...r, entryDecision: r.entryDecision ?? r.base.price, entryFilled: true }, { ...r.base, price: op.price }, r.adds ?? [])
          : { ...r, entryDecision: r.entryDecision ?? r.entryPrice, entryPrice: op.price, entryFilled: true };
        rows[i] = r.state === 'closed' && r.exitPrice !== undefined ? { ...next, pnl: rowPnl(r.side, next.entryPrice, r.exitPrice, next.unitsPerPoint) } : next;
      } else {
        if (r.state !== 'closed' || r.exitPrice === undefined) return { ok: false, status: 409, error: `Row is ${r.state}` };
        if (r.exitFilled) return { ok: true, ledger: led };
        rows[i] = { ...r, exitDecision: r.exitDecision ?? r.exitPrice, exitPrice: op.price, exitFilled: true, pnl: rowPnl(r.side, r.entryPrice, op.price, r.unitsPerPoint) };
      }
      return bump(rows);
    }
    case 'resolve': {
      // The user has checked the broker: an unknown entry really is open / never happened; an unknown exit is flat / still open.
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      // A stale entering / exiting row (the tab died with the order on the wire) is resolved the same way as an unknown one.
      if (r.state === 'open' || r.state === 'closed') return { ok: false, status: 409, error: 'Only an unresolved row can be resolved' };
      const rows = [...led.rows];
      const addState = r.state === 'adding' || r.state === 'unknownAdd';
      if (addState !== (op.as === 'added' || op.as === 'notAdded') && !(addState && op.as === 'flat')) {
        return { ok: false, status: 400, error: addState ? 'An unresolved add is resolved as added, not added or flat' : 'Resolve this row as open or flat' };
      }
      if (addState) {
        // The add the user checked at the broker: it went through (counted, at its decision price) or it did not (dropped). Flat: dropped too.
        const adds = (r.adds ?? []).filter(a => a.status === 'done' || op.as === 'added').map(a => (a.status === 'pending' ? { ...a, status: 'done' as const } : a));
        const next = { ...withTranches(r, baseOf(r), adds), pendingSince: undefined };
        if (op.as === 'flat') {
          const px = finite(op.exitPrice) ? op.exitPrice! : next.entryPrice;
          rows[i] = { ...next, state: 'closed', exitT: op.t, exitPrice: px, reason: 'resolved', pnl: rowPnl(r.side, next.entryPrice, px, next.unitsPerPoint), note: 'resolved by the user: flat' };
        } else rows[i] = { ...next, state: 'open', note: `resolved by the user: add ${op.as === 'added' ? 'went through' : 'did not happen'}` };
        return bump(rows);
      }
      if (op.as === 'open') rows[i] = { ...r, state: r.preExitState ?? 'open', preExitState: undefined, note: 'resolved by the user: open' };
      else {
        const px = finite(op.exitPrice) ? op.exitPrice! : r.entryPrice;
        const neverOpened = r.state === 'unknownEntry' || r.state === 'entering';
        rows[i] = { ...r, state: 'closed', exitT: op.t, exitPrice: px, reason: 'resolved', pnl: neverOpened ? 0 : rowPnl(r.side, r.entryPrice, px, r.unitsPerPoint), note: 'resolved by the user: flat' };
      }
      return bump(rows);
    }
    case 'log':
      if (typeof op.text !== 'string' || !op.text) return { ok: false, status: 400, error: 'Empty log' };
      return bump(led.rows, [...led.log, { t: op.t, chart: op.chart, text: op.text.slice(0, 300), ...(op.kind && (['entry', 'exit', 'halt', 'info'] as const).includes(op.kind) ? { kind: op.kind } : {}) }]);
    case 'setArm': {
      if (op.chart !== 1 && op.chart !== 2) return { ok: false, status: 400, error: 'chart must be 1 or 2' };
      if (typeof op.text !== 'string' || !op.text || !finite(op.t)) return { ok: false, status: 400, error: 'An arm change needs a time and a log line' };
      const k = String(op.chart) as '1' | '2';
      const arms = { ...(led.arms ?? {}) };
      if (op.arm === null) {
        if (!arms[k]) return { ok: true, ledger: led };                          // already off: nothing to log twice (every tab follows a stop)
        delete arms[k];
      } else {
        const a = armOk(op.arm);
        if (!a) return { ok: false, status: 400, error: 'Invalid arm' };
        arms[k] = a;
      }
      return bump(led.rows, [...led.log, { t: op.t, chart: op.chart, text: op.text.slice(0, 300) }], arms);
    }
    case 'resetPaper':
      // Live REAL rows are never touched; open PAPER rows go too (they own nothing at the broker).
      return bump(led.rows.filter(r => r.mode === 'REAL'));
    default:
      return { ok: false, status: 400, error: 'Unknown op' };
  }
}

/** Today's (IST) closed P&L and trade count for one mode, per chart. */
export function dayStats(led: AutoLedger, day: string, mode: AutoMode): Record<1 | 2, { pnl: number; trades: number }> {
  const out: Record<1 | 2, { pnl: number; trades: number }> = { 1: { pnl: 0, trades: 0 }, 2: { pnl: 0, trades: 0 } };
  for (const r of led.rows) {
    if (r.day !== day || r.mode !== mode) continue;
    out[r.chart].trades++;
    if (r.state === 'closed') out[r.chart].pnl += r.pnl ?? 0;
  }
  return out;
}

export interface AutoDaySummary {
  realised: number; unrealised: number; total: number;
  /** Open rows with no live price: their unrealised P&L is unknown (not counted as 0 silently: shown with a marker). */
  unpriced: number; open: number; closed: number; wins: number; losses: number;
}

/**
 * One mode's AUTO P&L for an IST day: closed rows' booked P&L plus open rows marked at `priceOf(targetKey)` (the price of
 * a chart showing that contract, or null when no chart shows it).
 */
export function autoDaySummary(rows: AutoRow[], day: string, mode: AutoMode, priceOf: (targetKey: string) => number | null): AutoDaySummary {
  const s: AutoDaySummary = { realised: 0, unrealised: 0, total: 0, unpriced: 0, open: 0, closed: 0, wins: 0, losses: 0 };
  for (const r of rows) {
    if (r.day !== day || r.mode !== mode) continue;
    if (r.state === 'closed') {
      const p = r.pnl ?? 0;
      s.realised += p; s.closed++;
      if (p > 0) s.wins++; else if (p < 0) s.losses++;
    } else if (holdsPosition(r)) {
      s.open++;
      const px = priceOf(r.targetKey);
      if (px === null || !(px > 0)) s.unpriced++;
      else s.unrealised += rowPnl(r.side, r.entryPrice, px, r.unitsPerPoint);
    }
  }
  s.total = s.realised + s.unrealised;
  return s;
}

/**
 * The chart markers of AUTO rows for one contract, drawn from the ledger on their confirmed boxes (entryBox / exitBox; older
 * rows fall back to the booked price): the entry on its SIGNAL bar, the exit on the bar that
 * triggered it (the reversal column's first bar). Never at the decision time: that is the minute after, often already in
 * the next column, which put a SELL on an X column. A row without `exitBarT` (older rows) uses the bar that closed just before
 * its exit was decided.
 */
export function autoMarkers(rows: AutoRow[], tk: string): { id: string; t: number; action: 'BUY' | 'SELL'; price: number; lots: number; mode: AutoMode }[] {
  const out: { id: string; t: number; action: 'BUY' | 'SELL'; price: number; lots: number; mode: AutoMode }[] = [];
  for (const r of rows) {
    if (r.targetKey !== tk || r.state === 'entering' || r.state === 'unknownEntry') continue;
    if (r.state === 'closed' && r.reason === 'refused') continue;          // never opened
    out.push({ id: `${r.id}:in`, t: r.entryBarT, action: r.side, price: r.entryBox ?? (r.base ? r.base.price : r.entryPrice), lots: r.base ? r.base.lots : r.lots, mode: r.mode });
    for (const a of r.adds ?? []) if (a.status === 'done') out.push({ id: `${r.id}:add:${a.id}`, t: a.barT, action: r.side, price: a.box ?? a.price, lots: a.lots, mode: r.mode });
    if (r.state === 'closed' && r.reason !== 'resolved' && r.exitPrice !== undefined && r.exitT !== undefined) {
      const t = r.exitBarT ?? Math.floor(r.exitT / 60) * 60 - 60;
      out.push({ id: `${r.id}:out`, t, action: r.side === 'BUY' ? 'SELL' : 'BUY', price: r.exitBox ?? r.exitPrice, lots: r.lots, mode: r.mode });
    }
  }
  return out;
}
