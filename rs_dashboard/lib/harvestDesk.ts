// Pure rules for the Harvest Desk page (/harvest-desk). No React, no fetch: everything the
// desk decides (entry gates, value balancing, rolls, resets, stops, trails, VWAP gates, diagonal
// sizing) is here so it can be unit-tested (harvestDesk.test.ts) without a browser or a feed.
//
// The desk is paper-only (SIM): fills happen at the quoted LTP and no order route is ever called.
// An algo is a set of leg ROWS (the user adds them one by one, as in Focus Tool) plus the control
// set the strategy script documents (harvestDeskControls.ts). stepAlgo() is one engine tick.

import {
  boolCtl, defaultControls, hasCtl, HD_KIND_META, numCtl, strCtl,
  type HdControls, type HdKind,
} from './harvestDeskControls.ts';

export type HdUnderlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
export const HD_UNDERLYINGS: readonly HdUnderlying[] = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
export type HdOption = 'CE' | 'PE';
export type HdSide = 'S' | 'B';
/** main = a legged position the balancing rules act on; hedge = protective wing the desk buys;
 *  long / short = the two sides of the diagonal. */
export type HdRole = 'main' | 'hedge' | 'long' | 'short';
export type HdStrikeBy = 'ATM' | 'OFFSET' | 'DELTA' | 'PREMIUM';
export type HdPhase = 'ACTIVE' | 'PAUSED' | 'DONE';

export const HD_MAX_LOTS = 50;
export const HD_EVENT_CAP = 80;
/** Expiry rule on a leg: '' = nearest, 'AUTO' = pick by the diagonal's DTE band, else an ISO date. */
export const HD_EXPIRY_AUTO = 'AUTO';

export interface HdLeg {
  id: string;
  role: HdRole;
  option: HdOption;
  side: HdSide;
  expiry: string;
  strikeBy: HdStrikeBy;
  /** OFFSET: points from spot (negative = ITM). DELTA: absolute delta 0-1. PREMIUM: ₹. */
  strikeValue: number;
  /** Lots on entry. For the diagonal short leg 0 = size from delta. */
  lots: number;
  slPct?: number;
  tgtPct?: number;
  /** After an SL / target exit, sell it again when its price returns to the first entry premium. */
  reentry?: boolean;
  /** Created by the desk (a hedge wing), removed when the cycle ends. */
  auto?: boolean;

  status: 'IDLE' | 'OPEN' | 'CLOSED';
  strike?: number;
  expiryUsed?: string;
  openLots: number;
  avgEntry: number;
  firstEntry?: number;
  entryDelta?: number;
  /** ₹ banked by this leg in the current cycle (closed or rolled-out lots). */
  realized: number;
  lastPx?: number;
  exitReason?: string;
  waitingReentry?: boolean;
  reentryPx?: number;
  reentries: number;
  openedAt?: number;
}

export interface HdEvent { t: number; k: string; msg: string }

export interface HdEntryBaseline {
  /** |CE-PE| / max at entry: the offset the lot / strike thresholds are measured from. */
  imbalance: number;
  atm: number;
  ceStrike?: number;
  peStrike?: number;
  /** Sum of the short legs' entry prices, per unit. */
  premiumUnits: number;
  /** ₹ premium collected at entry (the base for % targets and stops). */
  premiumRs: number;
  at: number;
}

export interface HdVwapState {
  strike: number;
  expiry: string;
  bars: number[];
  curMin: number;
  cur: number;
  ticks: number[];
}

export interface HdAlgo {
  v: 1;
  id: string;
  name: string;
  kind: HdKind;
  underlying: HdUnderlying;
  product: 'INTRADAY' | 'MARGIN';
  /** Armed = the desk may enter and adjust. Exits (stops, targets, square-off) run regardless. */
  armed: boolean;
  phase: HdPhase;
  pausedUntil?: number;
  controls: HdControls;
  legs: HdLeg[];
  cycle: number;
  entry?: HdEntryBaseline;
  /** ₹ premium collected by the latest entry; survives the cycle so % limits keep a base. */
  refPremiumRs: number;
  /** ₹ banked by finished cycles, never reset (positional strategies run for days). */
  cumRealized: number;
  /** cumRealized + open MTM at the start of the IST day: the day P&L is measured from here. */
  dayStartPnl: number;
  day: string;
  peakMtm: number;
  trail: { armed: boolean; best?: number };
  tradesToday: number;
  lastAdjustAt?: number;
  vwap?: HdVwapState;
  windowsDone: string[];
  suspendedDay?: string;
  /** The day's P&L baseline could not be priced at rollover; set from the first priced tick. */
  dayStartPending?: boolean;
  /** Last time an 'could not price' error was logged, so a stuck exit does not spam. */
  closeErrAt?: number;
  peakEquity: number;
  halved: boolean;
  longDebit: number;
  shortCredit: number;
  events: HdEvent[];
  updatedAt: number;
}

export interface HdQuote { ltp: number; deltaAbs?: number | null; spreadPct?: number | null }

export interface HdMarket {
  now: number;
  /** IST date yyyy-mm-dd and HH:MM. */
  day: string;
  hm: string;
  spot: number;
  step: number;
  lotSize: number;
  /** Listed expiries, ascending ISO dates. */
  expiries: string[];
  strikes: (expiry: string) => number[];
  quote: (expiry: string, strike: number, option: HdOption) => HdQuote | null;
  dte: (expiry: string) => number;
}

// ── small helpers ────────────────────────────────────────────────────────────

let legSeq = 0;
export function newId(prefix: string): string {
  legSeq += 1;
  return `${prefix}_${Date.now().toString(36)}${legSeq.toString(36)}`;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const px = (q: HdQuote | null | undefined): number | null => (q && finite(q.ltp) && q.ltp > 0 ? q.ltp : null);
const hmOf = (s: string): string => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
};

export function imbalancePct(a: number, b: number): number {
  const hi = Math.max(a, b);
  return hi > 0 ? (Math.abs(a - b) / hi) * 100 : 0;
}

export function atmStrike(spot: number, step: number): number {
  return Math.round(spot / step) * step;
}

export function isOpen(l: HdLeg): boolean {
  return l.openLots > 0;
}

/** ₹ P&L of a leg's open lots at `ltp`. */
export function legOpenPnl(l: HdLeg, ltp: number, lotSize: number): number {
  const perUnit = l.side === 'S' ? l.avgEntry - ltp : ltp - l.avgEntry;
  return perUnit * l.openLots * lotSize;
}

export function makeLeg(p: Partial<HdLeg> & Pick<HdLeg, 'option' | 'side'>): HdLeg {
  return {
    id: newId('leg'), role: 'main', expiry: '', strikeBy: 'ATM', strikeValue: 0, lots: 1,
    status: 'IDLE', openLots: 0, avgEntry: 0, realized: 0, reentries: 0, ...p,
  };
}

/** The leg rows a fresh algo starts with: what the strategy's readme enters, which the user edits. */
export function defaultLegs(kind: HdKind): HdLeg[] {
  switch (kind) {
    case 'imbalance_strangle':
      return [
        makeLeg({ option: 'CE', side: 'S', strikeBy: 'OFFSET', strikeValue: 200 }),
        makeLeg({ option: 'PE', side: 'S', strikeBy: 'OFFSET', strikeValue: 200 }),
      ];
    case 'diagonal_call':
      return [
        makeLeg({ option: 'CE', side: 'B', role: 'long', expiry: HD_EXPIRY_AUTO, strikeBy: 'DELTA', strikeValue: 0.6, lots: 3 }),
        makeLeg({ option: 'CE', side: 'S', role: 'short', expiry: HD_EXPIRY_AUTO, strikeBy: 'DELTA', strikeValue: 0.18, lots: 0 }),
      ];
    default:
      return [
        makeLeg({ option: 'CE', side: 'S' }),
        makeLeg({ option: 'PE', side: 'S' }),
      ];
  }
}

export function newAlgo(kind: HdKind, underlying: HdUnderlying, name?: string, now: number = Date.now()): HdAlgo {
  return {
    v: 1, id: newId('algo'), name: name ?? HD_KIND_META[kind].label, kind, underlying,
    product: HD_KIND_META[kind].product, armed: false, phase: 'ACTIVE',
    controls: defaultControls(kind), legs: defaultLegs(kind), cycle: 1,
    refPremiumRs: 0, cumRealized: 0, dayStartPnl: 0, day: '', peakMtm: 0, trail: { armed: false },
    tradesToday: 0, windowsDone: [], peakEquity: 0, halved: false, longDebit: 0, shortCredit: 0,
    events: [], updatedAt: now,
  };
}

export function resolveExpiry(rule: string, m: HdMarket): string {
  if (rule && rule !== HD_EXPIRY_AUTO) return rule;
  return m.expiries[0] ?? '';
}

const expOf = (l: HdLeg, m: HdMarket): string => l.expiryUsed ?? resolveExpiry(l.expiry, m);

