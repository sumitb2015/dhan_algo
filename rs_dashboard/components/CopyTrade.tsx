'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Repeat } from 'lucide-react';

// ─── Compact Dhan → child-broker trade-replication controls ───────────
//
// The full replication panel (bridge Start/Stop, per-child enable toggle,
// activity feed, safety-net warning) lives on /strategies-plus. This is a
// deliberately minimal subset — pick brokers, set multipliers, arm/disarm — for
// the scalper terminals, where a trader wants replication on without leaving
// the page.
//
// Arming conflates "child enabled" with "armed" into a single action: it ensures
// the bridge process is running (idempotent start) and writes {armed:true,
// children:[...]} in one go, so this control is fully self-sufficient — no need
// to visit Strategies+ first. Only the brokers ticked here are written as
// enabled; an unticked broker is written enabled:false rather than dropped, so
// its multiplier survives for next time.

const POLL_MS = 3000;

export const CHILD_BROKERS = ['zerodha', 'kotak'] as const;
export type ChildBroker = typeof CHILD_BROKERS[number];

const BROKER_LABELS: Record<ChildBroker, string> = {
  zerodha: 'Zerodha',
  kotak: 'Kotak',
};

interface CopyTradeChild {
  broker: ChildBroker;
  multiplier: number;
  enabled: boolean;
}
interface CopyTradeConfig {
  armed: boolean;
  children: CopyTradeChild[];
}
interface CopyTradeStatus {
  status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR' | string;
  /** Per-broker init failures reported by the bridge — a child listed here is
   *  NOT receiving fills, however green the rest of the panel looks. */
  broker_failures?: Record<string, string>;
}

export interface CopyTradeApi {
  multipliers: Record<ChildBroker, string>;
  setMultiplier: (broker: ChildBroker, value: string) => void;
  selected: Record<ChildBroker, boolean>;
  toggleBroker: (broker: ChildBroker) => void;
  armedBrokers: ChildBroker[];
  armed: boolean;
  bridgeRunning: boolean;
  brokerFailures: Record<string, string>;
  confirmArm: boolean;
  arming: boolean;
  arm: () => void;
  disarm: () => void;
}

const EMPTY_MULTIPLIERS = { zerodha: '1', kotak: '1' } as Record<ChildBroker, string>;
const NO_BROKERS = { zerodha: false, kotak: false } as Record<ChildBroker, boolean>;

