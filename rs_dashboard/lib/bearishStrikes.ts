/**
 * Bearish-strike signal for option sellers: an option's own price is below its
 * Supertrend(10,2) line, below its session VWAP and below EMA20.
 *
 * Pure module (no I/O). Indicator maths is reused from lib/indicators.ts (the repo's single
 * TypeScript Supertrend/EMA — see the dhan-indicators skill); only the session VWAP is new.
 *
 * Rules that cost a bug elsewhere:
 *  - Signals read CLOSED bars only. The forming bar repaints, so it never decides the flag.
 *  - Warm-up values are null = "no signal", never "bearish" and never "not bearish by a hair".
 *  - VWAP resets each IST session and needs cumulative volume > 0 (illiquid strikes print
 *    zero-volume bars; a 0/0 VWAP must not read as "price below VWAP").
 */
import { emaSmaSeeded, supertrendSeries } from './indicators.ts';
import { resampleBars, type Bar } from './volumeProfile.ts';

export const ST_PERIOD = 10;
export const ST_MULT = 2;
export const EMA_PERIOD = 20;

export type Timeframe = 1 | 3 | 5;

export interface Indicators {
  /** Last closed bar. */
  close: number | null;
  stLine: number | null;
  stDir: 1 | -1 | null;
  vwap: number | null;
  ema: number | null;
  barTime: string | null;
  barsUsed: number;
}

export interface BearishSignal extends Indicators {
  /** true / false once every indicator is warm; null while any is still warming up. */
  bearish: boolean | null;
  /** Which of the three conditions hold on the closed bar (null = indicator not ready). */
  below: { st: boolean | null; vwap: boolean | null; ema: boolean | null };
}

const dayOf = (t: string): string => t.slice(0, 10);

