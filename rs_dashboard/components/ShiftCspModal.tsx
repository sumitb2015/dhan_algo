'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Sparkles, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmt, fetchWithTimeout, PctText } from './cspShared';

export interface ShiftTarget {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  qty: number;
  spot: number;
  peLtp: number;
  move1d: number | null;
  move5d: number | null;
  moveCycle: number | null;
  /** Absent on paper rows — the exit leg cannot be placed for those. */
  securityId?: string;
}

interface ChainStrike {
  strike: number;
  ltp: number;
  oi: number;
  iv: number;
  noHitProb: number;
}

// Same liquidity floor the scanner applies (scripts/tools/csp_scanner.py): a
// strike with no open interest can't actually be sold at its quoted price, and
// that stale quote back-solves to a nonsense IV that makes the strike look far
// safer than it is. Recommending one would be actively harmful.
const MIN_OI = 100;
const MAX_IV = 100;

function isTradeable(s: ChainStrike): boolean {
  return s.ltp > 0 && s.oi >= MIN_OI && s.iv > 0 && s.iv <= MAX_IV;
}

type LegState = 'idle' | 'pending' | 'done' | 'failed';

interface StepState {
  exit: LegState;
  entry: LegState;
  exitOrderId?: string;
  entryOrderId?: string;
  error?: string;
}

/** Dhan builds stock option symbols as e.g. UNOMINDA26AUG1180PE. */
function contractName(symbol: string, expiry: string, strike: number): string {
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return `${symbol}${strike}PE`;
  const yy = String(d.getFullYear()).slice(2);
  const mon = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  return `${symbol}${yy}${mon}${strike % 1 === 0 ? strike : strike.toFixed(2)}PE`;
}

function MoveBox({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-sm border border-zinc-800 bg-zinc-950 px-2 py-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="font-mono text-[13px] font-bold">
        <PctText v={value} />
      </span>
    </div>
  );
}

function StepLine({ state, label }: { state: LegState; label: string }) {
  const dot = state === 'done' ? 'bg-emerald-500'
    : state === 'failed' ? 'bg-red-500'
      : state === 'pending' ? 'bg-amber-400 animate-pulse'
        : 'bg-zinc-700';
  return (
    <div className="flex items-start gap-2">
      <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', dot)} />
      <span className={cn('font-mono text-[11px]',
        state === 'failed' ? 'text-red-400' : state === 'done' ? 'text-emerald-400' : 'text-zinc-300')}>
        {label}
      </span>
    </div>
  );
}