/** Strike a leg row would trade now, with its price. Null when the feed cannot price it. */
export function resolveStrike(
  l: Pick<HdLeg, 'option' | 'strikeBy' | 'strikeValue'>, m: HdMarket, expiry: string,
): { strike: number; ltp: number; deltaAbs: number | null } | null {
  if (!expiry || !(m.spot > 0) || !(m.step > 0)) return null;
  const atm = atmStrike(m.spot, m.step);
  const grab = (strike: number) => {
    const q = m.quote(expiry, strike, l.option);
    const p = px(q);
    return p == null ? null : { strike, ltp: p, deltaAbs: q && finite(q.deltaAbs) ? q.deltaAbs : null };
  };
  if (l.strikeBy === 'ATM') return grab(atm);
  if (l.strikeBy === 'OFFSET') {
    const target = l.option === 'CE' ? m.spot + l.strikeValue : m.spot - l.strikeValue;
    return grab(atmStrike(target, m.step));
  }
  // DELTA / PREMIUM: closest OTM strike to the target.
  let best: { strike: number; ltp: number; deltaAbs: number | null; err: number } | null = null;
  for (const k of m.strikes(expiry)) {
    if (l.option === 'CE' ? k < atm : k > atm) continue;
    const g = grab(k);
    if (!g) continue;
    let err: number;
    if (l.strikeBy === 'DELTA') {
      if (g.deltaAbs == null) continue;
      err = Math.abs(g.deltaAbs - l.strikeValue);
    } else {
      err = Math.abs(g.ltp - l.strikeValue);
    }
    if (!best || err < best.err) best = { ...g, err };
  }
  return best ? { strike: best.strike, ltp: best.ltp, deltaAbs: best.deltaAbs } : null;
}

/** Closest strike to a target delta, inside [lo, hi]. Nothing is traded outside the band. */
export function pickDeltaStrike(
  m: HdMarket, expiry: string, option: HdOption, target: number, lo: number, hi: number,
): { strike: number; ltp: number; deltaAbs: number } | null {
  let best: { strike: number; ltp: number; deltaAbs: number; err: number } | null = null;
  for (const k of m.strikes(expiry)) {
    const q = m.quote(expiry, k, option);
    const p = px(q);
    if (p == null || !q || !finite(q.deltaAbs)) continue;
    const d = q.deltaAbs;
    if (d < lo - 1e-9 || d > hi + 1e-9) continue;
    const err = Math.abs(d - target);
    if (!best || err < best.err) best = { strike: k, ltp: p, deltaAbs: d, err };
  }
  return best ? { strike: best.strike, ltp: best.ltp, deltaAbs: best.deltaAbs } : null;
}

/** Expiry whose DTE sits in [min, max] and is closest to the middle; optionally ending before `before`. */
export function pickExpiryByDte(m: HdMarket, min: number, max: number, before?: string): string | null {
  const mid = (min + max) / 2;
  let best: { e: string; err: number } | null = null;
  for (const e of m.expiries) {
    const d = m.dte(e);
    if (d < min || d > max) continue;
    if (before && !(e < before)) continue;
    const err = Math.abs(d - mid);
    if (!best || err < best.err) best = { e, err };
  }
  return best?.e ?? null;
}

/** Short lots for the diagonal: net delta lands on the target, capped by lots and by the delta ratio. */
export function sizeShortLots(p: {
  longLots: number; longDeltaAbs: number; shortDeltaAbs: number; lotSize: number;
  targetNetDelta: number; maxShortLots: number; maxShortRatio: number; free: boolean;
}): number {
  const perShort = p.shortDeltaAbs * p.lotSize;
  const longTotal = p.longDeltaAbs * p.longLots * p.lotSize;
  if (!(perShort > 0) || !(longTotal > 0)) return 0;
  let k = Math.round((longTotal - p.targetNetDelta) / perShort);
  k = Math.min(k, Math.floor((p.maxShortRatio * longTotal) / perShort + 1e-9), p.maxShortLots);
  if (p.free) k = Math.floor(k / 2) || (k > 0 ? 1 : 0);
  return Math.max(0, k);
}

/** ₹ limit for a target / stop control: ₹ as typed, or % of the entry premium (of capital for the diagonal). */
export function limitRs(a: Pick<HdAlgo, 'kind' | 'controls' | 'refPremiumRs'>, valueKey: string, unitKey: string): number {
  const v = numCtl(a.controls, valueKey);
  if (!(v > 0)) return 0;
  if (strCtl(a.controls, unitKey, 'rs') !== 'pct') return v;
  const base = a.kind === 'diagonal_call' ? numCtl(a.controls, 'capital') : a.refPremiumRs;
  return base > 0 ? (v / 100) * base : 0;
}

function quoteOf(l: HdLeg, m: HdMarket): HdQuote | null {
  if (l.strike == null) return null;
  return m.quote(expOf(l, m), l.strike, l.option);
}

/** ₹ MTM of the current cycle (banked leg P&L + open legs). Null while an open leg has no price.
 *  `lastKnown` marks an unpriced leg at its last good price instead: used by the risk exits, so one
 *  missing quote (a far hedge wing) cannot switch every stop off. Display and entries stay strict. */
export function cycleMtm(a: Pick<HdAlgo, 'legs'>, m: HdMarket, lastKnown = false): number | null {
  let total = 0;
  for (const l of a.legs) {
    total += l.realized;
    if (!isOpen(l)) continue;
    const p = px(quoteOf(l, m)) ?? (lastKnown && l.lastPx != null && l.lastPx > 0 ? l.lastPx : null);
    if (p == null) return null;
    total += legOpenPnl(l, p, m.lotSize);
  }
  return total;
}

export function totalPnl(a: HdAlgo, m: HdMarket): number | null {
  const mtm = cycleMtm(a, m);
  return mtm == null ? null : a.cumRealized + mtm;
}

export function dayPnl(a: HdAlgo, m: HdMarket): number | null {
  const t = totalPnl(a, m);
  return t == null ? null : t - a.dayStartPnl;
}

// ── the engine ───────────────────────────────────────────────────────────────

export interface HdResult { algo: HdAlgo; notes: string[]; changed: boolean }

