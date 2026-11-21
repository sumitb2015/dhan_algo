// Signal Orb ledger: pure state + ops. The server (lib/signalOrbServer.ts) owns the file debug/signal_orb_state.json and applies
// these under one in-process chain; the browser only sends config / mode / engine ops and asks the trade route to act. Real money:
// the ledger is the authority for what THIS page opened (an exit closes only its own units, never the broker's whole net).

import { TIMEFRAMES, sanitizeSpec, specIssue, hhmmToMin, defaultSpec, rowPnl, rowLegsPnl, type IndicatorSpec, type Side, type Timeframe } from './signalOrb.ts';
import type { Target } from './pnfTarget.ts';
import { DEFAULT_PREMIUM, premiumHasStop, sanitizePremiumPatch, type PremiumConfig } from './orbFocus.ts';

export type OrbMode = 'SIM' | 'REAL';
export type OrbBroker = 'dhan' | 'kotak' | 'zerodha';
export type RowStatus = 'sending' | 'open' | 'closing' | 'closed' | 'failed' | 'unknown';
export type OrbSymbol = 'CRUDEOILM' | 'CRUDEOIL' | 'NIFTY';
export const ORB_SYMBOLS: OrbSymbol[] = ['CRUDEOILM', 'CRUDEOIL', 'NIFTY'];
/** Entry start / entry end / cutoff per symbol: MCX crude runs into the evening, NSE closes 15:30 (the repo's intraday exit is 15:17). */
export const SYMBOL_TIMES: Record<OrbSymbol, { entryStart: string; entryEnd: string; eodExit: string }> = {
  CRUDEOILM: { entryStart: '09:15', entryEnd: '22:45', eodExit: '23:00' },
  CRUDEOIL: { entryStart: '09:15', entryEnd: '22:45', eodExit: '23:00' },
  NIFTY: { entryStart: '09:16', entryEnd: '15:00', eodExit: '15:17' },
};
/** Points are not comparable across symbols (30 points is ~0.4% of crude, ~0.12% of NIFTY), so a symbol switch brings its own stop and trail. */
/** When a straddle / strangle is sold, per symbol (a few minutes after the open). */
export const SYMBOL_PREMIUM_ENTRY: Record<OrbSymbol, string> = { CRUDEOILM: '09:30', CRUDEOIL: '09:30', NIFTY: '09:20' };
export const SYMBOL_RISK: Record<OrbSymbol, { stopPts: number; trailStartPts: number; trailGapPts: number }> = {
  CRUDEOILM: { stopPts: 30, trailStartPts: 8, trailGapPts: 15 },
  CRUDEOIL: { stopPts: 30, trailStartPts: 8, trailGapPts: 15 },
  NIFTY: { stopPts: 40, trailStartPts: 25, trailGapPts: 15 },
};
/** futures: long on BULL, short on BEAR. options: SELL a PE on BULL, SELL a CE on BEAR (the indicators always read the future). */
export type OrbInstrument = 'futures' | 'options' | 'synthetic' | 'straddle' | 'strangle';
/** Straddle / strangle are non-directional: no indicator, a timed entry and the Focus Tool's SL / target rules (lib/orbFocus.ts). */
export const isPremiumInstrument = (i: OrbInstrument): boolean => i === 'straddle' || i === 'strangle';
/** Structures that are several option legs (placed leg by leg, Dhan only for now). */
export const isLegInstrument = (i: OrbInstrument): boolean => i === 'synthetic' || i === 'straddle' || i === 'strangle';
/** Strike offset bounds: 0 = ATM, +N = N strikes OTM (PE down, CE up), -N = ITM. */
export const MAX_STRIKE_OFFSET = 10;
export const MAX_INDICATORS = 8;
export const MAX_REJECTS = 3;
/** A 'sending' / 'closing' row older than this lost its order call (server restart mid-send): the user may resolve it. */
export const STUCK_MS = 90_000;

