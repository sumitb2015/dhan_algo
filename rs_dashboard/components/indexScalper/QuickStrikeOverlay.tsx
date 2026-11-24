'use client';

// Quick Trade overlay for the /index-scalper underlying chart (Upstox "Chart 360" style). Every strike in view gets a
// line with its LIVE Call / Put premium chips; a click on a chip opens Buy / Sell with the preset lots, and one click
// sends a market order through the terminal (placeContract: lot cap, live price, session, broker routing, isx tag).
//
// It sits over the chart and reads the chart's geometry from `viewportRef` on its own 150 ms timer, so live premiums
// re-render this small overlay only, never the memoised chart. Prices are live bridge ticks only (`ltpById`): a strike
// without one (outside the bridge window, stale feed, closed market) shows "—" and cannot trade.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ChevronsDown, ChevronsUp, X } from 'lucide-react';
import type { ChartViewport } from './ScalperChart';
import type { PickedContract } from './OptionChainPanel';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import { nearestStrike, resolveSource } from '@/lib/indexScalperChartSource';
import { visibleStrikeRows, type QuickSettings, type StrikeRow } from '@/lib/indexScalperQuickTrade';
import type { Underlying } from '@/lib/indexScalperInstrument';
import { cn } from '@/lib/utils';

type Side = 'BUY' | 'SELL';
type Opt = 'CE' | 'PE';

interface Props {
  viewportRef: MutableRefObject<ChartViewport | null>;
  underlying: Underlying;
  feed: IndexScalperFeed;
  settings: QuickSettings;
  real: boolean;
  onTrade: (c: PickedContract, side: Side, lots: number, product: 'INTRADAY' | 'MARGIN') => Promise<{ ok: boolean; text: string }>;
}

/** Chips sit this far left of the chart's right edge: clear of the price axis (~65 px), the position / TP / SL chips
 *  (right-[84px], ~260 px wide) and the OI profile's bars + labels (up to 260 px + label). */
const CHIPS_RIGHT = 430;
/** Width of one row's label + C + P chips: a narrow pane (two charts on a laptop) pulls the chips right so they never
 *  leave the plot on the left. */
const ROW_W = 240;