/** Mutating helpers over one algo clone. Shared by the tick and by the manual buttons. */
function session(a: HdAlgo, m: HdMarket) {
  const c = a.controls;
  const notes: string[] = [];
  let changed = false;
  const touch = () => { changed = true; };

  const ev = (k: string, msg: string, note = true) => {
    // A skip that persists (no strike in the band, no price yet) is logged once a minute, not every tick: an
    // event also triggers an immediate save and would push real history out of the capped log.
    if (k === 'SKIP') {
      const last = [...a.events].reverse().find((e) => e.k === 'SKIP' && e.msg === msg);
      if (last && m.now - last.t < 60_000) return;
    }
    a.events.push({ t: m.now, k, msg });
    if (a.events.length > HD_EVENT_CAP) a.events.splice(0, a.events.length - HD_EVENT_CAP);
    if (note) notes.push(msg);
    touch();
  };

  const openLegs = () => a.legs.filter(isOpen);
  /** Open legs that are not the desk's own hedge wings: a cycle with only a wing left is over. */
  const liveLegs = () => a.legs.filter((l) => isOpen(l) && l.role !== 'hedge');
  const mainOpen = (o: HdOption) => a.legs.find((l) => l.role === 'main' && l.option === o && l.side === 'S' && isOpen(l));
  const lotsFor = (l: HdLeg) => Math.max(0, Math.min(HD_MAX_LOTS, Math.floor(l.lots)));

  /** Open (or add to) a leg at `ltp`. */
  const fill = (l: HdLeg, strike: number, expiry: string, ltp: number, lots: number, deltaAbs?: number | null) => {
    const total = l.openLots + lots;
    l.avgEntry = total > 0 ? (l.avgEntry * l.openLots + ltp * lots) / total : ltp;
    l.openLots = total;
    l.status = 'OPEN';
    l.strike = strike;
    l.expiryUsed = expiry;
    l.lastPx = ltp;
    l.waitingReentry = false;
    l.reentryPx = undefined;
    l.exitReason = undefined;
    if (l.firstEntry == null) l.firstEntry = ltp;
    if (l.entryDelta == null && finite(deltaAbs)) l.entryDelta = deltaAbs;
    l.openedAt = l.openedAt ?? m.now;
    if (l.side === 'S' && l.role === 'short') a.shortCredit += ltp * lots * m.lotSize;
    if (l.role === 'long') a.longDebit += ltp * lots * m.lotSize;
    touch();
  };

  /** Close `lots` of a leg at its price (last known price as a fallback, so a stop is never skipped). */
  const unfill = (l: HdLeg, lots: number, reason: string, fallbackToLast = true): boolean => {
    if (!isOpen(l)) return true;
    const n = Math.min(lots, l.openLots);
    const p = px(quoteOf(l, m)) ?? (fallbackToLast ? l.lastPx ?? null : null);
    if (p == null || n <= 0) return false;
    const perUnit = l.side === 'S' ? l.avgEntry - p : p - l.avgEntry;
    l.realized += perUnit * n * m.lotSize;
    l.openLots -= n;
    l.lastPx = p;
    if (l.openLots <= 0) {
      l.openLots = 0;
      l.status = 'CLOSED';
      l.exitReason = reason;
    }
    touch();
    return true;
  };

  const endCycleState = () => {
    for (const l of a.legs) {
      l.status = 'IDLE';
      l.strike = undefined;
      l.expiryUsed = undefined;
      l.openLots = 0;
      l.avgEntry = 0;
      l.firstEntry = undefined;
      l.entryDelta = undefined;
      l.realized = 0;
      l.waitingReentry = false;
      l.reentryPx = undefined;
      l.exitReason = undefined;
      l.reentries = 0;
      l.openedAt = undefined;
    }
    a.legs = a.legs.filter((l) => !l.auto);
    a.entry = undefined;
    a.peakMtm = 0;
    a.trail = { armed: false };
    a.lastAdjustAt = undefined;
    touch();
  };

  /** Close every open leg (shorts before longs), bank the cycle, and move to `phase`. */
  const closeAll = (reason: string, opts: { phase: HdPhase; pauseMs?: number; disarm?: boolean }) => {
    const order = [...openLegs()].sort((x, y) => (x.side === 'B' ? 1 : 0) - (y.side === 'B' ? 1 : 0));
    for (const l of order) unfill(l, l.openLots, reason);
    const stuck = a.legs.filter(isOpen);
    if (stuck.length) {
      // Retried every tick; log it once a minute so the event cap and the toasts are not flooded.
      if (a.closeErrAt == null || m.now - a.closeErrAt >= 60_000) {
        a.closeErrAt = m.now;
        ev('ERROR', `Could not price ${stuck.length} leg(s) to close — they stay open and will be retried`);
      }
      return false;
    }
    a.closeErrAt = undefined;
    const pnl = a.legs.reduce((s, l) => s + l.realized, 0);
    a.cumRealized += pnl;
    ev('EXIT', `${reason}: cycle ${a.cycle} closed, P&L ${fmtRs(pnl)}`);
    endCycleState();
    // A pause is only enforced in the PAUSED phase, so any exit with a pause goes there.
    a.phase = opts.phase === 'DONE' ? 'DONE' : opts.pauseMs ? 'PAUSED' : 'ACTIVE';
    a.pausedUntil = a.phase === 'PAUSED' ? m.now + (opts.pauseMs ?? 0) : undefined;
    if (opts.disarm) a.armed = false;
    a.cycle += 1;
    return true;
  };

  const baseline = (): HdEntryBaseline | undefined => {
    const ce = a.legs.find((l) => l.role === 'main' && l.option === 'CE' && l.side === 'S' && isOpen(l));
    const pe = a.legs.find((l) => l.role === 'main' && l.option === 'PE' && l.side === 'S' && isOpen(l));
    const shorts = a.legs.filter((l) => l.side === 'S' && isOpen(l));
    if (!shorts.length) return undefined;
    const cq = ce ? px(quoteOf(ce, m)) : null;
    const pq = pe ? px(quoteOf(pe, m)) : null;
    return {
      imbalance: cq != null && pq != null ? imbalancePct(cq, pq) : 0,
      atm: atmStrike(m.spot, m.step),
      ceStrike: ce?.strike, peStrike: pe?.strike,
      premiumUnits: shorts.reduce((s, l) => s + l.avgEntry, 0),
      premiumRs: shorts.reduce((s, l) => s + l.avgEntry * l.openLots * m.lotSize, 0),
      at: m.now,
    };
  };

  const noteEntry = () => {
    const b = baseline();
    if (!b) return;
    a.entry = b;
    a.refPremiumRs = b.premiumRs;
    a.tradesToday += 1;
    a.peakMtm = 0;
    a.trail = { armed: false };
    touch();
  };

  /** Enter one leg now. Used by the entry plan, by re-entries and by the per-row button. */
  const enterLeg = (l: HdLeg, opts: { strike?: number; lots?: number; expiry?: string } = {}): boolean => {
    if (isOpen(l)) return false;
    const exp = opts.expiry ?? (opts.strike != null && l.expiryUsed ? l.expiryUsed : resolveExpiry(l.expiry, m));
    let strike = opts.strike;
    let ltp: number | null = null;
    let d: number | null = null;
    if (strike != null) {
      const q = m.quote(exp, strike, l.option);
      ltp = px(q);
      d = q && finite(q.deltaAbs) ? q.deltaAbs : null;
    } else {
      const r = resolveStrike(l, m, exp);
      if (r) { strike = r.strike; ltp = r.ltp; d = r.deltaAbs; }
    }
    const lots = opts.lots ?? lotsFor(l);
    if (strike == null || ltp == null || lots <= 0) {
      ev('SKIP', `${l.option} ${l.side === 'S' ? 'sell' : 'buy'}: no price for the strike yet`, false);
      return false;
    }
    fill(l, strike, exp, ltp, lots, d);
    ev('ENTER', `${l.side === 'S' ? 'Sold' : 'Bought'} ${lots}L ${l.option} ${strike} @ ${ltp.toFixed(2)}`);
    return true;
  };

  return { c, notes, ev, touch, openLegs, liveLegs, mainOpen, lotsFor, fill, unfill, closeAll, baseline, noteEntry, enterLeg, endCycleState, isChanged: () => changed };
}

export const fmtRs = (n: number): string => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/** True when entering these strikes would cross the CE and PE legs (strangle: equal strikes count too). */
export function entryInverted(a: Pick<HdAlgo, 'kind' | 'legs' | 'controls'>, ceStrike: number, peStrike: number): boolean {
  if (!boolCtl(a.controls, 'inversionGuard', false)) return false;
  if (a.kind === 'imbalance_strangle') return ceStrike <= peStrike;
  if (a.kind === 'advanced_imbalance') {
    const atmOnly = a.legs.filter((l) => l.role === 'main').every((l) => l.strikeBy === 'ATM');
    return atmOnly ? ceStrike < peStrike : ceStrike <= peStrike;
  }
  return ceStrike < peStrike;
}

/** Resolve strikes for every idle entry leg and report the first thing that blocks entering. */
function planEntry(a: HdAlgo, m: HdMarket, force: boolean): {
  ok: boolean; reason?: string; plan: { leg: HdLeg; strike: number; ltp: number; expiry: string }[];
} {
  const c = a.controls;
  const start = hmOf(strCtl(c, 'startTime', '09:20'));
  if (!force && start && m.hm < start) return { ok: false, reason: `before start ${start}`, plan: [] };
  const legs = a.legs.filter((l) => l.status !== 'OPEN' && l.role !== 'hedge' && !l.waitingReentry);
  const plan: { leg: HdLeg; strike: number; ltp: number; expiry: string }[] = [];
  for (const l of legs) {
    const exp = resolveExpiry(l.expiry, m);
    const r = resolveStrike(l, m, exp);
    if (!r) return { ok: false, reason: `no price for ${l.option} ${l.strikeBy.toLowerCase()} leg`, plan: [] };
    plan.push({ leg: l, strike: r.strike, ltp: r.ltp, expiry: exp });
  }
  if (!plan.length) return { ok: false, reason: 'no legs to enter', plan };
  const ceP = plan.find((p) => p.leg.role === 'main' && p.leg.option === 'CE' && p.leg.side === 'S');
  const peP = plan.find((p) => p.leg.role === 'main' && p.leg.option === 'PE' && p.leg.side === 'S');
  if (ceP && peP) {
    if (entryInverted(a, ceP.strike, peP.strike)) return { ok: false, reason: `inverted strikes CE ${ceP.strike} / PE ${peP.strike}`, plan: [] };
    if (!force && hasCtl(c, 'entryBalancePct')) {
      const imb = imbalancePct(ceP.ltp, peP.ltp);
      const thr = numCtl(c, 'entryBalancePct');
      if (!(imb < thr)) return { ok: false, reason: `CE/PE gap ${imb.toFixed(1)}% ≥ ${thr}%`, plan: [] };
    }
  }
  return { ok: true, plan };
}

/** One engine tick. Always returns a fresh copy (or `prev` when there is no price at all): the trail peak, VWAP
 *  bars and last prices live on it and must persist even on a tick with no event. */