/** In flight past STUCK_MS: the request that owned it is gone, only the broker book can say what happened. */
export const isStuck = (r: OrbRow, now: number) =>
  (r.status === 'sending' || r.status === 'closing') && now - (r.sentAt ?? r.entryAt) > STUCK_MS;
const LOG_MAX = 60;
const ROWS_MAX = 200;

export interface OrbConfig {
  indicators: IndicatorSpec[];
  timeframe: Timeframe;
  lots: number;
  /** Hard stop, points from entry. REAL needs it > 0. */
  stopPts: number;
  /** Trailing stop: points profit to activate trailing (0 = off). */
  trailStartPts?: number;
  /** Trailing stop: points gap behind peak price once trailing is active. */
  trailGapPts?: number;
  /** Rupees; today's realised loss (active mode) at or past it halts entries. */
  dailyLossLimit: number;
  entryStart: string;
  entryEnd: string;
  eodExit: string;
  broker: OrbBroker;
  symbol: OrbSymbol;
  instrument: OrbInstrument;
  strikeOffset: number;
  /** The straddle / strangle rules (used only when `instrument` is straddle or strangle). */
  premium: PremiumConfig;
}

/** REAL never runs a naked structure without a stop: a signal-driven one needs the hard stop, a straddle / strangle needs a leg or total SL. */
export const configHasStop = (c: OrbConfig): boolean => (isPremiumInstrument(c.instrument) ? premiumHasStop(c.premium) : c.stopPts > 0);

/** One leg of a multi-leg row. `entry` / `exit` are premiums (the decision price, like a single-leg row), `units` the broker quantity sent. */
export interface OrbLeg {
  target: Target;
  /** The action that OPENED the leg (a SELL leg is closed by a BUY). */
  action: 'BUY' | 'SELL';
  entry: number;
  exit?: number;
  units: number;
  status: 'open' | 'closed' | 'failed';
  note?: string;
  /** Straddle / strangle: the other leg's SL fired and SL-to-cost applies, so this leg now exits at its entry premium. */
  costStop?: boolean;
  /** Straddle / strangle: Trail SL steps earned (never lost). */
  trailSteps?: number;
}

/** What a row is, for comparing with the configured instrument: legs first, else a sold option, else the future. */
export const rowInstrument = (r: Pick<OrbRow, 'structure' | 'target'>): OrbInstrument =>
  r.structure ? r.structure : r.target.kind === 'options' ? 'options' : 'futures';

export interface OrbRow {
  id: string;
  mode: OrbMode;
  broker: OrbBroker;
  target: Target;
  side: Side;
  lots: number;
  /** Broker quantity sent (lots x the broker's own lot units); 0 for SIM. */
  units: number;
  /** Rupees per point per lot: barrels per lot for crude (CRUDEOILM 10), the master lot for NIFTY. */
  unitsPerLot: number;
  /** Decision price of the row's OWN instrument (futures LTP, or the option premium) when the order was sent, not the broker fill. */
  entry: number;
  /** A multi-leg row (synthetic future): its legs, in placement order (BUY first). Absent = a single-leg row. Leg 0 is mirrored in `target` / `entry`. */
  structure?: 'synthetic' | 'straddle' | 'strangle';
  legs?: OrbLeg[];
  /** Straddle / strangle: the running profit peak (rupees, premium points) the overall trail needs. */
  peak?: { pnl: number; pts: number };
  /** The future the signal (and the stop) read. Absent on rows written before options existed: then `target`. */
  signalTarget?: Target;
  /** The future's price at entry: the stop is measured from it. Absent on old rows: then `entry`. */
  signalEntry?: number;
  entryAt: number;
  day: string;
  status: RowStatus;
  exit?: number;
  exitAt?: number;
  exitReason?: string;
  pnl?: number;
  note?: string;
  /** When the row last went 'sending' / 'closing' (ms): an order still in flight after STUCK_MS died with the server. */
  sentAt?: number;
  /** The best signal-future price seen while open (high for LONG, low for SHORT): the trailing stop's peak, kept here so a reload or a new leader tab does not lose it. */
  bestPrice?: number;
}

