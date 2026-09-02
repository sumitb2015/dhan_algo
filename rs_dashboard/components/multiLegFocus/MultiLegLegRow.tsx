'use client';

import React from 'react';
import { X } from 'lucide-react';
import { legPnl, computeLegTrailingSL, type MultiLegLeg } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';
import RuleNumInput from './RuleNumInput';

const SELECT_CLASS = `h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2 focus:outline-none focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;

const STATUS_STYLE: Record<MultiLegLeg['status'], string> = {
  DRAFT:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  PLACING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  OPEN:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  CLOSING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CLOSED:  'bg-zinc-800 text-zinc-500 border-zinc-700',
  FAILED:  'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

interface MultiLegLegRowProps {
  leg: MultiLegLeg;
  allStrikes: number[];
  ltp: number;
  editable: boolean;
  exiting: boolean;
  margin?: number;
  onChange: (patch: Partial<MultiLegLeg>) => void;
  onRemove: () => void;
  onExit: () => void;
}

export default function MultiLegLegRow({
  leg, allStrikes, ltp, editable, exiting, margin, onChange, onRemove, onExit,
}: MultiLegLegRowProps) {
  const pnl = leg.fill ? legPnl(leg, ltp) : 0;
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-400';
  const trailingEval = computeLegTrailingSL(leg, ltp);

  const legPrice = (leg.fill?.avgPrice && leg.fill.avgPrice > 0) ? leg.fill.avgPrice : (ltp > 0 ? ltp : (leg.price || 0));
  const legBE = leg.option === 'CE' ? leg.strike + legPrice : leg.strike - legPrice;

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
        {legPrice > 0 && (
          <span className="block text-[10px] font-mono text-zinc-400 mt-0.5 tabular-nums" title={`Individual Leg Breakeven: ${legBE.toFixed(2)}`}>
            BE: {legBE.toFixed(1)}
          </span>
        )}
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
      <td className="px-2 py-2 text-right font-mono text-xs text-zinc-300 tabular-nums">
        {ltp > 0 ? ltp.toFixed(2) : '—'}
      </td>
      {/* SL Column */}
      <td className="px-2 py-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <RuleNumInput
              value={leg.sl}
              onCommit={val => onChange({ sl: val })}
              placeholder={leg.slType === 'price' ? 'Price' : 'Pts'}
              className="w-16 h-7 text-rose-300 placeholder-rose-900/40"
              title="Stop Loss (in points or price)"
            />
            <button
              type="button"
              onClick={() => onChange({ slType: leg.slType === 'price' ? 'pts' : 'price' })}
              className="h-7 px-1.5 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white"
              title="Toggle between Points and Price"
            >
              {leg.slType === 'price' ? '₹' : 'pts'}
            </button>
          </div>
          {trailingEval.effectiveSL != null && (
            <span className={`text-[10px] font-mono ${leg.trail ? 'text-amber-400 font-semibold' : 'text-zinc-500'}`}>
              {leg.trail ? 'TSL' : 'SL'}: {trailingEval.effectiveSL.toFixed(1)}
            </span>
          )}
        </div>
      </td>
      {/* TP Column */}
      <td className="px-2 py-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <RuleNumInput
              value={leg.tp}
              onCommit={val => onChange({ tp: val })}
              placeholder={leg.tpType === 'price' ? 'Price' : 'Pts'}
              className="w-16 h-7 text-emerald-300 placeholder-emerald-900/40"
              title="Take Profit (in points or price)"
            />
            <button
              type="button"
              onClick={() => onChange({ tpType: leg.tpType === 'price' ? 'pts' : 'price' })}
              className="h-7 px-1.5 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white"
              title="Toggle between Points and Price"
            >
              {leg.tpType === 'price' ? '₹' : 'pts'}
            </button>
          </div>
          {trailingEval.tpPrice != null && (
            <span className="text-[10px] font-mono text-emerald-500">
              TP: {trailingEval.tpPrice.toFixed(1)}
            </span>
          )}
        </div>
      </td>
      {/* Trail Column (1 rupee step) */}
      <td className="px-2 py-2 text-center">
        <label className="inline-flex items-center gap-1 cursor-pointer select-none text-[11px] font-semibold" title="Trailing SL: tightens SL by ₹1 for every ₹1 favorable move">
          <input
            type="checkbox"
            checked={!!leg.trail}
            onChange={e => onChange({ trail: e.target.checked })}
            className="rounded border-zinc-700 text-amber-500 focus:ring-0"
          />
          <span className={leg.trail ? 'text-amber-400 font-bold' : 'text-zinc-500'}>
            1₹
          </span>
        </label>
      </td>
      {/* Margin Column: Blocked for OPEN, Required for DRAFT */}
      <td className="px-2 py-2 text-right">
        {leg.status === 'CLOSED' ? (
          <span className="text-zinc-600 font-mono text-xs">—</span>
        ) : margin != null && margin > 0 ? (
          <div className="flex flex-col items-end">
            <span className="font-mono text-xs font-bold text-zinc-200 tabular-nums">
              {fmtMoney(margin)}
            </span>
            <span className={`text-[9px] font-semibold ${
              leg.status === 'OPEN' ? 'text-emerald-400' : 'text-sky-400'
            }`}>
              {leg.status === 'OPEN' ? 'Blocked' : 'Required'}
            </span>
          </div>
        ) : (
          <span className="text-zinc-600 font-mono text-xs">—</span>
        )}
      </td>
      <td className="px-2 py-2 text-right font-mono text-xs font-bold tabular-nums">
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
