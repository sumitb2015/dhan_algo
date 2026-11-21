'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePnfFeed } from '@/components/straddlePnf/usePnfFeed';
import { closedBars, replay, type ReplaySummary } from '@/lib/signalOrb';
import { liveRow, type OrbConfig, type OrbLedger, type OrbRow } from '@/lib/signalOrbLedger';
import type { Target } from '@/lib/pnfTarget';
import { isTabHidden, onTabVisible } from '@/lib/tabVisibility';

// The Signal Orb settings page's data: the ledger and its config ops (the same server routes the orb page uses), the contract's
// price for the exposure line, and the replay of the current rules. It never trades and never runs the engine.

type StateReply = { success: boolean; ledger: OrbLedger; contract: Target | null; unitsPerLot: number; error?: string };

const POLL_MS = 3_000;
/** 1-minute bars the replay reads: ~20 sessions plus indicator warm-up (as the orb page). */
const REPLAY_BARS_1M = 20_000;
const REPLAY_SESSIONS = 20;

export function useOrbSettings() {
  const [state, setState] = useState<StateReply | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The server's refusal of the last edit, shown until the next edit succeeds. */
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);

  // only a newer rev replaces what is on screen (a slow poll never rolls back an edit's reply)
  const accept = useCallback((j: Partial<StateReply>) => {
    if (!j.ledger) return;
    setState(prev => (prev && j.ledger!.rev < prev.ledger.rev ? prev : { ...(prev ?? ({} as StateReply)), ...j, ledger: j.ledger! } as StateReply));
  }, []);

  const load = useCallback(async () => {
    if (isTabHidden()) return;
    try {
      const r = await fetch('/api/signal-orb/state', { cache: 'no-store' });
      const j = await r.json() as StateReply;
      if (!j.success) { setLoadError(j.error ?? 'State unavailable'); return; }
      setLoadError(null);
      accept(j);
    } catch (e) { setLoadError(e instanceof Error ? e.message : 'State unavailable'); }
  }, [accept]);
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, POLL_MS);
    const cleanupVis = onTabVisible(() => { void load(); });
    return () => { clearTimeout(first); clearInterval(id); cleanupVis(); };
  }, [load]);

  const op = useCallback(async (body: Record<string, unknown>): Promise<string | null> => {
    try {
      const r = await fetch('/api/signal-orb/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { success: boolean; error?: string; ledger?: OrbLedger };
      if (j.ledger) accept({ ledger: j.ledger });
      return j.success ? null : (j.error ?? 'Refused');
    } catch (e) { return e instanceof Error ? e.message : 'Request failed'; }
  }, [accept]);

  const patch = useCallback(async (p: Partial<OrbConfig>) => setError(await op({ op: 'setConfig', patch: p })), [op]);
  const setMode = useCallback(async (m: 'SIM' | 'REAL') => setError(await op({ op: 'setMode', mode: m })), [op]);
  const resetSim = useCallback(async () => setError(await op({ op: 'resetSim' })), [op]);

  const ledger = state?.ledger ?? null;
  const cfg = ledger?.config;
  const feed = usePnfFeed(state?.contract ?? null, 0, now, null, { pauseWhenHidden: true });
  const bars = feed.bars;
  const last = bars[bars.length - 1];
  const price = last && last.straddle > 0 ? last.straddle : null;
  const unitsPerLot = state?.unitsPerLot ?? 0;
  const nowMinute = Math.floor(now / 60_000);
  const hasClock = nowMinute > 0;
  const replayed: ReplaySummary | null = useMemo(() => {
    if (!cfg || !nowMinute || cfg.instrument === 'straddle' || cfg.instrument === 'strangle') return null;
    return replay(cfg.indicators, closedBars(bars.slice(-REPLAY_BARS_1M), cfg.timeframe, nowMinute * 60 + 1),
      { times: cfg, stopPts: cfg.stopPts, trailStartPts: cfg.trailStartPts, trailGapPts: cfg.trailGapPts, lots: cfg.lots, unitsPerLot }, REPLAY_SESSIONS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.histVersion, cfg, unitsPerLot, hasClock]);

  const live: OrbRow | null = ledger ? liveRow(ledger) : null;
  return { ledger, live, error: error ?? loadError, patch, setMode, resetSim, replayed, price, unitsPerLot, loaded: !!ledger };
}
