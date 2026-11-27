'use client';

// Quick Trade overlay for the /index-scalper underlying chart (Upstox "Chart 360" style). Every strike in view gets a
// line with its LIVE Call / Put premium chips; a click on a chip opens Buy / Sell with the preset lots, and one click
// sends a market order through the terminal (placeContract: lot cap, live price, session, broker routing, isx tag).
//
// It sits over the chart and reads the chart's geometry from `viewportRef` on its own 150 ms timer, so live premiums
// re-render this small overlay only, never the memoised chart. Only a LIVE bridge tick (`ltpById`) can trade. Without one
// (closed market, stale feed, outside the bridge window, or a contract with no trade yet today: deep-ITM MCX strikes often
// have none for hours) the chip shows the chain's last price, else its previous close, dimmed and marked "not live"
// (display only, as the chain panel does), else "—"; its Buy / Sell stay disabled.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ChartViewport } from './ScalperChart';
import type { PickedContract } from './OptionChainPanel';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import { nearestStrike, resolveSource } from '@/lib/indexScalperChartSource';
import { strikesAroundAtm, visibleStrikeRows, type QuickSettings, type StrikeRow } from '@/lib/indexScalperQuickTrade';
import { INSTRUMENTS, isMcx, type Underlying } from '@/lib/indexScalperInstrument';
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

/** Chips sit this far left of the chart's right edge: clear of the price axis (~65 px), a plain position chip
 *  (right-[84px]) and the OI profile's bars + labels. A row whose strike holds a position (Quick Trade anchors it on the
 *  strike line) measures that chip, which grows with its TP / SL badges, and sits just left of it. */
const CHIPS_RIGHT = 430;
/** Width of one row's label + C + P chips (every cell has a fixed width so the ladder lines up in columns): a narrow
 *  pane (two charts on a laptop) pulls the chips right so they never leave the plot on the left. */
const ROW_W = 210;