export function stepAlgo(prev: HdAlgo, m: HdMarket): HdAlgo {
  if (!(m.spot > 0) || !(m.lotSize > 0)) return prev;
  const a: HdAlgo = structuredClone(prev);
  const s = session(a, m);
  const { c, ev, touch } = s;

  // ── day rollover ──
  if (a.day !== m.day) {
    const wasInit = a.day === '';
    a.day = m.day;
    a.tradesToday = 0;
    a.windowsDone = [];
    a.suspendedDay = undefined;
    a.peakEquity = Math.max(a.peakEquity, 0);
    if (!wasInit && a.phase === 'DONE') a.phase = 'ACTIVE';
    const t = cycleMtm(a, m, true);
    a.dayStartPnl = a.cumRealized + (t ?? 0);
    a.dayStartPending = t == null && s.openLegs().length > 0;
    touch();
    if (!wasInit && a.product === 'INTRADAY' && s.openLegs().length) {
      s.closeAll('previous session left open', { phase: 'ACTIVE' });
    }
  }

  if (a.phase === 'PAUSED' && a.pausedUntil != null && m.now >= a.pausedUntil) {
    a.phase = 'ACTIVE';
    a.pausedUntil = undefined;
    ev('RESUME', 'Pause over — ready for a fresh cycle', false);
  }
  if (a.phase === 'DONE') return s.isChanged() ? a : prev;

  const open = s.openLegs();
  const kind = a.kind;
  const squareOff = hmOf(strCtl(c, 'squareOffTime'));

  // ── VWAP bookkeeping (before any gate that reads it) ──
  if (kind === 'vwap_straddle') trackVwap(a, m);

  // ── risk exits: run armed or not, only ever reduce exposure ──
  const cycleLive = open.length > 0 || a.legs.some((l) => l.waitingReentry || l.realized !== 0);
  if (a.product === 'INTRADAY' && squareOff && m.hm >= squareOff && cycleLive) {
    s.closeAll(`square-off ${squareOff}`, { phase: 'DONE' });
    return a;
  }
  if (open.length) {
    for (const l of open) {
      const p = px(quoteOf(l, m));
      if (p != null) l.lastPx = p;
    }
    // An unpriced leg is marked at its last good price here, so one missing quote never switches the stops off.
    let mtm = cycleMtm(a, m, true);
    if (a.dayStartPending) {
      const strict = cycleMtm(a, m);
      if (strict != null) { a.dayStartPnl = a.cumRealized + strict; a.dayStartPending = false; }
    }
    if (mtm != null) {
      a.peakMtm = Math.max(a.peakMtm, mtm);
      const day = a.cumRealized + mtm - a.dayStartPnl;
      const targetRs = limitRs(a, 'targetProfit', 'targetUnit');
      const stopRs = limitRs(a, 'stopLoss', 'stopUnit');
      // The day baseline is not trustworthy until it has been priced once.
      if (!a.dayStartPending) {
        if (targetRs > 0 && day >= targetRs) { s.closeAll(`daily target ${fmtRs(targetRs)} reached`, { phase: 'DONE' }); return a; }
        if (stopRs > 0 && day <= -stopRs) { s.closeAll(`daily stop ${fmtRs(stopRs)} hit`, { phase: 'DONE' }); return a; }
      }
    }
    if (kind === 'diagonal_call') {
      if (mtm != null && diagonalRisk(a, m, s, mtm)) return a;
    } else {
      if (legRules(a, m, s)) {
        // A leg stopped out. With nothing left open and no re-entry waiting the cycle is over.
        if (!s.liveLegs().length && !a.legs.some((l) => l.waitingReentry)) {
          s.closeAll('all legs stopped', { phase: 'PAUSED', pauseMs: numCtl(c, 'cyclePauseMin') * 60_000 });
          return a;
        }
        mtm = cycleMtm(a, m, true);
      }
      if (mtm != null && cycleRisk(a, m, s, mtm)) return a;
    }
  }

  // ── everything below acts: needs the algo armed and a running phase ──
  if (a.armed && a.phase === 'ACTIVE') {
    if (kind === 'diagonal_call') {
      diagonalAct(a, m, s);
    } else if (kind === 'vwap_straddle') {
      vwapAct(a, m, s);
    } else {
      if (s.liveLegs().length) {
        balanceStep(a, m, s);
      } else if (!a.legs.some((l) => l.waitingReentry)) {
        const plan = planEntry(a, m, false);
        const pastOff = a.product === 'INTRADAY' && squareOff && m.hm >= squareOff;
        if (plan.ok && !pastOff) enterPlan(a, m, s, plan.plan);
      }
      reentries(a, m, s);
    }
  }

  // The clone always comes back: the trail peak, VWAP bars and last prices live on it and must persist.
  return a;
}

function enterPlan(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>, plan: { leg: HdLeg; strike: number; expiry: string }[]) {
  for (const p of plan) s.enterLeg(p.leg, { strike: p.strike, expiry: p.expiry });
  if (s.openLegs().length) s.noteEntry();
}

// ── leg-level rules (SL, target, re-entry) ───────────────────────────────────

function effSl(a: HdAlgo, l: HdLeg): number {
  if (l.slPct != null && l.slPct > 0) return l.slPct;
  if (a.kind === 'advanced_imbalance' && l.role === 'main' && strCtl(a.controls, 'adjustMode') === 'reentry_straddle') return numCtl(a.controls, 'legSlPct');
  return 0;
}
function effReentry(a: HdAlgo, l: HdLeg): boolean {
  if (l.reentry != null) return l.reentry;
  return a.kind === 'advanced_imbalance' && l.role === 'main' && strCtl(a.controls, 'adjustMode') === 'reentry_straddle';
}

/** Per-leg stop / target. Returns true if a leg was exited. */
function legRules(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>): boolean {
  let any = false;
  for (const l of a.legs) {
    if (!isOpen(l) || l.role === 'hedge' || l.role === 'long') continue;
    const p = px(quoteOf(l, m));
    if (p == null) continue;
    l.lastPx = p;
    const sl = effSl(a, l);
    const tg = l.tgtPct ?? 0;
    let why = '';
    if (sl > 0) {
      const lvl = l.side === 'S' ? l.avgEntry * (1 + sl / 100) : l.avgEntry * (1 - sl / 100);
      if (l.side === 'S' ? p >= lvl : p <= lvl) why = 'SL';
    }
    if (!why && tg > 0) {
      const lvl = l.side === 'S' ? l.avgEntry * (1 - tg / 100) : l.avgEntry * (1 + tg / 100);
      if (l.side === 'S' ? p <= lvl : p >= lvl) why = 'TARGET';
    }
    if (!why) continue;
    const first = l.firstEntry ?? l.avgEntry;
    s.unfill(l, l.openLots, why);
    s.ev('LEG_EXIT', `${l.option} ${l.strike} ${why} @ ${p.toFixed(2)}`);
    if (effReentry(a, l)) { l.waitingReentry = true; l.reentryPx = first; }
    any = true;
  }
  return any;
}

function reentries(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>) {
  for (const l of a.legs) {
    if (!l.waitingReentry || l.reentryPx == null || l.strike == null || isOpen(l)) continue;
    const p = px(quoteOf(l, m));
    if (p == null) continue;
    const back = l.side === 'S' ? p <= l.reentryPx : p >= l.reentryPx;
    if (!back) continue;
    const trigger = l.reentryPx;
    if (s.enterLeg(l, { strike: l.strike })) {
      l.reentries += 1;
      s.ev('REENTRY', `${l.option} ${l.strike} re-entered (price back to ${trigger.toFixed(2)})`);
    }
  }
}

// ── cycle-level risk (imbalance family + vwap) ───────────────────────────────

function cycleRisk(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>, mtm: number): boolean {
  const c = a.controls;
  const pause = numCtl(c, 'cyclePauseMin', 0) * 60_000;

  // VWAP exit: buy back when the combined premium rises above VWAP + buffer
  if (a.kind === 'vwap_straddle' && a.vwap && a.vwap.cur > 0) {
    const vw = vwapOf(a.vwap);
    const buffer = numCtl(c, 'exitBuffer');
    if (a.vwap.cur > vw + buffer) {
      const cool = mtm < 0 ? numCtl(c, 'cooldownSeconds') * 1000 : 0;
      return s.closeAll(`premium ${a.vwap.cur.toFixed(1)} above VWAP ${vw.toFixed(1)} + ${buffer}`, cool ? { phase: 'PAUSED', pauseMs: cool } : { phase: 'ACTIVE' }) || true;
    }
  }

  // per-trade hard stop (VWAP)
  const maxLoss = numCtl(c, 'maxLossPerTrade');
  if (maxLoss > 0 && mtm <= -maxLoss) return s.closeAll(`max loss per trade ${fmtRs(maxLoss)}`, { phase: 'ACTIVE', pauseMs: numCtl(c, 'cooldownSeconds') * 1000 }) || true;

  // scalp lock
  const scalp = numCtl(c, 'scalpFloorPct');
  const scalpBasis = a.legs.filter((l) => l.side === 'S' && l.role === 'main' && isOpen(l))
    .reduce((x, l) => x + (l.firstEntry ?? l.avgEntry) * l.openLots * m.lotSize, 0);
  if (scalp > 0 && scalpBasis > 0 && mtm >= (scalp / 100) * scalpBasis) {
    const multi = boolCtl(c, 'multiCycle');
    return s.closeAll(`scalp lock ${scalp}%`, multi
      ? { phase: 'PAUSED', pauseMs: numCtl(c, 'cycleCooldownSec') * 1000 }
      : { phase: 'DONE' }) || true;
  }

  // rupee trail on MTM
  const trailStart = numCtl(c, 'trailStartRs');
  const trailGap = numCtl(c, 'trailGapRs');
  if (trailStart > 0 && trailGap > 0 && a.peakMtm >= trailStart && mtm <= a.peakMtm - trailGap) {
    return s.closeAll(`trail: gave back ${fmtRs(a.peakMtm - mtm)} from ${fmtRs(a.peakMtm)}`, { phase: 'PAUSED', pauseMs: pause }) || true;
  }

  // premium trail on the combined short premium
  const tStartPct = numCtl(c, 'trailStartPct');
  const tGapPts = numCtl(c, 'trailGapPts');
  if (tStartPct > 0 && tGapPts > 0 && a.entry && a.entry.premiumUnits > 0) {
    const shorts = a.legs.filter((l) => l.side === 'S' && isOpen(l) && l.role === 'main');
    const prices = shorts.map((l) => px(quoteOf(l, m)));
    if (shorts.length && prices.every((p) => p != null)) {
      const cur = (prices as number[]).reduce((x, y) => x + y, 0);
      const profitPct = ((a.entry.premiumUnits - cur) / a.entry.premiumUnits) * 100;
      if (profitPct >= tStartPct) a.trail.armed = true;
      if (a.trail.armed) {
        a.trail.best = a.trail.best == null ? cur : Math.min(a.trail.best, cur);
        if (cur >= a.trail.best + tGapPts) {
          return s.closeAll(`premium trail: ${cur.toFixed(1)} is ${tGapPts} above best ${a.trail.best.toFixed(1)}`, { phase: 'PAUSED', pauseMs: pause }) || true;
        }
      }
    }
  }

  // cycle reset: straddle ATM drift from the entry strike / strangle strike-boundary breach
  if (a.kind !== 'vwap_straddle' && a.entry) {
    const ce = s.mainOpen('CE');
    const pe = s.mainOpen('PE');
    const straddleLike = a.entry.ceStrike != null && a.entry.ceStrike === a.entry.peStrike;
    if (straddleLike || a.kind === 'imbalance_straddle') {
      const shift = numCtl(c, 'straddleShiftPts');
      const from = a.entry.ceStrike ?? a.entry.atm;
      const now = atmStrike(m.spot, m.step);
      if (shift > 0 && Math.abs(now - from) >= shift) {
        return s.closeAll(`ATM ${now} shifted ${Math.abs(now - from)} pts from ${from} — cycle reset`, { phase: 'PAUSED', pauseMs: pause }) || true;
      }
    } else if (ce?.strike != null && pe?.strike != null) {
      // A strike rolled closer to ATM gets a 100-pt buffer for market wiggles (STRANGLE_INNER_BUFFER).
      const upper = a.entry.ceStrike != null && ce.strike < a.entry.ceStrike ? ce.strike + 100 : ce.strike;
      const lower = a.entry.peStrike != null && pe.strike > a.entry.peStrike ? pe.strike - 100 : pe.strike;
      if (m.spot >= upper || m.spot <= lower) {
        return s.closeAll(`spot ${m.spot.toFixed(0)} breached the strike boundary ${lower}-${upper} — cycle reset`, { phase: 'PAUSED', pauseMs: pause }) || true;
      }
    }
  }
  return false;
}

