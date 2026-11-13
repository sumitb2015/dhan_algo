'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeIndianRupee, AlertTriangle, CircleHelp, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { installAlertSoundUnlock, playAlertChime, playEntryChime, playExitChime, playWarnChime } from '@/lib/alertSound';
import { streakStart, tradeEvents, type ChimeKind, type TradeSnapshot } from '@/lib/freshMoneyChime';
import { useTabLeader } from '@/hooks/useTabLeader';
import NavBar from './NavBar';
import type { FreshMoneyResponse, FreshMoneyRow } from '@/app/api/fresh-money/route';
import type { FreshMoneyLive } from '@/app/api/fresh-money/live/route';
import { BUILDUP_TEXT, oiDelta, fmtOi, fmtOiAbs, fmtOiShort, flowScale, flowStreak, flowTier, streakVsDay, sumFlows, type Buildup, type FlowTier, type SideFlow, type SumFlow } from '@/lib/freshMoney';
import type { FmBroker, FmPosition, OptType, TxnSide } from '@/lib/freshMoneyTrades';
import { ExitAllButton, FM_BROKERS, OffBoardPositions, TradeBar, TradeCell, brokerLabel, lockKey, useFreshMoneyTrades, type ExitDefaultsUi } from './freshMoney/trading';
import { validateExitSpec, type ExitSpec, type FmExit } from '@/lib/freshMoneyExits';
import { usePageBroker } from './BrokerPicker';
import CollectorControl from './freshMoney/CollectorControl';
import PositionsOrders from './freshMoney/PositionsOrders';
import CumulativeOiWidget from './scalpCockpit/CumulativeOiWidget';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
const MCX_UNDERLYINGS: ReadonlySet<string> = new Set(['CRUDEOIL', 'CRUDEOILM']);
type Underlying = (typeof UNDERLYINGS)[number];
const POLL_MS = 30_000;
const PREF_UNDERLYING = 'freshMoney.underlying';
const PREF_LOTS = 'freshMoney.lots';
const PREF_OI_MODE = 'freshMoney.oiMode';
type OiMode = 'change' | 'total' | 'delta' | 'flow';
const PREF_POS_COLLAPSED = 'freshMoney.positionsCollapsed';
const PREF_FLOW_HELP = 'freshMoney.flowHelp';
/** Fresh Money's own sound on / off ('1' / '0', default on) — never another page's mute (dhan-alert-sound). */
const PREF_SOUND = 'freshMoney.sound';
const PREF_EXIT_DEFAULTS = 'freshMoney.exitDefaults';
const NO_EXITS: ExitDefaultsUi = { target: null, sl: null };

/** A remembered spec, re-validated (a hand-edited or old value is dropped, never used). */
const specOrNull = (v: unknown): ExitSpec | null => { const r = validateExitSpec(v); return r && !('error' in r) ? r : null; };
const LIVE_POLL_MS = 2_000;
/** Fallback chart span (NSE) until the board reply says which session it covers. */
const NSE_DAY = { from: 9 * 60 + 15, to: 15 * 60 + 30 };

// Literal class strings (Tailwind cannot see interpolated ones). Fill = OI building, outline = OI leaving.
const BAR_CLASS: Record<'put' | 'call', Record<'fill' | 'outline', string>> = {
  put: { fill: 'bg-emerald-500/55', outline: 'border border-emerald-500/60' },
  call: { fill: 'bg-red-500/60', outline: 'border border-red-500/60' },
};

const GRID = 'grid grid-cols-[minmax(0,1fr)_76px_96px_76px_minmax(0,1fr)] items-center';
// With trading on, a cell each side of the strike holds B / S, the P&L chip and × (literal string for Tailwind).
const GRID_TRADE = 'grid grid-cols-[minmax(0,1fr)_76px_172px_80px_172px_76px_minmax(0,1fr)] items-center';
// Slot-flow tab: the same grids plus an 11-cell block (10 completed slots + the running one, 38 px each) on each outer edge,
// and 96 px number columns (the streak badge sits beside the number: "▲10 +99,999").
const GRID_FLOW = 'grid grid-cols-[418px_minmax(0,1fr)_96px_96px_96px_minmax(0,1fr)_418px] items-center';
const GRID_FLOW_TRADE = 'grid grid-cols-[418px_minmax(0,1fr)_96px_172px_80px_172px_96px_minmax(0,1fr)_418px] items-center';
const gridFor = (mode: OiMode, trade: boolean) => (mode === 'flow' ? (trade ? GRID_FLOW_TRADE : GRID_FLOW) : (trade ? GRID_TRADE : GRID));

interface RowTrade {
  put: FmPosition | undefined;
  call: FmPosition | undefined;
  showButtons: boolean;
  canOrder: boolean;
  canClose: boolean;
  armed: boolean;
  ltpSource: Record<string, 'ws' | 'rest'>;
  exits: Record<string, FmExit>;
  busy: (opt: OptType) => boolean;
  order: (opt: OptType, side: TxnSide) => void;
  close: (p: FmPosition) => void;
  setExit: (key: string, target: ExitSpec | null, sl: ExitSpec | null) => Promise<boolean>;
}

function readPref(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, v: string) {
  try { window.localStorage.setItem(key, v); } catch { /* storage blocked */ }
}


/** "YYYY-MM-DD HH:MM:SS" IST → epoch ms. */
function istEpoch(ts: string): number {
  return new Date(`${ts.replace(' ', 'T')}+05:30`).getTime();
}

/** LB / SB / SC / LU pill at a bar's outer end; full name and meaning on hover. */
function BuildupTag({ tag }: { tag: Buildup }) {
  const t = BUILDUP_TEXT[tag];
  return (
    <span title={`${t.name} — ${t.meaning}`} aria-label={t.name}
      className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] font-bold leading-[14px] tracking-wide text-zinc-300">
      {tag}
    </span>
  );
}

/** `length` sets the bar (OI moved, or total OI); `moved` (today's change) always decides filled = building vs
 *  outline = leaving, so both modes read the same way. */
function Bar({ side, length, moved, max, tag }: {
  side: 'put' | 'call'; length: number | null; moved: number | null; max: number;
  tag: Buildup | null;
}) {
  if (length === null || length === 0 || max <= 0) return <div />;
  // The tag takes room at the outer end, so the bar scales within what is left.
  const w = Math.max(1.5, (Math.abs(length) / max) * (tag ? 88 : 100));
  const cls = BAR_CLASS[side][(moved ?? 0) >= 0 ? 'fill' : 'outline'];
  return (
    <div className={`flex h-full min-w-0 items-center gap-1 ${side === 'put' ? 'justify-end' : 'justify-start'}`}>
      {side === 'put' && tag && <BuildupTag tag={tag} />}
      <div className={`h-[15px] ${cls}`} style={{ width: `${w}%` }} />
      {side === 'call' && tag && <BuildupTag tag={tag} />}
    </div>
  );
}