export interface OrbLog { at: number; level: 'info' | 'warn' | 'error' | 'trade'; msg: string }

export interface OrbLedger {
  rev: number;
  config: OrbConfig;
  mode: OrbMode;
  engineActive: boolean;
  haltReason: string | null;
  /** Newest bar an entry / reversal was taken on. */
  watermarkT: number;
  /** After a stop-out: this side waits for the colour to change. */
  blockedSide: Side | null;
  /** The IST day a straddle / strangle was last entered (or an entry attempt consumed): one entry a day. */
  premiumEntryDay: string | null;
  rejects: number;
  rows: OrbRow[];
  log: OrbLog[];
  updatedAt: number;
}

export const DEFAULT_CONFIG: OrbConfig = {
  indicators: [defaultSpec('ema', 'ema-9'), defaultSpec('supertrend', 'st-10-2')],
  timeframe: 1,
  lots: 1,
  stopPts: 30,
  trailStartPts: 0,
  trailGapPts: 15,
  dailyLossLimit: 3000,
  entryStart: '09:15',
  entryEnd: '22:45',
  eodExit: '23:00',
  broker: 'dhan',
  symbol: 'CRUDEOILM',
  instrument: 'futures',
  strikeOffset: 0,
  premium: { ...DEFAULT_PREMIUM, trail: { ...DEFAULT_PREMIUM.trail } },
};

export const emptyLedger = (): OrbLedger => ({
  rev: 0, config: { ...DEFAULT_CONFIG, indicators: [...DEFAULT_CONFIG.indicators] }, mode: 'SIM', engineActive: false, haltReason: null,
  watermarkT: 0, blockedSide: null, premiumEntryDay: null, rejects: 0, rows: [], log: [], updatedAt: 0,
});

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A stored ledger of any shape -> a valid one (corrupt fields fall back to defaults; rows are kept as written). */
export function normalizeLedger(v: unknown): OrbLedger {
  const base = emptyLedger();
  if (!v || typeof v !== 'object') return base;
  const o = v as Partial<OrbLedger>;
  // field by field: one bad stored value falls back to its own default, never resets the whole config
  let cfg: OrbConfig = base.config;
  const stored = o.config && typeof o.config === 'object' ? (o.config as unknown as Record<string, unknown>) : {};
  const TIME_KEYS = ['entryStart', 'entryEnd', 'eodExit'];
  // the symbol first: switching it brings that symbol's stop / trail / times, which the stored values then replace
  for (const k of Object.keys(stored).filter(x => !TIME_KEYS.includes(x)).sort((a, b) => (a === 'symbol' ? -1 : b === 'symbol' ? 1 : 0))) {
    const r = sanitizeConfigPatch({ [k]: stored[k] }, cfg);
    if (typeof r !== 'string') cfg = r;
  }
  // the three times are ordered against each other, so they are checked as one group
  const times = Object.fromEntries(TIME_KEYS.filter(k => k in stored).map(k => [k, stored[k]]));
  const tr = sanitizeConfigPatch(times, cfg);
  if (typeof tr !== 'string') cfg = tr;
  return {
    rev: Number.isInteger(o.rev) ? (o.rev as number) : 0,
    config: cfg,
    mode: o.mode === 'REAL' ? 'REAL' : 'SIM',
    engineActive: o.engineActive === true,
    haltReason: typeof o.haltReason === 'string' ? o.haltReason : null,
    watermarkT: Number.isFinite(o.watermarkT) ? (o.watermarkT as number) : 0,
    blockedSide: o.blockedSide === 'LONG' || o.blockedSide === 'SHORT' ? o.blockedSide : null,
    premiumEntryDay: typeof o.premiumEntryDay === 'string' ? o.premiumEntryDay : null,
    rejects: Number.isInteger(o.rejects) ? (o.rejects as number) : 0,
    rows: Array.isArray(o.rows) ? o.rows : [],
    log: Array.isArray(o.log) ? o.log : [],
    updatedAt: Number.isFinite(o.updatedAt) ? (o.updatedAt as number) : 0,
  };
}

