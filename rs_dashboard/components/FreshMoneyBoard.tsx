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
import { BUILDUP_TEXT, oiDelta, fmtOi, fmtOiAbs, fmtOiShort, flowCarry, flowScale, scaleOiRows, pcrOf, boardPcr, fmtPcr, levelStrikes, stackParts, type LevelTag, flowStreak, flowTier, flowHeat, topBuilders, isRoundStrike, FLOW_VIEWS, streakVsDay, sumFlows, type Buildup, type FlowTier, type FlowView, type SideFlow, type SumFlow } from '@/lib/freshMoney';
import type { FmBroker, FmPosition, FmProduct, OptType, TxnSide } from '@/lib/freshMoneyTrades';
import { ExitAllButton, FM_BROKERS, OffBoardPositions, TradeBar, TradeCell, brokerLabel, lockKey, useFreshMoneyTrades, type ExitDefaultsUi } from './freshMoney/trading';
import { exitSummary, validateExitSpec, type ExitSpec, type FmExit } from '@/lib/freshMoneyExits';
import { entryActive, type FmEntry } from '@/lib/freshMoneyEntries';
import type { LevelCell } from './freshMoney/LevelEntry';
import { usePageBroker } from './BrokerPicker';
import { readPref, readPrefOf, savePref as writePref } from '@/lib/localPref';
import { openBurst } from '@/lib/freshMoneyOpen';
import { liveIdsParam, withLiveLtps } from '@/lib/freshMoneyLivePrices';
import { isRegularSession } from '@/lib/nseHolidays';
import { NSE_WINDOW } from '@/lib/freshMoneyTrades';
import { istToday, istMinuteOfDay } from '@/lib/istTime';
import CollectorControl from './freshMoney/CollectorControl';
import PositionsOrders from './freshMoney/PositionsOrders';
import type { SetExitFn } from './freshMoney/ExitInputs';
import CollapseToggle from './freshMoney/CollapseToggle';
import CumulativeOiWidget from './scalpCockpit/CumulativeOiWidget';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
const MCX_UNDERLYINGS: ReadonlySet<string> = new Set(['CRUDEOIL', 'CRUDEOILM']);
type Underlying = (typeof UNDERLYINGS)[number];
const POLL_MS = 30_000;
const PREF_UNDERLYING = 'freshMoney.underlying';
const PREF_LOTS = 'freshMoney.lots';
const PREF_PRODUCT = 'freshMoney.product';
const PREF_OI_MODE = 'freshMoney.oiMode';
const PREF_OI_UNITS = 'freshMoney.oiUnits';
const PREF_PCR = 'freshMoney.showPcr';
const PREF_PRICE = 'freshMoney.showPrice';
type OiMode = 'change' | 'total' | 'both' | 'delta' | 'flow';
const PREF_POS_COLLAPSED = 'freshMoney.positionsCollapsed';
const PREF_FLOW_HELP = 'freshMoney.flowHelp';
const PREF_FLOW_VIEW = 'freshMoney.flowView';
const PREF_CHART_COLLAPSED = 'freshMoney.chartCollapsed';
/** Fresh Money's own sound on / off ('1' / '0', default on) — never another page's mute (dhan-alert-sound). */
const PREF_SOUND = 'freshMoney.sound';
const PREF_EXIT_DEFAULTS = 'freshMoney.exitDefaults';
const NO_EXITS: ExitDefaultsUi = { target: null, sl: null };

/** A remembered spec, re-validated (a hand-edited or old value is dropped, never used). */
const specOrNull = (v: unknown): ExitSpec | null => { const r = validateExitSpec(v); return r && !('error' in r) ? r : null; };
/** The live poll: spot, the board strikes' and the open positions' WebSocket LTPs (a 5-30 ms file read on the server). */
const LIVE_POLL_MS = 1_000;
/** Fallback chart span (NSE) until the board reply says which session it covers. */
const NSE_DAY = { from: 9 * 60 + 15, to: 15 * 60 + 30 };

// Literal class strings (Tailwind cannot see interpolated ones). Fill = OI building, outline = OI leaving.
const BAR_CLASS: Record<'put' | 'call', Record<'fill' | 'outline', string>> = {
  put: { fill: 'bg-emerald-500/55', outline: 'border border-emerald-500/60' },
  call: { fill: 'bg-red-500/60', outline: 'border border-red-500/60' },
};

// The strike column's width is the CSS var --fm-k (set by the Ladder), so the optional PCR column beside the strike can
// widen it (PCR_PX) without a second set of grid strings.
const GRID = 'grid grid-cols-[minmax(0,1fr)_var(--fm-num,76px)_var(--fm-k,96px)_var(--fm-num,76px)_minmax(0,1fr)] items-center';
// With trading on, a cell each side of the strike holds B / S, the P&L chip and × (literal string for Tailwind).
const GRID_TRADE = 'grid grid-cols-[minmax(0,1fr)_var(--fm-num,76px)_204px_var(--fm-k,80px)_204px_var(--fm-num,76px)_minmax(0,1fr)] items-center';
// Slot-flow tab: the same grids plus a block of slot cells (38 px each; up to 10 completed slots + the running one) on each
// outer edge, and 96 px number columns (the streak badge sits beside the number: "▲10 +99,999"). The block's width and
// cell count are CSS variables set by the Ladder from the width it has (see slotsThatFit), so the call-side slots never
// scroll off to the right on a narrower screen: older slots are dropped instead. The block also holds one "earlier" cell
// at its outer end (OI change before the first shown slot), so a row's cells add up to its OI Δ today.
const GRID_FLOW = 'grid grid-cols-[var(--fm-slots)_minmax(0,1fr)_96px_var(--fm-k,96px)_96px_minmax(0,1fr)_var(--fm-slots)] items-center';
const GRID_FLOW_TRADE = 'grid grid-cols-[var(--fm-slots)_minmax(0,1fr)_96px_204px_var(--fm-k,80px)_204px_96px_minmax(0,1fr)_var(--fm-slots)] items-center';
const SLOT_CELL_PX = 38;
/** Extra strike-column width for the PCR beside the strike ("26.35"). */
const PCR_PX = 44;
/** Number column on the "OI + Δ" tab: total OI plus today's change chip ("1.3L +12k"); 76 px elsewhere (non-flow grids). */
const NUM_BOTH_PX = 112;
/** Extra strike-column width for the PDH / PDL tag left of the strike (only while the levels are known). */
const LEVEL_PX = 30;
/** Width of each option-price column beside the strike ("1234.50"). */
const PRICE_PX = 54;
/** What the strike column holds besides the strike: level tags, PCR, the PE / CE prices. */
type StrikeLayout = { lv: boolean; pcr: boolean; price: boolean };
const NO_EXTRAS: StrikeLayout = { lv: false, pcr: false, price: false };
const strikeColPx = (trade: boolean, l: StrikeLayout) =>
  (trade ? 80 : 96) + (l.pcr ? PCR_PX : 0) + (l.lv ? LEVEL_PX : 0) + (l.price ? 2 * PRICE_PX : 0);
/** Strike cell columns: [PE price] [level tag] strike [PCR] [CE price] (inline style: the combinations are many). */
function strikeGrid(l: StrikeLayout): React.CSSProperties | undefined {
  if (!l.lv && !l.pcr && !l.price) return undefined;
  const cols = [l.price && `${PRICE_PX - 2}px`, l.lv && '28px', 'minmax(0,1fr)', l.pcr && '40px', l.price && `${PRICE_PX - 2}px`];
  return { display: 'grid', gridTemplateColumns: cols.filter(Boolean).join(' '), alignItems: 'center' };
}
const MIN_SLOT_CELLS = 4;
/** Width of everything on a flow-tab row except the two slot blocks: the fixed columns plus a 120 px minimum per bar. */
const flowFixedPx = (trade: boolean, l: StrikeLayout = NO_EXTRAS) =>
  (trade ? 96 + 204 + 204 + 96 : 96 * 2) + strikeColPx(trade, l) + 2 * 120 + 2 * SLOT_CELL_PX;
