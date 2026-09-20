/**
 * Pure maths behind the Option Cube page (3D scatter of price change %,
 * OI change % and IV for one expiry). No React, no fetching — unit-tested.
 *
 * Why these choices (see the page's "How to read" panel for the user-facing
 * version):
 *  - Price change and OI change are day-over-day, against `previous_close_price`
 *    and `previous_oi` (Dhan's field is spelled `_price` on the close only).
 *  - Percentage changes explode on tiny bases (a ₹0.5 premium doubling, an OI
 *    of 300 -> 900), so illiquid strikes are filtered and the plot clamps
 *    outliers to the 2nd/98th percentile instead of letting one point squash
 *    the other 100 into a line.
 *  - Raw IV is dominated by the smile (wings are always "high IV"), so IV is
 *    also expressed as a residual against the neighbouring strikes on the same
 *    side. Rich residual = expensive vs its neighbours (sell-favourable),
 *    cheap residual = buy-favourable.
 *  - Scores use percentile ranks within the filtered set, so they are
 *    comparable across underlyings and immune to a single extreme value.
 */

export interface OcSide {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  implied_volatility?: number;
  greeks?: { iv?: number; delta?: number };
}

export interface OcEntry { ce?: OcSide; pe?: OcSide }

export type Side = 'CE' | 'PE';
export type Signal = 'Long buildup' | 'Short buildup' | 'Short covering' | 'Long unwinding';
export type Goal = 'buy' | 'sell';

export type Moneyness = 'ITM' | 'ATM' | 'OTM';

export interface ScatterPoint {
  key: string;            // "24500CE"
  strike: number;
  side: Side;
  ltp: number;
  priceChg: number;       // % vs previous close
  oi: number;
  oiChg: number;          // % vs previous OI
  volume: number;
  iv: number;             // %
  ivResidual: number;     // iv - mean(iv of neighbouring strikes, same side)
  delta: number | null;   // signed, as reported
  distPct: number;        // (strike - spot) / spot * 100
  moneyness: Moneyness;   // ITM | ATM | OTM
  signal: Signal;
  buyScore: number | null;   // 0-100, null = fails the delta gate for buying
  sellScore: number | null;  // 0-100, null = fails the delta gate for selling
}

export function getMoneyness(strike: number, side: Side, spot: number, step = 50): Moneyness {
  if (Math.abs(strike - spot) <= step * 0.5) return 'ATM';
  if (side === 'CE') return strike < spot ? 'ITM' : 'OTM';
  return strike > spot ? 'ITM' : 'OTM';
}

export interface ChainSummary {
  spot: number;
  atmStrike: number;
  totalCeOi: number;
  totalPeOi: number;
  pcr: number;
  maxCeOiStrike: number;
  maxPeOiStrike: number;
  ceCount: number;
  peCount: number;
}

/**
 * Chain-wide headline numbers (PCR, total OI, max-OI strikes, ATM).
 * Computed from the raw chain, NOT from the plotted points: those are cut by
 * the strike window / Min OI / Min ₹ filters and by rows with no previous-OI
 * base, so a PCR taken from them describes the filter, not the market.
 */
export function computeChainSummary(oc: Record<string, OcEntry>, spot: number): ChainSummary | null {
  if (!(spot > 0)) return null;
  let totalCeOi = 0;
  let totalPeOi = 0;
  let maxCeOi = 0;
  let maxPeOi = 0;
  let maxCeOiStrike = 0;
  let maxPeOiStrike = 0;
  let ceCount = 0;
  let peCount = 0;
  let atmStrike = 0;
  let minDiff = Infinity;

  for (const [key, e] of Object.entries(oc)) {
    const strike = Number(key);
    if (!Number.isFinite(strike)) continue;
    const diff = Math.abs(strike - spot);
    if (diff < minDiff) { minDiff = diff; atmStrike = strike; }
    const ceOi = e.ce?.oi ?? 0;
    const peOi = e.pe?.oi ?? 0;
    if (ceOi > 0) {
      ceCount++;
      totalCeOi += ceOi;
      if (ceOi > maxCeOi) { maxCeOi = ceOi; maxCeOiStrike = strike; }
    }
    if (peOi > 0) {
      peCount++;
      totalPeOi += peOi;
      if (peOi > maxPeOi) { maxPeOi = peOi; maxPeOiStrike = strike; }
    }
  }
  if (!atmStrike) return null;

  return {
    spot,
    atmStrike,
    totalCeOi,
    totalPeOi,
    pcr: totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(2)) : 0,
    maxCeOiStrike,
    maxPeOiStrike,
    ceCount,
    peCount,
  };
}

