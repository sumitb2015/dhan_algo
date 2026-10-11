'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTabLeader } from '@/hooks/useTabLeader';
import { useFocusMarketData, strikeKey } from '@/lib/useFocusMarketData';
import { useFocusToolWS, focusWsBookForExpiry, type FocusWSQuotes } from '@/lib/useFocusToolWS';
import { UNDERLYING_META, type FocusUnderlying } from '@/lib/focusToolUnderlyings';
import { dteForExpiry } from '@/lib/focusToolRules';
import { HD_KINDS, numCtl, type HdKind } from '@/lib/harvestDeskControls';
import {
  enterAlgoNow, enterLegNow, exitAllNow, exitLegNow, isOpen, makeLeg, newAlgo, pickExpiryByDte, resetAlgoRuntime, stepAlgo, validateLeg,
  HD_EXPIRY_AUTO, type HdAlgo, type HdLeg, type HdMarket, type HdOption, type HdQuote, type HdResult, type HdUnderlying,
} from '@/lib/harvestDesk';

const TICK_MS = 1000;
const SAVE_MS = 4000;
const READONLY_REFRESH_MS = 5000;
/** A bridge frame older than this is ignored, so a stalled feed falls back to the chain instead of freezing. */
const WS_STALE_MS = 8_000;

/** Chain prices older than this are not used: stops and fills must not run on a stalled poll (it ticks every 3 s). */
const CHAIN_STALE_MS = 60_000;
/** Gap between engine ticks above which the page warns: a hidden tab throttles timers. */
const LAG_WARN_MS = 5_000;

export type FeedSource = 'ws' | 'chain' | 'stale' | 'none';

/** What counts as "changed" for saving: fast-moving fields (last price, VWAP ticks, peak to the nearest ₹100,
 *  trail best to a point) are left out, so an open algo is not re-posted in full every few seconds. */
function snapKey(a: HdAlgo): string {
  return JSON.stringify(a, (k, v) => {
    if (k === 'updatedAt' || k === 'lastPx' || k === 'ticks' || k === 'cur') return undefined;
    if (k === 'peakMtm') return Math.round((v as number) / 100);
    if (k === 'best') return Math.round(v as number);
    return v;
  });
}

const istDay = (now: number) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istHm = (now: number) => new Date(now).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/** `saved` is true only when the server stored this copy; a write it ignored as stale is not saved. */
async function postAlgo(algo: HdAlgo): Promise<{ saved: boolean }> {
  try {
    const r = await fetch('/api/harvest-desk/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ algo }),
    });
    const j = await r.json() as { success: boolean; stale?: boolean };
    return { saved: r.ok && j.success && !j.stale };
  } catch { return { saved: false }; }
}

/** State + actions for the Harvest Desk page. The ledger is the page's own record (paper only);
 *  the engine ticks in the leader tab, and a follower tab is read-only. */
