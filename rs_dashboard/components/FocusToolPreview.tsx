'use client';

/**
 * Layout preview for the Focus Tool row views, on SAMPLE data.
 *
 * Renders the row components only — never the FocusTool page component, so
 * no scheduler runs, nothing is fetched, and every order callback is a no-op
 * that just logs what it would have done. Config edits update local state so
 * the controls can be exercised. Exists because opening the real /focus-tool
 * page in a second tab makes that tab a second live executor.
 */

import { useState } from 'react';
import { FocusProRow, FocusTableRow, type FocusRowViewProps } from './FocusTool';
import { EMPTY_ROW_LIVE, type RowLive } from '@/lib/focusToolRules';
import type { FocusRow } from '@/lib/focusToolRows';
import { cn } from '@/lib/utils';

const NOW = '2026-09-30T09:30:00.000Z';

function baseRow(id: string, patch: Partial<FocusRow>): FocusRow {
  return {
    id, underlying: 'NIFTY', entryTime: '09:20', exitTime: '15:15', dte: 'Any', expiry: '2026-10-06',
    strikeMode: 'ATM', linked: true, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '',
    lots: 2, side: 'BOTH', status: 'draft',
    levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1',
    slRupees: '', slMultiplier: '1.2', ceSlMultiplier: '1.2', peSlMultiplier: '1.2',
    reSlMode: 'off', reTgtMode: 'off', mode: 'real',
    createdAt: NOW, updatedAt: NOW,
    ...patch,
  };
}

const short = (sym: string, qty: number, avg: number, ltp: number) => ({
  tradingSymbol: sym, securityId: '1', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
  netQty: -qty, buyAvg: 0, sellAvg: avg, lastTradedPrice: ltp, realizedProfit: 0,
  unrealizedProfit: (avg - ltp) * qty,
});

const SAMPLES: { title: string; row: FocusRow; live: RowLive }[] = [
  {
    title: 'Open straddle (REAL) — leg target, RE-OTM on SL',
    row: baseRow('preview-open', {
      status: 'entered', ceOffset: 1, peOffset: 0, linked: false, ceTgtPct: '30',
      reSlMode: 'otm', slRollStrikes: 1, reSlMax: 3, slRupees: '4000', levelHigh: '22800', levelLow: '22400',
      fill: {
        ceStrike: 22650, peStrike: 22600, ceQty: 130, peQty: 130, ceEntry: 140, peEntry: 125,
        ceRolls: 1, ts: NOW,
      },
    }),
    live: {
      ...EMPTY_ROW_LIVE,
      ceStrike: 22650, peStrike: 22600, ltpCe: 133.2, ltpPe: 118.5,
      cePosition: short('NIFTY 06 OCT 22650 CALL', 130, 140, 133.2),
      pePosition: short('NIFTY 06 OCT 22600 PUT', 130, 125, 118.5),
      pnl: 1729, entryPremium: 530, lotSize: 65, vwap1m: 282.15, vwapClose1m: 280.9,
      ceBuildup: 'SB', peBuildup: 'LB', ceOiChgPct: 379.2, peOiChgPct: 28.6, ceOi: 812000, peOi: 1851000,
    },
  },
  {
    title: 'SIM row, CE stopped out — momentum re-entry waiting',
    row: baseRow('preview-pending', {
      mode: 'sim', status: 'entered', ceOffset: 2, peOffset: -2,
      reSlMode: 'momentum', reMomentumPts: '10', reSlMax: 2, noReEntryAfter: '14:30', slToCost: true,
      fill: {
        ceStrike: 22700, peStrike: 22500, ceQty: 0, peQty: 130, peEntry: 96, peCostStop: true,
        ceRolls: 0, ts: NOW,
        cePending: { trigger: 'sl', mode: 'momentum', strike: 22750, lots: 2, price: 88.4, dir: 'down', since: Date.parse(NOW) },
      },
    }),
    live: {
      ...EMPTY_ROW_LIVE,
      ceStrike: 22750, peStrike: 22500, ltpCe: 98.4, ltpPe: 81.1,
      pePosition: short('SIM-PE', 130, 96, 81.1),
      pnl: -1245, entryPremium: 192, lotSize: 65, vwap1m: 190.2, vwapClose1m: 189.9,
    },
  },
  {
    title: 'Draft, CE only, ₹ premium strikes',
    row: baseRow('preview-draft', { side: 'CE', strikeMode: 'PREMIUM', cePremium: '80', pePremium: '80', legTgtUnit: 'pts', ceTgtPct: '25' }),
    live: { ...EMPTY_ROW_LIVE, ceStrike: 22800, peStrike: 22450, ltpCe: 79.6, ltpPe: 77.9, lotSize: 65 },
  },
];

export default function FocusToolPreview() {
  const [rows, setRows] = useState(() => SAMPLES.map(s => s.row));
  const [view, setView] = useState<'pro' | 'table'>('pro');
  const [log, setLog] = useState<string[]>([]);
  const note = (msg: string) => setLog(l => [`${new Date().toLocaleTimeString('en-IN')}  ${msg}`, ...l].slice(0, 6));

  const propsFor = (i: number): FocusRowViewProps => {
    const row = rows[i];
    const id = row.id.replace('preview-', '');
    return {
      row, rowIndex: i, live: SAMPLES[i].live, lotSize: 65, spot: 22620.45,
      liveRealMoney: true, broker: 'dhan', busy: false, expiries: ['2026-10-06', '2026-10-13', '2026-10-27'],
      buildupWsActive: true, buildupExpiryHint: null,
      onUpdate: patch => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))),
      onDelete: () => note(`${id}: delete row`),
      onArm: () => note(`${id}: arm`), onDisarm: () => note(`${id}: disarm`),
      onExit: leg => note(`${id}: exit ${leg} (no order — preview)`),
      onExitPartial: (leg, pct) => note(`${id}: exit ${pct}% of ${leg} (no order — preview)`),
      onAddLot: (leg, lots) => note(`${id}: add ${lots} lot(s) ${leg} (no order — preview)`),
      onReduceLot: (leg, lots) => note(`${id}: reduce ${leg} by ${lots} lot(s) (no order — preview)`),
      onShift: (leg, dir) => note(`${id}: shift ${leg} ${dir} (no order — preview)`),
      onBlocked: msg => note(`blocked: ${msg}`),
      onCancelPending: leg => note(`${id}: cancel ${leg} re-entry`),
    };
  };

  return (
    <div className="min-h-screen bg-black text-zinc-200 p-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5">
        <span className="text-sm font-bold text-amber-300">Layout preview — sample data only. Nothing here places orders or reads your account.</span>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-0.5">
          {(['pro', 'table'] as const).map(v => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={cn('px-3 py-1 text-xs font-bold rounded-md cursor-pointer', view === v ? 'bg-zinc-800 text-white' : 'text-zinc-400')}>
              {v === 'pro' ? 'Pro' : 'Table'}
            </button>
          ))}
        </div>
      </div>

      {view === 'pro' ? (
        <div className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <div key={r.id} className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-zinc-500">{SAMPLES[i].title}</span>
              <FocusProRow {...propsFor(i)} />
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full border-collapse text-left min-w-[1500px]">
            <tbody>{rows.map((r, i) => <FocusTableRow key={r.id} {...propsFor(i)} />)}</tbody>
          </table>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 font-mono text-xs text-zinc-400 min-h-[5rem]">
        {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : 'Clicks on order buttons are logged here instead of being sent.'}
      </div>
    </div>
  );
}