/** Δ OI bar on the left panel: length = |Call OI − Put OI|, red when calls are heavier, green when puts are. */
function DeltaBar({ delta, max }: { delta: number | null; max: number }) {
  if (delta === null || delta === 0 || max <= 0) return <div />;
  const w = Math.max(1.5, (Math.abs(delta) / max) * 100);
  return (
    <div className="flex h-full min-w-0 items-center justify-end">
      <div className={`h-[15px] ${delta > 0 ? 'bg-red-500/60' : 'bg-emerald-500/55'}`} style={{ width: `${w}%` }} />
    </div>
  );
}

type FlowSlots = FreshMoneyResponse['flowSlots'];
/** A server that predates the slot tab sends no layout: no cells, nothing to break. */
const NO_SLOTS: FlowSlots = { slotMin: 3, bounds: [], boundOk: [], lastTs: '', dayAt: null };

/** Slot i (oldest first; the last index = the running slot): label, hover text and whether it is still running. */
function slotInfo(fs: FlowSlots, i: number): { head: string; span: string; running: boolean; ok: boolean } {
  const n = fs.bounds.length - 1;   // completed slots
  if (i < n) {
    return { head: fs.bounds[i + 1], span: `${fs.bounds[i]}–${fs.bounds[i + 1]}`, running: false, ok: fs.boundOk[i] && fs.boundOk[i + 1] };
  }
  const start = fs.bounds[n] ?? '';
  const [h, m] = start.split(':').map(Number);
  const endMin = h * 60 + m + fs.slotMin;
  const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  return { head: `${end}…`, span: `${start}–${end}, running (so far to ${fs.lastTs})`, running: true, ok: !!fs.boundOk[n] };
}

/** Cell order for one side: puts read oldest → running left to right, calls are mirrored, so the running slot always
 *  sits next to the strike. */
function slotOrder(fs: FlowSlots, side: 'put' | 'call'): number[] {
  const idx = Array.from({ length: fs.bounds.length }, (_, i) => i);   // n completed + 1 running
  return side === 'call' ? idx.reverse() : idx;
}

// Slot-cell tint by size (literal strings for Tailwind; tints on backgrounds are data colours, allowed in every theme).
// The strongest tier uses text-white, a theme token (near-white in dark, near-black in white / beige): coloured text on a
// 45 % tint of its own colour is too faint.
const TINT: Record<'up' | 'down', Record<Exclude<FlowTier, 'none'>, string>> = {
  up: { low: 'bg-emerald-500/10 text-emerald-400', mid: 'bg-emerald-500/25 text-emerald-400', high: 'bg-emerald-500/45 text-white font-bold' },
  down: { low: 'bg-red-500/10 text-red-400', mid: 'bg-red-500/25 text-red-400', high: 'bg-red-500/45 text-white font-bold' },
};
const cellClass = (v: number | null, scale: number) => {
  const t = flowTier(v, scale);
  return t === 'none' ? 'text-zinc-500' : TINT[v! > 0 ? 'up' : 'down'][t];
};

/** Hovered slot cell: its row and its slot column are highlighted across the board (both sides). */
type Hover = { row: string; slot: number } | null;
interface HoverProps { rowKey: string; hover: Hover; onHover: (h: Hover) => void }

/** One side's slot cells: OI change per completed slot (frozen) plus the running slot so far (ringed, italic). The
 *  background tint grows with the move's size against the board's scale; moves under 10 % of it are grey. */
function FlowCells({ side, flow, fs, unit, scale, rowKey, hover, onHover, note }: {
  side: 'put' | 'call'; flow: SideFlow | null; fs: FlowSlots; unit: string; scale: number;
  /** Why an unknown cell is unknown, when the caller knows better than "no reading" (the totals' partial slots). */
  note?: (i: number) => string | null;
} & HoverProps) {
  return (
    // Leaving the cell block clears the crosshair (a bar, the strike or the B / S buttons must not keep it lit).
    <span className="grid grid-cols-11 gap-px text-[11px]" onMouseLeave={() => onHover(null)}>
      {slotOrder(fs, side).map(i => {
        const v = flow?.cells[i] ?? null;
        const s = slotInfo(fs, i);
        const col = hover?.slot === i;
        return (
          <span key={i} data-slot={i} onMouseEnter={() => onHover({ row: rowKey, slot: i })}
            className={`rounded-sm text-center ${s.running ? 'italic' : ''} ${col ? 'ring-1 ring-inset ring-zinc-300' : s.running ? 'ring-1 ring-inset ring-zinc-500' : ''} ${cellClass(v, scale)}`}
            title={`${s.span}: ${v === null ? (note?.(i) ?? (s.ok ? 'unknown' : 'no OI reading at a slot edge')) : `${fmtOi(v)} ${unit}`}`}>
            {fmtOiShort(v)}
          </span>
        );
      })}
    </span>
  );
}

/** ▲n / ▼n: n completed slots in a row adding / cutting, each a tinted (not grey) move (only runs of 3+). Amber when the
 *  run goes against today's net change (built all day, now unwinding, or the reverse): a possible turn. */
function StreakBadge({ flow, fs, scale, unit }: { flow: SideFlow | null; fs: FlowSlots; scale: number; unit: string }) {
  const n = fs.bounds.length - 1;
  const st = flow ? flowStreak(flow.cells, n, scale) : null;
  if (!st) return null;
  const from = fs.bounds[n - st.n], to = fs.bounds[n];
  const against = streakVsDay(st, flow?.day ?? null) === 'against';
  return (
    <span className={`text-[10px] font-bold ${against ? 'text-amber-400' : st.dir > 0 ? 'text-emerald-400' : 'text-red-400'}`}
      title={`${st.n} completed slots in a row ${st.dir > 0 ? 'adding' : 'cutting'} OI (${from}–${to})`
        + (against ? ` — against today's net ${fmtOi(flow!.day)} ${unit}: reversing` : '')}>
      {st.dir > 0 ? '▲' : '▼'}{st.n}
    </span>
  );
}

/** Column labels over the slot cells: each slot's end time (the running one with "…"), in the cells' order. */
function FlowHeader({ side, fs, hoverSlot }: { side: 'put' | 'call'; fs: FlowSlots; hoverSlot: number | null }) {
  return (
    <span className="grid grid-cols-11 gap-px">
      {slotOrder(fs, side).map(i => {
        const s = slotInfo(fs, i);
        return (
          <span key={i} data-slot={i}
            className={`rounded-sm text-center ${s.running ? 'italic text-zinc-300' : ''} ${hoverSlot === i ? 'ring-1 ring-inset ring-zinc-300 text-zinc-100' : ''}`}
            title={s.span}>{s.head}</span>
        );
      })}
    </span>
  );
}

