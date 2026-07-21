'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Lock } from 'lucide-react';

// ─── Client-side minimum profit lock ──────────────────────────────
//
// Dashboard-level guard on TOTAL P&L (realized + unrealized). The user sets a
// ₹ floor; once total P&L is above it (ARMED), a fall back to/below the floor
// market-exits every open position immediately. Complements the broker-level
// Dhan pnlExit guard: that one caps profit/loss at fixed absolute levels,
// this one locks in an achieved profit when the market regime turns.
//
// State machine: INACTIVE → (set) → DORMANT (P&L not yet above floor+buffer,
// waits) or ARMED (P&L above floor+buffer) → TRIGGERED (fired once; terminal
// until cleared/re-set).
//
// The arm buffer is hysteresis: without it, P&L ticking ₹1 above the floor
// would arm the lock and the very next down-tick would exit everything. The
// lock only arms once P&L clears floor + buffer, guaranteeing that much
// cushion between arming and firing.
//
// Optional trail (user-selectable): once ARMED, the floor ratchets up 1:1
// with every new P&L high — the gap between P&L and floor captured at arming
// stays constant, so each rupee of fresh MTM gain raises the locked floor by
// a rupee. The floor never moves down.

export type ProfitLockState = 'INACTIVE' | 'DORMANT' | 'ARMED' | 'TRIGGERED';

const DEFAULT_ARM_BUFFER = 500;

interface PersistedLock {
  threshold: number;
  armBuffer: number;
  state: 'DORMANT' | 'ARMED';
  trailEnabled?: boolean;
  trailGap?: number | null; // P&L-to-floor distance captured at arming (null until armed)
  date: string; // YYYY-MM-DD — a lock never survives into the next session day
}