/** Merge a config patch into `cur`, bounded; a reason string when it is refused. Time order is checked only when a time is patched. */
export function sanitizeConfigPatch(patch: unknown, cur: OrbConfig): OrbConfig | string {
  if (!patch || typeof patch !== 'object') return 'config patch must be an object';
  const p = patch as Record<string, unknown>;
  const next: OrbConfig = { ...cur, indicators: [...cur.indicators] };
  if (p.indicators !== undefined) {
    if (!Array.isArray(p.indicators)) return 'indicators must be a list';
    if (p.indicators.length > MAX_INDICATORS) return `At most ${MAX_INDICATORS} indicators`;
    const specs = p.indicators.map(sanitizeSpec);
    if (specs.some(s => s === null)) return 'An indicator is invalid';
    const ids = new Set(specs.map(s => s!.id));
    if (ids.size !== specs.length) return 'Indicator ids must be unique';
    next.indicators = specs as IndicatorSpec[];
  }
  if (p.timeframe !== undefined) {
    if (!TIMEFRAMES.includes(p.timeframe as Timeframe)) return `timeframe must be one of ${TIMEFRAMES.join(', ')} minutes`;
    next.timeframe = p.timeframe as Timeframe;
  }
  if (p.lots !== undefined) {
    const n = Number(p.lots);
    // no lot cap on this page (the user's call, 2026-11-20); the exchange's freeze quantity still rejects an oversized order
    if (!Number.isSafeInteger(n) || n < 1) return 'lots must be a whole number of at least 1';
    next.lots = n;
  }
  if (p.stopPts !== undefined) {
    const n = Number(p.stopPts);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return 'stopPts must be 0-1000';
    next.stopPts = n;
  }
  if (p.trailStartPts !== undefined) {
    const n = Number(p.trailStartPts);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return 'trailStartPts must be 0-1000';
    next.trailStartPts = n;
  }
  if (p.trailGapPts !== undefined) {
    const n = Number(p.trailGapPts);
    if (!Number.isFinite(n) || n < 1 || n > 1000) return 'trailGapPts must be 1-1000';
    next.trailGapPts = n;
  }
  if (p.dailyLossLimit !== undefined) {
    const n = Number(p.dailyLossLimit);
    if (!Number.isFinite(n) || n < 100 || n > 500_000) return 'dailyLossLimit must be 100-500000';
    next.dailyLossLimit = n;
  }
  if (p.broker !== undefined) {
    if (p.broker !== 'dhan' && p.broker !== 'kotak' && p.broker !== 'zerodha') return 'broker must be dhan, kotak or zerodha';
    next.broker = p.broker;
  }
  if (p.symbol !== undefined) {
    if (!ORB_SYMBOLS.includes(p.symbol as OrbSymbol)) return `symbol must be ${ORB_SYMBOLS.join(' or ')}`;
    // a symbol change brings that exchange's session times (unless the same patch sets times itself)
    if (p.symbol !== cur.symbol && p.entryStart === undefined && p.entryEnd === undefined && p.eodExit === undefined) {
      Object.assign(next, SYMBOL_TIMES[p.symbol as OrbSymbol]);
    }
    if (p.symbol !== cur.symbol && p.stopPts === undefined && p.trailStartPts === undefined && p.trailGapPts === undefined) {
      Object.assign(next, SYMBOL_RISK[p.symbol as OrbSymbol]);
    }
    if (p.symbol !== cur.symbol && p.premium === undefined) next.premium = { ...next.premium, entryTime: SYMBOL_PREMIUM_ENTRY[p.symbol as OrbSymbol] };
    next.symbol = p.symbol as OrbSymbol;
  }
  if (p.instrument !== undefined) {
    if (!['futures', 'options', 'synthetic', 'straddle', 'strangle'].includes(p.instrument as string)) return 'instrument must be futures, options, synthetic, straddle or strangle';
    next.instrument = p.instrument as OrbInstrument;
  }
  if (p.strikeOffset !== undefined) {
    const n = Number(p.strikeOffset);
    if (!Number.isInteger(n) || Math.abs(n) > MAX_STRIKE_OFFSET) return `strikeOffset must be a whole number from -${MAX_STRIKE_OFFSET} to ${MAX_STRIKE_OFFSET}`;
    next.strikeOffset = n;
  }
  if (p.premium !== undefined) {
    const pr = sanitizePremiumPatch(p.premium, cur.premium ?? DEFAULT_PREMIUM);
    if (typeof pr === 'string') return pr;
    next.premium = pr;
  }
  if (isLegInstrument(next.instrument) && next.broker !== 'dhan') return `${next.instrument === 'synthetic' ? 'Synthetic futures' : 'Straddle / strangle'} run on Dhan only for now`;
  if (next.instrument === 'strangle' && next.strikeOffset < 1) return 'A strangle needs a strike offset of at least 1 (strikes OTM per side)';
  let timePatched = false;
  for (const k of ['entryStart', 'entryEnd', 'eodExit'] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'string' || !HHMM_RE.test(p[k] as string)) return `${k} must be HH:MM`;
    next[k] = p[k] as string;
    timePatched = true;
  }
  if (timePatched && !(hhmmToMin(next.entryStart) < hhmmToMin(next.entryEnd) && hhmmToMin(next.entryEnd) <= hhmmToMin(next.eodExit))) {
    return 'Times must run entry start < entry end <= cutoff';
  }
  // the broker squares MIS off before the exchange closes: a cutoff after that point never runs on this page
  const maxCutoff = next.symbol === 'NIFTY' ? '15:25' : '23:25';
  if (timePatched && hhmmToMin(next.eodExit) > hhmmToMin(maxCutoff)) return `${next.symbol} cutoff must be ${maxCutoff} or earlier (the broker squares off intraday positions near then)`;
  return next;
}

