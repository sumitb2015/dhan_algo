// The P&F / Renko AUTO engine for ONE chart (rules: lib/pnfAuto.ts; ledger: lib/pnfAutoLedger.ts; spec: strategies/pnf_auto/strategy.md).
// One implementation for the dashboard SERVER (lib/pnfAutoEngine.ts, which runs AUTO with every tab closed) and the tests: everything it
// touches outside itself (the ledger, the order route, the broker's order book, the clock) comes in through ChartDeps. Entries need
// AUTO armed on this chart; exits run for this chart's open row whatever the switch says. REAL orders are reserved in the ledger before
// they are sent and an unknown outcome is never resent: the chart halts and the user resolves it.
import { autoProductOf, carriesOvernight, decideAdd, decideAuto, reentryBlockOf, rowMarket, trailBest, trailLevel, trailOf, type AutoProduct } from './pnfAuto.ts';
import { ignoredByFilter, skippedBrick, SIDE_LABEL, withSide, type AutoRule, type AutoSide } from './pnfAutoRule.ts';
import { isSellSignal } from './straddlePnf.ts';
import { closingSide, isLive, PYRAMID_HARD_MAX, type AutoLedger, type AutoLeg, type AutoOp, type AutoRow } from './pnfAutoLedger.ts';
import { istDateIso } from './nseHolidays.ts';
import { targetKey, type Target } from './pnfTarget.ts';
import { fullFillAvg, type OrderPriceRead } from './tradedPriceClient.ts';
import type { LegResult, PnfBroker } from './pnfOrderLogic.ts';
import type { Market } from './straddlePnfLive.ts';
import type { PanelModel } from './straddlePnfModel.ts';
import type { IndexDir, IndexMap } from './pnfIndexMap.ts';

/** The option an index chart's entry trades, as the server resolved it (lib/pnfIndexTradeServer.ts resolveIndexTrade). */
export type IndexResolved = {
  traded: Target; action: 'BUY' | 'SELL'; ids: string; premium: number | null; unsupported: string | null;
  legs: { label: string; lot: number; unitsPerLot: number | null; key: string | null; lotUnits: number | null }[];
};

/** A REAL fill that cannot be read after this many tries (a minute apart) stays at its decision price. */
export const SETTLE_MAX_TRIES = 5;
export const MAX_REJECTS = 3;
/** A refused REAL exit is retried this often (the order route also holds a close cooldown). */
export const EXIT_RETRY_MS = 10_000;
/** A pyramid add that failed before anything was sent is retried this many times on its bar. */
export const ADD_MAX_TRIES = 3;
const SETTLE_WAITS = [800, 1500, 3000, 6000];

export type OrderReply = { success?: boolean; error?: string; outcome?: string; legs?: LegResult[]; message?: string };
export type LegInfo = { label: string; lot: number; unitsPerLot: number | null; key: string | null; lotUnits: number | null };
/** One lot of the chart's contract on the broker (resolved by the order route / lib/pnfOrderServer.ts); null while unknown. */
export type ChartInfo = { legs: LegInfo[]; unsupported: string | null } | null;

export type AutoEvent = { chart: 1 | 2; kind: 'entry' | 'exit' | 'halt' | 'info'; text: string; side?: 'BUY' | 'SELL'; price?: number; target?: Target; mode?: 'PAPER' | 'REAL'; lots?: number };

/** `armT`: the saved arming this follows (lib/pnfAutoLedger.ts AutoArmRecord.t). */
export interface AutoArm {
  on: boolean; mode: 'PAPER' | 'REAL'; watermarkT: number; armT?: number;
  /** Wall-clock time (epoch s) it was armed. */
  armedAtS?: number;
  /** The product new entries are sent with (MIS when absent); a row keeps the product it was opened with. */
  product?: AutoProduct;
}

/**
 * Pyramid (Renko): add one lot every `every` new bricks while a position is open, up to `max` total lots (lib/pnfAuto.ts decideAdd).
 * `trailOn` / `trail`: once a lot was added, exit on a closed brick `trail` boxes back from the best brick (lib/pnfAuto.ts trailOf).
 */
export interface AutoPyramid { on: boolean; max: number; every: number; trailOn: boolean; trail: number }

export interface ChartDeps {
  /** One ledger op (lib/pnfAutoLedger.ts applyAutoOp under the file lock). */
  post: (op: AutoOp) => Promise<{ ok: boolean; error?: string }>;
  /** One order (lib/pnfAutoOrders.ts placePnfMarket, source 'auto'). Null = no clean reply: UNKNOWN, never a failure. */
  sendOrder: (body: Record<string, unknown>) => Promise<OrderReply | null>;
  /** One read of an order's status at the broker; null = unreadable. */
  readOrderPrice: (orderId: string, broker: PnfBroker) => Promise<OrderPriceRead | null>;
  event: (e: AutoEvent) => void;
  /** The engine switched AUTO off itself (a halt, a server-guard exit). */
  disarm: (why: string) => void;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** An INDEX chart's entry: the option its map trades for `dir`, ATM +/- N from the server's live index price, or why there is none. */
  resolveIndex?: (broker: PnfBroker, index: Target, map: IndexMap, dir: IndexDir) => Promise<IndexResolved | string>;
  /** An option's price now (`SEG:ID`): the bridge when fresh, else one quote; null when none can be read. */
  premium?: (ids: string) => Promise<number | null>;
}

