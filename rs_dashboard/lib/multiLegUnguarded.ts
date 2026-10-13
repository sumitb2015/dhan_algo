// Multi-Leg Focus: which open SHORT legs have nothing that will exit them.
// Pure rules only. A short is "guarded" when at least one of these will act on it today:
//  - its own leg SL,
//  - an armed strategy-level SL,
//  - an armed spot trigger that EXITS (an ALERT does not exit) covering its side,
//  - an armed Greek band set to EXIT_ALL,
//  - an armed max-loss alarm with exitAtMaxLoss and a loss limit.
// An armed guard stamped with another day is not counted: expireStaleGuards disarms it on the next tick.
// Hedges (BUY legs), futures and legs with no fill are never reported.

import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The open short option legs of `basket` that nothing will exit. `today` is the IST day (YYYY-MM-DD). */
export function unguardedShorts(basket: MultiLegBasket, today: string): MultiLegLeg[] {
  const g = basket.guards;
  const live = (x: { armed: boolean; armedDay?: string }) => x.armed && x.armedDay === today;

  const basketWide =
    (basket.riskConfig?.armed === true && pos(basket.riskConfig.slValue))
    || (g?.greekBands ?? []).some(b => live(b) && b.action === 'EXIT_ALL' && (Number.isFinite(b.min) || Number.isFinite(b.max)))
    || (!!g?.alarm && live(g.alarm) && g.alarm.exitAtMaxLoss === true && pos(g.alarm.maxLoss));

  const triggers = (g?.spotTriggers ?? []).filter(t => live(t) && t.action !== 'ALERT' && pos(t.level));
  const exitAll = triggers.some(t => t.action === 'EXIT_ALL');
  const exitSides = new Set(triggers.flatMap(t => (t.action === 'EXIT_CE' ? ['CE'] : t.action === 'EXIT_PE' ? ['PE'] : [])));
  // autoLegRule is deliberately ignored: it is stamped onto a leg's own `sl` when the leg is placed (withAutoLegRisk) and
  // the monitor only evaluates `leg.sl`, so a rule enabled after a leg was placed protects nothing.

  return basket.legs.filter(l => {
    if (l.side !== 'S' || l.status !== 'OPEN' || l.option === 'FUT') return false;
    if (!((l.fill?.qty ?? 0) > 0)) return false;
    if (basketWide || exitAll || exitSides.has(l.option) || pos(l.sl)) return false;
    return true;
  });
}