// ── value balancing (imbalance family) ───────────────────────────────────────
// Mirrors the scripts: a leg's VALUE is lots × price, the imbalance is |CE value − PE value| / max,
// the winner is the lower-value (decayed) leg, the trigger is imbalance > baseline + threshold, the
// threshold is the wider strike one once a leg sits at max lots, at most one adjustment fires per
// bar, and the baseline is re-measured after every adjustment.

function legValue(l: HdLeg, ltp: number): number {
  return l.openLots * ltp;
}

function balanceStep(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>) {
  const c = a.controls;
  const mode = a.kind === 'advanced_imbalance' ? strCtl(c, 'adjustMode', 'winner_roll_atm') : 'value_balance';
  if (mode === 'reentry_straddle') return;
  const ce = s.mainOpen('CE');
  const pe = s.mainOpen('PE');
  if (!ce || !pe || !a.entry) return;
  const cool = numCtl(c, 'adjustCooldownSec') * 1000;
  if (a.lastAdjustAt != null && m.now - a.lastAdjustAt < cool) return;
  const cp = px(quoteOf(ce, m));
  const pp = px(quoteOf(pe, m));
  if (cp == null || pp == null) return;

  const maxLots = Math.min(HD_MAX_LOTS, numCtl(c, 'maxLots', 4));
  const ceVal = legValue(ce, cp);
  const peVal = legValue(pe, pp);
  const imb = imbalancePct(ceVal, peVal);
  const atMax = ce.openLots >= maxLots || pe.openLots >= maxLots;
  const thr = (atMax ? numCtl(c, 'thresholdStrikePct') : numCtl(c, 'thresholdLotPct')) + a.entry.imbalance;
  if (!(imb > thr)) return;

  const winner = ceVal < peVal ? ce : pe;
  const loser = winner === ce ? pe : ce;
  const wp = winner === ce ? cp : pp;
  const winnerVal = winner === ce ? ceVal : peVal;
  const loserVal = winner === ce ? peVal : ceVal;
  const guard = boolCtl(c, 'inversionGuard', false);
  const pause = numCtl(c, 'cyclePauseMin') * 60_000;
  const endCycle = (why: string) => { s.closeAll(why, { phase: 'PAUSED', pauseMs: pause }); };

  /** Re-measure the baseline and stamp the bar, as update_baseline_imbalance() does. */
  const done = () => {
    a.lastAdjustAt = m.now;
    const c2 = px(quoteOf(ce, m));
    const p2 = px(quoteOf(pe, m));
    if (a.entry && c2 != null && p2 != null && ce.openLots > 0 && pe.openLots > 0) {
      a.entry.imbalance = imbalancePct(legValue(ce, c2), legValue(pe, p2));
    }
    s.touch();
  };

  const addWinner = (hedged: boolean) => {
    if (winner.openLots >= maxLots) { endCycle(`${winner.option} already at max lots (${maxLots})`); return; }
    let hq: number | null = null;
    let hedgeStrike: number | null = null;
    if (hedged) {
      hedgeStrike = winner.option === 'CE' ? winner.strike! + numCtl(c, 'hedgeDistance') : winner.strike! - numCtl(c, 'hedgeDistance');
      hq = px(m.quote(expOf(winner, m), hedgeStrike, winner.option));
      if (hq == null) { s.ev('SKIP', `Hedge ${winner.option} ${hedgeStrike} has no price — lot not added`, false); done(); return; }
    }
    s.fill(winner, winner.strike!, expOf(winner, m), wp, 1);
    s.ev('ADD', `Imbalance ${imb.toFixed(1)}% > ${thr.toFixed(1)}% — sold +1L ${winner.option} ${winner.strike} @ ${wp.toFixed(2)} (now ${winner.openLots}L)`);
    if (hedgeStrike != null && hq != null) {
      let h = a.legs.find((l) => l.auto && l.option === winner.option && l.strike === hedgeStrike);
      if (!h) {
        h = makeLeg({ option: winner.option, side: 'B', role: 'hedge', auto: true, lots: 1 });
        a.legs.push(h);
      }
      s.fill(h, hedgeStrike, expOf(winner, m), hq, 1);
      s.ev('HEDGE', `Bought +1L ${h.option} ${hedgeStrike} hedge @ ${hq.toFixed(2)}`);
    }
    done();
  };

  /** Move `leg` to the OTM strike whose price is closest to `targetPrice`. True if the cycle ended. */
  const rollTo = (leg: HdLeg, newLots: number, targetPrice: number, label: string, closer: boolean): boolean => {
    const exp = expOf(leg, m);
    const other = leg === ce ? pe : ce;
    let best: { k: number; p: number; err: number } | null = null;
    for (const k of m.strikes(exp)) {
      if (leg.option === 'CE' ? k <= m.spot : k >= m.spot) continue;                 // OTM of spot only
      if (closer && (leg.option === 'CE' ? k >= leg.strike! : k <= leg.strike!)) continue;
      const p = px(m.quote(exp, k, leg.option));
      if (p == null) continue;
      const err = Math.abs(p - targetPrice);
      if (!best || err < best.err) best = { k, p, err };
    }
    if (!best) { s.ev('SKIP', `No OTM ${leg.option} strike to roll to`, false); done(); return false; }
    if (best.k === leg.strike) { s.ev('SKIP', `${leg.option} ${leg.strike} is already the value-matched strike`, false); done(); return false; }
    if (guard && (leg.option === 'CE' ? best.k <= other.strike! : best.k >= other.strike!)) {
      endCycle(`Blocked inversion: new ${leg.option} strike ${best.k} would cross/equal ${other.option} ${other.strike}`);
      return true;
    }
    const old = leg.strike!;
    s.unfill(leg, leg.openLots, 'ROLL');
    leg.status = 'IDLE';
    leg.openLots = 0;
    leg.avgEntry = 0;
    leg.firstEntry = undefined;
    s.fill(leg, best.k, exp, best.p, newLots);
    s.ev('ROLL', `Imbalance ${imb.toFixed(1)}% > ${thr.toFixed(1)}% — ${label}: ${leg.option} ${old} → ${best.k} (${newLots}L @ ${best.p.toFixed(2)}, target ${targetPrice.toFixed(2)})`);
    done();
    return false;
  };

  if (mode === 'winner_roll_atm') {
    // Rolling the winner toward ATM must not cross the other leg: nothing left to roll into = deadlock.
    const step = m.step;
    if (winner.option === 'PE' ? winner.strike! + step >= ce.strike! : winner.strike! - step <= pe.strike!) {
      endCycle(`Structural deadlock: ${winner.option} ${winner.strike} has no room to roll toward ATM`);
      return;
    }
    rollTo(winner, winner.openLots, loserVal / winner.openLots, 'winner roll', true);
    return;
  }
  if (mode === 'loser_ratio_roll') {
    const newLots = Math.min(maxLots, loser.openLots + numCtl(c, 'loserRatioLots', 1));
    if (newLots === loser.openLots) { endCycle(`Loser already at max lots (${maxLots})`); return; }
    rollTo(loser, newLots, winnerVal / newLots, 'loser ratio roll', false);
    return;
  }
  if (mode === 'hedged_addition' || mode === 'legacy') { addWinner(mode === 'hedged_addition'); return; }

  // Value-imbalance straddle / strangle: add lots to the winner, then roll the loser at max lots.
  if (winner.openLots < maxLots) { addWinner(false); return; }
  rollTo(loser, loser.openLots, winnerVal / loser.openLots, 'strike adjustment', false);
}

