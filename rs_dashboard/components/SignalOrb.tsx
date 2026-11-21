'use client';

import { useCallback, useState } from 'react';
import { Bell, BellOff, ChevronDown, ChevronUp, Clock, Info, PauseCircle, Power, Settings2, ShieldAlert, Volume2, VolumeX, X } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { Orb } from '@/components/signalOrb/Orb';
import { OrbDrawer } from '@/components/signalOrb/OrbDrawer';
import { useOrbEngine } from '@/components/signalOrb/useOrbEngine';
import { useBrokerPnl } from '@/components/signalOrb/useBrokerPnl';
import { istClock } from '@/lib/istTime';
import { istDateIso } from '@/lib/nseHolidays';
import { expiryLabel } from '@/lib/pnfTarget';
import { cn } from '@/lib/utils';
import { type EffectiveStopResult } from '@/lib/signalOrb';
import { ContextTabs } from '@/components/signalOrb/ContextPanels';
import { isStuck, type OrbConfig, type OrbLedger, type OrbRow } from '@/lib/signalOrbLedger';

// /signal-orb: one orb, one switch. A CRUDEOIL / CRUDEOILM / NIFTY future's closed bars give the consensus of the active indicators —
// futures mode: green long, red short; options mode: green sells a PE, red sells a CE; gray holds. Real money in REAL mode; the rules and every safety limit live in lib/signalOrb*.ts and
// strategies/signal_orb/strategy.md. The engine runs only while this page is open (leader tab).

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export default function SignalOrb() {
  const e = useOrbEngine();
  const [drawer, setDrawer] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { ledger, live, ev, contract } = e;
  const brokerPnl = useBrokerPnl(ledger?.config.broker);

  const patch = useCallback(async (p: Partial<OrbConfig>) => setErr(await e.op({ op: 'setConfig', patch: p })), [e]);
  const setMode = useCallback(async (m: 'SIM' | 'REAL') => { setErr(await e.op({ op: 'setMode', mode: m })); e.setArmed(false); }, [e]);
  const toggle = useCallback(async () => {
    if (!ledger) return;
    setErr(await e.op({ op: 'setEngine', active: !ledger.engineActive }));
  }, [e, ledger]);

  const position = !live ? 'FLAT' : live.status === 'open' ? live.side : 'PENDING';
  const optMode = ledger?.config.instrument === 'options';
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
      {/* Cyberpunk stage atmosphere & subtle grid */}
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-[0.035]"
        style={{
          backgroundImage: 'linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(0,0,0,0.75)_100%)]"
        aria-hidden
      />
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
              {ledger && (
                <>
                  {' '}· {optMode ? `sell options ${ledger.config.strikeOffset === 0 ? 'ATM' : `ATM${ledger.config.strikeOffset > 0 ? '+' : '−'}${Math.abs(ledger.config.strikeOffset)}`}` : 'futures'} · {ledger.config.lots} lot{ledger.config.lots > 1 ? 's' : ''} · SL {ledger.config.stopPts}p
                  {(ledger.config.trailStartPts ?? 0) > 0 ? ` (trail +${ledger.config.trailStartPts}/${ledger.config.trailGapPts ?? 15}p)` : ''}
                </>
              )}
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
            <span
              title={
                brokerPnl.connected && brokerPnl.totalPnl !== null
                  ? `${ledger.config.broker.toUpperCase()} overall P&L today: Realised ${inr(brokerPnl.realizedPnl ?? 0)} · Unrealised ${inr(brokerPnl.unrealizedPnl ?? 0)}${brokerPnl.openPositions !== null ? ` · ${brokerPnl.openPositions} open position(s)` : ''}`
                  : brokerPnl.error
                    ? `${ledger.config.broker.toUpperCase()}: ${brokerPnl.error}`
                    : `${ledger.config.broker.toUpperCase()} P&L loading…`
              }
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 font-mono text-[10px] font-bold',
                brokerPnl.totalPnl !== null
                  ? brokerPnl.totalPnl >= 0
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-red-500/30 bg-red-500/10 text-red-400'
                  : 'border-zinc-800 bg-zinc-900/60 text-zinc-400',
              )}
            >
              <span className="text-zinc-500">{ledger.config.broker.toUpperCase()} P&L</span>
              <span className="tabular-nums font-bold">
                {brokerPnl.totalPnl !== null ? inr(brokerPnl.totalPnl) : brokerPnl.loading ? '…' : '—'}
              </span>
            </span>
          )}
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

      {/* stage: the orb, with the context panels beside it (below it on a narrow window) */}
      <div className="relative z-10 grid flex-1 grid-cols-1 items-center gap-2 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <main className="flex flex-col items-center justify-center gap-4 px-4 py-4">
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
            <button type="button" className={cn('rounded border border-amber-500/40 px-2 py-0.5 font-bold hover:bg-amber-500/20', FOCUS)} onClick={async () => setErr(await e.op({ op: 'resolve', id: unresolved.id, as: 'closed', price: (unresolved.target.kind === 'options' ? e.state?.optionLtp : e.price) ?? undefined }))}>It is closed</button>
          </div>
        )}

        <Orb signal={ev.signal} readings={ev.readings} positionLabel={position} busy={e.busy}
          since={ev.sinceT ? sinceLabel(ev.sinceT, e.today) : null} progress={1 - e.secsToClose / e.barSecs} secsLeft={e.secsToClose} />

        {/* position: its own element, coloured by side (the orb shows the signal) */}
        <PositionPill live={live} position={position} pnl={e.openPnl} effectiveStop={e.effectiveStop} config={ledger?.config} mark={e.mark}
          onClose={live?.status === 'open' ? () => void e.closeAndStop() : null} />

        {/* readout: the price first, then one chip per indicator */}
        <div className="flex max-w-2xl flex-wrap items-center justify-center gap-2">
          <span className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/90 px-3 py-1 font-mono text-[11px] backdrop-blur-md shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-bold text-zinc-400 text-[10px] tracking-wider uppercase">FUT LTP</span>
            <span className="font-black tabular-nums text-zinc-100">{e.price === null ? '—' : e.price.toLocaleString('en-IN')}</span>
          </span>
          {ev.readings.map(r => (
            <span
              key={r.id}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] backdrop-blur-md shadow-sm transition-all',
                r.vote === 1
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                  : r.vote === -1
                    ? 'border-red-500/40 bg-red-500/10 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.15)]'
                    : 'border-zinc-800 bg-zinc-900/60 text-zinc-400',
              )}
            >
              <span aria-hidden className="text-[10px] font-bold">{r.vote === 1 ? '▲' : r.vote === -1 ? '▼' : '●'}</span>
              <span className="font-bold tracking-tight">{r.label}</span>
              <span className="tabular-nums font-semibold text-zinc-300">{r.value}</span>
              <span className="sr-only">{r.vote === 1 ? 'bullish' : r.vote === -1 ? 'bearish' : 'neutral or warming up'}</span>
            </span>
          ))}
          {!ev.readings.length && <span className="text-xs text-zinc-500">No indicators — open the rules to add one</span>}
        </div>

        {/* control capsule: the switch, what it is doing, and REAL's arm */}
        <div
          className={cn(
            'flex items-center gap-3.5 rounded-full border py-1.5 pl-1.5 pr-6 backdrop-blur-md transition-all duration-300',
            ledger?.engineActive
              ? 'border-emerald-500/40 bg-zinc-950/90 shadow-[0_0_28px_-4px_rgba(16,185,129,0.25)]'
              : 'border-zinc-800 bg-zinc-950/80 shadow-md',
          )}
        >
          <button
            type="button"
            onClick={toggle}
            disabled={!ledger}
            aria-pressed={!!ledger?.engineActive}
            aria-label={ledger?.engineActive ? 'Turn auto-trading off' : 'Turn auto-trading on'}
            className={cn(
              'relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-300 disabled:opacity-40',
              FOCUS,
              ledger?.engineActive
                ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-[0_0_16px_rgba(16,185,129,0.45)]'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
            )}
          >
            {ledger?.engineActive && (
              <span className="absolute -inset-1 rounded-full border border-emerald-400/40 animate-ping opacity-60" />
            )}
            <Power className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className={cn('text-[10px] font-black uppercase tracking-[0.35em]', ledger?.engineActive ? 'text-emerald-300 drop-shadow-[0_0_6px_rgba(16,185,129,0.35)]' : 'text-zinc-400')}>
              {autoLabel}
            </p>
            <p className="flex max-w-[22rem] items-center gap-1.5 font-mono text-[11px] text-zinc-400" aria-live="polite">
              <NoteIcon note={note} active={!!ledger?.engineActive} />
              <span className="truncate">{note ?? 'Turn on to follow the orb'}</span>
            </p>
          </div>
          {real && !e.armed && ledger?.engineActive && (
            <button
              type="button"
              onClick={() => e.setArmed(true)}
              className={cn(
                'ml-2 whitespace-nowrap rounded-full border border-red-500/60 bg-red-500/20 px-3.5 py-1 text-[10px] font-black uppercase tracking-[0.25em] text-red-300 hover:bg-red-500/30 shadow-[0_0_12px_rgba(239,68,68,0.25)] transition-all',
                FOCUS,
              )}
            >
              Arm real money
            </button>
          )}
        </div>
      </main>

      {ledger && (
        <aside aria-label="Context" className="flex flex-col gap-3 px-4 pb-4 lg:py-4 lg:pl-0 lg:pr-4">
          <ContextTabs mtf={e.mtf} active={e.tf} history={e.history} levels={e.levels} price={e.price} today={e.today}
            symbol={ledger.config.symbol} signal={ev.signal} />
        </aside>
      )}
      </div>

      {/* dock: today only - what the day has done and how close it is to the loss limit (the replay lives in the Rules drawer) */}
      {ledger && <DayDock ledger={ledger} today={e.today} realised={e.realised} openPnl={e.openPnl} />}

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
        <OrbDrawer open={drawer} onClose={() => setDrawer(false)} ledger={ledger} locked={!!live} replayed={e.replayed} unitsPerLot={e.state.unitsPerLot} price={e.price}
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

