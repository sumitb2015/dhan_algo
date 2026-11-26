import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { DEBUG_DIR } from '@/lib/ivSnapshotFiles';
import { readJsonFile, withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { createBridgeWsClient } from '@/lib/bridgeWsClient';
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { globalOnce } from '@/lib/globalOnce';
import { indexSpotId, resolveFuture, resolveOption } from '@/lib/pnfContracts';
import { istDateIso } from '@/lib/nseHolidays';
import { mcxSession } from '@/lib/mcxSession';
import { readLadderSettings, timeStringToHhmm } from '@/lib/priceLadderSettings';
import {
  alertCorrelationId, alertLabel, alertOrderQty, appendLog, emptyAlertsState, expiryReason, newId, stepAlert, tradeBlock, tradeLine,
  DEFAULT_SOUND_SEC,
  type AlertEvent, type AlertsView, type AlertInput, type AlertInstrument, type AlertMemory, type AlertsState, type InstrumentSpec, type OrderOutcome, type PriceAlert,
} from '@/lib/priceAlerts';

// The Price Alerts server watcher (docs/PRICE_ALERTS_GUIDE.md). It owns debug/price_alerts.json (alerts + daily REAL arm)
// and debug/price_alerts_log.json (fired events), and every 500 ms evaluates each active alert against its instrument's
// WebSocket last price — the shared price bridge under the name `price_alerts`, no REST quotes. It keeps working with every
// tab closed and stops with the dashboard server. Idle (no bridge subscription, no file reads beyond one stat) without
// active alerts.
//
// A trade alert's order follows the Price Ladder's three-step write: CLAIM under the lock (status 'firing' + correlationId)
// before the order is sent, send outside the lock, RECORD the outcome under the lock. An unknown outcome is recorded as
// unknown and never resent; an alert still 'firing' a minute later (the server died mid-send) is marked unknown too.

const STATE_FILE = path.join(DEBUG_DIR, 'price_alerts.json');
const LOG_FILE = path.join(DEBUG_DIR, 'price_alerts_log.json');
const LOCK_FILE = `${STATE_FILE}.lock`;
const LOCK_STALE_MS = 8000;
const TICK_MS = 500;
/** A claim older than this with no recorded outcome = the send was interrupted: unknown, never resent. */
const FIRING_STALE_MS = 60_000;
/** No leader tab's stream seen for this long = nobody will hear the browser: the server plays the alarm itself. */
const LISTENER_STALE_MS = 10_000;
const TAG = '[price-alerts]';

const ws = createBridgeWsClient('price_alerts', '__priceAlertsWs', TAG);

// ── state + log files ─────────────────────────────────────────────────

function normalise(s: Partial<AlertsState> | null): AlertsState {
  const e = emptyAlertsState();
  if (!s) return e;
  return {
    alerts: Array.isArray(s.alerts) ? s.alerts : [],
    armedOn: typeof s.armedOn === 'string' ? s.armedOn : null,
    defaultSoundSec: Number.isInteger(s.defaultSoundSec) ? Number(s.defaultSoundSec) : e.defaultSoundSec,
    version: Number(s.version) || 0,
  };
}

/** Fresh read (API routes). */
export function readAlertsState(): AlertsState {
  return normalise(readJsonFile<Partial<AlertsState>>(STATE_FILE));
}

/** The watcher's read: re-parsed only when the file changed (one stat per tick otherwise). */
const cache = globalOnce('__priceAlertsStateCache', () => ({ sig: '', state: emptyAlertsState() }));
function readAlertsStateCached(): AlertsState {
  let sig = 'none';
  try { const st = fs.statSync(STATE_FILE); sig = `${st.mtimeMs}:${st.size}`; } catch { /* no file yet */ }
  if (sig !== cache.sig) { cache.sig = sig; cache.state = readAlertsState(); }
  return cache.state;
}

export function readAlertsLog(): AlertEvent[] {
  const f = readJsonFile<{ events?: AlertEvent[] }>(LOG_FILE);
  return Array.isArray(f?.events) ? f.events : [];
}

/**
 * Read-modify-write of the state (and optionally the log) under the lock. `mutate` returns a result; the state is written
 * (version bumped) only when it returns `changed: true`.
 */
export async function updateAlerts<T>(
  label: string,
  mutate: (s: AlertsState, log: AlertEvent[]) => { changed: boolean; result: T; log?: AlertEvent[] },
): Promise<T> {
  return withFileLock(LOCK_FILE, LOCK_STALE_MS, `${TAG} ${label}`, () => {
    const s = readAlertsState();
    const log = readAlertsLog();
    const r = mutate(s, log);
    if (r.changed) {
      s.version += 1;
      writeJsonAtomic(STATE_FILE, s, { pretty: true });
    }
    if (r.log) writeJsonAtomic(LOG_FILE, { events: r.log });
    return r.result;
  });
}

// ── instrument resolution (security ids come from master_list.csv, never the browser) ──

export function resolveSpec(spec: InstrumentSpec): AlertInstrument | string {
  if (spec.kind === 'index') {
    const id = indexSpotId(spec.symbol);
    return id
      ? { kind: 'index', segment: 'IDX_I', securityId: id, displayName: spec.symbol, underlying: spec.symbol, expiry: null, lot: 1 }
      : `${spec.symbol} is not a known index`;
  }
  if (spec.kind === 'future') {
    const c = resolveFuture(spec.underlying, spec.expiry);
    return c
      ? { kind: 'future', segment: c.segment, securityId: c.securityId, displayName: c.displayName || `${spec.underlying} FUT ${spec.expiry}`, underlying: spec.underlying, expiry: c.expiry, lot: c.lot }
      : `No ${spec.underlying} future expiring ${spec.expiry}`;
  }
  const c = resolveOption(spec.underlying, spec.expiry, spec.strike, spec.optType);
  return c
    ? {
      kind: 'option', segment: c.segment, securityId: c.securityId, displayName: c.displayName || `${spec.underlying} ${spec.strike} ${spec.optType}`,
      underlying: spec.underlying, expiry: c.expiry, lot: c.lot, strike: spec.strike, optType: spec.optType,
    }
    : `No ${spec.underlying} ${spec.strike} ${spec.optType} expiring ${spec.expiry}`;
}

/** Turns a checked input into the alert's resolved fields, or an error. */
export function resolveInput(input: AlertInput): Pick<PriceAlert, 'instrument' | 'condition' | 'value' | 'trigger' | 'expiresAt' | 'soundSec' | 'message' | 'action'> | string {
  const instrument = resolveSpec(input.instrument);
  if (typeof instrument === 'string') return instrument;
  let action: PriceAlert['action'] = { kind: 'notify' };
  if (input.action.kind === 'trade') {
    const contract = resolveSpec(input.action.contract);
    if (typeof contract === 'string') return contract;
    if (contract.segment === 'IDX_I') return 'An index cannot be traded';
    if (!alertOrderQty(contract, input.action.lots)) return `${contract.displayName} has no usable lot size`;
    action = { kind: 'trade', contract, side: input.action.side, lots: input.action.lots, product: input.action.product };
  }
  return {
    instrument, condition: input.condition, value: input.value, trigger: input.trigger, expiresAt: input.expiresAt,
    soundSec: input.soundSec, message: input.message, action,
  };
}

// ── listeners + server-side sound ─────────────────────────────────────

/** When a leader tab's stream last checked in (set by app/api/price-alerts/stream; same process, shared via globalThis). */
export const listeners = globalOnce('__priceAlertListeners', () => ({ leaderAt: 0 }));

const sound = globalOnce('__priceAlertSound', () => ({ proc: null as ChildProcess | null, until: 0 }));

/** A 16-bit mono WAV of `sec` seconds: the browser chime's three rising tones repeated every 0.8 s. */
function beepWav(sec: number): Buffer {
  const rate = 16000;
  const n = rate * sec;
  const data = Buffer.alloc(n * 2);
  const tones = [660, 880, 1175];
  for (let i = 0; i < n; i++) {
    const t = (i / rate) % 0.8;
    const k = Math.floor(t / 0.18);
    let v = 0;
    if (k < tones.length) {
      const local = t - k * 0.18;
      const env = Math.min(1, local / 0.01) * Math.max(0, 1 - local / 0.17);
      v = Math.sin(2 * Math.PI * tones[k] * (i / rate)) * env * 0.4;
    }
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Plays the alarm on the PC's speakers (Linux: pw-play, else aplay). No-op elsewhere or while one is already playing. */
export function playServerAlarm(sec: number): void {
  if (process.platform !== 'linux') { console.log(`${TAG} no tab listening and no server sound on ${process.platform}`); return; }
  const now = Date.now();
  if (sound.proc && now < sound.until) return;
  const file = path.join(DEBUG_DIR, `price_alert_beep_${sec}s.wav`);
  try { if (!fs.existsSync(file)) { fs.mkdirSync(DEBUG_DIR, { recursive: true }); fs.writeFileSync(file, beepWav(sec)); } } catch { return; }
  const run = (cmd: string, fallback?: string) => {
    const p = spawn(cmd, [file], { stdio: 'ignore' });
    sound.proc = p; sound.until = now + sec * 1000 + 500;
    p.on('error', () => { sound.proc = null; if (fallback) run(fallback); else console.warn(`${TAG} no audio player (pw-play / aplay)`); });
    p.on('exit', () => { if (sound.proc === p) sound.proc = null; });
  };
  run('pw-play', 'aplay');
}

// ── the watcher ───────────────────────────────────────────────────────

/** What the panel shows about the watcher itself: when it last ticked, and alerts with no usable price since when. */
const status = globalOnce('__priceAlertStatus', () => ({ tickAt: 0, unpricedSince: new Map<string, number>() }));
/** An alert this long without a usable price is reported (the bridge's replay needs ~8 s to settle on a new subscription). */
const UNPRICED_REPORT_MS = 20_000;

/** Per-alert price memory, keyed by what the alert watches: an edit (new level / condition / instrument) starts a fresh baseline. */
const memory = globalOnce('__priceAlertMemory', () => new Map<string, AlertMemory>());
const memKey = (a: PriceAlert) => `${a.id}|${a.instrument.segment}:${a.instrument.securityId}|${a.condition}|${a.value}|${a.updatedAt}`;

interface Fire { alert: PriceAlert; price: number }

const toOutcome = (r: Awaited<ReturnType<typeof placeDhanOrder>>, qty: number, at: number): OrderOutcome =>
  r.status === 'placed' ? { status: 'placed', orderId: r.orderId, qty, at }
    : r.status === 'unknown' ? { status: 'unknown', message: `${r.error} (correlation id kept on the alert)`, qty, at }
      : { status: 'rejected', message: r.error, qty, at };

/** Sends a claimed trade alert's order (outside the lock) and records the outcome on the alert and its log event. */
async function sendOrder(alert: PriceAlert, eventId: string, armedOn: string | null): Promise<void> {
  const now = Date.now();
  let outcome: OrderOutcome;
  const settings = readLadderSettings();
  const block = tradeBlock({ armedOn }, alert, now, {
    nse: timeStringToHhmm(settings.nseAutoExitTime) ?? undefined,
    mcx: mcxSession(istDateIso(now), timeStringToHhmm(settings.mcxAutoExitTime)).autoExit,
  });
  if (alert.action.kind !== 'trade') return;
  const qty = alertOrderQty(alert.action.contract, alert.action.lots);
  if (block) {
    outcome = { status: 'skipped', message: block, at: now };
  } else {
    try {
      const r = await placeDhanOrder({
        securityId: alert.action.contract.securityId, exchangeSegment: alert.action.contract.segment, quantity: qty,
        side: alert.action.side, orderType: 'MARKET', productType: alert.action.product, source: 'pa', correlationId: alert.correlationId,
      });
      outcome = toOutcome(r, qty, Date.now());
    } catch (err) {
      outcome = { status: 'unknown', message: `Order send threw: ${String((err as Error)?.message ?? err)} — check the order book before retrying`, qty, at: Date.now() };
    }
  }
  console.log(`${TAG} ${alertLabel(alert)} -> ${tradeLine(alert.action)}: ${outcome.status}${'message' in outcome ? ` (${outcome.message})` : ''}`);
  await updateAlerts('order-outcome', (s, log) => {
    const a = s.alerts.find(x => x.id === alert.id);
    if (a && a.status === 'firing') { a.status = 'triggered'; a.order = outcome; a.updatedAt = Date.now(); }
    const next = log.map(e => (e.id === eventId ? { ...e, order: outcome } : e));
    return { changed: !!a, result: undefined, log: next };
  });
}

async function tick(): Promise<void> {
  const state = readAlertsStateCached();
  const now = Date.now();
  const stale = state.alerts.filter(a => a.status === 'firing' && now - (a.lastFiredAt ?? 0) > FIRING_STALE_MS);
  const expired = state.alerts.filter(a => (a.status === 'active' || a.status === 'paused') && expiryReason(a, now));
  const active = state.alerts.filter(a => a.status === 'active' && !expiryReason(a, now));

  // Drop memory of alerts that are gone or changed.
  const live = new Set(active.map(memKey));
  for (const k of memory.keys()) if (!live.has(k)) memory.delete(k);

  status.tickAt = now;
  for (const id of status.unpricedSince.keys()) if (!active.some(a => a.id === id)) status.unpricedSince.delete(id);
  const fires: Fire[] = [];
  if (active.length) {
    const keys = active.map(a => ws.want(a.instrument.segment, a.instrument.securityId));
    const prices = ws.prices(keys, ws.sync());           // one parse of the quotes file per tick
    active.forEach((a, i) => {
      const q = prices.get(keys[i]);
      if (!q) {                                     // no fresh price: keep the last one, evaluate when it returns
        if (!status.unpricedSince.has(a.id)) status.unpricedSince.set(a.id, now);
        return;
      }
      status.unpricedSince.delete(a.id);
      const k = memKey(a);
      // A trade alert never fires on its first price (Greater / Less Than included): the price must move into it.
      const r = stepAlert(a, memory.get(k), q.ltp, now, a.action.kind === 'trade');
      memory.set(k, r.mem);
      if (r.fire) fires.push({ alert: a, price: q.ltp });
    });
  } else {
    ws.sync();                                      // no asks: removes this process's wanted file once
  }
  if (!fires.length && !expired.length && !stale.length) return;

  // Claim under the lock, re-checking each alert is still the one evaluated (not edited, paused or deleted meanwhile).
  const claimed = await updateAlerts('fire', (s, log) => {
    const t = Date.now();
    const events: AlertEvent[] = [];
    const orders: { alert: PriceAlert; eventId: string }[] = [];
    let changed = false;
    for (const x of stale) {
      const a = s.alerts.find(y => y.id === x.id);
      if (a?.status === 'firing') {
        a.status = 'triggered';
        a.order = { status: 'unknown', message: 'Server stopped while the order was being sent — check the order book; not resent', at: t };
        changed = true;
      }
    }
    for (const x of expired) {
      const a = s.alerts.find(y => y.id === x.id);
      if (a && (a.status === 'active' || a.status === 'paused') && expiryReason(a, t)) { a.status = 'expired'; a.updatedAt = t; changed = true; }
    }
    for (const f of fires) {
      const a = s.alerts.find(y => y.id === f.alert.id);
      if (!a || a.status !== 'active' || a.updatedAt !== f.alert.updatedAt) continue;
      a.firedCount += 1; a.lastFiredAt = t; a.lastFiredPrice = f.price;
      const ev: AlertEvent = {
        id: newId(t), at: t, alertId: a.id, symbol: a.instrument.displayName, condition: a.condition, value: a.value, price: f.price,
        message: a.message || `${alertLabel(a)} (last ${f.price})`, soundSec: a.soundSec, action: a.action.kind,
        ...(a.action.kind === 'trade' ? { trade: tradeLine(a.action) } : {}),
      };
      events.push(ev);
      if (a.action.kind === 'trade') {
        a.status = 'firing';
        a.correlationId = alertCorrelationId(a.id, t);
        orders.push({ alert: structuredClone(a), eventId: ev.id });
      } else if (a.trigger === 'once') {
        a.status = 'triggered';
      }
      changed = true;
    }
    return { changed, result: { events, orders, armedOn: s.armedOn }, ...(events.length ? { log: appendLog(log, events) } : {}) };
  });

  if (claimed.events.length) {
    for (const e of claimed.events) console.log(`${TAG} fired: ${e.message} @ ${e.price}`);
    if (Date.now() - listeners.leaderAt > LISTENER_STALE_MS) playServerAlarm(Math.max(...claimed.events.map(e => e.soundSec)) || DEFAULT_SOUND_SEC);
  }
  // Orders after the claim is on disk. Each one independently: one failing never holds up another.
  await Promise.all(claimed.orders.map(o => sendOrder(o.alert, o.eventId, claimed.armedOn).catch(err => console.error(`${TAG} order record failed:`, err))));
}

interface Loop { timer: ReturnType<typeof setInterval>; busy: boolean }

/** Starts the watcher once per process (instrumentation + any API route). Skipped for the Playwright test server. */
export function startPriceAlertLoop(): void {
  if (process.env.DASHBOARD_NO_BACKGROUND === '1') return;
  const g = globalThis as { __priceAlertLoop?: Loop };
  if (g.__priceAlertLoop) return;
  const loop: Loop = {
    busy: false,
    timer: setInterval(() => {
      if (loop.busy) return;
      loop.busy = true;
      tick().catch(err => console.error(`${TAG} tick failed:`, err)).finally(() => { loop.busy = false; });
    }, TICK_MS),
  };
  g.__priceAlertLoop = loop;
  console.log(`${TAG} watcher started (${TICK_MS} ms)`);
}

/** The view the browser gets: alerts, arm state (as "armed today"), and the newest log events. */
export function alertsView(logLimit = 100): AlertsView {
  const s = readAlertsState();
  const log = readAlertsLog();
  const now = Date.now();
  return {
    watcher: {
      running: now - status.tickAt < 5_000,
      unpriced: [...status.unpricedSince].filter(([, since]) => now - since >= UNPRICED_REPORT_MS).map(([id]) => id),
    },
    alerts: s.alerts,
    armedToday: s.armedOn === istDateIso(Date.now()),
    defaultSoundSec: s.defaultSoundSec,
    version: s.version,
    log: log.slice(-logLimit),
  };
}
