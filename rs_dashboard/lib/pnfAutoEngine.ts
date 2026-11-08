import type { ServerBrick } from './pnfServerBrick.ts';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyAutoLedgerOp, readAutoLedger } from '@/lib/pnfAutoServer';
import { ChartEngine, type AutoArm, type AutoPyramid, type ChartDeps, type ChartInfo, type OrderReply } from '@/lib/pnfAutoChart';
import { isLive, type ArmRun, type AutoArmRecord, type AutoLedger, type AutoRow } from '@/lib/pnfAutoLedger';
import { armWatermark } from '@/lib/pnfAutoArm';
import { pyramidEveryOf } from '@/lib/pnfAuto';
import { AUTO_RULES, DEFAULT_AUTO_RULE, modelForRule, type AutoRule, type AutoSide } from '@/lib/pnfAutoRule';
import { placePnfMarket } from '@/lib/pnfAutoOrders';
import { parsePnfOrder, type PnfBroker } from '@/lib/pnfOrderLogic';
import { brokerLegs, resolvePnfLegs } from '@/lib/pnfOrderServer';
import { readOrderPriceServer } from '@/lib/brokerOrderStatus';
import { ServerFeed } from '@/lib/pnfServerFeed';
import { buildConfirmedModel, withLive, type ConfirmedModel, type PanelModel } from '@/lib/straddlePnfModel';
import { effectiveInterval, hasLongIntervals, isTickInterval, tickBucketSec } from '@/lib/straddlePnfInterval';
import { sessionWindow } from '@/lib/straddlePnfLive';
import { istDateIso } from '@/lib/nseHolidays';
import { targetKey, parseOptionIds, type Target } from '@/lib/pnfTarget';
import type { PnfScope } from '@/lib/pnfScope';
import { premiumOf, resolveIndexTrade } from '@/lib/pnfIndexTradeServer';
import { askBridge } from '@/lib/pnfLiveBridge';
import type { WantedPair } from '@/lib/pnfWanted';

// The P&F / Renko AUTO engine on the dashboard SERVER: it builds each armed chart from the saved arming (target + settings, lib/
// pnfAutoLedger.ts ArmRun) and runs the AUTO rules on it (lib/pnfAutoChart.ts, the same engine the page used to run) with every tab
// closed. Entries, rule exits, pyramid adds, end of day and reading back REAL fills all happen here; the page arms, disarms and shows
// what this engine says (debug/<scope>_auto_engine.json). It stops with the dashboard: `next start` must be running for AUTO to trade.
//
// One engine per machine: debug/pnf_auto_engine.lock names the process that runs it (taken over once its heartbeat is 10 s old), so a
// second dashboard on the same debug/ folder (a `next dev` beside `next start`) never trades the same arming twice.

const DEBUG = path.join(PROJECT_ROOT, 'debug');
const LOCK_FILE = path.join(DEBUG, 'pnf_auto_engine.lock');
const TICK_MS = 1_000;
const LOCK_STALE_MS = 10_000;
const SETTLE_EVERY_MS = 15_000;
/** A REAL row reserved this long with no outcome, while this engine is not sending for it, was left by a restart: it is said UNKNOWN. */
const ORPHAN_MS = 120_000;
const SCOPES: PnfScope[] = ['pnf', 'renko'];
const DEFAULT_TRAIL = 2;

export const engineFileFor = (scope: PnfScope) => path.join(DEBUG, scope === 'renko' ? 'renko_auto_engine.json' : 'pnf_auto_engine.json');

/** What the page shows for a chart: the engine's status line, a halt, the newest brick it trades on, and when it last looked. */
export interface EngineChartView {
  note: string;
  halt: string | null;
  armT: number | null;
  /** The server's newest brick (lib/pnfServerBrick.ts); its edges let the page tell the same brick from a build that started earlier. */
  lastBrick: ServerBrick | null;
  /** The chart the engine is building (the arming's, or the last one while its position is open). */
  targetKey: string | null;
  feedError: string | null;
  run?: ArmRun;
}
export interface EngineFile { v: 1; pid: number; t: number; charts: Partial<Record<'1' | '2', EngineChartView>> }