/** A row that holds (or may hold) a broker position: nothing new may open while one exists. */
export const isLive = (r: OrbRow) => r.status === 'open' || r.status === 'sending' || r.status === 'closing' || r.status === 'unknown';
export const liveRow = (l: OrbLedger): OrbRow | null => l.rows.find(isLive) ?? null;

/** Today's realised P&L of one mode. */
export const realisedToday = (l: OrbLedger, mode: OrbMode, day: string): number =>
  l.rows.filter(r => r.mode === mode && r.day === day && r.status === 'closed').reduce((s, r) => s + (r.pnl ?? 0), 0);

export const tradesToday = (l: OrbLedger, mode: OrbMode, day: string): number =>
  l.rows.filter(r => r.mode === mode && r.day === day && (r.status === 'closed' || isLive(r))).length;

export function addLog(l: OrbLedger, level: OrbLog['level'], msg: string, at: number): OrbLedger {
  return { ...l, log: [...l.log, { at, level, msg }].slice(-LOG_MAX) };
}

export function halt(l: OrbLedger, reason: string, at: number): OrbLedger {
  return addLog({ ...l, engineActive: false, haltReason: reason }, 'error', `HALTED: ${reason}`, at);
}

/** Old rows trimmed (closed / failed only, oldest first); live rows are never dropped. */
export function trimRows(rows: OrbRow[]): OrbRow[] {
  if (rows.length <= ROWS_MAX) return rows;
  let drop = rows.length - ROWS_MAX;
  return rows.filter(r => (drop > 0 && !isLive(r) ? (drop--, false) : true));
}

export type ClientOp =
  | { op: 'setConfig'; patch: unknown }
  | { op: 'setMode'; mode: OrbMode }
  | { op: 'setEngine'; active: boolean }
  | { op: 'addLog'; level: OrbLog['level']; msg: string }
  | { op: 'peak'; id: string; price: number }
  | { op: 'resetSim' }
  | { op: 'resolve'; id: string; as: 'open' | 'closed' | 'failed'; price?: number };

