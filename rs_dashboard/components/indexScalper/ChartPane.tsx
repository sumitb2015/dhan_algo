'use client';

// One chart pane of /index-scalper: a slim header (what it plots: the underlying, or a CE / PE strike of the selected
// expiry; its own timeframe) over a ScalperChart. An option pane plots that contract's premium, so its position line,
// TP / SL and working orders are exact premium levels. The pane only filters and binds; every order still goes through
// the terminal's placeContract (caps, live price, session, lot size). Memoised: every prop the terminal passes is
// stable, so a feed push re-renders a pane only through `feed` (cheap) and the chart only when its own props change.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import ScalperChart, { DRAW_KEY, type ChartViewport, type DrawTool } from './ScalperChart';
import QuickStrikeOverlay from './QuickStrikeOverlay';
import type { QuickSettings } from '@/lib/indexScalperQuickTrade';
import type { PickedContract } from './OptionChainPanel';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import { useChartBars, type Interval } from './useChartBars';
import {
  legOnChart, nearestStrike, orderOnChart, resolveSource, sourceLabel, type ChartSource,
} from '@/lib/indexScalperChartSource';
import { legsKey, type ScalperLeg } from '@/lib/indexScalperPositions';
import { buildOiProfile, oiProfileKey, type OiMode } from '@/lib/indexScalperOiProfile';
import type { IndicatorInstance } from '@/lib/indexScalperIndicators';
import type { OrderRowView } from '@/lib/indexScalperAccount';
import { isMcx, type Underlying } from '@/lib/indexScalperInstrument';
import { toIsoDate } from '@/components/DataChip';
import { cn } from '@/lib/utils';
import type { TrailState } from '@/lib/indexScalperTrail';

export interface PaneCfg { source: ChartSource; interval: Interval }

export const INTERVALS: Interval[] = ['1', '3', '5', '15', '30', '60'];
const intervalLabel = (i: Interval) => (i === '60' ? '1h' : `${i}m`);
const EMPTY_ORDERS: OrderRowView[] = [];

type ChartOrderReq = { side: 'BUY' | 'SELL'; price: number; lots: number; orderType?: 'LIMIT' | 'STOP_LOSS' };

interface Props {
  index: number;
  cfg: PaneCfg;
  onCfgChange: (index: number, cfg: PaneCfg) => void;
  /** Reports this pane's data date and candle state up (header DATA chip, refresh spinner, error strip). */
  onStatus: (index: number, s: { date: string | null; loading: boolean; error: string | null }) => void;
  underlying: Underlying;
  feed: IndexScalperFeed;
  days: number;
  refreshTick: number;
  /** The underlying pane's order contract (the future), and its name. */
  futureContract: PickedContract | null;
  futureName: string;
  // Shared chart props, passed straight through.
  indicators: IndicatorInstance[];
  tool: DrawTool;
  onToolDone: () => void;
  clearToken: number;
  logScale: boolean;
  showGrid: boolean;
  showVolume: boolean;
  volumeMaLen: number;
  pctScale: boolean;
  autoScale: boolean;
  legs: ScalperLeg[];
  entrySpots: Record<string, number>;
  onExitLeg: (leg: ScalperLeg) => void;
  /** Quick Trade chip +/-: one lot more in the leg's direction (+1) or one lot taken off (-1). */
  onAdjustLeg: (leg: ScalperLeg, delta: 1 | -1) => void;
  exitingId: string | null;
  onToggleIndicator: (id: string) => void;
  onRemoveIndicator: (id: string) => void;
  onEditIndicator: (id: string) => void;
  focus: { seconds: number; seq: number } | null;
  /** Bumped by the header's Reset scale button: the chart goes back to auto-scale and its default time frame. */
  resetSeq: number;
  lots: number;
  openOrders: OrderRowView[];
  onCancelOrder: (orderId: string) => void;
  onModifyOrder: (req: { orderId: string; level?: number; lots?: number }) => Promise<boolean>;
  onPlaceChartOrder: (contract: PickedContract | null, req: ChartOrderReq) => void;
  onOpenTicket: (contract: PickedContract | null, req: { price: number; lots: number; orderType: 'LIMIT' }) => void;
  onAlert: (symbol: string, price: number) => void;
  simBrackets: Record<string, { tp?: number; sl?: number }>;
  onSetBracket: (req: { leg: ScalperLeg; kind: 'TP' | 'SL'; price: number }) => void;
  onCancelBracket: (req: { legId: string; kind: 'TP' | 'SL'; orderId?: string }) => void;
  onReversePosition: (leg: ScalperLeg) => void;
  trails: Record<string, TrailState>;
  onSetTrail: (leg: ScalperLeg, pts: number, tick: number) => void;
  onCancelTrail: (legId: string) => void;
  feedLotSize: number | null;
  orderQtyMult: number;
  /** Draw the Call / Put OI profile (underlying panes only: strikes are underlying levels, not premiums). */
  showOi: boolean;
  oiMode: OiMode;
  /** Quick Trade settings when it is on (strike lines with live C / P chips on underlying panes); null = off. */
  quick: QuickSettings | null;
  /** The position chip's - / + step in lots (Quick Trade's "Lots per + / -"), also used while Quick Trade is off. */
  stepLots: number;
  real: boolean;
  onQuickTrade: (c: PickedContract, side: 'BUY' | 'SELL', lots: number, product: 'INTRADAY' | 'MARGIN') => Promise<{ ok: boolean; text: string }>;
}