export function readEngineFile(scope: PnfScope): EngineFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(engineFileFor(scope), 'utf8')) as Partial<EngineFile>;
    return j && j.v === 1 && typeof j.t === 'number' ? { v: 1, pid: Number(j.pid) || 0, t: j.t, charts: j.charts ?? {} } : null;
  } catch { return null; }
}

interface ChartRt {
  engine: ChartEngine;
  feed: ServerFeed | null;
  feedKey: string;
  prev: ConfirmedModel | null;
  model: PanelModel | null;
  /** What the confirmed model was built from (closed bars + history version): rebuilt only when it changes, as on the page. */
  modelKey: string;
  info: { key: string; val: ChartInfo; pending: boolean; retryAt: number } | null;
  /** The last arming's chart: kept while its position is open, so a disarmed chart still exits by its rule. */
  run: ArmRun | null;
  lastSettle: number;
  busy: boolean;
}

type EngineState = {
  timer: ReturnType<typeof setInterval> | null; busy: boolean; charts: Map<string, ChartRt>; owner: boolean; lastTickAt: number;
  /** Nothing armed or open on the last tick: the engine files were not rewritten (the page reads `idle` from the route). */
  idle: boolean;
  saved: Partial<Record<PnfScope, EngineFile | null>>;
  /** The last tick's failure (cleared by a good tick), and how many ticks have run: the route reports both, so a stuck engine says why. */
  lastError?: string | null;
  ticks?: number;
};
type G = { __pnfAutoEngine?: EngineState };
const g = globalThis as G;
const state: EngineState = (g.__pnfAutoEngine ??= { timer: null, busy: false, charts: new Map(), owner: false, lastTickAt: 0, idle: true, saved: {} });