export type OpResult = { ok: true; ledger: OrbLedger } | { ok: false; status: number; error: string };

/** The browser's ops (never a trade: those are the trade route's). Pure; the caller bumps rev and writes. */
export function applyClientOp(l: OrbLedger, raw: unknown, now: number): OpResult {
  const bad = (error: string, status = 400): OpResult => ({ ok: false, status, error });
  if (!raw || typeof raw !== 'object') return bad('Invalid op');
  const op = raw as ClientOp;
  const live = liveRow(l);
  switch (op.op) {
    case 'setConfig': {
      const next = sanitizeConfigPatch(op.patch, l.config);
      if (typeof next === 'string') return bad(next);
      // a live edit is strict: a spec that sanitizing would change is refused, not quietly rewritten
      const specs = (op.patch as { indicators?: unknown } | null)?.indicators;
      if (Array.isArray(specs)) { for (const sp of specs) { const why = specIssue(sp); if (why) return bad(why); } }
      // REAL never runs without a hard stop, whatever order the settings were changed in
      if (l.mode === 'REAL' && !configHasStop(next)) return bad(isPremiumInstrument(next.instrument) ? 'REAL needs a leg SL or a total SL - switch to SIM to turn the stops off' : 'REAL needs a hard stop (points) above 0 - switch to SIM to turn the stop off', 409);
      if (live && next.broker !== l.config.broker) return bad('The broker cannot change while a position is open', 409);
      if (live && (next.symbol !== l.config.symbol || next.instrument !== l.config.instrument || next.strikeOffset !== l.config.strikeOffset)) {
        return bad('Symbol, instrument and strike cannot change while a position is open', 409);
      }
      // a new symbol is a new price series: its last-acted bar and stop-out block do not carry over (no row is live here)
      const symbolChanged = next.symbol !== l.config.symbol;
      return { ok: true, ledger: { ...l, config: next, ...(symbolChanged ? { watermarkT: 0, blockedSide: null } : {}) } };
    }
    case 'setMode': {
      if (op.mode !== 'SIM' && op.mode !== 'REAL') return bad('mode must be SIM or REAL');
      if (live) return bad('Close the open position before switching mode', 409);
      if (op.mode === 'REAL' && !configHasStop(l.config)) return bad(isPremiumInstrument(l.config.instrument) ? 'REAL needs a leg SL or a total SL' : 'REAL needs a hard stop (points) above 0', 409);
      // a mode switch always lands paused: REAL is armed by the user, never inherited from SIM's running engine
      return { ok: true, ledger: addLog({ ...l, mode: op.mode, engineActive: false, watermarkT: 0, blockedSide: null, rejects: 0 }, 'info', `Mode -> ${op.mode}`, now) };
    }
    case 'setEngine': {
      const active = op.active === true;
      if (active && l.mode === 'REAL' && !configHasStop(l.config)) return bad(isPremiumInstrument(l.config.instrument) ? 'REAL needs a leg SL or a total SL' : 'REAL needs a hard stop (points) above 0', 409);
      if (active && !l.config.indicators.length) return bad('Add at least one indicator', 409);
      if (active && (live?.status === 'unknown' || (live && isStuck(live, now)))) return bad('A position has an UNKNOWN outcome - resolve it from the broker book first', 409);
      return { ok: true, ledger: addLog({ ...l, engineActive: active, haltReason: active ? null : l.haltReason, rejects: active ? 0 : l.rejects }, 'info', active ? 'Auto ON' : 'Auto OFF', now) };
    }
    case 'addLog': {
      const level = op.level === 'warn' || op.level === 'error' || op.level === 'trade' ? op.level : 'info';
      if (typeof op.msg !== 'string' || !op.msg.trim()) return bad('msg required');
      return { ok: true, ledger: addLog(l, level, op.msg.slice(0, 240), now) };
    }
    case 'peak': {
      // ratchets only in the trade's favour (never loosens the trail); a stale or odd report changes nothing
      const r = l.rows.find(x => x.id === op.id);
      const px = Number(op.price);
      if (!r || r.status !== 'open' || !Number.isFinite(px) || px <= 0) return { ok: true, ledger: l };
      const cur = r.bestPrice;
      const better = cur === undefined || (r.side === 'LONG' ? px > cur : px < cur);
      return { ok: true, ledger: better ? patchRow(l, r.id, { bestPrice: px }) : l };
    }
    case 'resetSim': {
      if (live?.mode === 'SIM') return bad('Close the SIM position first', 409);
      return { ok: true, ledger: addLog({ ...l, rows: l.rows.filter(r => r.mode !== 'SIM') }, 'info', 'SIM trades cleared', now) };
    }
    case 'resolve': {
      // The user's reading of the broker book for a row the page cannot be sure of (UNKNOWN outcome, or one from an earlier day).
      const r = l.rows.find(x => x.id === op.id);
      if (!r || !isLive(r)) return bad('No such live row', 404);
      if ((r.status === 'sending' || r.status === 'closing') && !isStuck(r, now)) return bad('An order for this row is still in flight', 409);
      if (op.as === 'open') return { ok: true, ledger: addLog(patchRow(l, r.id, { status: 'open', note: 'confirmed open by user' }), 'warn', `Row ${r.id} confirmed OPEN by user`, now) };
      if (op.as === 'failed') return { ok: true, ledger: addLog(patchRow(l, r.id, { status: 'failed', note: 'confirmed not filled by user' }), 'warn', `Row ${r.id} marked NOT FILLED by user`, now) };
      if (op.as === 'closed' && r.legs) {
        // a multi-leg row has no single price to mark it at: every open leg is booked at its entry (no P&L), the broker book is the truth
        return { ok: true, ledger: addLog(closeRowLegs(l, r.id, r.legs.map(() => null), 'Marked closed by user (legs booked at entry: P&L not recorded)', now), 'warn', `Row ${r.id} marked CLOSED by user - its P&L is not recorded`, now) };
      }
      if (op.as === 'closed') {
        const px = Number(op.price);
        const exit = Number.isFinite(px) && px > 0 ? px : r.entry;
        return { ok: true, ledger: addLog(closeRow(l, r.id, exit, 'Marked closed by user', now), 'warn', `Row ${r.id} marked CLOSED by user`, now) };
      }
      return bad('as must be open, closed or failed');
    }
    default:
      return bad('Unknown op');
  }
}