/** Board totals (flow tab): per slot the sum over the strikes on the board, puts and calls, on their OWN tint scale (sums
 *  are far larger than single strikes), with Σ today's change and the streak badge. Lines up with the strike rows. */
function TotalsRow({ put, call, fs, unit, scale, trade, hover, onHover }: {
  put: SumFlow; call: SumFlow; fs: FlowSlots; unit: string; scale: number; trade: boolean;
  hover: Hover; onHover: (h: Hover) => void;
}) {
  const nStrikes = Math.max(put.n, call.n);
  // A slot some strikes have no reading for is left blank (a partial sum would look like a move); say why.
  const partial = (f: SumFlow) => (i: number) =>
    f.counts[i] > 0 && f.counts[i] < f.n ? `only ${f.counts[i]} of ${f.n} strikes have a reading here — no partial sum` : null;
  const num = (f: SumFlow, side: 'put' | 'call') => (
    <span className={`whitespace-nowrap font-bold ${side === 'put' ? 'pr-2 text-right text-emerald-400' : 'pl-2 text-red-400'}`}
      title={`Σ today's OI change vs the previous close over the ${f.n} strikes with data on the board, as of ${fs.dayAt ?? '–'}: ${
        f.day != null ? `${fmtOi(f.day)} ${unit}` : f.dayCount > 0 ? `unknown (only ${f.dayCount} of ${f.n} strikes have it)` : 'unknown'}`}>
      {side === 'put' && <><StreakBadge flow={f} fs={fs} scale={scale} unit={unit} />{' '}</>}
      {fmtOi(f.day)}
      {side === 'call' && <>{' '}<StreakBadge flow={f} fs={fs} scale={scale} unit={unit} /></>}
    </span>
  );
  return (
    <div className={`${gridFor('flow', trade)} h-[21px] text-[13px] tabular-nums ${hover?.row === 'sum' ? 'bg-zinc-800/50' : ''}`}>
      <FlowCells side="put" flow={put} fs={fs} unit={unit} scale={scale} rowKey="sum" hover={hover} onHover={onHover} note={partial(put)} />
      <span />
      {num(put, 'put')}
      {trade && <span />}
      <span className="text-center text-[11.5px] font-bold text-zinc-300"
        title={`Sum over the ${nStrikes} strikes with data on the board (not the whole chain); its tints use their own scale`}>Σ shown</span>
      {trade && <span />}
      {num(call, 'call')}
      <span />
      <FlowCells side="call" flow={call} fs={fs} unit={unit} scale={scale} rowKey="sum" hover={hover} onHover={onHover} note={partial(call)} />
    </div>
  );
}

function BoardRowView({ row, max, boxed, trade, mode, fs, unit, scale, hover, onHover }: {
  row: FreshMoneyRow; max: number; boxed: boolean; trade: RowTrade | null; mode: OiMode;
  /** Slot layout, the OI unit and the board-wide cell scale (see flowScale), for the slot-flow tab. */
  fs: FlowSlots; unit: string; scale: number;
  hover: Hover; onHover: (h: Hover) => void;
}) {
  const rowKey = String(row.strike);
  const shown = (sd: FreshMoneyRow['put']) => (sd ? (mode === 'total' ? sd.oi : mode === 'flow' ? sd.flow?.day ?? null : sd.oiMoved) : null);
  const label = (sd: FreshMoneyRow['put']) => (sd
    ? (mode === 'total' ? fmtOiAbs(sd.oi) : mode === 'flow' ? fmtOi(sd.flow?.day ?? null) : fmtOi(sd.oiMoved)) : '–');
  // In flow mode the bar is today's OI change as of the latest completed slot (it grows by each completed slot's cell).
  const moved = (sd: FreshMoneyRow['put']) => (mode === 'flow' ? sd?.flow?.day ?? null : sd?.oiMoved ?? null);
  const flowTitle = (sd: FreshMoneyRow['put']) => {
    if (mode !== 'flow') return undefined;
    const v = (n: number | null | undefined) => (n == null ? 'unknown' : `${fmtOi(n)} ${unit}`);
    const late = fs.dayAt && fs.dayAt !== fs.bounds[fs.bounds.length - 1] ? ' (latest slot edge had no reading)' : '';
    return `Today's OI change vs the previous close, as of ${fs.dayAt ?? 'no slot edge with a reading'}${late}: ${v(sd?.flow?.day)}`
      + ` · live (${fs.lastTs || 'now'}): ${v(sd?.oiMoved)}`;
  };
  const p = row.put, c = row.call;
  const cell = (side: 'put' | 'call') => {
    if (!trade) return null;
    const opt: OptType = side === 'put' ? 'PE' : 'CE';
    const has = side === 'put' ? !!p : !!c;
    return (
      <TradeCell
        side={side} opt={opt} strike={row.strike} pos={side === 'put' ? trade.put : trade.call}
        showButtons={trade.showButtons && has} canOrder={trade.canOrder} canClose={trade.canClose} armed={trade.armed}
        ltpSource={(() => { const p = side === 'put' ? trade.put : trade.call; return p ? trade.ltpSource[p.priceId] : undefined; })()} busy={trade.busy(opt)}
        exit={(() => { const p = side === 'put' ? trade.put : trade.call; return p ? trade.exits[p.key] : undefined; })()}
        onBuy={() => trade.order(opt, 'BUY')} onSell={() => trade.order(opt, 'SELL')}
        onClose={() => { const pos = side === 'put' ? trade.put : trade.call; if (pos) trade.close(pos); }}
        onSetExit={trade.setExit}
      />
    );
  };
  const delta = mode === 'delta' ? oiDelta(row) : null;
  return (
    <div className={`${gridFor(mode, !!trade)} ${trade ? 'h-[26px]' : 'h-[21px]'} text-[13px] tabular-nums ${mode === 'flow' && hover?.row === rowKey ? 'bg-zinc-800/50' : ''}`}>
      {mode === 'flow' && <FlowCells side="put" flow={p?.flow ?? null} fs={fs} unit={unit} scale={scale} rowKey={rowKey} hover={hover} onHover={onHover} />}
      {mode === 'delta' ? (
        <>
          <DeltaBar delta={delta} max={max} />
          <span className={`pr-2 text-right font-bold ${delta === null || delta === 0 ? 'text-zinc-300' : delta > 0 ? 'text-red-400' : 'text-emerald-400'}`}
            title={delta === null ? undefined : `Call OI ${fmtOiAbs(c?.oi ?? null)} − Put OI ${fmtOiAbs(p?.oi ?? null)}`}>
            {fmtOi(delta)}
          </span>
        </>
      ) : (
        <>
          <Bar side="put" length={shown(p)} moved={moved(p)} max={max} tag={mode === 'flow' ? null : p?.buildup ?? null} />
          <span className="whitespace-nowrap pr-2 text-right font-bold text-emerald-400" title={flowTitle(p)}>
            {mode === 'flow' && <><StreakBadge flow={p?.flow ?? null} fs={fs} scale={scale} unit={unit} />{' '}</>}{label(p)}
          </span>
        </>
      )}
      {cell('put')}
      <span className="flex justify-center">
        <span className={`px-2 leading-[18px] ${boxed ? 'border border-sky-400 text-zinc-100' : 'border border-transparent text-zinc-300'}`}>
          {row.strike}
        </span>
      </span>
      {cell('call')}
      {mode === 'delta' ? (
        // Δ OI tab: the right panel is left empty (the difference is on the left).
        <><span /><span /></>
      ) : (
        <>
          <span className="whitespace-nowrap pl-2 font-bold text-red-400" title={flowTitle(c)}>
            {label(c)}{mode === 'flow' && <>{' '}<StreakBadge flow={c?.flow ?? null} fs={fs} scale={scale} unit={unit} /></>}
          </span>
          <Bar side="call" length={shown(c)} moved={moved(c)} max={max} tag={mode === 'flow' ? null : c?.buildup ?? null} />
        </>
      )}
      {mode === 'flow' && <FlowCells side="call" flow={c?.flow ?? null} fs={fs} unit={unit} scale={scale} rowKey={rowKey} hover={hover} onHover={onHover} />}
    </div>
  );
}