export interface BuildOptions {
  spot: number;
  /** Keep strikes within this many strikes of ATM each way. 0 = all. */
  strikeWindow: number;
  /** Drop points whose OI is below this % of the chain's largest OI. */
  minOiPct: number;
  /** Drop points whose premium is below this many rupees. */
  minLtp: number;
}

const NEIGHBOURS = 2; // strikes each side used for the IV residual

export function classify(priceChg: number, oiChg: number): Signal {
  if (priceChg >= 0) return oiChg >= 0 ? 'Long buildup' : 'Short covering';
  return oiChg >= 0 ? 'Short buildup' : 'Long unwinding';
}

/** Percentile rank in [0,1] of each value within `values` (ties share the mean rank). */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0.5);
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1].v === order[i].v) j++;
    const rank = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[order[k].i] = rank;
    i = j + 1;
  }
  return out;
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function ivOf(s: OcSide | undefined): number {
  const v = s?.implied_volatility ?? s?.greeks?.iv ?? 0;
  return Number.isFinite(v) ? v : 0;
}

// Delta gates: buying wants real sensitivity but not deep-ITM capital lock-up;
// selling wants OTM/near-ATM premium with room for the underlying to be wrong.
const BUY_DELTA = [0.2, 0.7] as const;
const SELL_DELTA = [0.05, 0.4] as const;

export function buildPoints(oc: Record<string, OcEntry>, opts: BuildOptions): ScatterPoint[] {
  const { spot } = opts;
  if (!(spot > 0)) return [];

  const strikes = Object.keys(oc).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!strikes.length) return [];

  let atmIdx = 0;
  for (let i = 1; i < strikes.length; i++) {
    if (Math.abs(strikes[i] - spot) < Math.abs(strikes[atmIdx] - spot)) atmIdx = i;
  }
  // Grid spacing at ATM (wings can be wider on some underlyings, so strikes[1]-strikes[0] is unsafe).
  const strikeStep = strikes.length > 1
    ? Math.abs(strikes[Math.min(atmIdx + 1, strikes.length - 1)] - strikes[Math.min(atmIdx + 1, strikes.length - 1) - 1])
    : 50;
  const lo = opts.strikeWindow > 0 ? Math.max(0, atmIdx - opts.strikeWindow) : 0;
  const hi = opts.strikeWindow > 0 ? Math.min(strikes.length - 1, atmIdx + opts.strikeWindow) : strikes.length - 1;

  // IV residual is computed on the full chain so window edges still have neighbours.
  const ivBySide: Record<Side, Map<number, number>> = { CE: new Map(), PE: new Map() };
  let maxOi = 0;
  for (const k of strikes) {
    const e = oc[String(k)] ?? oc[k.toFixed(6)];
    for (const side of ['CE', 'PE'] as const) {
      const s = side === 'CE' ? e?.ce : e?.pe;
      const iv = ivOf(s);
      if (iv > 0) ivBySide[side].set(k, iv);
      if ((s?.oi ?? 0) > maxOi) maxOi = s?.oi ?? 0;
    }
  }
  const idxOf = new Map(strikes.map((k, i) => [k, i] as const));
  const residual = (side: Side, k: number, iv: number): number => {
    const i = idxOf.get(k)!;
    const ns: number[] = [];
    for (let d = -NEIGHBOURS; d <= NEIGHBOURS; d++) {
      if (d === 0) continue;
      const nk = strikes[i + d];
      const v = nk === undefined ? undefined : ivBySide[side].get(nk);
      if (v !== undefined) ns.push(v);
    }
    return ns.length >= 2 ? iv - ns.reduce((a, b) => a + b, 0) / ns.length : 0;
  };

  const pts: ScatterPoint[] = [];
  for (let i = lo; i <= hi; i++) {
    const k = strikes[i];
    const e = oc[String(k)] ?? oc[k.toFixed(6)];
    for (const side of ['CE', 'PE'] as const) {
      const s = side === 'CE' ? e?.ce : e?.pe;
      if (!s) continue;
      const ltp = s.last_price ?? 0;
      const prevClose = s.previous_close_price ?? 0;
      const oi = s.oi ?? 0;
      const prevOi = s.previous_oi ?? 0;
      const iv = ivOf(s);
      // Percent change is undefined without a base; these can't be plotted honestly.
      if (ltp <= 0 || prevClose <= 0 || prevOi <= 0 || oi <= 0 || iv <= 0) continue;
      if (ltp < opts.minLtp) continue;
      if (maxOi > 0 && (oi / maxOi) * 100 < opts.minOiPct) continue;

      const priceChg = ((ltp - prevClose) / prevClose) * 100;
      const oiChg = ((oi - prevOi) / prevOi) * 100;
      pts.push({
        key: `${k}${side}`,
        strike: k,
        side,
        ltp,
        priceChg,
        oi,
        oiChg,
        volume: s.volume ?? 0,
        iv,
        ivResidual: residual(side, k, iv),
        delta: typeof s.greeks?.delta === 'number' ? s.greeks.delta : null,
        distPct: ((k - spot) / spot) * 100,
        moneyness: getMoneyness(k, side, spot, strikeStep),
        signal: classify(priceChg, oiChg),
        buyScore: null,
        sellScore: null,
      });
    }
  }

  scorePoints(pts);
  return pts;
}