function ChartPane(p: Props) {
  const { index, cfg, onCfgChange, onStatus, underlying, feed } = p;
  const { source, interval } = cfg;

  // ATM reference: the live spot, else the chain snapshot's (market closed / bridge not up yet). With neither, an ATM
  // pane waits: it never pins a guessed strike.
  const spot = feed.spot ?? feed.chain?.spot ?? null;
  const needsSpot = source.kind === 'option' && !feed.strikeIds.has(source.strike);
  const resolved = useMemo(
    () => resolveSource(source, underlying, feed.strikeIds, spot, feed.kotak?.strikes ?? null, feed.indexFuture?.dhanId ?? null),
    // Spot only matters until the strike is pinned (below); a strike already listed ignores it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, underlying, feed.strikeIds, feed.kotak?.strikes, needsSpot ? spot : null, feed.indexFuture?.dhanId],
  );

  // Pin the strike: a pane opened on "ATM" (or on a strike this expiry does not list) keeps the strike it resolved to,
  // so the chart does not hop to a new contract as spot moves. `auto` = pinned by the pane, so a reload resolves ATM
  // again instead of reopening yesterday's ATM.
  useEffect(() => {
    if (source.kind !== 'option' || resolved.strike === null || resolved.strike === source.strike) return;
    onCfgChange(index, { ...cfg, source: { kind: 'option', type: source.type, strike: resolved.strike, auto: true } });
  }, [resolved.strike, source, cfg, index, onCfgChange]);

  const { bars, loading, error, noLiveTicks, tag: viewKey } = useChartBars(underlying, resolved, interval, p.days, p.refreshTick, feed);

  const lastT = bars.length ? bars[bars.length - 1].t : null;
  const date = lastT !== null ? toIsoDate(String(lastT)) : null;
  useEffect(() => { onStatus(index, { date, loading, error }); }, [index, date, loading, error, onStatus]);

  const isOption = resolved.kind === 'option';
  // The NIFTY future: chart only (no orders, positions, brackets, Quick Trade or OI profile on it).
  const isFuture = resolved.kind === 'future';
  const isIndex = !isOption && !isFuture;
  const viewportRef = useRef<ChartViewport | null>(null);
  const quickOn = !!p.quick && isIndex;
  const label = sourceLabel(underlying, resolved);

  // The contract this pane's "+" menu and ticket trade: the option on screen, or the underlying's future.
  const optContract = useMemo<PickedContract | null>(() => {
    if (!isOption || resolved.strike === null || resolved.type === null) return null;
    const securityId = resolved.dhanId ?? resolved.kotakSymbol;
    if (!securityId) return null;
    return { strike: resolved.strike, type: resolved.type, securityId, ltp: null, expiry: feed.expiry, tradingSymbol: resolved.kotakSymbol };
  }, [isOption, resolved.strike, resolved.type, resolved.dhanId, resolved.kotakSymbol, feed.expiry]);
  const contract = isOption ? optContract : p.futureContract;

  const { onPlaceChartOrder, onOpenTicket } = p;
  const placeOrder = useCallback((req: ChartOrderReq) => onPlaceChartOrder(contract, req), [onPlaceChartOrder, contract]);
  const openTicket = useCallback((req: { price: number; lots: number; orderType: 'LIMIT' }) => onOpenTicket(contract, req), [onOpenTicket, contract]);

  // Keep identity while nothing on this pane changed (legsKey), so the memoised chart skips feed pushes.
  const paneLegsAll = useMemo(() => p.legs.filter(l => legOnChart(l, resolved)), [p.legs, resolved]);
  const legsSig = legsKey(paneLegsAll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const paneLegs = useMemo(() => paneLegsAll, [legsSig]);
  // OI per strike for the expiry on screen: the live chain, else Dhan's snapshot (display only). Kept by value (oiProfileKey)
  // so a push that moved only prices does not re-render the chart.
  // (index pane only: strike levels are index levels; the future trades ~100 pts away)
  const oiSource = isIndex && p.showOi ? (feed.quotes ?? feed.chain)?.strikes ?? null : null;
  const oiRaw = useMemo(() => buildOiProfile(oiSource), [oiSource]);
  const oiKey = oiProfileKey(oiRaw);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const oiProfile = useMemo(() => oiRaw, [oiKey]);
  // Quick Trade: the working orders of the option legs drawn here (their premium TP / SL badges), by security id. They
  // are not drawn as lines: their prices are premiums, not index levels.
  const premiumOrders = useMemo(() => {
    if (!quickOn) return EMPTY_ORDERS;
    const ids = new Set(paneLegs.filter(l => l.type !== 'FUT').map(l => l.securityId));
    return ids.size ? p.openOrders.filter(o => o.securityId && ids.has(o.securityId)) : EMPTY_ORDERS;
  }, [quickOn, paneLegs, p.openOrders]);
  const paneOrders = useMemo(() => p.openOrders.filter(o => orderOnChart(o, resolved)), [p.openOrders, resolved]);

  // Strike picker: every strike the expiry lists. Strikes far from ATM get history only (the bridge ticks 35 around ATM).
  const pickList = useMemo(() => [...feed.strikeIds.keys()].sort((a, b) => a - b), [feed.strikeIds]);
  const atm = useMemo(() => nearestStrike(pickList, spot), [pickList, spot]);

  const setSource = (s: ChartSource) => onCfgChange(index, { ...cfg, source: s });
  // CE <-> PE keeps the strike (and whether it was the pane's own ATM pin); Index -> option starts at ATM.
  const pickType = (t: 'CE' | 'PE') => setSource(source.kind === 'option'
    ? { ...source, type: t }
    : { kind: 'option', type: t, strike: 0 });

  const seg = 'h-6 px-2 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';
  const tf = 'h-6 px-1.5 rounded text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';

  // Drawings belong to the price axis they were made on: an option's premium, the NIFTY future (~100 pts off the index),
  // each crude contract; the NIFTY index keeps the original key (existing drawings stay).
  const drawKey = isOption ? `${DRAW_KEY}:${resolved.dhanId ?? resolved.kotakSymbol ?? 'none'}`
    : isFuture ? `${DRAW_KEY}:fut:${underlying}`
    : underlying === 'NIFTY' ? DRAW_KEY : `${DRAW_KEY}:${underlying}`;
  const tfLabel = `${interval}`;

  return (
    <div data-testid={`chart-pane-${index}`} className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="flex items-center gap-1.5 px-2 h-8 border-b border-zinc-800 bg-zinc-950 shrink-0">
        <div role="group" aria-label={`Chart ${index + 1} instrument`} className="flex rounded border border-zinc-700 overflow-hidden">
          <button type="button" aria-pressed={isIndex} onClick={() => setSource({ kind: 'underlying' })}
            className={cn(seg, isIndex ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800')}>
            {isMcx(underlying) ? 'FUT' : 'Index'}
          </button>
          {!isMcx(underlying) && (
            <button type="button" aria-pressed={isFuture} onClick={() => setSource({ kind: 'future' })}
              title="NIFTY future: real volume and a volume-weighted VWAP (chart only: orders are not placed from this pane)"
              className={cn(seg, isFuture ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800')}>FUT</button>
          )}
          <button type="button" aria-pressed={isOption && resolved.type === 'CE'} onClick={() => pickType('CE')}
            className={cn(seg, isOption && resolved.type === 'CE' ? 'bg-sky-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}>CE</button>
          <button type="button" aria-pressed={isOption && resolved.type === 'PE'} onClick={() => pickType('PE')}
            className={cn(seg, isOption && resolved.type === 'PE' ? 'bg-rose-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}>PE</button>
        </div>
        {isOption && (
          <select
            aria-label={`Chart ${index + 1} strike`}
            value={resolved.strike ?? ''}
            disabled={pickList.length === 0}
            onChange={e => setSource({ kind: 'option', type: resolved.type ?? 'CE', strike: Number(e.target.value) })} // a user pick: kept across reloads
            className="h-6 px-1 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-mono text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
          >
            {(pickList.length === 0 || resolved.strike === null) && <option value="">{pickList.length === 0 ? 'loading…' : 'ATM…'}</option>}
            {pickList.map(s => <option key={s} value={s}>{s}{s === atm ? ' (ATM)' : ''}</option>)}
          </select>
        )}
        <span className="w-px h-4 bg-zinc-800 shrink-0" />
        <div role="group" aria-label={`Chart ${index + 1} timeframe`} className="flex items-center">
          {INTERVALS.map(i => (
            <button key={i} type="button" aria-pressed={interval === i} onClick={() => onCfgChange(index, { ...cfg, interval: i })}
              className={cn(tf, interval === i && 'bg-zinc-800 text-white')}>{intervalLabel(i)}</button>
          ))}
        </div>
        <span className="ml-1 text-[11px] font-mono font-semibold text-zinc-300 truncate">{label}</span>
        {isOption && feed.expiry && <span className="text-[10px] font-mono text-zinc-500 shrink-0">{feed.expiry}</span>}
        {isFuture && feed.indexFuture && <span className="text-[10px] font-mono text-zinc-500 shrink-0">{feed.indexFuture.expiry} · chart only</span>}
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500 shrink-0" aria-label="Loading candles" />}
        {noLiveTicks && (
          <span data-testid="no-live-ticks" className="text-[10px] text-amber-400 shrink-0" title={isFuture
              ? 'The options bridge is not streaming this future (it tracks another month): this chart shows history only.'
              : 'The live bridge ticks the strikes around ATM only: this chart shows history, and market orders on it are refused.'}>
            no live ticks
          </span>
        )}
        {error && <span className="text-[10px] text-amber-400 truncate" title={error}>Candles: {error}</span>}
        {oiProfile && p.oiMode === 'change' && !oiProfile.hasChange && (
          <span data-testid="oi-change-unavailable" className="text-[10px] text-amber-400 shrink-0"
            title="The chain has no previous-day OI for this expiry, so the change cannot be computed (it is not shown as zero).">
            OI change: no previous-day OI
          </span>
        )}
      </div>
      <div className="relative flex-1 min-w-0 min-h-0">
        <ScalperChart
          key={drawKey}
          bars={bars} indicators={p.indicators} tool={p.tool} onToolDone={p.onToolDone} clearToken={p.clearToken}
          logScale={p.logScale} pctScale={p.pctScale} autoScale={p.autoScale} showGrid={p.showGrid} showVolume={p.showVolume} volumeMaLen={p.volumeMaLen}
          legs={paneLegs} entrySpots={p.entrySpots} onExitLeg={p.onExitLeg} onAdjustLeg={quickOn || isOption ? p.onAdjustLeg : undefined} adjustLots={p.stepLots} exitingId={p.exitingId}
          onToggleIndicator={p.onToggleIndicator} onRemoveIndicator={p.onRemoveIndicator} onEditIndicator={p.onEditIndicator}
          symbolLabel={isOption ? `${label} · ${tfLabel}` : isFuture ? `NIFTY · ${tfLabel} · FUT` : (isMcx(underlying) ? `${underlying} · ${tfLabel} · FUT` : `NIFTY · ${tfLabel} · IDX`)}
          focus={p.focus} resetSeq={p.resetSeq}
          contractName={isOption || isFuture ? label : p.futureName}
          ordersEnabled={!isFuture}
          lots={p.lots}
          openOrders={paneOrders}
          onCancelOrder={p.onCancelOrder} onModifyOrder={p.onModifyOrder}
          onPlaceLimitOrder={placeOrder}
          onOpenTicket={openTicket}
          onAlert={p.onAlert}
          simBrackets={p.simBrackets}
          onSetBracket={p.onSetBracket}
          onCancelBracket={p.onCancelBracket}
          onReversePosition={p.onReversePosition}
          trails={p.trails} onSetTrail={p.onSetTrail} onCancelTrail={p.onCancelTrail}
          underlying={underlying}
          feedLotSize={p.feedLotSize}
          orderQtyMult={p.orderQtyMult}
          premium={isOption}
          tickSize={resolved.tick}
          drawKey={drawKey}
          viewKey={viewKey}
          oiProfile={oiProfile}
          oiMode={p.oiMode}
          viewportRef={viewportRef}
          strikeAnchor={quickOn}
          premiumOrders={premiumOrders}
        />
        {quickOn && p.quick && (
          <QuickStrikeOverlay viewportRef={viewportRef} underlying={underlying} feed={feed} settings={p.quick} real={p.real} onTrade={p.onQuickTrade} />
        )}
        {bars.length === 0 && !loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500 pointer-events-none">
            {isOption && resolved.strike === null && pickList.length > 0
              ? `Waiting for the ${underlying} price to pick the ATM strike…`
              : isOption && !resolved.dhanId ? 'Waiting for the option contract…'
              : isFuture && !resolved.dhanId ? 'Waiting for the NIFTY future contract…' : `No candles to show${error ? '' : ' yet'}.`}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ChartPane);
