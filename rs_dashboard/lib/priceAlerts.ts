/**
 * Price Alerts (TradingView-style) — the pure rules. No IO: the server watcher (lib/priceAlertServer.ts) feeds it prices
 * and the clock, the API route feeds it what the browser sent. See docs/PRICE_ALERTS_GUIDE.md.
 *
 * An alert watches ONE instrument's last price (an index, a future or an option premium) against a level:
 *   Crossing / Crossing Up / Crossing Down  — an EVENT between two observed prices (needs a previous price)
 *   Greater Than / Less Than               — a STATE of the current price
 * and, when it fires, notifies (sound for N seconds) or places ONE Dhan MARKET order on a fixed contract chosen when the
 * alert was made. A trade alert is always "Once only": it can never trade twice.
 *
 * The first price seen for an alert (after creation or a server restart) is only a baseline: it never fires a crossing, so a
 * stale or replayed packet cannot fire one either.
 */
import { isRegularSession, istDateIso } from './nseHolidays.ts';
import { mcxSession } from './mcxSession.ts';

export type AlertCondition = 'cross' | 'crossUp' | 'crossDown' | 'gt' | 'lt';
export type AlertTrigger = 'once' | 'every';
export type AlertSegment = 'IDX_I' | 'NSE_FNO' | 'MCX_COMM';
export type AlertStatus = 'active' | 'paused' | 'triggered' | 'expired' | 'firing';

export const CONDITIONS: Record<AlertCondition, string> = {
  cross: 'Crossing', crossUp: 'Crossing Up', crossDown: 'Crossing Down', gt: 'Greater Than', lt: 'Less Than',
};

/** Hard cap on lots per alert order (also backed by the 'pa' source cap in lib/dhanSourceCaps.ts). */
export const MAX_ALERT_LOTS = 10;
export const DEFAULT_SOUND_SEC = 3;
export const MAX_SOUND_SEC = 60;
/** "Every time" alerts fire at most once per this long, so a price hovering on the level cannot fire every tick. */
export const EVERY_COOLDOWN_MS = 10_000;
export const MAX_ALERTS = 200;
export const MAX_LOG = 500;
export const MAX_MESSAGE = 200;

/** What the browser sends to pick an instrument. Security ids are resolved on the server from master_list.csv, never taken from the browser. */
export type InstrumentSpec =
  | { kind: 'index'; symbol: string }
  | { kind: 'future'; underlying: string; expiry: string }
  | { kind: 'option'; underlying: string; expiry: string; strike: number; optType: 'CE' | 'PE' };

/** A resolved instrument (server-side lookup of an InstrumentSpec). */
export interface AlertInstrument {
  kind: 'index' | 'future' | 'option';
  segment: AlertSegment;
  securityId: string;
  displayName: string;
  underlying: string;
  /** Contract expiry (YYYY-MM-DD); null for an index. */
  expiry: string | null;
  /** Lot size from the master list (index: 1). */
  lot: number;
  strike?: number;
  optType?: 'CE' | 'PE';
}

export type AlertAction =
  | { kind: 'notify' }
  | { kind: 'trade'; contract: AlertInstrument; side: 'BUY' | 'SELL'; lots: number; product: 'INTRADAY' | 'MARGIN' };

export type OrderOutcome =
  | { status: 'placed'; orderId: string; qty: number; at: number }
  | { status: 'rejected' | 'unknown' | 'skipped'; message: string; qty?: number; at: number };

export interface PriceAlert {
  id: string;
  createdAt: number;
  updatedAt: number;
  instrument: AlertInstrument;
  condition: AlertCondition;
  value: number;
  trigger: AlertTrigger;
  /** Epoch ms, or null = open-ended. */
  expiresAt: number | null;
  soundSec: number;
  message: string;
  action: AlertAction;
  status: AlertStatus;
  firedCount: number;
  lastFiredAt: number | null;
  lastFiredPrice: number | null;
  /** The trade alert's order, once sent (or refused). */
  order?: OrderOutcome;
  /** For a trade alert: the correlationId claimed before sending, so an unknown order can be looked up in the book. */
  correlationId?: string;
}

export interface AlertEvent {
  id: string;
  at: number;
  alertId: string;
  symbol: string;
  condition: AlertCondition;
  value: number;
  price: number;
  message: string;
  soundSec: number;
  action: 'notify' | 'trade';
  /** Trade alerts: the order line ("BUY 2 lots NIFTY 24000 CE") and its outcome, filled in after the send. */
  trade?: string;
  order?: OrderOutcome;
}

export interface AlertsState {
  alerts: PriceAlert[];
  /** IST date REAL orders are armed for; anything else = not armed (trade alerts then only notify). */
  armedOn: string | null;
  defaultSoundSec: number;
  /** Bumped on every write; the browser's stream sends on change. */
  version: number;
}