// ── VWAP straddle ────────────────────────────────────────────────────────────

/** Session VWAP of the combined premium, from the desk's own 1-minute bars. The feed carries no
 *  per-bar volume to the page, so the bars are weighted equally: the mean of the bar closes. */
export function vwapOf(v: HdVwapState): number {
  const all = [...v.bars, v.cur].filter((x) => x > 0);
  return all.length ? all.reduce((x, y) => x + y, 0) / all.length : 0;
}

function trackVwap(a: HdAlgo, m: HdMarket) {
  const exp = resolveExpiry(a.legs.find((l) => l.role === 'main')?.expiry ?? '', m);
  const openLeg = a.legs.find(isOpen);
  const strike = openLeg?.strike ?? atmStrike(m.spot, m.step);
  if (!a.vwap || (!openLeg && a.vwap.strike !== strike) || a.vwap.expiry !== exp) {
    a.vwap = { strike, expiry: exp, bars: [], curMin: Math.floor(m.now / 60_000), cur: 0, ticks: [] };
  }
  const cq = px(m.quote(a.vwap.expiry, a.vwap.strike, 'CE'));
  const pq = px(m.quote(a.vwap.expiry, a.vwap.strike, 'PE'));
  if (cq == null || pq == null) return;
  const combined = cq + pq;
  const mk = Math.floor(m.now / 60_000);
  if (mk !== a.vwap.curMin) {
    if (a.vwap.cur > 0) a.vwap.bars.push(a.vwap.cur);
    a.vwap.curMin = mk;
  }
  a.vwap.cur = combined;
  a.vwap.ticks.push(combined);
  if (a.vwap.ticks.length > 200) a.vwap.ticks.splice(0, a.vwap.ticks.length - 200);
}

function vwapAct(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>) {
  const c = a.controls;
  const v = a.vwap;
  if (!v || !(v.cur > 0)) return;
  const vw = vwapOf(v);
  if (s.openLegs().length) return;   // exits live in cycleRisk so they run disarmed too

  const start = hmOf(strCtl(c, 'startTime', '09:15'));
  const off = hmOf(strCtl(c, 'squareOffTime'));
  if (start && m.hm < start) return;
  if (off && m.hm >= off) return;
  const maxTrades = numCtl(c, 'maxTradesPerDay');
  if (maxTrades > 0 && a.tradesToday >= maxTrades) return;
  if (v.bars.length < numCtl(c, 'vwapWarmupBars')) return;                 // VWAP ready
  if (!(v.cur <= vw + numCtl(c, 'entryBand'))) return;                      // price gate
  const n = numCtl(c, 'declineTicks');
  if (v.ticks.length < n + 1 || !(v.ticks[v.ticks.length - 1] < v.ticks[v.ticks.length - 1 - n])) return; // decline gate
  const ce = px(m.quote(v.expiry, v.strike, 'CE'));
  const pe = px(m.quote(v.expiry, v.strike, 'PE'));
  if (ce == null || pe == null) return;
  if (!(imbalancePct(ce, pe) < numCtl(c, 'maxPremiumDiffPct'))) return;      // balance gate
  const maxSpread = numCtl(c, 'maxSpreadPct');
  if (maxSpread > 0) {
    for (const o of ['CE', 'PE'] as const) {
      const sp = m.quote(v.expiry, v.strike, o)?.spreadPct;
      if (finite(sp) && sp > maxSpread) return;                               // liquidity guard
    }
  }
  const legs = a.legs.filter((l) => l.role === 'main' && l.status !== 'OPEN');
  for (const l of legs) s.enterLeg(l, { strike: v.strike, expiry: v.expiry });
  if (s.openLegs().length) {
    s.noteEntry();
    s.ev('VWAP', `Entered at premium ${v.cur.toFixed(1)} ≤ VWAP ${vw.toFixed(1)} + ${numCtl(c, 'entryBand')}`, false);
  }
}

// ── diagonal covered call ────────────────────────────────────────────────────

/** Net delta in units: long +, short −. Null when a leg has no delta. */
export function portfolioDelta(a: HdAlgo, m: HdMarket): number | null {
  let total = 0;
  for (const l of a.legs) {
    if (!isOpen(l)) continue;
    const q = quoteOf(l, m);
    const d = q && finite(q.deltaAbs) ? q.deltaAbs : l.entryDelta;
    if (!finite(d)) return null;
    total += (l.side === 'B' ? 1 : -1) * d * l.openLots * m.lotSize;
  }
  return total;
}

function diagonalRisk(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>, mtm: number): boolean {
  const c = a.controls;
  const capital = numCtl(c, 'capital');
  const equity = a.cumRealized + mtm;
  if (equity >= a.peakEquity) { a.peakEquity = equity; a.halved = false; }
  if (capital > 0) {
    const dd = ((a.peakEquity - equity) / capital) * 100;
    const exitPct = numCtl(c, 'drawdownExitPct');
    const halvePct = numCtl(c, 'drawdownHalvePct');
    if (exitPct > 0 && dd >= exitPct) {
      return s.closeAll(`drawdown ${dd.toFixed(1)}% ≥ ${exitPct}% — halted`, { phase: 'DONE', disarm: true }) || true;
    }
    if (halvePct > 0 && dd >= halvePct && !a.halved) {
      const sh = a.legs.find((l) => l.role === 'short' && isOpen(l));
      a.halved = true;
      if (sh && sh.openLots > 1) {
        const cut = Math.floor(sh.openLots / 2);
        s.unfill(sh, cut, 'HALVE');
        s.ev('HALVE', `Drawdown ${dd.toFixed(1)}% — bought back ${cut}L of the short call`);
      } else s.touch();
    }
    const lossPct = numCtl(c, 'dailyLossPct');
    const day = equity - a.dayStartPnl;
    if (lossPct > 0 && a.suspendedDay !== m.day && day <= -(lossPct / 100) * capital) {
      a.suspendedDay = m.day;
      s.ev('SUSPEND', `Daily loss ${fmtRs(day)} — discretionary adjustments suspended for today`);
    }
  }
  return false;
}

function diagonalAct(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>) {
  const c = a.controls;
  const longLeg = a.legs.find((l) => l.role === 'long');
  const shortLeg = a.legs.find((l) => l.role === 'short');
  if (!longLeg || !shortLeg) return;

  // long roll: shorts first, then the long; a fresh pair opens at the next window
  if (isOpen(longLeg) && longLeg.expiryUsed && m.dte(longLeg.expiryUsed) < numCtl(c, 'longRollDte')) {
    // The free-long-call credit is only forgotten once the pair is really closed; a failed close is retried.
    if (s.closeAll(`long call DTE ${m.dte(longLeg.expiryUsed)} < ${numCtl(c, 'longRollDte')} — rolling`, { phase: 'ACTIVE' })) {
      a.longDebit = 0; a.shortCredit = 0;
    }
    return;
  }

  if (isOpen(shortLeg)) {
    const q = quoteOf(shortLeg, m);
    const p = px(q);
    if (p != null && q) {
      const suspended = a.suspendedDay === m.day;
      const dte = shortLeg.expiryUsed ? m.dte(shortLeg.expiryUsed) : 99;
      const deltaNow = finite(q.deltaAbs) ? q.deltaAbs : null;
      const pd = portfolioDelta(a, m);
      const critical = dte <= numCtl(c, 'shortRollDte')
        || (deltaNow != null && deltaNow > numCtl(c, 'shortRollDelta'))
        || (pd != null && pd < numCtl(c, 'portfolioDeltaFloor'));
      const captured = shortLeg.avgEntry > 0 ? ((shortLeg.avgEntry - p) / shortLeg.avgEntry) * 100 : 0;
      const profitTake = captured >= numCtl(c, 'shortProfitPct');
      if (critical || (profitTake && !suspended)) {
        const why = critical ? 'risk roll' : `${captured.toFixed(0)}% of premium captured`;
        sellShort(a, m, s, `Short call roll (${why})`);
      }
    }
  }

  // window-based entries
  const windows = strCtl(c, 'rebalanceWindows', '').split(',').map(hmOf).filter(Boolean).sort();
  const start = hmOf(strCtl(c, 'startTime', '09:30'));
  if (start && m.hm < start) return;
  const due = windows.find((w) => w <= m.hm && !a.windowsDone.includes(w));
  if (!due) return;
  if (a.suspendedDay === m.day && isOpen(longLeg)) { a.windowsDone.push(due); s.touch(); return; }

  if (!isOpen(longLeg)) {
    const exp = pickExpiryByDte(m, numCtl(c, 'longDteMin'), numCtl(c, 'longDteMax'));
    if (!exp) { s.ev('SKIP', 'No expiry in the long DTE band', false); a.windowsDone.push(due); s.touch(); return; }
    const pick = pickDeltaStrike(m, exp, longLeg.option, numCtl(c, 'longDelta'), numCtl(c, 'longDeltaMin'), numCtl(c, 'longDeltaMax'));
    if (!pick) {
      // No data yet vs. nothing in the band: only a populated chain closes the window.
      if (m.strikes(exp).length) { s.ev('SKIP', `No ${longLeg.option} in the long Δ band for ${exp}`); a.windowsDone.push(due); s.touch(); }
      return;
    }
    s.enterLeg(longLeg, { strike: pick.strike, expiry: exp, lots: Math.max(1, s.lotsFor(longLeg)) });
    if (!isOpen(longLeg)) return;
    if (!a.entry) s.noteEntry();
  }
  a.windowsDone.push(due);
  if (!isOpen(shortLeg)) sellShort(a, m, s, 'Short call sold');
  s.touch();
}

