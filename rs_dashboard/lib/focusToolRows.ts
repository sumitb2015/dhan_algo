import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

const ROWS_FILE = path.join(PROJECT_ROOT, 'debug', 'focus_tool_rows.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export type FocusUnderlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
export type FocusDte = 'Any' | '0' | '1' | '0+1';
export type FocusRowStatus = 'draft' | 'armed' | 'entered' | 'exited';
export type FocusSide = 'CE' | 'PE' | 'BOTH';
export type FocusRowMode = 'real' | 'sim';

/**
 * What a leg does after its own SL × or target closes it (AlgoTest's
 * "Re-Entry on SL / Tgt", minus the Reverse variants — this tool only ever
 * opens with a SELL):
 *  - off      — stays closed.
 *  - asap     — re-sell at once at the strike the row resolves to NOW
 *               (ATM ± offset, or the ₹ premium target).
 *  - otm      — re-sell at once, FocusRow.slRollStrikes further OTM than the
 *               strike that just closed (CE up, PE down).
 *  - cost     — wait on the SAME strike until its premium returns to the
 *               closed leg's own entry, then re-sell there.
 *  - momentum — pick the strike the row resolves to now, note its premium,
 *               and re-sell once it has moved FocusRow.reMomentumPts points
 *               in FocusRow.reMomentumDir.
 */
export type FocusReentryMode = 'off' | 'asap' | 'otm' | 'cost' | 'momentum';
export type FocusReentryTrigger = 'sl' | 'tgt';

/**
 * A re-entry armed on a leg and waiting for its price (cost / momentum).
 * Persisted in the fill ledger so it survives a reload and dies with the
 * cycle (Arm, whole-row exit) like everything else in the ledger.
 */
export interface FocusPendingReentry {
  trigger: FocusReentryTrigger;
  mode: 'cost' | 'momentum';
  strike: number;
  /** Whole lots to re-sell — what the closed leg held. */
  lots: number;
  /** Premium level that fires it. */
  price: number;
  /** 'down' fires at LTP ≤ price, 'up' at LTP ≥ price. */
  dir: 'down' | 'up';
  /** Unix ms armed. */
  since: number;
}

export interface FocusIndexGroup {
  underlying: FocusUnderlying;
  enabled: boolean;
  atmBy: 'Spot' | 'Fut';
  product: 'INTRADAY' | 'MARGIN';
  strikesOffset: number;     // ± whole-strike offset (0 = ATM, 1 = 1 step OTM, etc.)
  bookExit: boolean;
  spotHigh: string;          // level-exit: exit when spot breaks above
  spotLow: string;           // level-exit: exit when spot breaks below
}

export type FocusStrikeMode = 'ATM' | 'PREMIUM';

/**
 * What a row actually holds — this page's own fill ledger, the counterpart of
 * `self.fills` in focus_tool_rows_worker.py.
 *
 * Two jobs, both of which the page used to do wrong by having no record at all:
 *
 *  * The STRIKES. `ceStrike`/`peStrike` were recomputed live from the current
 *    ATM on every tick, so the moment spot crossed a half-step the row started
 *    looking its position up at a strike it did not hold — P&L blanked, the row
 *    reported itself flat, and every level exit quietly stopped being evaluated
 *    against a live position.
 *
 *  * The QUANTITIES. Exits sized off the broker's raw net quantity, and Dhan
 *    nets by security id — so two rows at the same strike (or a row sharing a
 *    strike with a running strategy) share ONE position, and exiting either
 *    flattened the other. `ceQty`/`peQty` are what THIS row opened, and an
 *    exit is clamped to them exactly as lib/strategy_risk.resolve_exit_qty
 *    clamps the Python side.
 *
 * Adjusted on every accepted order, cleared on Arm (which re-resolves from
 * scratch) and once a confirmed exit leaves both legs flat.
 */
export interface FocusRowFill {
  ceStrike: number | null;
  peStrike: number | null;
  /** Absolute units this row holds, already lot-multiplied. Never lots. */
  ceQty: number;
  peQty: number;
  /**
   * Realised P&L from qty this row has already closed or rolled away.
   *
   * The pin tracks only the CURRENT strike per leg. Closing (or shifting off)
   * a strike leaves broker realised on that old security id — without this
   * running total, that money drops out of the row the moment the pin moves.
   * Optional on disk for older sessions; readers treat missing as 0.
   */
  bookedPnl?: number;
  /**
   * This row's own qty-weighted average entry premium per leg — an LTP
   * estimate at order-send time, blended across every opening add on this
   * leg. Unlike the broker's own live buyAvg/sellAvg (which blends in
   * everything else sharing the same strike/security), this is scoped to
   * only what THIS row's own orders opened, so a shared-strike row's SL ×
   * entry side isn't contaminated by another row's/strategy's cost basis.
   * Optional on disk for older sessions or worker-only entries; readers
   * treat missing as "fall back to the broker average" (only when this row
   * can fully account for the whole broker position — see
   * broker_avg_trusted's Python-side twin).
   */
  ceEntry?: number | null;
  peEntry?: number | null;
  /**
   * Unix ms this leg's qty last went from 0 to positive. Persisted to disk
   * (same file as the rest of `fill`) so it survives a page reload, not just
   * an in-memory ref — the whole point is to protect a fresh fill across
   * exactly the kind of interruption (tab reload/reopen) that clears memory.
   *
   * Exists to refuse a ghost-drop: a leg the broker's polled position still
   * reads as flat (netQty === 0) within GHOST_DROP_GRACE_MS of opening is
   * treated as "fill not caught up yet", not "actually flat" — Kotak/Zerodha
   * have no fill-confirmation socket, so a stale poll right after a real
   * fill can otherwise make this page zero a live short out of its own
   * ledger and stop tracking it entirely. Cleared when the leg returns to 0.
   * Mirrors the retired focus_tool_rows_worker.py's RECONCILE_GRACE_SECONDS.
   */
  ceOpenedTs?: number | null;
  peOpenedTs?: number | null;
  /**
   * How many times this leg has been auto-rolled OTM after its own SL × hit
   * during the current cycle (see FocusRow.slRollStrikes). Capped by
   * FocusRow.slRollMax so a trending market can't chain rolls all day. Reset
   * with the rest of the ledger on Arm / full-row exit.
   */
  ceRolls?: number;
  peRolls?: number;
  /**
   * The SL-to-cost stop is live on this leg: the OTHER leg's own SL × fired
   * while this one was open and the row has FocusRow.slToCost on. Exits this
   * leg if its premium climbs back to its own entry. Cleared when the leg
   * goes flat (a later re-open starts without it).
   */
  ceCostStop?: boolean;
  peCostStop?: boolean;
  /** Re-entries taken after a leg TARGET this cycle (SL ones are ceRolls/peRolls). */
  ceTgtReentries?: number;
  peTgtReentries?: number;
  /** A cost / momentum re-entry waiting for its price. See FocusPendingReentry. */
  cePending?: FocusPendingReentry | null;
  pePending?: FocusPendingReentry | null;
  /**
   * RE-Cost's price: the INITIAL entry of the strike cost re-entries cycle
   * on (AlgoTest re-enters "at initial entry price"). Recorded the first time
   * a cost re-entry is armed on that strike this cycle and reused while later
   * ones stay on it — the closed leg's own entry would be the previous cost
   * fill, drifting the level lower with every re-entry. See costReentryBasis.
   */
  ceCostBasis?: { strike: number; price: number } | null;
  peCostBasis?: { strike: number; price: number } | null;
  ts: string;
}

export interface FocusRow {
  id: string;
  underlying: FocusUnderlying;
  entryTime: string;         // 'HH:MM'
  exitTime: string;          // 'HH:MM'
  dte: FocusDte;
  expiry: string;            // resolved expiry date string YYYY-MM-DD
  // Strike resolution: ATM mode picks a strike a signed number of steps away
  // from ATM per leg; PREMIUM mode picks whichever listed strike's LTP sits
  // closest to the given rupee target. `linked` mirrors CE's setting onto PE
  // (and vice versa) when the two are edited together; unlinked, each leg is
  // independent and an inverted strangle is a valid, user-chosen shape.
  strikeMode: FocusStrikeMode;
  linked: boolean;
  ceOffset: number;
  peOffset: number;
  cePremium: string;
  pePremium: string;
  lots: number;
  side: FocusSide;
  status: FocusRowStatus;
  // Level exits
  levelHigh: string;
  levelLow: string;
  levelVw: boolean;
  // Candle interval (minutes) the VW rule's session-open VWAP is computed
  // from — '1' or '5', per the Dhan intraday intervals the backend supports.
  vwapInterval: string;
  // VW exits fire off the last CLOSED candle's combined premium, not a live
  // tick — a spurious wick doesn't trigger it. This is a % buffer past VWAP
  // that close must clear before it counts as a breach. '' or '0' means no
  // buffer (close at/above VWAP exits).
  vwapBufferPct: string;
  slRupees: string;
  slMultiplier: string;
  // Leg-wise stop, independent of the pair-level slMultiplier above: exits
  // JUST that leg when its own premium expands to this multiple of its own
  // entry price, regardless of what the other leg (or the combined pair) is
  // doing. The row stays open on whichever leg didn't breach. '1' or blank
  // means off, same convention as slMultiplier.
  ceSlMultiplier: string;
  peSlMultiplier: string;
  /**
   * Re-enter after a leg SL × hit: once the stopped leg's close confirms,
   * sell the same lots again this many strikes further OTM than the strike
   * that was stopped (CE up, PE down). 0 / missing = off — the leg just stays
   * closed, as before this option existed.
   */
  slRollStrikes?: number;
  /** Max auto-rolls per leg per cycle (Arm → exit). Missing = 2. */
  slRollMax?: number;
  /**
   * Re-entry after a leg SL × close. Missing = 'otm' when slRollStrikes > 0
   * (rows saved before re-entry modes existed), else 'off'. Strikes for
   * 'otm' come from slRollStrikes. Max per leg per cycle from reSlMax, else
   * slRollMax.
   */
  reSlMode?: FocusReentryMode;
  reSlMax?: number;
  /** Re-entry after a leg TARGET close — same modes. Missing = 'off'. */
  reTgtMode?: FocusReentryMode;
  reTgtMax?: number;
  /** Momentum re-entry: points the new strike's premium must move. */
  reMomentumPts?: string;
  /** Momentum direction. Missing = 'down' (premium decaying — a seller's confirmation). */
  reMomentumDir?: 'down' | 'up';
  /**
   * 'HH:MM' IST. A stop/target hit at or after this time takes no re-entry,
   * and waiting (cost / momentum) re-entries are dropped. Blank = no cutoff
   * beyond the row's own exit time and the 15:17 backstop.
   */
  noReEntryAfter?: string;
  /**
   * Leg-wise target, % of this leg's own entry premium: the leg exits when
   * its premium has decayed by this much (entry × (1 − pct/100)). Blank / 0
   * = off.
   */
  ceTgtPct?: string;
  peTgtPct?: string;
  /**
   * SL to cost: when one leg's own SL × hits, the leg still open gets a stop
   * at its own entry premium (break-even on that leg). Missing = off.
   */
  slToCost?: boolean;
  /**
   * 'real' sends broker orders (still gated by the daily LIVE · REAL MONEY
   * arm); 'sim' forward-tests the same rules with paper fills at LTP and never
   * touches the broker. Missing on disk means 'real' — every row saved before
   * this field existed traded real money, and reading one as sim would orphan
   * a live position. New rows start as 'sim'. See isSimRow().
   */
  mode?: FocusRowMode;
  // What this row actually holds — see FocusRowFill. Absent until it enters.
  // For a sim row this is the paper ledger itself, not a broker-backed record.
  fill?: FocusRowFill;
  // Audit
  createdAt: string;
  updatedAt: string;
}

export interface FocusToolConfig {
  groups: FocusIndexGroup[];
  rows: FocusRow[];
  riskEnabled: boolean;
  targetRupees: string;
  stopRupees: string;
  trailEnabled: boolean;
  triggerRupees: string;
  lockRupees: string;
  liveRealMoney: boolean;
  /**
   * IST date (YYYY-MM-DD) on which LIVE · REAL MONEY was last switched on.
   *
   * The arm expires with the session. `liveRealMoney` lives on disk and the
   * worker auto-starts when the page mounts, so without this yesterday's "on"
   * silently becomes today's "on": a page opened on Monday morning could start
   * trading a config last looked at on Friday. Both readers — the page and
   * focus_tool_rows_worker.py — treat live as OFF unless this is today, so
   * going live is a decision that has to be made again each day.
   */
  liveArmedOn: string;
  updatedAt: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_GROUP = (u: FocusUnderlying): FocusIndexGroup => ({
  underlying: u,
  enabled: false,
  atmBy: 'Spot',
  product: 'INTRADAY',
  strikesOffset: 0,
  bookExit: false,
  spotHigh: '',
  spotLow: '',
});

export const DEFAULT_CONFIG: FocusToolConfig = {
  groups: [DEFAULT_GROUP('NIFTY'), DEFAULT_GROUP('BANKNIFTY'), DEFAULT_GROUP('SENSEX')],
  rows: [],
  riskEnabled: false,
  targetRupees: '',
  stopRupees: '',
  trailEnabled: false,
  triggerRupees: '',
  lockRupees: '',
  liveRealMoney: false,
  liveArmedOn: '',
  updatedAt: new Date().toISOString(),
};

// ── I/O ───────────────────────────────────────────────────────────────────────

function writeJsonAtomic(file: string, data: unknown) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readFocusConfig(): FocusToolConfig {
  try {
    if (!fs.existsSync(ROWS_FILE)) return DEFAULT_CONFIG;
    const raw = JSON.parse(fs.readFileSync(ROWS_FILE, 'utf-8'));
    // Merge with defaults so new keys added to DEFAULT_CONFIG are always present
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      groups: (raw.groups ?? DEFAULT_CONFIG.groups).map((g: Partial<FocusIndexGroup>, i: number) => ({
        ...DEFAULT_CONFIG.groups[i] ?? DEFAULT_GROUP(g.underlying ?? 'NIFTY'),
        ...g,
      })),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeFocusConfig(config: FocusToolConfig): void {
  writeJsonAtomic(ROWS_FILE, { ...config, updatedAt: new Date().toISOString() });
}

// ── ID helper ─────────────────────────────────────────────────────────────────

let _seq = 0;
export function newFocusRowId(): string {
  _seq += 1;
  return `ft_${Date.now().toString(36)}_${_seq.toString(36)}`;
}
