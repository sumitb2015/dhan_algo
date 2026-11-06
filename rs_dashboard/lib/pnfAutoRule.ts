// Which signals each Renko AUTO rule trades, and how the rule reads in the UI: one place for both charts, so a new rule cannot be
// added to one chart's selection and missed on the other (a missed case would trade the plain N-brick signals under another name).
// Pure (tested in lib/pnfAutoRule.test.ts).
import { isSellSignal, type PnfSignal } from './straddlePnf.ts';

export type AutoRule = 'nbrick' | 'trend' | 'twoback' | 'oneback' | 'supertrend';
/** What a chart starts with (and falls back to for an unreadable saved value). */
export const DEFAULT_AUTO_RULE: AutoRule = 'supertrend';
export const AUTO_RULES: readonly AutoRule[] = ['nbrick', 'trend', 'twoback', 'oneback', 'supertrend'];

/** The chart model with `signals` replaced by the selected rule's signals (the engine reads `model.signals`). */
export function modelForRule<M extends { signals: PnfSignal[]; trend: PnfSignal[]; twoBack: PnfSignal[]; oneBack: PnfSignal[]; stSignals: PnfSignal[] }>(rule: AutoRule, m: M): M {
  switch (rule) {
    case 'supertrend': return { ...m, signals: m.stSignals };
    case 'trend': return { ...m, signals: m.trend };
    case 'twoback': return { ...m, signals: m.twoBack };
    case 'oneback': return { ...m, signals: m.oneBack };
    case 'nbrick': return m;
  }
}

/** The tooltip text of the rule. `confirm`: the chart's N (bricks) for the N-brick rules. */
export function ruleText(rule: AutoRule, confirm: number): string {
  switch (rule) {
    case 'supertrend': return 'Supertrend: BUY on a green brick while the line is up, SELL on a red brick while it is down (a brick of the other colour never enters); exit when the line flips against the position, then enter the new side (uses the chart\'s ATR / multiplier). No stop of its own: the MTM guard is its loss limit';
    case 'trend': return `Renko trend: SELL / BUY on every brick that completes ${confirm} same-colour brick(s), no reversal needed; exit on the first opposite brick, then re-enter the new direction`;
    case 'oneback': return 'One-back: 2+ bricks, 1-brick pullback, 2 bricks resume past the swing; stop one brick beyond the pullback';
    case 'twoback': return 'Two-back: 3+ bricks, 2-brick pullback, 3 bricks resume past the swing; stop one brick beyond the pullback';
    case 'nbrick': return `Renko SELL / BUY after ${confirm} confirming bricks, exit on the first opposite brick`;
  }
}

/** Which side(s) AUTO may OPEN. Exits are never filtered: a position that is open always exits by its own rule. */
export type AutoSide = 'both' | 'buy' | 'sell';
export const AUTO_SIDES: readonly AutoSide[] = ['both', 'buy', 'sell'];
export const DEFAULT_AUTO_SIDE: AutoSide = 'both';

/** The model with only the allowed side's signals (the engine enters on `model.signals`); 'both' is the model itself. */
export function withSide<M extends { signals: PnfSignal[] }>(m: M, side: AutoSide): M {
  if (side === 'both') return m;
  return { ...m, signals: m.signals.filter(s => (side === 'sell') === isSellSignal(s.kind)) };
}

export const SIDE_LABEL: Record<AutoSide, string> = { both: 'Buy + Sell', buy: 'Buy only', sell: 'Sell only' };

/**
 * The signal the side filter is holding back right now: the newest signal after `watermarkT`, on the last closed bar, for the side the
 * filter does not allow - so the AUTO status can say "SELL signal ignored (Buy only)" instead of looking idle. Null when the filter is
 * 'both', or nothing is being held back (the engine enters, or has no fresh signal).
 */
export function ignoredByFilter(m: { signals: PnfSignal[]; lastBarT: number | null }, side: AutoSide, watermarkT: number): PnfSignal | null {
  if (side === 'both' || m.lastBarT === null) return null;
  const allowed = withSide(m, side).signals;
  if (allowed.some(s => s.t > watermarkT && s.t === m.lastBarT)) return null;
  return [...m.signals].reverse().find(s => s.t > watermarkT && s.t === m.lastBarT) ?? null;
}

/**
 * Supertrend rule: why the brick(s) the newest closed bar printed did not enter, so the AUTO status can say "red brick skipped:
 * Supertrend line is up" instead of a bare "waiting for a signal" (2026-11-06: a red pullback brick under a rising line looked like a
 * stuck engine). Only bricks after `watermarkT` count (those formed since arming); the bar's LAST brick is the one explained. Null for
 * any other rule, no brick on the newest closed bar, or a brick that is a signal (the engine enters it, or the side filter says so).
 */
export function skippedBrick(m: { columns: { dir: 'X' | 'O' }[]; columnTimes: { start: number }[]; supertrend?: { line: number | null; dir: 1 | -1 | null }[]; lastBarT: number | null },
  rule: AutoRule, watermarkT: number): { key: string; text: string } | null {
  if (rule !== 'supertrend' || m.lastBarT === null || !(m.lastBarT > watermarkT)) return null;
  let i = m.columns.length - 1;
  while (i >= 0 && (m.columnTimes[i]?.start ?? -Infinity) > m.lastBarT) i--;
  if (i < 0 || m.columnTimes[i]?.start !== m.lastBarT) return null;
  const colour = m.columns[i].dir === 'X' ? 'green' : 'red';
  const st = m.supertrend?.[i];
  if (!st || (st.dir !== 1 && st.dir !== -1)) return { key: `${i}:na`, text: `${colour} brick skipped: Supertrend not ready yet (too few bricks for its ATR)` };
  if ((st.dir === 1) === (m.columns[i].dir === 'X')) return null;
  const line = st.line !== null ? ` (${st.line.toFixed(2)})` : '';
  return {
    key: `${i}:${st.dir}`,
    text: `${colour} brick skipped: Supertrend line is ${st.dir === 1 ? 'up' : 'down'}${line} - a ${st.dir === 1 ? 'SELL needs a red brick with the line down' : 'BUY needs a green brick with the line up'}`,
  };
}