export function useHarvestDesk() {
  const { isLeader, leaderRef } = useTabLeader('harvest-desk');
  const [algos, setAlgos] = useState<HdAlgo[]>([]);
  const algosRef = useRef<HdAlgo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [lagMs, setLagMs] = useState(0);
  const lastTickRef = useRef(0);
  const savedRef = useRef<Map<string, string>>(new Map());
  const failedSaveToast = useRef(0);

  const commit = useCallback((next: HdAlgo[]) => {
    algosRef.current = next;
    setAlgos(next);
  }, []);

  // ── load (and keep a follower tab current) ──
  // `loaded` means the ledger was read successfully. A failed read is retried: the engine and the Add / Delete
  // actions stay off until it succeeds, so an empty list is never mistaken for "no algos" and written over.
  const loadedRef = useRef(false);
  const deletedRef = useRef<Set<string>>(new Set());
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/harvest-desk/state', { cache: 'no-store' });
      const j = await r.json() as { success: boolean; data?: { algos: HdAlgo[] }; error?: string };
      if (!j.success || !j.data) { if (!loadedRef.current) setLoadError(j.error ?? 'could not load the ledger'); return; }
      const rows = j.data.algos.filter((a) => !deletedRef.current.has(a.id));
      for (const a of rows) savedRef.current.set(a.id, snapKey(a));
      commit(rows);
      setLoadError(null);
      loadedRef.current = true;
      setLoaded(true);
    } catch (e) {
      if (!loadedRef.current) setLoadError(String(e));
    }
  }, [commit]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (loaded) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [loaded, load]);

  useEffect(() => {
    if (isLeader !== false || !loaded) return;
    const t = setInterval(() => { void load(); }, READONLY_REFRESH_MS);
    return () => clearInterval(t);
  }, [isLeader, loaded, load]);

  // ── market data ──
  // Keyed by a string: the engine hands back a fresh algos array every second, and an array identity that
  // changed every tick would re-fire the expiry / chain / lookup effects keyed on `watched`.
  const watchedKey = useMemo(
    () => [...new Set<FocusUnderlying>(['NIFTY', ...algos.map((a) => a.underlying as FocusUnderlying)])].sort().join('|'),
    [algos],
  );
  const watched = useMemo(() => watchedKey.split('|') as FocusUnderlying[], [watchedKey]);
  const groups = useMemo(() => watched.map((u) => ({ underlying: u, enabled: true })), [watched]);

  // The diagonal's expiries are picked from the DTE bands, and the market hook needs to be told which
  // expiries to warm, so the listed expiries are read here first (the route is cached server-side).
  const [expiriesSeen, setExpiriesSeen] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    for (const u of watched) {
      fetch(`/api/options/expiries?underlying=${u}&broker=dhan`)
        .then((r) => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (!cancelled && j.success && j.data) setExpiriesSeen((prev) => ({ ...prev, [u]: j.data! }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [watched]);
  const today = istDay(clock);
  const rowsKey = useMemo(() => {
    const parts: string[] = [];
    for (const a of algos) {
      for (const l of a.legs) {
        if (l.expiry && l.expiry !== HD_EXPIRY_AUTO) parts.push(`${a.underlying}:${l.expiry}`);
      }
      if (a.kind === 'diagonal_call') {
        const list = expiriesSeen[a.underlying] ?? [];
        const m = { expiries: list, dte: (e: string) => dteForExpiry(e, today) ?? -1 } as unknown as HdMarket;
        const long = pickExpiryByDte(m, numCtl(a.controls, 'longDteMin'), numCtl(a.controls, 'longDteMax'));
        const short = pickExpiryByDte(m, numCtl(a.controls, 'shortDteMin'), numCtl(a.controls, 'shortDteMax'), long ?? undefined);
        if (long) parts.push(`${a.underlying}:${long}`);
        if (short) parts.push(`${a.underlying}:${short}`);
        for (const l of a.legs) if (l.expiryUsed) parts.push(`${a.underlying}:${l.expiryUsed}`);
      }
    }
    return [...new Set(parts)].sort().join('|');
  }, [algos, expiriesSeen, today]);
  const expiryRows = useMemo(
    () => (rowsKey ? rowsKey.split('|').map((p) => { const [u, e] = p.split(':'); return { underlying: u as FocusUnderlying, expiry: e }; }) : []),
    [rowsKey],
  );

  const md = useFocusMarketData({ broker: 'dhan', watched, watchedKey, rows: expiryRows, groups });
  const { quotes: rawWs, bridgeStatus } = useFocusToolWS();

  // Start a STOPPED bridge only. A running one is shared with Focus Tool, and a start with a different
  // expiry set restarts it, so this page never restarts it: it reads whatever the bridge covers.
  const bridgeDown = ['STOPPED', 'STALE', 'ERROR'].includes(bridgeStatus.status);
  const nearestKey = (['NIFTY', 'BANKNIFTY', 'SENSEX'] as const).map((u) => md.expiries[u]?.[0] ?? '').join('|');
  useEffect(() => {
    if (!bridgeDown || !nearestKey.split('|').some(Boolean)) return;
    const start = () => fetch('/api/focus-tool/live-ws', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', expiries: { NIFTY: md.expiries.NIFTY?.[0] ?? '', BANKNIFTY: md.expiries.BANKNIFTY?.[0] ?? '', SENSEX: md.expiries.SENSEX?.[0] ?? '' } }),
    }).catch(() => {});
    start();
    const t = setInterval(start, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeDown, nearestKey]);

  const dataRef = useRef({ md, rawWs, bridgeStatus });
  const chainAtRef = useRef(0);
  useEffect(() => { dataRef.current = { md, rawWs, bridgeStatus }; });
  // `chains` is replaced on every successful poll, so a new identity means fresh chain data.
  useEffect(() => { chainAtRef.current = Date.now(); }, [md.chains]);

  const marketFor = useCallback((u: HdUnderlying, now: number = Date.now()): HdMarket | null => {
    const { md: d, rawWs: ws } = dataRef.current;
    const fu = u as FocusUnderlying;
    const frameAt = Date.parse(ws?.updated_at ?? '');
    const wsU = ws && Number.isFinite(frameAt) && now - frameAt <= WS_STALE_MS ? (ws as FocusWSQuotes)[fu] : undefined;
    const lotSize = d.lotSizes[fu];
    const day = istDay(now);
    const exps = d.expiries[fu] ?? [];
    const chainFresh = now - chainAtRef.current <= CHAIN_STALE_MS;
    // A stalled chain poll must not drive fills or stops: the leg is then simply unpriced (stops hold their last price).
    const chainFor = (e: string) => (chainFresh ? d.chains[`${fu}:${e}`] ?? null : null);
    const spot = Number(wsU?.spot) > 0 ? Number(wsU!.spot) : d.spotPrices[fu] > 0 ? d.spotPrices[fu] : (chainFor(exps[0] ?? '')?.spot ?? 0);
    if (!(spot > 0) || !lotSize || !exps.length) return null;
    return {
      now, day, hm: istHm(now), spot, step: UNDERLYING_META[fu].strikeStep, lotSize, expiries: exps,
      strikes: (e) => {
        const oc = chainFor(e)?.oc;
        return oc ? Object.keys(oc).map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
      },
      quote: (e, k, o: HdOption): HdQuote | null => {
        const key = strikeKey(k);
        const row = chainFor(e)?.oc?.[key];
        const wsLeg = wsU ? focusWsBookForExpiry(wsU, e)?.strikes?.[key]?.[o === 'CE' ? 'ce' : 'pe'] : undefined;
        const live = Number(wsLeg?.ltp) > 0 ? Number(wsLeg!.ltp) : 0;
        const chainPx = row ? (o === 'CE' ? row.ce : row.pe) : 0;
        const ltp = live > 0 ? live : chainPx;
        if (!(ltp > 0)) return null;
        const d100 = row ? (o === 'CE' ? (row.ceDelta ?? row.ceDeltaDhan) : (row.peDelta ?? row.peDeltaDhan)) : null;
        return { ltp, deltaAbs: d100 != null && Number.isFinite(d100) ? d100 / 100 : null };
      },
      dte: (e) => dteForExpiry(e, day) ?? 9999,
    };
  }, []);

  /** Where an underlying's prices currently come from (for the feed chip). */
  const feedFor = useCallback((u: HdUnderlying, expiry: string): FeedSource => {
    const { md: d, rawWs: ws } = dataRef.current;
    const fu = u as FocusUnderlying;
    const frameAt = Date.parse(ws?.updated_at ?? '');
    const fresh = ws && Number.isFinite(frameAt) && Date.now() - frameAt <= WS_STALE_MS;
    if (fresh && (ws as FocusWSQuotes)[fu] && focusWsBookForExpiry((ws as FocusWSQuotes)[fu], expiry)) return 'ws';
    if (!d.chains[`${fu}:${expiry}`]) return 'none';
    return Date.now() - chainAtRef.current <= CHAIN_STALE_MS ? 'chain' : 'stale';
  }, []);

  // ── persistence ──
  // Saves of one ledger run one after another: two overlapping POSTs could land out of order and the
  // server would then (correctly) refuse the older one as stale.
  const flushChain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback((only?: string): Promise<void> => {
    const run = async () => {
      for (const a of algosRef.current) {
        if (only && a.id !== only) continue;
        if (deletedRef.current.has(a.id)) continue;
        const snap = snapKey(a);
        if (savedRef.current.get(a.id) === snap) continue;
        const { saved } = await postAlgo({ ...a, updatedAt: Date.now() });
        if (saved) savedRef.current.set(a.id, snap);   // not marked when the server ignored it: retried next round
        else if (Date.now() - failedSaveToast.current > 30_000) {
          failedSaveToast.current = Date.now();
          toast.error('Harvest Desk could not save — changes are kept in this tab only until it reconnects');
        }
      }
    };
    flushChain.current = flushChain.current.then(run, run);
    return flushChain.current;
  }, []);

  // A fill made in the last seconds before a reload or a closed tab must reach the ledger, or the engine
  // re-enters on the next load. On page hide ONE keepalive request carries every unsaved algo, trimmed to
  // stay under the browser's ~64 KB keepalive quota; a merely hidden tab keeps running, so it uses the
  // normal serialized save instead.
  useEffect(() => {
    if (isLeader !== true) return;
    const onPageHide = () => {
      const now = Date.now();
      let dirty = algosRef.current.filter((a) => savedRef.current.get(a.id) !== snapKey(a))
        .map((a) => ({ ...a, updatedAt: now, events: a.events.slice(-20), vwap: a.vwap ? { ...a.vwap, ticks: [] } : undefined }));
      if (!dirty.length) return;
      let body = JSON.stringify({ algos: dirty });
      if (body.length > 60_000) { dirty = dirty.map((a) => ({ ...a, events: [] })); body = JSON.stringify({ algos: dirty }); }
      fetch('/api/harvest-desk/state', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') void flush(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.removeEventListener('pagehide', onPageHide); document.removeEventListener('visibilitychange', onVisibility); };
  }, [isLeader, flush]);

  useEffect(() => {
    if (isLeader !== true) return;
    const t = setInterval(() => { void flush(); }, SAVE_MS);
    return () => clearInterval(t);
  }, [isLeader, flush]);

  // ── engine tick ──
  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(() => {
      const now = Date.now();
      setClock(now);
      // A hidden tab throttles timers, which delays stops and square-off: surface it instead of failing quietly.
      const gap = lastTickRef.current ? now - lastTickRef.current : 0;
      lastTickRef.current = now;
      setLagMs((prev) => (gap > LAG_WARN_MS ? gap : prev > 0 && gap < TICK_MS * 3 ? 0 : prev));
      if (!leaderRef.current) return;
      const cur = algosRef.current;
      if (!cur.length) return;
      const markets = new Map<string, HdMarket | null>();
      let anyChange = false;
      const next = cur.map((a) => {
        if (!markets.has(a.underlying)) markets.set(a.underlying, marketFor(a.underlying, now));
        const m = markets.get(a.underlying);
        if (!m) return a;
        let out: HdAlgo;
        try { out = stepAlgo(a, m); } catch (e) { console.error('harvest-desk tick failed', a.id, e); return a; }
        if (out !== a) {
          anyChange = true;
          const fresh = out.events.filter((e) => e.t === now);
          for (const ev of fresh) {
            if (ev.k === 'ERROR') toast.error(`${a.name}: ${ev.msg}`);
            else if (['EXIT', 'LEG_EXIT', 'ROLL', 'ADD', 'HEDGE', 'REENTRY', 'HALVE', 'SUSPEND'].includes(ev.k)) toast(`${a.name}: ${ev.msg}`);
          }
        }
        return out;
      });
      if (anyChange) commit(next);
      // Anything the engine just did (a fill, a roll, an exit) is saved now, not at the next 4 s round.
      if (next.some((a) => a.events.length && a.events[a.events.length - 1].t === now)) void flush();
    }, TICK_MS);
    return () => clearInterval(t);
  }, [loaded, leaderRef, marketFor, commit, flush]);

  // ── actions ──
  const replace = useCallback((id: string, fn: (a: HdAlgo) => HdAlgo | null, flushNow = true) => {
    const cur = algosRef.current;
    const i = cur.findIndex((a) => a.id === id);
    if (i < 0) return;
    const out = fn(cur[i]);
    if (!out || out === cur[i]) return;
    const next = [...cur];
    next[i] = out;
    commit(next);
    if (flushNow) void flush(id);
  }, [commit, flush]);

  const readOnly = isLeader === false;
  const guard = (): boolean => {
    if (isLeader !== true) { toast.error('Another tab is running the desk — actions are disabled here'); return false; }
    return true;
  };

  /** Run a manual row action against fresh prices. */
  const act = useCallback((id: string, run: (a: HdAlgo, m: HdMarket) => HdResult) => {
    if (isLeader !== true) { toast.error('Another tab is running the desk — actions are disabled here'); return; }
    const a = algosRef.current.find((x) => x.id === id);
    if (!a) return;
    const m = marketFor(a.underlying);
    if (!m) { toast.error('Waiting for prices — try again in a moment'); return; }
    const r = run(a, m);
    r.notes.forEach((n) => toast(n));
    if (r.changed) replace(id, () => r.algo);
  }, [isLeader, marketFor, replace]);

  const actions = useMemo(() => ({
    addAlgo: (kind: HdKind, underlying: HdUnderlying) => {
      if (!guard()) return;
      const a = newAlgo(kind, underlying);
      commit([...algosRef.current, a]);
      void flush(a.id);
    },
    deleteAlgo: async (id: string) => {
      if (!guard()) return;
      const a = algosRef.current.find((x) => x.id === id);
      if (!a) return;
      if (a.legs.some(isOpen)) { toast.error('Close the open legs first'); return; }
      // Take it out of the page first so no queued, in-flight or periodic save can write it back, then let
      // the saves already running settle before the DELETE goes out.
      deletedRef.current.add(id);
      commit(algosRef.current.filter((x) => x.id !== id));
      await flushChain.current;
      let ok = false;
      try {
        const r = await fetch('/api/harvest-desk/state', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        const j = await r.json() as { success: boolean; error?: string };
        ok = j.success;
        if (!ok) toast.error(j.error ?? 'Could not delete');
      } catch { toast.error('Could not delete — ledger unreachable'); }
      if (ok) { savedRef.current.delete(id); return; }
      deletedRef.current.delete(id);
      commit([...algosRef.current, a]);
    },
    edit: (id: string, fn: (a: HdAlgo) => HdAlgo) => {
      if (!guard()) return;
      replace(id, (a) => fn(structuredClone(a)));
    },
    setControl: (id: string, key: string, value: number | string | boolean) => {
      if (!guard()) return;
      replace(id, (a) => ({ ...a, controls: { ...a.controls, [key]: value } }));
    },
    setLeg: (id: string, legId: string, patch: Partial<HdLeg>) => {
      if (!guard()) return;
      replace(id, (a) => {
        const cur = a.legs.find((l) => l.id === legId);
        if (!cur) return a;
        const err = validateLeg({ ...cur, ...patch });
        if (err) { toast.error(err); return a; }
        return { ...a, legs: a.legs.map((l) => (l.id === legId ? { ...l, ...patch } : l)) };
      });
    },
    addLeg: (id: string, role: HdLeg['role'] = 'main') => {
      if (!guard()) return;
      replace(id, (a) => {
        const proto = a.legs.find((l) => l.role === role && !l.auto) ?? a.legs[0];
        const leg = makeLeg({
          option: proto?.option ?? 'CE', side: proto?.side ?? 'S', role, expiry: proto?.expiry ?? '',
          strikeBy: proto?.strikeBy ?? 'ATM', strikeValue: proto?.strikeValue ?? 0, lots: Math.max(1, proto?.lots ?? 1),
        });
        return { ...a, legs: [...a.legs, leg] };
      });
    },
    removeLeg: (id: string, legId: string) => {
      if (!guard()) return;
      replace(id, (a) => {
        const l = a.legs.find((x) => x.id === legId);
        if (!l || isOpen(l)) { toast.error('Close the leg before removing it'); return a; }
        return { ...a, legs: a.legs.filter((x) => x.id !== legId) };
      });
    },
    toggleArm: (id: string) => {
      if (!guard()) return;
      replace(id, (a) => ({ ...a, armed: !a.armed, phase: !a.armed && a.phase === 'DONE' ? 'ACTIVE' : a.phase }));
    },
    enterNow: (id: string) => act(id, (a, m) => enterAlgoNow(a, m)),
    enterLeg: (id: string, legId: string) => act(id, (a, m) => enterLegNow(a, legId, m)),
    exitLeg: (id: string, legId: string, lots?: number) => act(id, (a, m) => exitLegNow(a, legId, m, lots)),
    exitAll: (id: string) => act(id, (a, m) => exitAllNow(a, m)),
    exitEverything: () => {
      if (isLeader !== true) { toast.error('Another tab is running the desk — actions are disabled here'); return; }
      for (const a of algosRef.current) if (a.legs.some(isOpen) || a.armed) act(a.id, (x, m) => exitAllNow(x, m));
    },
    reset: (id: string) => {
      if (!guard()) return;
      replace(id, (a) => resetAlgoRuntime(a));
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [commit, flush, replace, act, isLeader]);

  return {
    algos, loaded, loadError, clock, lagMs, isLeader, readOnly, marketFor, feedFor, actions, bridgeStatus,
    kinds: HD_KINDS,
  };
}
