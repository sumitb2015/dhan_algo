'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, BellOff, CarFront, Lock, LockOpen, Pause, Play } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { istClock, istMinuteOfDay } from '@/lib/istTime';
import { istDateIso } from '@/lib/nseHolidays';
import { hhmmToMin } from '@/lib/gearboxBars';
import { targetLabel } from '@/lib/pnfTarget';
import type { GbMode, GbRow, GbUnderlying } from '@/lib/gearboxLedger';
import { cn } from '@/lib/utils';
import { Cluster } from './Cluster';
import { DirectionMap } from './DirectionMap';
import { RoadScene } from './RoadScene';
import { RulesPanel } from './RulesPanel';
import { Scoreboard } from './Scoreboard';
import { FOCUS_RING, RiskPanel, TradeStrip } from './TradeStrip';
import { TradesTable } from './TradesTable';
import { TripLog } from './TripLog';
import { useGearboxEngine } from './useGearboxEngine';

// /gearbox — Gearbox Drive: the driving game on the live CRUDEOIL(M) future. The road, gears and lamps read the future's closed bars
// (lib/gearbox.ts); ↑ / ↓ buy the option the direction map names, through the server (lib/gearboxCore.ts). REAL MONEY in REAL mode:
// Dhan only, 1 lot, armed per page load. Keys ↑ / ↓ / X trade (never on key repeat or while typing); Space only pauses the scene.

const CHIP = 'whitespace-nowrap rounded border px-2 py-0.5 font-mono text-[10px] font-bold';

function useHotkeys(on: { up: () => void; down: () => void; exit: () => void; space: () => void }) {
  const ref = useRef(on);
  useEffect(() => { ref.current = on; });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); if (!e.repeat) ref.current.space(); return; }
      if (e.repeat) { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault(); return; }   // a held key never sends twice
      if (e.key === 'ArrowUp') { e.preventDefault(); ref.current.up(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); ref.current.down(); }
      else if (e.key === 'x' || e.key === 'X') ref.current.exit();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

