'use client';

// Floating option chain for /index-scalper: live per-strike LTP / OI / OI change / buildup from the shared tick bridge.
// Clicking an LTP opens the order ticket for that contract. Display only; it places nothing itself.

import { useMemo } from 'react';
import { X } from 'lucide-react';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import { useDraggable } from './useDraggable';
import { cn } from '@/lib/utils';
import { fmtOI } from '@/lib/indexScalperOiProfile';

export interface PickedContract {
  strike: number; type: 'CE' | 'PE' | 'FUT'; securityId: string | null; ltp: number | null;
  /** Expiry the security id belongs to; the terminal refuses an order once the chain shows another. */
  expiry: string;
  tradingSymbol?: string | null;
}

const BUILDUP: Record<string, { label: string; cls: string }> = {
  LB: { label: 'Long Buildup', cls: 'text-emerald-400 border-emerald-500/40' },
  SB: { label: 'Short Buildup', cls: 'text-rose-400 border-rose-500/40' },
  SC: { label: 'Short Covering', cls: 'text-sky-400 border-sky-500/40' },
  LU: { label: 'Long Unwinding', cls: 'text-amber-400 border-amber-500/40' },
};

const pct = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const pctCls = (n: number | undefined) => (n === undefined || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-rose-400');

function Buildup({ code }: { code?: string }) {
  const b = code ? BUILDUP[code] : undefined;
  if (!b) return <span className="text-zinc-600">—</span>;
  return <span className={cn('px-1 py-px rounded border text-[9px] font-bold whitespace-nowrap', b.cls)}>{b.label}</span>;
}

export default function OptionChainPanel({ feed, onPick, onTrade, oneClick, onClose, wings = 8 }: {
  feed: IndexScalperFeed;
  onPick: (c: PickedContract) => void;
  /** Row B / S (Dhan-style, on hover). The terminal decides: a market order at once in one-click mode, else the ticket. */
  onTrade: (c: PickedContract, side: 'BUY' | 'SELL') => void;
  /** One-click (Scalper) mode is on: B / S send a market order immediately. */
  oneClick: boolean;
  onClose: () => void;
  wings?: number;
}) {
  const { pos, handle } = useDraggable({ x: 120, y: 190 });
  // The live chain, or Dhan's REST snapshot when the bridge has none (holiday / bridge down): same rows, flagged below.
  const { chain: quotes, strikeIds } = feed;
  const snapshot = feed.chainSource === 'snapshot';

  const atmStrike = useMemo(() => {
    if (!quotes) return null;
    const all = Object.values(quotes.strikes ?? {});
    if (all.length === 0) return quotes.atm ?? null;
    const exact = all.find(r => r.strike === quotes.atm);
    if (exact) return quotes.atm;
    const target = (quotes.atm && quotes.atm > 0 ? quotes.atm : quotes.spot) || 0;
    if (target > 0) {
      return all.reduce((best, r) => (Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best), all[0]).strike;
    }
    return quotes.atm ?? null;
  }, [quotes]);

  const rows = useMemo(() => {
    if (!quotes) return [];
    const all = Object.values(quotes.strikes ?? {}).sort((a, b) => a.strike - b.strike);
    if (all.length === 0) return [];
    let atmIdx = all.findIndex(r => r.strike === (atmStrike ?? quotes.atm));
    if (atmIdx < 0) {
      const target = (quotes.atm && quotes.atm > 0 ? quotes.atm : quotes.spot) || 0;
      if (target > 0) {
        atmIdx = all.reduce((bestIdx, r, idx) => (Math.abs(r.strike - target) < Math.abs(all[bestIdx].strike - target) ? idx : bestIdx), 0);
      } else {
        atmIdx = Math.floor(all.length / 2);
      }
    }
    return all.slice(Math.max(0, atmIdx - wings), atmIdx + wings + 1);
  }, [quotes, wings, atmStrike]);

  const contract = (strike: number, type: 'CE' | 'PE', ltp: number | undefined): PickedContract => {
    const ids = strikeIds.get(strike);
    const sideData = type === 'CE' ? quotes?.strikes?.[String(strike)]?.ce : quotes?.strikes?.[String(strike)]?.pe;
    const finalLtp = (ltp && ltp > 0) ? ltp : (sideData?.prev_close && sideData.prev_close > 0) ? sideData.prev_close : null;
    const kotakSym = type === 'CE' ? feed.kotak?.strikes?.get(strike)?.ceSymbol : feed.kotak?.strikes?.get(strike)?.peSymbol;
    return {
      strike,
      type,
      securityId: (type === 'CE' ? ids?.ceId : ids?.peId) ?? kotakSym ?? null,
      ltp: finalLtp,
      expiry: feed.expiry,
      tradingSymbol: kotakSym,
    };
  };
  const pick = (strike: number, type: 'CE' | 'PE', ltp: number | undefined) => onPick(contract(strike, type, ltp));

  const futContract = useMemo<PickedContract | null>(() => {
    if (!feed.future) return null;
    return {
      strike: 0,
      type: 'FUT',
      securityId: feed.future.dhanId ?? feed.future.kotakSymbol ?? null,
      ltp: feed.future.ltp,
      expiry: feed.future.expiry ?? feed.expiry,
      tradingSymbol: feed.future.kotakSymbol ?? undefined,
    };
  }, [feed.future, feed.expiry]);

  // B / S on a row, shown on hover (and to the keyboard on focus). A snapshot chain is not live: nothing trades on it.
  const tradeButtons = (strike: number, type: 'CE' | 'PE', ltp: number | undefined) => {
    const what = `${strike} ${type}`;
    const how = snapshot ? 'No live prices: the chain is a snapshot' : oneClick ? 'market order NOW (one-click Scalper mode is on)' : 'opens the order ticket';
    const cls = 'w-5 h-5 rounded text-[10px] font-bold text-oncolor disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300';
    return (
      <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button type="button" disabled={snapshot} onClick={() => onTrade(contract(strike, type, ltp), 'BUY')} aria-label={`Buy ${what}`} title={`Buy ${what}: ${how}`}
          className={cn(cls, 'bg-sky-600 hover:bg-sky-500')}>B</button>
        <button type="button" disabled={snapshot} onClick={() => onTrade(contract(strike, type, ltp), 'SELL')} aria-label={`Sell ${what}`} title={`Sell ${what}: ${how}`}
          className={cn(cls, 'bg-rose-600 hover:bg-rose-500')}>S</button>
      </span>
    );
  };

  return (
    <div style={{ left: pos.x, top: pos.y }}
      className="fixed z-40 w-[860px] max-w-[calc(100vw-16px)] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl select-none" data-testid="option-chain-panel">
      <div {...handle} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-zinc-800 cursor-move">
        <span className="flex items-center gap-2 text-sm font-bold text-white">Option Chain
          {feed.chainSource === 'live' && <span className="px-1.5 py-px rounded border border-emerald-500/40 text-[10px] font-bold text-emerald-400">LIVE</span>}
          {snapshot && quotes?.updated_at && (
            <span data-testid="chain-snapshot" title="No live ticks (market closed or the tick bridge is down): Dhan's last option chain, refreshed every minute. Display only: orders never use these prices."
              className="px-1.5 py-px rounded border border-amber-500/40 text-[10px] font-bold text-amber-300">
              SNAPSHOT · not live · {new Date(quotes.updated_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </span>
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
              <th className="px-2 text-left"><span className="text-rose-300">PE</span> LTP</th><th className="px-2 text-right">LTP Chg</th>
              <th className="px-2 text-right">OI Chg%</th><th className="px-2 text-right">OI</th><th className="px-2 text-right">Buildup</th>
            </tr>
          </thead>
          <tbody>
            {futContract && (
              <tr className="group border-b border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 font-semibold text-xs">
                <td className="px-2 py-1 text-amber-300 font-bold" colSpan={4}>
                  FUT · {feed.underlying} {futContract.expiry ? futContract.expiry.slice(5) : ''}
                </td>
                <td className="px-1 text-center" colSpan={3}>
                  <div className="flex items-center justify-center gap-2">
                    <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        disabled={snapshot}
                        onClick={() => onTrade(futContract, 'BUY')}
                        aria-label="Buy Future"
                        title="Buy Future"
                        className="w-5 h-5 rounded text-[10px] font-bold text-oncolor bg-sky-600 hover:bg-sky-500 disabled:opacity-40"
                      >
                        B
                      </button>
                      <button
                        type="button"
                        disabled={snapshot}
                        onClick={() => onTrade(futContract, 'SELL')}
                        aria-label="Sell Future"
                        title="Sell Future"
                        className="w-5 h-5 rounded text-[10px] font-bold text-oncolor bg-rose-600 hover:bg-rose-500 disabled:opacity-40"
                      >
                        S
                      </button>
                    </span>
                    <button
                      type="button"
                      onClick={() => onPick(futContract)}
                      aria-label="Trade Future"
                      className="px-2 py-0.5 rounded font-bold text-amber-300 hover:bg-amber-600 hover:text-oncolor tabular-nums"
                    >
                      {futContract.ltp ? futContract.ltp.toFixed(2) : '—'}
                    </button>
                  </div>
                </td>
                <td className="px-2 text-zinc-400 text-right" colSpan={4}>
                  Future Contract
                </td>
              </tr>
            )}
            {rows.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-zinc-500">{!feed.expiry ? 'Loading expiries…' : feed.snapshotError ? `No live ticks, and the chain snapshot failed: ${feed.snapshotError}` : 'Waiting for live ticks…'}</td></tr>
            )}
            {rows.map(r => {
              const atm = r.strike === (atmStrike ?? quotes?.atm);
              const cePrice = (r.ce?.ltp && r.ce.ltp > 0) ? r.ce.ltp : (r.ce?.prev_close && r.ce.prev_close > 0) ? r.ce.prev_close : null;
              const pePrice = (r.pe?.ltp && r.pe.ltp > 0) ? r.pe.ltp : (r.pe?.prev_close && r.pe.prev_close > 0) ? r.pe.prev_close : null;
              const ceChg = r.ce?.ltp && r.ce.ltp > 0 ? r.ce.change_pct : (r.ce?.change_pct === -100 && (!r.ce.volume || r.ce.volume === 0)) ? 0 : r.ce?.change_pct;
              const peChg = r.pe?.ltp && r.pe.ltp > 0 ? r.pe.change_pct : (r.pe?.change_pct === -100 && (!r.pe.volume || r.pe.volume === 0)) ? 0 : r.pe?.change_pct;
              return (
                <tr key={r.strike} className={cn('group border-t border-zinc-800/70 hover:bg-zinc-800/60', atm && 'bg-sky-500/10')}>
                  <td className="px-2 py-1"><Buildup code={r.ce?.buildup} /></td>
                  <td className="px-2 text-right text-zinc-200">{fmtOI(r.ce?.oi)}</td>
                  <td className={cn('px-2 text-right', pctCls(r.ce?.oi_chg_pct))}>{pct(r.ce?.oi_chg_pct)}</td>
                  <td className={cn('px-2 text-right', pctCls(ceChg))}>{pct(ceChg)}</td>
                  <td className="px-1 text-right">
                    <span className="flex items-center justify-end gap-1">
                      {tradeButtons(r.strike, 'CE', cePrice ?? undefined)}
                      <button type="button" onClick={() => pick(r.strike, 'CE', cePrice ?? undefined)} aria-label={`Trade ${r.strike} CE`}
                        className="px-1.5 py-0.5 rounded font-bold text-zinc-100 hover:bg-sky-600 hover:text-oncolor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                        {cePrice ? cePrice.toFixed(2) : '—'}
                      </button>
                    </span>
                  </td>
                  <td className={cn('px-2 text-center font-bold', atm ? 'text-sky-300' : 'text-zinc-100')}>{r.strike}</td>
                  <td className="px-1 text-left">
                    <span className="flex items-center justify-start gap-1">
                      <button type="button" onClick={() => pick(r.strike, 'PE', pePrice ?? undefined)} aria-label={`Trade ${r.strike} PE`}
                        className="px-1.5 py-0.5 rounded font-bold text-zinc-100 hover:bg-rose-600 hover:text-oncolor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60">
                        {pePrice ? pePrice.toFixed(2) : '—'}
                      </button>
                      {tradeButtons(r.strike, 'PE', pePrice ?? undefined)}
                    </span>
                  </td>
                  <td className={cn('px-2 text-right', pctCls(peChg))}>{pct(peChg)}</td>
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