/** Sell (or roll) the short call: expiry in the DTE band ending before the long, strike in the Δ band,
 *  lots sized from delta. Buys back the old short first. */
function sellShort(a: HdAlgo, m: HdMarket, s: ReturnType<typeof session>, label: string): boolean {
  const c = a.controls;
  const longLeg = a.legs.find((l) => l.role === 'long')!;
  const shortLeg = a.legs.find((l) => l.role === 'short')!;
  if (!isOpen(longLeg) || !longLeg.expiryUsed) return false;
  const exp = pickExpiryByDte(m, numCtl(c, 'shortDteMin'), numCtl(c, 'shortDteMax'), longLeg.expiryUsed);
  if (!exp) { s.ev('SKIP', 'No expiry in the short DTE band before the long call', false); return false; }
  const free = a.longDebit > 0 && a.shortCredit >= a.longDebit;
  const target = free ? numCtl(c, 'freeCallDelta') : numCtl(c, 'shortDelta');
  const lo = free ? Math.min(0.08, target) : numCtl(c, 'shortDeltaMin');
  const hi = free ? Math.max(0.15, target) : numCtl(c, 'shortDeltaMax');
  const pick = pickDeltaStrike(m, exp, shortLeg.option, target, lo, hi);
  if (!pick) { s.ev('SKIP', `No ${shortLeg.option} in the short Δ band for ${exp}`, false); return false; }
  const lq = quoteOf(longLeg, m);
  const longDelta = lq && finite(lq.deltaAbs) ? lq.deltaAbs : longLeg.entryDelta;
  if (!finite(longDelta)) return false;
  let lots = sizeShortLots({
    longLots: longLeg.openLots, longDeltaAbs: longDelta, shortDeltaAbs: pick.deltaAbs, lotSize: m.lotSize,
    targetNetDelta: numCtl(c, 'targetNetDelta'), maxShortLots: Math.min(HD_MAX_LOTS, numCtl(c, 'maxShortLots')),
    maxShortRatio: numCtl(c, 'maxShortRatio'), free,
  });
  if (shortLeg.lots > 0) lots = Math.min(lots, s.lotsFor(shortLeg));
  if (isOpen(shortLeg)) {
    const old = shortLeg.strike;
    s.unfill(shortLeg, shortLeg.openLots, 'ROLL');
    shortLeg.status = 'IDLE';
    shortLeg.openLots = 0;
    shortLeg.avgEntry = 0;
    shortLeg.firstEntry = undefined;
    shortLeg.entryDelta = undefined;
    s.ev('ROLL', `Bought back ${shortLeg.option} ${old}`, false);
  }
  if (lots <= 0) { s.ev('SKIP', 'Sizing gives 0 short lots', false); return false; }
  s.fill(shortLeg, pick.strike, exp, pick.ltp, lots, pick.deltaAbs);
  s.ev('ENTER', `${label}: ${lots}L ${shortLeg.option} ${pick.strike} (${exp}, Δ${pick.deltaAbs.toFixed(2)}) @ ${pick.ltp.toFixed(2)}${free ? ' — free long call mode' : ''}`);
  return true;
}

// ── manual actions (the row and algo buttons) ────────────────────────────────

export function enterAlgoNow(prev: HdAlgo, m: HdMarket): HdResult {
  const a = structuredClone(prev);
  const s = session(a, m);
  if (a.phase === 'DONE') { a.phase = 'ACTIVE'; s.touch(); }
  if (a.phase === 'PAUSED') { a.phase = 'ACTIVE'; a.pausedUntil = undefined; s.touch(); }
  if (a.kind === 'diagonal_call') {
    const longLeg = a.legs.find((l) => l.role === 'long');
    if (!longLeg) return { algo: prev, notes: ['No long leg row'], changed: false };
    const before = a.legs.reduce((n, l) => n + l.openLots, 0);
    if (!isOpen(longLeg)) {
      const exp = pickExpiryByDte(m, numCtl(a.controls, 'longDteMin'), numCtl(a.controls, 'longDteMax'));
      const pick = exp ? pickDeltaStrike(m, exp, longLeg.option, numCtl(a.controls, 'longDelta'), numCtl(a.controls, 'longDeltaMin'), numCtl(a.controls, 'longDeltaMax')) : null;
      if (!exp || !pick) { s.notes.push('No long strike in the DTE / delta band yet'); return { algo: prev, notes: s.notes, changed: false }; }
      s.enterLeg(longLeg, { strike: pick.strike, expiry: exp, lots: Math.max(1, s.lotsFor(longLeg)) });
      if (!a.entry) s.noteEntry();
    }
    // With the long already open this only sells the missing short call.
    if (isOpen(longLeg) && !a.legs.some((l) => l.role === 'short' && isOpen(l))) {
      if (!sellShort(a, m, s, 'Short call sold')) s.notes.push(`Short call not sold: ${a.events[a.events.length - 1]?.msg ?? 'no strike in the band'}`);
    }
    const changed = a.legs.reduce((n, l) => n + l.openLots, 0) !== before;
    return { algo: changed ? a : prev, notes: s.notes, changed };
  }
  const plan = planEntry(a, m, true);
  if (!plan.ok) { s.notes.push(`Not entered: ${plan.reason}`); return { algo: prev, notes: s.notes, changed: false }; }
  enterPlan(a, m, s, plan.plan);
  return { algo: a, notes: s.notes, changed: s.isChanged() };
}

export function enterLegNow(prev: HdAlgo, legId: string, m: HdMarket): HdResult {
  const a = structuredClone(prev);
  const s = session(a, m);
  const leg = a.legs.find((l) => l.id === legId);
  if (!leg) return { algo: prev, notes: ['Leg not found'], changed: false };
  if (isOpen(leg)) return { algo: prev, notes: ['Leg is already open'], changed: false };
  if (a.phase !== 'ACTIVE') { a.phase = 'ACTIVE'; a.pausedUntil = undefined; }
  const opts: { strike?: number } = leg.waitingReentry && leg.strike != null ? { strike: leg.strike } : {};
  if (leg.role === 'short' && a.kind === 'diagonal_call') {
    sellShort(a, m, s, 'Short call sold');
  } else if (!s.enterLeg(leg, opts)) {
    return { algo: prev, notes: s.notes.length ? s.notes : ['No price for that strike yet'], changed: false };
  }
  if (!a.entry) s.noteEntry();
  return { algo: a, notes: s.notes, changed: true };
}

export function exitLegNow(prev: HdAlgo, legId: string, m: HdMarket, lots?: number): HdResult {
  const a = structuredClone(prev);
  const s = session(a, m);
  const leg = a.legs.find((l) => l.id === legId);
  if (!leg || !isOpen(leg)) return { algo: prev, notes: ['Leg is not open'], changed: false };
  const n = lots != null ? Math.min(lots, leg.openLots) : leg.openLots;
  const k = `${leg.option} ${leg.strike}`;
  if (!s.unfill(leg, n, 'MANUAL', false)) return { algo: prev, notes: [`${k}: no live price — not closed`], changed: false };
  leg.waitingReentry = false;
  s.ev('LEG_EXIT', `Manual exit ${n}L ${k}`);
  // Closing the last open leg ends the cycle and disarms, or an armed algo would re-enter next tick.
  if (!s.liveLegs().length && !a.legs.some((l) => l.waitingReentry)) s.closeAll('last leg exited manually', { phase: 'ACTIVE', disarm: true });
  return { algo: a, notes: s.notes, changed: true };
}

export function exitAllNow(prev: HdAlgo, m: HdMarket): HdResult {
  const a = structuredClone(prev);
  const s = session(a, m);
  if (!s.openLegs().length) {
    a.legs.forEach((l) => { l.waitingReentry = false; });
    a.armed = false;
    return { algo: a, notes: ['Disarmed'], changed: true };
  }
  const ok = s.closeAll('manual exit all', { phase: 'ACTIVE', disarm: true });
  return { algo: ok ? a : prev, notes: s.notes, changed: ok };
}

