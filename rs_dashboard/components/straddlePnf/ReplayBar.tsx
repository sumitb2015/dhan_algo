'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronFirst, CalendarDays, History, Pause, Play, Scissors, Shuffle, SkipForward, StepForward, X } from 'lucide-react';
import { REPLAY_SPEEDS, type ReplaySpeed } from '@/lib/pnfReplay';
import { crosshairStamp } from '@/lib/straddlePnfTimeAxis';

// The Bar Replay bar of the P&F / Renko page, laid out like TradingView's: start point (Select bar ▾), Play / Pause, Forward,
// speed, the step interval, Jump to real time; then PRACTICE trading at the replayed price (Sell [qty] Buy, Flatten) and its P&L.

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';
const BTN = `inline-flex items-center justify-center gap-1.5 h-8 px-2 rounded-md text-xs font-semibold text-zinc-200 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:pointer-events-none ${FOCUS_RING}`;
const MENU = 'absolute bottom-10 z-50 min-w-48 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl';
const ITEM = `flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800 ${FOCUS_RING}`;
const inr = (n: number) => `${n < 0 ? '-' : n > 0 ? '+' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/** Closes a popup on a press outside it. */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close]);
  return ref;
}

export interface ReplayPractice {
  /** Why practice trading is not possible on the active chart (an index), or null. */
  blocked: string | null;
  lots: number;
  onLots: (n: number) => void;
  onBuy: () => void;
  onSell: () => void;
  onFlatten: () => void;
  /** "LONG 2L @ 22,650.00" or "FLAT". */
  position: string;
  pnl: number;
  trades: number;
}

export interface ReplayBarProps {
  picking: boolean;
  cursorT: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  ended: boolean;
  /** A saved session for these charts (offered as Continue). */
  savedCursorT: number | null;
  /** The time of the active chart's last bar: Select date starts on that day. */
  dataEndT: number | null;
  /** The step: one bar of the active chart's interval ("1 min", "1 day"). */
  stepLabel: string;
  onPickBar: () => void;
  onSelectDate: (t: number) => void;
  onFirst: () => void;
  onRandom: () => void;
  onContinue: () => void;
  onTogglePlay: () => void;
  onStep: () => void;
  onSpeed: (s: ReplaySpeed) => void;
  onRealtime: () => void;
  onClose: () => void;
  practice: ReplayPractice;
}

const istParts = (t: number) => { const iso = new Date((t + 19_800) * 1000).toISOString(); return { d: iso.slice(0, 10), tm: iso.slice(11, 16) }; };

/** Practice lots: free-typed, applied on Enter / blur (1-100); re-keyed on the applied value, so the draft restarts from it. */
function LotsInput({ lots, onLots }: { lots: number; onLots: (n: number) => void }) {
  const [draft, setDraft] = useState(String(lots));
  const commit = () => {
    const n = Math.floor(Number(draft));
    if (Number.isFinite(n) && n >= 1 && n <= 100) { if (n !== lots) onLots(n); } else setDraft(String(lots));
  };
  return (
    <input aria-label="Practice lots" inputMode="numeric" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
           onKeyDown={e => { if (e.key === 'Enter') commit(); }}
           className="h-7 w-11 rounded border border-zinc-700 bg-zinc-900 text-center text-xs font-semibold text-zinc-100" />
  );
}

export default function ReplayBar(p: ReplayBarProps) {
  const [startOpen, setStartOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const startRef = useOutside(startOpen, () => setStartOpen(false));
  const dateRef = useOutside(dateOpen, () => setDateOpen(false));
  const speedRef = useOutside(speedOpen, () => setSpeedOpen(false));
  // Date / time / lots are drafts: nothing moves until Go / Enter / blur (a half-typed date must not jump the replay).
  const [date, setDate] = useState(() => istParts(p.cursorT ?? p.dataEndT ?? 0).d);
  const [time, setTime] = useState('09:15');
  const goDate = () => {
    const t = Date.parse(`${date}T${time || '09:15'}:00+05:30`) / 1000;
    if (Number.isFinite(t)) { p.onSelectDate(t); setDateOpen(false); }
  };
  const on = p.cursorT !== null && !p.picking;
  const speedLabel = REPLAY_SPEEDS.find(s => s.id === p.speed)?.id ?? p.speed;

  return (
    <div data-testid="pnf-replay-bar" role="toolbar" aria-label="Bar replay"
         className="shrink-0 flex items-center gap-1 flex-wrap px-4 py-1.5 border-t border-sky-500/40 bg-zinc-950">
      <span className="mr-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/15 text-[10px] font-bold uppercase tracking-wider text-sky-300">
        <History className="w-3 h-3" aria-hidden="true" /> Replay
      </span>

      {/* start point */}
      <div ref={startRef} className="relative inline-flex">
        <button type="button" onClick={p.onPickBar} aria-pressed={p.picking} title="Click a bar on the chart to start the replay there"
                className={`${BTN} ${p.picking ? 'bg-sky-500/20 text-sky-200' : ''}`}>
          <Scissors className="w-3.5 h-3.5" aria-hidden="true" /> Select bar
        </button>
        <button type="button" aria-label="More ways to choose the start" aria-expanded={startOpen} onClick={() => setStartOpen(v => !v)} className={`${BTN} px-1`}>
          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        {startOpen && (
          <div className={`${MENU} left-0`} role="menu">
            <button type="button" role="menuitem" className={ITEM} onClick={() => { setStartOpen(false); p.onPickBar(); }}><Scissors className="w-3.5 h-3.5" aria-hidden="true" />Select bar</button>
            <button type="button" role="menuitem" className={ITEM} onClick={() => { setStartOpen(false); setDateOpen(true); }}><CalendarDays className="w-3.5 h-3.5" aria-hidden="true" />Select date…</button>
            <button type="button" role="menuitem" className={ITEM} onClick={() => { setStartOpen(false); p.onFirst(); }}><ChevronFirst className="w-3.5 h-3.5" aria-hidden="true" />Select the first available day</button>
            <button type="button" role="menuitem" className={ITEM} onClick={() => { setStartOpen(false); p.onRandom(); }}><Shuffle className="w-3.5 h-3.5" aria-hidden="true" />Random bar</button>
            {p.savedCursorT !== null && (
              <button type="button" role="menuitem" className={ITEM} onClick={() => { setStartOpen(false); p.onContinue(); }}>
                <History className="w-3.5 h-3.5" aria-hidden="true" />Continue from {crosshairStamp(p.savedCursorT)}
              </button>
            )}
          </div>
        )}
      </div>
      {dateOpen && (
        <div ref={dateRef} className="relative">
          <div className={`${MENU} left-0 flex items-center gap-2 p-2`} role="dialog" aria-label="Choose the replay start">
            <input type="date" aria-label="Replay start date" value={date} onChange={e => setDate(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') goDate(); }}
                   className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1.5 text-xs text-zinc-100" />
            <input type="time" aria-label="Replay start time" value={time} onChange={e => setTime(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') goDate(); }}
                   className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1.5 text-xs text-zinc-100" />
            <button type="button" onClick={goDate} aria-label="Start the replay at this time" className={`${BTN} h-7 bg-sky-600 text-oncolor hover:bg-sky-500`}>Go</button>
          </div>
        </div>
      )}
      {p.savedCursorT !== null && !on && (
        <button type="button" onClick={p.onContinue} className={`${BTN} text-sky-300`} title="Resume the last replay session of these charts">
          <History className="w-3.5 h-3.5" aria-hidden="true" /> Continue {crosshairStamp(p.savedCursorT)}
        </button>
      )}
      <span className="w-px h-5 bg-zinc-800 mx-1" />

      {/* playback */}
      <button type="button" onClick={p.onTogglePlay} disabled={!on || p.ended} aria-label={p.playing ? 'Pause' : 'Play'} title={`${p.playing ? 'Pause' : 'Play'} (Shift + ↓)`} className={BTN}>
        {p.playing ? <Pause className="w-4 h-4" aria-hidden="true" /> : <Play className="w-4 h-4" aria-hidden="true" />}
      </button>
      <button type="button" onClick={p.onStep} disabled={!on || p.ended} aria-label="Forward" title="Forward one bar (Shift + →)" className={BTN}>
        <StepForward className="w-4 h-4" aria-hidden="true" />
      </button>
      <div ref={speedRef} className="relative">
        <button type="button" onClick={() => setSpeedOpen(v => !v)} aria-label={`Replay speed ${speedLabel}`} aria-expanded={speedOpen} className={`${BTN} tabular-nums`}>{speedLabel}</button>
        {speedOpen && (
          <div className={`${MENU} left-0 w-56`} role="menu" aria-label="Replay speed">
            <p className="px-2.5 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Replay speed</p>
            {REPLAY_SPEEDS.map(s => (
              <button key={s.id} type="button" role="menuitemradio" aria-checked={p.speed === s.id} onClick={() => { p.onSpeed(s.id); setSpeedOpen(false); }}
                      className={`${ITEM} justify-between ${p.speed === s.id ? 'bg-zinc-700 text-white' : ''}`}>
                <span className="font-semibold">{s.id}</span><span className="text-zinc-400">{s.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="px-1.5 text-xs font-semibold text-zinc-400" title="One step = one bar of the active chart's interval">{p.stepLabel}</span>
      <button type="button" onClick={p.onRealtime} aria-label="Jump to real-time chart" title="Jump to real-time chart" className={BTN}>
        <SkipForward className="w-4 h-4" aria-hidden="true" />
      </button>
      <span data-testid="pnf-replay-clock" className="ml-1 text-xs font-mono tabular-nums text-zinc-300">
        {p.picking ? 'Click a bar on the chart to start' : p.cursorT !== null ? `${crosshairStamp(p.cursorT)}${p.ended ? ' · end of data' : ''}` : ''}
      </span>

      {/* practice trading at the replayed price: never an order, never a ledger */}
      <div className="ml-auto flex items-center gap-1.5" role="group" aria-label="Practice trading">
        {p.practice.blocked ? (
          <span className="text-xs text-zinc-500">{p.practice.blocked}</span>
        ) : (
          <>
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Practice</span>
            <button type="button" onClick={p.practice.onSell} disabled={!on} className={`${BTN} h-7 px-3 bg-red-600 text-oncolor hover:bg-red-500`}>Sell</button>
            <LotsInput key={p.practice.lots} lots={p.practice.lots} onLots={p.practice.onLots} />
            <button type="button" onClick={p.practice.onBuy} disabled={!on} className={`${BTN} h-7 px-3 bg-emerald-600 text-oncolor hover:bg-emerald-500`}>Buy</button>
            <button type="button" onClick={p.practice.onFlatten} disabled={!on} className={`${BTN} h-7 border border-zinc-700`}>Flatten</button>
            <span data-testid="pnf-replay-position" className="ml-1 text-xs font-mono text-zinc-300">{p.practice.position}</span>
            <span data-testid="pnf-replay-pnl" className={`text-xs font-mono font-bold ${p.practice.pnl > 0 ? 'text-emerald-400' : p.practice.pnl < 0 ? 'text-red-400' : 'text-zinc-400'}`}>
              {inr(p.practice.pnl)}
            </span>
            <span className="text-[10px] text-zinc-500">{p.practice.trades} trade{p.practice.trades === 1 ? '' : 's'}</span>
          </>
        )}
        <button type="button" onClick={p.onClose} aria-label="Close bar replay" title="Close bar replay" className={`${BTN} ml-1`}><X className="w-4 h-4" aria-hidden="true" /></button>
      </div>
    </div>
  );
}