/** This process runs the engine: the lock is ours, free, or its owner has stopped beating. */
function holdLock(nowMs: number): boolean {
  try {
    fs.mkdirSync(DEBUG, { recursive: true });
    let cur: { pid?: number; t?: number } | null = null;
    try { cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { cur = null; }
    if (cur && cur.pid !== process.pid && typeof cur.t === 'number' && nowMs - cur.t < LOCK_STALE_MS) {
      if (state.owner) console.warn(`[pnf-auto-engine] the engine lock is held by pid ${cur.pid}: this process stands down`);
      state.owner = false;
      return false;
    }
    writeJsonAtomic(LOCK_FILE, { pid: process.pid, t: nowMs });
    if (!state.owner) console.log(`[pnf-auto-engine] running AUTO in pid ${process.pid}`);
    state.owner = true;
    return true;
  } catch { return state.owner; }
}

function depsFor(scope: PnfScope, chart: 1 | 2): ChartDeps {
  const log = (text: string, kind?: 'entry' | 'exit' | 'info') => void applyAutoLedgerOp(scope, { op: 'log', chart, t: Date.now() / 1000, text, ...(kind ? { kind } : {}) });
  return {
    post: op => applyAutoLedgerOp(scope, op),
    sendOrder: async body => {
      const order = parsePnfOrder({ source: 'auto', ...body });
      if (typeof order === 'string') return { success: false, outcome: 'rejected', error: order };
      const r = await placePnfMarket(order, scope);
      const reply = r.body as OrderReply;
      // A throw after something was sent comes back as HTTP 504 with no outcome ("Order status unknown"): UNKNOWN, never a refusal (a
      // refusal would void the row while an order may be live at the broker).
      if (!reply.outcome && (r.status === 504 || /status unknown/i.test(String(reply.error ?? '')))) return { ...reply, outcome: 'unknown', message: reply.error };
      return reply;
    },
    readOrderPrice: (id, broker) => readOrderPriceServer(id, broker),
    // A halt is already in the log (the engine writes it with its kind); entries, exits and refusals are written here, for the page's toasts.
    event: e => { if (e.kind !== 'halt') log(e.text.replace(/^AUTO C\d /, ''), e.kind); },
    disarm: why => void applyAutoLedgerOp(scope, { op: 'setArm', chart, arm: null, t: Date.now() / 1000, text: `AUTO switched off: ${why}` }),
    nowMs: () => Date.now(),
    sleep: ms => new Promise(res => setTimeout(res, ms)),
    // A Renko index chart: the option its map trades, resolved from the server's own index price; its premium is quoted too (P&L is in it).
    resolveIndex: async (broker, index, map, dir) => {
      const r = await resolveIndexTrade(broker, index, map, dir, true);
      return typeof r === 'string' ? r : { traded: r.traded, action: r.action, ids: r.ids, premium: r.premium, unsupported: r.unsupported, legs: r.legs };
    },
    premium: ids => premiumOf(ids, `autoengine:${scope}:${chart}:opt`),
  };
}

function rtFor(scope: PnfScope, chart: 1 | 2, saved: EngineChartView | undefined): ChartRt {
  const key = `${scope}:${chart}`;
  let rt = state.charts.get(key);
  if (!rt) {
    rt = { engine: new ChartEngine(chart, depsFor(scope, chart)), feed: null, feedKey: '', prev: null, model: null, modelKey: '', info: null, run: saved?.run ?? null, lastSettle: 0, busy: false };
    state.charts.set(key, rt);
  }
  return rt;
}

/**
 * One lot of the chart's contract on the broker, resolved once per broker + contract (in the background). A lookup that FAILED (a broker
 * session not up yet, a cache still loading) is not an answer: the chart waits (null: "waiting for the contract lookup") and it is tried
 * again a minute later, rather than halting REAL AUTO on a temporary error. Only a definite "cannot trade this" is `unsupported`.
 */
const LOOKUP_RETRY_MS = 60_000;
function infoFor(rt: ChartRt, broker: PnfBroker, target: Target, nowMs: number): ChartInfo {
  const key = `${broker}|${targetKey(target)}`;
  if (rt.info?.key === key && (rt.info.pending || rt.info.val !== null || nowMs < rt.info.retryAt)) return rt.info.val;
  if (target.kind === 'index') return null;
  let legs: ReturnType<typeof resolvePnfLegs>;
  try { legs = resolvePnfLegs(target); } catch (e) {
    // the contract master unreadable (master_list.csv missing / being rewritten): wait and try again, never stop the whole tick
    rt.info = { key, val: null, pending: false, retryAt: nowMs + LOOKUP_RETRY_MS };
    console.warn(`[pnf-auto-engine] contract lookup for ${key} failed (retried in a minute): ${(e as Error).message}`);
    return null;
  }
  if (typeof legs === 'string') { rt.info = { key, val: { legs: [], unsupported: legs }, pending: false, retryAt: 0 }; return rt.info.val; }
  const slot: NonNullable<ChartRt['info']> = { key, val: null, pending: true, retryAt: 0 };
  rt.info = slot;
  brokerLegs(broker, target, legs).then(on => {
    if (typeof on === 'string') { slot.val = { legs: legs.map(l => ({ label: l.label, lot: l.lot, unitsPerLot: l.unitsPerLot, key: null, lotUnits: null })), unsupported: on }; return; }
    slot.val = { legs: legs.map((l, i) => ({ label: l.label, lot: l.lot, unitsPerLot: l.unitsPerLot, key: on[i].key, lotUnits: on[i].lotUnits })), unsupported: null };
  }, (e: Error) => {
    slot.val = null;
    slot.retryAt = Date.now() + LOOKUP_RETRY_MS;
    console.warn(`[pnf-auto-engine] contract lookup for ${key} failed (retried in a minute): ${e.message}`);
  }).finally(() => { slot.pending = false; });
  return null;
}

const EMPTY_MODEL = { chart: 'pnf', box: 0, signals: [], columns: [], columnTimes: [], lastBarT: null, trend: [], twoBack: [], oneBack: [], stSignals: [], supertrend: [] } as unknown as PanelModel;

/** The chart's confirmed model on the server: the page's useChartModel on the server feed's bars. */
function modelFor(rt: ChartRt, scope: PnfScope, run: ArmRun, nowMs: number): { model: PanelModel; feed: ServerFeed; price: number | null; stale: boolean } {
  const renko = scope === 'renko';
  const interval = effectiveInterval(run.settings.interval, hasLongIntervals(run.target.kind), renko);
  const tickSec = renko && isTickInterval(interval) ? tickBucketSec(interval) : null;
  const feedKey = `${targetKey(run.target)}|${tickSec}`;
  if (!rt.feed || rt.feedKey !== feedKey) {
    rt.feed = new ServerFeed(run.target, tickSec, `autoengine:${scope}:${rt.engine.chart}`);
    rt.feedKey = feedKey; rt.prev = null; rt.modelKey = ''; rt.model = null;
  }
  const feed = rt.feed;
  feed.step(nowMs);
  const bars = feed.chartBars(nowMs);
  const last = bars[bars.length - 1];
  // the minute still forming is left out (a Tick / N-second chart has none: its bars are emitted only once closed)
  const forming = tickSec === null && last !== undefined && last.t >= Math.floor(nowMs / 60_000) * 60;
  const n = forming ? bars.length - 1 : bars.length;
  const closedLast = bars[n - 1];
  const sessionClose = sessionWindow(feed.market, nowMs / 1000)[1];
  // The confirmed chart depends only on the closed bars (and the session close): rebuilt when a bar closes or the history reloads, not
  // on every one-second step (the page's closedKey).
  const key = `${n}:${bars[0]?.t ?? 0}:${closedLast?.t ?? 0}:${closedLast?.straddle ?? 0}:${feed.histVersion}:${sessionClose}`;
  if (key !== rt.modelKey || !rt.model) {
    const closed = forming ? bars.slice(0, -1) : bars;
    const confirmed = buildConfirmedModel(closed, 'vwap', {
      ...run.settings, interval, sessionCloseMin: sessionClose || undefined, volume: run.volume,
      anchorT: run.anchorT ?? feed.anchorT ?? undefined, boxBaseT: run.boxBaseT, chart: renko ? 'renko' : 'pnf',
    }, rt.prev);
    rt.prev = confirmed;
    rt.model = withLive(confirmed);
    rt.modelKey = key;
  }
  return { model: rt.model, feed, price: feed.price(nowMs, bars), stale: feed.stale(nowMs, bars) };
}

function pyramidOf(rec: AutoArmRecord): AutoPyramid | undefined {
  if (!rec.pyramid) return undefined;
  return { on: true, max: rec.pyramid.max, every: pyramidEveryOf(rec.pyramid.every), trailOn: rec.pyramid.trail !== 0, trail: rec.pyramid.trail || DEFAULT_TRAIL };
}

/** REAL rows reserved with no outcome for ORPHAN_MS while nothing here is sending for them: left by a restart mid-order. */
async function sweepOrphans(scope: PnfScope, ledger: AutoLedger, nowS: number) {
  for (const r of ledger.rows) {
    if (r.mode !== 'REAL' || !(r.state === 'entering' || r.state === 'exiting' || r.state === 'adding')) continue;
    if (!(r.pendingSince && nowS - r.pendingSince > ORPHAN_MS / 1000)) continue;
    const rt = state.charts.get(`${scope}:${r.chart}`);
    if (rt?.busy) continue;
    await applyAutoLedgerOp(scope, { op: 'markUnknown', id: r.id, note: `no outcome recorded for ${Math.round((nowS - r.pendingSince) / 60)} min (the dashboard may have restarted with the order on the wire) - check the broker, then resolve it` });
    await applyAutoLedgerOp(scope, { op: 'log', chart: r.chart, t: nowS, kind: 'info', text: `${r.state} order outcome unknown after a restart - check Orders/Positions, then resolve it` });
  }
}

/** The arming as the engine runs it; its watermark rebuilt from the ledger (lib/pnfAutoArm.ts), so a restart never re-enters a signal. */
const arming = (rec: AutoArmRecord | undefined, row: AutoRow | undefined, ledger: AutoLedger, chart: 1 | 2): AutoArm => rec
  ? { on: true, mode: rec.mode, watermarkT: armWatermark(rec, ledger.rows, chart), armT: rec.t, ...(rec.product ? { product: rec.product } : {}) }
  : { on: false, mode: row?.mode ?? 'PAPER', watermarkT: 0 };

/** One chart's step: refuse an arming the engine cannot run, build the chart, run the rules. */
async function stepChart(scope: PnfScope, chart: 1 | 2, ledger: AutoLedger, saved: EngineChartView | undefined, nowMs: number): Promise<EngineChartView | null> {
  const k = String(chart) as '1' | '2';
  let rec = ledger.arms?.[k];
  const row = ledger.rows.find(r => r.chart === chart && isLive(r));
  const rt = rtFor(scope, chart, saved);
  const today = istDateIso(nowMs);
  if (rec && rec.day !== today) {
    await applyAutoLedgerOp(scope, { op: 'setArm', chart, arm: null, t: nowMs / 1000, text: `AUTO switched off: armed on ${rec.day}, an arming never carries into another day` });
    rec = undefined;
  } else if (rec && !rec.run) {
    await applyAutoLedgerOp(scope, { op: 'setArm', chart, arm: null, t: nowMs / 1000, text: 'AUTO switched off: armed from a page that did not save its chart for the server - reload the page and arm again' });
    rec = undefined;
  }
  if (rec?.run) rt.run = rec.run;
  if (!rec && !row) {
    // idle chart; a halt stays on the page (with why) until the next arming clears it
    rt.run = null; rt.feed = null; rt.prev = null; rt.model = null; rt.modelKey = '';
    return rt.engine.halt ? { note: '', halt: rt.engine.halt, armT: null, lastBrick: null, targetKey: null, feedError: null } : null;
  }
  const run = rt.run;
  const target = run?.target ?? row!.target;
  const broker = (rec?.broker ?? row?.broker ?? 'dhan') as PnfBroker;
  let model = EMPTY_MODEL, price: number | null = null, stale = true, complete = false, market = row?.market ?? 'NSE', feedError: string | null = null;
  if (run) {
    const m = modelFor(rt, scope, run, nowMs);
    model = m.model; price = m.price; stale = m.stale; complete = m.feed.loaded; market = m.feed.market; feedError = m.feed.error;
  }
  const renko = scope === 'renko';
  const rule = renko && AUTO_RULES.includes(rec?.rule as AutoRule) ? rec!.rule as AutoRule : renko ? DEFAULT_AUTO_RULE : undefined;
  const arm = arming(rec, row, ledger, chart);
  // An index chart's open option row: its option is kept on the price bridge (its exit and P&L are priced on it, tab open or not).
  const held = row?.traded;
  if (held) {
    const m = parseOptionIds(held.ids);
    if (m) { try { askBridge(`autoengine:${scope}:${chart}:opt`, [[m.segment, m.securityId]] as WantedPair[], nowMs); } catch { /* the exit quotes it */ } }
  }
  if (rec && rt.engine.guardExitedSinceArm(ledger, arm)) {
    await applyAutoLedgerOp(scope, { op: 'setArm', chart, arm: null, t: nowMs / 1000, text: `AUTO switched off: the server guard exited chart ${chart}` });
  } else if (!rt.busy) {
    rt.busy = true;
    const inputs = {
      arm, lots: rec?.lots ?? row?.lots ?? 1, target, model: renko && rule ? modelForRule(rule, model) : model, rule, side: (rec?.side ?? 'both') as AutoSide,
      pyramid: rec ? pyramidOf(rec) : undefined, price, stale, market, complete, broker, ledger, info: infoFor(rt, broker, target, nowMs),
      ...(run?.indexMap ? { indexMap: run.indexMap } : {}),
    };
    // Each chart runs on its own: an order on the wire on one chart never holds the other chart (or the other page) back.
    void rt.engine.tick(inputs).catch(e => console.error(`[pnf-auto-engine] ${scope} chart ${chart}:`, e)).finally(() => { rt.busy = false; });
  }
  if (nowMs - rt.lastSettle >= SETTLE_EVERY_MS) { rt.lastSettle = nowMs; rt.engine.settle(ledger); }
  const cols = model.columns;
  const lc = cols.length ? cols[cols.length - 1] : null;
  return {
    note: run ? rt.engine.note : 'no chart saved for this position: only the server guard and end of day exit it',
    halt: rt.engine.halt, armT: rec?.t ?? null,
    lastBrick: lc ? { n: cols.length, dir: lc.dir, barT: model.columnTimes[cols.length - 1]?.start ?? 0, box: model.box, low: lc.low, high: lc.high } : null,
    targetKey: run ? targetKey(run.target) : row ? row.targetKey : null, feedError, ...(run ? { run } : {}),
  };
}

async function tick(): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.ticks = (state.ticks ?? 0) + 1;
  try {
    const nowMs = Date.now();
    const ledgers = SCOPES.map(scope => ({ scope, ledger: readAutoLedger(scope) }));
    // Idle (nothing armed, nothing open, no halt to show): two ledger reads a second and nothing else. The lock is only held while there is
    // work, and taken (or refused) before any of it.
    const busyScope = (l: AutoLedger) => !!(l.arms && Object.keys(l.arms).length) || l.rows.some(isLive);
    const work = ledgers.some(({ ledger }) => busyScope(ledger)) || [...state.charts.values()].some(rt => rt.engine.halt);
    if (!work) {
      // going idle: the last views (an arming just switched off) are cleared once, so no page shows a stale status
      if (!state.idle && state.owner) for (const scope of SCOPES) { try { writeJsonAtomic(engineFileFor(scope), { v: 1, pid: process.pid, t: nowMs, charts: {} } satisfies EngineFile); } catch { /* next */ } }
      state.lastTickAt = nowMs; state.idle = true; state.lastError = null;
      return;
    }
    if (!holdLock(nowMs)) return;
    state.lastTickAt = nowMs;
    state.idle = false;
    for (const { scope, ledger } of ledgers) {
      // the views written before a restart: read once, for the chart of an open position whose arming was switched off
      const saved: EngineState['saved'] = (state.saved ??= {});
      const prev = saved[scope] !== undefined ? saved[scope] : (saved[scope] = readEngineFile(scope));
      const charts: EngineFile['charts'] = {};
      for (const chart of [1, 2] as const) {
        try {
          const v = await stepChart(scope, chart, ledger, prev?.charts[String(chart) as '1' | '2'], nowMs);
          if (v) charts[String(chart) as '1' | '2'] = v;
        } catch (e) {
          // one chart's failure never stops the other chart, the other page or the status file; it is shown on the chart
          console.error(`[pnf-auto-engine] ${scope} chart ${chart} step failed:`, e);
          charts[String(chart) as '1' | '2'] = { note: `engine error: ${(e as Error).message}`, halt: null, armT: null, lastBrick: null, targetKey: null, feedError: null };
        }
      }
      await sweepOrphans(scope, ledger, nowMs / 1000);
      try { writeJsonAtomic(engineFileFor(scope), { v: 1, pid: process.pid, t: nowMs, charts } satisfies EngineFile); } catch { /* next tick */ }
    }
    state.lastError = null;
  } catch (e) {
    console.error('[pnf-auto-engine] tick failed:', e);
    state.lastError = `${(e as Error).message ?? e}`.slice(0, 300);
  } finally {
    state.busy = false;
  }
}