export interface ProfitLockApi {
  thresholdInput: string;
  setThresholdInput: (v: string) => void;
  armBufferInput: string;
  setArmBufferInput: (v: string) => void;
  trailEnabled: boolean;
  setTrailEnabled: (v: boolean) => void;
  lockState: ProfitLockState;
  threshold: number | null;
  armBuffer: number;
  setLock: () => void;
  clearLock: () => void;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function useProfitLock(opts: {
  totalPnl: number;
  hasOpenPositions: boolean;
  exitAll: (reason: string) => Promise<void>;
  notify: (type: 'success' | 'error', message: string, detail?: string) => void;
  storageKey: string;
}): ProfitLockApi {
  const { totalPnl, hasOpenPositions, exitAll, notify, storageKey } = opts;

  const [thresholdInput, setThresholdInput] = useState('');
  const [armBufferInput, setArmBufferInput] = useState(String(DEFAULT_ARM_BUFFER));
  const [threshold, setThreshold] = useState<number | null>(null);
  const [armBuffer, setArmBuffer] = useState(DEFAULT_ARM_BUFFER);
  const [trailEnabled, setTrailEnabled] = useState(false);
  // Constant P&L-to-floor gap captured when the lock arms; while trailing,
  // floor ratchets to (P&L high − gap). Null until armed with trail on.
  const [trailGap, setTrailGap] = useState<number | null>(null);
  const [lockState, setLockState] = useState<ProfitLockState>('INACTIVE');
  // Synchronous one-shot latch — set before the async exitAll so a second
  // effect run during the await cannot double-fire.
  const firingRef = useRef(false);

  // Restore today's lock on mount; discard stale (previous-day) entries so an
  // old floor can't false-fire against a fresh session's P&L.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as PersistedLock;
      if (saved.date !== todayStr() || typeof saved.threshold !== 'number' || !isFinite(saved.threshold)) {
        localStorage.removeItem(storageKey);
        return;
      }
      const savedBuffer = typeof saved.armBuffer === 'number' && isFinite(saved.armBuffer) && saved.armBuffer >= 0
        ? saved.armBuffer : DEFAULT_ARM_BUFFER;
      setThreshold(saved.threshold);
      setArmBuffer(savedBuffer);
      setTrailEnabled(!!saved.trailEnabled);
      setTrailGap(typeof saved.trailGap === 'number' && isFinite(saved.trailGap) && saved.trailGap > 0 ? saved.trailGap : null);
      setLockState(saved.state === 'ARMED' ? 'ARMED' : 'DORMANT');
      setThresholdInput(String(saved.threshold));
      setArmBufferInput(String(savedBuffer));
    } catch {
      /* corrupt entry — ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist while waiting/armed; drop on INACTIVE or TRIGGERED (a fired lock
  // must never resurrect on reload).
  useEffect(() => {
    try {
      if (threshold !== null && (lockState === 'DORMANT' || lockState === 'ARMED')) {
        const entry: PersistedLock = { threshold, armBuffer, state: lockState, trailEnabled, trailGap, date: todayStr() };
        localStorage.setItem(storageKey, JSON.stringify(entry));
      } else {
        localStorage.removeItem(storageKey);
      }
    } catch {
      /* storage unavailable — lock still works in-session */
    }
  }, [threshold, armBuffer, lockState, trailEnabled, trailGap, storageKey]);

  const setLock = useCallback(() => {
    const t = parseFloat(thresholdInput);
    if (isNaN(t) || !isFinite(t)) {
      notify('error', 'Profit lock: enter a valid ₹ amount');
      return;
    }
    const buf = armBufferInput.trim() === '' ? 0 : parseFloat(armBufferInput);
    if (isNaN(buf) || !isFinite(buf) || buf < 0) {
      notify('error', 'Profit lock: arm buffer must be ₹0 or more');
      return;
    }
    firingRef.current = false;
    setThreshold(t);
    setArmBuffer(buf);
    if (totalPnl > t + buf) {
      setLockState('ARMED');
      setTrailGap(trailEnabled ? totalPnl - t : null);
      notify('success', `Profit lock ARMED at ₹${t}${trailEnabled ? ' (trailing)' : ''}`,
        `Exits all if P&L falls to ₹${t} (now ₹${totalPnl.toFixed(0)})${trailEnabled ? ` · floor trails ₹${(totalPnl - t).toFixed(0)} behind new highs` : ''}`);
    } else {
      setLockState('DORMANT');
      setTrailGap(null);
      notify('success', `Profit lock set at ₹${t} (dormant)`, `Arms when P&L rises above ₹${t + buf} (now ₹${totalPnl.toFixed(0)})`);
    }
  }, [thresholdInput, armBufferInput, trailEnabled, totalPnl, notify]);

  const clearLock = useCallback(() => {
    firingRef.current = false;
    setThreshold(null);
    setLockState('INACTIVE');
    setThresholdInput('');
    setArmBufferInput(String(DEFAULT_ARM_BUFFER));
    setTrailGap(null);
  }, []);

  // Monitor — totalPnl recomputes on every WS tick and 5s poll, so this
  // effect fires at exactly the cadence the P&L is known to have changed.
  useEffect(() => {
    if (threshold === null) return;

    if (lockState === 'DORMANT') {
      // Arm only once P&L clears floor + buffer — hysteresis so a marginal
      // poke above the floor can't arm-then-fire on the next down-tick.
      if (totalPnl > threshold + armBuffer) {
        setLockState('ARMED');
        if (trailEnabled) setTrailGap(totalPnl - threshold);
        notify('success', `Profit lock ARMED${trailEnabled ? ' (trailing)' : ''}`,
          `P&L ₹${totalPnl.toFixed(0)} cleared ₹${threshold + armBuffer} (lock ₹${threshold} + buffer ₹${armBuffer})`);
      }
      return;
    }

    if (lockState !== 'ARMED') return;

    // Trail: ratchet the floor to (new P&L high − gap); never lower it.
    if (trailEnabled && trailGap !== null) {
      const candidate = totalPnl - trailGap;
      if (candidate > threshold) {
        setThreshold(candidate);
        return; // fire-check re-runs against the raised floor on the next pass
      }
    }

    if (!hasOpenPositions) return; // nothing to exit; also gates initial empty-load ticks
    if (totalPnl > threshold) return;
    if (firingRef.current) return;

    firingRef.current = true;
    setLockState('TRIGGERED');
    notify('success', '🔒 Profit lock TRIGGERED — exiting all positions', `P&L ₹${totalPnl.toFixed(0)} ≤ lock ₹${threshold.toFixed(0)}`);
    void exitAll(`Profit lock ₹${threshold.toFixed(0)}`);
  }, [totalPnl, lockState, threshold, armBuffer, trailEnabled, trailGap, hasOpenPositions, exitAll, notify]);

  return {
    thresholdInput, setThresholdInput,
    armBufferInput, setArmBufferInput,
    trailEnabled, setTrailEnabled,
    lockState, threshold, armBuffer,
    setLock, clearLock,
  };
}

