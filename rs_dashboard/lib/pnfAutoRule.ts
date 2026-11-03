// Which signals each Renko AUTO rule trades, and how the rule reads in the UI: one place for both charts, so a new rule cannot be
// added to one chart's selection and missed on the other (a missed case would trade the plain N-brick signals under another name).
// Pure (tested in lib/pnfAutoRule.test.ts).
import type { PnfSignal } from './straddlePnf.ts';

export type AutoRule = 'nbrick' | 'trend' | 'twoback' | 'oneback';

/** The chart model with `signals` replaced by the selected rule's signals (the engine reads `model.signals`). */
export function modelForRule<M extends { signals: PnfSignal[]; trend: PnfSignal[]; twoBack: PnfSignal[]; oneBack: PnfSignal[] }>(rule: AutoRule, m: M): M {
  switch (rule) {
    case 'trend': return { ...m, signals: m.trend };
    case 'twoback': return { ...m, signals: m.twoBack };
    case 'oneback': return { ...m, signals: m.oneBack };
    case 'nbrick': return m;
  }
}

/** The tooltip text of the rule. `confirm`: the chart's N (bricks) for the N-brick rules. */
export function ruleText(rule: AutoRule, confirm: number): string {
  switch (rule) {
    case 'trend': return `Renko trend: SELL / BUY on every brick that completes ${confirm} same-colour brick(s), no reversal needed; exit on the first opposite brick, then re-enter the new direction`;
    case 'oneback': return 'One-back: 2+ bricks, 1-brick pullback, 2 bricks resume past the swing; stop one brick beyond the pullback';
    case 'twoback': return 'Two-back: 3+ bricks, 2-brick pullback, 3 bricks resume past the swing; stop one brick beyond the pullback';
    case 'nbrick': return `Renko SELL / BUY after ${confirm} confirming bricks, exit on the first opposite brick`;
  }
}
