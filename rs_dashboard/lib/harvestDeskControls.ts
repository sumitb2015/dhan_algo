// Control catalogue for the Harvest Desk page: every input the five Premium Harvest strategies
// document in strategies/<group>/readmes/*.md, with the readme's default and CLI flag.
//
// The page renders its control panels from this table and the engine (harvestDesk.ts) reads the
// values by key, so a documented control exists in exactly one place. `enforced: false` marks
// a control the desk stores and shows but cannot evaluate yet; the UI says so on the control.

export type HdKind =
  | 'imbalance_straddle'
  | 'imbalance_strangle'
  | 'advanced_imbalance'
  | 'vwap_straddle'
  | 'diagonal_call';

export const HD_KINDS: readonly HdKind[] = [
  'imbalance_straddle', 'imbalance_strangle', 'advanced_imbalance', 'vwap_straddle', 'diagonal_call',
];

export interface HdKindMeta {
  label: string;
  /** The strategy script the controls come from (strategies/…). */
  script: string;
  summary: string;
  product: 'INTRADAY' | 'MARGIN';
}

export const HD_KIND_META: Record<HdKind, HdKindMeta> = {
  imbalance_straddle: {
    label: 'Value Imbalance Straddle',
    script: 'value_imbalance/nifty_value_imbalance_straddle.py',
    summary: 'Sell ATM CE+PE once premiums balance; add lots on the decaying leg, roll the other leg out.',
    product: 'INTRADAY',
  },
  imbalance_strangle: {
    label: 'Value Imbalance Strangle',
    script: 'value_imbalance/nifty_value_imbalance_strangle.py',
    summary: 'Sell an OTM CE+PE once premiums balance; same value balancing, reset if spot breaches a strike.',
    product: 'INTRADAY',
  },
  advanced_imbalance: {
    label: 'Advanced Imbalance',
    script: 'value_imbalance/nifty_advanced_imbalance.py',
    summary: 'Straddle or strangle with five adjustment modes, scalp lock, rupee trail and multi-cycle.',
    product: 'INTRADAY',
  },
  vwap_straddle: {
    label: 'VWAP 1-Min Straddle',
    script: 'value_imbalance/nifty_vwap_1min_straddle.py',
    summary: 'Sell the ATM straddle while its combined premium sits under its own session VWAP; buy back above it.',
    product: 'INTRADAY',
  },
  diagonal_call: {
    label: 'Low-Gamma Diagonal Call',
    script: 'diagonal_call/nifty_diagonal_call.py',
    summary: 'Long 60-120 DTE ~0.60Δ call financed by short 25-45 DTE ~0.18Δ calls; positional, delta-sized.',
    product: 'MARGIN',
  },
};

export type HdSection = 'Entry' | 'Adjust' | 'Exit' | 'Target' | 'Stop loss';
export const HD_SECTIONS: readonly HdSection[] = ['Entry', 'Adjust', 'Exit', 'Target', 'Stop loss'];

export type HdControlValue = number | string | boolean;
export type HdControls = Record<string, HdControlValue>;

export interface HdControlSpec {
  key: string;
  label: string;
  section: HdSection;
  type: 'num' | 'time' | 'text' | 'select' | 'bool';
  /** Kinds that document this control, with the readme default for each. */
  def: Partial<Record<HdKind, HdControlValue>>;
  unit?: string;
  /** The CLI flag in the strategy script, so the desk can be read against the readme. */
  flag: string;
  hint: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** False = shown and stored, but the engine does not act on it (the UI says so). */
  enforced: boolean;
}

const IMB: HdKind[] = ['imbalance_straddle', 'imbalance_strangle', 'advanced_imbalance'];
const INTRADAY_ALL: HdKind[] = ['imbalance_straddle', 'imbalance_strangle', 'advanced_imbalance', 'vwap_straddle'];

const all = (v: HdControlValue, kinds: HdKind[]): Partial<Record<HdKind, HdControlValue>> =>
  Object.fromEntries(kinds.map((k) => [k, v]));

const UNIT_OPTS = [{ value: 'rs', label: '₹' }, { value: 'pct', label: '%' }];