/** What one tick reads: the chart as it is now. */
export interface ChartInputs {
  arm: AutoArm;
  lots: number;
  target: Target;
  /** The chart's CLOSED-bar model (signals / columns never include the forming minute), with the selected rule's signals. */
  model: PanelModel;
  /** Renko: the chart's AUTO rule, so the status can say why a brick did not enter (Supertrend: a brick against the line). */
  rule?: AutoRule;
  /** Which side AUTO may OPEN (default both); exits are never filtered. */
  side?: AutoSide;
  pyramid?: AutoPyramid;
  /** The chart's live price (a straddle's CE + PE), or null. */
  price: number | null;
  stale: boolean;
  market: Market;
  /** The chart's bars are the whole history (a partial model would miss the best brick so far). */
  complete: boolean;
  broker: PnfBroker;
  ledger: AutoLedger;
  info: ChartInfo;
  /** A Renko INDEX chart: the bull / bear option map saved with the arming. An index chart without one never enters. */
  indexMap?: IndexMap;
}

const RESOLVE_BACKOFF_MS = 10_000, RESOLVE_MAX_FAILS = 6;

export class ChartEngine {
  note = '';
  halt: string | null = null;
  private busy = false;
  private rejects = 0;
  /** An index chart's option lookup that failed: not asked again for a while (each ask is a spot + chain + option quote on the shared lane), and given up after a few. */
  private resolveFails = 0;
  private resolveRetryAt = 0;
  private exitRetryAt = 0;
  private watermark = 0;
  /**
   * Adds tried on a bar. An order that went out (or a definite refusal) spends the bar; a failure before anything was sent (ledger
   * unreachable, contract lookup pending) is retried on the next ticks, at most ADD_MAX_TRIES times, while the bar is the newest.
   */
  private addTries: { barT: number; n: number; spent: boolean } | null = null;
  /** A signal whose entry failed before anything was sent (retried while fresh), so a miss is logged once. */
  private retry: { id: string; side: 'BUY' | 'SELL'; why: string } | null = null;
  /** The kind of the last held-back signal that was logged. */
  private ignored = '';
  /** The last brick the Supertrend rule skipped (logged once per brick, and kept on the status line until a newer state replaces it). */
  private skipped: { key: string; text: string } | null = null;
  private settling = new Map<string, number>();
  private settleTries = new Map<string, number>();
  private last: { on: boolean; id: number; side: AutoSide; rule?: AutoRule } | null = null;

  readonly chart: 1 | 2;
  private deps: ChartDeps;

  constructor(chart: 1 | 2, deps: ChartDeps) { this.chart = chart; this.deps = deps; }

  private nowS() { return this.deps.nowMs() / 1000; }

  /**
   * The state an arming resets: called with every tick's inputs, it acts only when the arming (its `armT`), the side filter or the rule
   * changed. A new arming moves the watermark to its own (a signal already on the chart is never entered) and clears a halt and the
   * refusal count; the same arming only ever moves the watermark forward (the engine's rebuilt one after a restart, lib/pnfAutoArm.ts).
   */
  sync(arm: AutoArm, side: AutoSide = 'both', rule?: AutoRule): void {
    const p = this.last;
    const id = arm.on ? arm.armT ?? arm.armedAtS ?? arm.watermarkT : 0;
    this.last = { on: arm.on, id, side, rule };
    const fresh = !p || p.on !== arm.on || p.id !== id;
    if (fresh || p.side !== side) this.ignored = '';
    if (fresh || p.rule !== rule) this.skipped = null;
    this.watermark = fresh ? arm.watermarkT : Math.max(this.watermark, arm.watermarkT);
    if (fresh && arm.on) { this.halt = null; this.rejects = 0; this.resolveFails = 0; this.resolveRetryAt = 0; }
  }

  rowOf(ledger: AutoLedger): AutoRow | undefined { return ledger.rows.find(r => r.chart === this.chart && isLive(r)); }

  /**
   * The SERVER guard exited this chart's position after this arming: AUTO is switched off too, or a trend rule would re-enter on the
   * next brick. Measured from the ARMING (wall clock), never the watermark: that is the last closed bar, which before the open is the
   * previous session's, so yesterday's guard exits would disarm a fresh arming (2026-11-06).
   */
  guardExitedSinceArm(ledger: AutoLedger, arm: AutoArm): boolean {
    if (!arm.on) return false;
    const since = arm.armT ?? arm.armedAtS;
    if (since === undefined) return false;
    return ledger.rows.some(r => r.chart === this.chart && r.mode === arm.mode && (r.exitT ?? r.pendingSince ?? 0) > since
      && ((r.state === 'closed' && (r.reason ?? '').startsWith('server guard')) || (r.state === 'unknownExit' && (r.note ?? '').startsWith('server guard'))));
  }

