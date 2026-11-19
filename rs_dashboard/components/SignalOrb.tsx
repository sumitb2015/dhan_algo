'use client';

import { useCallback, useState } from 'react';
import { Bell, BellOff, ChevronDown, ChevronUp, Clock, Info, PauseCircle, Power, Settings2, ShieldAlert, Volume2, VolumeX, X } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { Orb } from '@/components/signalOrb/Orb';
import { OrbDrawer } from '@/components/signalOrb/OrbDrawer';
import { ReplayCard } from '@/components/signalOrb/ReplayCard';
import { useOrbEngine } from '@/components/signalOrb/useOrbEngine';
import { istClock } from '@/lib/istTime';
import { istDateIso } from '@/lib/nseHolidays';
import { expiryLabel } from '@/lib/pnfTarget';
import { cn } from '@/lib/utils';
import { isStuck, type OrbConfig, type OrbRow } from '@/lib/signalOrbLedger';

// /signal-orb: one orb, one switch. CRUDEOILM futures follow the consensus of the active indicators on closed bars — green long,
// red short, gray holds. Real money in REAL mode; the rules and every safety limit live in lib/signalOrb*.ts and
// strategies/signal_orb/strategy.md. The engine runs only while this page is open (leader tab).

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export default function SignalOrb() {
  const e = useOrbEngine();
  const [drawer, setDrawer] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { ledger, live, ev, contract } = e;

  const patch = useCallback(async (p: Partial<OrbConfig>) => setErr(await e.op({ op: 'setConfig', patch: p })), [e]);
  const setMode = useCallback(async (m: 'SIM' | 'REAL') => { setErr(await e.op({ op: 'setMode', mode: m })); e.setArmed(false); }, [e]);
  const toggle = useCallback(async () => {
    if (!ledger) return;
    setErr(await e.op({ op: 'setEngine', active: !ledger.engineActive }));
  }, [e, ledger]);

  const position = !live ? 'FLAT' : live.status === 'open' ? live.side : 'PENDING';
  const stopLevel = live?.status === 'open' && ledger && ledger.config.stopPts > 0
    ? live.side === 'LONG' ? live.entry - ledger.config.stopPts : live.entry + ledger.config.stopPts : null;
  const tfLabel = ledger ? (ledger.config.timeframe === 60 ? '1h' : `${ledger.config.timeframe}m`) : '';
  const real = ledger?.mode === 'REAL';
  const lastBar = e.feed.bars[e.feed.bars.length - 1];
  const dataDate = lastBar ? istDateIso(lastBar.t * 1000) : '—';
  const stuck = !!live && isStuck(live, e.now);
  const unresolved = live && (live.status === 'unknown' || stuck || live.day !== e.today) ? live : null;
  const autoLabel = ledger?.engineActive ? (real && !e.armed ? 'Auto on · not armed' : 'Auto on') : 'Auto off';
  // the engine note, unless it only repeats the switch label
  const note = /^Auto is OFF$/i.test(e.note) ? null : e.note;

  return (
    <div className="relative flex h-dvh min-h-[560px] flex-col overflow-x-hidden overflow-y-auto bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 bg-zinc-950/80 px-4 py-2.5 backdrop-blur sm:px-6">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', ledger?.engineActive ? 'bg-emerald-400' : 'bg-zinc-600')} />
            <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', ledger?.engineActive ? 'bg-emerald-400' : 'bg-zinc-600')} />
          </span>
          <div>
            <h1 className="text-[11px] font-black uppercase tracking-[0.45em] text-zinc-100">Signal Orb</h1>
            <p className="font-mono text-[10px] text-zinc-500">
              {contract ? `${contract.symbol} FUT ${contract.expiry ? expiryLabel(contract.expiry) : ''}` : 'resolving contract…'} · {tfLabel}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span title={e.priceFresh ? 'Live price is updating' : 'No new price for 30 s - entries are paused (exits still run)'}
            className={cn('flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 font-mono text-[10px] font-bold',
              e.priceFresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/40 bg-amber-500/10 text-amber-400')}>
            <span className={cn('h-1.5 w-1.5 rounded-full', e.priceFresh ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden />
            {e.priceFresh ? 'LIVE' : 'STALE'}
          </span>
          {ledger && !e.isLeader && (
            <span title="Another open tab runs the engine; this one only watches" className="whitespace-nowrap rounded border border-zinc-700 px-2 py-0.5 font-mono text-[10px] font-bold text-zinc-400">VIEW ONLY</span>
          )}
          <span className="whitespace-nowrap rounded border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 font-mono text-[10px] font-bold text-zinc-400">DATA: {dataDate}</span>
          {ledger && (
            <span className={cn('whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-widest',
              real ? 'border-red-500/40 bg-red-500/10 text-red-400' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400')}>
              {ledger.mode} · {ledger.config.broker.toUpperCase()}
            </span>
          )}
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Sound">
            <button type="button" onClick={() => e.setTradeSound(!e.tradeSound)} aria-pressed={e.tradeSound}
              aria-label={e.tradeSound ? 'Mute trade chimes' : 'Unmute trade chimes'}
              title={`${(e.tradeSound || e.alertSound) && !e.soundReady ? 'Click anywhere on the page to enable sound. ' : ''}Trade chimes ${e.tradeSound ? 'on' : 'off'}: entry (rising), exit (falling), rejected / unknown order (buzz)${e.isLeader ? '' : ' - automatic trades ring in the engine tab'}`}
              className={cn('relative rounded-l-lg p-1.5 hover:bg-zinc-800', FOCUS, e.tradeSound ? 'text-zinc-200' : 'text-zinc-500')}>
              {e.tradeSound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              {(e.tradeSound || e.alertSound) && !e.soundReady && (
                // browsers keep a page silent until its first click: an amber dot until then (the title says why)
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
              )}
            </button>
            <button type="button" onClick={() => e.setAlertSound(!e.alertSound)} aria-pressed={e.alertSound}
              aria-label={e.alertSound ? 'Mute signal alerts' : 'Unmute signal alerts'}
              title={`Signal alerts ${e.alertSound ? 'on' : 'off'}: orb turns green (arpeggio up), red (down), gray (two level tones); halt, stale feed or a row needing you (buzz)${e.isLeader ? '' : ' - rings in the engine tab only'}`}
              className={cn('rounded-r-lg border-l border-zinc-800 p-1.5 hover:bg-zinc-800', FOCUS, e.alertSound ? 'text-zinc-200' : 'text-zinc-500')}>
              {e.alertSound ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </button>
          </div>
          <button type="button" onClick={() => setDrawer(true)} aria-label="Rules and indicators" title="Rules and indicators"
            className={cn('rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100', FOCUS)}>
            <Settings2 className="h-4 w-4" />
          </button>
          <NavBar />
        </div>
      </header>

      {/* stage */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4">
        {(e.stateError || e.feed.loadError) && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{e.stateError ?? e.feed.loadError}</p>
        )}
        {e.outdated && (
          <div role="alert" className="flex flex-wrap items-center justify-center gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-300">
            <span>This tab is running an older version of the Signal Orb. Its numbers may be wrong and new entries are blocked.</span>
            <button type="button" onClick={() => window.location.reload()}
              className={cn('rounded border border-amber-500/50 px-2.5 py-0.5 hover:bg-amber-500/20', FOCUS)}>Reload</button>
          </div>
        )}
        {ledger?.haltReason && (
          <p className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-300">
            <ShieldAlert className="h-3.5 w-3.5" /> HALTED — {ledger.haltReason}
          </p>
        )}
        {unresolved && (
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <span className="font-bold">
              {unresolved.status === 'unknown' || stuck ? `Order outcome UNKNOWN (${unresolved.side} ${unresolved.lots}) — check the ${unresolved.broker} book, then:` : `Open row from ${unresolved.day} — check the broker, then:`}
            </span>
            {(unresolved.status === 'unknown' || stuck) && (
              <>
                <button type="button" className={cn('rounded border border-amber-500/40 px-2 py-0.5 font-bold hover:bg-amber-500/20', FOCUS)} onClick={async () => setErr(await e.op({ op: 'resolve', id: unresolved.id, as: 'open' }))}>It is open</button>
                <button type="button" className={cn('rounded border border-amber-500/40 px-2 py-0.5 font-bold hover:bg-amber-500/20', FOCUS)} onClick={async () => setErr(await e.op({ op: 'resolve', id: unresolved.id, as: 'failed' }))}>Never filled</button>
              </>
            )}
            <button type="button" className={cn('rounded border border-amber-500/40 px-2 py-0.5 font-bold hover:bg-amber-500/20', FOCUS)} onClick={async () => setErr(await e.op({ op: 'resolve', id: unresolved.id, as: 'closed', price: e.price ?? undefined }))}>It is closed</button>
          </div>
        )}

        <Orb signal={ev.signal} readings={ev.readings} positionLabel={position} busy={e.busy}
          since={ev.sinceT ? istClock(ev.sinceT * 1000).slice(0, 5) : null} progress={1 - e.secsToClose / e.barSecs} secsLeft={e.secsToClose} />

        {/* position: its own element, coloured by side (the orb shows the signal) */}
        <PositionPill live={live} position={position} pnl={e.openPnl} stopLevel={stopLevel}
          onClose={live?.status === 'open' ? () => void e.closeAndStop() : null} />

        {/* readout: the price first, then one chip per indicator */}
        <div className="flex max-w-2xl flex-wrap items-center justify-center gap-1.5">
          <span className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/80 px-2.5 py-0.5 font-mono text-[11px] backdrop-blur">
            <span className="font-bold text-zinc-400">LTP</span>
            <span className="font-bold tabular-nums text-zinc-100">{e.price === null ? '—' : e.price.toLocaleString('en-IN')}</span>
          </span>
          {ev.readings.map(r => (
            <span key={r.id} className={cn('flex items-center gap-1.5 rounded-full border bg-zinc-950/70 px-2.5 py-0.5 font-mono text-[11px] backdrop-blur',
              r.vote === 1 ? 'border-emerald-500/40 text-emerald-300' : r.vote === -1 ? 'border-red-500/40 text-red-300' : 'border-zinc-700 text-zinc-400')}>
              <span aria-hidden className="text-[9px]">{r.vote === 1 ? '▲' : r.vote === -1 ? '▼' : '●'}</span>
              <span className="font-bold">{r.label}</span>
              <span className="tabular-nums text-zinc-400">{r.value}</span>
              <span className="sr-only">{r.vote === 1 ? 'bullish' : r.vote === -1 ? 'bearish' : 'neutral or warming up'}</span>
            </span>
          ))}
          {!ev.readings.length && <span className="text-xs text-zinc-500">No indicators — open the rules to add one</span>}
        </div>

        {/* control capsule: the switch, what it is doing, and REAL's arm */}
        <div className="flex items-center gap-3 rounded-full border border-zinc-800 bg-zinc-950/80 py-1.5 pl-1.5 pr-5 backdrop-blur">
          <button type="button" onClick={toggle} disabled={!ledger} aria-pressed={!!ledger?.engineActive}
            aria-label={ledger?.engineActive ? 'Turn auto-trading off' : 'Turn auto-trading on'}
            className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-40', FOCUS,
              ledger?.engineActive ? 'border-emerald-400 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200')}>
            <Power className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className={cn('text-[10px] font-black uppercase tracking-[0.35em]', ledger?.engineActive ? 'text-emerald-300' : 'text-zinc-400')}>{autoLabel}</p>
            <p className="flex max-w-[22rem] items-center gap-1.5 font-mono text-[11px] text-zinc-400" aria-live="polite">
              <NoteIcon note={note} active={!!ledger?.engineActive} />
              <span className="truncate">{note ?? 'Turn on to follow the orb'}</span>
            </p>
          </div>
          {real && !e.armed && ledger?.engineActive && (
            <button type="button" onClick={() => e.setArmed(true)}
              className={cn('ml-1 whitespace-nowrap rounded-full border border-red-500/60 bg-red-500/15 px-3 py-1 text-[10px] font-black uppercase tracking-[0.25em] text-red-300 hover:bg-red-500/25', FOCUS)}>
              Arm real money
            </button>
          )}
        </div>
      </main>

      {/* dock: today's numbers and the replay, one bar pinned above the log */}
      {ledger && (
        <section aria-label="Today and replay" className="relative z-10 border-t border-zinc-900 bg-zinc-950/85 px-4 py-2 backdrop-blur sm:px-6">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11px] text-zinc-500">
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">Today</span>
              <span>Realised <strong className={e.realised >= 0 ? 'text-emerald-400' : 'text-red-400'}>{inr(e.realised)}</strong></span>
              <span>Stop <strong className="text-zinc-300">{ledger.config.stopPts || 'off'}</strong>{ledger.config.stopPts ? ' pts' : ''}</span>
              <span>Limit <strong className="text-zinc-300">₹{ledger.config.dailyLossLimit.toLocaleString('en-IN')}</strong></span>
            </div>
            <span className="hidden h-4 w-px bg-zinc-800 md:block" aria-hidden />
            <ReplayCard r={e.replayed} tf={ledger.config.timeframe} bare />
          </div>
        </section>
      )}

      {/* log ribbon */}
      {ledger && (
        <footer className="relative z-10 border-t border-zinc-900 bg-zinc-950/80 backdrop-blur">
          <button type="button" onClick={() => setLogOpen(o => !o)} aria-expanded={logOpen}
            className={cn('flex w-full items-center justify-between px-4 py-2 text-[10px] font-bold uppercase tracking-[0.3em] text-zinc-500 hover:text-zinc-300 sm:px-6', FOCUS)}>
            <span className="truncate normal-case tracking-normal font-mono">
              {ledger.log.length ? `${istClock(ledger.log[ledger.log.length - 1].at)}  ${ledger.log[ledger.log.length - 1].msg}` : 'No activity yet'}
            </span>
            {logOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronUp className="h-3.5 w-3.5 shrink-0" />}
          </button>
          {logOpen && (
            <ul className="max-h-56 overflow-y-auto px-4 pb-3 font-mono text-[11px] sm:px-6">
              {[...ledger.log].reverse().slice(0, 20).map((l, i) => (
                <li key={`${l.at}-${i}`} className={cn('py-0.5', l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : l.level === 'trade' ? 'text-zinc-100' : 'text-zinc-400')}>
                  <span className="text-zinc-600">{istClock(l.at)}</span> {l.msg}
                </li>
              ))}
            </ul>
          )}
        </footer>
      )}

      {ledger && e.state && (
        <OrbDrawer open={drawer} onClose={() => setDrawer(false)} ledger={ledger} locked={!!live} maxLots={e.state.maxLots} replayed={e.replayed}
          onPatch={patch} onMode={setMode} onResetSim={async () => setErr(await e.op({ op: 'resetSim' }))} error={err} />
      )}
      {err && !drawer && (
        <button type="button" onClick={() => setErr(null)} className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-red-500/40 bg-zinc-950 px-3 py-1.5 text-xs text-red-300 shadow-lg">
          {err} ✕
        </button>
      )}
    </div>
  );
}

function PositionPill({ live, position, pnl, stopLevel, onClose }: {
  live: OrbRow | null; position: 'LONG' | 'SHORT' | 'FLAT' | 'PENDING'; pnl: number | null; stopLevel: number | null; onClose: (() => void) | null;
}) {
  if (!live) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/80 px-4 py-1.5 font-mono text-[11px] text-zinc-500 backdrop-blur">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" aria-hidden />
        <span className="font-bold tracking-[0.25em] text-zinc-400">FLAT</span>
        <span>no position</span>
      </div>
    );
  }
  if (position === 'PENDING') {
    return (
      <div className="flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 font-mono text-[11px] text-amber-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden />
        <span className="font-bold tracking-[0.2em]">{live.status.toUpperCase()}</span>
        <span>{live.side} {live.lots} lot{live.lots > 1 ? 's' : ''}</span>
      </div>
    );
  }
  const long = position === 'LONG';
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-3 rounded-full border bg-zinc-950/85 py-1 pl-1 pr-2 font-mono text-[11px] backdrop-blur',
      long ? 'border-emerald-500/50' : 'border-red-500/50')}>
      <span className={cn('rounded-full px-3 py-1 text-[11px] font-black tracking-[0.25em] text-oncolor', long ? 'bg-emerald-600' : 'bg-red-600')}>{position}</span>
      <span className="text-zinc-400">{live.lots} lot @ <strong className="text-zinc-200">{live.entry.toLocaleString('en-IN')}</strong></span>
      <strong className={cn('text-sm tabular-nums', pnl === null ? 'text-zinc-500' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {pnl === null ? '—' : inr(pnl)}
      </strong>
      {stopLevel !== null && <span className="text-zinc-500">stop <strong className="text-zinc-300">{stopLevel.toLocaleString('en-IN')}</strong></span>}
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close the position and turn auto off" title="Close the position and turn auto off"
          className={cn('ml-1 flex items-center gap-1 rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:border-red-500/60 hover:text-red-400', FOCUS)}>
          <X className="h-3 w-3" aria-hidden /> Close
        </button>
      )}
    </div>
  );
}

/** A small glyph for the engine note: paused, waiting on time, or a plain status. */
function NoteIcon({ note, active }: { note: string | null; active: boolean }) {
  const cls = 'h-3 w-3 shrink-0';
  if (!active) return <PauseCircle className={cn(cls, 'text-zinc-500')} aria-hidden />;
  if (note && /window|cutoff|waiting|next closed bar/i.test(note)) return <Clock className={cn(cls, 'text-sky-400')} aria-hidden />;
  return <Info className={cn(cls, 'text-zinc-400')} aria-hidden />;
}
