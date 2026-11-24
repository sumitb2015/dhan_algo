'use client';

// Floating option chain for /index-scalper: live per-strike LTP / OI / OI change / buildup from the shared tick bridge.
// Clicking an LTP opens the order ticket for that contract. Display only; it places nothing itself.

import { useMemo } from 'react';
import { X } from 'lucide-react';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import { useDraggable } from './useDraggable';
import { cn } from '@/lib/utils';

export interface PickedContract { strike: number; type: 'CE' | 'PE'; securityId: string | null; ltp: number | null }

const BUILDUP: Record<string, { label: string; cls: string }> = {
  LB: { label: 'Long Buildup', cls: 'text-emerald-400 border-emerald-500/40' },
  SB: { label: 'Short Buildup', cls: 'text-rose-400 border-rose-500/40' },
  SC: { label: 'Short Covering', cls: 'text-sky-400 border-sky-500/40' },
  LU: { label: 'Long Unwinding', cls: 'text-amber-400 border-amber-500/40' },
};

function fmtOI(n: number | undefined): string {
  if (!n) return '—';
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `${(n / 100_000).toFixed(2)} L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} K`;
  return String(n);
}
const pct = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const pctCls = (n: number | undefined) => (n === undefined || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-rose-400');

function Buildup({ code }: { code?: string }) {
  const b = code ? BUILDUP[code] : undefined;
  if (!b) return <span className="text-zinc-600">—</span>;
  return <span className={cn('px-1 py-px rounded border text-[9px] font-bold whitespace-nowrap', b.cls)}>{b.label}</span>;
}

export default function OptionChainPanel({ feed, onPick, onClose, wings = 8 }: {
  feed: IndexScalperFeed;
  onPick: (c: PickedContract) => void;
  onClose: () => void;
  wings?: number;
}) {
  const { pos, handle } = useDraggable({ x: 120, y: 190 });
  const { quotes, strikeIds } = feed;

  const rows = useMemo(() => {
    if (!quotes) return [];
    const all = Object.values(quotes.strikes ?? {}).sort((a, b) => a.strike - b.strike);
    const atmIdx = all.findIndex(r => r.strike === quotes.atm);
    if (atmIdx < 0) return all.slice(0, wings * 2 + 1);
    return all.slice(Math.max(0, atmIdx - wings), atmIdx + wings + 1);
  }, [quotes, wings]);

  const pick = (strike: number, type: 'CE' | 'PE', ltp: number | undefined) => {
    const ids = strikeIds.get(strike);
    onPick({ strike, type, securityId: (type === 'CE' ? ids?.ceId : ids?.peId) ?? null, ltp: ltp && ltp > 0 ? ltp : null });
  };

  return (
    <div style={{ left: pos.x, top: pos.y }}
      className="fixed z-40 w-[860px] max-w-[calc(100vw-16px)] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl select-none" data-testid="option-chain-panel">
      <div {...handle} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-zinc-800 cursor-move">
        <span className="text-sm font-bold text-white">Option Chain</span>
        <div className="flex items-center gap-3 text-[11px] text-zinc-400">
          <label className="flex items-center gap-1">Expiry
            <select value={feed.expiry} onChange={e => feed.setExpiry(e.target.value)}
              className="bg-zinc-800 text-zinc-100 rounded px-1 py-0.5 text-[11px] border border-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
              {feed.expiries.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          {quotes && <span>Spot <b className="text-zinc-100 tabular-nums">{quotes.spot.toFixed(2)}</b></span>}
          {quotes?.vix && <span>VIX <b className="text-zinc-100 tabular-nums">{quotes.vix.ltp.toFixed(2)}</b></span>}
          <button type="button" aria-label="Close option chain" onClick={onClose}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"><X className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-zinc-800">
            <tr className="text-xs font-bold text-white">
              <th className="px-2 py-1.5 text-left">Buildup</th><th className="px-2 text-right">OI</th><th className="px-2 text-right">OI Chg%</th>
              <th className="px-2 text-right">LTP Chg</th><th className="px-2 text-right">LTP <span className="text-sky-300">CE</span></th>
              <th className="px-2 text-center">Strike</th>
              <th className="px-2 text-right"><span className="text-rose-300">PE</span> LTP</th><th className="px-2 text-right">LTP Chg</th>
              <th className="px-2 text-right">OI Chg%</th><th className="px-2 text-right">OI</th><th className="px-2 text-right">Buildup</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-zinc-500">{feed.expiry ? 'Waiting for live ticks…' : 'Loading expiries…'}</td></tr>
            )}
            {rows.map(r => {
              const atm = r.strike === quotes?.atm;
              return (
                <tr key={r.strike} className={cn('border-t border-zinc-800/70', atm && 'bg-sky-500/10')}>
                  <td className="px-2 py-1"><Buildup code={r.ce?.buildup} /></td>
                  <td className="px-2 text-right text-zinc-200">{fmtOI(r.ce?.oi)}</td>
                  <td className={cn('px-2 text-right', pctCls(r.ce?.oi_chg_pct))}>{pct(r.ce?.oi_chg_pct)}</td>
                  <td className={cn('px-2 text-right', pctCls(r.ce?.change_pct))}>{pct(r.ce?.change_pct)}</td>
                  <td className="px-1 text-right">
                    <button type="button" onClick={() => pick(r.strike, 'CE', r.ce?.ltp)} aria-label={`Trade ${r.strike} CE`}
                      className="px-1.5 py-0.5 rounded font-bold text-zinc-100 hover:bg-sky-600 hover:text-oncolor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                      {r.ce?.ltp ? r.ce.ltp.toFixed(2) : '—'}
                    </button>
                  </td>
                  <td className={cn('px-2 text-center font-bold', atm ? 'text-sky-300' : 'text-zinc-100')}>{r.strike}</td>
                  <td className="px-1 text-right">
                    <button type="button" onClick={() => pick(r.strike, 'PE', r.pe?.ltp)} aria-label={`Trade ${r.strike} PE`}
                      className="px-1.5 py-0.5 rounded font-bold text-zinc-100 hover:bg-rose-600 hover:text-oncolor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60">
                      {r.pe?.ltp ? r.pe.ltp.toFixed(2) : '—'}
                    </button>
                  </td>
                  <td className={cn('px-2 text-right', pctCls(r.pe?.change_pct))}>{pct(r.pe?.change_pct)}</td>
                  <td className={cn('px-2 text-right', pctCls(r.pe?.oi_chg_pct))}>{pct(r.pe?.oi_chg_pct)}</td>
                  <td className="px-2 text-right text-zinc-200">{fmtOI(r.pe?.oi)}</td>
                  <td className="px-2 text-right"><Buildup code={r.pe?.buildup} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