export default function QuickStrikeOverlay({ viewportRef, underlying, feed, settings, real, onTrade }: Props) {
  const strikes = useMemo(() => [...feed.strikeIds.keys()].sort((a, b) => a - b), [feed.strikeIds]);
  const spot = feed.spot ?? feed.chain?.spot ?? null;
  const atm = useMemo(() => nearestStrike(strikes, spot), [strikes, spot]);

  // Rows follow zoom / pan / autoscale, which fire no event: re-read the chart's geometry every 150 ms and set state only
  // when something moved, so an idle chart costs nothing.
  const [layout, setLayout] = useState<{ rows: StrikeRow[]; step: number; plotW: number }>({ rows: [], step: 1, plotW: 0 });
  const strikesRef = useRef(strikes);
  const atmRef = useRef(atm);
  useEffect(() => { strikesRef.current = strikes; atmRef.current = atm; });
  useEffect(() => {
    const tick = () => {
      const vp = viewportRef.current;
      if (!vp) return;
      const { rows, step } = visibleStrikeRows(strikesRef.current, vp.priceToY, vp.plotHeight(), atmRef.current);
      const plotW = vp.plotWidth();
      setLayout(prev => {
        const same = prev.step === step && Math.abs(prev.plotW - plotW) < 0.5 && prev.rows.length === rows.length
          && prev.rows.every((r, i) => r.strike === rows[i].strike && r.atm === rows[i].atm && Math.abs(r.y - rows[i].y) < 0.5);
        return same ? prev : { rows, step, plotW };
      });
    };
    tick();
    const t = setInterval(tick, 150);
    return () => clearInterval(t);
  }, [viewportRef]);

  // Popover (one at a time) and its outside-click / Esc close.
  const [open, setOpen] = useState<{ strike: number; type: Opt } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (popRef.current?.contains(t) || t?.closest?.('[data-quick-chip]')) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const contractFor = useCallback((strike: number, type: Opt): { c: PickedContract | null; ltp: number | null } => {
    const r = resolveSource({ kind: 'option', type, strike }, underlying, feed.strikeIds, spot, feed.kotak?.strikes ?? null);
    if (r.strike !== strike) return { c: null, ltp: null }; // not listed for this expiry
    const ltp = r.dhanId ? feed.ltpById.get(r.dhanId) ?? null : null;
    const securityId = r.dhanId ?? r.kotakSymbol;
    if (!securityId) return { c: null, ltp };
    return { c: { strike, type, securityId, ltp, expiry: feed.expiry, tradingSymbol: r.kotakSymbol }, ltp };
  }, [underlying, feed.strikeIds, feed.kotak?.strikes, feed.ltpById, feed.expiry, spot]);

  // Why a chip cannot trade right now (null = it can). Live price only: never a snapshot or a previous close.
  const blocked = (ltp: number | null): string | null => {
    if (!feed.marketOpen) return `${underlying === 'CRUDEOILM' ? 'MCX' : 'NSE'} is closed`;
    if (feed.feedAgeSec === null || feed.stale) return 'No live ticks: the feed is stale or not running';
    if (ltp === null || !(ltp > 0)) return 'No live price for this strike (the live feed covers the strikes around ATM)';
    return null;
  };

  // One order per click: a click while one is in flight is ignored (the terminal has its own busy latch too).
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const send = async (strike: number, type: Opt, side: Side) => {
    if (sendingRef.current) return;
    const { c, ltp } = contractFor(strike, type);
    if (!c || blocked(ltp)) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onTrade(c, side, side === 'BUY' ? settings.buyLots : settings.sellLots, settings.product);
      setOpen(null);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(2));
  const { rows, step, plotW } = layout;
  if (rows.length === 0) return null;
  const right = Math.max(84, Math.min(CHIPS_RIGHT, plotW + 65 - ROW_W - 8));

  return (
    <div className="absolute inset-0 z-[3] pointer-events-none" data-testid="quick-overlay">
      {step > 1 && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-8 px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-400">
          Every {step === 2 ? '2nd' : `${step}th`} strike: zoom in for all
        </div>
      )}
      {rows.map(r => {
        const ce = contractFor(r.strike, 'CE'), pe = contractFor(r.strike, 'PE');
        return (
          <div key={r.strike} data-testid="quick-strike-row" data-strike={r.strike} data-y={r.y.toFixed(1)}>
            {/* strike line: violet data colour, the ATM line a little stronger */}
            <div className={cn('absolute left-0 h-px', r.atm ? 'bg-violet-400/70' : 'bg-violet-500/30')} style={{ top: r.y, width: Math.max(0, plotW) }} />
            <div className="absolute flex items-center gap-1.5 -translate-y-1/2 pointer-events-auto" style={{ top: r.y, right }}>
              <span className={cn('text-[10px] font-mono pr-0.5 whitespace-nowrap', r.atm ? 'text-violet-300 font-bold' : 'text-violet-400')}>{r.strike}{r.atm ? ' ATM' : ''}</span>
              {(['CE', 'PE'] as const).map(t => {
                const { ltp } = t === 'CE' ? ce : pe;
                const why = blocked(ltp);
                const isOpen = open?.strike === r.strike && open.type === t;
                return (
                  <div key={t} className="relative">
                    <button
                      type="button"
                      data-quick-chip
                      aria-label={`Quick ${r.strike} ${t}`}
                      aria-expanded={isOpen}
                      title={why ?? `${underlying} ${r.strike} ${t === 'CE' ? 'CALL' : 'PUT'}: click to buy or sell`}
                      onClick={() => setOpen(isOpen ? null : { strike: r.strike, type: t })}
                      className={cn('flex items-stretch h-[22px] rounded overflow-hidden border text-[11px] font-mono tabular-nums shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                        t === 'CE' ? 'border-sky-500/70' : 'border-violet-500/70', isOpen && 'ring-2 ring-offset-0 ring-sky-400')}
                    >
                      <span className={cn('px-1.5 flex items-center font-bold text-oncolor', t === 'CE' ? 'bg-sky-600' : 'bg-violet-600')}>{t === 'CE' ? 'C' : 'P'}</span>
                      <span className={cn('px-1.5 flex items-center bg-zinc-900', why ? 'text-zinc-500' : 'text-zinc-100')}>{fmt(ltp)}</span>
                    </button>
                    {isOpen && (
                      <div ref={popRef} role="dialog" aria-label={`Trade ${r.strike} ${t}`}
                        className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 z-10 w-[132px] rounded-2xl border border-violet-500/60 bg-zinc-900 shadow-2xl p-1.5 flex flex-col gap-1">
                        <button type="button" disabled={!!why || sending} onClick={() => void send(r.strike, t, 'BUY')}
                          aria-label={`Quick buy ${r.strike} ${t} ${settings.buyLots} lot${settings.buyLots === 1 ? '' : 's'}`}
                          className="h-8 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-oncolor text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">
                          <ChevronsUp className="w-4 h-4" />Buy {settings.buyLots}L
                        </button>
                        <div className="flex items-center justify-between px-1 text-[10px] font-mono">
                          <span className={cn('font-bold', t === 'CE' ? 'text-sky-400' : 'text-violet-400')}>{r.strike} {t}</span>
                          <span className="text-zinc-200">{fmt(ltp)}</span>
                          <button type="button" aria-label="Close" onClick={() => setOpen(null)} className="text-zinc-500 hover:text-white"><X className="w-3 h-3" /></button>
                        </div>
                        <button type="button" disabled={!!why || sending} onClick={() => void send(r.strike, t, 'SELL')}
                          aria-label={`Quick sell ${r.strike} ${t} ${settings.sellLots} lot${settings.sellLots === 1 ? '' : 's'}`}
                          className="h-8 rounded-xl bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300">
                          <ChevronsDown className="w-4 h-4" />Sell {settings.sellLots}L
                        </button>
                        {why && <div className="text-[9px] leading-tight text-amber-400 px-0.5">{why}</div>}
                        {real && !why && <div className="text-[9px] font-bold text-rose-400 text-center">REAL · market order</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