export default function GearboxPage() {
  const e = useGearboxEngine();
  const [paused, setPaused] = useState(false);
  const { config, mode, held, states } = e;
  const s = states.length ? states[states.length - 1] : null;
  const real = mode === 'REAL';

  useHotkeys({ up: () => void e.open('LONG'), down: () => void e.open('SHORT'), exit: () => void e.exit(), space: () => setPaused(p => !p) });

  const switchMode = useCallback((m: GbMode) => { if (m !== mode) void e.setMode(m); }, [e, mode]);

  const lastBar = e.feed.bars[e.feed.bars.length - 1];
  const dataDate = lastBar ? istDateIso(lastBar.t * 1000) : null;
  const sess = e.session;
  const nowMin = e.now ? istMinuteOfDay(e.now) : 0;
  const toSq = sess && sess.open !== sess.close ? hhmmToMin(sess.autoExit) - nowMin : null;
  const sqText = !sess ? '' : sess.open === sess.close ? (sess.note ?? 'MCX closed') : toSq !== null && toSq > 0
    ? `square-off ${sess.autoExitLabel} · in ${Math.floor(toSq / 60)}h ${String(toSq % 60).padStart(2, '0')}m` : `square-off ${sess.autoExitLabel} · passed`;
  const ltpOf = (r: GbRow) => e.prices?.rows[r.id]?.ltp ?? r.lastLtp ?? null;
  const unrealPts = held && e.heldLtp !== null ? (held.leg.action === 'BUY' ? e.heldLtp - held.entry : held.entry - e.heldLtp) : null;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/10">
            <CarFront className="h-4 w-4 text-amber-400" />
          </div>
          <div>
            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-amber-400">Scalping · MCX options</p>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">Gearbox Drive</h1>
            <p className="mt-1 text-[10px] font-medium text-zinc-500">
              {e.state?.future ? `${targetLabel(e.state.future)} drives the road` : 'resolving the future…'} · EMA gears on closed bars
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Underlying" value={config?.underlying ?? 'CRUDEOILM'} disabled={!config || !!held}
            title={held ? 'Locked while a leg is held' : 'Underlying'}
            onChange={ev => { e.disarm(); void e.setConfig({ underlying: ev.target.value as GbUnderlying }); }}
            className={cn('h-7 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 disabled:opacity-50', FOCUS_RING)}>
            <option value="CRUDEOILM">CRUDEOILM</option><option value="CRUDEOIL">CRUDEOIL</option>
          </select>
          <div className="flex items-center rounded-md border border-zinc-700 bg-zinc-900 p-0.5" role="group" aria-label="Timeframe">
            {([1, 3, 5] as const).map(t => (
              <button key={t} type="button" aria-pressed={config?.tf === t} disabled={!config} onClick={() => void e.setConfig({ tf: t })}
                className={cn('rounded px-2 py-0.5 text-xs font-bold', config?.tf === t ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200', FOCUS_RING)}>
                {t}m
              </button>
            ))}
          </div>
          <span className={cn(CHIP, 'border-zinc-700 text-zinc-300')} title="REAL is Dhan only in Gearbox Drive">DHAN</span>
          <div className="flex items-center rounded-md border border-zinc-700 bg-zinc-900 p-0.5" role="group" aria-label="Mode">
            {(['SIM', 'REAL'] as const).map(m => (
              <button key={m} type="button" aria-pressed={mode === m} disabled={!config || !!held} onClick={() => switchMode(m)}
                title={held ? 'Mode is locked while a leg is held' : m === 'SIM' ? 'Paper trades at the option LTP' : 'Real Dhan orders, 1 lot, armed per page load'}
                className={cn('rounded px-2 py-0.5 text-xs font-bold disabled:cursor-not-allowed', mode === m ? (m === 'REAL' ? 'bg-red-600 text-oncolor' : 'bg-zinc-700 text-zinc-100') : 'text-zinc-400 hover:text-zinc-200', FOCUS_RING)}>
                {m}
              </button>
            ))}
          </div>
          {real && (e.realArmed ? (
            <button type="button" onClick={e.disarm} aria-label="Disarm real money"
              className={cn('flex items-center gap-1 rounded-md border border-red-500/60 bg-red-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-red-300 hover:bg-red-500/25', FOCUS_RING)}>
              <LockOpen className="h-3.5 w-3.5" /> Armed
            </button>
          ) : (
            <button type="button" onClick={e.armReal}
              className={cn('flex items-center gap-1 rounded-md border border-red-500/60 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-red-300 hover:bg-red-500/15', FOCUS_RING)}>
              <Lock className="h-3.5 w-3.5" /> Arm real money
            </button>
          ))}
          <span className={cn(CHIP, e.feedFresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/40 bg-amber-500/10 text-amber-400')}
            title={e.feedFresh ? 'Futures price is live' : 'No fresh futures price - entries are paused (exits still work)'}>
            {e.feedFresh ? 'LIVE' : 'STALE'}
          </span>
          <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300">
            DATA: {dataDate ?? '—'}{dataDate && e.state && dataDate !== e.state.today ? ' · last session' : ''}
          </span>
          <span className="font-mono text-[10px] text-zinc-400" title="IST clock and the MCX square-off">
            {e.now ? istClock(e.now) : '—'} IST{sqText ? ` · ${sqText}` : ''}
          </span>
          <button type="button" onClick={() => e.setChime(!e.chime)} aria-pressed={e.chime}
            aria-label={e.chime ? 'Mute the Shift-up chime' : 'Chime on Shift up'} title={`Shift-up chime ${e.chime ? 'on' : 'off'} (rings in the leader tab; click the page once after a reload)`}
            className={cn('rounded-md border border-zinc-700 bg-zinc-900 p-1 hover:bg-zinc-800', e.chime ? 'text-zinc-100' : 'text-zinc-500', FOCUS_RING)}>
            {e.chime ? <BellRing className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
          </button>
          <span className="h-5 w-px shrink-0 bg-zinc-800" />
          <NavBar />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-4 px-6 py-5">
        {(e.error || e.feed.loadError) && (
          <button type="button" onClick={() => e.setError(null)} role="alert"
            className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-left text-xs text-red-300">
            {e.error ?? e.feed.loadError} <span className="text-zinc-500">✕</span>
          </button>
        )}
        <div className={cn('overflow-hidden rounded-2xl border bg-zinc-900', real ? 'border-red-500/50' : 'border-zinc-800')}>
          <div className="relative h-[clamp(240px,40vh,400px)]">
            <RoadScene states={states} held={held?.status === 'open' || held?.status === 'closing' ? held.dir : null} paused={paused} />
            <div className="pointer-events-none absolute left-3 right-3 top-2.5 flex flex-wrap justify-between gap-2">
              <span className="rounded-full bg-zinc-950/80 px-3 py-1 text-sm font-semibold text-zinc-100">
                {s ? `${istDateIso(s.t * 1000)} · ${istClock(s.t * 1000).slice(0, 5)}` : 'Waiting for bars'} · {config?.tf ?? 5}m
              </span>
              <span className="rounded-full bg-zinc-950/80 px-3 py-1 text-sm font-semibold text-zinc-100">
                {!held ? 'Flat' : <>{held.dir === 'LONG' ? 'Long' : 'Short'} · <b className={unrealPts === null ? 'text-zinc-400' : unrealPts >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {unrealPts === null ? '—' : `${unrealPts > 0 ? '+' : ''}${unrealPts.toFixed(2)} pts`}</b></>}
              </span>
            </div>
            <button type="button" onClick={() => setPaused(p => !p)} aria-label={paused ? 'Resume the animation' : 'Pause the animation'} aria-pressed={paused}
              title="Pause only stops the animation (Space); prices, the gearbox and your SL / target keep running"
              className={cn('absolute bottom-2.5 right-3 rounded-full bg-zinc-950/80 p-1.5 text-zinc-200 hover:bg-zinc-900', FOCUS_RING)}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
          </div>
          <div className="flex flex-col gap-4 border-t border-zinc-800 bg-zinc-900 px-5 pb-5 pt-4">
            <Cluster s={s} />
            <TradeStrip e={e} />
            <DirectionMap e={e} />
            <RiskPanel e={e} />
            <Scoreboard ledger={e.ledger} mode={mode} today={e.state?.today ?? ''} heldPnl={e.heldPnl} states={states} ghost={e.ghost} />
            <TripLog states={states} ghost={e.ghost} log={e.ledger?.log ?? []} tf={config?.tf ?? 5} />
          </div>
        </div>
        <section aria-label="Today's trades" className="flex flex-col gap-2">
          <h2 className="text-sm font-bold text-zinc-100">Today&apos;s trades</h2>
          <TradesTable ledger={e.ledger} today={e.state?.today ?? ''} ltpOf={ltpOf} />
        </section>
        <RulesPanel session={sess} />
      </div>
    </div>
  );
}
