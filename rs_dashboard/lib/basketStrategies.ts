// Predefined option strategy templates and pure payoff math for the Baskets page.
// Templates express strikes relative to ATM in units of the strike step
// (e.g. offset +2 on NIFTY with a 50-pt step = ATM + 100).

export type LegSide = 'B' | 'S';
export type OptionType = 'CE' | 'PE';

export interface TemplateLeg {
  side: LegSide;
  option: OptionType;
  offset: number;   // strike steps relative to ATM
  ratio: number;    // lots multiplier within the template
  expiryRole?: 'front' | 'far';  // omitted = front (the page's single main expiry)
}

export interface StrategyTemplate {
  key: string;
  name: string;
  legs: TemplateLeg[];
}

export type StrategyCategory = 'Bullish' | 'Bearish' | 'Range Bound' | 'Big Move' | 'Ratio Spreads' | 'Lizard' | 'Calendar';

export interface BasketLeg {
  id: string;
  side: LegSide;
  option: OptionType;
  strike: number;
  lots: number;
  type: 'MARKET' | 'LIMIT';
  price: string;   // empty = follow live LTP
  expiry: string;  // which expiry this leg trades on — 'front' (main) or 'far' (calendar/diagonal only)
}

export const STRATEGY_CATEGORIES: Record<StrategyCategory, StrategyTemplate[]> = {
  Bullish: [
    { key: 'buy-call',          name: 'Buy Call',               legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }] },
    { key: 'bull-call-spread',  name: 'Bull Call Spread',       legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }, { side: 'S', option: 'CE', offset: 4, ratio: 1 }] },
    { key: 'bull-put-spread',   name: 'Bull Put Spread',        legs: [{ side: 'S', option: 'PE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'long-synthetic',    name: 'Long Synthetic Future',  legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }, { side: 'S', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'range-forward',     name: 'Range Forward',          legs: [{ side: 'B', option: 'CE', offset: 4, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 1 }] },
  ],
  Bearish: [
    { key: 'buy-put',           name: 'Buy Put',                legs: [{ side: 'B', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'bear-put-spread',   name: 'Bear Put Spread',        legs: [{ side: 'B', option: 'PE', offset: 0, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'bear-call-spread',  name: 'Bear Call Spread',       legs: [{ side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'CE', offset: 4, ratio: 1 }] },
    { key: 'short-synthetic',   name: 'Short Synthetic Future', legs: [{ side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: 0, ratio: 1 }] },
  ],
  'Range Bound': [
    { key: 'short-straddle',    name: 'Short Straddle',         legs: [{ side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'S', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'short-strangle',    name: 'Short Strangle',         legs: [{ side: 'S', option: 'CE', offset: 4, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'iron-condor',       name: 'Iron Condor',            legs: [
      { side: 'S', option: 'CE', offset: 3, ratio: 1 }, { side: 'B', option: 'CE', offset: 6, ratio: 1 },
      { side: 'S', option: 'PE', offset: -3, ratio: 1 }, { side: 'B', option: 'PE', offset: -6, ratio: 1 },
    ] },
    { key: 'batman',            name: 'Batman',                 legs: [
      { side: 'B', option: 'CE', offset: 2, ratio: 1 }, { side: 'S', option: 'CE', offset: 4, ratio: 2 },
      { side: 'B', option: 'PE', offset: -2, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 2 },
    ] },
    { key: 'iron-butterfly',    name: 'Iron Butterfly',         legs: [
      { side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'CE', offset: 4, ratio: 1 },
      { side: 'S', option: 'PE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 1 },
    ] },
  ],
  'Big Move': [
    { key: 'long-straddle',     name: 'Long Straddle',          legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'long-strangle',     name: 'Long Strangle',          legs: [{ side: 'B', option: 'CE', offset: 4, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'long-iron-condor',  name: 'Long Iron Condor',       legs: [
      { side: 'B', option: 'CE', offset: 3, ratio: 1 }, { side: 'S', option: 'CE', offset: 6, ratio: 1 },
      { side: 'B', option: 'PE', offset: -3, ratio: 1 }, { side: 'S', option: 'PE', offset: -6, ratio: 1 },
    ] },
  ],
  'Ratio Spreads': [
    { key: 'call-ratio-back',        name: 'Call Ratio Backspread',        legs: [
      { side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'CE', offset: 4, ratio: 2 },
    ] },
    { key: 'put-broken-wing',        name: 'Put Broken Wing',              legs: [
      { side: 'B', option: 'PE', offset: -10, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 2 }, { side: 'B', option: 'PE', offset: -2, ratio: 1 },
    ] },
    { key: 'inverse-call-broken-wing', name: 'Inverse Call Broken Wing',   legs: [
      { side: 'S', option: 'CE', offset: 2, ratio: 1 }, { side: 'B', option: 'CE', offset: 4, ratio: 2 }, { side: 'S', option: 'CE', offset: 10, ratio: 1 },
    ] },
    { key: 'put-ratio-back',         name: 'Put Ratio Backspread',         legs: [
      { side: 'S', option: 'PE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 2 },
    ] },
    { key: 'call-broken-wing',       name: 'Call Broken Wing',             legs: [
      { side: 'B', option: 'CE', offset: 2, ratio: 1 }, { side: 'S', option: 'CE', offset: 4, ratio: 2 }, { side: 'B', option: 'CE', offset: 10, ratio: 1 },
    ] },
    { key: 'inverse-put-broken-wing', name: 'Inverse Put Broken Wing',     legs: [
      { side: 'S', option: 'PE', offset: -10, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 2 }, { side: 'S', option: 'PE', offset: -2, ratio: 1 },
    ] },
    { key: 'call-ratio-spread',      name: 'Call Ratio Spread',           legs: [
      { side: 'B', option: 'CE', offset: 0, ratio: 1 }, { side: 'S', option: 'CE', offset: 4, ratio: 2 },
    ] },
    { key: 'put-ratio-spread',       name: 'Put Ratio Spread',            legs: [
      { side: 'S', option: 'PE', offset: -4, ratio: 2 }, { side: 'B', option: 'PE', offset: 0, ratio: 1 },
    ] },
  ],
  Lizard: [
    { key: 'jade-lizard',         name: 'Jade Lizard',          legs: [
      { side: 'S', option: 'PE', offset: -4, ratio: 1 }, { side: 'S', option: 'CE', offset: 4, ratio: 1 }, { side: 'B', option: 'CE', offset: 8, ratio: 1 },
    ] },
    { key: 'reverse-jade-lizard', name: 'Reverse Jade Lizard', legs: [
      { side: 'B', option: 'PE', offset: -8, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 1 }, { side: 'S', option: 'CE', offset: 4, ratio: 1 },
    ] },
  ],
  Calendar: [
    { key: 'calendar-call-spread', name: 'Calendar Call Spread', legs: [
      { side: 'S', option: 'CE', offset: 0, ratio: 1, expiryRole: 'front' },
      { side: 'B', option: 'CE', offset: 0, ratio: 1, expiryRole: 'far' },
    ] },
    { key: 'calendar-put-spread',  name: 'Calendar Put Spread',  legs: [
      { side: 'S', option: 'PE', offset: 0, ratio: 1, expiryRole: 'front' },
      { side: 'B', option: 'PE', offset: 0, ratio: 1, expiryRole: 'far' },
    ] },
    { key: 'diagonal-call-spread', name: 'Diagonal Call Spread', legs: [
      { side: 'S', option: 'CE', offset: 4, ratio: 1, expiryRole: 'front' },
      { side: 'B', option: 'CE', offset: 0, ratio: 1, expiryRole: 'far' },
    ] },
    { key: 'diagonal-put-spread',  name: 'Diagonal Put Spread',  legs: [
      { side: 'S', option: 'PE', offset: -4, ratio: 1, expiryRole: 'front' },
      { side: 'B', option: 'PE', offset: 0, ratio: 1, expiryRole: 'far' },
    ] },
  ],
};

// ─── Payoff math ─────────────────────────────────────────────────

/** A fully materialised basket leg. `qty` is in units (lots × lotSize). */
export interface PayoffLeg {
  side: LegSide;
  option: OptionType;
  strike: number;
  premium: number;  // per-unit premium
  qty: number;      // units
}

export function legPnlAtExpiry(leg: PayoffLeg, underlying: number): number {
  const intrinsic = leg.option === 'CE'
    ? Math.max(0, underlying - leg.strike)
    : Math.max(0, leg.strike - underlying);
  const perUnit = leg.side === 'B' ? intrinsic - leg.premium : leg.premium - intrinsic;
  return perUnit * leg.qty;
}

export interface PayoffResult {
  points: { x: number; y: number }[];
  breakevens: number[];
  maxProfit: number;        // ignored when maxProfitUnlimited
  maxLoss: number;          // negative number; ignored when maxLossUnlimited
  maxProfitUnlimited: boolean;
  maxLossUnlimited: boolean;
  /** Direction in which the displayed curve continues beyond the right edge (upside). */
  rightWing: 'profit' | 'loss' | null;
  /** Direction in which the displayed curve continues beyond the left edge (downside). Never 'profit' — a net long put's profit is capped because spot can't go below 0, so there's no downside-unlimited-profit case. */
  leftWing: 'loss' | null;
  netPremium: number;       // >0 net credit received, <0 net debit paid (total ₹)
}

export function computePayoff(legs: PayoffLeg[], lo: number, hi: number, samples = 240): PayoffResult {
  // Sample a uniform grid plus every strike, so the kinks (where max
  // profit/loss actually sit) are evaluated exactly, not interpolated past.
  const xs = new Set<number>();
  const step = (hi - lo) / Math.max(1, samples - 1);
  for (let i = 0; i < samples; i++) xs.add(lo + i * step);
  for (const l of legs) if (l.strike >= lo && l.strike <= hi) xs.add(l.strike);
  const points = [...xs].sort((a, b) => a - b).map(x => ({
    x, y: legs.reduce((sum, l) => sum + legPnlAtExpiry(l, x), 0),
  }));

  const breakevens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.y < 0 && b.y >= 0) || (a.y >= 0 && b.y < 0)) {
      const t = a.y === b.y ? 0 : -a.y / (b.y - a.y);
      breakevens.push(a.x + t * (b.x - a.x));
    }
  }

  // "Unlimited" is a position fact, not a curve-shape guess: derive it from net
  // signed quantity per option type, not from the sampled curve's slope (which
  // is always finite by construction and would silently report a bounded number
  // for a naked short). Positive = net short that option type.
  const netCallQty = legs.filter(l => l.option === 'CE').reduce((s, l) => s + (l.side === 'S' ? l.qty : -l.qty), 0);
  const netPutQty  = legs.filter(l => l.option === 'PE').reduce((s, l) => s + (l.side === 'S' ? l.qty : -l.qty), 0);

  const upsideUnlimitedLoss    = netCallQty > 0;
  const upsideUnlimitedProfit  = netCallQty < 0;
  // The underlying's floor is 0, so a net long put's profit is capped — there is
  // no downside-unlimited-profit case, only downside-unlimited-loss (net short puts).
  const downsideUnlimitedLoss  = netPutQty > 0;

  const maxProfitUnlimited = upsideUnlimitedProfit;
  const maxLossUnlimited   = upsideUnlimitedLoss || downsideUnlimitedLoss;
  const rightWing: 'profit' | 'loss' | null = upsideUnlimitedProfit ? 'profit' : upsideUnlimitedLoss ? 'loss' : null;
  const leftWing: 'loss' | null = downsideUnlimitedLoss ? 'loss' : null;

  // When a side is bounded (not flagged unlimited above), its true cap sits
  // beyond the plotted [lo, hi] window — at spot->0 downside, or past the
  // outermost strike upside (payoff is flat out there) — not just whatever the
  // sampled points happen to cover. Only pull those boundary values in when
  // that side isn't already unlimited, so a genuinely unbounded side keeps
  // reporting Infinity/-Infinity rather than a misleadingly finite number.
  const pnlAt = (x: number) => legs.reduce((sum, l) => sum + legPnlAtExpiry(l, x), 0);
  const strikes = legs.map(l => l.strike);
  const far = strikes.length ? Math.max(hi, ...strikes) * 2 + 1000 : hi;
  const candidates = points.map(p => p.y);
  if (!maxProfitUnlimited && !upsideUnlimitedLoss) candidates.push(pnlAt(far));
  if (!downsideUnlimitedLoss) candidates.push(pnlAt(0));

  let maxProfit = Math.max(...candidates);
  let maxLoss   = Math.min(...candidates);
  if (maxProfitUnlimited) maxProfit = Infinity;
  if (maxLossUnlimited) maxLoss = -Infinity;

  const netPremium = legs.reduce((sum, l) =>
    sum + (l.side === 'S' ? l.premium : -l.premium) * l.qty, 0);

  return { points, breakevens, maxProfit, maxLoss, maxProfitUnlimited, maxLossUnlimited, rightWing, leftWing, netPremium };
}

/** Nearest listed strike to a target price. */
export function nearestStrike(strikes: number[], target: number): number | null {
  if (!strikes.length) return null;
  return strikes.reduce((best, s) => Math.abs(s - target) < Math.abs(best - target) ? s : best);
}

/** Typical gap between adjacent strikes (median of diffs, robust to gaps). */
export function strikeStep(strikes: number[]): number {
  if (strikes.length < 2) return 50;
  const diffs = [];
  for (let i = 1; i < strikes.length; i++) diffs.push(strikes[i] - strikes[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || 50;
}

/** Calendar days until an expiry string, "2026-07-21" or "21-Jul-2026". 0 on the expiry date itself. */
export function daysToExpiry(expiry: string, now = new Date()): number | null {
  let y = 0, mi = -1, d = 0;
  const iso = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = expiry.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (iso) {
    y = Number(iso[1]); mi = Number(iso[2]) - 1; d = Number(iso[3]);
  } else if (dmy) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    y = Number(dmy[3]); mi = months.indexOf(dmy[2].toLowerCase()); d = Number(dmy[1]);
  }
  if (mi < 0) return null;
  const startOfDay = (dt: Date) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diff = startOfDay(new Date(y, mi, d)).getTime() - startOfDay(now).getTime();
  return Math.max(0, Math.round(diff / 86_400_000));
}
