import { sessionOf, type Bar } from './straddlePnf.ts';

/**
 * Calibrated baseline 30-minute block sizes (pts) for major indices, commodities, and equities.
 * Derived from historical Daily ATR divided by session blocks (12 blocks for a 6h NSE session).
 * Formula: Daily ATR / 12 (NIFTY 100/12 = 8.33 -> 8.35; SENSEX 350/12 = 29.16 -> 29.2; BANKNIFTY 360/12 = 30.0).
 */
export const INDEX_BASELINE_BLOCKS: Record<string, number> = {
  NIFTY: 8.35,
  BANKNIFTY: 30.0,
  SENSEX: 29.2,
  FINNIFTY: 10.0,
  MIDCPNIFTY: 6.7,
  BANKEX: 32.0,
  // MCX Commodities (14-hour session: 28 blocks for 30m, or 12 blocks for active 6h block)
  CRUDEOIL: 16.0,
  CRUDEOILM: 16.0,
  NATURALGAS: 0.5,
  GOLD: 25.0,
  GOLDM: 25.0,
  SILVER: 50.0,
  SILVERM: 50.0,
};

/** Returns the calibrated baseline block size in points for a given symbol. */
export function indexBaselineBlock(symbol: string): number {
  const s = symbol.toUpperCase().trim();
  if (INDEX_BASELINE_BLOCKS[s] !== undefined) return INDEX_BASELINE_BLOCKS[s];
  // Check if symbol contains known roots (e.g., option or future like 'CRUDEOILM26DEC...')
  for (const [root, pts] of Object.entries(INDEX_BASELINE_BLOCKS)) {
    if (s.startsWith(root)) return pts;
  }
  return 10.0;
}

/** Trading session length in hours for market segment. NSE = 6 hrs (approx 6h 15m), MCX = 14 hrs, Crypto = 24 hrs. */
export function sessionHoursForMarket(market?: string, symbol?: string): number {
  const m = market?.toUpperCase();
  const s = symbol?.toUpperCase();
  if (m === 'MCX' || m === 'MCX_COMM' || s?.includes('CRUDE') || s?.includes('NATURALGAS') || s?.includes('GOLD') || s?.includes('SILVER')) {
    return 14;
  }
  if (m === 'CRYPTO' || s?.includes('BTC') || s?.includes('ETH')) {
    return 24;
  }
  return 6;
}

export type DailyAtrResult = {
  atr: number;
  sessionsCount: number;
  lastSessionRange: number;
};

/**
 * Calculates Daily ATR from 1-minute bars by grouping bars into trading sessions.
 * Returns null if fewer than 1 session can be constructed.
 */
export function calculateDailyAtr(bars: Bar[], maxSessions = 5): DailyAtrResult | null {
  if (bars.length === 0) return null;
  // Group into sessions
  const sessions: { high: number; low: number; close: number }[] = [];
  let curSession: { session: string; high: number; low: number; close: number } | null = null;

  for (const b of bars) {
    const sId = sessionOf(b.t);
    const price = b.straddle > 0 ? b.straddle : (b.ce + b.pe);
    if (!(price > 0)) continue;
    const high = b.h ?? price;
    const low = b.l ?? price;

    if (!curSession || curSession.session !== sId) {
      if (curSession) sessions.push({ high: curSession.high, low: curSession.low, close: curSession.close });
      curSession = { session: sId, high, low, close: price };
    } else {
      curSession.high = Math.max(curSession.high, high);
      curSession.low = Math.min(curSession.low, low);
      curSession.close = price;
    }
  }
  if (curSession) sessions.push({ high: curSession.high, low: curSession.low, close: curSession.close });
  if (sessions.length === 0) return null;

  // Calculate True Range for the recent sessions
  const recent = sessions.slice(-maxSessions);
  const trs: number[] = [];
  for (let i = 0; i < recent.length; i++) {
    const cur = recent[i];
    const prev = i > 0 ? recent[i - 1] : null;
    const hl = cur.high - cur.low;
    if (!prev) {
      trs.push(hl);
    } else {
      const hc = Math.abs(cur.high - prev.close);
      const lc = Math.abs(cur.low - prev.close);
      trs.push(Math.max(hl, hc, lc));
    }
  }

  const sum = trs.reduce((a, b) => a + b, 0);
  const atr = trs.length > 0 ? sum / trs.length : 0;
  const lastSessionRange = recent[recent.length - 1].high - recent[recent.length - 1].low;

  return {
    atr: Number(atr.toFixed(2)),
    sessionsCount: recent.length,
    lastSessionRange: Number(lastSessionRange.toFixed(2)),
  };
}

/** Snaps a float value to instrument tick (e.g. 0.05 on NSE, 1.0 on MCX Crude). */
export function snapToTick(val: number, tick = 0.05): number {
  if (!(tick > 0)) return Number(val.toFixed(2));
  const rounded = Math.round(val / tick) * tick;
  return Number(rounded.toFixed(2));
}

export type AutoBlockResult = {
  boxPts: number;
  source: 'atr' | 'baseline';
  dailyAtr: number;
  blocks: number;
  formula: string;
};

/**
 * Calculates optimal Renko block size for an instrument:
 * Formula: Daily ATR / Blocks in session (where blocks = SessionHours * (60 / targetMinutes)).
 * Uses live session bars ATR when >= 2 sessions available, else falls back to calibrated index baseline.
 */
export function calculateAutoBlockSize(opts: {
  symbol?: string;
  bars?: Bar[];
  market?: string;
  targetMinutes?: number;
  boxTick?: number;
}): AutoBlockResult {
  const { symbol = 'NIFTY', bars, market, targetMinutes = 30, boxTick } = opts;
  const s = (symbol || 'NIFTY').toUpperCase().trim();
  const sessionHours = sessionHoursForMarket(market, s);
  const blocks = Math.max(1, Math.round(sessionHours * (60 / targetMinutes)));
  const tick = boxTick && boxTick > 0 ? boxTick : (sessionHours === 14 ? 1.0 : 0.05);

  const atrRes = bars && bars.length >= 60 ? calculateDailyAtr(bars, 5) : null;
  if (atrRes && atrRes.atr > 0 && atrRes.sessionsCount >= 2) {
    const rawBox = atrRes.atr / blocks;
    const boxPts = Math.max(tick, snapToTick(rawBox, tick));
    return {
      boxPts,
      source: 'atr',
      dailyAtr: atrRes.atr,
      blocks,
      formula: `${atrRes.atr} ATR / ${blocks} blocks = ${boxPts} pts`,
    };
  }

  // Baseline calibration
  const basePts = indexBaselineBlock(s);
  const boxPts = Math.max(tick, snapToTick(basePts, tick));
  const estDailyAtr = Number((basePts * blocks).toFixed(1));
  return {
    boxPts,
    source: 'baseline',
    dailyAtr: estDailyAtr,
    blocks,
    formula: `Baseline (${s}): ${boxPts} pts (${targetMinutes}m target, ${blocks} blocks)`,
  };
}