export function useCopyTrade(notify: (type: 'success' | 'error', message: string, detail?: string) => void): CopyTradeApi {
  const [config, setConfig] = useState<CopyTradeConfig>({ armed: false, children: [] });
  const [status, setStatus] = useState<CopyTradeStatus | null>(null);
  const [multipliers, setMultipliers] = useState<Record<ChildBroker, string>>({ ...EMPTY_MULTIPLIERS });
  // Which brokers the ARM click will enable. Defaults to Zerodha so the
  // pre-Kotak one-click flow is unchanged for anyone who never touches this.
  const [selected, setSelected] = useState<Record<ChildBroker, boolean>>({ zerodha: true, kotak: false });
  const [confirmArm, setConfirmArm] = useState(false);
  const [arming, setArming] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // multipliers/selected are local edit buffers, not live-mirrored display
  // values. They track the server value until the user edits them (dirty) —
  // otherwise a long-open tab would ARM with a stale multiplier or broker set,
  // silently reverting a change made elsewhere (e.g. on /strategies-plus). Once
  // dirty, background polls must never overwrite them, or a user mid-edit (or
  // just before clicking ARM) would see their input reverted every 3s.
  const dirtyRef = useRef(false);

  const setMultiplier = useCallback((broker: ChildBroker, value: string) => {
    dirtyRef.current = true;
    setMultipliers(prev => ({ ...prev, [broker]: value }));
  }, []);

  const toggleBroker = useCallback((broker: ChildBroker) => {
    dirtyRef.current = true;
    setSelected(prev => ({ ...prev, [broker]: !prev[broker] }));
  }, []);

  const poll = useCallback(async () => {
    try {
      const [cfgRes, statusRes] = await Promise.all([
        fetch('/api/copy-trade/config').then(r => r.json()),
        fetch('/api/copy-trade').then(r => r.json()),
      ]);
      if (cfgRes.success && cfgRes.config) {
        setConfig(cfgRes.config);
        if (!dirtyRef.current) {
          const children: CopyTradeChild[] = cfgRes.config.children ?? [];
          const nextMultipliers = { ...EMPTY_MULTIPLIERS };
          const nextSelected = { ...NO_BROKERS };
          for (const c of children) {
            if (!CHILD_BROKERS.includes(c.broker)) continue;
            nextMultipliers[c.broker] = String(c.multiplier ?? 1);
            nextSelected[c.broker] = !!c.enabled;
          }
          // An all-empty config would otherwise leave nothing tickable, so keep
          // Zerodha pre-selected until the user says otherwise.
          if (!children.length) nextSelected.zerodha = true;
          setMultipliers(nextMultipliers);
          setSelected(nextSelected);
        }
      }
      if (statusRes.success) setStatus(statusRes.status ?? null);
    } catch { /* keep last known state */ }
  }, []);

  useEffect(() => {
    poll();
    const iv = setInterval(poll, POLL_MS);
    return () => clearInterval(iv);
  }, [poll]);

  useEffect(() => () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current); }, []);

  const arm = useCallback(async () => {
    const chosen = CHILD_BROKERS.filter(b => selected[b]);
    if (!chosen.length) {
      notify('error', 'Copy trade: pick at least one child broker');
      return;
    }
    const parsed: Record<string, number> = {};
    for (const b of chosen) {
      const n = parseInt(multipliers[b], 10);
      if (!Number.isInteger(n) || n <= 0) {
        notify('error', `Copy trade: ${BROKER_LABELS[b]} multiplier must be a positive integer`);
        return;
      }
      parsed[b] = n;
    }

    if (!confirmArm) {
      setConfirmArm(true);
      confirmTimerRef.current = setTimeout(() => setConfirmArm(false), 3000);
      return;
    }
    setConfirmArm(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setArming(true);
    try {
      await fetch('/api/copy-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const res = await fetch('/api/copy-trade/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Unticked brokers are written disabled rather than omitted, so their
          // multiplier is still there next time they are ticked.
          children: CHILD_BROKERS.map(b => ({
            broker: b,
            multiplier: parsed[b] ?? Math.max(1, parseInt(multipliers[b], 10) || 1),
            enabled: !!selected[b],
          })),
          armed: true,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        dirtyRef.current = false; // saved — resume tracking the server value
        const summary = chosen.map(b => `${BROKER_LABELS[b]} ${parsed[b]}x`).join(', ');
        notify('success', `Trade replication ARMED — ${summary} will mirror Dhan fills live.`);
      } else {
        notify('error', data.error || 'Failed to arm trade replication.');
      }
    } catch {
      notify('error', 'Network error arming trade replication.');
    } finally {
      setArming(false);
      poll();
    }
  }, [multipliers, selected, confirmArm, notify, poll]);

  const disarm = useCallback(async () => {
    try {
      const res = await fetch('/api/copy-trade/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: false }),
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        notify('success', 'Trade replication disarmed.');
      } else {
        notify('error', data.error || 'Failed to disarm trade replication.');
      }
    } catch {
      notify('error', 'Network error disarming trade replication.');
    }
  }, [notify]);

  const armedBrokers = (config.children ?? [])
    .filter(c => c.enabled && CHILD_BROKERS.includes(c.broker))
    .map(c => c.broker);

  return {
    multipliers, setMultiplier,
    selected, toggleBroker,
    armedBrokers,
    armed: config.armed,
    bridgeRunning: status?.status === 'RUNNING',
    brokerFailures: status?.broker_failures ?? {},
    confirmArm, arming,
    arm, disarm,
  };
}

