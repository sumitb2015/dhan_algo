'use client';

import type { ReactNode } from 'react';
import { Loader2, ArrowUpRight, ArrowDownRight, XCircle } from 'lucide-react';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import type { PnfAction } from '@/lib/pnfOrderLogic';
import type { Target } from '@/lib/pnfTarget';
import type { PnfTrade } from './usePnfTrade';

// The P&F page's 1-click trade bar: the view of the page's order engine (usePnfTrade), which the Scalper window shares.

export interface PnfTradeBarProps {
  /** The page's order engine: lots, position, P&L and the order calls. */
  trade: PnfTrade;
  target: Target;
  /** Drawn in the bar between the lots and the BUY / SELL buttons: the page's order Style (Single / Bracket / Cover) and MTM guard. */
  styleSlot?: ReactNode;
  /** Named in the bar so the order target is never in doubt. */
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  onModeChange: (mode: 'PAPER' | 'REAL') => void;
  onSwitchTarget?: (target: Target) => void;
  /** Which chart the bar trades ("C2 · NIFTY 23000 CE+PE 03 Nov 26"): two charts can show two instruments, the bar follows the active one. */
  tradesLabel?: string;
  /** A Renko index chart that trades options: its map controls (IndexMapControls), drawn before the buttons. */
  indexSlot?: ReactNode;
  /** The map's legs as short button hints ("BUY CE", "SELL PE +2"), for a mapped index chart. */
  sideHints?: { BUY: string; SELL: string };
  /** The same legs in full ("BUY CE ATM"), for the buttons' titles. */
  sideTitles?: { BUY: string; SELL: string };
}