/** How many slot cells per side fit in `width` px (at least MIN_SLOT_CELLS — narrower than that scrolls — at most `max`). */
function slotsThatFit(width: number, trade: boolean, max: number, l: StrikeLayout = NO_EXTRAS): number {
  const n = Math.floor((width - flowFixedPx(trade, l)) / (2 * SLOT_CELL_PX));
  return Math.max(Math.min(MIN_SLOT_CELLS, max), Math.min(max, n));
}
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
  setExit: SetExitFn;
  /** Level entries (MKT / LVL switch, ticket) for this strike. */
  level: LevelCell;
  /** Why new orders cannot go now, or null. */
  blockedWhy: string | null;
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
function Bar({ side, length, moved, max, tag, mark, room }: {
  /** Keep the outer-end room free on EVERY bar (the slots tab, where one bar per side carries the ★), so a marked bar
   *  is not drawn shorter than its neighbours. */
  room?: boolean;
  side: 'put' | 'call'; length: number | null; moved: number | null; max: number;
  tag: Buildup | null;
  /** A marker at the bar's outer end (the slots tab's ★); pass `room` on every bar of that tab. */
  mark?: React.ReactNode;
}) {
  if (length === null || length === 0 || max <= 0) return <div />;
  // The tag takes room at the outer end, so the bar scales within what is left.
  const w = Math.max(1.5, (Math.abs(length) / max) * (tag || room || mark ? 88 : 100));
  const cls = BAR_CLASS[side][(moved ?? 0) >= 0 ? 'fill' : 'outline'];
  return (
    <div className={`flex h-full min-w-0 items-center gap-1 ${side === 'put' ? 'justify-end' : 'justify-start'}`}>
      {side === 'put' && mark}
      {side === 'put' && tag && <BuildupTag tag={tag} />}
      <div className={`h-[15px] ${cls}`} style={{ width: `${w}%` }} />
      {side === 'call' && tag && <BuildupTag tag={tag} />}
      {side === 'call' && mark}
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

// "OI + Δ" tab segments (literal strings for Tailwind): held since the previous close dim, added today bright, cut today a
// dashed outline tail (no fill: that OI is gone).
const STACK_CLASS: Record<'put' | 'call', { held: string; added: string; cut: string }> = {
  put: { held: 'bg-emerald-500/25', added: 'bg-emerald-500/80', cut: 'border border-dashed border-emerald-500/70' },
  call: { held: 'bg-red-500/25', added: 'bg-red-500/80', cut: 'border border-dashed border-red-500/70' },
};

/** Total OI as one bar with today's change coloured in it: [held | added] or [held | cut tail], outward from the strike.
 *  Bar length = the larger of today's and the previous close's OI (`max` is board-wide over the same). */
function StackBar({ side, oi, chg, max, tag, unit }: {
  side: 'put' | 'call'; oi: number | null; chg: number | null; max: number; tag: Buildup | null; unit: string;
}) {
  const sp = stackParts(oi, chg);
  if (!sp || sp.total === 0 || max <= 0) return <div />;
  const room = tag ? 88 : 100;
  const pct = (v: number) => (v / max) * room;
  const cls = STACK_CLASS[side];
  const prev = sp.unknown ? null : sp.held + sp.cut;   // = oi − chg
  const title = `Total OI ${fmtOiAbs(oi)} ${unit}`
    + (sp.unknown ? ' · today\'s change unknown'
      : ` · prev close ${fmtOiAbs(prev)} · today ${fmtOi(chg)}${prev && prev > 0 ? ` (${chg! >= 0 ? '+' : ''}${((chg! / prev) * 100).toFixed(1)} %)` : ''}`);
  // Segment widths are shares of this bar (the outer box is sized against the board's max).
  const of = (v: number) => `${(v / sp.total) * 100}%`;
  return (
    <div className={`flex h-full min-w-0 items-center gap-1 ${side === 'put' ? 'justify-end' : 'justify-start'}`} title={title}>
      {side === 'put' && tag && <BuildupTag tag={tag} />}
      {/* Puts grow leftward from the strike, so their parts are laid out mirrored. */}
      <div data-testid="fm-stack" className={`flex min-w-0 ${side === 'put' ? 'flex-row-reverse' : ''}`} style={{ width: `${pct(sp.total)}%`, minWidth: 2 }}>
        <div data-part="held" className={`h-[15px] shrink-0 ${cls.held}`} style={{ width: of(sp.held) }} />
        {sp.added > 0 && <div data-part="added" className={`h-[15px] shrink-0 ${cls.added}`} style={{ width: of(sp.added) }} />}
        {sp.cut > 0 && <div data-part="cut" className={`h-[15px] shrink-0 ${cls.cut}`} style={{ width: of(sp.cut) }} />}
      </div>
      {side === 'call' && tag && <BuildupTag tag={tag} />}
    </div>
  );
}

/** Today's OI change after the total on the "OI + Δ" tab ("1.3L +12k", as in the approved mock): side colour when
 *  added, grey when cut (like `numTone`). */
function ChgChip({ v, side }: { v: number | null; side: 'put' | 'call' }) {
  const cut = v != null && Math.round(v) < 0;
  return (
    <span data-testid="fm-chg-chip" className={`ml-1 text-[10.5px] font-normal ${
      v == null ? 'text-zinc-500' : cut ? 'text-zinc-400' : side === 'put' ? 'text-emerald-400' : 'text-red-400'}`}>
      {fmtOiShort(v)}
    </span>
  );
}

/** Colour of a strike's number: the side's colour (puts green, calls red) when OI was added, dimmed when it was cut
 *  (an unwind), so the two read apart at a glance; Total OI is never negative and keeps the side's colour. */
function numTone(side: 'put' | 'call', v: number | null | undefined, mode: OiMode): string {
  if (mode !== 'total' && mode !== 'both' && v != null && Number.isFinite(v) && Math.round(v) < 0) return 'text-zinc-400';
  return side === 'put' ? 'text-emerald-400' : 'text-red-400';
}

type FlowSlots = FreshMoneyResponse['flowSlots'] & {
  /** Cells shown per side (the newest ones), set by the Ladder from its width; all of them when absent. */
  show?: number;
};
/** A server that predates the slot tab sends no layout: no cells, nothing to break. */
const NO_SLOTS: FlowSlots = { slotMin: 3, bounds: [], boundOk: [], lastTs: '', dayAt: null, closed: false };

/** Cells per side the server sent: the completed slots plus the running one (none running once the session closed). */
const cellCount = (fs: FlowSlots) => (fs.bounds.length === 0 ? 0 : fs.closed ? fs.bounds.length - 1 : fs.bounds.length);

/** Slot i (oldest first; the last index = the running slot, unless closed): label, hover text, whether it is running. */
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

/** For flowCarry: where the "earlier" cell starts counting (= a start edge in `bounds`) and `dayAt`'s index in `bounds`.
 *  It starts at the oldest shown cell, or at the session open when shown cells lie before it (the first half hour):
 *  those cells have no reading by design, and nothing trades before the open, so "earlier" is then exactly 0. */
function carryIdx(fs: FlowSlots): { first: number; dayIdx: number } {
  const total = cellCount(fs);
  const shown = Math.min(total, fs.show ?? total);
  const openIdx = fs.open ? fs.bounds.findIndex(b => b >= fs.open!) : -1;   // "HH:MM" compares as text
  return { first: Math.max(total - shown, openIdx), dayIdx: fs.dayAt ? fs.bounds.indexOf(fs.dayAt) : -1 };
}

/** Cell order for one side: puts read oldest → running left to right, calls are mirrored, so the running slot always
 *  sits next to the strike. Only the newest `fs.show` cells (indices stay the server's, so hover and streaks agree). */
function slotOrder(fs: FlowSlots, side: 'put' | 'call'): number[] {
  const total = cellCount(fs);
  const shown = Math.min(total, fs.show ?? total);
  const idx = Array.from({ length: shown }, (_, k) => total - shown + k);
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

// Heat views: the tint is continuous (flowHeat), mixed from the palette's own emerald / red so it follows every theme.
const HEAT_VAR = { up: 'var(--color-emerald-500)', down: 'var(--color-red-500)' } as const;
const heatBg = (dir: 'up' | 'down', h: number) => `color-mix(in srgb, ${HEAT_VAR[dir]} ${Math.round(8 + 62 * h)}%, transparent)`;
/** One slot cell in the chosen view: classes, an inline heat background, and whether its number is drawn (the value is
 *  always in the hover, and in a screen-reader-only span when it is not drawn). An unknown cell keeps its "–" in every
 *  view, so a gap never reads as "no change". */
function slotCell(v: number | null, scale: number, view: FlowView): { cls: string; style?: React.CSSProperties; showText: boolean } {
  if (view === 'numbers') return { cls: cellClass(v, scale), showText: true };
  if (v === null) return { cls: 'text-zinc-600', showText: true };
  const h = flowHeat(v, scale);
  if (h === 0) return { cls: 'text-zinc-500', showText: view === 'both' };   // heat: blank, as the legend says
  return {
    cls: view === 'heat' ? '' : h >= 0.7 ? 'text-white font-bold' : 'text-zinc-200',
    style: { background: heatBg(v > 0 ? 'up' : 'down', h) },
    showText: view === 'both',
  };
}

/** Hovered slot cell: its row and its slot column are highlighted across the board (both sides). */
type Hover = { row: string; slot: number } | null;
interface HoverProps { rowKey: string; hover: Hover; onHover: (h: Hover) => void }

/** One side's slot cells: OI change per completed slot (frozen) plus the running slot so far (ringed, italic). The
 *  background tint grows with the move's size against the board's scale; moves under 10 % of it are grey. */
function FlowCells({ side, flow, fs, unit, scale, view, rowKey, hover, onHover, note }: {
  side: 'put' | 'call'; flow: SideFlow | null; fs: FlowSlots; unit: string; scale: number; view: FlowView;
  /** Why an unknown cell is unknown, when the caller knows better than "no reading" (the totals' partial slots). */
  note?: (i: number) => string | null;
} & HoverProps) {
  const order = slotOrder(fs, side);
  const { first, dayIdx } = carryIdx(fs);
  const carry = flowCarry(flow, first, dayIdx);
  // OI Δ today at the end of each shown cell (carry + the cells up to it); null once any of them is unknown.
  const upTo = new Map<number, number | null>();
  let run: number | null = carry;
  for (let i = first; i < cellCount(fs); i++) {
    const v = flow?.cells[i] ?? null;
    run = run === null || v === null ? null : run + v;
    upTo.set(i, run);
  }
  const carryCell = order.length > 0 && (
    <span key="carry" data-slot="carry" onMouseEnter={() => onHover({ row: rowKey, slot: -1 })}
      className={`${side === 'put' ? 'mr-1' : 'ml-1'} rounded-sm bg-zinc-800 text-center text-zinc-300 ${hover?.slot === -1 ? 'ring-1 ring-inset ring-zinc-300' : ''}`}
      title={`Earlier: OI Δ from the previous close to ${fs.bounds[first]}: ${carry === null ? 'unknown' : `${fmtOi(carry)} ${unit}`}`
        + ` · earlier + the slots to ${fs.dayAt ?? '–'} = OI Δ today${flow?.day != null ? ` (${fmtOi(flow.day)} ${unit})` : ''}`}>
      {fmtOiShort(carry)}
    </span>
  );
  return (
    // Leaving the cell block clears the crosshair (a bar, the strike or the B / S buttons must not keep it lit).
    <span className="grid grid-cols-[repeat(var(--fm-n),minmax(0,1fr))] gap-px text-[11px]" onMouseLeave={() => onHover(null)}>
      {side === 'put' && carryCell}
      {order.map(i => {
        const v = flow?.cells[i] ?? null;
        const s = slotInfo(fs, i);
        const col = hover?.slot === i;
        const cum = upTo.get(i) ?? null;
        const c = slotCell(v, scale, view);
        return (
          <span key={i} data-slot={i} onMouseEnter={() => onHover({ row: rowKey, slot: i })} style={c.style}
            className={`rounded-sm text-center ${s.running ? 'italic' : ''} ${col ? 'ring-1 ring-inset ring-zinc-300' : s.running ? 'ring-1 ring-inset ring-zinc-500' : ''} ${c.cls}`}
            title={`${s.span}: ${v === null ? (note?.(i) ?? (s.ok ? 'unknown' : 'no OI reading at a slot edge')) : `${fmtOi(v)} ${unit}`}`
              + ` · OI Δ today ${s.running ? `so far (${fs.lastTs})` : `at ${s.head}`}: ${cum === null ? 'unknown' : `${fmtOi(cum)} ${unit}`}`}>
            {c.showText ? fmtOiShort(v) : <><span aria-hidden>&nbsp;</span><span className="sr-only">{fmtOiShort(v)}</span></>}
          </span>
        );
      })}
      {side === 'call' && carryCell}
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
  const order = slotOrder(fs, side);
  const { first } = carryIdx(fs);
  const carryHead = order.length > 0 && (
    <span key="carry" data-slot="carry" className={`${side === 'put' ? 'mr-1' : 'ml-1'} rounded-sm text-center ${hoverSlot === -1 ? 'ring-1 ring-inset ring-zinc-300 text-zinc-100' : ''}`}
      title={`Earlier: OI Δ from the previous close to ${fs.bounds[first]} (this + the slots = OI Δ today)`}>&lt;{fs.bounds[first]}</span>
  );
  return (
    <span className="grid grid-cols-[repeat(var(--fm-n),minmax(0,1fr))] gap-px">
      {side === 'put' && carryHead}
      {order.map(i => {
        const s = slotInfo(fs, i);
        return (
          <span key={i} data-slot={i}
            className={`rounded-sm text-center ${s.running ? 'italic text-zinc-100' : ''} ${hoverSlot === i ? 'ring-1 ring-inset ring-zinc-300 text-zinc-100' : ''}`}
            title={s.span}>{s.head}</span>
        );
      })}
      {side === 'call' && carryHead}
    </span>
  );
}

/** Board totals (flow tab): per slot the sum over the strikes on the board, puts and calls, on their OWN tint scale (sums
 *  are far larger than single strikes), with Σ today's change and the streak badge. Lines up with the strike rows. */
function TotalsRow({ put, call, fs, unit, scale, view, trade, hover, onHover, pcr, layout }: {
  view: FlowView;
  /** The strike column's extras (keeps "Σ shown" over the strikes). */
  layout: StrikeLayout;
  put: SumFlow; call: SumFlow; fs: FlowSlots; unit: string; scale: number; trade: boolean;
  /** Board PCR (Σ put OI ÷ Σ call OI over the strikes shown) when the PCR column is on; undefined = off. */
  pcr?: number | null;
  hover: Hover; onHover: (h: Hover) => void;
}) {
  const nStrikes = Math.max(put.n, call.n);
  // A slot some strikes have no reading for is left blank (a partial sum would look like a move); say why.
  const partial = (f: SumFlow) => (i: number) =>
    f.counts[i] > 0 && f.counts[i] < f.n ? `only ${f.counts[i]} of ${f.n} strikes have a reading here — no partial sum` : null;
  const num = (f: SumFlow, side: 'put' | 'call') => (
    <span className={`whitespace-nowrap font-bold ${side === 'put' ? 'pr-2 text-right' : 'pl-2'} ${numTone(side, f.day, 'flow')}`}
      title={`Σ today's OI change vs the previous close over the ${f.n} strikes with data on the board, as of ${fs.dayAt ?? '–'}: ${
        f.day != null ? `${fmtOi(f.day)} ${unit}` : f.dayCount > 0 ? `unknown (only ${f.dayCount} of ${f.n} strikes have it)` : 'unknown'}`}>
      {side === 'put' && <><StreakBadge flow={f} fs={fs} scale={scale} unit={unit} />{' '}</>}
      {fmtOi(f.day)}
      {side === 'call' && <>{' '}<StreakBadge flow={f} fs={fs} scale={scale} unit={unit} /></>}
    </span>
  );
  return (
    <div className={`${gridFor('flow', trade)} h-[22px] text-[13px] font-bold tabular-nums ${hover?.row === 'sum' ? 'bg-zinc-800' : 'bg-zinc-800/40'}`}>
      <FlowCells side="put" flow={put} fs={fs} unit={unit} scale={scale} view={view} rowKey="sum" hover={hover} onHover={onHover} note={partial(put)} />
      <span />
      {num(put, 'put')}
      {trade && <span />}
      <span style={strikeGrid(layout)}>
        {layout.price && <span />}
        {layout.lv && <span />}
        <span className="block text-center text-[11.5px] font-bold text-zinc-300"
          title={`Sum over the ${nStrikes} strikes with data on the board (not the whole chain); its tints use their own scale`}>Σ shown</span>
        {pcr !== undefined && (
          <span className="pr-1 text-right text-[11.5px] font-bold text-zinc-300"
            title={pcr === null ? 'Board PCR unknown' : `PCR of the strikes shown: Σ put OI ÷ Σ call OI = ${pcr.toFixed(2)}`}>{fmtPcr(pcr)}</span>
        )}
        {layout.price && <span />}
      </span>
      {trade && <span />}
      {num(call, 'call')}
      <span />
      <FlowCells side="call" flow={call} fs={fs} unit={unit} scale={scale} view={view} rowKey="sum" hover={hover} onHover={onHover} note={partial(call)} />
    </div>
  );
}

/** ★ on the strike with the largest OI added since the previous close on its side (the shown session's biggest put /
 *  call builder on the board; the board may show an earlier day, so never "today"). */
function TopMark({ side, at }: { side: 'put' | 'call'; at: string | null }) {
  return (
    <span data-testid={`fm-top-${side}`} className="shrink-0 text-[11px] leading-none text-amber-400"
      title={`Largest ${side} OI added since the previous close on the board (as of ${at ?? '–'})`}>★</span>
  );
}

function BoardRowView({ row, max, boxed, trade, mode, fs, unit, scale, view, round, line, topPut, topCall, hover, onHover, showPcr, lv, priceAsOf, livePut, liveCall }: {
  /** WebSocket LTPs for this strike's PE / CE (undefined = none fresh; the snapshot price is shown). */
  livePut?: number; liveCall?: number;
  /** Slot cells' view (flow tab). `round`: a round strike, drawn bolder on every tab; `line`: with a faint line above it
   *  (not where the header or the spot divider already draws one). `topPut` / `topCall`: this strike is the session's
   *  biggest OI builder on that side (flow tab only). */
  view: FlowView; round: boolean; line: boolean; topPut: boolean; topCall: boolean;
  row: FreshMoneyRow; max: number; boxed: boolean; trade: RowTrade | null; mode: OiMode; showPcr: boolean; lv: LevelInfo;
  /** Snapshot time ("HH:MM:SS") when the price columns are on; undefined = off. */
  priceAsOf?: string;
  /** Slot layout, the OI unit and the board-wide cell scale (see flowScale), for the slot-flow tab. */
  fs: FlowSlots; unit: string; scale: number;
  hover: Hover; onHover: (h: Hover) => void;
}) {
  const rowKey = String(row.strike);
  const shown = (sd: FreshMoneyRow['put']) => (sd ? (mode === 'total' || mode === 'both' ? sd.oi : mode === 'flow' ? sd.flow?.day ?? null : sd.oiMoved) : null);
  const label = (sd: FreshMoneyRow['put']) => (sd
    ? (mode === 'total' || mode === 'both' ? fmtOiAbs(sd.oi) : mode === 'flow' ? fmtOi(sd.flow?.day ?? null) : fmtOi(sd.oiMoved)) : '–');
  // In flow mode the bar is today's OI change as of the latest completed slot (it grows by each completed slot's cell).
  const moved = (sd: FreshMoneyRow['put']) => (mode === 'flow' ? sd?.flow?.day ?? null : sd?.oiMoved ?? null);
  const flowTitle = (sd: FreshMoneyRow['put']) => {
    if (mode !== 'flow') return undefined;
    const v = (n: number | null | undefined) => (n == null ? 'unknown' : `${fmtOi(n)} ${unit}`);
    const late = fs.dayAt && fs.dayAt !== fs.bounds[fs.bounds.length - 1] ? ' (latest slot edge had no reading)' : '';
    const { first, dayIdx } = carryIdx(fs);
    const carry = flowCarry(sd?.flow ?? null, first, dayIdx);
    const split = carry !== null && sd?.flow?.day != null
      ? ` = earlier ${v(carry)} + slots ${fs.bounds[first]}–${fs.dayAt} ${v(sd.flow.day - carry)}` : '';
    return `Today's OI change vs the previous close, as of ${fs.dayAt ?? 'no slot edge with a reading'}${late}: ${v(sd?.flow?.day)}${split}`
      + (sd?.official ? ` · official close (the OI change tab): ${v(sd?.oiMoved)}` : ` · live (${fs.lastTs || 'now'}): ${v(sd?.oiMoved)}`);
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
        level={trade.level} blockedWhy={trade.blockedWhy}
      />
    );
  };
  const delta = mode === 'delta' ? oiDelta(row) : null;
  return (
    <div className={`${gridFor(mode, !!trade)} ${trade ? 'h-[26px]' : 'h-[21px]'} text-[13px] tabular-nums ${line ? 'shadow-[inset_0_1px_0_var(--color-zinc-800)]' : ''} ${mode === 'flow' && hover?.row === rowKey ? 'bg-zinc-800/50' : ''}`}>
      {mode === 'flow' && <FlowCells side="put" flow={p?.flow ?? null} fs={fs} unit={unit} scale={scale} view={view} rowKey={rowKey} hover={hover} onHover={onHover} />}
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
          {mode === 'both'
            ? <StackBar side="put" oi={p?.oi ?? null} chg={p?.oiMoved ?? null} max={max} tag={p?.buildup ?? null} unit={unit} />
            : <Bar side="put" length={shown(p)} moved={moved(p)} max={max} tag={mode === 'flow' ? null : p?.buildup ?? null}
                room={mode === 'flow'} mark={mode === 'flow' && topPut ? <TopMark side="put" at={fs.dayAt} /> : undefined} />}
          <span className={`whitespace-nowrap pr-2 text-right font-bold ${numTone('put', shown(p), mode)}`} title={flowTitle(p)}>
            {mode === 'flow' && <><StreakBadge flow={p?.flow ?? null} fs={fs} scale={scale} unit={unit} />{' '}</>}{label(p)}{mode === 'both' && <ChgChip v={p?.oiMoved ?? null} side="put" />}
          </span>
        </>
      )}
      {cell('put')}
      <StrikeCell strike={row.strike} boxed={boxed} round={round} pcr={showPcr ? pcrOf(row) : undefined} lv={lv}
        price={priceAsOf !== undefined ? { put: p, call: c, asOf: priceAsOf, livePut, liveCall } : undefined} />
      {cell('call')}
      {mode === 'delta' ? (
        // Δ OI tab: the right panel is left empty (the difference is on the left).
        <><span /><span /></>
      ) : (
        <>
          <span className={`whitespace-nowrap pl-2 font-bold ${numTone('call', shown(c), mode)}`} title={flowTitle(c)}>
            {label(c)}{mode === 'both' && <ChgChip v={c?.oiMoved ?? null} side="call" />}{mode === 'flow' && <>{' '}<StreakBadge flow={c?.flow ?? null} fs={fs} scale={scale} unit={unit} /></>}
          </span>
          {mode === 'both'
            ? <StackBar side="call" oi={c?.oi ?? null} chg={c?.oiMoved ?? null} max={max} tag={c?.buildup ?? null} unit={unit} />
            : <Bar side="call" length={shown(c)} moved={moved(c)} max={max} tag={mode === 'flow' ? null : c?.buildup ?? null}
                room={mode === 'flow'} mark={mode === 'flow' && topCall ? <TopMark side="call" at={fs.dayAt} /> : undefined} />}
        </>
      )}
      {mode === 'flow' && <FlowCells side="call" flow={c?.flow ?? null} fs={fs} unit={unit} scale={scale} view={view} rowKey={rowKey} hover={hover} onHover={onHover} />}
    </div>
  );
}

/** Previous-day levels shown as tags (the strike column grows a tag slot only while they are known). */
type LevelInfo = { tags: Map<number, LevelTag[]>; values: Partial<Record<LevelTag, number>>; prevDate?: string } | null;
// Today's range solid, the previous day's tinted, so the two sets read apart at a glance (data colours; the label on a
// solid fill is text-oncolor, which never flips).
const LEVEL_TAG_CLASS: Record<LevelTag, string> = {
  DH: 'border border-sky-600 bg-sky-600 text-oncolor',
  DL: 'border border-fuchsia-600 bg-fuchsia-600 text-oncolor',
  PDH: 'border border-sky-500/50 bg-sky-500/15 text-sky-300',
  PDL: 'border border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-300',
};
const LEVEL_NAME: Record<LevelTag, string> = {
  DH: "Today's high", DL: "Today's low", PDH: 'Previous day high', PDL: 'Previous day low',
};

/** DH / DL / PDH / PDL tag(s) at the strike nearest each level; the exact levels are in the hover. One or two tags
 *  stack; three or four (rare) sit in a 2×2 grid so the row never grows. */
function LevelTags({ tags, lv }: { tags: LevelTag[]; lv: NonNullable<LevelInfo> }) {
  const what = (t: LevelTag) => `${LEVEL_NAME[t]} ${(lv.values[t] ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    + (t === 'DH' || t === 'DL' ? ' (live)' : lv.prevDate ? ` (${lv.prevDate})` : '');
  const size = tags.length > 2 ? 'text-[7px] leading-[8px]' : tags.length > 1 ? 'text-[8px] leading-[9px]' : 'text-[9px] leading-[13px]';
  return (
    <span className={tags.length > 2 ? 'grid grid-cols-2 items-center gap-px' : 'flex flex-col items-start justify-center gap-px'}
      title={`${tags.map(what).join(' · ')} — nearest strike`}>
      {tags.map(t => (
        <span key={t} data-testid={`fm-${t.toLowerCase()}`}
          className={`rounded-sm px-0.5 font-bold tracking-tight ${size} ${LEVEL_TAG_CLASS[t]}`}>
          {t}
        </span>
      ))}
    </span>
  );
}

/** The strike cell: [DH / DL / PDH / PDL tag] strike [PCR (put OI ÷ call OI) when the PCR column is on]. */
/** An option's price beside the strike: the live WebSocket LTP when there is a fresh one, else the board snapshot's last
 *  price; green / red against its previous close. */
function OptPrice({ side, s, asOf, live }: { side: 'put' | 'call'; s: FreshMoneyRow['put']; asOf: string; live?: number }) {
  const isLive = live !== undefined && live > 0;
  const ltp = isLive ? live : s?.ltp ?? null, pc = s?.prevClose ?? null;
  const chg = ltp !== null && pc !== null && pc > 0 ? ltp - pc : null;
  const tone = chg === null || Math.abs(chg) < 1e-9 ? 'text-zinc-300' : chg > 0 ? 'text-emerald-400' : 'text-red-400';
  return (
    <span data-testid={`fm-price-${side === 'put' ? 'pe' : 'ce'}`}
      className={`${side === 'put' ? 'pl-1 text-left' : 'pr-1 text-right'} text-[11.5px] ${tone}`}
      title={ltp === null ? `${side === 'put' ? 'PE' : 'CE'} price unknown`
        : `${side === 'put' ? 'PE' : 'CE'} last price ${ltp.toFixed(2)}`
          + (chg !== null ? ` · prev close ${pc!.toFixed(2)} · ${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${chg >= 0 ? '+' : ''}${((chg / pc!) * 100).toFixed(1)} %)` : '')
          + (isLive ? ' · live (WebSocket)' : ` · board snapshot ${asOf} (no live price)`)}>
      {ltp === null ? '–' : ltp.toFixed(2)}
    </span>
  );
}

function StrikeCell({ strike, boxed, round, pcr, lv, price }: {
  strike: number; boxed: boolean; round: boolean; pcr: number | null | undefined; lv: LevelInfo;
  /** The row's sides and the snapshot time when the price columns are on; undefined = off. */
  price?: { put: FreshMoneyRow['put']; call: FreshMoneyRow['call']; asOf: string; livePut?: number; liveCall?: number };
}) {
  const box = (
    <span className={`px-2 leading-[18px] ${boxed ? 'border border-sky-400 bg-sky-500/15 font-bold text-white' : round ? 'border border-transparent font-bold text-zinc-100' : 'border border-transparent text-zinc-300'}`}>
      {strike}
    </span>
  );
  const layout: StrikeLayout = { lv: !!lv, pcr: pcr !== undefined, price: !!price };
  const grid = strikeGrid(layout);
  if (!grid) return <span className="flex justify-center">{box}</span>;
  const tags = lv?.tags.get(strike);
  return (
    <span style={grid}>
      {price && <OptPrice side="put" s={price.put} asOf={price.asOf} live={price.livePut} />}
      {lv && (tags ? <LevelTags tags={tags} lv={lv} /> : <span />)}
      <span className="flex justify-center">{box}</span>
      {pcr !== undefined && (
        <span data-testid="fm-pcr" className="pr-1 text-right text-[11.5px] text-zinc-400" title={pcr === null ? 'PCR unknown (a side has no OI)' : `PCR = put OI ÷ call OI = ${pcr.toFixed(2)}`}>
          {fmtPcr(pcr)}
        </span>
      )}
      {price && <OptPrice side="call" s={price.call} asOf={price.asOf} live={price.liveCall} />}
    </span>
  );
}

/** Minutes of the day → "HH:MM". */
const fmtHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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
function Ladder({ data, oiMode, tradeMode, fs: fsAll, maxAbs, boxedStrike, rowTrade, spot, liveSpot, totals, scale, view, showPcr, showPrice, livePrices, today }: {
  /** Slot cells: numbers, heat or both (flow tab). */
  view: FlowView;
  showPcr: boolean;
  /** PE / CE price columns beside the strike. */
  showPrice: boolean;
  /** WebSocket LTPs by `"strike:opt"` (today's board only); the snapshot price is the fallback. */
  livePrices: Readonly<Record<string, number>> | null;
  /** Today's high / low of the board's price (live, for DH / DL); null when the board is not today's or not known. */
  today: { high: number | null; low: number | null } | null;
  data: FreshMoneyResponse; oiMode: OiMode; tradeMode: boolean; fs: FlowSlots; maxAbs: number; boxedStrike: number | null;
  rowTrade: (strike: number) => RowTrade | null; spot: number | null; liveSpot: number | null;
  totals: { put: SumFlow; call: SumFlow; scale: number }; scale: number;
}) {
  const [hover, setHover] = useState<Hover>(null);
  // The strike column grows a tag slot while any level is known (sized here, before the slot count is worked out).
  const hasLevels = (data.market === 'NSE' && !!data.prevDay) || !!today?.high || !!today?.low;
  const flowTotals = totals, flowCellScale = scale;
  // Flow tab: as many slot cells per side as the box has room for (the newest ones), so on a narrower screen the oldest
  // slots go instead of the call side scrolling off to the right once the trade columns appear.
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth - 32));   // minus px-4 on both sides
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const total = cellCount(fsAll);
  const show = boxW > 0 ? slotsThatFit(boxW, tradeMode, total, { lv: hasLevels, pcr: showPcr, price: showPrice }) : total;
  const fs = useMemo<FlowSlots>(() => ({ ...fsAll, show }), [fsAll, show]);
  // +1: the "earlier" cell at the outer end of each slot block (its width is counted in flowFixedPx for slotsThatFit).
  const flowVars = { '--fm-slots': `${(show + 1) * SLOT_CELL_PX}px`, '--fm-n': String(show + 1) } as React.CSSProperties;
  const dh = today?.high ?? null, dl = today?.low ?? null;
  const lv = useMemo<LevelInfo>(() => {
    const p = data.market === 'NSE' ? data.prevDay : null;   // PDH / PDL: NSE indices only
    const values: Partial<Record<LevelTag, number>> = {};
    if (dh) values.DH = dh;
    if (dl) values.DL = dl;
    if (p) { values.PDH = p.high; values.PDL = p.low; }
    const tags = levelStrikes((Object.entries(values) as [LevelTag, number][]).map(([tag, value]) => ({ tag, value })), data.step);
    return tags.size ? { tags, values, prevDate: p?.date } : null;
  }, [data.prevDay, data.market, data.step, dh, dl]);
  const layout: StrikeLayout = { lv: !!lv, pcr: showPcr, price: showPrice };
  const kPx = strikeColPx(tradeMode, layout);
  const priceAsOf = showPrice ? data.lastTs.slice(11) : undefined;
  const numPx = oiMode === 'both' ? NUM_BOTH_PX : 76;
  const kVar = { '--fm-k': `${kPx}px`, '--fm-num': `${numPx}px` } as React.CSSProperties;
  const pcrAll = useMemo(() => (showPcr ? boardPcr(data.rows) : undefined), [showPcr, data.rows]);
  // Only the slots tab draws the ★.
  const tops = useMemo(() => (oiMode === 'flow' ? topBuilders(data.rows) : { put: null, call: null }), [oiMode, data.rows]);
  return (
    <>
    {/* Flow tab: the ladder scrolls inside its own box (both ways), so the slot times and totals can stay pinned
        (an overflow-x box is a scroll container, so `sticky` could never pin against the window). */}
    <div ref={boxRef} className={oiMode === 'flow' ? 'max-h-[calc(100vh-170px)] overflow-auto px-4 pb-2' : 'overflow-x-auto px-4 pb-2 pt-2'}
      onMouseLeave={() => setHover(null)}>
     <div style={oiMode === 'flow'
       ? { ...flowVars, ...kVar, minWidth: 2 * show * SLOT_CELL_PX + flowFixedPx(tradeMode, layout) }
       : { ...kVar, minWidth: (tradeMode ? 1104 : 720) + kPx - strikeColPx(tradeMode, NO_EXTRAS) + 2 * (numPx - 76) }}>
      <div data-testid="flow-sticky-head" className={oiMode === 'flow' ? 'sticky top-0 z-10 border-b border-zinc-700 bg-zinc-900 pt-2' : ''}>
      <div className={`${gridFor(oiMode, tradeMode)} h-5 whitespace-nowrap text-[11.5px] ${oiMode === 'flow' ? 'text-zinc-300' : 'text-zinc-400'}`}>
        {oiMode === 'flow' && <FlowHeader side="put" fs={fs} hoverSlot={hover?.slot ?? null} />}
        <span className="col-span-2 pr-2 text-right">{oiMode === 'delta' ? 'Δ OI: calls − puts (total)' : `PUTS: ${oiMode === 'total' ? 'total OI' : oiMode === 'both' ? 'total OI · Δ today' : oiMode === 'flow' ? `OI Δ today @ ${fs.dayAt ?? '–'}` : 'OI moved'}`}</span>
        {tradeMode && <span className="pr-1 text-right text-zinc-400" title="Buy / Sell the put, and your put position's P&L at this strike (open, or booked today once closed)">PE · B/S · P&amp;L</span>}
        {strikeGrid(layout) ? (
          <span style={strikeGrid(layout)}>
            {showPrice && <span className="pl-1" title={`Put last price, from the board snapshot (${priceAsOf}); green / red vs its previous close`}>PE ₹</span>}
            {lv && <span />}
            <span className="text-center">STRIKE</span>
            {showPcr && <span className="pr-1 text-right" title="Put-call ratio at the strike: put total OI ÷ call total OI (as Dhan's option chain shows it)">PCR</span>}
            {showPrice && <span className="pr-1 text-right" title={`Call last price, from the board snapshot (${priceAsOf}); green / red vs its previous close`}>CE ₹</span>}
          </span>
        ) : <span className="text-center">STRIKE</span>}
        {tradeMode && <span className="pl-1 text-zinc-400" title="Buy / Sell the call, and your call position's P&L at this strike (open, or booked today once closed)">CE · B/S · P&amp;L</span>}
        <span className="col-span-2 pl-2">{oiMode === 'delta' ? '' : `CALLS: ${oiMode === 'total' ? 'total OI' : oiMode === 'both' ? 'total OI · Δ today' : oiMode === 'flow' ? `OI Δ today @ ${fs.dayAt ?? '–'}` : 'OI moved'}`}</span>
        {oiMode === 'flow' && <FlowHeader side="call" fs={fs} hoverSlot={hover?.slot ?? null} />}
      </div>
      {oiMode === 'flow' && fs.bounds.length > 0 && (
        <TotalsRow put={flowTotals.put} call={flowTotals.call} fs={fs} unit={data.oiUnit} scale={flowTotals.scale} view={view}
          trade={tradeMode} hover={hover} onHover={setHover} pcr={pcrAll} layout={layout} />
      )}
      </div>
      {data.rows.map((r, i) => {
        const next = data.rows[i + 1];
        const divider = spot !== null && next && r.strike > spot && next.strike <= spot;
        const prev = data.rows[i - 1];
        const afterDivider = spot !== null && !!prev && prev.strike > spot && r.strike <= spot;
        // Round strikes (the 100s on a 50 step, the 500s on a 100 step) are bolder with a faint line above (all tabs).
        const round = isRoundStrike(r.strike, data.step);
        return (
          <React.Fragment key={r.strike}>
            <BoardRowView row={r} max={maxAbs} boxed={r.strike === boxedStrike} trade={rowTrade(r.strike)} mode={oiMode}
              fs={fs} unit={data.oiUnit} scale={flowCellScale} view={view} round={round}
              line={round && i > 0 && !afterDivider} topPut={tops.put === r.strike} topCall={tops.call === r.strike}
              hover={hover} onHover={setHover} showPcr={showPcr} lv={lv} priceAsOf={priceAsOf}
              livePut={livePrices?.[`${r.strike}:PE`]} liveCall={livePrices?.[`${r.strike}:CE`]} />
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
  const [rawData, setData] = useState<FreshMoneyResponse | null>(null);
  // OI unit (remembered per browser): lots as served, or units (lots x lot size) like Dhan's option chain. NSE only:
  // MCX OI is already lots (lot 1). Display only — orders, lots and the lot size are never scaled.
  const [oiUnits, setOiUnits] = useState(false);
  const pickOiUnits = (on: boolean) => { setOiUnits(on); writePref(PREF_OI_UNITS, on ? '1' : '0'); };
  // PCR column beside the strike (remembered per browser), like Dhan's option chain.
  const [showPcr, setShowPcr] = useState(false);
  const toggleShowPcr = () => setShowPcr(o => { writePref(PREF_PCR, o ? '0' : '1'); return !o; });
  // PE / CE price columns beside the strike (remembered per browser).
  const [showPrice, setShowPrice] = useState(false);
  const toggleShowPrice = () => setShowPrice(o => { writePref(PREF_PRICE, o ? '0' : '1'); return !o; });
  const canUnits = !!rawData && rawData.market === 'NSE' && rawData.oiUnit === 'lots' && (rawData.lot ?? 0) > 1;
  const data = useMemo<FreshMoneyResponse | null>(() => (rawData && canUnits && oiUnits
    ? { ...rawData, oiUnit: 'units', rows: scaleOiRows(rawData.rows, rawData.lot!) }
    : rawData), [rawData, canUnits, oiUnits]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // REAL-money arm: per page load, never persisted, dropped on an underlying switch.
  const [armed, setArmed] = useState(false);
  // Account for NEW orders (remembered per browser). An open position keeps the broker it was opened on.
  const [broker, setBrokerRaw, brokerReady] = usePageBroker<FmBroker>('freshMoney.broker', FM_BROKERS);
  // Switching account disarms: an armed page must never quietly start sending to a different account.
  const setBroker = useCallback((b: FmBroker) => { setArmed(false); setBrokerRaw(b); }, [setBrokerRaw]);
  const [lots, setLots] = useState(1);
  const [product, setProduct] = useState<FmProduct>('MIS');
  // Target / stop-loss stamped onto each new position (remembered per browser, like Lots).
  const [exitDefaults, setExitDefaults] = useState<ExitDefaultsUi>(NO_EXITS);
  const pickExitDefaults = (d: ExitDefaultsUi) => { setExitDefaults(d); writePref(PREF_EXIT_DEFAULTS, JSON.stringify(d)); };
  // Collapsed panels (remembered per browser).
  const [posCollapsed, setPosCollapsed] = useState(false);
  // Slot tab: the "How to read" panel (remembered per browser). The hover crosshair lives in <Ladder>.
  const [flowHelp, setFlowHelp] = useState(false);
  const toggleFlowHelp = () => setFlowHelp(o => { writePref(PREF_FLOW_HELP, o ? '0' : '1'); return !o; });
  // Slot tab: exact numbers, colour only (heat map), or numbers on the gradient (remembered per browser).
  const [flowView, setFlowView] = useState<FlowView>('numbers');
  const pickFlowView = (v: FlowView) => { setFlowView(v); writePref(PREF_FLOW_VIEW, v); };
  // What the board's numbers and bar lengths show: today's OI change (default) or total OI outstanding.
  const [oiMode, setOiMode] = useState<OiMode>('change');
  const pickOiMode = (m: OiMode) => { setOiMode(m); writePref(PREF_OI_MODE, m); };
  const togglePos = () => setPosCollapsed(c => { writePref(PREF_POS_COLLAPSED, c ? '0' : '1'); return !c; });
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const toggleChart = () => setChartCollapsed(c => { writePref(PREF_CHART_COLLAPSED, c ? '0' : '1'); return !c; });
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
  /** The newest board request whose reply (or error) is on screen, and the underlying the page shows now. */
  const applied = useRef(0);
  const underlyingRef = useRef<Underlying>(underlying);
  useEffect(() => { underlyingRef.current = underlying; }, [underlying]);

  // Restore preferences after mount (SSR renders the defaults).
  useEffect(() => {
    const u = readPref(PREF_UNDERLYING);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    if (u && (UNDERLYINGS as readonly string[]).includes(u)) setUnderlying(u as Underlying);
    const l = Number(readPref(PREF_LOTS));
    if (Number.isInteger(l) && l >= 1 && l <= 20) setLots(l);
    if (readPref(PREF_PRODUCT) === 'NRML') setProduct('NRML');
    setPosCollapsed(readPref(PREF_POS_COLLAPSED) === '1');
    setChartCollapsed(readPref(PREF_CHART_COLLAPSED) === '1');
    setFlowHelp(readPref(PREF_FLOW_HELP) === '1');
    setFlowView(readPrefOf(PREF_FLOW_VIEW, FLOW_VIEWS, 'numbers'));
    setOiUnits(readPref(PREF_OI_UNITS) === '1');
    setShowPcr(readPref(PREF_PCR) === '1');
    setShowPrice(readPref(PREF_PRICE) === '1');
    setSoundOn(readPref(PREF_SOUND) !== '0');
    const om = readPref(PREF_OI_MODE);
    if (om === 'total' || om === 'both' || om === 'delta' || om === 'flow') setOiMode(om);
    try {
      const d = JSON.parse(readPref(PREF_EXIT_DEFAULTS) ?? 'null') as { target?: unknown; sl?: unknown } | null;
      if (d) setExitDefaults({ target: specOrNull(d.target), sl: specOrNull(d.sl) });
    } catch { /* a bad saved value = no defaults */ }
  }, []);

  // A reply is dropped only when it is for another underlying or OLDER than one already shown. "Only the newest request"
  // would starve the board around the open, where it is re-read every second: a reply slower than a second would always
  // be superseded and thrown away (the trade state poll had the same fault; see useFreshMoneyTrades).
  const load = useCallback(async (u: Underlying, signal?: AbortSignal) => {
    const my = ++seq.current;
    const stale = () => u !== underlyingRef.current || my < applied.current;
    try {
      const res = await fetch(`/api/fresh-money?underlying=${u}`, { cache: 'no-store', signal });
      const body = await res.json();
      if (stale()) return;
      applied.current = my;
      if (!res.ok || body.error) { setError(body.error ?? `HTTP ${res.status}`); setData(null); }
      else { setData(body as FreshMoneyResponse); setError(null); }
    } catch (e) {
      if (stale() || (e as Error).name === 'AbortError') return;
      applied.current = my;
      setError(String((e as Error).message ?? e));
    } finally {
      if (my === applied.current) { setLoading(false); setNow(Date.now()); }
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
    underlyingRef.current = u;   // a reply for the old underlying still in flight is dropped at once
    setUnderlying(u);
    writePref(PREF_UNDERLYING, u);
  };

  // Slot-flow layout; empty from a server that predates the slot tab.
  const fs = data?.flowSlots ?? NO_SLOTS;
  const nSlots = Math.max(0, fs.bounds.length - 1);
  // One tint scale for every slot cell on the board (puts and calls), so sizes compare across strikes.
  // Board totals per slot (puts / calls) and their own tint scale: sums dwarf single strikes.
  const flowTotals = useMemo(() => {
    const len = cellCount(fs);
    const put = sumFlows((data?.rows ?? []).map(r => r.put?.flow ?? null), len);
    const call = sumFlows((data?.rows ?? []).map(r => r.call?.flow ?? null), len);
    return { put, call, scale: flowScale([...put.cells, ...call.cells]) };
  }, [data, fs]);

  // Board-wide streak alert: the Σ totals row starts (or turns into) a run of 3+ slots on puts or calls. Live board only,
  // leader tab only; the first reply after a load / underlying or day switch only records (no chime for history).
  const prevStreakRef = useRef<{ key: string; put: { dir: 1 | -1 } | null; call: { dir: 1 | -1 } | null } | null>(null);
  useEffect(() => {
    // Not once the session closed: the slot row is re-laid on the close then, which is no new streak.
    if (!data?.isToday || fs.closed || fs.bounds.length < 2) return;
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
  }, [flowTotals, data, fs.bounds, fs.closed, leaderRef, play]);
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
    // OI + Δ: the bar runs to the larger of today's and the previous close's OI (a cut shows as a tail past today's OI).
    const v = (sd: FreshMoneyRow['put']) => oiMode === 'both' ? (stackParts(sd?.oi, sd?.oiMoved)?.total ?? 0) : Math.abs((oiMode === 'total' ? sd?.oi : oiMode === 'flow' ? sd?.flow?.day : sd?.oiMoved) ?? 0);
    for (const r of data?.rows ?? []) mx = Math.max(mx, v(r.put), v(r.call));
    return mx;
  }, [data, oiMode]);

  // Live spot from the WebSocket (today's board only: a live price over an old session's OI would mislead). Falls back
  // to the board snapshot's spot when there is no fresh WebSocket price.
  // Polled whenever a board is shown (the header price); the board itself uses it only on today's board.
  const [live, setLive] = useState<{ key: string; q: FreshMoneyLive; at: number } | null>(null);
  const liveKey = data ? `${underlying}|${data.expiry}` : null;
  // The open positions' contracts ride on the same poll (their WebSocket LTPs re-price the P&L between trade polls).
  const liveIdsRef = useRef('');
  useEffect(() => { liveIdsRef.current = liveIdsParam(trades.state?.positions ?? []); }, [trades.state]);
  useEffect(() => {
    if (!liveKey) return;
    const [u, expiry] = liveKey.split('|');
    let alive = true;
    let my = 0;
    let applied = 0;
    const tick = async () => {
      if (document.hidden) return;
      const n = ++my;
      try {
        const ids = liveIdsRef.current;
        const r = await fetch(`/api/fresh-money/live?underlying=${u}&expiry=${expiry}${ids ? `&ids=${encodeURIComponent(ids)}` : ''}`, { cache: 'no-store' });
        const j = (await r.json()) as FreshMoneyLive;
        // Drop only a reply OLDER than one shown (dropping all but the newest starves a 1 s poll; see useFreshMoneyTrades).
        if (!alive || n < applied) return;
        applied = n;
        setLive({ key: liveKey, q: j, at: Date.now() });
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
  const nowIstMin = istMinuteOfDay(now);
  const day = data?.day ?? NSE_DAY;
  const isMcx = MCX_UNDERLYINGS.has(underlying);
  const collectorName = isMcx ? `${underlying} OI collector` : 'IV snapshot collector';
  const isStale = !!data?.isToday && staleMin >= 3 && nowIstMin >= day.from && nowIstMin <= day.to;
  // Today's session is over (the server stops the slots at the close then; flowSlots.closed says it did).
  const sessionOver = !!data?.isToday && (nowIstMin >= day.to || !!data.flowSlots?.closed);

  // ── trading ──
  const ts = trades.state;
  // Trade sounds + toasts for what changed since the last trade-state poll (entry / exit / warn; server-fired target,
  // stop-loss and total exits get a toast here, which they had none of). The first poll only records.
  const prevTradeRef = useRef<TradeSnapshot | null>(null);
  useEffect(() => {
    if (!ts) return;
    const cur: TradeSnapshot = { positions: ts.positions, exits: ts.exits ?? {}, global: ts.global ?? null, entries: ts.entries ?? [] };
    const ev = tradeEvents(prevTradeRef.current, cur);
    prevTradeRef.current = cur;
    if (!leaderRef.current) return;
    for (const t of ev.toasts) {
      if (t.kind === 'error') toast.error(t.title, { description: t.detail, duration: 20_000 });
      else toast.success(t.title, { description: t.detail, duration: 8_000 });
    }
    if (ev.sound) play(ev.sound);
  }, [ts, leaderRef, play]);
  // What the screen shows: the trade state with position LTP / P&L re-priced at the 1 s live poll's WebSocket LTPs
  // (lib/freshMoneyLivePrices.ts), so they no longer step only with the 2 s trade poll. DISPLAY ONLY: sounds and toasts
  // above diff the server's own state, and every order, close and exit is decided on the server.
  const liveIdLtps = liveQ?.idLtps ?? null;
  const tsView = useMemo(() => {
    if (!ts || !liveIdLtps) return ts;
    const positions = withLiveLtps(ts.positions, liveIdLtps);
    if (positions === ts.positions) return ts;
    const ltpSource = { ...ts.ltpSource };
    for (const id of Object.keys(liveIdLtps)) ltpSource[id] = 'ws';
    return { ...ts, positions, ltpSource };
  }, [ts, liveIdLtps]);
  const tradable = !!ts?.tradable.includes(underlying);
  const tradeExpiry = ts?.boardExpiry[underlying] ?? null;
  // Orders only from a live board: today's snapshot, and the expiry the server will trade.
  // NRML may open new positions until 15:29 (MIS: 15:17); the server re-checks with the order's own product.
  const sessionInfo = product === 'NRML' ? (ts?.sessions[underlying]?.nrml ?? ts?.sessions[underlying]) : ts?.sessions[underlying];
  const session = sessionInfo?.gate ?? 'closed';
  const blocked = !data ? null
    : ts && !ts.brokers[broker] ? `${brokerLabel(broker)} is not logged in — log in from Autologin, then refresh`
    : session !== 'open' ? (sessionInfo?.note ?? null)
    : !data.isToday ? `Trading opens when today's board is live (the ${collectorName} has not written today)`
      : isStale ? 'Board snapshot is stale — orders paused until the collector writes again'
        : tradeExpiry !== data.expiry ? "The board's expiry is changing — wait for the next refresh"
          : null;
  // Around the NSE open the normal polls (board 30 s, trade state 10 s) are far too slow: the buttons need the session
  // gate AND today's first snapshot, both of which appear within a second or two of 09:15:00. So from 5 s before the
  // open the page re-reads both once a second until trading is unblocked (lib/freshMoneyOpen.ts); no timer otherwise.
  // The server still re-checks every order (session, today's board, staleness).
  // "Still blocked" = anything the open resolves: no board on screen (a failed read must not end the polling), or any
  // blocked reason (session, yesterday's board, a stale board, the trade state's expiry not caught up yet). Not while
  // the broker is logged out (polling cannot fix that) or on a watch-only index (SENSEX: never tradable).
  const waitingForOpen = !isMcx && (!ts || (tradable && !!ts.brokers[broker])) && (!data || blocked !== null);
  const waitingRef = useRef(false);
  useEffect(() => { waitingRef.current = waitingForOpen; }, [waitingForOpen]);
  const refreshTrades = trades.refresh;
  useEffect(() => {
    if (isMcx) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One self-rescheduling timer: every second inside the window, otherwise asleep until the next window starts
    // (re-checked at least hourly, so a laptop that slept or a clock change cannot leave it pointing at the wrong time).
    const step = () => {
      const b = openBurst(Date.now(), NSE_WINDOW.open);
      if (b.active && waitingRef.current && !document.hidden && isRegularSession(istToday())) {
        load(underlying);
        refreshTrades();
      }
      timer = setTimeout(step, b.active ? 1_000 : Math.min(b.startsInMs, 3_600_000));
    };
    step();
    return () => { if (timer) clearTimeout(timer); };
  }, [isMcx, underlying, load, refreshTrades]);
  // Coming back to a background tab: re-read both at once instead of waiting for the next 10 s / 30 s tick.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) { load(underlying); refreshTrades(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [underlying, load, refreshTrades]);
  // This underlying's positions on every expiry: they all count in the bar's P&L.
  // The bar and the board show the selected broker; positions on other brokers are listed under the bar.
  const underlyingPositions = useMemo(
    () => (tsView?.positions ?? []).filter(p => p.underlying === underlying && p.broker === broker), [tsView, underlying, broker]);
  // On the board: the board's expiry AND a strike the board has a row for. Everything else that is still open is listed
  // under the bar (with its own ×) — a position must never become invisible because spot moved or the expiry rolled.
  const boardStrikes = useMemo(() => new Set((data?.rows ?? []).map(r => r.strike)), [data]);
  const myPositions = useMemo(
    // ...and the selected product: a strike can hold an MIS and an NRML position, each listed apart.
    () => underlyingPositions.filter(p => !!data && p.expiry === data.expiry && boardStrikes.has(p.strike) && (p.product ?? 'MIS') === product),
    [underlyingPositions, data, boardStrikes, product],
  );
  const offBoard = useMemo(() => {
    const on = new Set(myPositions.map(p => p.key));
    return (tsView?.positions ?? []).filter(p => p.netQty !== 0 && !on.has(p.key));
  }, [tsView, myPositions]);
  const posByKey = useMemo(() => new Map(myPositions.map(p => [`${p.strike}:${p.opt}`, p] as const)), [myPositions]);
  const tradeMode = armed || myPositions.length > 0;
  const { order: sendOrder, close: sendClose, setExit, inflight, arm, cancelEntry } = trades;
  // Strikes switched to LVL (page memory only: a reload is back on MKT, so it can never turn a click into a level).
  const [levelOn, setLevelOn] = useState<ReadonlySet<string>>(new Set());
  const toggleLevel = useCallback((k: string) => setLevelOn(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);
  // Active level entries on this board (selected broker + underlying), by strike.
  const entriesByStrike = useMemo(() => {
    const m = new Map<number, FmEntry[]>();
    for (const e of ts?.entries ?? []) {
      if (e.broker !== broker || e.underlying !== underlying || e.expiry !== data?.expiry || !entryActive(e.state)) continue;
      m.set(e.strike, [...(m.get(e.strike) ?? []), e]);
    }
    return m;
  }, [ts, broker, underlying, data?.expiry]);
  const levelPriceName = data?.market === 'MCX' ? (liveQ?.label ?? `${underlying} FUT`) : underlying;
  const exitText = exitSummary(exitDefaults) || 'none (header New positions)';
  const rowTrade = useCallback((strike: number): RowTrade | null => {
    if (!tradeMode || !data) return null;
    return {
      put: posByKey.get(`${strike}:PE`),
      call: posByKey.get(`${strike}:CE`),
      showButtons: armed && tradable,
      canOrder: armed && tradable && !blocked,
      canClose: armed && session !== 'closed',
      ltpSource: tsView?.ltpSource ?? {},
      exits: ts?.exits ?? {},
      armed,
      // The order buttons trade the selected product; × closes the position shown, in its own product.
      busy: opt => {
        const shown = posByKey.get(`${strike}:${opt}`);
        return inflight.has(lockKey(broker, underlying, strike, opt, product))
          || (!!shown && inflight.has(lockKey(shown.broker, underlying, strike, opt, shown.product)));
      },
      order: (opt, side) => sendOrder({ broker, underlying, expiry: data.expiry, strike, opt, side, lots, product, exitDefaults }),
      close: p => sendClose(p),
      setExit,
      blockedWhy: !armed ? 'Arm live trading first' : blocked,
      level: {
        on: levelOn.has(`${underlying}:${strike}`),
        toggle: () => toggleLevel(`${underlying}:${strike}`),
        entries: entriesByStrike.get(strike) ?? [],
        spot: liveSpot, priceName: levelPriceName, lots, product, exitText,
        arm: (opt, side, level, expect) => arm({ broker, underlying, expiry: data.expiry, strike, opt, side, lots, product, exitDefaults, level, expect }),
        cancel: cancelEntry,
      },
    };
  }, [tradeMode, data, posByKey, armed, tradable, blocked, session, inflight, underlying, broker, sendOrder, sendClose, setExit, lots, product, ts, tsView, exitDefaults,
    levelOn, toggleLevel, entriesByStrike, liveSpot, levelPriceName, exitText, arm, cancelEntry]);
  const showTradeBar = !!(data && ts);
  const openCount = ts ? ts.positions.filter(p => p.netQty !== 0).length : 0;
  const setLotsPref = (n: number) => { setLots(n); writePref(PREF_LOTS, String(n)); };
  const setProductPref = (p: FmProduct) => { setProduct(p); writePref(PREF_PRODUCT, p); };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur sm:px-6">
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
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Underlying" className="flex max-w-full overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
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
          {data?.closeOi ? (
            <span data-testid="fm-oi-source" className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-300"
              title={`OI change, Total OI and Δ OI use the exchange's official end-of-day OI for ${data.date} (Dhan, fetched ${data.closeOi.fetchedAt}),`
                + ` on ${data.closeOi.official} of ${data.closeOi.total} strike sides; the rest show the last in-session reading.`
                + ' The 3m slots stay on in-session readings (to the close).'}>
              OI · official close{data.closeOi.official < data.closeOi.total ? ` (${data.closeOi.official}/${data.closeOi.total})` : ''}
            </span>
          ) : data && data.market === 'NSE' && (!data.isToday || sessionOver) && (
            <span data-testid="fm-oi-source" className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-400"
              title={`Dhan revises option OI after the close (often a few % lower). This is the last reading of the session (${data.lastTs.slice(11)});`
                + ' the official close OI loads on the next trading morning when the IV snapshot collector starts.'}>
              OI · last session reading
            </span>
          )}
          {sessionOver && (
            <span data-testid="fm-closed" className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-300"
              title={`The ${data!.market} session closed at ${fmtHm(day.to)}: the slots and today's change stop there, and the board no longer moves`}>
              Closed · final {fmtHm(day.to)}
            </span>
          )}
          {/* Exit all lives in the trade bar, beside the P&L it acts on. When the bar is not shown (no board loaded, trade
              state not in yet) it stays here, so it is reachable whenever this page holds a position. */}
          {!showTradeBar && <ExitAllButton count={openCount} busy={trades.exitingAll} onExit={trades.exitAll} />}
          <span className="h-5 w-px shrink-0 bg-zinc-800" />
          <div className="max-w-full overflow-x-auto"><NavBar /></div>
        </div>
      </div>

      {/* The flow tab adds an 11-cell block on each side (board min-width 1980 / 1596 px + paddings), so the page widens
          with it instead of making the call cells scroll off to the right. */}
      <div className={`mx-auto flex w-full ${oiMode === 'flow'
        ? (tradeMode ? 'max-w-[2104px]' : 'max-w-[1720px]')
        : (tradeMode ? 'max-w-[1640px]' : 'max-w-[1400px]')} flex-1 flex-col gap-3 px-4 py-5 sm:px-6`}>
        {isStale && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            The {collectorName} has not written for {staleMin} min. The board shows its last snapshot.
          </div>
        )}
        {ts?.nrmlWarning && (
          <div role="alert" data-testid="fm-nrml-warning" className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {ts.nrmlWarning}
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
                product={product} onProduct={setProductPref}
                maxLots={ts.maxLots} lotSize={data.lot} mcxMult={data.mult} tradable={tradable} blocked={blocked} positions={underlyingPositions}
                broker={broker} onBroker={setBroker} brokerReady={brokerReady} brokerSessions={ts.brokers ?? null}
                exitDefaults={exitDefaults} onExitDefaults={pickExitDefaults}
                exitWatcher={ts.exitWatcher ?? null} hasExits={Object.keys(ts.exits ?? {}).length > 0}
                globalExit={ts.global ?? null} allPositions={tsView?.positions ?? ts.positions} onSetGlobal={trades.setGlobal}
                exitAll={<ExitAllButton count={openCount} busy={trades.exitingAll} onExit={trades.exitAll} />}
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
              {oiMode !== 'flow' && (
                // The bar / tag legend is static text: shown on demand (the slots tab keeps its own one-line legend).
                <button type="button" onClick={toggleFlowHelp} aria-label="How to read the board" aria-expanded={flowHelp}
                  title="How to read the bars and tags"
                  className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70">
                  <CircleHelp className="h-3.5 w-3.5" /> How to read
                </button>
              )}
              <button type="button" onClick={toggleSound} aria-pressed={!soundOn}
                aria-label={soundOn ? 'Mute Fresh Money sounds' : 'Unmute Fresh Money sounds'}
                title={soundOn ? 'Sounds on (trades, board-wide streaks) — click to mute. They play after your first click on the page.' : 'Sounds muted — toasts still show'}
                className={`ml-auto flex h-6 w-6 items-center justify-center rounded border border-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 ${soundOn ? 'text-zinc-300' : 'text-zinc-500'}`}>
                {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              </button>
              <button type="button" aria-pressed={showPcr} onClick={toggleShowPcr}
                title={showPcr ? 'Hide the PCR column' : 'Show each strike\'s PCR (put OI ÷ call OI) beside the strike, as Dhan\'s option chain does'}
                className={`rounded-md border border-zinc-800 px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  showPcr ? 'bg-zinc-700 text-white' : 'bg-zinc-950/40 text-zinc-400 hover:text-zinc-200'}`}>
                PCR
              </button>
              <button type="button" aria-pressed={showPrice} onClick={toggleShowPrice}
                title={showPrice ? 'Hide the option prices' : 'Show each strike\'s put and call last price beside the strike (board snapshot, ~30 s)'}
                className={`rounded-md border border-zinc-800 px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  showPrice ? 'bg-zinc-700 text-white' : 'bg-zinc-950/40 text-zinc-400 hover:text-zinc-200'}`}>
                Price
              </button>
              {canUnits && (
                <div role="group" aria-label="OI unit" className="flex rounded-md border border-zinc-800 bg-zinc-950/40 p-0.5">
                  {([[false, 'Lots'], [true, 'Units']] as const).map(([on, name]) => (
                    <button key={name} type="button" aria-pressed={oiUnits === on} onClick={() => pickOiUnits(on)}
                      title={on ? `OI in units (lots × ${rawData!.lot}), as Dhan's option chain shows it` : 'OI in lots (contracts), as NSE reports it'}
                      className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                        oiUnits === on ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
              {oiMode === 'flow' && (
                <div role="group" aria-label="Slot cells show" className="flex rounded-md border border-zinc-800 bg-zinc-950/40 p-0.5">
                  {([['numbers', 'Numbers', 'Exact OI change in each slot, tinted in three steps by size'],
                    ['heat', 'Heat', 'Colour only: green = OI added, red = OI cut, stronger = bigger. Hover a cell for its number'],
                    ['both', 'Both', 'The numbers on the smooth colour gradient']] as const).map(([v, name, tip]) => (
                    <button key={v} type="button" aria-pressed={flowView === v} onClick={() => pickFlowView(v)} title={tip}
                      className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                        flowView === v ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <div role="tablist" aria-label="Bars and numbers show" className="flex rounded-md border border-zinc-800 bg-zinc-950/40 p-0.5">
                {([['change', 'OI change'], ['total', 'Total OI'], ['both', 'OI + Δ'], ['delta', 'Δ OI'], ['flow', `${fs.slotMin}m slots`]] as const).map(([m, name]) => (
                  <button key={m} type="button" role="tab" aria-selected={oiMode === m} onClick={() => pickOiMode(m)}
                    title={m === 'change' ? "Today's change in open interest vs the previous close"
                      : m === 'total' ? 'Open interest outstanding now'
                      : m === 'both' ? "Total OI as one bar with today's change coloured in it: dim = held since the previous close, bright = added today, dashed tail = cut today"
                      : m === 'delta' ? 'Call OI − Put OI (total OI outstanding) at each strike'
                      : `OI added or cut in fixed ${fs.slotMin}-minute slots counted from the session open: the last ${nSlots} completed slots (frozen)${fs.closed ? ', ending at the close' : ' and the running one'}`}
                    className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                      oiMode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                    {name}
                  </button>
                ))}
              </div>
              </div>
              <div className={`mt-0.5 text-[11.5px] ${oiMode === 'flow' ? 'text-zinc-300' : 'text-zinc-400'}`}>
                {oiMode === 'flow' ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {/* One-line legend; the full explanation is behind "?". */}
                    {flowView !== 'numbers' && !(flowCellScale > 0) ? (
                      <span data-testid="fm-heat-legend" className="text-zinc-400">no slot readings yet — nothing to colour</span>
                    ) : flowView !== 'numbers' ? (
                      <span data-testid="fm-heat-legend" className="flex items-center gap-1.5"
                        title={`Colour strength = the slot's OI change against this board's 95th-percentile move (${fmtOiAbs(flowCellScale)} ${data.oiUnit}); the Σ row uses its own scale`}>
                        <span className="text-red-400">cut −{fmtOiShort(flowCellScale).replace(/^[+-]/, '')}</span>
                        <span aria-hidden className="h-2.5 w-28 rounded-sm"
                          style={{ background: `linear-gradient(to right, ${heatBg('down', 1)}, ${heatBg('down', 0.1)} 45%, transparent 45%, transparent 55%, ${heatBg('up', 0.1)} 55%, ${heatBg('up', 1)})` }} />
                        <span className="text-emerald-400">+{fmtOiShort(flowCellScale).replace(/^[+-]/, '')} added</span>
                        <span className="text-zinc-400">· blank = noise &lt;10 %</span>
                      </span>
                    ) : ([['none', 'noise <10 %'], ['low', 'small'], ['mid', 'medium'], ['high', 'big ≥70 %']] as const).map(([t, name]) => (
                      <span key={t} className="flex items-center gap-1">
                        {t === 'none'
                          ? <span className="rounded-sm px-1 text-[10px] text-zinc-500">+9</span>
                          : <><span className={`rounded-sm px-1 text-[10px] ${TINT.up[t]}`}>+2k</span><span className={`rounded-sm px-1 text-[10px] ${TINT.down[t]}`}>-2k</span></>}
                        <span>{name}</span>
                      </span>
                    ))}
                    <span><span className="font-bold text-emerald-400">▲n</span> / <span className="font-bold text-red-400">▼n</span> n slots in a row</span>
                    <span><span className="font-bold text-amber-400">▼n</span> against today&apos;s net</span>
                    <span title="The strike with the most put / call OI added since the previous close, on the board shown"><span className="text-amber-400">★</span> most OI added</span>
                    {!fs.closed && <span className="flex items-center gap-1"><span className="rounded-sm px-1 text-[10px] italic ring-1 ring-inset ring-zinc-500">+1k</span> live slot</span>}
                    <span>number = OI Δ today @ {fs.dayAt ?? '–'} <span className="text-zinc-500">(grey = cut)</span></span>
                    <button type="button" onClick={toggleFlowHelp} aria-label="How to read the slots" aria-expanded={flowHelp}
                      title="How to read the slots"
                      className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70">
                      <CircleHelp className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : !flowHelp ? null : oiMode === 'delta' ? (
                  <>Bar = Call OI − Put OI (total OI, in {data.oiUnit}) · <span className="text-red-400">red = calls heavier</span> ·{' '}
                    <span className="text-emerald-400">green = puts heavier</span></>
                ) : (
                  oiMode === 'both' ? (
                    <>Bar = total OI · <span className="text-zinc-300">dim</span> = held since the previous close ·{' '}
                      <span className="font-bold text-zinc-200">bright</span> = added today · dashed tail = cut today · small number = today&apos;s change</>
                  ) : <>{oiMode === 'total' ? 'Bar = total OI (fill still from today\'s change)' : 'Bar = OI moved'} · filled = building, outline = leaving</>
                )}
              </div>
              {oiMode === 'flow' && flowHelp && (
                <div className="mt-1 space-y-0.5 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-[11.5px] text-zinc-300">
                  <p>Each cell is the OI change ({data.oiUnit}) in one {fs.slotMin}-minute slot counted from the open ({data.market === 'MCX' ? '09:00' : '09:15'}).
                    Completed slots are frozen; the ringed, italic cell next to the strike is the current slot so far (after the close there is none:
                    the slots stop at the close, so OI the chain moves after the bell is not counted). – = no OI reading at a slot edge.
                    On a narrower screen the oldest slots are left out. The grey cell at the outer end (headed &lt;HH:MM) is everything
                    before that time, so that cell + the completed slots = the number beside the strike, exactly.
                    Hover a cell for today&apos;s OI change as of that slot&apos;s end.</p>
                  <p>Tint = size of the move against this board&apos;s 95th-percentile move: grey under 10 %, then faint, medium, and bold white on a
                    strong tint for the biggest moves (≥ 70 %). Green = OI added, red = OI cut.
                    Numbers / Heat / Both: Heat hides the numbers and colours each cell on a smooth scale (blank = under 10 %, full colour
                    at the 95th-percentile move or more); Both keeps the numbers on that colour. The exact figure is always in the hover.
                    <span className="text-amber-400"> ★</span> = the strike with the most put / call OI added since the previous close on the board.</p>
                  <p>The number and bar beside the strike = today&apos;s OI change vs the previous close as of the last completed slot with a reading
                    ({fs.dayAt ?? '–'}); each slot that completes adds its cell to it. Filled bar = net added today, outline = net cut; a cut also turns the number grey.</p>
                  <p><span className="font-bold text-emerald-400">▲n</span> / <span className="font-bold text-red-400">▼n</span> = the last n completed slots
                    all added / all cut OI (tinted moves only, runs of 3+). <span className="font-bold text-amber-400">Amber</span> = that run goes against
                    today&apos;s net (built all day, now unwinding, or the reverse): a possible turn.</p>
                  <p>Σ shown = the same for the whole board (the {Math.max(flowTotals.put.n, flowTotals.call.n)} strikes with data, not the whole chain), on its
                    own tint scale; a slot that some strikes have no reading for is left blank rather than summed short.
                    Hover a cell to highlight its strike and its slot across the board.</p>
                  <p>On a short window the ladder scrolls inside its own box, so the slot times and Σ row stay pinned at its top.</p>
                </div>
              )}
              {flowHelp && oiMode !== 'delta' && oiMode !== 'flow' && <div className="mt-0.5 text-[11px] text-zinc-500">
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
              rowTrade={rowTrade} spot={spot} liveSpot={liveSpot} totals={flowTotals} scale={flowCellScale} view={flowView} showPcr={showPcr} showPrice={showPrice}
              livePrices={data.isToday ? liveQ?.optionLtps ?? null : null}
              today={data.isToday && liveQ ? { high: liveQ.dayHigh ?? null, low: liveQ.dayLow ?? null } : null} />

          </div>
        )}

        {/* Positions sit right under the board: mid-trade they matter more than the chart below. */}
        {ts && (
          <PositionsOrders
            state={tsView} broker={broker} armed={armed} inflight={inflight} onClose={sendClose} onSetExit={setExit} onCancelEntry={cancelEntry}
            collapsed={posCollapsed} onToggle={togglePos}
            canClose={p => (ts.sessions[p.underlying]?.gate ?? 'closed') !== 'closed' && !!ts.brokers?.[p.broker]}
          />
        )}

        {/* Cumulative OI over the day (ATM ± strikes), the same widget the Scalp Cockpit uses. It fills its parent's
            height. Collapsible (remembered): only the header row stays. */}
        {data && (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            {/* The widget carries its own title, so the bar names the chart only while it is hidden. */}
            <div className="flex items-center gap-2 px-4 pt-2">
              <CollapseToggle collapsed={chartCollapsed} onToggle={toggleChart} label="cumulative OI chart" controls="fm-chart-body" />
              <span className="text-[11px] text-zinc-500">{chartCollapsed ? 'Cumulative OI chart (hidden)' : 'Hide chart'}</span>
            </div>
            {chartCollapsed ? <div className="h-2" /> : (
              <div id="fm-chart-body" className="h-[340px] px-4 pb-3 pt-2">
                <CumulativeOiWidget key={underlying} underlying={underlying} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