export function canEditStructure(a: HdAlgo): boolean {
  return !a.legs.some(isOpen);
}

/** Clear a finished or stuck cycle's runtime state (no open legs only). */
export function resetAlgoRuntime(prev: HdAlgo, now: number = Date.now()): HdAlgo {
  if (prev.legs.some(isOpen)) return prev;
  const a = structuredClone(prev);
  a.legs = a.legs.filter((l) => !l.auto);
  for (const l of a.legs) {
    l.status = 'IDLE'; l.strike = undefined; l.expiryUsed = undefined; l.openLots = 0; l.avgEntry = 0;
    l.firstEntry = undefined; l.entryDelta = undefined; l.realized = 0; l.waitingReentry = false;
    l.reentryPx = undefined; l.exitReason = undefined; l.reentries = 0;
  }
  a.phase = 'ACTIVE'; a.pausedUntil = undefined; a.entry = undefined; a.peakMtm = 0; a.trail = { armed: false };
  a.vwap = undefined; a.windowsDone = []; a.halved = false; a.longDebit = 0; a.shortCredit = 0; a.armed = false;
  a.events.push({ t: now, k: 'RESET', msg: 'Runtime state cleared' });
  return a;
}

export function validateLeg(l: HdLeg): string | null {
  if (!Number.isInteger(l.lots) || l.lots < 0) return 'Lots must be a whole number';
  if (l.lots > HD_MAX_LOTS) return `Max ${HD_MAX_LOTS} lots per leg`;
  if (l.lots === 0 && l.role !== 'short') return 'Lots must be at least 1';
  return null;
}

export function pruneAlgos(algos: HdAlgo[]): HdAlgo[] {
  return algos.filter((a) => a && a.v === 1 && typeof a.id === 'string' && Array.isArray(a.legs));
}

// ── read-only status for the UI ──────────────────────────────────────────────

export interface HdStatus {
  state: 'DISARMED' | 'WAITING' | 'RUNNING' | 'PAUSED' | 'DONE';
  /** Why a waiting algo has not entered yet. */
  waiting?: string;
  mtm: number | null;
  dayPnl: number | null;
  targetRs: number;
  stopRs: number;
  imbalance?: { current: number; baseline: number; trigger: number; atMax: boolean; winner: HdOption; next: string };
  vwap?: { vwap: number; combined: number; bars: number; warmup: number; gates: { label: string; ok: boolean }[] };
  diagonal?: {
    portDelta: number | null; shortCapturedPct: number | null; shortDte: number | null; longDte: number | null;
    free: boolean; suspended: boolean; drawdownPct: number | null; nextWindow: string | null;
  };
}

export function algoStatus(a: HdAlgo, m: HdMarket | null): HdStatus {
  const open = a.legs.some(isOpen);
  const c = a.controls;
  const base: HdStatus = {
    state: a.phase === 'DONE' ? 'DONE' : a.phase === 'PAUSED' ? 'PAUSED' : open ? 'RUNNING' : a.armed ? 'WAITING' : 'DISARMED',
    mtm: m ? cycleMtm(a, m) : null,
    dayPnl: m ? dayPnl(a, m) : null,
    targetRs: limitRs(a, 'targetProfit', 'targetUnit'),
    stopRs: limitRs(a, 'stopLoss', 'stopUnit'),
  };
  if (!m) return { ...base, waiting: base.state === 'WAITING' ? 'waiting for prices' : undefined };
  if (base.state === 'WAITING') {
    if (a.kind === 'diagonal_call') {
      const windows = strCtl(c, 'rebalanceWindows').split(',').map(hmOf).filter(Boolean).sort();
      const next = windows.find((w) => w > m.hm && !a.windowsDone.includes(w));
      base.waiting = a.legs.some((l) => l.waitingReentry) ? 're-entry pending' : next ? `next window ${next}` : 'no rebalance window left today';
    } else if (a.kind === 'vwap_straddle') {
      base.waiting = undefined;
    } else if (a.legs.some((l) => l.waitingReentry)) {
      base.waiting = 'waiting for re-entry price';
    } else {
      const p = planEntry(a, m, false);
      base.waiting = p.ok ? 'entering…' : p.reason;
    }
  }

  const ce = a.legs.find((l) => l.role === 'main' && l.option === 'CE' && l.side === 'S' && isOpen(l));
  const pe = a.legs.find((l) => l.role === 'main' && l.option === 'PE' && l.side === 'S' && isOpen(l));
  if (ce && pe && a.entry && ['imbalance_straddle', 'imbalance_strangle', 'advanced_imbalance'].includes(a.kind)) {
    const cp = px(quoteOf(ce, m));
    const pp = px(quoteOf(pe, m));
    if (cp != null && pp != null) {
      const maxLots = Math.min(HD_MAX_LOTS, numCtl(c, 'maxLots', 4));
      const cv = ce.openLots * cp;
      const pv = pe.openLots * pp;
      const atMax = ce.openLots >= maxLots || pe.openLots >= maxLots;
      const trigger = (atMax ? numCtl(c, 'thresholdStrikePct') : numCtl(c, 'thresholdLotPct')) + a.entry.imbalance;
      const winner: HdOption = cv < pv ? 'CE' : 'PE';
      const mode = a.kind === 'advanced_imbalance' ? strCtl(c, 'adjustMode', 'winner_roll_atm') : 'value_balance';
      const wl = winner === 'CE' ? ce : pe;
      const next = mode === 'reentry_straddle' ? 'none — legs run on their own SL'
        : mode === 'winner_roll_atm' ? `roll ${winner} toward ATM`
        : mode === 'loser_ratio_roll' ? `roll ${winner === 'CE' ? 'PE' : 'CE'} out, +${numCtl(c, 'loserRatioLots', 1)}L`
        : wl.openLots < maxLots ? `+1 lot ${winner}${mode === 'hedged_addition' ? ' + hedge' : ''}`
          : mode === 'value_balance' ? `roll ${winner === 'CE' ? 'PE' : 'CE'} out` : 'exit cycle';
      base.imbalance = { current: imbalancePct(cv, pv), baseline: a.entry.imbalance, trigger, atMax, winner, next };
    }
  }
  if (a.kind === 'vwap_straddle' && a.vwap && a.vwap.cur > 0) {
    const v = a.vwap;
    const vw = vwapOf(v);
    const n = numCtl(c, 'declineTicks');
    const cq = px(m.quote(v.expiry, v.strike, 'CE'));
    const pq = px(m.quote(v.expiry, v.strike, 'PE'));
    base.vwap = {
      vwap: vw, combined: v.cur, bars: v.bars.length, warmup: numCtl(c, 'vwapWarmupBars'),
      gates: [
        { label: 'VWAP ready', ok: v.bars.length >= numCtl(c, 'vwapWarmupBars') },
        { label: 'Price ≤ VWAP + band', ok: v.cur <= vw + numCtl(c, 'entryBand') },
        { label: 'Declining', ok: v.ticks.length >= n + 1 && v.ticks[v.ticks.length - 1] < v.ticks[v.ticks.length - 1 - n] },
        { label: 'Balanced', ok: cq != null && pq != null && imbalancePct(cq, pq) < numCtl(c, 'maxPremiumDiffPct') },
      ],
    };
    if (base.state === 'WAITING') {
      const bad = base.vwap.gates.find((g) => !g.ok);
      const maxTrades = numCtl(c, 'maxTradesPerDay');
      base.waiting = maxTrades > 0 && a.tradesToday >= maxTrades ? `max ${maxTrades} trades reached`
        : m.hm < hmOf(strCtl(c, 'startTime', '09:15')) ? 'before start time'
        : bad ? `gate: ${bad.label}` : 'entering…';
    }
  }
  if (a.kind === 'diagonal_call') {
    const lg = a.legs.find((l) => l.role === 'long');
    const sh = a.legs.find((l) => l.role === 'short');
    const sp = sh && isOpen(sh) ? px(quoteOf(sh, m)) : null;
    const capital = numCtl(c, 'capital');
    const t = totalPnl(a, m);
    base.diagonal = {
      portDelta: portfolioDelta(a, m),
      shortCapturedPct: sh && sp != null && sh.avgEntry > 0 ? ((sh.avgEntry - sp) / sh.avgEntry) * 100 : null,
      shortDte: sh?.expiryUsed && isOpen(sh) ? m.dte(sh.expiryUsed) : null,
      longDte: lg?.expiryUsed && isOpen(lg) ? m.dte(lg.expiryUsed) : null,
      free: a.longDebit > 0 && a.shortCredit >= a.longDebit,
      suspended: a.suspendedDay === m.day,
      drawdownPct: t != null && capital > 0 ? Math.max(0, ((Math.max(a.peakEquity, t) - t) / capital) * 100) : null,
      nextWindow: strCtl(c, 'rebalanceWindows').split(',').map(hmOf).filter(Boolean).sort().find((w) => w > m.hm && !a.windowsDone.includes(w)) ?? null,
    };
  }
  return base;
}