const inr = (v: number, d = 2) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** The chosen underlying's latest price and change vs the previous close (WebSocket; "–" when the previous close is
 *  not known — never a flipped close shown as 0.00%). Without a live price, the board snapshot's spot, marked as such. */
function PriceChip({ underlying, q, fallback }: { underlying: string; q: FreshMoneyLive | null; fallback: number | null }) {
  const price = q?.spot ?? fallback;
  if (price === null) return null;
  const live = !!q?.spot;
  const up = (q?.change ?? 0) > 0, down = (q?.change ?? 0) < 0;
  const tone = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-zinc-300';
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1"
      title={live ? `Live from the Dhan WebSocket${q?.prevClose ? ` · previous close ${inr(q.prevClose)}` : ''}` : 'Last board snapshot (no live price yet)'}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{q?.label ?? underlying}</span>
      {live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />}
      <span className="text-[14px] font-bold tabular-nums text-white">{inr(price)}</span>
      {live && q?.change != null && q.changePct != null ? (
        <span className={`text-[12px] font-bold tabular-nums ${tone}`}>
          {up ? '+' : down ? '−' : ''}{inr(Math.abs(q.change))} ({up ? '+' : down ? '−' : ''}{Math.abs(q.changePct).toFixed(2)}%)
        </span>
      ) : (
        <span className="text-[11px] text-zinc-500">{live ? 'chg –' : 'snapshot'}</span>
      )}
    </div>
  );
}

/** The strike ladder (all tabs). It owns the slot tab's hover crosshair, so moving the mouse across the cells re-renders
 *  only the ladder, not the trade bar, positions panel or the Cumulative OI chart. */
function Ladder({ data, oiMode, tradeMode, fs, maxAbs, boxedStrike, rowTrade, spot, liveSpot, totals, scale }: {
  data: FreshMoneyResponse; oiMode: OiMode; tradeMode: boolean; fs: FlowSlots; maxAbs: number; boxedStrike: number | null;
  rowTrade: (strike: number) => RowTrade | null; spot: number | null; liveSpot: number | null;
  totals: { put: SumFlow; call: SumFlow; scale: number }; scale: number;
}) {
  const [hover, setHover] = useState<Hover>(null);
  const flowTotals = totals, flowCellScale = scale;
  return (
    <>
    {/* Flow tab: the ladder scrolls inside its own box (both ways), so the slot times and totals can stay pinned
        (an overflow-x box is a scroll container, so `sticky` could never pin against the window). */}
    <div className={oiMode === 'flow' ? 'max-h-[calc(100vh-170px)] overflow-auto px-4 pb-2' : 'overflow-x-auto px-4 pb-2 pt-2'}
      onMouseLeave={() => setHover(null)}>
     <div className={oiMode === 'flow' ? (tradeMode ? 'min-w-[1916px]' : 'min-w-[1596px]') : tradeMode ? 'min-w-[1040px]' : 'min-w-[720px]'}>
      <div data-testid="flow-sticky-head" className={oiMode === 'flow' ? 'sticky top-0 z-10 border-b border-zinc-700 bg-zinc-900 pt-2' : ''}>
      <div className={`${gridFor(oiMode, tradeMode)} h-5 whitespace-nowrap text-[11.5px] text-zinc-400`}>
        {oiMode === 'flow' && <FlowHeader side="put" fs={fs} hoverSlot={hover?.slot ?? null} />}
        <span className="col-span-2 pr-2 text-right">{oiMode === 'delta' ? 'Δ OI: calls − puts (total)' : `PUTS: ${oiMode === 'total' ? 'total OI' : oiMode === 'flow' ? `OI Δ today @ ${fs.dayAt ?? '–'}` : 'OI moved'}`}</span>
        {tradeMode && <span className="pr-1 text-right text-zinc-400">PE trade</span>}
        <span className="text-center">STRIKE</span>
        {tradeMode && <span className="pl-1 text-zinc-400">CE trade</span>}
        <span className="col-span-2 pl-2">{oiMode === 'delta' ? '' : `CALLS: ${oiMode === 'total' ? 'total OI' : oiMode === 'flow' ? `OI Δ today @ ${fs.dayAt ?? '–'}` : 'OI moved'}`}</span>
        {oiMode === 'flow' && <FlowHeader side="call" fs={fs} hoverSlot={hover?.slot ?? null} />}
      </div>
      {oiMode === 'flow' && fs.bounds.length > 0 && (
        <TotalsRow put={flowTotals.put} call={flowTotals.call} fs={fs} unit={data.oiUnit} scale={flowTotals.scale}
          trade={tradeMode} hover={hover} onHover={setHover} />
      )}
      </div>
      {data.rows.map((r, i) => {
        const next = data.rows[i + 1];
        const divider = spot !== null && next && r.strike > spot && next.strike <= spot;
        return (
          <React.Fragment key={r.strike}>
            <BoardRowView row={r} max={maxAbs} boxed={r.strike === boxedStrike} trade={rowTrade(r.strike)} mode={oiMode}
              fs={fs} unit={data.oiUnit} scale={flowCellScale} hover={hover} onHover={setHover} />
            {divider && <SpotDivider spot={spot!} live={liveSpot !== null} />}
          </React.Fragment>
        );
      })}
     </div>
    </div>
    </>
  );
}