/** What GET /api/price-alerts and its stream send the browser. */
export interface AlertsView {
  alerts: PriceAlert[];
  armedToday: boolean;
  defaultSoundSec: number;
  version: number;
  log: AlertEvent[];
  /** The server watcher: running = ticked in the last 5 s; unpriced = active alert ids with no usable live price for 20 s+. */
  watcher?: { running: boolean; unpriced: string[] };
}

export const emptyAlertsState = (): AlertsState => ({ alerts: [], armedOn: null, defaultSoundSec: DEFAULT_SOUND_SEC, version: 0 });

// ── evaluation ─────────────────────────────────────────────────────────

/** Whether the condition holds between the previous observed price (null = none yet) and the current one. */
export function conditionMet(condition: AlertCondition, value: number, prev: number | null, cur: number): boolean {
  switch (condition) {
    case 'gt': return cur > value;
    case 'lt': return cur < value;
    case 'crossUp': return prev !== null && prev < value && cur >= value;
    case 'crossDown': return prev !== null && prev > value && cur <= value;
    case 'cross': return prev !== null && ((prev < value && cur >= value) || (prev > value && cur <= value));
  }
}

/** Per-alert memory the watcher keeps between ticks (in-process; lost on restart, which only means a fresh baseline). */
export interface AlertMemory { prev: number; armed: boolean; lastFireAt: number }

/**
 * One tick for one active alert: does it fire now, and what to remember. A crossing needs a previous price (the first sample
 * is a baseline). "Every time" re-arms a Greater/Less Than alert only after the condition went false, and every repeat waits
 * out EVERY_COOLDOWN_MS. The same value is never re-evaluated as a crossing (prev === cur is no cross).
 */
export function stepAlert(
  a: Pick<PriceAlert, 'condition' | 'value' | 'trigger'>, mem: AlertMemory | undefined, cur: number, now: number,
  /** Trade alerts: the first sample never fires, even for Greater / Less Than — the price must MOVE into the condition
   *  (already above the level when created or after a restart = wait until it has been below and comes back). */
  baselineFirst = false,
): { fire: boolean; mem: AlertMemory } {
  const prev = mem ? mem.prev : null;
  const met = conditionMet(a.condition, a.value, prev, cur);
  const isState = a.condition === 'gt' || a.condition === 'lt';
  if (!mem && baselineFirst) return { fire: false, mem: { prev: cur, armed: !(met && isState), lastFireAt: Number.NEGATIVE_INFINITY } };
  const armed = mem ? mem.armed : true;
  const lastFireAt = mem ? mem.lastFireAt : Number.NEGATIVE_INFINITY;
  if (!met) return { fire: false, mem: { prev: cur, armed: true, lastFireAt } };
  const cooled = a.trigger === 'once' || now - lastFireAt >= EVERY_COOLDOWN_MS;
  if (armed && cooled) return { fire: true, mem: { prev: cur, armed: !isState, lastFireAt: now } };
  return { fire: false, mem: { prev: cur, armed: isState ? false : armed, lastFireAt } };
}

/** Why an alert has run out (its own expiry, or its watched / traded contract expired), or null. */
export function expiryReason(a: PriceAlert, now: number): string | null {
  if (a.expiresAt !== null && now >= a.expiresAt) return 'Alert expired';
  const today = istDateIso(now);
  if (a.instrument.expiry && a.instrument.expiry < today) return `${a.instrument.displayName} expired`;
  if (a.action.kind === 'trade' && a.action.contract.expiry && a.action.contract.expiry < today) return `${a.action.contract.displayName} expired`;
  return null;
}

// ── orders ─────────────────────────────────────────────────────────────

/** Dhan order quantity: MCX_COMM takes LOTS (dhan-crudeoil-trading), NSE F&O takes units (lots x lot size). 0 = refuse. */
export function alertOrderQty(contract: Pick<AlertInstrument, 'segment' | 'lot'>, lots: number): number {
  if (!Number.isInteger(lots) || lots < 1 || lots > MAX_ALERT_LOTS) return 0;
  if (contract.segment === 'MCX_COMM') return lots;
  return contract.lot > 0 ? lots * contract.lot : 0;
}

const hhmm = (now: number) => {
  const d = new Date(now + 19_800_000);
  return d.getUTCHours() * 100 + d.getUTCMinutes();
};

/** Whether the contract's exchange is in its regular session now (NSE 09:15-15:30 on a regular day; MCX from mcxSession). */
export function sessionOpen(segment: AlertSegment, now: number): boolean {
  const iso = istDateIso(now);
  const t = hhmm(now);
  if (segment === 'MCX_COMM') {
    const s = mcxSession(iso);
    return s.open < s.close && t >= s.open && t < s.close;
  }
  return isRegularSession(iso) && t >= 915 && t < 1530;
}

