'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Repeat } from 'lucide-react';

// ─── Compact Dhan → Zerodha trade-replication controls ────────────────
//
// The full replication panel (bridge Start/Stop, per-child enable toggle,
// activity feed, safety-net warning) lives on /strategies-plus. This is a
// deliberately minimal subset — arm/disarm + multiplier — for the scalper
// terminals, where a trader wants replication on without leaving the page.
//
// Since only one child broker (Zerodha) exists today, arming here conflates
// "child enabled" with "armed" into a single action: it ensures the bridge
// process is running (idempotent start) and writes {armed:true, children:
// [{broker:'zerodha', multiplier, enabled:true}]} in one go, so this control
// is fully self-sufficient — no need to visit Strategies+ first.

const POLL_MS = 3000;

interface CopyTradeConfig {
  armed: boolean;
  children: { broker: 'zerodha'; multiplier: number; enabled: boolean }[];
}
interface CopyTradeStatus {
  status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR' | string;
}

export interface CopyTradeApi {
  multiplierInput: string;
  setMultiplierInput: (v: string) => void;
  armed: boolean;
  bridgeRunning: boolean;
  confirmArm: boolean;
  arming: boolean;
  arm: () => void;
  disarm: () => void;
}

export function useCopyTrade(notify: (type: 'success' | 'error', message: string, detail?: string) => void): CopyTradeApi {
  const [config, setConfig] = useState<CopyTradeConfig>({ armed: false, children: [] });
  const [status, setStatus] = useState<CopyTradeStatus | null>(null);
  const [multiplierInput, setMultiplierInput] = useState('1');
  const [confirmArm, setConfirmArm] = useState(false);
  const [arming, setArming] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // multiplierInput is a local edit buffer, not a live-mirrored display value
  // — only seed it from the server once on first load (and again right after
  // a successful arm, to reflect what was actually saved). Background polls
  // must never overwrite it, or a user mid-edit (or just before clicking ARM)
  // would see their typed value silently reverted every 3s.
  const hasLoadedOnceRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const [cfgRes, statusRes] = await Promise.all([
        fetch('/api/copy-trade/config').then(r => r.json()),
        fetch('/api/copy-trade').then(r => r.json()),
      ]);
      if (cfgRes.success && cfgRes.config) {
        setConfig(cfgRes.config);
        if (!hasLoadedOnceRef.current) {
          hasLoadedOnceRef.current = true;
          const zerodha = cfgRes.config.children?.find((c: { broker: string }) => c.broker === 'zerodha');
          if (zerodha) setMultiplierInput(String(zerodha.multiplier ?? 1));
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
    const n = parseInt(multiplierInput, 10);
    if (!Number.isInteger(n) || n <= 0) {
      notify('error', 'Copy trade: multiplier must be a positive integer');
      return;
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
          children: [{ broker: 'zerodha', multiplier: n, enabled: true }],
          armed: true,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        notify('success', `Trade replication ARMED (${n}x) — Zerodha will mirror Dhan fills live.`);
      } else {
        notify('error', data.error || 'Failed to arm trade replication.');
      }
    } catch {
      notify('error', 'Network error arming trade replication.');
    } finally {
      setArming(false);
      poll();
    }
  }, [multiplierInput, confirmArm, notify, poll]);

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

  return {
    multiplierInput, setMultiplierInput,
    armed: config.armed,
    bridgeRunning: status?.status === 'RUNNING',
    confirmArm, arming,
    arm, disarm,
  };
}

// ─── Inline controls for the P&L Guard bar ────────────────────────

export function CopyTradeControls({ copyTrade }: { copyTrade: CopyTradeApi }) {
  const { armed, bridgeRunning, multiplierInput, setMultiplierInput, confirmArm, arming, arm, disarm } = copyTrade;

  return (
    <>
      <span className="w-px h-5 bg-zinc-800" />

      <span className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider"
        title="Mirrors every Dhan fill to the Zerodha child account at quantity = qty x multiplier.">
        <Repeat className="w-3 h-3" /> Copy → Zerodha
      </span>

      {armed && (
        <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
          bridgeRunning
            ? 'bg-emerald-900/60 text-emerald-400 border border-emerald-500/30'
            : 'bg-red-900/60 text-red-400 border border-red-500/30 animate-pulse'
        }`} title={bridgeRunning ? undefined : 'Armed but the bridge is not running — not actually replicating right now'}>
          {bridgeRunning ? 'ARMED' : 'ARMED (bridge down!)'}
        </span>
      )}

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-zinc-500 font-semibold">MULT</span>
        <input type="number" min="1" step="1" placeholder="1" value={multiplierInput}
          onChange={e => setMultiplierInput(e.target.value)}
          disabled={armed}
          className="w-12 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                     rounded px-2 py-1 focus:outline-none focus:border-sky-500 disabled:opacity-50 tabular-nums" />
        <span className="text-[10px] text-zinc-500">x</span>
      </div>

      {!armed ? (
        <button onClick={arm} disabled={arming}
          className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all disabled:opacity-50 ${
            confirmArm
              ? 'bg-red-600 border-red-500 text-white animate-pulse shadow-lg shadow-red-500/20'
              : 'bg-sky-700 hover:bg-sky-600 text-white border-sky-500/40'
          }`}>
          {arming ? 'Arming…' : confirmArm ? 'Confirm ARM?' : 'ARM'}
        </button>
      ) : (
        <button onClick={disarm}
          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-zinc-900 border border-zinc-700
                     text-zinc-400 hover:text-red-300 hover:border-red-800 transition-all">
          Disarm
        </button>
      )}
    </>
  );
}