export default function ShiftCspModal({ target, onClose, onComplete }: {
  target: ShiftTarget;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [strikes, setStrikes] = useState<ChainStrike[]>([]);
  const [loadingChain, setLoadingChain] = useState(true);
  const [chainError, setChainError] = useState<string | null>(null);
  const [newStrike, setNewStrike] = useState<string>('');
  const [steps, setSteps] = useState<StepState>({ exit: 'idle', entry: 'idle' });
  const [executing, setExecuting] = useState(false);
  const [cancelled, setCancelled] = useState<{ exit: boolean; entry: boolean }>({ exit: false, entry: false });

  const isPaper = !target.securityId;
  const [reloadKey, setReloadKey] = useState(0);
  const [moves, setMoves] = useState<{ move1d: number | null; move5d: number | null; moveCycle: number | null }>({
    move1d: target.move1d, move5d: target.move5d, moveCycle: target.moveCycle,
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/csp-tracked/moves?symbol=${encodeURIComponent(target.symbol)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j.success) return;
        setMoves({ move1d: j.move1d, move5d: j.move5d, moveCycle: j.moveCycle });
      })
      .catch(() => { /* the move boxes just stay blank */ });
    return () => { cancelled = true; };
  }, [target.symbol]);

  useEffect(() => {
    let cancelled = false;
    setLoadingChain(true);
    setChainError(null);
    fetchWithTimeout(
      `/api/csp-watchlist/chain?symbol=${encodeURIComponent(target.symbol)}&expiry=${encodeURIComponent(target.expiry)}`,
      45_000,
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.success) throw new Error(j.error ?? 'Failed to load chain');
        setStrikes((j.strikes ?? []).sort((a: ChainStrike, b: ChainStrike) => a.strike - b.strike));
      })
      .catch((e: unknown) => {
        if (!cancelled) setChainError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoadingChain(false); });
    return () => { cancelled = true; };
  }, [target.symbol, target.expiry, reloadKey]);

  // A roll is only defensive if it moves further from the money, so only
  // strikes below the current one are candidates — and only liquid ones.
  const candidates = useMemo(
    () => strikes.filter((s) => s.strike < target.strike && isTradeable(s)),
    [strikes, target.strike],
  );

  const recommended = useMemo(() => {
    if (candidates.length === 0) return null;
    return candidates.reduce(
      (best, s) => (Math.abs(s.noHitProb - 80) < Math.abs(best.noHitProb - 80) ? s : best),
      candidates[0],
    );
  }, [candidates]);

  const selected = useMemo(
    () => strikes.find((s) => String(s.strike) === newStrike) ?? null,
    [strikes, newStrike],
  );

  const runShift = useCallback(async () => {
    // Never retry a roll in-place: once leg 1 is away the old put may already be
    // bought back, and re-running would fire a second BUY and open a real long
    // position. Any recovery goes through a freshly loaded row.
    if (!selected || executing || steps.exit !== 'idle') return;
    setExecuting(true);
    setSteps({ exit: 'pending', entry: 'idle' });

    try {
      const exitRes = await fetch('/api/csp-tracked/shift/exit-leg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id }),
      });
      const exitJson = await exitRes.json();
      if (!exitJson.success) {
        setSteps({
          exit: 'failed', entry: 'idle',
          exitOrderId: exitJson.orderId,
          error: exitJson.error ?? 'Exit leg failed',
        });
        onComplete();
        return;
      }
      setSteps({ exit: 'done', entry: 'pending', exitOrderId: exitJson.orderId });

      const entryRes = await fetch('/api/csp-tracked/shift/entry-leg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: target.id,
          newStrike: selected.strike,
          newExpiry: target.expiry,
          entrySpot: target.spot,
        }),
      });
      const entryJson = await entryRes.json();
      if (!entryJson.success) {
        setSteps((s) => ({
          ...s, entry: 'failed',
          entryOrderId: entryJson.orderId,
          error: entryJson.error ?? 'Entry leg failed',
        }));
        return;
      }
      setSteps((s) => ({
        ...s, entry: 'done',
        entryOrderId: entryJson.orderId,
        error: entryJson.warning,
      }));
    } catch (e: unknown) {
      setSteps((s) => ({
        ...s,
        entry: s.exit === 'done' ? 'failed' : s.entry,
        exit: s.exit === 'pending' ? 'failed' : s.exit,
        error: `${e instanceof Error ? e.message : String(e)} — outcome UNCONFIRMED, check Orders/Positions.`,
      }));
    } finally {
      setExecuting(false);
      // Always resync: every terminal path above changes the stored rows.
      onComplete();
    }
  }, [selected, executing, steps.exit, target, onComplete]);

  const cancelOrder = useCallback(async (orderId: string | undefined, leg: 'exit' | 'entry') => {
    if (!orderId) return;
    setCancelled((c) => ({ ...c, [leg]: true }));
    try {
      const res = await fetch('/api/csp-watchlist/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      const j = await res.json();
      if (!j.success) {
        setSteps((s) => ({ ...s, error: `Cancel failed for ${orderId}: ${j.error ?? 'unknown'}` }));
        setCancelled((c) => ({ ...c, [leg]: false }));
      }
    } catch (e: unknown) {
      setSteps((s) => ({ ...s, error: `Cancel failed for ${orderId}: ${e instanceof Error ? e.message : String(e)}` }));
      setCancelled((c) => ({ ...c, [leg]: false }));
    }
  }, []);

  const started = steps.exit !== 'idle';
  const finished = steps.entry === 'done';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="mt-8 w-full max-w-lg rounded-md border border-zinc-800 bg-[#0a0a0a] shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <h2 className="text-[15px] font-bold text-zinc-100">Shift Cash Secured Put</h2>
            <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
              {target.symbol} (LTP: {fmt(target.spot)}) · Expiry {target.expiry}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="grid grid-cols-2 gap-3 rounded-sm border border-zinc-800 bg-zinc-950 px-3 py-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Current Put</span>
              <span className="font-mono text-[12px] font-bold text-red-400">
                {contractName(target.symbol, target.expiry, target.strike)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Current Strike</span>
              <span className="font-mono text-[13px] font-bold text-zinc-100">
                {target.strike.toLocaleString('en-IN')} PE
              </span>
            </div>
          </div>

          <div className="flex gap-2">
            <MoveBox label="1D Move" value={moves.move1d} />
            <MoveBox label="5D Move" value={moves.move5d} />
            <MoveBox label="Cycle Move" value={moves.moveCycle} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-bold text-zinc-200">Select New Strike Price</label>
            <select
              value={newStrike}
              onChange={(e) => setNewStrike(e.target.value)}
              disabled={loadingChain || started}
              className="w-full rounded-sm border border-zinc-800 bg-zinc-950 px-2 py-2 font-mono text-[12px] text-zinc-100 disabled:opacity-50"
            >
              <option value="">
                {loadingChain ? 'Loading chain…' : candidates.length === 0 ? 'No liquid strikes below current' : 'Select a strike'}
              </option>
              {candidates.map((s) => (
                <option key={s.strike} value={s.strike}>
                  {s.strike} PE (LTP: {s.ltp.toFixed(2)}) · OI {s.oi.toLocaleString('en-IN')} · {s.noHitProb.toFixed(0)}% safe
                </option>
              ))}
            </select>
            {!loadingChain && strikes.length > 0 && (
              <span className="text-[10px] text-zinc-600">
                Showing {candidates.length} of {strikes.filter((s) => s.strike < target.strike).length} strikes below {target.strike} — illiquid strikes (OI &lt; {MIN_OI}) are hidden.
              </span>
            )}
            {chainError && (
              <div className="flex items-start gap-2 text-[11px] text-red-400">
                <span className="flex-1">{chainError}</span>
                <button
                  onClick={() => setReloadKey((k) => k + 1)}
                  disabled={loadingChain || started}
                  className="shrink-0 underline underline-offset-2 hover:text-red-300 disabled:opacity-40"
                >
                  Retry
                </button>
              </div>
            )}
          </div>

          {recommended && (
            <div className="flex flex-col gap-1.5 rounded-sm border border-sky-500/25 bg-sky-500/5 px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-400">
                <Sparkles className="h-3 w-3" /> Recommended Target PE Strike
              </span>
              <p className="text-[11px] text-zinc-300">
                Target the <span className="font-mono font-bold text-sky-400">{recommended.strike} PE</span> strike
                (Estimated success: <span className="font-mono font-bold text-emerald-400">{recommended.noHitProb.toFixed(1)}%</span> probability of expiring worthless).
              </p>
              <button
                onClick={() => setNewStrike(String(recommended.strike))}
                disabled={started}
                className="self-start text-[11px] text-sky-400 underline underline-offset-2 hover:text-sky-300 disabled:opacity-40"
              >
                Apply Recommended Strike
              </button>
            </div>
          )}

          {selected && (
            <div className="flex flex-col gap-2 rounded-sm border border-zinc-800 bg-zinc-950 px-3 py-2.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Adjustment Preview</span>
              <div className="flex items-start gap-2">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-500" />
                <span className="font-mono text-[11px] text-zinc-300">
                  Leg 1 (Exit): BUY {contractName(target.symbol, target.expiry, target.strike)} ({target.qty} Qty) @ Market
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <span className="font-mono text-[11px] text-zinc-300">
                  Leg 2 (Entry): SELL {contractName(target.symbol, target.expiry, selected.strike)} ({target.qty} Qty) @ Market
                </span>
              </div>

              {started && (
                <div className="mt-1 flex flex-col gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <StepLine
                      state={steps.exit}
                      label={`[Step 1/2] Closing ${contractName(target.symbol, target.expiry, target.strike)}: ${steps.exit.toUpperCase()}`}
                    />
                    {/* Only offered once a leg has stalled with a live order id —
                        a filled or rejected order has nothing left to cancel. */}
                    {steps.exit === 'failed' && steps.exitOrderId && !cancelled.exit && (
                      <button onClick={() => cancelOrder(steps.exitOrderId, 'exit')}
                        className="shrink-0 rounded-sm bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-400">
                        Cancel Order
                      </button>
                    )}
                  </div>
                  {steps.entry !== 'idle' && (
                    <div className="flex items-center justify-between gap-2">
                      <StepLine
                        state={steps.entry}
                        label={`[Step 2/2] Opening new CSP ${contractName(target.symbol, target.expiry, selected.strike)}: ${steps.entry.toUpperCase()} (${steps.entry === 'done' ? target.qty : 0}/${target.qty} filled)`}
                      />
                      {steps.entry === 'failed' && steps.entryOrderId && !cancelled.entry && (
                        <button onClick={() => cancelOrder(steps.entryOrderId, 'entry')}
                          className="shrink-0 rounded-sm bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-400">
                          Cancel Order
                        </button>
                      )}
                    </div>
                  )}
                  {steps.error && (
                    <div className="flex items-start gap-1.5 text-[11px] text-red-400">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{steps.error}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {isPaper && (
            <div className="flex items-start gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>This is a manually tracked (paper) position with no linked broker contract — the exit leg cannot be placed.</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-sm border border-zinc-700 px-3 py-1.5 text-[12px] font-bold text-zinc-300 hover:text-zinc-100"
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={runShift}
            // `started` (not just `finished`): a roll that failed mid-way must be
            // reopened from a freshly loaded row, never retried against stale state.
            disabled={!selected || executing || isPaper || started}
            className="rounded-sm bg-sky-600 px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-40"
          >
            {executing ? 'Executing Shift…'
              : finished ? 'Shift Complete'
                : started ? 'Shift Stopped' : 'Execute Shift'}
          </button>
        </div>
      </div>
    </div>
  );
}