export const HD_CONTROLS: HdControlSpec[] = [
  // ── Entry ────────────────────────────────────────────────────────────────
  {
    key: 'startTime', label: 'Start time', section: 'Entry', type: 'time', flag: '--start-time', enforced: true,
    def: { imbalance_straddle: '09:20', imbalance_strangle: '09:20', advanced_imbalance: '09:20', vwap_straddle: '09:15', diagonal_call: '09:30' },
    hint: 'No entry before this IST time. The VWAP script starts its 1-minute bars at the 09:15 open.',
  },
  {
    key: 'entryBalancePct', label: 'Entry balance', section: 'Entry', type: 'num', unit: '%', flag: '--entry-balance-threshold', enforced: true, min: 0, step: 1,
    def: { imbalance_straddle: 15, imbalance_strangle: 25, advanced_imbalance: 10 },
    hint: 'Enter only while |CE − PE| / max(CE, PE) is under this. Readme defaults: 15 straddle, 25 strangle; Advanced uses 10 for a straddle and 25 for a strangle.',
  },
  {
    key: 'vwapWarmupBars', label: 'VWAP warm-up bars', section: 'Entry', type: 'num', unit: 'bars', flag: '--vwap-warmup-bars', enforced: true, min: 1, step: 1,
    def: { vwap_straddle: 10 }, hint: 'Completed 1-minute bars needed before the VWAP is trusted. The desk builds its own bars from the combined premium.',
  },
  {
    key: 'entryBand', label: 'Entry band', section: 'Entry', type: 'num', unit: 'pts', flag: '--entry-band', enforced: true, min: 0, step: 1,
    def: { vwap_straddle: 5 }, hint: 'Price gate: combined CE+PE ≤ session VWAP + this.',
  },
  {
    key: 'declineTicks', label: 'Decline ticks', section: 'Entry', type: 'num', unit: 'ticks', flag: '--decline-ticks', enforced: true, min: 1, step: 1,
    def: { vwap_straddle: 5 }, hint: 'Decline gate: the combined premium must be lower than it was this many samples ago (one sample per engine second).',
  },
  {
    key: 'maxPremiumDiffPct', label: 'Max premium diff', section: 'Entry', type: 'num', unit: '%', flag: '--max-premium-diff', enforced: true, min: 0, step: 1,
    def: { vwap_straddle: 15 }, hint: 'Balance gate: |CE − PE| / max(CE, PE) under this.',
  },
  {
    key: 'maxSpreadPct', label: 'Max bid-ask spread', section: 'Entry', type: 'num', unit: '%', flag: '--max-spread-pct', enforced: true, min: 0, step: 1,
    def: { vwap_straddle: 8 }, hint: 'Liquidity guard: skip entry if either leg spread exceeds this % of mid. Skipped for a leg the feed gives no bid/ask for.',
  },
  {
    key: 'rebalanceWindows', label: 'Rebalance windows', section: 'Entry', type: 'text', flag: 'rebalance windows', enforced: true,
    def: { diagonal_call: '10:00,12:00,14:00' }, hint: 'IST times at which the desk may open the long/short pair (comma separated). Each window fires once a day.',
  },
  {
    key: 'longDteMin', label: 'Long DTE min', section: 'Entry', type: 'num', unit: 'd', flag: 'long leg 60-120 DTE', enforced: true, min: 1, step: 1,
    def: { diagonal_call: 60 }, hint: 'Long call expiry window, days to expiry.',
  },
  {
    key: 'longDteMax', label: 'Long DTE max', section: 'Entry', type: 'num', unit: 'd', flag: 'long leg 60-120 DTE', enforced: true, min: 1, step: 1,
    def: { diagonal_call: 120 }, hint: 'Long call expiry window, days to expiry.',
  },
  {
    key: 'longDelta', label: 'Long Δ target', section: 'Entry', type: 'num', flag: 'long leg ~0.60Δ', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.6 }, hint: 'Strike closest to this absolute delta inside the band.',
  },
  {
    key: 'longDeltaMin', label: 'Long Δ min', section: 'Entry', type: 'num', flag: '0.55-0.65Δ', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.55 }, hint: 'Nothing is bought outside the delta band.',
  },
  {
    key: 'longDeltaMax', label: 'Long Δ max', section: 'Entry', type: 'num', flag: '0.55-0.65Δ', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.65 }, hint: 'Nothing is bought outside the delta band.',
  },
  {
    key: 'shortDteMin', label: 'Short DTE min', section: 'Entry', type: 'num', unit: 'd', flag: 'short leg 25-45 DTE', enforced: true, min: 1, step: 1,
    def: { diagonal_call: 25 }, hint: 'Short call expiry window; it must end before the long call.',
  },
  {
    key: 'shortDteMax', label: 'Short DTE max', section: 'Entry', type: 'num', unit: 'd', flag: 'short leg 25-45 DTE', enforced: true, min: 1, step: 1,
    def: { diagonal_call: 45 }, hint: 'Short call expiry window; it must end before the long call.',
  },
  {
    key: 'shortDelta', label: 'Short Δ target', section: 'Entry', type: 'num', flag: 'short leg ~0.18Δ', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.18 }, hint: 'Strike closest to this absolute delta inside the band.',
  },
  {
    key: 'shortDeltaMin', label: 'Short Δ min', section: 'Entry', type: 'num', flag: '0.15-0.22Δ', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.15 }, hint: 'Nothing is sold outside the delta band.',
  },
  {
    key: 'shortDeltaMax', label: 'Short Δ max', section: 'Entry', type: 'num', flag: '0.15-0.22Δ', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.22 }, hint: 'Nothing is sold outside the delta band.',
  },
  {
    key: 'targetNetDelta', label: 'Target net Δ', section: 'Entry', type: 'num', unit: 'units', flag: '--target-net-delta', enforced: true, step: 1,
    def: { diagonal_call: 13 }, hint: 'Short lots are sized so net portfolio delta (units) lands here.',
  },
  {
    key: 'maxShortLots', label: 'Max short lots', section: 'Entry', type: 'num', unit: 'lots', flag: '--max-short-lots', enforced: true, min: 0, max: 50, step: 1,
    def: { diagonal_call: 6 }, hint: 'Cap on the dynamically sized short call.',
  },
  {
    key: 'maxShortRatio', label: 'Max short ratio', section: 'Entry', type: 'num', unit: '×', flag: '--max-short-ratio', enforced: true, min: 0, step: 0.05,
    def: { diagonal_call: 1.25 }, hint: 'Short delta may not exceed this multiple of the long delta.',
  },
  {
    key: 'capital', label: 'Capital', section: 'Entry', type: 'num', unit: '₹', flag: 'capital base', enforced: true, min: 0, step: 10000,
    def: { diagonal_call: 1000000 }, hint: 'Base for the % limits below (daily loss, drawdown, % target / stop).',
  },

  // ── Adjust ───────────────────────────────────────────────────────────────
  {
    key: 'adjustMode', label: 'Adjustment mode', section: 'Adjust', type: 'select', flag: '--mode', enforced: true,
    def: { advanced_imbalance: 'winner_roll_atm' },
    options: [
      { value: 'winner_roll_atm', label: 'Winner roll (value-matched, toward ATM)' },
      { value: 'loser_ratio_roll', label: 'Loser ratio roll' },
      { value: 'hedged_addition', label: 'Hedged addition' },
      { value: 'reentry_straddle', label: 'Re-entry straddle' },
      { value: 'legacy', label: 'Legacy (exit at max lots)' },
    ],
    hint: 'How an imbalance is corrected. Winner roll moves the decayed leg toward ATM until its value matches the other leg (the script does this; its readme describes lot additions). Re-entry straddle gives each leg its own SL and re-sells it when the price returns to entry.',
  },
  {
    key: 'thresholdLotPct', label: 'Add-lot imbalance', section: 'Adjust', type: 'num', unit: '%', flag: '--threshold-lot', enforced: true, min: 0, step: 1,
    def: all(25, IMB), hint: 'Imbalance of leg VALUES (lots × price) above the baseline that triggers an adjustment: one more lot on the winning (lower-value) leg. The baseline is the imbalance at entry and is re-measured after every adjustment.',
  },
  {
    key: 'thresholdStrikePct', label: 'Roll-strike imbalance', section: 'Adjust', type: 'num', unit: '%', flag: '--threshold-strike', enforced: true, min: 0, step: 1,
    def: all(40, IMB), hint: 'The wider trigger used once a leg sits at max lots: the losing leg rolls to the OTM strike whose value matches the winner.',
  },
  {
    key: 'maxLots', label: 'Max lots per leg', section: 'Adjust', type: 'num', unit: 'lots', flag: '--max-lots', enforced: true, min: 1, max: 50, step: 1,
    def: all(4, IMB), hint: 'Lot additions stop here. Has no effect in re-entry straddle mode.',
  },
  {
    key: 'loserRatioLots', label: 'Loser ratio lots', section: 'Adjust', type: 'num', unit: 'lots', flag: '--loser-ratio-lots', enforced: true, min: 1, max: 50, step: 1,
    def: { advanced_imbalance: 1 }, hint: 'Loser ratio mode: lots added to the loser as it rolls further OTM.',
  },
  {
    key: 'hedgeDistance', label: 'Hedge distance', section: 'Adjust', type: 'num', unit: 'pts', flag: 'hedge 200 pts further', enforced: true, min: 0, step: 50,
    def: { advanced_imbalance: 200 }, hint: 'Hedged addition mode: the protective wing is bought this far beyond the winner strike.',
  },
  {
    key: 'legSlPct', label: 'Leg SL (re-entry mode)', section: 'Adjust', type: 'num', unit: '%', flag: '--leg-sl-pct', enforced: true, min: 0, step: 1,
    def: { advanced_imbalance: 20 }, hint: 'Re-entry straddle mode: each leg stops at this % above its own entry; it re-enters when its price falls back to the entry premium.',
  },
  {
    key: 'inversionGuard', label: 'Inversion guard', section: 'Adjust', type: 'bool', flag: 'CE strike > PE strike', enforced: true,
    def: all(true, IMB), hint: 'Block an entry or roll that would cross the CE and PE strikes. A blocked roll ends the cycle (5-minute pause, fresh cycle).',
  },
  {
    key: 'adjustCooldownSec', label: 'Adjust cooldown', section: 'Adjust', type: 'num', unit: 's', flag: 'one per 1-min bar', enforced: true, min: 0, step: 5,
    def: all(60, IMB), hint: 'Desk safeguard that mirrors the script: at most one adjustment per bar, so one imbalance reading does not add a lot every second.',
  },
  {
    key: 'shortProfitPct', label: 'Short profit take', section: 'Adjust', type: 'num', unit: '%', flag: '--short-profit-pct', enforced: true, min: 0, step: 1,
    def: { diagonal_call: 65 }, hint: 'Roll the short call once this % of its premium has decayed.',
  },
  {
    key: 'shortRollDte', label: 'Short roll DTE', section: 'Adjust', type: 'num', unit: 'd', flag: '--short-roll-dte', enforced: true, min: 0, step: 1,
    def: { diagonal_call: 14 }, hint: 'Roll the short call when its DTE falls to this.',
  },
  {
    key: 'shortRollDelta', label: 'Short roll Δ', section: 'Adjust', type: 'num', flag: '--short-roll-delta', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.35 }, hint: 'Roll the short call when its absolute delta expands past this.',
  },
  {
    key: 'portfolioDeltaFloor', label: 'Portfolio Δ floor', section: 'Adjust', type: 'num', unit: 'units', flag: 'delta < -40', enforced: true, step: 1,
    def: { diagonal_call: -40 }, hint: 'Roll the short call when net portfolio delta drops below this.',
  },
  {
    key: 'minGammaLimit', label: 'Min gamma limit', section: 'Adjust', type: 'num', flag: '--min-gamma-limit', enforced: false, step: 0.01,
    def: { diagonal_call: -0.2 }, hint: 'Portfolio gamma floor that forces a short roll. Stored only: the chain feed carries no gamma yet.',
  },
  {
    key: 'longRollDte', label: 'Long roll DTE', section: 'Adjust', type: 'num', unit: 'd', flag: '--long-roll-dte', enforced: true, min: 0, step: 1,
    def: { diagonal_call: 35 }, hint: 'Close the long call (shorts first) when its DTE falls below this; a fresh pair opens at the next window.',
  },
  {
    key: 'freeCallDelta', label: 'Free-long-call short Δ', section: 'Adjust', type: 'num', flag: 'clamp 0.08-0.15Δ', enforced: true, min: 0, step: 0.01,
    def: { diagonal_call: 0.12 }, hint: 'Once cumulative short premium covers the long debit, new shorts use this far-OTM delta with half the lots.',
  },

  // ── Exit ─────────────────────────────────────────────────────────────────
  {
    key: 'straddleShiftPts', label: 'Straddle shift reset', section: 'Exit', type: 'num', unit: 'pts', flag: 'ATM shift ≥100', enforced: true, min: 0, step: 50,
    def: { imbalance_straddle: 100, advanced_imbalance: 100 }, hint: 'Straddle: if ATM moves this far from the entry strike, exit everything, pause, restart. A strangle resets when spot breaches either strike.',
  },
  {
    key: 'cyclePauseMin', label: 'Cycle pause', section: 'Exit', type: 'num', unit: 'min', flag: '5-minute pause', enforced: true, min: 0, step: 1,
    def: all(5, IMB), hint: 'Pause after a cycle exit (reset, trail, deadlock, blocked roll) before a fresh cycle.',
  },
  {
    key: 'squareOffTime', label: 'Square-off', section: 'Exit', type: 'time', flag: 'hard intraday square-off', enforced: true,
    def: all('15:17', INTRADAY_ALL), hint: 'Everything is closed at this IST time and the day ends.',
  },
  {
    key: 'exitBuffer', label: 'VWAP exit buffer', section: 'Exit', type: 'num', unit: 'pts', flag: '--exit-buffer', enforced: true, min: 0, step: 1,
    def: { vwap_straddle: 10 }, hint: 'Buy back when the combined premium rises above VWAP + this.',
  },
  {
    key: 'cooldownSeconds', label: 'Loss cooldown', section: 'Exit', type: 'num', unit: 's', flag: '--cooldown-seconds', enforced: true, min: 0, step: 5,
    def: { vwap_straddle: 90 }, hint: 'Pause after a losing cycle.',
  },
  {
    key: 'maxTradesPerDay', label: 'Max trades / day', section: 'Exit', type: 'num', unit: 'trades', flag: '--max-trades-per-day', enforced: true, min: 0, step: 1,
    def: { vwap_straddle: 15 }, hint: 'Entries per day; 0 = unlimited.',
  },

  // ── Target ───────────────────────────────────────────────────────────────
  {
    key: 'targetProfit', label: 'Daily profit target', section: 'Target', type: 'num', flag: '--target-profit', enforced: true, min: 0, step: 100,
    def: { imbalance_straddle: 4000, imbalance_strangle: 4000, advanced_imbalance: 25, vwap_straddle: 4000, diagonal_call: 0 },
    hint: 'Reaching it closes everything and ends the day. 0 = off. A % is of the entry premium collected (of capital for the diagonal).',
  },
  {
    key: 'targetUnit', label: 'Target unit', section: 'Target', type: 'select', flag: '--target-profit', enforced: true, options: UNIT_OPTS,
    def: { imbalance_straddle: 'rs', imbalance_strangle: 'rs', advanced_imbalance: 'pct', vwap_straddle: 'rs', diagonal_call: 'rs' },
    hint: 'Rupees, or % of the entry premium collected.',
  },
  {
    key: 'scalpFloorPct', label: 'Scalp lock', section: 'Target', type: 'num', unit: '%', flag: '--scalp-floor-pct', enforced: true, min: 0, step: 1,
    def: { advanced_imbalance: 0 }, hint: 'Exit once cycle profit reaches this % of the entry premium; 0 = disabled.',
  },
  {
    key: 'multiCycle', label: 'Multi-cycle', section: 'Target', type: 'bool', flag: '--multi-cycle', enforced: true,
    def: { advanced_imbalance: false }, hint: 'After a scalp lock, start a fresh cycle instead of ending the day.',
  },
  {
    key: 'cycleCooldownSec', label: 'Cycle cooldown', section: 'Target', type: 'num', unit: 's', flag: '--cycle-cooldown', enforced: true, min: 0, step: 10,
    def: { advanced_imbalance: 300 }, hint: 'Multi-cycle: wait before the next cycle after a scalp lock.',
  },

  // ── Stop loss ────────────────────────────────────────────────────────────
  {
    key: 'stopLoss', label: 'Daily stop loss', section: 'Stop loss', type: 'num', flag: '--stop-loss', enforced: true, min: 0, step: 100,
    def: { imbalance_straddle: 4000, imbalance_strangle: 4000, advanced_imbalance: 25, vwap_straddle: 4000, diagonal_call: 0 },
    hint: 'Reaching it closes everything and ends the day. 0 = off.',
  },
  {
    key: 'stopUnit', label: 'Stop unit', section: 'Stop loss', type: 'select', flag: '--stop-loss', enforced: true, options: UNIT_OPTS,
    def: { imbalance_straddle: 'rs', imbalance_strangle: 'rs', advanced_imbalance: 'pct', vwap_straddle: 'rs', diagonal_call: 'rs' },
    hint: 'Rupees, or % of the entry premium collected.',
  },
  {
    key: 'trailStartRs', label: 'Trail start', section: 'Stop loss', type: 'num', unit: '₹', flag: '--trail-start-rs', enforced: true, min: 0, step: 50,
    def: { advanced_imbalance: 500 }, hint: 'Rupee MTM trail (realized + open, so it survives rolls): arms once cycle profit reaches this. 0 = off.',
  },
  {
    key: 'trailGapRs', label: 'Trail gap', section: 'Stop loss', type: 'num', unit: '₹', flag: '--trail-gap-rs', enforced: true, min: 0, step: 50,
    def: { advanced_imbalance: 300 }, hint: 'Exit if MTM gives back this much from its best.',
  },
  {
    key: 'trailStartPct', label: 'Trail start', section: 'Stop loss', type: 'num', unit: '%', flag: '--trail-start-pct', enforced: true, min: 0, step: 0.5,
    def: { imbalance_straddle: 5 }, hint: 'Premium trail: arms once profit reaches this % of the entry combined premium. 0 = off.',
  },
  {
    key: 'trailGapPts', label: 'Trail gap', section: 'Stop loss', type: 'num', unit: 'pts', flag: '--trail-gap-pts', enforced: true, min: 0, step: 1,
    def: { imbalance_straddle: 15 }, hint: 'Exit if the combined premium rises this many points above its best since arming.',
  },
  {
    key: 'maxLossPerTrade', label: 'Max loss / trade', section: 'Stop loss', type: 'num', unit: '₹', flag: '--max-loss-per-trade', enforced: true, min: 0, step: 100,
    def: { vwap_straddle: 1500 }, hint: 'Hard per-cycle stop, independent of VWAP. 0 = off.',
  },
  {
    key: 'dailyLossPct', label: 'Daily loss limit', section: 'Stop loss', type: 'num', unit: '% cap', flag: '--daily-loss-pct', enforced: true, min: 0, step: 0.1,
    def: { diagonal_call: 1.5 }, hint: 'Suspends discretionary adjustments for the day if intraday MTM drops this % of capital. Expiry and critical-delta rolls still run.',
  },
  {
    key: 'drawdownHalvePct', label: 'Drawdown halve', section: 'Stop loss', type: 'num', unit: '% cap', flag: '--drawdown-halve-pct', enforced: true, min: 0, step: 0.5,
    def: { diagonal_call: 5 }, hint: 'Halves the short call when drawdown from the equity peak reaches this % of capital.',
  },
  {
    key: 'drawdownExitPct', label: 'Drawdown exit', section: 'Stop loss', type: 'num', unit: '% cap', flag: '--drawdown-exit-pct', enforced: true, min: 0, step: 0.5,
    def: { diagonal_call: 8 }, hint: 'Closes everything and halts the algo at this drawdown.',
  },
];

export function controlsFor(kind: HdKind): HdControlSpec[] {
  return HD_CONTROLS.filter((c) => c.def[kind] !== undefined);
}

export function defaultControls(kind: HdKind): HdControls {
  const out: HdControls = {};
  for (const c of controlsFor(kind)) out[c.key] = c.def[kind] as HdControlValue;
  return out;
}

export function numCtl(c: HdControls, key: string, fallback = 0): number {
  const v = c[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function strCtl(c: HdControls, key: string, fallback = ''): string {
  const v = c[key];
  return v == null ? fallback : String(v);
}

export function boolCtl(c: HdControls, key: string, fallback = false): boolean {
  const v = c[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** A control is "present" when the kind documents it; the engine skips rules whose control is absent. */
export function hasCtl(c: HdControls, key: string): boolean {
  return c[key] !== undefined;
}
