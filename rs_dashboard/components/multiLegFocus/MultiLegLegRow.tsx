'use client';

import React from 'react';
import { X } from 'lucide-react';
import { legPnl, type MultiLegLeg } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';

const SELECT_CLASS = `h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2 focus:outline-none focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;

const STATUS_STYLE: Record<MultiLegLeg['status'], string> = {
  DRAFT:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  PLACING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  OPEN:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  CLOSING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CLOSED:  'bg-zinc-800 text-zinc-500 border-zinc-700',
  FAILED:  'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

interface MultiLegLegRowProps {
  leg: MultiLegLeg;
  allStrikes: number[];
  ltp: number;
  editable: boolean;
  exiting: boolean;
  onChange: (patch: Partial<MultiLegLeg>) => void;
  onRemove: () => void;
  onExit: () => void;
}

export default function MultiLegLegRow({
  leg, allStrikes, ltp, editable, exiting, onChange, onRemove, onExit,
}: MultiLegLegRowProps) {
  const pnl = leg.fill ? legPnl(leg, ltp) : 0;
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-400';

  return (
    <tr className="border-b border-zinc-800/60 hover:bg-zinc-900/30 transition-colors">
      <td className="px-3 py-2">
        <select value={leg.side} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ side: e.target.value as MultiLegLeg['side'] })}>
          <option value="B">BUY</option>
          <option value="S">SELL</option>
        </select>
      </td>
      <td className="px-2 py-2">
        <select value={leg.option} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ option: e.target.value as MultiLegLeg['option'] })}>
          <option value="CE">CE</option>
          <option value="PE">PE</option>
        </select>
      </td>
      <td className="px-2 py-2">
        <select value={leg.strike} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ strike: Number(e.target.value) })}>
          {!allStrikes.includes(leg.strike) && <option value={leg.strike}>{leg.strike}</option>}
          {allStrikes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td className="px-2 py-2">
        <input type="number" min={1} value={leg.lots} disabled={!editable}
          onChange={e => onChange({ lots: Math.max(1, Number(e.target.value) || 1) })}
          className={`h-8 w-16 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded-lg px-2 text-center focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`} />
      </td>
      <td className="px-2 py-2">
        <select value={leg.type} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ type: e.target.value as MultiLegLeg['type'] })}>
          <option value="MARKET">MARKET</option>
          <option value="LIMIT">LIMIT</option>
        </select>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300 tabular-nums">
        {ltp > 0 ? ltp.toFixed(2) : '—'}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs font-bold tabular-nums">
        {leg.fill ? <span className={pnlColor}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}</span> : <span className="text-zinc-600">—</span>}
      </td>
      <td className="px-2 py-2 text-center">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLE[leg.status]}`}>
          {leg.status}
        </span>
      </td>
      <td className="px-2 py-2 text-center">
        {leg.status === 'OPEN' ? (
          <button onClick={onExit} disabled={exiting} aria-label="Exit this leg" title="Exit this leg"
            className={`text-[10px] font-bold text-rose-400 hover:text-rose-300 px-1.5 py-0.5 rounded border border-rose-500/30 hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}>
            {exiting ? 'Exiting…' : 'EXIT'}
          </button>
        ) : editable ? (
          <button onClick={onRemove} aria-label="Remove leg" title="Remove leg"
            className={`w-6 h-6 inline-flex items-center justify-center text-zinc-500 hover:text-rose-300 ${FOCUS_RING}`}>
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </td>
    </tr>
  );
}