// ─── Inline controls for the P&L Guard bar ────────────────────────

export function CopyTradeControls({ copyTrade }: { copyTrade: CopyTradeApi }) {
  const {
    armed, bridgeRunning, brokerFailures, armedBrokers,
    multipliers, setMultiplier, selected, toggleBroker,
    confirmArm, arming, arm, disarm,
  } = copyTrade;

  const label = armed
    ? armedBrokers.map(b => BROKER_LABELS[b]).join(' + ') || 'none'
    : CHILD_BROKERS.filter(b => selected[b]).map(b => BROKER_LABELS[b]).join(' + ') || 'none';
  const failed = Object.keys(brokerFailures);

  return (
    <>
      <span className="w-px h-5 bg-zinc-800 shrink-0" />

      <span className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider shrink-0 whitespace-nowrap"
        title="Mirrors every Dhan fill to each enabled child account at quantity = qty x that child's multiplier.">
        <Repeat className="w-3 h-3" /> Copy → {label}
      </span>

      {armed && (
        <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 whitespace-nowrap ${
          !bridgeRunning
            ? 'bg-red-900/60 text-red-400 border border-red-500/30 animate-pulse'
            : 'bg-emerald-900/60 text-emerald-400 border border-emerald-500/30'
        }`} title={
          !bridgeRunning
            ? 'Armed but the bridge is not running — not actually replicating right now'
            : undefined
        }>
          {!bridgeRunning ? 'ARMED (bridge down!)' : 'ARMED'}
        </span>
      )}

      {/* A child the bridge could not initialise is receiving nothing, even
          while the panel reads ARMED — call it out rather than let it hide. */}
      {failed.length > 0 && (
        <span className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 whitespace-nowrap
                         bg-red-900/60 text-red-400 border border-red-500/30 animate-pulse"
          title={failed.map(b => `${b}: ${brokerFailures[b]}`).join('\n')}>
          {failed.map(b => BROKER_LABELS[b as ChildBroker] ?? b).join(', ')} DOWN
        </span>
      )}

      {CHILD_BROKERS.map(b => (
        <div key={b} className="flex items-center gap-1.5 shrink-0">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={!!selected[b]} onChange={() => toggleBroker(b)}
              disabled={armed}
              className="w-3 h-3 accent-sky-500 disabled:opacity-50" />
            <span className="text-[10px] text-zinc-400 font-semibold whitespace-nowrap">{BROKER_LABELS[b]}</span>
          </label>
          <input type="number" min="1" step="1" placeholder="1" value={multipliers[b]}
            onChange={e => setMultiplier(b, e.target.value)}
            disabled={armed || !selected[b]}
            title={`${BROKER_LABELS[b]} quantity multiplier`}
            className="w-11 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                       rounded px-1.5 py-1 focus:outline-none focus:border-sky-500 disabled:opacity-50 tabular-nums" />
          <span className="text-[10px] text-zinc-500">x</span>
        </div>
      ))}

      {!armed ? (
        <button onClick={arm} disabled={arming}
          className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all disabled:opacity-50 shrink-0 whitespace-nowrap ${
            confirmArm
              ? 'bg-red-600 border-red-500 text-white animate-pulse shadow-lg shadow-red-500/20'
              : 'bg-sky-700 hover:bg-sky-600 text-white border-sky-500/40'
          }`}>
          {arming ? 'Arming…' : confirmArm ? 'Confirm ARM?' : 'ARM'}
        </button>
      ) : (
        <button onClick={disarm}
          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-zinc-900 border border-zinc-700
                     text-zinc-400 hover:text-red-300 hover:border-red-800 transition-all shrink-0 whitespace-nowrap">
          Disarm
        </button>
      )}
    </>
  );
}
