'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyHeldOp, emptyHeld, heldFor, type HeldLedger, type HeldOp, type HeldRow } from '@/lib/pnfIndexHeld';
import { scopeQuery, type PnfScope } from '@/lib/pnfScope';
import type { Broker } from '@/hooks/useBrokerSelector';

// Which option an index chart holds (lib/pnfIndexHeld.ts). REAL: the server ledger (app/api/straddle-pnf/index-held), re-read every 3 s
// so a second tab sees the same row. PAPER: the same ops on a ledger in page memory - it lives exactly as long as the paper book it
// describes (the paper book is page memory too, so a reload drops both together and never leaves one without the other).

/** Each op resolves to the row after it (null = the row is gone) or the reason it was refused (a string). */
type OpReply = Promise<HeldRow | null | string>;
export type HeldOps = {
  /** Reserve a new entry of `units` (or, when this exact leg is already held, an add of `units` to it). */
  enter: (row: Omit<HeldRow, 'state' | 't' | 'units' | 'pending'>, units: number) => OpReply;
  /** Reserve an add (+) or a reduce / close (-) on the held row. */
  begin: (id: string, delta: number) => OpReply;
  confirm: (id: string) => OpReply;
  unknown: (id: string, note?: string) => OpReply;
  void: (id: string) => OpReply;
  clear: (id: string) => OpReply;
  resolve: (id: string, as: 'done' | 'none') => OpReply;
};

type Dist<T> = T extends unknown ? Omit<T, 'now'> : never;
type OpIn = Dist<HeldOp>;

const READ_MS = 3_000;

export function useIndexHeld({ enabled, scope, chart, indexKey, broker, mode }: {
  enabled: boolean; scope: PnfScope; chart: 1 | 2; indexKey: string; broker: Broker; mode: 'PAPER' | 'REAL';
}) {
  const [real, setReal] = useState<HeldLedger | null>(null);
  const [realError, setRealError] = useState<string | null>(null);
  const [paper, setPaper] = useState<HeldLedger>(emptyHeld);
  const paperRef = useRef(paper);
  useEffect(() => { paperRef.current = paper; });
  // Replies are taken in the order their REQUESTS were sent: a poll sent before an op must not overwrite the op's newer reply. Not by the
  // file's rev: a ledger file that was reset or deleted starts again from rev 0, and a rev guard would ignore it for good.
  const seqRef = useRef(0);
  const takenRef = useRef(0);
  const take = useCallback((led: HeldLedger, seq: number) => {
    if (seq < takenRef.current) return;
    takenRef.current = seq;
    setReal(led);
  }, []);

  useEffect(() => {
    if (!enabled || mode !== 'REAL') return;
    let dead = false;
    const read = async () => {
      const seq = ++seqRef.current;
      try {
        const res = await fetch(`/api/straddle-pnf/index-held${scopeQuery(scope)}`);
        const j = await res.json() as { success?: boolean; ledger?: HeldLedger; error?: string };
        if (dead) return;
        if (j.success && j.ledger) { take(j.ledger, seq); setRealError(null); } else setRealError(j.error ?? 'Held-option ledger unavailable');
      } catch { if (!dead) setRealError('Held-option ledger unavailable'); }
    };
    void read();
    const id = setInterval(read, READ_MS);
    return () => { dead = true; clearInterval(id); };
  }, [enabled, mode, scope, take]);

  const apply = useCallback(async (op: OpIn): OpReply => {
    if (mode === 'PAPER') {
      const r = applyHeldOp(paperRef.current, { ...op, now: Math.floor(Date.now() / 1000) } as HeldOp);
      if (!r.ok) return r.error;
      paperRef.current = r.ledger;
      setPaper(r.ledger);
      return r.row ?? null;
    }
    const seq = ++seqRef.current;
    try {
      const res = await fetch(`/api/straddle-pnf/index-held${scopeQuery(scope)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op),
      });
      const j = await res.json() as { success?: boolean; ledger?: HeldLedger; row?: HeldRow | null; error?: string };
      if (j.ledger) take(j.ledger, seq);
      return j.success ? j.row ?? null : j.error ?? `Held-option ledger refused (HTTP ${res.status})`;
    } catch (e) {
      return `Held-option ledger unavailable (${(e as Error).message})`;
    }
  }, [mode, scope, take]);

  const ops: HeldOps = {
    enter: async (row, units) => { const r = await apply({ op: 'enter', row, units }); return r === null ? 'Held-option ledger gave no row' : r; },
    begin: (id, delta) => apply({ op: 'begin', id, delta }),
    confirm: id => apply({ op: 'confirm', id }),
    unknown: (id, note) => apply({ op: 'unknown', id, note }),
    void: id => apply({ op: 'void', id }),
    clear: id => apply({ op: 'clear', id }),
    resolve: (id, as) => apply({ op: 'resolve', id, as }),
  };

  const led = mode === 'PAPER' ? paper : real;
  const held = enabled && led ? heldFor(led, chart, broker, indexKey) : null;
  /** REAL: the ledger has not been read yet (or cannot be) - no order may go out on a guess of what is held. */
  const loading = enabled && mode === 'REAL' && real === null;
  return { held, ops, loading, error: mode === 'REAL' ? realError : null };
}

export type IndexHeld = ReturnType<typeof useIndexHeld>;

/** The live price of one option (`SEG:ID`) from the P&F WebSocket bridge, polled every second; null until it has one. */
export function useTradedLive(ids: string | null): { ltp: number | null; changedMs: number | null } {
  const [q, setQ] = useState<{ ids: string; ltp: number | null; changedMs: number | null } | null>(null);
  useEffect(() => {
    if (!ids) return;
    let dead = false, fails = 0;
    // A price that cannot be refreshed is dropped (null) after 3 failed polls: a PAPER fill or a P&L must never run on a frozen premium.
    const miss = () => { if (++fails >= 3 && !dead) setQ(prev => (prev && prev.ids === ids ? { ids, ltp: null, changedMs: null } : prev)); };
    const poll = async () => {
      try {
        const res = await fetch(`/api/straddle-pnf/live?ids=${ids}`);
        const j = await res.json() as { success?: boolean; legs?: { quote: { ltp: number; changedMs: number } | null; last: { ltp: number } | null }[] };
        if (dead) return;
        if (!j.success || !j.legs?.[0]) return void miss();
        const l = j.legs[0];
        fails = 0;
        setQ({ ids, ltp: l.quote?.ltp ?? l.last?.ltp ?? null, changedMs: l.quote?.changedMs ?? null });
      } catch { miss(); }
    };
    void poll();
    const id = setInterval(poll, 1_000);
    return () => { dead = true; clearInterval(id); };
  }, [ids]);
  return q && q.ids === ids ? { ltp: q.ltp, changedMs: q.changedMs } : { ltp: null, changedMs: null };
}
