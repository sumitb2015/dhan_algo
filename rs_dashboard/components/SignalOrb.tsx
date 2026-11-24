'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, ChevronDown, ChevronUp, Clock, Info, MonitorDot, Orbit, PauseCircle, Power, Settings2, ShieldAlert, Volume2, VolumeX, X } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { Orb } from '@/components/signalOrb/Orb';
import { useOrbEngine } from '@/components/signalOrb/useOrbEngine';
import { useBrokerPnl } from '@/components/signalOrb/useBrokerPnl';
import { istClock } from '@/lib/istTime';
import { istDateIso } from '@/lib/nseHolidays';
import { expiryLabel } from '@/lib/pnfTarget';
import { cn } from '@/lib/utils';
import { type EffectiveStopResult, type IndicatorReading, type Signal } from '@/lib/signalOrb';
import { ContextTabs } from '@/components/signalOrb/ContextPanels';
import { PivotPanel } from '@/components/signalOrb/PivotChart';
import { legStopForDisplay } from '@/lib/orbFocus';
import { BLIND_WARN_MS } from '@/lib/orbFocus';
import { isPremiumInstrument, isStuck, unknownLegIndexes, type OrbConfig, type OrbLedger, type OrbRow } from '@/lib/signalOrbLedger';

// /signal-orb: one orb, one switch. A CRUDEOIL / CRUDEOILM / NIFTY future's closed bars give the consensus of the active indicators —
// futures mode: green long, red short; options mode: green sells a PE, red sells a CE; gray holds. Real money in REAL mode; the rules and every safety limit live in lib/signalOrb*.ts and
// strategies/signal_orb/strategy.md. Entries need this page open (leader tab); every open row's stops run on the server (lib/orbPremiumServer.ts).

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export default function SignalOrb() {
  const e = useOrbEngine();
  const [logOpen, setLogOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { ledger, live, ev, contract } = e;
  const brokerPnl = useBrokerPnl(ledger?.config.broker);

  const toggle = useCallback(async () => {
    if (!ledger) return;
    setErr(await e.op({ op: 'setEngine', active: !ledger.engineActive }));
  }, [e, ledger]);

  const position = !live ? 'FLAT' : live.status === 'open' ? live.side : 'PENDING';
  const tfLabel = ledger ? (ledger.config.timeframe === 60 ? '1h' : `${ledger.config.timeframe}m`) : '';
  const real = ledger?.mode === 'REAL';
  const lastBar = e.feed.bars[e.feed.bars.length - 1];
  const dataDate = lastBar ? istDateIso(lastBar.t * 1000) : '—';
  const stuck = !!live && isStuck(live, e.now);
  const unresolved = live && (live.status === 'unknown' || stuck || live.day !== e.today) ? live : null;
  const premiumMode = !!ledger && isPremiumInstrument(ledger.config.instrument);
  // A straddle / strangle is entered by the server, so its ARM lives there (today only). Signal-driven trades need both: this page
  // load's ARM and the server's (which a dashboard restart or a mode switch clears), so a tab cannot trade REAL on a stale arm.
  const armedEff = premiumMode ? e.armedToday : e.armed && e.armedToday;
  const autoLabel = ledger?.engineActive ? (real && !armedEff ? 'Auto on · not armed' : 'Auto on') : 'Auto off';
  const resolveBtn = (label: string, body: Record<string, unknown>) => ({ label, run: async () => setErr(await e.op(body)) });
  // Every condition that needs the user, in one place, most serious first (red: money may be unprotected; amber: a decision).
  const attention: AttentionItem[] = [];
  if (e.stateError || e.feed.loadError) attention.push({ tone: 'red', text: e.stateError ?? e.feed.loadError ?? '' });
  if (ledger?.haltReason) attention.push({ tone: 'red', text: `HALTED - ${ledger.haltReason}` });
  if ((e.state?.premiumBlindMs ?? 0) >= BLIND_WARN_MS && live?.status === 'open') {
    attention.push({ tone: 'red', text: `No live price for ${Math.round((e.state?.premiumBlindMs ?? 0) / 1000)} s - the stops are NOT being judged (only the cutoff). Check the price feed and the broker.` });
  }
  if (live?.legs) {
    for (const i of unknownLegIndexes(live)) {
      const g = live.legs[i];
      attention.push({
        tone: 'amber', text: `Leg ${i + 1} (${g.action === 'BUY' ? 'bought' : 'sold'} ${g.target.strike} ${g.target.side}) outcome UNKNOWN - check the ${live.broker} book, then:`,
        actions: [resolveBtn('It is open', { op: 'resolveLeg', id: live.id, leg: i, as: 'open' }), resolveBtn('It is closed', { op: 'resolveLeg', id: live.id, leg: i, as: 'closed', price: e.state?.legLtps?.[i] ?? undefined })],
      });
    }
  }
  if (unresolved) {
    const unk = unresolved.status === 'unknown' || stuck;
    attention.push({
      tone: 'amber',
      text: unk ? `Order outcome UNKNOWN (${unresolved.side} ${unresolved.lots}) - check the ${unresolved.broker} book, then:` : `Open row from ${unresolved.day} - check the broker, then:`,
      actions: [
        ...(unk ? [resolveBtn('It is open', { op: 'resolve', id: unresolved.id, as: 'open' }), resolveBtn('Never filled', { op: 'resolve', id: unresolved.id, as: 'failed' })] : []),
        resolveBtn('It is closed', { op: 'resolve', id: unresolved.id, as: 'closed', price: (unresolved.target.kind === 'options' ? e.state?.optionLtp : e.price) ?? undefined }),
      ],
    });
  }
  if (e.outdated) {
    attention.push({ tone: 'amber', text: 'This tab is running an older version of the Signal Orb. Its numbers may be wrong and new entries are blocked.', actions: [{ label: 'Reload', run: () => window.location.reload() }] });
  }

  // the engine note, unless it only repeats the switch label
  const note = /^Auto is OFF$/i.test(e.note) ? null : e.note;

  return (
    <div className="relative flex h-dvh min-h-[560px] flex-col overflow-x-hidden overflow-y-auto bg-zinc-950 text-zinc-100">
      {/* Cyberpunk stage atmosphere & subtle grid */}
      <div
        className="pointer-events-none absolute inset-0 z-0 text-zinc-100 opacity-[0.035]"
        style={{
          backgroundImage: 'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,var(--color-zinc-950)_100%)] opacity-75"
        aria-hidden
      />
      {/* header */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-2 backdrop-blur lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10">
            <Orbit className="h-4 w-4 text-emerald-400" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400">
              Signal Orb
              <span title={ledger?.engineActive ? 'Auto is on' : 'Auto is off'}
                className={cn('h-1.5 w-1.5 rounded-full', ledger?.engineActive ? 'bg-emerald-400' : 'bg-zinc-600')} aria-hidden />
              <span className="font-mono font-medium normal-case tracking-normal text-zinc-500">{ledger?.engineActive ? 'auto on' : 'auto off'}</span>
            </p>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">
              {contract ? `${contract.symbol} FUT ${contract.expiry ? expiryLabel(contract.expiry) : ''}` : 'Resolving contract…'}
            </h1>
            {ledger && <ConfigChips config={ledger.config} tfLabel={tfLabel} />}
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
              {ledger.mode} · {ledger.config.broker.toUpperCase()}{real ? (armedEff ? ' · ARMED' : ' · NOT ARMED') : ''}
            </span>
          )}
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Sound and notifications">
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
              className={cn('border-l border-zinc-800 p-1.5 hover:bg-zinc-800', FOCUS, e.alertSound ? 'text-zinc-200' : 'text-zinc-500')}>
              {e.alertSound ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </button>
            <button type="button" onClick={() => void e.setDesktopNotify(!e.desktopNotify)} aria-pressed={e.desktopNotify}
              disabled={e.notifyPerm === 'unsupported' || (e.notifyPerm === 'denied' && !e.desktopNotify)}
              aria-label={e.desktopNotify ? 'Turn desktop notifications off' : 'Turn desktop notifications on'}
              title={e.notifyPerm === 'unsupported' ? 'This browser has no desktop notifications'
                : e.notifyPerm === 'denied' ? 'The browser blocks notifications for this site - allow them in the site settings, then turn this on'
                : `Desktop notifications ${e.desktopNotify ? 'on' : 'off'}: a halt, an UNKNOWN / stuck order, the stop watcher down, a stale feed or a refused automatic order, while this page is not in front${e.isLeader ? '' : ' - shown by the engine tab'}`}
              className={cn('rounded-r-lg border-l border-zinc-800 p-1.5 hover:bg-zinc-800 disabled:opacity-40', FOCUS, e.desktopNotify ? 'text-zinc-200' : 'text-zinc-500')}>
              <MonitorDot className="h-4 w-4" />
            </button>
          </div>
          <Link href="/signal-orb/settings" aria-label="Rules and indicators" title="Rules and indicators (full page)"
            className={cn('rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100', FOCUS)}>
            <Settings2 className="h-4 w-4" />
          </Link>
          <NavBar />
        </div>
      </header>

      {/* stage: the CPR window | the orb | the context window on a wide screen; the orb and the context window side by side on a
          laptop, with the CPR window under the orb; everything stacked on a narrow one */}
      <div className={cn('relative z-10 grid flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[27rem_minmax(0,1fr)_29rem] 2xl:grid-cols-[35rem_minmax(0,1fr)_29rem]',
        // REAL money: the whole stage is framed in red (solid when armed), so the mode is never one small pill away
        real && (armedEff ? 'm-1 rounded-xl ring-2 ring-inset ring-red-500/70' : 'm-1 rounded-xl ring-1 ring-inset ring-red-500/35'))}>
      {real && (
        <span className={cn('pointer-events-none absolute left-1/2 top-1 z-20 -translate-x-1/2 rounded-full border px-3 py-0.5 font-mono text-[10px] font-black tracking-[0.3em]',
          armedEff ? 'border-red-500/70 bg-red-600 text-oncolor' : 'border-red-500/40 bg-zinc-950 text-red-300')}>
          REAL MONEY · {armedEff ? 'ARMED' : 'NOT ARMED'}
        </span>
      )}
      <main className="flex flex-col items-center justify-center gap-4 px-4 py-4 xl:col-start-2 xl:row-start-1">
        <Attention items={attention} />
        {live?.status === 'open' && live.day === e.today && <StopsWhere server={e.serverStops} seen={e.watcherSeen} leader={e.isLeader} premium={e.isPremiumRow} />}

        <Orb signal={ev.signal} readings={ev.readings} positionLabel={position} busy={e.busy}
          since={ev.sinceT ? sinceLabel(ev.sinceT, e.today) : null} progress={1 - e.secsToClose / e.barSecs} secsLeft={e.secsToClose} />

        {/* position: its own element, coloured by side (the orb shows the signal) */}
        <PositionPill real={real} now={e.now} futPrice={e.price} live={live} position={position} pnl={e.openPnl} effectiveStop={e.effectiveStop} config={ledger?.config} mark={e.mark} legLtps={e.state?.legLtps}
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
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-md shadow-emerald-500/15'
                  : r.vote === -1
                    ? 'border-red-500/40 bg-red-500/10 text-red-300 shadow-md shadow-red-500/15'
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
        {ev.readings.length > 0 && <Agreement readings={ev.readings} signal={ev.signal} />}

        {/* control capsule: the switch, what it is doing, and REAL's arm */}
        <div
          className={cn(
            'flex items-center gap-3.5 rounded-full border py-1.5 pl-1.5 pr-6 backdrop-blur-md transition-all duration-300',
            ledger?.engineActive
              ? 'border-emerald-500/40 bg-zinc-950/90 shadow-lg shadow-emerald-500/25'
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
                ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-md shadow-emerald-500/45'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
            )}
          >
            {ledger?.engineActive && (
              <span className="absolute -inset-1 rounded-full border border-emerald-400/40 animate-ping opacity-60" />
            )}
            <Power className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className={cn('text-[10px] font-black uppercase tracking-[0.35em]', ledger?.engineActive ? 'text-emerald-300' : 'text-zinc-400')}>
              {autoLabel}
            </p>
            <p className="flex max-w-[22rem] items-center gap-1.5 font-mono text-[11px] text-zinc-400" aria-live="polite">
              <NoteIcon note={note} active={!!ledger?.engineActive} />
              <span className="truncate">{note ?? 'Turn on to follow the orb'}</span>
            </p>
          </div>
          {premiumMode && !live && (!real || armedEff) && (
            <button type="button" onClick={() => void e.trade({ action: 'enterNow' })} disabled={e.busy}
              title="Sell the structure now at the live prices (the server places it; its stops then run on the server)"
              className={cn('ml-2 whitespace-nowrap rounded-full border border-emerald-500/50 bg-emerald-500/15 px-3.5 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50', FOCUS)}>
              Enter now
            </button>
          )}
          {real && !armedEff && (ledger?.engineActive || premiumMode) && (
            <button
              type="button"
              onClick={() => { e.setArmed(true); void e.op({ op: 'arm' }); }}
              className={cn(
                'ml-2 whitespace-nowrap rounded-full border border-red-500/60 bg-red-500/20 px-3.5 py-1 text-[10px] font-black uppercase tracking-[0.25em] text-red-300 hover:bg-red-500/30 shadow-md transition-all',
                FOCUS,
              )}
            >
              Arm real money
            </button>
          )}
          {real && armedEff && (
            <button type="button" onClick={() => { e.setArmed(false); void e.op({ op: 'disarm' }); }}
              title="Disarm: no new REAL entries until armed again (open positions keep their stops and exits)"
              className={cn('ml-2 whitespace-nowrap rounded-full border border-zinc-700 bg-zinc-900 px-3.5 py-1 text-[10px] font-black uppercase tracking-[0.25em] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100', FOCUS)}>
              Disarm
            </button>
          )}
        </div>
      </main>

      {ledger && (
        <>
          <aside aria-label="Context" className="flex flex-col gap-3 self-start px-4 pb-4 lg:self-center lg:py-4 lg:pl-0 lg:pr-4 xl:col-start-3 xl:row-start-1">
            <ContextTabs mtf={e.mtf} active={e.tf} history={e.history} levels={e.levels} price={e.price} today={e.today}
              symbol={ledger.config.symbol} signal={ev.signal} />
          </aside>
          <aside aria-label="CPR and pivots" className="self-start px-4 pb-4 lg:py-4 lg:pr-0 xl:col-start-1 xl:row-start-1 xl:self-center xl:pl-4 xl:pr-0">
            <PivotPanel levels={e.levels} price={e.price} path={e.dayPath} symbol={ledger.config.symbol} />
          </aside>
        </>
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
          {logOpen && <Journal ledger={ledger} today={e.today} />}
        </footer>
      )}

      {(e.tradeErr || err) && (
        <div className="fixed bottom-24 left-1/2 z-50 flex max-w-xl -translate-x-1/2 flex-col items-center gap-2">
          {e.tradeErr && (
            <button type="button" onClick={e.clearTradeErr} aria-label="Dismiss" className={cn('rounded-lg border border-amber-500/40 bg-zinc-950 px-3 py-1.5 text-xs text-amber-300 shadow-lg', FOCUS)}>
              Order not sent: {e.tradeErr} ✕
            </button>
          )}
          {err && (
            <button type="button" onClick={() => setErr(null)} aria-label="Dismiss" className={cn('rounded-lg border border-red-500/40 bg-zinc-950 px-3 py-1.5 text-xs text-red-300 shadow-lg', FOCUS)}>
              {err} ✕
            </button>
          )}
        </div>
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
            Last <strong className={last.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}>{last.legs ? (last.structure === 'synthetic' ? `SYN ${last.side}` : `SHORT ${last.structure === 'strangle' ? 'STRANGLE' : 'STRADDLE'}`) : last.target.kind === 'options' ? `SELL ${last.target.side}` : last.side}</strong>{' '}
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

/** What a single-leg row holds, e.g. "CRUDEOIL 5600 PE" for an options row (always sold), or "" for a futures row or a multi-leg row. */
const optionOf = (r: OrbRow) => (!r.legs && r.target.kind === 'options' ? `${r.target.symbol} ${r.target.strike} ${r.target.side}` : '');
/** A multi-leg row's legs, e.g. "+25800 CE −25800 PE" (+ bought, − sold). */
const legsOf = (r: OrbRow) => (r.legs ?? []).map(g => `${g.action === 'BUY' ? '+' : '−'}${g.target.strike} ${g.target.side}`).join('  ');

function PositionPill({ real, now, futPrice, live, position, pnl, effectiveStop, config, mark, legLtps, onClose }: {
  /** REAL: Close needs a second click within a few seconds (it sends a market exit and turns Auto off) */
  real: boolean;
  now: number;
  /** the signal future's live price (the stop is measured on it) */
  futPrice: number | null;
  live: OrbRow | null; position: 'LONG' | 'SHORT' | 'FLAT' | 'PENDING'; pnl: number | null; effectiveStop: EffectiveStopResult | null; config?: OrbConfig;
  /** the row's own live price (an option's premium for an options row) */
  mark: number | null;
  /** a multi-leg row's live premiums, in leg order */
  legLtps?: (number | null)[] | null;
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
      <div className="flex items-center gap-2.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 font-mono text-[11px] text-amber-300 shadow-md">
        <span className="h-2 w-2 animate-ping rounded-full bg-amber-400" aria-hidden />
        <span className="font-black tracking-[0.2em]">{live.status.toUpperCase()}</span>
        <span>{live.side} {optionOf(live) ? `· SELL ${optionOf(live)} ` : ''}{live.legs ? `· ${legsOf(live)} ` : ''}{live.lots} lot{live.lots > 1 ? 's' : ''}</span>
      </div>
    );
  }
  const long = position === 'LONG';
  return (
    <div
      className={cn(
        'group relative flex flex-wrap items-center justify-center gap-3 rounded-full border bg-zinc-950/90 py-1 pl-1.5 pr-2.5 font-mono text-[11px] backdrop-blur-md transition-all duration-300',
        long
          ? 'border-emerald-500/50 shadow-lg shadow-emerald-500/25'
          : 'border-red-500/50 shadow-lg shadow-red-500/25',
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
      {live.legs && (
        <span className="font-bold text-zinc-100 flex flex-wrap items-center gap-x-3 gap-y-1" title="Each leg: entry premium to live premium; a short leg also shows the SL it exits at">
          <span className="text-zinc-500 text-[10px] font-normal uppercase">{live.structure === 'synthetic' ? 'Synthetic' : `Short ${live.structure}`}</span>
          {live.legs.map((g, i) => {
            const stop = config && (live.structure === 'straddle' || live.structure === 'strangle') && g.status === 'open' && legLtps?.[i] != null
              ? legStopForDisplay(config.premium, { lots: live.lots, unitsPerLot: live.unitsPerLot, lotUnits: live.lots > 0 ? live.legs![0].units / live.lots : 0,
                legs: live.legs!.map(x => ({ side: x.target.side as 'CE' | 'PE', entry: x.entry, units: x.units, status: x.status, exit: x.exit, costStop: x.costStop, trailSteps: x.trailSteps })) }, i, legLtps[i]!)
              : null;
            return (
              <span key={i} className={cn(g.status === 'closed' ? 'text-zinc-500 line-through' : g.action === 'BUY' ? 'text-emerald-300' : 'text-red-300')}>
                {g.action === 'BUY' ? '+' : '−'}{g.target.strike}{g.target.side}{' '}
                <span className="font-normal text-zinc-500 no-underline">
                  {g.entry.toLocaleString('en-IN')}→{g.status === 'closed' ? (g.exit ?? '—').toLocaleString('en-IN') : legLtps?.[i] == null ? '—' : legLtps[i]!.toLocaleString('en-IN')}
                  {g.status !== 'closed' && legLtps?.[i] != null && (() => {
                    const v = (g.action === 'SELL' ? g.entry - legLtps[i]! : legLtps[i]! - g.entry) * live.lots * live.unitsPerLot;
                    return <> <strong className={v >= 0 ? 'text-emerald-400' : 'text-red-400'}>{inr(v)}</strong></>;
                  })()}
                  {stop && <> · SL <strong className="text-zinc-300">{stop.level.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</strong>{stop.trailed > 0 ? ` (trailed ${stop.trailed}×)` : ''}</>}
                </span>
              </span>
            );
          })}
        </span>
      )}
      <span className="text-zinc-400">
        {live.lots} lot{live.lots > 1 ? 's' : ''}{!live.legs && <> @ <strong className="text-zinc-200">{live.entry.toLocaleString('en-IN')}</strong></>}
        {optionOf(live) && <> · now <strong className="text-zinc-100">{mark === null ? '—' : mark.toLocaleString('en-IN')}</strong></>}
      </span>
      <span className="h-3 w-px bg-zinc-800" aria-hidden />
      <strong
        className={cn(
          'text-sm font-black tabular-nums tracking-tight',
          pnl === null ? 'text-zinc-500' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400',
        )}
      >
        {pnl === null ? '—' : inr(pnl)}
      </strong>
      {effectiveStop && effectiveStop.stopLevel !== null && (
        effectiveStop.isTrailing ? (
          <span className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-300 shadow-md">
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
      {effectiveStop && effectiveStop.stopLevel !== null && futPrice !== null && (() => {
        const pts = live.side === 'LONG' ? futPrice - effectiveStop.stopLevel : effectiveStop.stopLevel - futPrice;
        // rupees only where the stop's points ARE the row's P&L (a futures row); an option or a synthetic moves differently
        const rs = live.target.kind !== 'options' && !live.legs ? pts * live.lots * live.unitsPerLot : null;
        return (
          <span className="text-[11px] text-zinc-400" title="Room left before the stop, on the signal future's price">
            to stop <strong className={pts <= 0 ? 'text-red-400' : 'text-zinc-200'}>{pts.toFixed(1)} pts</strong>
            {rs !== null && <> (₹{Math.abs(rs).toLocaleString('en-IN', { maximumFractionDigits: 0 })})</>}
          </span>
        );
      })()}
      {now > 0 && <span className="text-[11px] text-zinc-500" title={`Entered ${istClock(live.entryAt)}`}>{held(now - live.entryAt)}</span>}
      {onClose && <CloseButton real={real} onClose={onClose} />}
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

/** Close (market exit + Auto off). In REAL the first click only arms it: a second click within 4 s sends; otherwise it resets. */
function CloseButton({ real, onClose }: { real: boolean; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4_000);
    return () => clearTimeout(t);
  }, [confirming]);
  const click = () => {
    if (real && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    onClose();
  };
  return (
    <button type="button" onClick={click}
      aria-label={confirming ? 'Confirm: close the REAL position at market and turn auto off' : 'Close the position and turn auto off'}
      title={real ? 'REAL: click, then click again within 4 s to close at market (Auto turns off)' : 'Close the position and turn auto off'}
      className={cn(
        'ml-1 flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors',
        confirming ? 'border-red-500 bg-red-600 text-oncolor' : 'border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:border-red-500/70 hover:bg-red-500/15 hover:text-red-300',
        FOCUS,
      )}>
      <X className="h-3 w-3" aria-hidden /> {confirming ? 'Confirm close' : 'Close'}
    </button>
  );
}

type AttentionItem = { tone: 'red' | 'amber'; text: string; actions?: { label: string; run: () => void | Promise<void> }[] };

/** Everything that needs the user, in ONE box above the orb (red first), instead of a stack of separate banners. */
function Attention({ items }: { items: AttentionItem[] }) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'red' ? -1 : 1));
  const red = sorted[0].tone === 'red';
  return (
    <section role="alert" aria-label="Needs attention"
      className={cn('w-full max-w-2xl rounded-lg border bg-zinc-950/90 text-xs', red ? 'border-red-500/50' : 'border-amber-500/50')}>
      <h2 className={cn('flex items-center gap-1.5 border-b px-3 py-1 text-[10px] font-black uppercase tracking-[0.25em]', red ? 'border-red-500/30 text-red-300' : 'border-amber-500/30 text-amber-300')}>
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Needs attention{sorted.length > 1 ? ` (${sorted.length})` : ''}
      </h2>
      <ul>
        {sorted.map((it, i) => (
          <li key={i} className={cn('flex flex-wrap items-center gap-2 px-3 py-1.5', i > 0 && 'border-t border-zinc-900', it.tone === 'red' ? 'text-red-300' : 'text-amber-300')}>
            <span className="font-bold">{it.text}</span>
            {it.actions?.map(a => (
              <button key={a.label} type="button" onClick={() => void a.run()}
                className={cn('rounded border px-2 py-0.5 font-bold', it.tone === 'red' ? 'border-red-500/40 hover:bg-red-500/20' : 'border-amber-500/40 hover:bg-amber-500/20', FOCUS)}>
                {a.label}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Where the open position's stops are running. Server: they run with every tab closed. Otherwise only the engine tab sends them,
 * so closing it leaves the position without a stop (or, for a straddle / strangle, without any of its rules).
 */
function StopsWhere({ server, seen, leader, premium }: { server: boolean; seen: boolean; leader: boolean; premium: boolean }) {
  if (server) {
    return (
      <p className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-0.5 font-mono text-[10px] font-bold text-emerald-300"
        title="The dashboard server judges the cutoff, the stop, the trail and the daily loss limit on its own price feed: closing this tab is safe (stopping the dashboard is not)">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> STOPS RUN ON THE SERVER · safe to close this tab
      </p>
    );
  }
  return (
    <p role="alert" className="flex max-w-2xl items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-300">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {premium
        ? `The server watcher is ${seen ? 'not responding' : 'not running'}: this straddle / strangle's stops and targets are NOT running. Restart the dashboard.`
        : `The server watcher is ${seen ? 'not responding' : 'not running'}: the stops run only in the engine tab${leader ? ' (this one) - keep it open' : ' (another tab) - keep it open'}.`}
    </p>
  );
}

/** The configured trade as chips (instrument, size, stop, trail) instead of one run-on line. */
function ConfigChips({ config: c, tfLabel }: { config: OrbConfig; tfLabel: string }) {
  const premium = isPremiumInstrument(c.instrument);
  const off = c.strikeOffset === 0 ? 'ATM' : `ATM${c.strikeOffset > 0 ? '+' : '−'}${Math.abs(c.strikeOffset)}`;
  const what = c.instrument === 'options' ? `Sell option ${off}` : c.instrument === 'synthetic' ? 'Synthetic ATM'
    : c.instrument === 'straddle' ? `Short straddle @ ${c.premium.entryTime}` : c.instrument === 'strangle' ? `Short strangle ±${c.strikeOffset} @ ${c.premium.entryTime}` : 'Futures';
  const chips = [
    tfLabel,
    what,
    `${c.lots} lot${c.lots > 1 ? 's' : ''}`,
    premium ? `Leg SL ×${c.premium.legSlX || 'off'}` : `SL ${c.stopPts} pts`,
    ...(!premium && (c.trailStartPts ?? 0) > 0 ? [`Trail +${c.trailStartPts} / ${c.trailGapPts ?? 15} pts`] : []),
    `Loss limit ₹${c.dailyLossLimit.toLocaleString('en-IN')}`,
    ...(!premium && c.htfConfirm > 0 ? [`Confirm ${c.htfConfirm === 60 ? '1h' : `${c.htfConfirm}m`}`] : []),
    ...(!premium && c.levelGuardPts > 0 ? [`Pivot guard ${c.levelGuardPts} pts`] : []),
  ];
  return (
    <ul className="mt-1 flex flex-wrap items-center gap-1" aria-label="Configuration">
      {chips.map(t => (
        <li key={t} className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-px font-mono text-[11px] text-zinc-300">{t}</li>
      ))}
    </ul>
  );
}

/** How close the indicators are to agreeing: "All 3 agree", or "2 of 3 bullish · waiting on ST". */
function Agreement({ readings, signal }: { readings: IndicatorReading[]; signal: Signal }) {
  const n = readings.length;
  const bull = readings.filter(r => r.vote === 1);
  const bear = readings.filter(r => r.vote === -1);
  let text: string;
  if (signal !== 'NEUTRAL') text = `All ${n} agree · ${signal === 'BULL' ? 'bullish' : 'bearish'}`;
  else if (!bull.length && !bear.length) text = `None of ${n} has a view yet`;
  else if (bull.length === bear.length) text = `Split · ${bull.length} bullish, ${bear.length} bearish of ${n}`;
  else {
    const lead = bull.length > bear.length ? bull : bear;
    const word = lead === bull ? 'bullish' : 'bearish';
    const waiting = readings.filter(r => !lead.includes(r)).map(r => r.label);
    text = `${lead.length} of ${n} ${word} · waiting on ${waiting.join(', ')}`;
  }
  return <p className="font-mono text-xs text-zinc-400" aria-live="polite">{text}</p>;
}

/** Time in the trade: "45 s", "12 m", "2 h 05 m". */
const held = (ms: number): string => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
};

type JournalTab = 'trades' | 'all' | 'trade' | 'problems';
const JOURNAL_TABS: { v: JournalTab; label: string }[] = [
  { v: 'trades', label: 'Trades today' }, { v: 'all', label: 'Log' }, { v: 'trade', label: 'Orders' }, { v: 'problems', label: 'Errors & warnings' },
];

/** The footer panel: today's trades as a table (active mode), or the log (every stored line, filterable). */
function Journal({ ledger, today }: { ledger: OrbLedger; today: string }) {
  const [tab, setTab] = useState<JournalTab>('trades');
  const rows = useMemo(
    () => ledger.rows.filter(r => r.mode === ledger.mode && r.day === today && r.status !== 'failed').sort((a, b) => b.entryAt - a.entryAt),
    [ledger.rows, ledger.mode, today],
  );
  const log = useMemo(() => [...ledger.log].reverse().filter(l => (tab === 'trade' ? l.level === 'trade' : tab === 'problems' ? l.level === 'error' || l.level === 'warn' : true)), [ledger.log, tab]);
  return (
    <div className="px-4 pb-3 lg:px-6">
      <div role="tablist" aria-label="Journal" className="mb-2 inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
        {JOURNAL_TABS.map(t => (
          <button key={t.v} type="button" role="tab" aria-selected={tab === t.v} onClick={() => setTab(t.v)}
            className={cn('rounded-md px-2.5 py-0.5 text-xs font-bold', tab === t.v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300', FOCUS)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'trades' ? (
        rows.length ? (
          <div className="max-h-64 overflow-auto rounded-lg border border-zinc-800">
            <table className="w-full border-collapse font-mono text-xs">
              <thead className="sticky top-0 z-10">
                <tr>
                  {['In', 'Out', 'What', 'Lots', 'Entry', 'Exit', 'P&L', 'Reason'].map(h => (
                    <th key={h} className={cn('bg-zinc-800 px-2 py-1 text-xs font-bold text-white', h === 'What' || h === 'Reason' ? 'text-left' : 'text-right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const open = r.status !== 'closed';
                  return (
                    <tr key={r.id} className="border-t border-zinc-900">
                      <td className="px-2 py-1 text-right text-zinc-400">{istClock(r.entryAt).slice(0, 5)}</td>
                      <td className="px-2 py-1 text-right text-zinc-400">{r.exitAt ? istClock(r.exitAt).slice(0, 5) : <span className="text-amber-400">{r.status.toUpperCase()}</span>}</td>
                      <td className="px-2 py-1 text-zinc-200">{rowWhat(r)}</td>
                      <td className="px-2 py-1 text-right text-zinc-300">{r.lots}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-zinc-300">{r.legs ? '—' : r.entry.toLocaleString('en-IN')}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-zinc-300">{r.legs || r.exit === undefined ? '—' : r.exit.toLocaleString('en-IN')}</td>
                      <td className={cn('px-2 py-1 text-right font-bold tabular-nums', open || r.pnl === undefined ? 'text-zinc-500' : r.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {open || r.pnl === undefined ? '—' : inr(r.pnl)}
                      </td>
                      <td className="max-w-[28rem] truncate px-2 py-1 text-zinc-400" title={[r.exitReason, r.note].filter(Boolean).join(' · ')}>{r.exitReason ?? r.note ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-xs text-zinc-500">No {ledger.mode} trades today</p>
      ) : (
        <ul className="max-h-64 overflow-y-auto font-mono text-xs">
          {log.length ? log.map((l, i) => (
            <li key={`${l.at}-${i}`} className={cn('py-0.5', l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : l.level === 'trade' ? 'text-zinc-100' : 'text-zinc-400')}>
              <span className="text-zinc-600">{istClock(l.at)}</span> {l.msg}
            </li>
          )) : <li className="text-zinc-500">Nothing here</li>}
        </ul>
      )}
    </div>
  );
}

/** What a row traded, in a few words: "LONG FUT", "SELL 5600 PE", "SYN LONG", "SHORT STRADDLE". */
const rowWhat = (r: OrbRow): string =>
  r.legs ? (r.structure === 'synthetic' ? `SYN ${r.side} ${legsOf(r)}` : `SHORT ${(r.structure ?? '').toUpperCase()} ${legsOf(r)}`)
    : r.target.kind === 'options' ? `SELL ${r.target.strike} ${r.target.side}` : `${r.side} FUT`;