  private haltNow(why: string) {
    this.halt = why;
    this.deps.disarm(why);
    this.deps.event({ chart: this.chart, kind: 'halt', text: `AUTO C${this.chart} halted: ${why}` });
    void this.deps.post({ op: 'log', chart: this.chart, t: this.nowS(), text: `halted: ${why}`, kind: 'halt' });
  }

  private send(body: Record<string, unknown>): Promise<OrderReply | null> {
    return this.deps.sendOrder(body).catch(() => null);           // no clean reply: UNKNOWN, never a failure
  }

  /**
   * REAL fills: a row's entry / exit price starts as the chart's price at the DECISION. Once the broker reports its orders FULLY traded,
   * the broker's average traded price (summed over a straddle's legs) replaces it (the `fillPrice` ledger op). It only prices what it can
   * price whole: one order per leg, each fully traded for the leg's units. Anything else keeps its decision price after a few tries, and
   * is said once in the ledger log. Runs in the background: returns at once.
   */
  settle(ledger: AutoLedger): void {
    const todo: { r: AutoRow; which: 'entry' | 'exit' | 'add'; addId?: string }[] = [];
    for (const r of ledger.rows) {
      if (r.chart !== this.chart || r.mode !== 'REAL') continue;
      // closed without an AUTO order (flat at the broker, resolved by hand, refused): no real exit to price against
      if (r.state === 'closed' && (r.reason === 'flat at broker' || r.reason === 'resolved' || r.reason === 'refused')) continue;
      if (r.entryOrderIds?.length && !r.entryFilled && (r.state === 'open' || r.state === 'exiting' || r.state === 'closed' || r.state === 'adding' || r.state === 'unknownAdd')) todo.push({ r, which: 'entry' });
      if (r.state === 'closed' && r.exitOrderIds?.length && !r.exitFilled) todo.push({ r, which: 'exit' });
      for (const a of r.adds ?? []) if (a.status === 'done' && a.orderIds?.length && !a.filled) todo.push({ r, which: 'add', addId: a.id });
    }
    for (const { r, which, addId } of todo) {
      const key = `${r.id}:${which}${addId ? `:${addId}` : ''}`;
      if (this.deps.nowMs() < (this.settling.get(key) ?? 0)) continue;
      const add = addId ? r.adds?.find(a => a.id === addId) : undefined;
      const ids = (which === 'entry' ? r.entryOrderIds : which === 'add' ? add?.orderIds : r.exitOrderIds) ?? [];
      const unitsOf = (k: number) => (which === 'add' && add ? add.units[k] : r.legs[k].units);   // an add's units per leg, not the row's totals
      // one order per leg, or it is not the whole price: left at the decision price for good
      if (ids.length !== r.legs.length) { this.settling.set(key, Number.POSITIVE_INFINITY); continue; }
      this.settling.set(key, this.deps.nowMs() + 60_000);                      // in flight, or retried after a minute
      void (async () => {
        const reads = await Promise.all(ids.map(async (id, k) => {
          for (const wait of SETTLE_WAITS) {
            await this.deps.sleep(wait);
            const px = fullFillAvg(await this.deps.readOrderPrice(id, r.broker as PnfBroker), unitsOf(k));
            if (px > 0) return px;
          }
          return 0;
        }));
        if (reads.every(px => px > 0)) {
          const res = await this.deps.post({ op: 'fillPrice', id: r.id, which, price: Math.round(reads.reduce((a, b) => a + b, 0) * 100) / 100, legCount: ids.length, ...(addId ? { addId } : {}) });
          if (res.ok) { this.settling.set(key, Number.POSITIVE_INFINITY); return; }        // done for good
          // refused for good (a price outside the band, a row closed another way): the decision price stands
          if (res.error && /more than|closed as|covers/.test(res.error)) this.settling.set(key, Number.POSITIVE_INFINITY);
        }
        const tries = (this.settleTries.get(key) ?? 0) + 1;
        this.settleTries.set(key, tries);
        if (tries >= SETTLE_MAX_TRIES) {
          this.settling.set(key, Number.POSITIVE_INFINITY);
          void this.deps.post({ op: 'log', chart: this.chart, t: this.nowS(), text: `could not read the broker's ${which} fill (${ids.join(', ')}); the ${which} price stays at the decision price` });
        }
      })();
    }
  }