/** Session VWAP (typical price x volume), reset on each IST date. null until cumulative volume > 0. */
export function sessionVwap(bars: Bar[]): (number | null)[] {
  const out: (number | null)[] = [];
  let day = '';
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const d = dayOf(b.t);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const v = Number.isFinite(b.v) && b.v > 0 ? b.v : 0;
    pv += ((b.h + b.l + b.c) / 3) * v;
    vol += v;
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

/** Drop the still-forming last bar when its bucket has not finished yet. */
export function closedBarsOnly(bars: Bar[], minutes: number, nowIstMs: number): Bar[] {
  if (!bars.length) return bars;
  const last = bars[bars.length - 1];
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(last.t);
  if (!m) return bars;
  // IST-naive stamp read as UTC so it compares with an IST-shifted "now" on the same axis.
  const startMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return startMs + minutes * 60_000 <= nowIstMs ? bars : bars.slice(0, -1);
}

export function istNowMs(now = Date.now()): number {
  return now + 5.5 * 3600_000;
}

/** Indicators on the last CLOSED bar of `bars1m` resampled to `tf` minutes. */
export function computeIndicators(bars1m: Bar[], tf: Timeframe, nowIstMs: number): Indicators {
  const empty: Indicators = { close: null, stLine: null, stDir: null, vwap: null, ema: null, barTime: null, barsUsed: 0 };
  if (!bars1m.length) return empty;
  const bars = closedBarsOnly(resampleBars(bars1m, tf), tf, nowIstMs);
  if (!bars.length) return empty;

  const st = supertrendSeries(bars.map((b) => ({ high: b.h, low: b.l, close: b.c })), ST_PERIOD, ST_MULT);
  const ema = emaSmaSeeded(bars.map((b) => b.c), EMA_PERIOD);
  const vw = sessionVwap(bars);
  const i = bars.length - 1;
  return {
    close: bars[i].c,
    stLine: st[i].line,
    stDir: st[i].dir,
    vwap: vw[i],
    ema: ema[i],
    barTime: bars[i].t,
    barsUsed: bars.length,
  };
}

/** Bearish = close below ST line (ST direction bearish), below VWAP and below EMA20. */
export function evaluateBearish(ind: Indicators): BearishSignal {
  const stBelow = ind.close == null || ind.stLine == null || ind.stDir == null
    ? null : (ind.stDir === -1 && ind.close < ind.stLine);
  const vwBelow = ind.close == null || ind.vwap == null ? null : ind.close < ind.vwap;
  const emaBelow = ind.close == null || ind.ema == null ? null : ind.close < ind.ema;
  const ready = stBelow != null && vwBelow != null && emaBelow != null;
  return {
    ...ind,
    bearish: ready ? (stBelow && vwBelow && emaBelow) : null,
    below: { st: stBelow, vwap: vwBelow, ema: emaBelow },
  };
}

/** % of price a level sits above the live price — positive means price is below the level. */
export function pctBelow(level: number | null, price: number | null): number | null {
  if (level == null || price == null || !(level > 0)) return null;
  return ((level - price) / level) * 100;
}

/** One-minute OHLC built from LTP prints only (WS high/low are day-level, so they cannot build a bar). */
export type LiveMinutes = Map<string, { o: number; h: number; l: number; c: number }>;

export function minuteStamp(nowIstMs: number): string {
  const d = new Date(nowIstMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

/** Fold one LTP print into the minute accumulator. Ignores non-positive prices. */
export function recordTick(live: LiveMinutes, ltp: number, nowIstMs: number): void {
  if (!(ltp > 0)) return;
  const t = minuteStamp(nowIstMs);
  const cur = live.get(t);
  if (!cur) live.set(t, { o: ltp, h: ltp, l: ltp, c: ltp });
  else { cur.h = Math.max(cur.h, ltp); cur.l = Math.min(cur.l, ltp); cur.c = ltp; }
}

/**
 * Backfilled 1-minute bars (volume-bearing) + LTP-built minutes. The backfill is only refreshed once a
 * minute, so minutes that closed since the last fetch exist only in `live`; they are appended with zero
 * volume (VWAP ignores them). A minute present in both keeps the backfill's O/volume and extends H/L/C
 * with the live prints. Includes the forming minute; computeIndicators drops it as not yet closed.
 */
export function mergeBars(api: Bar[], live: LiveMinutes): Bar[] {
  const out = api.map((b) => ({ ...b }));
  const idx = new Map(out.map((b, i) => [b.t, i]));
  const lastApi = out.length ? out[out.length - 1].t : '';
  for (const t of [...live.keys()].sort()) {
    const m = live.get(t)!;
    const i = idx.get(t);
    if (i != null) {
      const b = out[i];
      b.h = Math.max(b.h, m.h); b.l = Math.min(b.l, m.l); b.c = m.c;
    } else if (t > lastApi) {
      out.push({ t, o: m.o, h: m.h, l: m.l, c: m.c, v: 0 });
    }
  }
  return out;
}

/**
 * How the OI buildup label (from the live bridge, vs the previous day) sits against a BEARISH price signal:
 *  - 'confirm'  SB short buildup (price down, OI up: writers adding) or LU long unwinding (price down, OI down:
 *               longs leaving) — the move is backed by positioning, what a seller wants to see;
 *  - 'conflict' LB long buildup (price up, OI up: fresh longs) — the day's positioning disagrees with the bearish bars;
 *  - null       anything else (SC short covering, no label) or the signal is not bearish, so there is nothing to compare.
 * The labels are the bridge's own (live_options_ws._classify_buildup); they are never re-derived here.
 */
export type OiView = 'confirm' | 'conflict' | null;
export type OiMode = 'any' | 'confirm' | 'no-conflict';

export function oiView(buildup: string | null | undefined, sig: Pick<BearishSignal, 'bearish'>): OiView {
  if (sig.bearish !== true) return null;
  if (buildup === 'SB' || buildup === 'LU') return 'confirm';
  if (buildup === 'LB') return 'conflict';
  return null;
}

export interface StrikeFilters {
  side: 'BOTH' | 'CE' | 'PE';
  minLtp: number;
  minOiLots: number;
  minVolLots: number;
  maxSpreadPct: number;      // 0 = off
  otmOnly: boolean;
  /** Each ticked condition must hold on the closed bar (null = still warming up = fails). None ticked = no signal filter. */
  requireSt: boolean;
  requireVwap: boolean;
  requireEma: boolean;
  /** 'confirm' keeps only bearish rows backed by SB/LU; 'no-conflict' drops bearish rows with LB. */
  oiMode?: OiMode;
}

export function passesFilters(
  row: { option: 'CE' | 'PE'; strike: number; ltp: number; oi: number; volume: number; spreadPct: number | null; sig: BearishSignal; buildup?: string },
  spot: number,
  lotSize: number,
  f: StrikeFilters,
): boolean {
  if (f.side !== 'BOTH' && row.option !== f.side) return false;
  if (row.ltp < f.minLtp) return false;
  const lot = lotSize > 0 ? lotSize : 1;
  if (row.oi / lot < f.minOiLots) return false;
  if (row.volume / lot < f.minVolLots) return false;
  if (f.maxSpreadPct > 0 && row.spreadPct != null && row.spreadPct > f.maxSpreadPct) return false;
  if (f.otmOnly && spot > 0) {
    if (row.option === 'CE' && row.strike <= spot) return false;
    if (row.option === 'PE' && row.strike >= spot) return false;
  }
  if (f.requireSt && row.sig.below.st !== true) return false;
  if (f.requireVwap && row.sig.below.vwap !== true) return false;
  if (f.requireEma && row.sig.below.ema !== true) return false;
  const oi = oiView(row.buildup, row.sig);
  if (f.oiMode === 'confirm' && oi !== 'confirm') return false;
  if (f.oiMode === 'no-conflict' && oi === 'conflict') return false;
  return true;
}