function SpotDivider({ spot, live }: { spot: number; live: boolean }) {
  return (
    <div className="relative flex h-[21px] items-center" aria-label={`Spot ${spot.toFixed(2)}${live ? ' (live)' : ' (last snapshot)'}`}>
      <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-amber-400/70" />
      <span
        className="relative mx-auto flex items-center gap-1 bg-zinc-900 px-1.5 text-[13px] font-bold tabular-nums text-amber-300"
        title={live ? 'Live price from the Dhan WebSocket' : 'Price from the last board snapshot (no live WebSocket price yet)'}
      >
        {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />}
        {spot.toFixed(2)}
      </span>
    </div>
  );
}

export default function FreshMoneyBoard() {
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [data, setData] = useState<FreshMoneyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // REAL-money arm: per page load, never persisted, dropped on an underlying switch.
  const [armed, setArmed] = useState(false);
  // Account for NEW orders (remembered per browser). An open position keeps the broker it was opened on.
  const [broker, setBrokerRaw, brokerReady] = usePageBroker<FmBroker>('freshMoney.broker', FM_BROKERS);
  // Switching account disarms: an armed page must never quietly start sending to a different account.
  const setBroker = useCallback((b: FmBroker) => { setArmed(false); setBrokerRaw(b); }, [setBrokerRaw]);
  const [lots, setLots] = useState(1);
  // Target / stop-loss stamped onto each new position (remembered per browser, like Lots).
  const [exitDefaults, setExitDefaults] = useState<ExitDefaultsUi>(NO_EXITS);
  const pickExitDefaults = (d: ExitDefaultsUi) => { setExitDefaults(d); writePref(PREF_EXIT_DEFAULTS, JSON.stringify(d)); };
  // Collapsed panels (remembered per browser).
  const [posCollapsed, setPosCollapsed] = useState(false);
  // Slot tab: the "How to read" panel (remembered per browser). The hover crosshair lives in <Ladder>.
  const [flowHelp, setFlowHelp] = useState(false);
  const toggleFlowHelp = () => setFlowHelp(o => { writePref(PREF_FLOW_HELP, o ? '0' : '1'); return !o; });
  // What the board's numbers and bar lengths show: today's OI change (default) or total OI outstanding.
  const [oiMode, setOiMode] = useState<OiMode>('change');
  const pickOiMode = (m: OiMode) => { setOiMode(m); writePref(PREF_OI_MODE, m); };
  const togglePos = () => setPosCollapsed(c => { writePref(PREF_POS_COLLAPSED, c ? '0' : '1'); return !c; });
  // Sounds (dhan-alert-sound): unlocked by the first click / key on the page; poll-driven ones ring only in the leader
  // tab so two open tabs never double-ring; always in addition to a toast; own mute setting.
  const [soundOn, setSoundOn] = useState(true);
  const soundRef = useRef(true);
  useEffect(() => { soundRef.current = soundOn; }, [soundOn]);
  const toggleSound = () => setSoundOn(o => { writePref(PREF_SOUND, o ? '0' : '1'); return !o; });
  const play = useCallback((k: ChimeKind | 'alert') => {
    if (!soundRef.current) return;
    if (k === 'entry') playEntryChime();
    else if (k === 'exit') playExitChime();
    else if (k === 'warn') playWarnChime();
    else playAlertChime();
  }, []);
  useEffect(() => installAlertSoundUnlock(), []);
  const { leaderRef } = useTabLeader('fresh-money');
  // An order or close this tab sent came back rejected / UNKNOWN / partly sent: warn right here (its toast is here too).
  const onOrderWarn = useCallback(() => play('warn'), [play]);
  const trades = useFreshMoneyTrades(onOrderWarn);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  // Restore preferences after mount (SSR renders the defaults).
  useEffect(() => {
    const u = readPref(PREF_UNDERLYING);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    if (u && (UNDERLYINGS as readonly string[]).includes(u)) setUnderlying(u as Underlying);
    const l = Number(readPref(PREF_LOTS));
    if (Number.isInteger(l) && l >= 1 && l <= 20) setLots(l);
    setPosCollapsed(readPref(PREF_POS_COLLAPSED) === '1');
    setFlowHelp(readPref(PREF_FLOW_HELP) === '1');
    setSoundOn(readPref(PREF_SOUND) !== '0');
    const om = readPref(PREF_OI_MODE);
    if (om === 'total' || om === 'delta' || om === 'flow') setOiMode(om);
    try {
      const d = JSON.parse(readPref(PREF_EXIT_DEFAULTS) ?? 'null') as { target?: unknown; sl?: unknown } | null;
      if (d) setExitDefaults({ target: specOrNull(d.target), sl: specOrNull(d.sl) });
    } catch { /* a bad saved value = no defaults */ }
  }, []);

  const load = useCallback(async (u: Underlying, signal?: AbortSignal) => {
    const my = ++seq.current;
    try {
      const res = await fetch(`/api/fresh-money?underlying=${u}`, { cache: 'no-store', signal });
      const body = await res.json();
      if (my !== seq.current) return; // a newer request (or underlying switch) superseded this one
      if (!res.ok || body.error) { setError(body.error ?? `HTTP ${res.status}`); setData(null); }
      else { setData(body as FreshMoneyResponse); setError(null); }
    } catch (e) {
      if (my !== seq.current || (e as Error).name === 'AbortError') return;
      setError(String((e as Error).message ?? e));
    } finally {
      if (my === seq.current) { setLoading(false); setNow(Date.now()); }
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its fetch resolves
    load(underlying, ac.signal);
    const id = setInterval(() => { if (!document.hidden) load(underlying, ac.signal); }, POLL_MS);
    return () => { ac.abort(); clearInterval(id); };
  }, [underlying, load]);

  const pickUnderlying = (u: Underlying) => {
    if (u === underlying) return;
    setLoading(true);
    setData(null);
    setError(null);
    setArmed(false);
    setUnderlying(u);
    writePref(PREF_UNDERLYING, u);
  };

  // Slot-flow layout; empty from a server that predates the slot tab.
  const fs = data?.flowSlots ?? NO_SLOTS;
  const nSlots = Math.max(0, fs.bounds.length - 1);
  // One tint scale for every slot cell on the board (puts and calls), so sizes compare across strikes.
  // Board totals per slot (puts / calls) and their own tint scale: sums dwarf single strikes.
  const flowTotals = useMemo(() => {
    const len = fs.bounds.length;
    const put = sumFlows((data?.rows ?? []).map(r => r.put?.flow ?? null), len);
    const call = sumFlows((data?.rows ?? []).map(r => r.call?.flow ?? null), len);
    return { put, call, scale: flowScale([...put.cells, ...call.cells]) };
  }, [data, fs.bounds.length]);

  // Board-wide streak alert: the Σ totals row starts (or turns into) a run of 3+ slots on puts or calls. Live board only,
  // leader tab only; the first reply after a load / underlying or day switch only records (no chime for history).
  const prevStreakRef = useRef<{ key: string; put: { dir: 1 | -1 } | null; call: { dir: 1 | -1 } | null } | null>(null);
  useEffect(() => {
    if (!data?.isToday || fs.bounds.length < 2) return;
    const n = fs.bounds.length - 1;
    const put = flowStreak(flowTotals.put.cells, n, flowTotals.scale);
    const call = flowStreak(flowTotals.call.cells, n, flowTotals.scale);
    const key = `${data.underlying}|${data.date}`;
    const prev = prevStreakRef.current;
    prevStreakRef.current = { key, put, call };
    if (!prev || prev.key !== key || !leaderRef.current) return;
    for (const [side, cur, was] of [['puts', put, prev.put], ['calls', call, prev.call]] as const) {
      if (!cur || !streakStart(was, cur)) continue;
      toast.info(`Σ ${side} ${cur.dir > 0 ? '▲' : '▼'}${cur.n} — ${data.underlying}`, {
        description: `The board ${cur.dir > 0 ? 'added' : 'cut'} ${side === 'puts' ? 'put' : 'call'} OI ${cur.n} slots in a row (${fs.bounds[n - cur.n]}–${fs.bounds[n]})`,
        duration: 10_000,
      });
      play('alert');
    }
  }, [flowTotals, data, fs.bounds, leaderRef, play]);
  const flowCellScale = useMemo(
    () => flowScale((data?.rows ?? []).flatMap(r => [...(r.put?.flow?.cells ?? []), ...(r.call?.flow?.cells ?? [])])),
    [data],
  );

  const maxAbs = useMemo(() => {
    let mx = 0;
    if (oiMode === 'delta') {
      for (const r of data?.rows ?? []) mx = Math.max(mx, Math.abs(oiDelta(r) ?? 0));
      return mx;
    }
    const v = (sd: FreshMoneyRow['put']) => Math.abs((oiMode === 'total' ? sd?.oi : oiMode === 'flow' ? sd?.flow?.day : sd?.oiMoved) ?? 0);
    for (const r of data?.rows ?? []) mx = Math.max(mx, v(r.put), v(r.call));
    return mx;
  }, [data, oiMode]);

  // Live spot from the WebSocket (today's board only: a live price over an old session's OI would mislead). Falls back
  // to the board snapshot's spot when there is no fresh WebSocket price.
  // Polled whenever a board is shown (the header price); the board itself uses it only on today's board.
  const [live, setLive] = useState<{ key: string; q: FreshMoneyLive } | null>(null);
  const liveKey = data ? `${underlying}|${data.expiry}` : null;
  useEffect(() => {
    if (!liveKey) return;
    const [u, expiry] = liveKey.split('|');
    let alive = true;
    let my = 0;
    const tick = async () => {
      if (document.hidden) return;
      const n = ++my;
      try {
        const r = await fetch(`/api/fresh-money/live?underlying=${u}&expiry=${expiry}`, { cache: 'no-store' });
        const j = (await r.json()) as FreshMoneyLive;
        if (!alive || n !== my) return;
        setLive({ key: liveKey, q: j });
      } catch { /* keep the last value; the next tick retries */ }
    };
    tick();
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [liveKey]);
  const liveQ = live && live.key === liveKey ? live.q : null;
  const liveSpot = data?.isToday && liveQ?.spot && liveQ.spot > 0 ? liveQ.spot : null;
  const spot = liveSpot ?? data?.spot ?? null;

  const boxedStrike = useMemo(() => {
    if (!spot || !data?.rows.length) return null;
    let best = data.rows[0].strike;
    for (const r of data.rows) if (Math.abs(r.strike - spot) < Math.abs(best - spot)) best = r.strike;
    return best;
  }, [data, spot]);

  const staleMin = data?.isToday ? Math.floor((now - istEpoch(data.lastTs)) / 60_000) : 0;
  const nowIstMin = (() => {
    const d = new Date(now + 5.5 * 3600_000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  })();
  const day = data?.day ?? NSE_DAY;
  const isMcx = MCX_UNDERLYINGS.has(underlying);
  const collectorName = isMcx ? `${underlying} OI collector` : 'IV snapshot collector';
  const isStale = !!data?.isToday && staleMin >= 3 && nowIstMin >= day.from && nowIstMin <= day.to;

  // ── trading ──
  const ts = trades.state;
  // Trade sounds + toasts for what changed since the last trade-state poll (entry / exit / warn; server-fired target,
  // stop-loss and total exits get a toast here, which they had none of). The first poll only records.
  const prevTradeRef = useRef<TradeSnapshot | null>(null);
  useEffect(() => {
    if (!ts) return;
    const cur: TradeSnapshot = { positions: ts.positions, exits: ts.exits ?? {}, global: ts.global ?? null };
    const ev = tradeEvents(prevTradeRef.current, cur);
    prevTradeRef.current = cur;
    if (!leaderRef.current) return;
    for (const t of ev.toasts) {
      if (t.kind === 'error') toast.error(t.title, { description: t.detail, duration: 20_000 });
      else toast.success(t.title, { description: t.detail, duration: 8_000 });
    }
    if (ev.sound) play(ev.sound);
  }, [ts, leaderRef, play]);
  const tradable = !!ts?.tradable.includes(underlying);
  const tradeExpiry = ts?.boardExpiry[underlying] ?? null;
  // Orders only from a live board: today's snapshot, and the expiry the server will trade.
  const session = ts?.sessions[underlying]?.gate ?? 'closed';
  const blocked = !data ? null
    : ts && !ts.brokers[broker] ? `${brokerLabel(broker)} is not logged in — log in from Autologin, then refresh`
    : session !== 'open' ? (ts?.sessions[underlying]?.note ?? null)
    : !data.isToday ? `Trading opens when today's board is live (the ${collectorName} has not written today)`
      : isStale ? 'Board snapshot is stale — orders paused until the collector writes again'
        : tradeExpiry !== data.expiry ? "The board's expiry is changing — wait for the next refresh"
          : null;
  // This underlying's positions on every expiry: they all count in the bar's P&L.
  // The bar and the board show the selected broker; positions on other brokers are listed under the bar.
  const underlyingPositions = useMemo(
    () => (ts?.positions ?? []).filter(p => p.underlying === underlying && p.broker === broker), [ts, underlying, broker]);
  // On the board: the board's expiry AND a strike the board has a row for. Everything else that is still open is listed
  // under the bar (with its own ×) — a position must never become invisible because spot moved or the expiry rolled.
  const boardStrikes = useMemo(() => new Set((data?.rows ?? []).map(r => r.strike)), [data]);
  const myPositions = useMemo(
    () => underlyingPositions.filter(p => !!data && p.expiry === data.expiry && boardStrikes.has(p.strike)),
    [underlyingPositions, data, boardStrikes],
  );
  const offBoard = useMemo(() => {
    const on = new Set(myPositions.map(p => p.key));
    return (ts?.positions ?? []).filter(p => p.netQty !== 0 && !on.has(p.key));
  }, [ts, myPositions]);
  const posByKey = useMemo(() => new Map(myPositions.map(p => [`${p.strike}:${p.opt}`, p] as const)), [myPositions]);
  const tradeMode = armed || myPositions.length > 0;
  const { order: sendOrder, close: sendClose, setExit, inflight } = trades;
  const rowTrade = useCallback((strike: number): RowTrade | null => {
    if (!tradeMode || !data) return null;
    return {
      put: posByKey.get(`${strike}:PE`),
      call: posByKey.get(`${strike}:CE`),
      showButtons: armed && tradable,
      canOrder: armed && tradable && !blocked,
      canClose: armed && session !== 'closed',
      ltpSource: ts?.ltpSource ?? {},
      exits: ts?.exits ?? {},
      armed,
      busy: opt => inflight.has(lockKey(broker, underlying, strike, opt)),
      order: (opt, side) => sendOrder({ broker, underlying, expiry: data.expiry, strike, opt, side, lots, exitDefaults }),
      close: p => sendClose(p),
      setExit,
    };
  }, [tradeMode, data, posByKey, armed, tradable, blocked, session, inflight, underlying, broker, sendOrder, sendClose, setExit, lots, ts, exitDefaults]);
  const setLotsPref = (n: number) => { setLots(n); writePref(PREF_LOTS, String(n)); };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10">
            <BadgeIndianRupee className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400">Options · {underlying}</p>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">Fresh Money Board</h1>
            <p className="mt-1 text-[10px] font-medium text-zinc-500">
              Open interest by strike: today&apos;s change, total outstanding, and call − put difference
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Underlying" className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
            {UNDERLYINGS.map(u => (
              <button key={u} role="tab" aria-selected={u === underlying} onClick={() => pickUnderlying(u)}
                className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  u === underlying ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                {u}
              </button>
            ))}
          </div>
          <PriceChip underlying={underlying} q={liveQ} fallback={data?.spot ?? null} />
          {MCX_UNDERLYINGS.has(underlying) && <CollectorControl key={underlying} underlying={underlying} />}
          {data && (
            <span className="text-[10px] font-mono text-zinc-400">
              {data.lastTs.slice(11)} · exp {data.expiry} · OI in {data.oiUnit}
            </span>
          )}
          <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300">
            DATA: {data?.date ?? '—'}{data && !data.isToday ? ' · last session' : ''}
          </span>
          {ts && (
            <ExitAllButton count={ts.positions.filter(p => p.netQty !== 0).length} busy={trades.exitingAll} onExit={trades.exitAll} />
          )}
          <span className="h-5 w-px shrink-0 bg-zinc-800" />
          <NavBar />
        </div>
      </div>

      {/* The flow tab adds an 11-cell block on each side (board min-width 1916 / 1596 px + paddings), so the page widens
          with it instead of making the call cells scroll off to the right. */}
      <div className={`mx-auto flex w-full ${oiMode === 'flow'
        ? (tradeMode ? 'max-w-[2040px]' : 'max-w-[1720px]')
        : (tradeMode ? 'max-w-[1320px]' : 'max-w-[1100px]')} flex-1 flex-col gap-3 px-6 py-5`}>
        {isStale && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            The {collectorName} has not written for {staleMin} min. The board shows its last snapshot.
          </div>
        )}
        {data && !data.isToday && (
          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            No snapshot for today yet; showing {data.date}.{' '}
            {isMcx ? `Start the ${collectorName} (top right) during MCX hours.` : 'The IV snapshot collector starts with the dashboard in market hours.'}
          </div>
        )}

        {error && !data && !loading && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-3 text-sm text-red-300">{error}</div>
        )}

        {loading && !data && (
          <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="h-5 w-80 animate-pulse rounded bg-zinc-800" />
            <div className="mb-3 h-3 w-[32rem] max-w-full animate-pulse rounded bg-zinc-800" />
            {Array.from({ length: 16 }, (_, i) => <div key={i} className="h-[17px] animate-pulse rounded bg-zinc-800/60" />)}
          </div>
        )}

        {data && (
          <div className={`overflow-hidden rounded-lg border bg-zinc-900 ${armed ? 'border-red-500/50' : 'border-zinc-800'}`}>
            {ts && (
              <TradeBar
                underlying={underlying} armed={armed} onArm={setArmed} lots={lots} onLots={setLotsPref}
                maxLots={ts.maxLots} lotSize={data.lot} mcxMult={data.mult} tradable={tradable} blocked={blocked} positions={underlyingPositions}
                broker={broker} onBroker={setBroker} brokerReady={brokerReady} brokerSessions={ts.brokers ?? null}
                exitDefaults={exitDefaults} onExitDefaults={pickExitDefaults}
                exitWatcher={ts.exitWatcher ?? null} hasExits={Object.keys(ts.exits ?? {}).length > 0}
                globalExit={ts.global ?? null} allPositions={ts.positions} onSetGlobal={trades.setGlobal}
              />
            )}
            {ts && offBoard.length > 0 && (
              <OffBoardPositions
                positions={offBoard} armed={armed} inflight={inflight}
                canClose={p => (ts.sessions[p.underlying]?.gate ?? 'closed') !== 'closed' && !!ts.brokers?.[p.broker]} onClose={sendClose}
              />
            )}
            <div className="px-4 pt-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button type="button" onClick={toggleSound} aria-pressed={!soundOn}
                aria-label={soundOn ? 'Mute Fresh Money sounds' : 'Unmute Fresh Money sounds'}
                title={soundOn ? 'Sounds on (trades, board-wide streaks) — click to mute. They play after your first click on the page.' : 'Sounds muted — toasts still show'}
                className={`ml-auto flex h-6 w-6 items-center justify-center rounded border border-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 ${soundOn ? 'text-zinc-300' : 'text-zinc-500'}`}>
                {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              </button>
              <div role="tablist" aria-label="Bars and numbers show" className="flex rounded-md border border-zinc-800 bg-zinc-950/40 p-0.5">
                {([['change', 'OI change'], ['total', 'Total OI'], ['delta', 'Δ OI'], ['flow', `${fs.slotMin}m slots`]] as const).map(([m, name]) => (
                  <button key={m} type="button" role="tab" aria-selected={oiMode === m} onClick={() => pickOiMode(m)}
                    title={m === 'change' ? "Today's change in open interest vs the previous close"
                      : m === 'total' ? 'Open interest outstanding now'
                      : m === 'delta' ? 'Call OI − Put OI (total OI outstanding) at each strike'
                      : `OI added or cut in fixed ${fs.slotMin}-minute slots counted from the session open: the last ${nSlots} completed slots (frozen) and the running one`}
                    className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                      oiMode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                    {name}
                  </button>
                ))}
              </div>
              </div>
              <div className="mt-0.5 text-[11.5px] text-zinc-400">
                {oiMode === 'flow' ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {/* One-line legend; the full explanation is behind "?". */}
                    {([['none', 'noise <10 %'], ['low', 'small'], ['mid', 'medium'], ['high', 'big ≥70 %']] as const).map(([t, name]) => (
                      <span key={t} className="flex items-center gap-1">
                        {t === 'none'
                          ? <span className="rounded-sm px-1 text-[10px] text-zinc-500">+9</span>
                          : <><span className={`rounded-sm px-1 text-[10px] ${TINT.up[t]}`}>+2k</span><span className={`rounded-sm px-1 text-[10px] ${TINT.down[t]}`}>-2k</span></>}
                        <span>{name}</span>
                      </span>
                    ))}
                    <span><span className="font-bold text-emerald-400">▲n</span> / <span className="font-bold text-red-400">▼n</span> n slots in a row</span>
                    <span><span className="font-bold text-amber-400">▼n</span> against today&apos;s net</span>
                    <span className="flex items-center gap-1"><span className="rounded-sm px-1 text-[10px] italic ring-1 ring-inset ring-zinc-500">+1k</span> live slot</span>
                    <span>number = OI Δ today @ {fs.dayAt ?? '–'}</span>
                    <button type="button" onClick={toggleFlowHelp} aria-label="How to read the slots" aria-expanded={flowHelp}
                      title="How to read the slots"
                      className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70">
                      <CircleHelp className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : oiMode === 'delta' ? (
                  <>Bar = Call OI − Put OI (total OI, in {data.oiUnit}) · <span className="text-red-400">red = calls heavier</span> ·{' '}
                    <span className="text-emerald-400">green = puts heavier</span></>
                ) : (
                  <>{oiMode === 'total' ? 'Bar = total OI (fill still from today\'s change)' : 'Bar = OI moved'} · filled = building, outline = leaving</>
                )}
              </div>
              {oiMode === 'flow' && flowHelp && (
                <div className="mt-1 space-y-0.5 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-[11.5px] text-zinc-300">
                  <p>Each cell is the OI change ({data.oiUnit}) in one {fs.slotMin}-minute slot counted from the open ({data.market === 'MCX' ? '09:00' : '09:15'}).
                    Completed slots are frozen; the ringed, italic cell next to the strike is the current slot so far. – = no OI reading at a slot edge.</p>
                  <p>Tint = size of the move against this board&apos;s 95th-percentile move: grey under 10 %, then faint, medium, and bold white on a
                    strong tint for the biggest moves (≥ 70 %). Green = OI added, red = OI cut.</p>
                  <p>The number and bar beside the strike = today&apos;s OI change vs the previous close as of the last completed slot with a reading
                    ({fs.dayAt ?? '–'}); each slot that completes adds its cell to it. Filled bar = net added today, outline = net cut.</p>
                  <p><span className="font-bold text-emerald-400">▲n</span> / <span className="font-bold text-red-400">▼n</span> = the last n completed slots
                    all added / all cut OI (tinted moves only, runs of 3+). <span className="font-bold text-amber-400">Amber</span> = that run goes against
                    today&apos;s net (built all day, now unwinding, or the reverse): a possible turn.</p>
                  <p>Σ shown = the same for the whole board (the {Math.max(flowTotals.put.n, flowTotals.call.n)} strikes with data, not the whole chain), on its
                    own tint scale; a slot that some strikes have no reading for is left blank rather than summed short.
                    Hover a cell to highlight its strike and its slot across the board.</p>
                  <p>On a short window the ladder scrolls inside its own box, so the slot times and Σ row stay pinned at its top.</p>
                </div>
              )}
              {oiMode !== 'delta' && oiMode !== 'flow' && <div className="mt-0.5 text-[11px] text-zinc-500">
                {data.hasBuildup
                  ? <>Tags (option&apos;s own premium vs its previous close): <span className="font-bold text-zinc-300">LB</span> long buildup ·{' '}
                      <span className="font-bold text-zinc-300">SB</span> short buildup · <span className="font-bold text-zinc-300">SC</span> short covering ·{' '}
                      <span className="font-bold text-zinc-300">LU</span> long unwinding — hover a tag for its meaning</>
                  : data.isToday
                    ? 'Buildup tags (LB / SB / SC / LU) start once the collector records option previous closes — after its next restart.'
                    : 'No buildup tags for this day: option previous closes were not recorded for it.'}
              </div>}
            </div>

            <Ladder data={data} oiMode={oiMode} tradeMode={tradeMode} fs={fs} maxAbs={maxAbs} boxedStrike={boxedStrike}
              rowTrade={rowTrade} spot={spot} liveSpot={liveSpot} totals={flowTotals} scale={flowCellScale} />

            {/* Cumulative OI over the day (ATM ± strikes), the same widget the Scalp Cockpit uses. It fills its parent's height. */}
            <div className="h-[340px] border-t border-zinc-800 px-4 pb-3 pt-3">
              <CumulativeOiWidget key={underlying} underlying={underlying} />
            </div>
          </div>
        )}

        {ts && (
          <PositionsOrders
            state={ts} broker={broker} armed={armed} inflight={inflight} onClose={sendClose} onSetExit={setExit}
            collapsed={posCollapsed} onToggle={togglePos}
            canClose={p => (ts.sessions[p.underlying]?.gate ?? 'closed') !== 'closed' && !!ts.brokers?.[p.broker]}
          />
        )}
      </div>
    </div>
  );
}