/**
 * A manual (or the page's MTM guard) exit of chart `chart`'s open AUTO row, at the engine's live price for THE ROW'S contract. It switches
 * AUTO off on that chart too (a trend rule would re-enter at once). `fallback`: this process cannot exit it (it does not run the engine,
 * or has no fresh price for that contract) and nothing was tried, so the page exits it itself (lib/pnfAutoChart.ts exitNow, the same
 * reserved exit: whoever takes the row's beginExit first owns it).
 */
export async function requestExit(scope: PnfScope, chart: 1 | 2, why: string): Promise<{ ok: boolean; error?: string; fallback?: boolean }> {
  if (!state.owner) return { ok: false, fallback: true, error: 'the AUTO engine is not running in this dashboard process' };
  const ledger = readAutoLedger(scope);
  const row = ledger.rows.find(r => r.chart === chart && isLive(r));
  if (!row) return { ok: false, error: 'no open AUTO position on this chart' };
  const rt = state.charts.get(`${scope}:${chart}`);
  const nowMs = Date.now();
  // a feed of another contract (the chart re-armed on another one) or a stale one never prices this row's exit
  if (!rt?.feed || targetKey(rt.feed.target) !== row.targetKey || rt.feed.stale(nowMs)) {
    return { ok: false, fallback: true, error: 'the engine has no fresh price for this position\'s contract' };
  }
  const ok = await rt.engine.exitNow({ ledger, price: rt.feed.price(nowMs) }, why);
  return ok ? { ok } : { ok, error: rt.engine.note || 'the exit did not complete' };
}

export function startPnfAutoEngine(): void {
  if (state.timer) return;
  state.timer = setInterval(() => { void tick(); }, TICK_MS);
  state.timer.unref?.();
}

/** This process's engine: its last tick (0 = never), and whether that tick found nothing to do (the engine files are then not rewritten). */
export const engineHeartbeat = () => ({
  t: state.lastTickAt, idle: state.idle, pid: process.pid, started: !!state.timer, ticks: state.ticks ?? 0, owner: state.owner, error: state.lastError ?? null,
});