/** The repo's intraday (MIS) cutoffs in IST hhmm: NSE 15:17 (CLAUDE.md), MCX the session's auto-exit. */
export interface MisCutoffs { nse: number; mcx: number }

const label = (t: number) => `${String(Math.floor(t / 100)).padStart(2, '0')}:${String(t % 100).padStart(2, '0')}`;

/**
 * Why a firing trade alert must not send its order (it still notifies), or null when it may. An intraday (MIS) order is
 * refused from the intraday cutoff on (`mis`: the dashboard's NSE / MCX auto-exit settings; default NSE 15:17 and
 * mcxSession's auto-exit), so an alert never opens a position minutes before it is squared off.
 */
export function tradeBlock(state: Pick<AlertsState, 'armedOn'>, a: PriceAlert, now: number, mis?: Partial<MisCutoffs>): string | null {
  if (a.action.kind !== 'trade') return 'Not a trade alert';
  const c = a.action.contract;
  if (state.armedOn !== istDateIso(now)) return 'REAL orders are not armed today — order skipped';
  if (c.expiry && c.expiry < istDateIso(now)) return `${c.displayName} has expired — order skipped`;
  if (!sessionOpen(c.segment, now)) return `${c.segment === 'MCX_COMM' ? 'MCX' : 'NSE'} market is closed — order skipped`;
  if (a.action.product === 'INTRADAY') {
    const cutoff = c.segment === 'MCX_COMM' ? (mis?.mcx ?? mcxSession(istDateIso(now)).autoExit) : (mis?.nse ?? 1517);
    if (hhmm(now) >= cutoff) return `Past the ${label(cutoff)} intraday (MIS) cutoff — order skipped`;
  }
  if (!alertOrderQty(c, a.action.lots)) return `Lots must be 1-${MAX_ALERT_LOTS} with a known lot size — order skipped`;
  return null;
}

export type AlertMarket = 'NSE' | 'MCX';

/**
 * The markets (NSE / MCX) that are open now and hold an ACTIVE, unexpired trade alert whose order would be skipped only
 * because REAL orders are not armed today. Empty when armed, or when no such alert exists. Drives the "not armed"
 * reminder (PriceAlertListener): forgetting to arm skipped real trades (2026-11-27, NIFTY 25,800 crossDown BUY 2L).
 */
export function unarmedTradeMarkets(view: Pick<AlertsView, 'alerts' | 'armedToday'>, now: number): AlertMarket[] {
  if (view.armedToday) return [];
  const today = istDateIso(now);
  const out = new Set<AlertMarket>();
  for (const a of view.alerts) {
    if (a.status !== 'active' || a.action.kind !== 'trade') continue;
    const c = a.action.contract;
    if (c.expiry && c.expiry < today) continue;
    if (sessionOpen(c.segment, now)) out.add(c.segment === 'MCX_COMM' ? 'MCX' : 'NSE');
  }
  return (['NSE', 'MCX'] as const).filter(m => out.has(m));
}

export const tradeLine = (a: AlertAction): string | undefined =>
  a.kind === 'trade' ? `${a.side} ${a.lots} lot${a.lots === 1 ? '' : 's'} ${a.contract.displayName} (${a.product === 'MARGIN' ? 'NRML' : 'MIS'})` : undefined;

/** A Dhan correlationId for an alert order (8-25 lowercase letters/digits, prefixed with the 'pa' source). */
export const alertCorrelationId = (alertId: string, now: number): string =>
  `pa${now.toString(36)}${alertId.replace(/[^a-z0-9]/g, '').slice(-6)}`.slice(0, 25);

// ── input validation (the browser's create / update body) ──────────────