  /**
   * `livePx`: the chart's price now; `box`: the confirmed box the signal bar reached (PAPER books it; REAL books the live price).
   * Returns why NOTHING was sent when it may work on the next tick (no contract lookup yet, the ledger unreachable or refusing the
   * reservation): the tick then keeps the signal and tries again while it is still the newest closed bar's. null once the entry was
   * taken, or sent, or refused for good (a REAL order that went out is never retried).
   */
  private async enter(i: ChartInputs, side: 'BUY' | 'SELL', signalT: number, livePx: number, box: number | null, stop?: number, exitBy?: 'supertrend'): Promise<string | null> {
    const { arm, lots, target, market, broker } = i;
    const chart = this.chart;
    const px = arm.mode === 'PAPER' && box !== null ? box : livePx;
    // An INDEX chart trades the option its map names for this direction, picked now (ATM +/- N): the row keeps the index as its chart and
    // carries the option as `traded`. Its P&L is the option's premium, so an entry needs that price (a missing one is retried while fresh).
    let info = i.info, traded: AutoRow['traded'] | undefined, pyramid = i.pyramid;
    if (target.kind === 'index') {
      if (!i.indexMap || !this.deps.resolveIndex || !this.deps.premium) { this.note = 'no option map saved with this arming'; return null; }
      if (this.deps.nowMs() < this.resolveRetryAt) return this.note ?? 'waiting to retry the option lookup';
      const r = await this.deps.resolveIndex(broker, target, i.indexMap, side === 'BUY' ? 'bull' : 'bear').catch((e: Error) => `option lookup failed (${e.message})`);
      const why = typeof r === 'string' ? r : !(r.premium && r.premium > 0) ? `no price for the ${r.traded.strike} ${r.traded.side} option yet` : null;
      if (why !== null) {
        this.resolveFails += 1;
        // a mapping that keeps failing (a strike that is not listed, an option with no quote) is not retried every tick: back off, then stop
        if (this.resolveFails >= RESOLVE_MAX_FAILS) { this.resolveFails = 0; this.resolveRetryAt = 0; this.haltNow(`${why} - gave up after ${RESOLVE_MAX_FAILS} tries; check the option map`); return null; }
        this.resolveRetryAt = this.deps.nowMs() + RESOLVE_BACKOFF_MS;
        this.note = why;
        return why;
      }
      this.resolveFails = 0; this.resolveRetryAt = 0;
      if (typeof r === 'string') return null;
      info = { legs: r.legs, unsupported: r.unsupported };
      traded = { target: r.traded, targetKey: targetKey(r.traded), action: r.action, ids: r.ids, entryPremium: r.premium as number };
      pyramid = undefined;                                       // an option row on an index chart has no adds
    }
    if (!info || !info.legs.length) { this.note = 'waiting for the contract lookup'; return 'the contract lookup has not answered'; }
    if (arm.mode === 'REAL' && info.unsupported) { this.haltNow(info.unsupported); return null; }
    const unitsPerPoint = (info.legs[0].unitsPerLot ?? info.legs[0].lot) * lots;
    const nowMs = this.deps.nowMs();
    const id = `pnfa-${chart}-${nowMs}`;
    const nowS = nowMs / 1000;
    const product = target.kind === 'equity' ? 'INTRADAY' : autoProductOf(arm.product);   // a stock is MIS only
    const base = {
      id, day: istDateIso(nowMs), chart, target, market, ...(product === 'MARGIN' ? { product } : {}), mode: arm.mode, broker, side, lots, unitsPerPoint,
      legs: info.legs.map(l => ({ label: l.label, key: l.key, units: (l.lotUnits ?? l.lot) * lots })), entryT: nowS, entryBarT: signalT, entryPrice: px,
      ...(box !== null ? { entryBox: box } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(exitBy ? { exitBy } : {}),
      ...(traded ? { traded } : {}),
      ...(pyramid?.on && pyramid.max > lots ? { pyramidMax: Math.min(pyramid.max, PYRAMID_HARD_MAX), ...(pyramid.every > 1 ? { pyramidEvery: pyramid.every } : {}), ...(pyramid.trailOn ? { trailBoxes: pyramid.trail } : {}) } : {}),
    };
    const post = this.deps.post;
    // what is sent: the chart's own contract, or an index chart's option on the option's own side
    const orderTarget = traded ? traded.target : target, orderSide = traded ? traded.action : side;
    const what = traded ? ` → ${traded.action} ${traded.target.strike} ${traded.target.side} @ ${traded.entryPremium.toFixed(2)}` : '';
    if (arm.mode === 'PAPER') {
      const j = await this.send({ broker, mode: 'PAPER', target: orderTarget, action: orderSide, lots, product });
      if (!j?.success) { this.note = `paper order refused: ${j?.error ?? 'no reply'}`; return `paper order refused (${j?.error ?? 'no reply'})`; }
      const r = await post({ op: 'open', row: base });
      if (!r.ok) { this.note = `ledger refused: ${r.error}`; return `the ledger refused it (${r.error ?? 'unreachable'})`; }
      this.deps.event({ chart, kind: 'entry', side, price: px, target, mode: arm.mode, lots, text: `AUTO C${chart} [PAPER] ${side} ${lots}L @ ${px.toFixed(2)}${what}` });
      return null;
    }
    // REAL: reserve, send, then confirm / void / mark unknown. A refused reservation sent nothing: it may be tried again.
    const reserved = await post({ op: 'open', row: { ...base, state: 'entering' } });
    if (!reserved.ok) { this.note = `ledger refused the entry: ${reserved.error}`; return `the ledger refused the reservation (${reserved.error ?? 'unreachable'})`; }
    const j = await this.send({ broker, mode: 'REAL', target: orderTarget, action: orderSide, lots, product });
    if (!j || j.outcome === 'unknown') {
      await post({ op: 'markUnknown', id, note: j?.message ?? 'no reply from the order route' });
      this.haltNow('entry outcome unknown - check Orders/Positions, then resolve it');
      return null;
    }
    if (j.outcome === 'placed') {
      const legs: AutoLeg[] = (j.legs ?? []).filter(l => l.status === 'placed').map((l, k) => ({ label: l.label, key: base.legs[k]?.key ?? null, units: l.qty }));
      const ok = await post({ op: 'confirmEntry', id, legs, orderIds: (j.legs ?? []).filter(l => l.status === 'placed' && l.orderId).map(l => String(l.orderId)) });
      if (!ok.ok) {
        // placed, but not as reserved (other units, a leg missing): the row must not open on sizes the broker does not hold
        await post({ op: 'markUnknown', id, note: `entry placed but not as reserved: ${ok.error}` });
        this.haltNow(`order placed but the ledger refused it (${ok.error}) - check Positions, then resolve it`);
        return null;
      }
      this.rejects = 0;
      this.deps.event({ chart, kind: 'entry', side, price: px, target, mode: arm.mode, lots, text: `AUTO C${chart} [REAL] ${side} ${lots}L @ ~${px.toFixed(2)}${what}` });
      return null;
    }
    if (j.outcome === 'partial') {
      await post({ op: 'markUnknown', id, note: j.message ?? 'partial' });
      this.haltNow('only part of the straddle was placed - check Positions, then resolve it');
      return null;
    }
    // rejected / reversed: nothing is open.
    await post({ op: 'voidEntry', id, t: this.nowS(), note: j.message ?? j.error ?? 'refused' });
    this.rejects += 1;
    this.deps.event({ chart, kind: 'info', text: `AUTO C${chart} entry refused: ${j.message ?? j.error ?? ''}` });
    if (this.rejects >= MAX_REJECTS) this.haltNow(`${MAX_REJECTS} entries in a row were refused`);
    return null;
  }

  /**
   * True when the row was closed (PAPER ledger close, or a REAL exit the broker placed / found already flat). `barT`: the bar that
   * triggered the exit (the reversal column's first bar), for the chart marker.
   */
  private async exit(r: AutoRow, reason: string, px: number | null, barT?: number, box?: number | null, best?: number | null): Promise<boolean> {
    const chart = this.chart, post = this.deps.post;
    // PAPER books the confirmed box the reversal reached; REAL (and an EOD exit, which has no box) the live price. Only an EOD
    // exit can run without a price (E5): it books the entry price then.
    const exitPx = r.mode === 'PAPER' && box != null ? box : px ?? r.entryPrice;
    const boxField = { ...(box != null ? { exitBox: box } : {}), ...(best != null ? { trailBest: best } : {}) };
    const side = r.side === 'BUY' ? 'SELL' : 'BUY';
    // An index chart's row exits its OPTION, on the option's own closing side, and books the option's price at the decision.
    const contract = r.traded ? r.traded.target : r.target;
    const exitSide = closingSide(r);
    const premium = r.traded && this.deps.premium ? await this.deps.premium(r.traded.ids).catch(() => null) : null;
    const premField = premium && premium > 0 ? { exitPremium: premium } : {};
    const premTxt = r.traded ? ` → ${exitSide} ${r.traded.target.strike} ${r.traded.target.side}${premium ? ` @ ${premium.toFixed(2)}` : ''}` : '';
    if (r.mode === 'PAPER') {
      // a paper exit is booked at the option's price: without one it waits (the end of day still closes, its P&L said unknown)
      if (r.traded && !(premium && premium > 0) && reason !== 'eod') { this.note = `${reason} seen, waiting for the option's price`; return false; }
      const c = await post({ op: 'close', id: r.id, exitT: this.nowS(), exitPrice: exitPx, reason, exitBarT: barT, ...boxField, ...premField });
      if (c.ok) this.deps.event({ chart, kind: 'exit', side, price: exitPx, target: r.target, mode: r.mode, lots: r.lots, text: `AUTO C${chart} [PAPER] exit (${reason}) @ ${exitPx.toFixed(2)}${premTxt}` });
      return c.ok;
    }
    if (this.deps.nowMs() < this.exitRetryAt) return false;
    const reserved = await post({ op: 'beginExit', id: r.id, t: this.nowS() });
    if (!reserved.ok) { this.note = `ledger refused the exit: ${reserved.error}`; return false; }
    // The broker it was opened on and the units AUTO owns, never the Lots box or the page broker.
    const j = await this.send({ broker: r.broker, mode: 'REAL', target: contract, exitOwn: { side: exitSide, units: r.legs.map(l => l.units), product: autoProductOf(r.product) } });
    if (!j || j.outcome === 'unknown' || j.outcome === 'partial') {
      await post({ op: 'markUnknown', id: r.id, note: j?.message ?? 'no reply from the order route' });
      this.haltNow('exit outcome unknown - check Orders/Positions, then resolve it');
      return false;
    }
    if (j.outcome === 'placed' || j.outcome === 'flat') {
      const c = await post({ op: 'close', id: r.id, exitT: this.nowS(), exitPrice: exitPx, reason, exitBarT: barT, ...boxField, ...premField, note: j.outcome === 'flat' ? 'already flat at the broker' : undefined, orderIds: (j.legs ?? []).filter(l => l.status === 'placed' && l.orderId).map(l => String(l.orderId)) });
      if (!c.ok) { this.haltNow(`exit sent but the ledger refused it (${c.error})`); return false; }
      this.deps.event({ chart, kind: 'exit', side, price: exitPx, target: r.target, mode: r.mode, lots: r.lots, text: `AUTO C${chart} [REAL] exit (${reason}) @ ~${exitPx.toFixed(2)}${premTxt}${j.outcome === 'flat' ? ' - already flat at the broker' : ''}` });
      return true;
    }
    await post({ op: 'abortExit', id: r.id, note: j.message ?? j.error ?? 'exit refused' });
    this.exitRetryAt = this.deps.nowMs() + EXIT_RETRY_MS;
    this.deps.event({ chart, kind: 'info', text: `AUTO C${chart} exit refused, retrying: ${j.message ?? j.error ?? ''}` });
    return false;
  }

  /**
   * Pyramid: add one lot to the open row on a new best brick. PAPER books the brick; REAL reserves the add in the ledger (open → adding),
   * sends ONE order in the row's own direction on the broker it was opened on, then confirms / voids it; an unclear outcome halts the
   * chart and waits for the user (never resent). `barT` is tried once: a refused add waits for the next new best brick.
   */
  private async addLot(i: ChartInputs, r: AutoRow, barT: number, box: number, livePx: number): Promise<void> {
    const chart = this.chart, post = this.deps.post;
    const tries = this.addTries?.barT === barT ? this.addTries : { barT, n: 0, spent: false };
    tries.n += 1;
    this.addTries = tries;
    const spend = () => { tries.spent = true; };
    const id = `add-${this.deps.nowMs()}`;
    const t = this.nowS();
    const total = r.lots + 1;
    if (r.mode === 'PAPER') {
      const res = await post({ op: 'addPaper', id: r.id, add: { id, t, barT, box, lots: 1, price: box } });
      if (!res.ok) { this.note = `add refused: ${res.error}`; return; }      // nothing booked: retried while the bar is fresh
      spend();
      this.deps.event({ chart, kind: 'entry', side: r.side, price: box, target: r.target, mode: r.mode, lots: 1, text: `AUTO C${chart} [PAPER] add 1L @ ${box.toFixed(2)} → ${total}L` });
      return;
    }
    // The checks an entry makes before it sends: the contract lookup for THIS broker and contract, and REAL support for it.
    if (!i.info || !i.info.legs.length) { this.note = 'add waiting for the contract lookup'; return; }
    if (i.info.unsupported) { spend(); this.haltNow(i.info.unsupported); return; }
    const reserved = await post({ op: 'beginAdd', id: r.id, add: { id, t, barT, box, lots: 1, price: livePx } });
    if (!reserved.ok) { this.note = `ledger refused the add: ${reserved.error}`; return; }
    spend();                                                          // reserved: whatever happens next, this bar's add is never sent again
    const j = await this.send({ broker: r.broker, mode: 'REAL', target: r.target, action: r.side, lots: 1, product: autoProductOf(r.product) });
    if (!j || j.outcome === 'unknown' || j.outcome === 'partial') {
      await post({ op: 'markUnknown', id: r.id, note: `add: ${j?.message ?? 'no reply from the order route'}` });
      this.haltNow('add outcome unknown - check Orders/Positions, then resolve it');
      return;
    }
    if (j.outcome === 'placed') {
      const placed = (j.legs ?? []).filter(l => l.status === 'placed');
      const ok = await post({ op: 'confirmAdd', id: r.id, units: placed.map(l => l.qty), orderIds: placed.filter(l => l.orderId).map(l => String(l.orderId)) });
      if (!ok.ok) {
        await post({ op: 'markUnknown', id: r.id, note: `add placed but not as reserved: ${ok.error}` });
        this.haltNow(`add placed but the ledger refused it (${ok.error}) - check Positions, then resolve it`);
        return;
      }
      this.deps.event({ chart, kind: 'entry', side: r.side, price: livePx, target: r.target, mode: r.mode, lots: 1, text: `AUTO C${chart} [REAL] add 1L @ ~${livePx.toFixed(2)} → ${total}L` });
      return;
    }
    // rejected / reversed: nothing was added
    await post({ op: 'voidAdd', id: r.id, note: `add refused: ${j.message ?? j.error ?? 'refused'}` });
    this.deps.event({ chart, kind: 'info', text: `AUTO C${chart} add refused: ${j.message ?? j.error ?? ''} - the next new best brick tries again` });
  }

  /** One tick. Never overlaps itself: a tick that finds the previous one still sending returns at once. */
  async tick(i: ChartInputs): Promise<void> {
    if (this.busy) return;
    this.sync(i.arm, i.side, i.rule);
    const { arm, price, stale, complete, broker, ledger, pyramid, target, market, rule } = i;
    const ruleModel = i.model;
    const side = i.side ?? 'both';
    const model = withSide(ruleModel, side);                                  // entries read the allowed side's signals only
    const chart = this.chart, post = this.deps.post;
    const tk = targetKey(target);
    const row = this.rowOf(ledger);
    const nowS = this.nowS();
    if (row) {
      this.retry = null;                                         // a row exists: the signal being retried was taken (or reserved)
      if (row.state !== 'open') { this.note = row.state === 'entering' || row.state === 'exiting' || row.state === 'adding' ? `${row.state}…` : 'unresolved - check the broker'; return; }
      if (row.targetKey !== tk) {
        // The chart was switched away from its position: only the EOD exit can still run (no model for that contract here).
        const d = decideAuto({ model: { box: 0, signals: [], columns: [], columnTimes: [], lastBarT: null }, position: { side: row.side, entryBarT: row.entryBarT }, watermarkT: 0, nowS, market: rowMarket(row), product: autoProductOf(row.product), carry: carriesOvernight(row, nowS) });
        this.note = carriesOvernight(row, nowS) ? 'position on another contract: held overnight (NRML NIFTY option), only the server guard watches it' : 'position on another contract: watching the EOD exit only';
        if (d.action === 'exit' && d.reason === 'eod') { this.busy = true; try { await this.exit(row, 'eod', null); } finally { this.busy = false; } }
        return;
      }
      // The end-of-day time is the POSITION's market (saved on the row), never the chart's `market`: that reads 'NSE' until the history has
      // loaded, which would flatten an MCX position at the NSE 15:15 straight away.
      const position = { side: row.side, entryBarT: row.entryBarT, stop: row.stop, exitBy: row.exitBy, trail: trailOf(row) };
      // A stale price never decides a stop (it may be minutes old): the Renko stop then reads closed bricks instead.
      const d = decideAuto({ model, position, watermarkT: this.watermark, nowS, market: rowMarket(row), price: stale ? null : price, product: autoProductOf(row.product), carry: carriesOvernight(row, nowS) });
      if (d.action !== 'exit') {
        const tl = trailLevel(model, position);
        const trailTxt = tl !== null ? ` · trail SL ${tl.toFixed(2)}` : '';
        // Pyramid: only while armed in the row's own mode, with adds still switched on, a fresh price and no halt. `complete`: the bars
        // are the whole history (a partial model would miss the best brick so far and add after a pullback). The row's broker must be
        // the chart's: the contract lookup and the order sizing are that broker's.
        if (arm.on && arm.mode === row.mode && pyramid?.on && row.pyramidMax && !this.halt && !stale && price !== null && complete && row.broker === broker) {
          const a = decideAdd({ model, row, nowS, market: rowMarket(row), maxLots: Math.min(row.pyramidMax, pyramid.max, PYRAMID_HARD_MAX) });
          const tried = a.add && this.addTries?.barT === a.barT ? this.addTries : null;
          if (a.add && !(tried && (tried.spent || tried.n >= ADD_MAX_TRIES))) {
            this.busy = true;
            try { await this.addLot(i, row, a.barT, a.box, price); } finally { this.busy = false; }
            return;
          }
          this.note = a.add || a.why === 'no new best brick on the newest bar' || a.why === 'already added on this bar' || a.why.startsWith('waiting for') ? `holding ${row.lots}L (+1L/${row.pyramidEvery ?? 1} br to ${Math.min(row.pyramidMax, pyramid.max)}L)${trailTxt}` : `holding ${row.lots}L (${a.why})${trailTxt}`;
          return;
        }
        this.note = (arm.on ? 'holding' : 'holding - AUTO is OFF: it will exit by its rule, not re-enter') + trailTxt;
        return;
      }
      // A stop seen on a brick with no fresh price is decided at that brick's close (REAL replaces it with the fill).
      const exitPx = d.reason === 'stop' ? (stale ? null : price) ?? d.boxPrice ?? null : price;
      if (d.reason !== 'eod' && exitPx === null) { this.note = `${d.reason} seen, waiting for a price`; return; }
      this.busy = true;
      const barT = d.reason !== 'eod' && d.col !== undefined ? model.columnTimes[d.col]?.start : undefined;
      let closed = false;
      const best = d.reason === 'trail' ? trailBest(model, position) : null;   // fixed on the row: the re-entry level after this exit
      try { closed = await this.exit(row, d.reason, exitPx, barT, d.boxPrice, best); } finally { this.busy = false; }
      // A rule exit with AUTO off (a halt, a disarm) is the end of the trade: said out loud, so a missing re-entry is never silent.
      if (closed && !arm.on && d.reason !== 'eod') {
        const text = `exited (${d.reason}) while AUTO was OFF on this chart: no re-entry - arm AUTO to trade the next signal`;
        this.deps.event({ chart, kind: 'info', text: `AUTO C${chart} ${text}` });   // the event is the log line (lib/pnfAutoEngine.ts)
      }
      return;
    }
    if (!arm.on || this.halt) return;
    if (target.kind === 'index' && !i.indexMap) { this.note = 'an index chart trades options only through its map - arm it again from the page'; return; }
    if (!complete || stale || price === null) { this.note = stale ? 'feed stale: no entries' : 'waiting for a price'; return; }
    // The chart's last trade, if the trailing SL closed it today on this contract in this mode: same-side entries wait for a new best brick.
    // The EXIT's day (an NRML trade opened yesterday and trailed out today still blocks), and the rule's signals of both sides (an
    // opposite signal the Buy only / Sell only filter ignores still ends the wait: the trend turned).
    // The last TRADE on this contract in this mode: a refused entry (nothing opened) or another contract's / mode's row never ends the wait.
    const lastRow = [...ledger.rows].reverse().find(r => r.chart === chart && r.targetKey === tk && r.mode === arm.mode && r.reason !== 'refused');
    const today = istDateIso(this.deps.nowMs());
    const reentryBlock = lastRow && lastRow.exitT !== undefined && istDateIso(lastRow.exitT * 1000) === today
      ? reentryBlockOf(lastRow, ruleModel) : undefined;
    const d = decideAuto({ model, position: null, watermarkT: this.watermark, nowS, market, product: target.kind === 'equity' ? 'INTRADAY' : autoProductOf(arm.product), reentryBlock });
    // A signal whose entry kept failing before anything was sent, and is no longer enterable (a newer bar closed, it aged out): said once.
    const pending = this.retry;
    if (pending && !(d.action === 'enter' && d.signal.id === pending.id)) {
      this.retry = null;
      const text = `missed the ${pending.side} signal: ${pending.why} until it was no longer the newest bar's - nothing was sent`;
      this.deps.event({ chart, kind: 'info', text: `AUTO C${chart} ${text}` });   // the event is the log line (lib/pnfAutoEngine.ts)
    }
    if (d.action !== 'enter') {
      const held = d.action === 'none' ? ignoredByFilter(ruleModel, side, this.watermark) : null;
      if (held) {
        const what = `${isSellSignal(held.kind) ? 'SELL' : 'BUY'} signal ignored (${SIDE_LABEL[side]})`;
        this.note = what;
        if (this.ignored !== held.kind) { this.ignored = held.kind; void post({ op: 'log', chart, t: this.nowS(), text: what }); }   // once per change of direction, not per brick
      } else {
        const waiting = d.action === 'none' && (d.why === 'waiting for a signal' || d.why === 'signal is not on the last closed bar');
        const skip = waiting && rule ? skippedBrick(ruleModel, rule, this.watermark) : null;
        if (skip && this.skipped?.key !== skip.key) {
          this.skipped = skip;
          void post({ op: 'log', chart, t: this.nowS(), text: skip.text });
        }
        this.note = waiting && this.skipped ? `waiting for a signal · last: ${this.skipped.text}` : d.action === 'none' ? d.why : '';
      }
      return;
    }
    this.ignored = '';
    this.skipped = null;                                       // an entry: an older skipped brick is no longer the news
    const before = this.watermark;
    this.watermark = d.signal.t;                               // handled: this signal is never entered again...
    this.busy = true;
    try {
      const again = await this.enter(i, d.side, d.signal.t, price, d.boxPrice, d.signal.stop, d.signal.exitBy);
      if (again === null) this.retry = null;
      // ...unless nothing was sent and it may work next tick: the signal is kept (never across a new arming, which moved the watermark)
      else if (this.watermark === d.signal.t) {
        this.watermark = before;
        if (this.retry?.id !== d.signal.id) void post({ op: 'log', chart, t: nowS, text: `${d.side} signal not entered yet: ${again} - retrying while it is fresh` });
        this.retry = { id: d.signal.id, side: d.side, why: again };
      }
    } finally { this.busy = false; }
  }

  /**
   * Manual (or MTM-guard) exit of the open row, at the live price (PAPER: the ledger close; REAL: the same reserved exit as a rule exit).
   * It also switches AUTO off: otherwise a state-based rule would re-enter on the next brick. Never runs on an unresolved row.
   */
  async exitNow(i: Pick<ChartInputs, 'ledger' | 'price'>, why = 'manual'): Promise<boolean> {
    const row = this.rowOf(i.ledger);
    if (!row || row.state !== 'open' || this.busy) return false;
    // A close at the entry price would book a loss as flat: only the end-of-day exit may run without a price.
    if (i.price === null) { this.note = 'exit waiting for a live price'; this.deps.event({ chart: this.chart, kind: 'info', text: `AUTO C${this.chart} exit (${why}) is waiting for a live price` }); return false; }
    this.busy = true;
    try {
      this.deps.disarm(`${why} exit`);
      return await this.exit(row, why, i.price);
    } finally { this.busy = false; }
  }
}