// ─── Inline controls for the P&L guard bar ────────────────────────

const CHIP_CLS: Record<Exclude<ProfitLockState, 'INACTIVE'>, string> = {
  DORMANT:   'bg-amber-900/40 text-amber-400 border border-amber-500/30',
  ARMED:     'bg-emerald-900/60 text-emerald-400 border border-emerald-500/30',
  TRIGGERED: 'bg-rose-900/60 text-rose-400 border border-rose-500/30 animate-pulse',
};

export function ProfitLockControls({ lock, totalPnl }: { lock: ProfitLockApi; totalPnl: number }) {
  const active = lock.lockState !== 'INACTIVE';

  return (
    <>
      <span className="w-px h-5 bg-zinc-800 shrink-0" />

      <span className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider shrink-0 whitespace-nowrap"
        title="Client-side: exits ALL positions at market if total P&L falls to this floor. Set above current P&L to pre-arm (dormant until crossed).">
        <Lock className="w-3 h-3" /> Profit Lock
      </span>

      {active && (
        <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 whitespace-nowrap ${CHIP_CLS[lock.lockState as Exclude<ProfitLockState, 'INACTIVE'>]}`}>
          {lock.lockState}
        </span>
      )}

      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-zinc-500 font-semibold whitespace-nowrap">LOCK ₹</span>
        <input type="number" placeholder="e.g. 2000" value={lock.thresholdInput}
          onChange={e => lock.setThresholdInput(e.target.value)}
          disabled={active}
          className="w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                     rounded px-2 py-1 focus:outline-none focus:border-cyan-500 disabled:opacity-50" />
      </div>

      {/* Hysteresis: dormant lock arms only once P&L clears LOCK + this buffer */}
      <div className="flex items-center gap-1.5 shrink-0"
        title="Arm buffer: a dormant lock arms only when P&L rises above LOCK + buffer, so a brief poke above the floor can't arm and immediately exit on the next dip.">
        <span className="text-[10px] text-zinc-500 font-semibold whitespace-nowrap">ARM +₹</span>
        <input type="number" min="0" placeholder="500" value={lock.armBufferInput}
          onChange={e => lock.setArmBufferInput(e.target.value.replace(/-/g, ''))}
          disabled={active}
          className="w-16 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono
                     rounded px-2 py-1 focus:outline-none focus:border-cyan-500 disabled:opacity-50" />
      </div>

      {/* User-selectable 1:1 trail — only trails when enabled */}
      <button onClick={() => !active && lock.setTrailEnabled(!lock.trailEnabled)}
        disabled={active}
        title="Trail the lock: once armed, every new P&L high raises the floor rupee-for-rupee (gap captured at arming stays constant). The floor never moves down."
        className={`px-2.5 py-1 rounded text-[10px] font-bold border transition-all disabled:opacity-50 shrink-0 whitespace-nowrap ${
          lock.trailEnabled
            ? 'bg-cyan-900/50 border-cyan-500/40 text-cyan-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300'
        }`}>
        ⤴ Trail {lock.trailEnabled ? 'ON' : 'OFF'}
      </button>

      {!active ? (
        <button onClick={lock.setLock}
          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-cyan-700 hover:bg-cyan-600
                     text-white border border-cyan-500/40 transition-all shrink-0 whitespace-nowrap">
          Set Lock
        </button>
      ) : (
        <button onClick={lock.clearLock}
          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-zinc-900 border border-zinc-700
                     text-zinc-400 hover:text-zinc-200 transition-all shrink-0 whitespace-nowrap">
          Clear Lock
        </button>
      )}

      {active && lock.threshold !== null && (
        <span className="text-[10px] text-zinc-500 font-mono tabular-nums shrink-0 whitespace-nowrap">
          ₹{totalPnl.toFixed(0)} / lock ₹{lock.threshold.toFixed(0)}
          {lock.lockState === 'DORMANT' && ` · arms at ₹${(lock.threshold + lock.armBuffer).toFixed(0)}`}
          {lock.lockState === 'ARMED' && lock.trailEnabled && ' ⤴'}
        </span>
      )}
    </>
  );
}