export interface AlertInput {
  instrument: InstrumentSpec;
  condition: AlertCondition;
  value: number;
  trigger: AlertTrigger;
  expiresAt: number | null;
  soundSec: number;
  message: string;
  action: { kind: 'notify' } | { kind: 'trade'; contract: InstrumentSpec; side: 'BUY' | 'SELL'; lots: number; product: 'INTRADAY' | 'MARGIN' };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The only underlyings alerts are offered on: NIFTY (index, futures, options) and MCX crude (futures, options). */
export const ALERT_UNDERLYINGS = ['NIFTY', 'CRUDEOIL', 'CRUDEOILM'] as const;
export type AlertUnderlying = (typeof ALERT_UNDERLYINGS)[number];
export const isAlertUnderlying = (u: string): u is AlertUnderlying => (ALERT_UNDERLYINGS as readonly string[]).includes(u);
export const isMcxAlertUnderlying = (u: string): boolean => u === 'CRUDEOIL' || u === 'CRUDEOILM';
/** Underlyings with an index of their own (alerts on the index level). Crude's "spot" is its future. */
export const hasIndex = (u: string): boolean => u === 'NIFTY';

/**
 * Epoch ms of the session close on `iso` for this underlying — what an "expire at <date>" choice means. NSE 15:30 IST;
 * MCX from mcxSession (23:30 in US summer time, else 23:55; 17:00 on a morning-only day). A closed MCX day falls back to 23:55.
 */
export function sessionCloseMs(underlying: string, iso: string): number {
  let hhmm = 1530;
  if (isMcxAlertUnderlying(underlying)) {
    const m = mcxSession(iso);
    hhmm = m.open < m.close ? m.close : 2355;
  }
  const mins = Math.floor(hhmm / 100) * 60 + (hhmm % 100);
  return Date.parse(`${iso}T00:00:00Z`) + (mins - 330) * 60_000;
}

function parseSpec(raw: unknown, allowIndex: boolean): InstrumentSpec | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind;
  if (kind === 'index') {
    if (!allowIndex) return 'An index cannot be traded — pick a future or an option';
    const symbol = String(r.symbol ?? '').toUpperCase();
    return hasIndex(symbol) ? { kind, symbol } : `${symbol || 'That'} has no index alert — pick ${ALERT_UNDERLYINGS.join(' / ')} future or option`;
  }
  if (kind === 'future' || kind === 'option') {
    const underlying = String(r.underlying ?? '').toUpperCase();
    const expiry = String(r.expiry ?? '');
    if (!isAlertUnderlying(underlying)) return `Alerts are only for ${ALERT_UNDERLYINGS.join(', ')}`;
    if (!ISO.test(expiry)) return 'Invalid expiry';
    if (kind === 'future') return { kind, underlying, expiry };
    const strike = Number(r.strike);
    const optType = r.optType === 'CE' || r.optType === 'PE' ? r.optType : null;
    if (!(strike > 0) || !optType) return 'Option needs a strike and CE / PE';
    return { kind, underlying, expiry, strike, optType };
  }
  return 'Pick an index, a future or an option';
}

/** The browser's alert body, checked and normalised (trade alerts forced to "Once only"), or an error message. */
export function parseAlertInput(raw: unknown, now: number): AlertInput | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const instrument = parseSpec(r.instrument, true);
  if (typeof instrument === 'string') return instrument;
  const condition = r.condition as AlertCondition;
  if (!(condition in CONDITIONS)) return 'Unknown condition';
  const value = Number(r.value);
  if (!(value > 0) || !Number.isFinite(value)) return 'Value must be a positive price';
  let trigger: AlertTrigger = r.trigger === 'every' ? 'every' : 'once';
  const expiresAt = r.expiresAt == null || r.expiresAt === '' ? null : Number(r.expiresAt);
  if (expiresAt !== null && !(expiresAt > now)) return 'Expiration must be in the future';
  const soundSec = r.soundSec == null || r.soundSec === '' ? DEFAULT_SOUND_SEC : Number(r.soundSec);
  if (!Number.isInteger(soundSec) || soundSec < 1 || soundSec > MAX_SOUND_SEC) return `Sound must be 1-${MAX_SOUND_SEC} seconds`;
  const message = String(r.message ?? '').slice(0, MAX_MESSAGE);
  const act = (r.action ?? { kind: 'notify' }) as Record<string, unknown>;
  let action: AlertInput['action'] = { kind: 'notify' };
  if (act.kind === 'trade') {
    const contract = parseSpec(act.contract, false);
    if (typeof contract === 'string') return contract;
    const side = act.side === 'BUY' || act.side === 'SELL' ? act.side : null;
    if (!side) return 'Pick BUY or SELL';
    const lots = Number(act.lots);
    if (!Number.isInteger(lots) || lots < 1 || lots > MAX_ALERT_LOTS) return `Lots must be a whole number 1-${MAX_ALERT_LOTS}`;
    const product = act.product === 'MARGIN' ? 'MARGIN' : 'INTRADAY';
    action = { kind: 'trade', contract, side, lots, product };
    trigger = 'once';
  } else if (act.kind !== undefined && act.kind !== 'notify') {
    return 'Unknown action';
  }
  return { instrument, condition, value, trigger, expiresAt, soundSec, message, action };
}

/** A new alert id (also used as the event id prefix). */
export const newId = (now: number): string => `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Appends events to a log, newest last, capped at MAX_LOG. */
export function appendLog(log: AlertEvent[], events: AlertEvent[]): AlertEvent[] {
  const next = [...log, ...events];
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
}

/** A short label for the alert list: "NIFTY Crossing Up 24,100". */
export const alertLabel = (a: Pick<PriceAlert, 'instrument' | 'condition' | 'value'>): string =>
  `${a.instrument.displayName} ${CONDITIONS[a.condition]} ${a.value.toLocaleString('en-IN')}`;