export default function QuickStrikeOverlay({ viewportRef, underlying, feed, settings, real, onTrade }: Props) {
  const strikes = useMemo(() => [...feed.strikeIds.keys()].sort((a, b) => a - b), [feed.strikeIds]);
  const spot = feed.spot ?? feed.chain?.spot ?? null;
  const atm = useMemo(() => nearestStrike(strikes, spot), [strikes, spot]);

  // Rows follow zoom / pan / autoscale, which fire no event: re-read the chart's geometry every 150 ms and set state only
  // when something moved, so an idle chart costs nothing.
  const [layout, setLayout] = useState<{ rows: StrikeRow[]; step: number; plotW: number; rights: Record<number, number> }>({ rows: [], step: 1, plotW: 0, rights: {} });
  const rootRef = useRef<HTMLDivElement>(null);
  // Only ATM ± `settings.range` strikes get a ladder row.
  const shownStrikes = useMemo(() => strikesAroundAtm(strikes, atm, settings.range), [strikes, atm, settings.range]);
  const strikesRef = useRef(shownStrikes);
  const atmRef = useRef(atm);
  useEffect(() => { strikesRef.current = shownStrikes; atmRef.current = atm; });
  useEffect(() => {
    const tick = () => {
      const vp = viewportRef.current;
      if (!vp) return;
      const { rows, step } = visibleStrikeRows(strikesRef.current, vp.priceToY, vp.plotHeight(), atmRef.current);
      const plotW = vp.plotWidth();
      // Position chips on a strike line (the chart draws them; they grow with TP / SL badges): measure where each starts.
      const rights: Record<number, number> = {};
      const host = rootRef.current?.parentElement;
      if (host) {
        const box = host.getBoundingClientRect();
        const chips = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="position-chip"]')).map(el => el.getBoundingClientRect());
        for (const r of rows) {
          for (const c of chips) {
            if (Math.abs(c.top + c.height / 2 - box.top - r.y) < 14) rights[r.strike] = Math.max(rights[r.strike] ?? 0, Math.round(box.right - c.left + 8));
          }
        }
      }
      setLayout(prev => {
        const same = prev.step === step && Math.abs(prev.plotW - plotW) < 0.5 && prev.rows.length === rows.length
          && prev.rows.every((r, i) => r.strike === rows[i].strike && r.atm === rows[i].atm && Math.abs(r.y - rows[i].y) < 0.5)
          && JSON.stringify(prev.rights) === JSON.stringify(rights);
        return same ? prev : { rows, step, plotW, rights };
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

  // `ltp`: the live tick (the only price that may trade). `shown`: what the chip displays: the live tick, else the chain's
  // last price (snapshot only: a live chain's last price IS the tick), else its previous close (display only, `live: false`;
  // `prev` marks a previous close, i.e. no trade yet today).
  const contractFor = useCallback((strike: number, type: Opt): { c: PickedContract | null; ltp: number | null; shown: number | null; live: boolean; prev: boolean } => {
    const side = feed.chain?.strikes?.[String(strike)]?.[type === 'CE' ? 'ce' : 'pe'];
    const snapLtp = feed.chainSource === 'snapshot' && side && side.ltp > 0 ? side.ltp : null;
    const prevClose = side?.prev_close && side.prev_close > 0 ? side.prev_close : null;
    const fallback = snapLtp ?? prevClose;
    const prev = snapLtp === null && prevClose !== null;
    const r = resolveSource({ kind: 'option', type, strike }, underlying, feed.strikeIds, spot, feed.kotak?.strikes ?? null);
    if (r.strike !== strike) return { c: null, ltp: null, shown: fallback, live: false, prev }; // not listed for this expiry
    const ltp = r.dhanId ? feed.ltpById.get(r.dhanId) ?? null : null;
    const shown = ltp ?? fallback;
    const live = ltp !== null;
    const securityId = r.dhanId ?? r.kotakSymbol;
    if (!securityId) return { c: null, ltp, shown, live, prev: !live && prev };
    return { c: { strike, type, securityId, ltp, expiry: feed.expiry, tradingSymbol: r.kotakSymbol }, ltp, shown, live, prev: !live && prev };
  }, [underlying, feed.strikeIds, feed.kotak?.strikes, feed.ltpById, feed.expiry, feed.chain, feed.chainSource, spot]);

  // Why a chip cannot trade right now (null = it can). Live price only: never a snapshot or a previous close.
  const blocked = (ltp: number | null): string | null => {
    if (!feed.marketOpen) return `${INSTRUMENTS[underlying].exchange} is closed`;
    if (feed.feedAgeSec === null || feed.stale) return 'No live ticks: the feed is stale or not running';
    if (ltp === null || !(ltp > 0)) return 'No live price for this strike: no trade yet today, or outside the strikes the live feed covers';
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
  const { rows, step, plotW, rights } = layout;
  if (rows.length === 0) return null;
  // One right edge for the whole ladder, so the C and P columns stay aligned: a row whose position chip reaches further
  // left moves every row with it, instead of only its own row jumping out of the column.
  const baseRight = Math.max(84, Math.min(CHIPS_RIGHT, plotW + 65 - ROW_W - 8));
  const right = Math.max(baseRight, ...rows.map(r => rights[r.strike] ?? 0));

  return (
    <div ref={rootRef} className="absolute inset-0 z-[3] pointer-events-none" data-testid="quick-overlay">
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
              <span className={cn('w-[54px] text-right text-[10px] font-mono whitespace-nowrap', r.atm ? 'text-violet-300 font-bold' : 'text-violet-400')}>{r.strike}{r.atm ? ' ATM' : ''}</span>
              {(['CE', 'PE'] as const).map(t => {
                const { ltp, shown, live, prev } = t === 'CE' ? ce : pe;
                const why = blocked(ltp);
                const shownTitle = live || shown === null ? ''
                  : prev ? ` · ${fmt(shown)} is the previous close (no trade today), not live`
                  : ` · ${fmt(shown)} is the last price from Dhan's chain snapshot, not live`;
                const isOpen = open?.strike === r.strike && open.type === t;
                return (
                  <div key={t} className="relative">
                    <button
                      type="button"
                      data-quick-chip
                      aria-label={`Quick ${r.strike} ${t}`}
                      aria-expanded={isOpen}
                      title={why ? `${why}${shownTitle}` : `${underlying} ${r.strike} ${t === 'CE' ? 'CALL' : 'PUT'}: click to buy or sell`}
                      onClick={() => setOpen(isOpen ? null : { strike: r.strike, type: t })}
                      className={cn('flex items-stretch h-[22px] rounded overflow-hidden border text-[11px] font-mono tabular-nums shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                        t === 'CE' ? 'border-sky-500/70' : 'border-violet-500/70', isOpen && 'ring-2 ring-offset-0 ring-sky-400')}
                    >
                      <span className={cn('w-4 flex items-center justify-center font-bold text-oncolor', t === 'CE' ? 'bg-sky-600' : 'bg-violet-600')}>{t === 'CE' ? 'C' : 'P'}</span>
                      <span data-live={live ? '1' : '0'} className={cn('w-[52px] pr-1 flex items-center justify-end bg-zinc-900', live && !why ? 'text-zinc-100' : shown !== null ? 'text-zinc-400 italic' : 'text-zinc-500')}>{fmt(shown)}</span>
                    </button>
                    {isOpen && (
                      // Compact: two small B / S buttons LEFT of the chip (lots and any reason in the tooltip). Not right of
                      // it: that is where the strike's position chip sits once it holds a leg, and it would cover them.
                      <div ref={popRef} role="group" aria-label={`Trade ${r.strike} ${t}`} data-reason={why ?? ''}
                        className="absolute right-full top-1/2 -translate-y-1/2 mr-1 z-10 flex items-center gap-0.5 p-0.5 rounded-md border border-zinc-600 bg-zinc-900 shadow-xl">
                        <button type="button" disabled={!!why || sending} onClick={() => void send(r.strike, t, 'BUY')}
                          aria-label={`Quick buy ${r.strike} ${t} ${settings.buyLots} lot${settings.buyLots === 1 ? '' : 's'}`}
                          title={why ? `${why}${shownTitle}` : `Buy ${settings.buyLots} lot${settings.buyLots === 1 ? '' : 's'} ${r.strike} ${t} at market${real ? ' (REAL)' : ' (SIM)'}`}
                          className={cn('w-6 h-[18px] rounded text-[11px] font-bold text-oncolor bg-emerald-600 hover:bg-emerald-500 disabled:opacity-35 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300', real && 'ring-1 ring-rose-400')}>B</button>
                        <button type="button" disabled={!!why || sending} onClick={() => void send(r.strike, t, 'SELL')}
                          aria-label={`Quick sell ${r.strike} ${t} ${settings.sellLots} lot${settings.sellLots === 1 ? '' : 's'}`}
                          title={why ? `${why}${shownTitle}` : `Sell ${settings.sellLots} lot${settings.sellLots === 1 ? '' : 's'} ${r.strike} ${t} at market${real ? ' (REAL)' : ' (SIM)'}`}
                          className={cn('w-6 h-[18px] rounded text-[11px] font-bold text-oncolor bg-rose-600 hover:bg-rose-500 disabled:opacity-35 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300', real && 'ring-1 ring-rose-400')}>S</button>
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