/** Fills buyScore / sellScore in place. */
export function scorePoints(pts: ScatterPoint[]): void {
  if (!pts.length) return;
  const rPrice = percentileRanks(pts.map(p => p.priceChg));
  const rOi = percentileRanks(pts.map(p => p.oiChg));
  const rIv = percentileRanks(pts.map(p => p.ivResidual));
  const inBand = (d: number | null, [a, b]: readonly [number, number]) =>
    d === null || (Math.abs(d) >= a && Math.abs(d) <= b);

  pts.forEach((p, i) => {
    // Buy: momentum in premium, fresh longs, and not paying up for IV vs neighbours.
    p.buyScore = inBand(p.delta, BUY_DELTA)
      ? Math.round(100 * (0.4 * rPrice[i] + 0.35 * rOi[i] + 0.25 * (1 - rIv[i])))
      : null;
    // Sell: premium bleeding while OI builds (writers), and rich IV to harvest.
    p.sellScore = inBand(p.delta, SELL_DELTA)
      ? Math.round(100 * (0.35 * (1 - rPrice[i]) + 0.35 * rOi[i] + 0.3 * rIv[i]))
      : null;
  });
}

export interface AxisClip { lo: number; hi: number; clipped: number }

/** 2nd–98th percentile envelope (padded) so a few outliers don't flatten the cloud. */
export function clipRange(values: number[], enabled: boolean): AxisClip {
  if (!values.length) return { lo: -1, hi: 1, clipped: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!enabled) return { lo: min, hi: max, clipped: 0 };
  const lo = quantile(values, 0.02);
  const hi = quantile(values, 0.98);
  const clipped = values.filter(v => v < lo || v > hi).length;
  return { lo, hi, clipped };
}

export function topByGoal(pts: ScatterPoint[], goal: Goal, n: number): ScatterPoint[] {
  const score = (p: ScatterPoint) => (goal === 'buy' ? p.buyScore : p.sellScore);
  return pts
    .filter(p => score(p) !== null)
    .sort((a, b) => (score(b) as number) - (score(a) as number))
    .slice(0, n);
}

// ─── Directional bias ──────────────────────────────────────────────────────
//
// The four buildup signals describe the OPTION's own price/OI. What they imply
// for the UNDERLYING depends on the side: writing calls is bearish, writing puts
// is bullish, buying puts is bearish, buying calls is bullish. Strong = fresh
// positions (OI up); weak = positions being closed (OI down), which carries
// roughly half the conviction.

export type BiasDir = 'bearish' | 'bullish';
export interface DirectionalBias { dir: BiasDir; strength: number }

