'use client';

// Live data for /index-scalper: the shared options tick bridge (spot + per-strike LTP / OI / buildup), the
// expiry list, lot size and strike -> security id map. Supports NIFTY, CRUDEOILM and CRUDEOIL. Nothing here places an order.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import type { LiveQuotes } from '@/components/Scalper';
import { chainSnapshot, type RestChain } from '@/lib/indexScalperChain';
import { inOrderSession } from '@/lib/indexScalperSession';
import type { KotakSymbolInfo } from '@/lib/indexScalperKotak';
import { isMcx, type Underlying } from '@/lib/indexScalperInstrument';

export interface StrikeIds { ceId?: string; peId?: string }

export interface FutureContractInfo {
  dhanId: string | null;
  kotakSymbol: string | null;
  expiry: string | null;
  ltp: number | null;
}

const STALE_FEED_MS = 10_000;
/** No live chain for this long after an expiry is picked: show Dhan's REST chain as a snapshot instead. */
const SNAPSHOT_AFTER_MS = 1_000;
/** Snapshot refresh while there is still no live chain (the route caches 30 s; Dhan allows ~1 chain call / 3 s). */
const SNAPSHOT_EVERY_MS = 60_000;

const newId = () => `isx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export interface IndexScalperFeed {
  underlying: Underlying;
  expiries: string[];
  expiry: string;
  setExpiry: (e: string) => void;
  /** LIVE bridge quotes only. Orders, ATM one-click, spot and staleness read this and nothing else. */
  quotes: LiveQuotes | null;
  /** What the chain panel draws: the live quotes, else a REST snapshot (display only, never an order price). */
  chain: LiveQuotes | null;
  chainSource: 'live' | 'snapshot' | null;
  /** Error from the last snapshot fetch, shown in the panel when there is nothing to draw. */
  snapshotError: string | null;
  spot: number | null;
  /** Seconds since the last tick; null when no tick has arrived. */
  feedAgeSec: number | null;
  stale: boolean;
  /** Trading session open now (NSE F&O: 09:15-15:40 IST, the close auction; MCX: 09:00-23:30/23:55 IST). Outside it
   *  nothing fills or sends at market. Index candles keep their own 15:30 cash close (`inMarketSession`). */
  marketOpen: boolean;
  lotSize: number | null;
  strikeIds: Map<number, StrikeIds>;
  /** security id -> last premium, for every strike the bridge tracks. */
  ltpById: Map<string, number>;
  /** security id -> the day's cumulative traded volume (options from the chain; the CRUDEOILM future from the bridge's
   *  `future.volume`), live only. Charts turn its increases into bar volume for a volume-weighted VWAP. */
  volumeById: Map<string, number>;
  /** Future contract for the selected option month (MCX mini future, or Nifty future). */
  future: FutureContractInfo | null;
  /** NIFTY only: its future for the chart's FUT pane (chart only, never traded from here). `ltp` / `volume` are live
   *  when the options bridge tracks this same contract (else null: history only). */
  indexFuture: { dhanId: string; expiry: string; ltp: number | null; volume: number | null } | null;
  /** Kotak contracts when Kotak is the page's broker (null on Dhan, and until both reads land). */
  kotak: KotakContracts | null;
  /** Why Kotak's contracts are not loaded (a read failed; it is retried every 15 s), null while fine or loading. */
  kotakError: string | null;
}

export interface KotakContracts {
  /** For `expiry` only (the expiry on screen): strike -> Kotak trading symbols. */
  expiry: string;
  strikes: Map<number, { ceSymbol?: string; peSymbol?: string }>;
  lotSize: number | null;
  /** Exchange freeze quantity (max units per order), when Kotak's cache lists it: larger closes are sent in slices. */
  freezeQty: number | null;
  /** Every Kotak symbol for this underlying -> its contract, to place and price Kotak positions of any expiry. */
  symbols: Record<string, KotakSymbolInfo>;
}

export function useIndexScalperFeed(
  broker: 'dhan' | 'kotak' = 'dhan',
  underlying: Underlying = 'NIFTY',
): IndexScalperFeed {
  const [viewerId] = useState(newId);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [expiryOwner, setExpiryOwner] = useState<Underlying>(underlying);
  const [lotSize, setLotSize] = useState<number | null>(null);
  const [strikeIdsRaw, setStrikeIdsRaw] = useState<Record<string, StrikeIds>>({});
  const [dhanFuture, setDhanFuture] = useState<{ securityId: string; expiry: string } | null>(null);
  const [kotakFutureSymbol, setKotakFutureSymbol] = useState<string | null>(null);
  const [lookupFor, setLookupFor] = useState('');
  const [nowMs, setNowMs] = useState(0);

  // Fetch expiries whenever underlying changes
  useEffect(() => {
    let dead = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (dead || !j.success || !Array.isArray(j.data) || j.data.length === 0) return;
        setExpiries(j.data);
        setExpiry(prev => (prev && j.data!.includes(prev) ? prev : j.data![0]));
        setExpiryOwner(underlying);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [underlying]);

  // Start the shared tick bridge for this expiry; only when expiryOwner matches underlying (guards against expiry race)
  const startedRef = useRef(false);
  useEffect(() => {
    if (!expiry || expiryOwner !== underlying) return;
    startedRef.current = true;
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 35, broker: 'dhan', viewer: viewerId }),
    }).catch(() => {});
  }, [underlying, expiry, expiryOwner, viewerId]);

  useEffect(() => () => {
    if (!startedRef.current) return;
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop', brokers: ['dhan'], underlying, viewer: viewerId }),
      keepalive: true,
    }).catch(() => {});
  }, [underlying, viewerId]);

  const { liveQuotes: raw, feedAt } = useLiveOptionsWS(expiry, 'dhan', ['dhan'], underlying);
  const quotes = useMemo(() => {
    if (!raw) return null;
    if (raw.underlying && raw.underlying.toUpperCase() !== underlying) return null;
    if (raw.expiry && expiry && raw.expiry !== expiry) return null;
    return raw;
  }, [raw, expiry, underlying]);

  // Dhan contract and lot size lookup
  useEffect(() => {
    if (!expiry || expiryOwner !== underlying) return;
    let dead = false;
    const key = `${underlying}:${expiry}`;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLotSize(null);
    setStrikeIdsRaw({});
    setDhanFuture(null);
    fetch(`/api/scalper/lookup?underlying=${underlying}&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIds>; future?: { securityId: string; expiry: string } } }) => {
        if (dead || !j.success || !j.data) return;
        setStrikeIdsRaw(j.data.strikes ?? {});
        if (j.data.future) setDhanFuture(j.data.future);
        if (typeof j.data.lotSize === 'number' && j.data.lotSize > 0) setLotSize(j.data.lotSize);
        setLookupFor(key);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [underlying, expiry, expiryOwner]);

  // Kotak's contracts for the expiry on screen
  const [kotakLookup, setKotakLookup] = useState<{ expiry: string; strikes: Record<string, { ceSymbol?: string; peSymbol?: string }>; lotSize: number | null; freezeQty: number | null } | null>(null);
  const [kotakSymbols, setKotakSymbols] = useState<Record<string, KotakSymbolInfo> | null>(null);
  const [kotakLookupError, setKotakLookupError] = useState<string | null>(null);
  const [kotakSymbolsError, setKotakSymbolsError] = useState<string | null>(null);
  const KOTAK_RETRY_MS = 15_000;

  useEffect(() => {
    // A Kotak future symbol from an earlier broker / underlying / expiry must never stand in for this one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKotakFutureSymbol(null);
    if (broker !== 'kotak' || !expiry || expiryOwner !== underlying) return;
    let dead = false;
    let done = false;
    const futParam = dhanFuture?.expiry ? `&futureExpiry=${dhanFuture.expiry}` : '';
    const load = () => {
      if (done) return;
      fetch(`/api/scalper/kotak/lookup?underlying=${underlying}&expiry=${expiry}${futParam}`)
        .then(r => r.json())
        .then((j: { success: boolean; error?: string; data?: { lotSize?: number; freezeQty?: number; future?: { trading_symbol?: string }; strikes?: Record<string, { ceSymbol?: string; peSymbol?: string }> } }) => {
          if (dead) return;
          if (!j.success || !j.data) { setKotakLookupError(`Kotak contracts: ${j.error ?? 'lookup failed'} (retrying)`); return; }
          done = true;
          setKotakLookupError(null);
          if (j.data.future?.trading_symbol) setKotakFutureSymbol(j.data.future.trading_symbol);
          setKotakLookup({
            expiry, strikes: j.data.strikes ?? {},
            lotSize: typeof j.data.lotSize === 'number' && j.data.lotSize > 0 ? j.data.lotSize : null,
            freezeQty: typeof j.data.freezeQty === 'number' && j.data.freezeQty > 1 ? j.data.freezeQty : null,
          });
        })
        .catch(e => { if (!dead) setKotakLookupError(`Kotak contracts: ${String((e as Error)?.message ?? e)} (retrying)`); });
    };
    load();
    const t = setInterval(load, KOTAK_RETRY_MS);
    return () => { dead = true; clearInterval(t); };
  }, [broker, underlying, expiry, expiryOwner, dhanFuture?.expiry]);

  useEffect(() => {
    // Another underlying's symbol map must not be used for this one: drop it, then load once (retrying every 15 s
    // only until a read succeeds).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKotakSymbols(null);
    if (broker !== 'kotak') return;
    let dead = false;
    let done = false;
    const load = () => {
      if (done) return;
      fetch(`/api/scalper/kotak/symbol-lookup?underlying=${underlying}`)
        .then(r => r.json())
        .then((j: { success: boolean; error?: string; data?: Record<string, KotakSymbolInfo> }) => {
          if (dead) return;
          if (j.success && j.data) { done = true; setKotakSymbols(j.data); setKotakSymbolsError(null); }
          else setKotakSymbolsError(`Kotak symbols: ${j.error ?? 'lookup failed'} (retrying)`);
        })
        .catch(e => { if (!dead) setKotakSymbolsError(`Kotak symbols: ${String((e as Error)?.message ?? e)} (retrying)`); });
    };
    load();
    const t = setInterval(load, KOTAK_RETRY_MS);
    return () => { dead = true; clearInterval(t); };
  }, [broker, underlying]);

  const kotak = useMemo<KotakContracts | null>(() => {
    if (broker !== 'kotak' || !kotakSymbols || !kotakLookup || kotakLookup.expiry !== expiry) return null;
    const strikes = new Map<number, { ceSymbol?: string; peSymbol?: string }>();
    for (const [k, v] of Object.entries(kotakLookup.strikes)) strikes.set(Number(k), v);
    return { expiry, strikes, lotSize: kotakLookup.lotSize, freezeQty: kotakLookup.freezeQty, symbols: kotakSymbols };
  }, [broker, kotakSymbols, kotakLookup, expiry]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const strikeIds = useMemo(() => {
    const m = new Map<number, StrikeIds>();
    if (lookupFor !== `${underlying}:${expiry}`) return m;
    for (const [k, v] of Object.entries(strikeIdsRaw)) m.set(Number(k), v);
    return m;
  }, [strikeIdsRaw, lookupFor, underlying, expiry]);

  // REST snapshot, only while the live bridge has no chain for this expiry
  const [snapshot, setSnapshot] = useState<LiveQuotes | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  // LIVE prices only (the bridge's chain): SIM fills, SIM closes and leg P&L read this map, so a REST snapshot (or a
  // previous close) must never land in it. Display-only fallbacks read `chain` instead.
  const ltpById = useMemo(() => {
    const m = new Map<string, number>();
    const src = quotes;
    if (!src) return m;
    for (const sd of Object.values(src.strikes ?? {})) {
      const ids = strikeIds.get(Number(sd.strike));
      if (!ids) continue;
      if (ids.ceId && sd.ce?.ltp > 0) m.set(String(ids.ceId), sd.ce.ltp);
      if (ids.peId && sd.pe?.ltp > 0) m.set(String(ids.peId), sd.pe.ltp);
    }
    // CRUDEOILM only: the bridge's spot IS the option month's own future (the contract the lookup returns). NIFTY's spot
    // is the index, not its future, so a NIFTY future gets no price here.
    if (isMcx(underlying) && dhanFuture?.securityId && src.spot > 0) m.set(dhanFuture.securityId, src.spot);
    return m;
  }, [quotes, strikeIds, dhanFuture, underlying]);

  const volumeById = useMemo(() => {
    const m = new Map<string, number>();
    const src = quotes;
    if (!src) return m;
    for (const sd of Object.values(src.strikes ?? {})) {
      const ids = strikeIds.get(Number(sd.strike));
      if (!ids) continue;
      if (ids.ceId && sd.ce?.volume > 0) m.set(String(ids.ceId), sd.ce.volume);
      if (ids.peId && sd.pe?.volume > 0) m.set(String(ids.peId), sd.pe.volume);
    }
    // The bridge's future is the option month's own (CRUDEOILM): its volume belongs to that contract only.
    const fv = src.future?.volume;
    if (isMcx(underlying) && dhanFuture?.securityId && fv && fv > 0 && (!src.future?.expiry || src.future.expiry === dhanFuture.expiry)) {
      m.set(dhanFuture.securityId, fv);
    }
    return m;
  }, [quotes, strikeIds, dhanFuture, underlying]);

  const indexFuture = useMemo(() => {
    if (isMcx(underlying) || !dhanFuture?.securityId) return null;
    const f = quotes?.future;
    const same = !!f && f.ltp > 0 && String(f.expiry ?? '').slice(0, 10) === dhanFuture.expiry.slice(0, 10);
    return {
      dhanId: dhanFuture.securityId,
      expiry: dhanFuture.expiry.slice(0, 10),
      ltp: same ? f!.ltp : null,
      volume: same && f!.volume && f!.volume > 0 ? f!.volume : null,
    };
  }, [underlying, dhanFuture, quotes?.future]);

  const hasLive = !!quotes;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot(prev => (prev && prev.expiry === expiry ? prev : null));
    if (!expiry || expiryOwner !== underlying || hasLive) return;
    let dead = false;
    const load = () => {
      fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&allowStale=1`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: RestChain; error?: string; as_of?: number }) => {
          if (dead) return;
          const snap = j.success && j.data ? chainSnapshot(j.data, underlying, expiry, j.as_of ?? Date.now()) : null;
          if (snap) { setSnapshot(snap); setSnapshotError(null); } else setSnapshotError(j.error ?? 'Option chain unavailable');
        })
        .catch(e => { if (!dead) setSnapshotError(String((e as Error)?.message ?? e)); });
    };
    const first = setTimeout(load, SNAPSHOT_AFTER_MS);
    const every = setInterval(load, SNAPSHOT_EVERY_MS);
    return () => { dead = true; clearTimeout(first); clearInterval(every); };
  }, [underlying, expiry, expiryOwner, hasLive]);
  const chain = quotes ?? (snapshot && snapshot.expiry === expiry ? snapshot : null);

  const feedMs = feedAt ? Date.parse(feedAt) : NaN;
  const changeMs = quotes?.updated_at ? Date.parse(quotes.updated_at) : 0;
  const lastTick = !quotes ? 0 : Number.isFinite(feedMs) && feedMs > 0 ? feedMs : changeMs;
  const feedAgeSec = lastTick > 0 && nowMs > 0 ? Math.max(0, (nowMs - lastTick) / 1000) : null;
  const spot = quotes && quotes.spot > 0 ? quotes.spot : null;

  const future = useMemo<FutureContractInfo | null>(() => {
    // Futures trade on this page for CRUDEOILM only (see ltpById: NIFTY's spot is the index, not a futures price).
    if (!isMcx(underlying) || (!dhanFuture && !kotakFutureSymbol)) return null;
    const src = quotes ?? snapshot;
    const futLtp = (dhanFuture?.securityId ? ltpById.get(dhanFuture.securityId) : null) ?? (src && src.spot > 0 ? src.spot : null);
    return {
      dhanId: dhanFuture?.securityId ?? null,
      kotakSymbol: kotakFutureSymbol ?? null,
      expiry: dhanFuture?.expiry ?? null,
      ltp: futLtp,
    };
  }, [underlying, dhanFuture, kotakFutureSymbol, ltpById, quotes, snapshot]);

  return {
    underlying,
    expiries, expiry, setExpiry, quotes, chain, chainSource: quotes ? 'live' : chain ? 'snapshot' : null, snapshotError,
    spot, feedAgeSec,
    stale: feedAgeSec !== null && feedAgeSec > STALE_FEED_MS / 1000,
    marketOpen: nowMs > 0 && inOrderSession(underlying, nowMs),
    lotSize: lookupFor === `${underlying}:${expiry}` ? lotSize : null,
    strikeIds, ltpById, volumeById, future, indexFuture,
    kotak, kotakError: broker === 'kotak' && !kotak ? (kotakSymbolsError ?? kotakLookupError) : null,
  };
}