const inr = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const pnlTone = (n: number | null) => (n == null || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-red-400');

export default function PnfTradeBar({ trade, target, broker, mode, onModeChange, onSwitchTarget, tradesLabel, styleSlot = null, indexSlot = null, sideHints, sideTitles }: PnfTradeBarProps) {
  const {
    isIndex, mapped, held, closeTitle, heldWarning, isEquity, isStraddle, lots, lotsDraft, setLotsDraft, commitLots, pickLots, product, setProduct,
    busy, ready, unsupported, position, shownPnl, realError, executeOrder, executeSquareOff,
  } = trade;

  const pill = (active: boolean) =>
    `px-2 h-6 text-[11px] font-bold rounded transition-colors ${active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`;
  const disabled = busy || !ready;
  // an unsettled order on a mapped chart is said by its chip and settle prompt; the bar does not repeat it
  const heldPending = mapped && !!held && held.state !== 'open';
  const squareTitle = closeTitle ? closeTitle
    : mode === 'REAL'
    ? `Closes the whole ${BROKER_LABELS[broker]} position on this contract (every product), including any opened from another page`
    : 'Closes the paper position';

  const squareOff = position && (
    <button type="button" disabled={busy} onClick={() => void executeSquareOff()} title={squareTitle}
            className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-amber-600 hover:bg-amber-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
      <XCircle className="w-3.5 h-3.5" />
      <span>SQUARE OFF</span>
    </button>
  );
  const actionButton = (action: PnfAction, label: string, title?: string) => (
    <button type="button" disabled={disabled} onClick={() => void executeOrder(action)} title={title} data-testid={`pnf-trade-${action.toLowerCase()}`}
            className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold ${action === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} text-oncolor disabled:opacity-50 disabled:cursor-not-allowed shadow transition-colors`}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : action === 'BUY' ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      <span>{label}</span>
    </button>
  );

  return (
    <div data-testid="pnf-trade-bar" className="flex items-center gap-x-4 gap-y-2 flex-wrap px-6 py-1 bg-zinc-900/70 border-b border-zinc-800 text-xs">
      {/* 1. Broker & Trading Mode */}
      <div className="flex items-center gap-2">
        {/* the broker is picked in the page header; the bar names it so the order target is never in doubt */}
        <span data-testid="pnf-trade-broker" className="text-[11px] font-bold text-zinc-300">{BROKER_LABELS[broker]}</span>
        {tradesLabel && (
          <span data-testid="pnf-trade-target" title={`Orders from this bar go to ${tradesLabel}`}
                className="max-w-[18rem] truncate rounded border border-amber-500/40 bg-amber-500/10 px-1.5 h-6 inline-flex items-center text-[11px] font-bold text-amber-300">
            {tradesLabel}
          </span>
        )}
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Execution mode">
          <button type="button" className={pill(mode === 'PAPER')} onClick={() => onModeChange('PAPER')} title="Simulate orders without placing real trades">
            PAPER
          </button>
          <button type="button"
                  className={`px-2 h-6 text-[11px] font-bold rounded transition-colors ${mode === 'REAL' ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'text-zinc-400 hover:text-zinc-200'}`}
                  onClick={() => onModeChange('REAL')} title="Place live orders with real capital (not remembered: every page load starts in PAPER)">
            REAL
          </button>
        </div>
      </div>

      <span className="w-px h-5 bg-zinc-800 shrink-0" />

      {/* 2. Product & Lot Sizing */}
      {!isIndex && (
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Product">
            <button type="button" className={pill(product === 'INTRADAY')} onClick={() => setProduct('INTRADAY')}>MIS</button>
            {isEquity
              ? <button type="button" className={pill(product === 'CNC')} onClick={() => setProduct('CNC')}>CNC</button>
              : <button type="button" className={pill(product === 'MARGIN')} onClick={() => setProduct('MARGIN')}>NRML</button>}
          </div>

          {/* Sizing Input with commit-on-blur */}
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400 text-[11px] font-medium">{isEquity ? 'Qty' : 'Lots'}:</span>
            <div className="inline-flex items-center rounded border border-zinc-700 bg-zinc-950">
              <button type="button" aria-label={`Decrease ${isEquity ? 'quantity' : 'lots'}`}
                      className="w-6 h-6 flex items-center justify-center text-zinc-300 hover:bg-zinc-800 rounded-l" onClick={() => pickLots(lots - 1)}>
                −
              </button>
              <input
                type="text"
                aria-label={isEquity ? 'Order quantity' : 'Order lots'}
                value={lotsDraft}
                onChange={e => setLotsDraft(e.target.value)}
                onBlur={e => commitLots(e.currentTarget.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    commitLots((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') { setLotsDraft(String(lots)); (e.target as HTMLInputElement).blur(); }
                }}
                className="w-10 h-6 text-center text-xs font-mono font-bold bg-transparent text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded"
              />
              <button type="button" aria-label={`Increase ${isEquity ? 'quantity' : 'lots'}`}
                      className="w-6 h-6 flex items-center justify-center text-zinc-300 hover:bg-zinc-800 rounded-r" onClick={() => pickLots(lots + 1)}>
                +
              </button>
            </div>

            {/* Quick lot presets */}
            <div className="flex items-center gap-1">
              {(isEquity ? [10, 50, 100] : [1, 2, 5, 10]).map(n => (
                <button key={n} type="button" onClick={() => pickLots(n)}
                        className={`px-1.5 h-6 rounded text-[10px] font-mono border ${lots === n ? 'border-zinc-500 bg-zinc-800 text-white' : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}>
                  {isEquity ? n : `${n}L`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {styleSlot}

      {/* 2b. A Renko index chart's option map: its own group, so it wraps as one block and never pushes the buttons apart */}
      {indexSlot && <><span className="w-px h-5 bg-zinc-800 shrink-0" />{indexSlot}</>}

      {/* 3. Action Buttons */}
      <div className="flex items-center gap-2 ml-auto">
        {isIndex ? (
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 text-[11px] italic">Index spot is non-tradable directly.</span>
            {onSwitchTarget && (
              <>
                <button type="button" onClick={() => onSwitchTarget({ kind: 'options', symbol: target.symbol, name: target.name || target.symbol, side: 'STRADDLE' })}
                        className="px-2.5 h-7 rounded text-[11px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors">
                  Trade ATM Straddle
                </button>
                <button type="button" onClick={() => onSwitchTarget({ kind: 'futures', symbol: target.symbol, name: target.name || target.symbol })}
                        className="px-2.5 h-7 rounded text-[11px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors">
                  Trade Near Future
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            {heldWarning && <span className="text-[11px] text-amber-400 max-w-[16rem] truncate" title={`${heldWarning} - trading goes on with the last read held option`}>Ledger read failed</span>}
            {unsupported && !heldPending && <span data-testid="pnf-trade-unsupported" className="text-[11px] text-amber-400 max-w-[22rem] truncate" title={unsupported}>{unsupported}</span>}
            {mapped && sideHints
              ? <>
                  {actionButton('BUY', `BULL ▸ ${sideHints.BUY}`, `Bullish on ${target.symbol}: ${sideTitles?.BUY ?? sideHints.BUY} at market (strike picked at the click). Holding the bearish leg: reduces / closes it.`)}
                  {actionButton('SELL', `BEAR ▸ ${sideHints.SELL}`, `Bearish on ${target.symbol}: ${sideTitles?.SELL ?? sideHints.SELL} at market (strike picked at the click). Holding the bullish leg: reduces / closes it.`)}
                </>
              : isStraddle
              ? <>{actionButton('SELL', 'SHORT STRADDLE')}{actionButton('BUY', 'LONG STRADDLE')}</>
              : <>{actionButton('BUY', 'BUY MARKET')}{actionButton('SELL', 'SELL MARKET')}</>}
            {squareOff}
          </>
        )}

        {/* 4. Active Position & P&L readout */}
        {!isIndex && (
          <div className="shrink-0 whitespace-nowrap flex items-center gap-2 pl-3 border-l border-zinc-800 font-mono text-[11px]">
            {heldPending ? (
              <span data-testid="pnf-trade-position" className="px-1.5 py-0.5 rounded font-bold bg-amber-500/20 text-amber-400"
                    title="The last order's outcome is not known yet: check Orders / Positions and settle it">
                {held!.state === 'unknown' ? 'UNKNOWN' : 'SENDING'}
              </span>
            ) : realError ? (
              <span className="text-amber-400" title={realError}>POSITION ?</span>
            ) : position ? (
              <div className="flex items-center gap-2">
                <span data-testid="pnf-trade-position"
                      className={`px-1.5 py-0.5 rounded font-bold ${position.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : position.side === 'SHORT' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                  {position.text}
                </span>
                {shownPnl != null && <span className={`font-bold ${pnlTone(shownPnl)}`}>{inr(shownPnl)}</span>}
              </div>
            ) : (
              <span className="text-zinc-500">FLAT{mode === 'PAPER' && shownPnl ? <span className={`ml-2 font-bold ${pnlTone(shownPnl)}`}>{inr(shownPnl)}</span> : null}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