const BIAS: Record<Side, Record<Signal, { dir: BiasDir; weak: boolean }>> = {
  CE: {
    'Short buildup':  { dir: 'bearish', weak: false }, // call writing
    'Long unwinding': { dir: 'bearish', weak: true },  // call longs bailing
    'Long buildup':   { dir: 'bullish', weak: false }, // call buying
    'Short covering': { dir: 'bullish', weak: true },  // call writers bailing
  },
  PE: {
    'Long buildup':   { dir: 'bearish', weak: false }, // put buying
    'Short covering': { dir: 'bearish', weak: true },  // put writers bailing
    'Short buildup':  { dir: 'bullish', weak: false }, // put writing
    'Long unwinding': { dir: 'bullish', weak: true },  // put longs bailing
  },
};

/** Premium move that counts as a full-strength signal, and the OI surge likewise. */
const FULL_PRICE_MOVE_PCT = 60;
const FULL_OI_SURGE_PCT = 120;

export function directionalBias(p: Pick<ScatterPoint, 'side' | 'signal' | 'priceChg' | 'oiChg'>): DirectionalBias {
  const { dir, weak } = BIAS[p.side][p.signal];
  const price = Math.min(1, Math.abs(p.priceChg) / FULL_PRICE_MOVE_PCT);
  const oi = Math.min(1, Math.abs(p.oiChg) / FULL_OI_SURGE_PCT);
  const raw = (price * 0.5 + oi * 0.5) * 100 * (weak ? 0.5 : 1);
  return { dir, strength: Math.round(Math.min(100, Math.max(5, raw))) };
}

/** 0–100 heat for the "Bearish" colour mode: bearish points by strength, everything else 0. */
export function bearishIntensity(p: Pick<ScatterPoint, 'side' | 'signal' | 'priceChg' | 'oiChg'>): number {
  const b = directionalBias(p);
  return b.dir === 'bearish' ? b.strength : 0;
}

// ─── Data-date chip ────────────────────────────────────────────────────────

const IST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
});

/**
 * Date (YYYY-MM-DD, IST) of the session the live chain belongs to: today once the
 * market has opened (09:15 IST) on a weekday, otherwise the previous weekday.
 * There is no holiday calendar, so a weekday holiday still reports that weekday —
 * the chain has no timestamp of its own to correct it with.
 */
export function lastSessionDate(now: Date = new Date()): string {
  const g = Object.fromEntries(IST_PARTS.formatToParts(now).map(x => [x.type, x.value]));
  const minutes = (Number(g.hour) % 24) * 60 + Number(g.minute);
  let back = 0;
  if (g.weekday === 'Sat') back = 1;
  else if (g.weekday === 'Sun') back = 2;
  else if (minutes < 9 * 60 + 15) back = g.weekday === 'Mon' ? 3 : 1;
  const d = new Date(Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day) - back));
  return d.toISOString().slice(0, 10);
}

// ─── Expiry picker ─────────────────────────────────────────────────────────

export interface ExpiryOption {
  value: string;                 // YYYY-MM-DD, what the API takes
  label: string;                 // "22 Sep 2026 · Tue · 2d · Weekly"
  dte: number;                   // calendar days to expiry (0 = expiry day)
  kind: 'Weekly' | 'Monthly';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function utcDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Describe each expiry for the picker. `today` is the IST calendar date (YYYY-MM-DD).
 * An expiry is "Monthly" when it is the last one listed in its calendar month — the
 * exchange lists weeklies only for the near months, so far-dated ones are all monthly.
 */
export function describeExpiries(expiries: string[], today: string): ExpiryOption[] {
  const lastInMonth = new Map<string, string>();
  for (const e of expiries) {
    const ym = e.slice(0, 7);
    const cur = lastInMonth.get(ym);
    if (!cur || e > cur) lastInMonth.set(ym, e);
  }
  return expiries.map(value => {
    const t = utcDay(value);
    const dt = new Date(t);
    const dte = Math.round((t - utcDay(today)) / 86_400_000);
    const kind = lastInMonth.get(value.slice(0, 7)) === value ? 'Monthly' : 'Weekly';
    const when = dte === 0 ? 'expiry day' : `${dte}d`;
    const label = `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()} · ${DAYS[dt.getUTCDay()]} · ${when} · ${kind}`;
    return { value, label, dte, kind };
  });
}