export function patchRow(l: OrbLedger, id: string, patch: Partial<OrbRow>): OrbLedger {
  return { ...l, rows: l.rows.map(r => (r.id === id ? { ...r, ...patch } : r)) };
}

export function closeRow(l: OrbLedger, id: string, exit: number, reason: string, at: number): OrbLedger {
  return {
    ...l,
    rows: l.rows.map(r => (r.id !== id ? r : {
      ...r, status: 'closed' as const, exit, exitAt: at, exitReason: reason,
      pnl: Math.round(rowPnl(r, exit) * 100) / 100,
    })),
  };
}

/** Closes a multi-leg row at the legs' exit premiums (null = a leg's exit is unknown: it is booked at its entry, so it adds no P&L). */
export function closeRowLegs(l: OrbLedger, id: string, exits: (number | null)[], reason: string, at: number): OrbLedger {
  return {
    ...l,
    rows: l.rows.map(r => {
      if (r.id !== id || !r.legs) return r;
      const legs = r.legs.map((g, i) => (g.status === 'closed' && g.exit !== undefined ? g : { ...g, status: 'closed' as const, exit: exits[i] ?? g.entry }));
      const pnl = rowLegsPnl({ lots: r.lots, unitsPerLot: r.unitsPerLot, legs }, legs.map(g => g.exit ?? g.entry));
      return { ...r, legs, status: 'closed' as const, exit: legs[0].exit, exitAt: at, exitReason: reason, pnl: Math.round((pnl ?? 0) * 100) / 100 };
    }),
  };
}