/** Today's result in the active mode: net P&L, trades and win/loss, the share of the daily loss limit used, and the last closed trade. */
function DayDock({ ledger, today, realised, openPnl }: { ledger: OrbLedger; today: string; realised: number; openPnl: number | null }) {
  const done = ledger.rows.filter(r => r.mode === ledger.mode && r.day === today && r.status === 'closed');
  const wins = done.filter(r => (r.pnl ?? 0) > 0).length;
  const last = done.length ? done.reduce((a, b) => ((b.exitAt ?? 0) > (a.exitAt ?? 0) ? b : a)) : null;
  const net = realised + (openPnl ?? 0);
  const limit = ledger.config.dailyLossLimit;
  const used = Math.min(1, Math.max(0, -net) / limit);
  const tone = used >= 0.8 ? 'bg-red-500' : used >= 0.5 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <section aria-label="Today" className="relative z-10 border-t border-zinc-900 bg-zinc-950/85 px-4 py-2 backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-6 gap-y-1.5 font-mono text-[11px] text-zinc-500">
        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">Today · {ledger.mode}</span>
        <span title={`Realised ${inr(realised)}${openPnl !== null ? ` + open ${inr(openPnl)}` : ''}`}>
          Net <strong className={cn('text-sm', net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-zinc-300')}>{inr(net)}</strong>
        </span>
        <span>
          {done.length ? <><strong className="text-zinc-300">{done.length}</strong> trade{done.length > 1 ? 's' : ''} · <strong className="text-emerald-400">{wins}</strong> win · <strong className="text-red-400">{done.length - wins}</strong> loss</> : 'No trades yet'}
        </span>
        <span className="flex items-center gap-2" title={`Realised + open loss against the daily limit of ₹${limit.toLocaleString('en-IN')}; at the limit the Orb closes and halts`}>
          Loss limit
          <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label="Daily loss limit used">
            <span className={cn('absolute inset-y-0 left-0 rounded-full', tone)} style={{ width: `${used * 100}%` }} />
          </span>
          <strong className="text-zinc-300">{Math.round(used * 100)}%</strong>
        </span>
        {last && (
          <span title={last.exitReason ?? ''}>
            Last <strong className={last.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}>{last.target.kind === 'options' ? `SELL ${last.target.side}` : last.side}</strong>{' '}
            <strong className={(last.pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{inr(last.pnl ?? 0)}</strong>
            <span className="text-zinc-600"> · {istClock((last.exitAt ?? 0)).slice(0, 5)}</span>
          </span>
        )}
      </div>
    </section>
  );
}

/** "23:46" for a colour that began today (IST), "Fri 23:46" for an earlier day, so a weekend reading is not mistaken for this morning. */
const sinceLabel = (t: number, today: string): string => {
  const hhmm = istClock(t * 1000).slice(0, 5);
  if (!today || istDateIso(t * 1000) === today) return hhmm;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date((t + 19_800) * 1000).getUTCDay()]} ${hhmm}`;
};

/** What a row holds, e.g. "CRUDEOIL 5600 PE" for an options row (always sold), or "" for a futures row. */
const optionOf = (r: OrbRow) => (r.target.kind === 'options' ? `${r.target.symbol} ${r.target.strike} ${r.target.side}` : '');

function PositionPill({ live, position, pnl, effectiveStop, config, mark, onClose }: {
  live: OrbRow | null; position: 'LONG' | 'SHORT' | 'FLAT' | 'PENDING'; pnl: number | null; effectiveStop: EffectiveStopResult | null; config?: OrbConfig;
  /** the row's own live price (an option's premium for an options row) */
  mark: number | null;
  onClose: (() => void) | null;
}) {
  if (!live) {
    return (
      <div className="flex items-center gap-2.5 rounded-full border border-zinc-800/80 bg-zinc-950/80 px-4 py-1.5 font-mono text-[11px] text-zinc-500 backdrop-blur-md shadow-sm">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-600 animate-pulse" aria-hidden />
        <span className="font-bold tracking-[0.25em] text-zinc-400">FLAT</span>
        <span className="text-zinc-500">no active position</span>
      </div>
    );
  }
  if (position === 'PENDING') {
    return (
      <div className="flex items-center gap-2.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 font-mono text-[11px] text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.15)]">
        <span className="h-2 w-2 animate-ping rounded-full bg-amber-400" aria-hidden />
        <span className="font-black tracking-[0.2em]">{live.status.toUpperCase()}</span>
        <span>{live.side} {optionOf(live) ? `· SELL ${optionOf(live)} ` : ''}{live.lots} lot{live.lots > 1 ? 's' : ''}</span>
      </div>
    );
  }
  const long = position === 'LONG';
  return (
    <div
      className={cn(
        'group relative flex flex-wrap items-center justify-center gap-3 rounded-full border bg-zinc-950/90 py-1 pl-1.5 pr-2.5 font-mono text-[11px] backdrop-blur-md transition-all duration-300',
        long
          ? 'border-emerald-500/50 shadow-[0_0_24px_-4px_rgba(16,185,129,0.25)]'
          : 'border-red-500/50 shadow-[0_0_24px_-4px_rgba(239,68,68,0.25)]',
      )}
    >
      <span
        className={cn(
          'rounded-full px-3 py-0.5 text-[10px] font-black tracking-[0.25em] text-oncolor shadow-sm',
          long ? 'bg-emerald-600' : 'bg-red-600',
        )}
      >
        {position}
      </span>
      {optionOf(live) && (
        <span className="font-bold text-zinc-100 flex items-center gap-1.5">
          <span className="text-zinc-500 text-[10px] font-normal">SOLD</span> {optionOf(live)}
        </span>
      )}
      <span className="text-zinc-400">
        {live.lots} lot{live.lots > 1 ? 's' : ''} @ <strong className="text-zinc-200">{live.entry.toLocaleString('en-IN')}</strong>
        {optionOf(live) && <> · now <strong className="text-zinc-100">{mark === null ? '—' : mark.toLocaleString('en-IN')}</strong></>}
      </span>
      <span className="h-3 w-px bg-zinc-800" aria-hidden />
      <strong
        className={cn(
          'text-sm font-black tabular-nums tracking-tight',
          pnl === null ? 'text-zinc-500' : pnl >= 0 ? 'text-emerald-400 drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'text-red-400 drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]',
        )}
      >
        {pnl === null ? '—' : inr(pnl)}
      </strong>
      {effectiveStop && effectiveStop.stopLevel !== null && (
        effectiveStop.isTrailing ? (
          <span className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.2)]">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span>TRAIL SL</span>
            <strong className="font-mono text-zinc-100">{effectiveStop.stopLevel.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</strong>
            <span className="font-bold text-emerald-400">
              ({effectiveStop.trailedPtsFromEntry >= 0 ? `+${effectiveStop.trailedPtsFromEntry.toFixed(1)}` : effectiveStop.trailedPtsFromEntry.toFixed(1)} pts)
            </span>
          </span>
        ) : (
          <span className="text-[10px] text-zinc-500">
            SL <strong className="text-zinc-300">{effectiveStop.stopLevel.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</strong>
            {config && (config.trailStartPts ?? 0) > 0 && (
              <span className="ml-1 text-zinc-500">· trail @ +{config.trailStartPts}</span>
            )}
          </span>
        )
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the position and turn auto off"
          title="Close the position and turn auto off"
          className={cn(
            'ml-1 flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/60 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-300 hover:border-red-500/70 hover:bg-red-500/15 hover:text-red-300 transition-colors',
            FOCUS,
          )}
        >
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
