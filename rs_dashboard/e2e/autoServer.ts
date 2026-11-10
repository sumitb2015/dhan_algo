import { type Route } from '@playwright/test';
import { json } from './support';
import { applyAutoOp, type AutoLedger, type AutoOp } from '../lib/pnfAutoLedger';

// The dashboard SERVER's part of P&F / Renko AUTO, for the page's e2e specs. Since feaa01a5 (2026-11-06) AUTO trades on the server
// (lib/pnfAutoEngine.ts): the page arms it (the ledger's `arms`, with the chart the server is to build), shows the rows, log lines and
// status the server writes, and asks it for a manual or MTM-guard exit. This stand-in gives the page a live heartbeat (else it says
// SERVER ENGINE QUIET), a status line per chart and the exit route, and writes the rows the engine would - through the REAL ledger ops.
// What the engine DECIDES (which bar enters, adds, exits, retries) is unit-tested in lib/pnfAutoChart.test.ts / lib/pnfAuto.test.ts:
// it builds its chart from the server's own files and cannot run in a browser mock.

export type AutoState = { ledger: AutoLedger; tick: { ltp: number; at: number } };
type View = { note: string; halt: string | null; armT: number | null; lastBrick: null; targetKey: string | null; feedError: null };
export type AutoServer = { view: Record<string, View>; exits: { chart: 1 | 2; why: string }[] };

export const newAutoServer = (): AutoServer => ({ view: {}, exits: [] });
export const engineView = (o: Partial<View>): View => ({ note: '', halt: null, armT: null, lastBrick: null, targetKey: null, feedError: null, ...o });

export function apply(state: AutoState, op: AutoOp) {
  const r = applyAutoOp(state.ledger, op);
  if (!r.ok) throw new Error(`ledger refused ${op.op}: ${r.error}`);
  state.ledger = r.ledger;
}

/** GET /api/straddle-pnf/auto: the ledger plus a live engine (its heartbeat and status are fresh on the server clock; the page's is faked). */
export function autoGet(route: Route, state: AutoState, server: AutoServer) {
  const now = Date.now();
  return json(route, {
    success: true, ledger: state.ledger,
    engine: { v: 1, pid: 1, t: now, charts: server.view },
    heartbeat: { t: now, idle: false, pid: 1, started: true, ticks: 1, owner: true },
    serverNow: now,
  });
}

/** POST /api/straddle-pnf/auto/exit (lib/pnfAutoEngine.ts requestExit): exits the chart's open row at its price and switches its AUTO off. */
export function autoExit(route: Route, state: AutoState, server: AutoServer) {
  const b = route.request().postDataJSON() as { chart: 1 | 2; why: string };
  server.exits.push(b);
  const row = state.ledger.rows.find(x => x.chart === b.chart && x.state === 'open');
  if (row) serverClose(state, { price: state.tick.ltp, reason: b.why });
  apply(state, { op: 'setArm', chart: b.chart, arm: null, t: state.tick.at / 1000, text: `AUTO switched off: ${b.why} exit` });
  return json(route, { success: true });
}

/**
 * What the server engine writes when chart 1's armed rule enters: on the ARMED contract (the arming's `run.target`), in its mode and lots,
 * through the ops it uses (REAL: reserved `entering`, then confirmed - or marked unknown), plus its log line (the page chimes on it).
 * PAPER books `box`, REAL the live `price`; the marker sits on `box`. A NIFTY future, 65 per lot. `t`: when the server acted (epoch s; default
 * the last tick's time) - the page toasts and chimes only on lines newer than it loaded, so pass the page clock when that matters.
 */
export function serverEnter(state: AutoState, o: { side?: 'BUY' | 'SELL'; price?: number; box: number; barT: number; unknown?: boolean; t?: number }): string {
  const arm = state.ledger.arms?.['1'];
  if (!arm?.run) throw new Error('chart 1 is not armed with a run');
  const id = `pnfa-1-${state.tick.at}`, units = 65 * arm.lots, side = o.side ?? 'SELL', t = o.t ?? state.tick.at / 1000;
  const entryPrice = arm.mode === 'PAPER' ? o.box : o.price ?? state.tick.ltp;
  const row = {
    id, day: '2026-10-30', chart: 1 as const, target: arm.run.target, market: 'NSE_FNO' as const, mode: arm.mode, broker: arm.broker,
    side, lots: arm.lots, unitsPerPoint: units, legs: [{ label: 'NIFTY NOV FUT', key: arm.mode === 'REAL' ? '54321' : null, units }],
    entryT: t, entryBarT: o.barT, entryPrice, entryBox: o.box,
    // armed with adds: the row carries its cap, as the engine's entry writes it (lib/pnfAutoChart.ts enter)
    ...(arm.pyramid && arm.pyramid.max > arm.lots ? { pyramidMax: arm.pyramid.max } : {}),
  };
  if (arm.mode === 'PAPER') apply(state, { op: 'open', row });
  else {
    apply(state, { op: 'open', row: { ...row, state: 'entering' } });
    if (o.unknown) {
      apply(state, { op: 'markUnknown', id, note: 'Status unknown' });
      apply(state, { op: 'log', chart: 1, t, kind: 'halt', text: 'halted: entry outcome unknown - check Orders/Positions, then resolve it' });
      return id;
    }
    apply(state, { op: 'confirmEntry', id, legs: row.legs, orderIds: ['O1'] });
  }
  apply(state, { op: 'log', chart: 1, t, kind: 'entry', text: `[${arm.mode}] ${side} ${arm.lots}L @ ${entryPrice.toFixed(2)}` });
  return id;
}

/** The server's exit of chart 1's open row (a REAL one through its reserved exit), with its log line. */
export function serverClose(state: AutoState, o: { price: number; reason: string; box?: number; barT?: number; t?: number }) {
  const row = state.ledger.rows.find(x => x.chart === 1 && x.state === 'open');
  if (!row) throw new Error('no open row on chart 1');
  const t = o.t ?? state.tick.at / 1000;
  if (row.mode === 'REAL') apply(state, { op: 'beginExit', id: row.id, t });
  apply(state, { op: 'close', id: row.id, exitT: t, exitPrice: o.price, reason: o.reason, ...(o.box !== undefined ? { exitBox: o.box } : {}), ...(o.barT !== undefined ? { exitBarT: o.barT } : {}) });
  apply(state, { op: 'log', chart: 1, t, kind: 'exit', text: `[${row.mode}] exit (${o.reason}) @ ${o.price.toFixed(2)}` });
}
