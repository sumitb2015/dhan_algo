// The paper trade book of the P&F / Renko page: every simulated fill of the day in one list - the trade bar, the chart rail, the
// MTM guard and the +/- chip (all kept as execution markers) and both legs of every AUTO paper row (from the AUTO ledger).
// Paper trades never reach a broker, so the broker's Trade Book cannot show them. Pure (tested in lib/pnfPaperBook.test.ts).
import { expiryLabel, targetLabel, type Target } from './pnfTarget.ts';
import { istDateIso } from './nseHolidays.ts';
import type { PnfExecutionMarker } from './straddlePnf.ts';
import type { AutoRow } from './pnfAutoLedger.ts';

export interface PaperTradeRow {
  id: string;
  /** Epoch seconds of the fill. */
  t: number;
  instrument: string;
  source: 'Trade bar' | 'AUTO';
  side: 'BUY' | 'SELL';
  lots: number;
  price: number;
  /** AUTO: why it exited and the row's P&L; empty otherwise. */
  note: string;
}

/** "futures|CRUDEOILM|2026-11-19||" -> "CRUDEOILM FUT 19 Nov 26" (the chart label of a stored marker key). */
export function labelOfTargetKey(key: string): string {
  const [kind, symbol = '', expiry = '', strike = '', side = ''] = key.split('|');
  if (kind !== 'futures' && kind !== 'options' && kind !== 'equity' && kind !== 'index') return key;
  const t: Target = { kind, symbol, name: symbol, ...(expiry ? { expiry } : {}), ...(strike ? { strike: Number(strike) } : {}), ...(side ? { side: side as Target['side'] } : {}) } as Target;
  return targetLabel(t) || (expiry ? `${symbol} ${expiryLabel(expiry)}` : symbol);
}

/**
 * Today's paper trades, newest first. `markers` is every stored marker list by target key (PAPER ones only are kept; markers
 * drawn from the ledger are not stored, so nothing is counted twice); `autoRows` the AUTO ledger rows. A row opened and closed
 * gives two trades (the entry at its decision time, the exit at the exit time); an open one gives one; a row that never opened
 * (refused / unresolved-flat entry) gives none.
 */
export function buildPaperTrades(markers: Record<string, PnfExecutionMarker[]>, autoRows: AutoRow[], day: string): PaperTradeRow[] {
  const out: PaperTradeRow[] = [];
  for (const [key, list] of Object.entries(markers)) {
    for (const m of list) {
      if (m.mode !== 'PAPER' || m.axis || !(m.price > 0) || istDateIso(m.t * 1000) !== day) continue;   // an index chart's arrow is no trade
      out.push({ id: `m:${key}:${m.id}`, t: m.t, instrument: labelOfTargetKey(key), source: 'Trade bar', side: m.action, lots: m.lots, price: m.price, note: '' });
    }
  }
  for (const r of autoRows) {
    if (r.mode !== 'PAPER' || r.state === 'entering' || r.state === 'unknownEntry') continue;
    if (r.state === 'closed' && r.reason === 'refused') continue;            // never opened
    const label = targetLabel(r.target);
    if (istDateIso(r.entryT * 1000) === day) {
      out.push({ id: `a:${r.id}:in`, t: r.entryT, instrument: label, source: 'AUTO', side: r.side, lots: r.base ? r.base.lots : r.lots, price: r.base ? r.base.price : r.entryPrice, note: `C${r.chart} entry` });
    }
    for (const a of r.adds ?? []) {
      if (a.status === 'done' && istDateIso(a.t * 1000) === day) out.push({ id: `a:${r.id}:add:${a.id}`, t: a.t, instrument: label, source: 'AUTO', side: r.side, lots: a.lots, price: a.price, note: `C${r.chart} add` });
    }
    if (r.state === 'closed' && r.reason !== 'resolved' && r.exitPrice !== undefined && r.exitT !== undefined && istDateIso(r.exitT * 1000) === day) {
      const pnl = r.pnl === undefined ? '' : ` · ${r.pnl < 0 ? '-' : r.pnl > 0 ? '+' : ''}₹${Math.abs(Math.round(r.pnl)).toLocaleString('en-IN')}`;
      out.push({ id: `a:${r.id}:out`, t: r.exitT, instrument: label, source: 'AUTO', side: r.side === 'BUY' ? 'SELL' : 'BUY', lots: r.lots, price: r.exitPrice, note: `C${r.chart} exit (${r.reason ?? 'closed'})${pnl}` });
    }
  }
  return out.sort((a, b) => b.t - a.t || a.id.localeCompare(b.id));
}
