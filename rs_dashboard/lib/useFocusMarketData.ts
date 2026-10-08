'use client';

/**
 * Market data the Focus Tool page polls on its own: per-index expiries, spot,
 * futures, lot sizes + order handles (lookup) and the option chain. Pulled out of
 * FocusTool.tsx so the page component only consumes the results.
 *
 * Everything is scoped to `watched` — the indices in use (NIFTY always, the others
 * once they have a row or a started group) — so an unused index costs no calls.
 * The header futures strip is the one exception: one batched call for all three.
 */

import React, { useEffect, useState } from 'react';
import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { absDelta100, modelAbsDelta100 } from '@/lib/focusToolRules';
import { futureQuote } from '@/lib/optionsPricing';
import type { FocusRow, FocusIndexGroup } from '@/lib/focusToolRows';
import { FOCUS_UNDERLYINGS, UNDERLYING_META, type FocusUnderlying } from '@/lib/focusToolUnderlyings';

const UNDERLYINGS: FocusUnderlying[] = [...FOCUS_UNDERLYINGS];

export interface FutQuote {
  ltp: number;
  change_pct: number | null;
}

/** Per-strike order handles from /api/scalper[/<broker>]/lookup. Dhan is the
 *  only broker that trades by numeric security id; the rest trade by symbol. */
export interface StrikeRef { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }
export interface LookupData { lotSize: number; strikes: Record<string, StrikeRef> }

/** Spot + per-strike premiums/OI, flattened out of /api/options/chain.
 *  LTP drives the premium column; OI feeds OI PCR when the WS bridge is on a
 *  different expiry than this row (bridge stays on nearest). */
export interface ChainData {
  spot: number;
  oc: Record<string, { ce: number; pe: number; ceOi?: number | null; peOi?: number | null; ceDelta?: number | null; peDelta?: number | null; ceDeltaDhan?: number | null; peDeltaDhan?: number | null }>;
}

/** Cache key for `lookups`/`chains` — a row can trade any listed expiry, not
 *  just the nearest, so both caches are keyed per (underlying, expiry) pair
 *  rather than per underlying alone. */
export function expKey(underlying: FocusUnderlying, expiry: string): string {
  return `${underlying}:${expiry}`;
}

/** The option chain keys strikes as '24250.000000'; every other source uses
 *  '24250'. Normalise both onto the integer form before joining them. */
export function strikeKey(n: number | string): string {
  return String(Math.round(Number(n)));
}

export interface FocusMarketData {
  futQuotes: Record<FocusUnderlying, FutQuote | null>;
  spotPrices: Record<FocusUnderlying, number>;
  lotSizes: Record<FocusUnderlying, number | null>;
  expiries: Record<FocusUnderlying, string[]>;
  lookups: Record<string, LookupData | null>;
  chains: Record<string, ChainData | null>;
}

export function useFocusMarketData({ broker, watched, watchedKey, rows, groups }: {
  broker: Broker;
  watched: readonly FocusUnderlying[];
  watchedKey: string;
  rows: readonly FocusRow[];
  groups: readonly FocusIndexGroup[];
}): FocusMarketData {
  const [futQuotes, setFutQuotes] = useState<Record<FocusUnderlying, FutQuote | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null, CRUDEOILM: null,
  });
  const [spotPrices, setSpotPrices] = useState<Record<FocusUnderlying, number>>({
    NIFTY: 0, BANKNIFTY: 0, SENSEX: 0, CRUDEOILM: 0,
  });
  const [lotSizes, setLotSizes] = useState<Record<FocusUnderlying, number | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null, CRUDEOILM: null,
  });
  const [expiries, setExpiries] = useState<Record<FocusUnderlying, string[]>>({
    NIFTY: [], BANKNIFTY: [], SENSEX: [], CRUDEOILM: [],
  });
  // Keyed by expKey(underlying, expiry) — a row can trade any listed expiry,
  // not just the nearest, so these can no longer be one entry per underlying.
  // See expKey's doc comment.
  const [lookups, setLookups] = useState<Record<string, LookupData | null>>({});
  const [chains, setChains] = useState<Record<string, ChainData | null>>({});

  useEffect(() => {
    watched.forEach(u => {
      fetch(`/api/options/expiries?underlying=${u}&broker=${broker}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (j.success && j.data) setExpiries(prev => ({ ...prev, [u]: j.data! }));
        })
        .catch(() => {});
    });
  }, [broker, watched]);

  useEffect(() => {
    const fetchTopIndices = () => {
      fetch('/api/scalper/top-indices')
        .then(r => r.json())
        .then((j: { success?: boolean; quotes?: Record<string, { ltp: number; change_pct: number | null }> }) => {
          if (!j.quotes) return;
          const q = j.quotes;
          // Spot only. This endpoint has no futures rows at all — the header's
          // futures strip is served by /api/focus-tool/futures below — and it
          // dropped SENSEX in favour of CRUDEOIL, so SENSEX spot comes off its
          // option chain instead (see the chain effect).
          const KEY_MAP: Record<string, FocusUnderlying> = {
            'NIFTY 50': 'NIFTY', 'NIFTY': 'NIFTY', 'BANKNIFTY': 'BANKNIFTY', 'SENSEX': 'SENSEX', 'CRUDEOILM': 'CRUDEOILM',
          };
          setSpotPrices(prev => {
            const next = { ...prev };
            for (const [key, val] of Object.entries(q)) {
              const u = KEY_MAP[key];
              if (u && val?.ltp) {
                next[u] = val.ltp;
              }
            }
            return next;
          });
        })
        .catch(() => {});
    };
    fetchTopIndices();
    const t = setInterval(fetchTopIndices, 2000);
    return () => clearInterval(t);
  }, [broker]);

  // ── Futures strip ───────────────────────────────────────────────
  // /api/focus-tool/futures exists precisely for this header: futures contract
  // ids expire, so it resolves them once per IST day and then quotes them off
  // Dhan's batched OHLC endpoint. % change comes from the same response —
  // the route caches the first genuine (pre-15:30-flip) close each day and
  // guards against a later flipped value, so this never needs to reason about
  // the flip itself. The header hides the % when it's still null (no genuine
  // close cached yet today).
  useEffect(() => {
    const fetchFuts = () => {
      fetch('/api/focus-tool/futures')
        .then(r => r.json())
        .then((j: { quotes?: Record<string, { ltp: number; change_pct: number | null }> }) => {
          if (!j.quotes) return;
          setFutQuotes(prev => {
            const next = { ...prev };
            for (const u of UNDERLYINGS) {
              const q = j.quotes?.[u];
              if (q && q.ltp > 0) next[u] = { ltp: q.ltp, change_pct: q.change_pct ?? null };
            }
            return next;
          });
        })
        .catch(() => {});
    };
    fetchFuts();
    const t = setInterval(fetchFuts, 3000);
    return () => clearInterval(t);
  }, []);

  // The nearest expiry per underlying, as a scalar dep. `expiries` is replaced
  // wholesale on every fetch, so depending on the object itself would re-run
  // these effects on every poll even when nothing changed.
  const expiryKey = UNDERLYINGS.map(u => expiries[u]?.[0] ?? '').join('|');
  // Every row's own picked expiry (or '' if it hasn't picked one yet), as a
  // scalar dep — a row can trade any listed expiry, not just nearest, so the
  // lookup/chain effects below must also warm whatever a row actually picked.
  const rowExpiryKey = rows.map(r => `${r.underlying}:${r.expiry ?? ''}`).join('|');

  // ── Lot sizes + per-strike order handles ────────────────────────
  // One lookup per (underlying, expiry): it carries the lot size AND the
  // ce/pe security ids (Dhan) or trading symbols (everyone else) that the leg
  // buttons need to place an order. Nearest expiry is pre-warmed for every
  // underlying unconditionally (see the chain effect below for why); each
  // row's own picked expiry is added on top since it may not be nearest.
  const lookupSeq = React.useRef(0);
  useEffect(() => {
    const seq = ++lookupSeq.current;
    const pairs = new Map<string, { u: FocusUnderlying; expiry: string }>();
    watched.forEach(u => {
      const nearest = expiries[u]?.[0];
      if (nearest) pairs.set(expKey(u, nearest), { u, expiry: nearest });
    });
    rows.forEach(r => {
      const e = r.expiry || expiries[r.underlying]?.[0];
      if (e) pairs.set(expKey(r.underlying, e), { u: r.underlying, expiry: e });
    });
    pairs.forEach(({ u, expiry }) => {
      fetch(`${scalperRoute(broker, 'lookup')}?underlying=${u}&expiry=${expiry}`)
        .then(r => r.json())
        .then((j: { success?: boolean; data?: LookupData }) => {
          // Out-of-order guard: a slow lookup for the previous broker must not
          // land on top of the current one's — those ids place orders.
          if (seq !== lookupSeq.current) return;
          if (!j.success || !j.data?.strikes) return;
          setLookups(prev => ({ ...prev, [expKey(u, expiry)]: j.data! }));
          if (Number(j.data.lotSize) > 0) {
            // MCX: the page works in barrels, so its lot is barrels-per-lot, a constant. The
            // lookup's own figure is not used: Dhan reports 1 (order quantity is in lots) and
            // Kotak a different unit again, so multiplying it would size SIM rows wrongly.
            const unitsPerLot = UNDERLYING_META[u].unitsPerLot;
            const lot = UNDERLYING_META[u].segment === 'MCX_COMM' ? unitsPerLot : Number(j.data!.lotSize);
            setLotSizes(prev => ({ ...prev, [u]: lot }));
          }
        })
        .catch(() => {});
    });
  }, [broker, expiryKey, rowExpiryKey, watchedKey]);

  // ── Option premiums ─────────────────────────────────────────────
  // The chain is the fallback LTP source for every underlying, and the spot
  // source for SENSEX. The standalone tick bridge (useFocusToolWS, all three
  // underlyings) is preferred per-strike in rowLive below because it's
  // realtime; the chain route caches 10s and is paced ~1 call/3s per
  // underlying account-wide, so it is polled at that cadence and only for
  // underlyings that actually have rows.
  // Pre-warmed, not lazy. Both /api/options/chain and /api/scalper/lookup spawn
  // Python on a cold cache — measured at 6.5s and 2.7s respectively, against
  // ~7ms once warm. Waiting until a row exists put that cold spawn in front of
  // the first trade of the day, which is the worst possible place for it. An
  // underlying whose GROUP is started is warmed even with no rows yet.
  const activeUnderlyings = UNDERLYINGS.filter(u =>
    rows.some(r => r.underlying === u)
    || groups.some(g => g.underlying === u && g.enabled));
  const activeKey = activeUnderlyings.join('|');
  const chainSeq = React.useRef(0);
  useEffect(() => {
    if (!activeKey) return;
    const seq = ++chainSeq.current;
    const fetchChains = () => {
      const pairs = new Map<string, { u: FocusUnderlying; expiry: string }>();
      activeKey.split('|').forEach(name => {
        const u = name as FocusUnderlying;
        const nearest = expiries[u]?.[0];
        if (nearest) pairs.set(expKey(u, nearest), { u, expiry: nearest });
      });
      // Every row's own picked expiry, even on an underlying whose group
      // isn't "active" by the enabled/has-rows test above — a lone draft row
      // pointed at a further expiry still needs its own chain to resolve
      // PREMIUM-mode strikes and show a live LTP.
      rows.forEach(r => {
        const e = r.expiry || expiries[r.underlying]?.[0];
        if (e) pairs.set(expKey(r.underlying, e), { u: r.underlying, expiry: e });
      });
      pairs.forEach(({ u, expiry }) => {
        // Always Dhan's chain (market data is Dhan-sourced whichever broker
        // places the orders): for Kotak / Zerodha the route otherwise serves a
        // strike list with no prices or Greeks while their quote bridge runs,
        // which left premium / delta strike criteria unresolved and delta
        // stops silently falling back to SL ×. The route caches it 30 s.
        fetch(`/api/options/chain?underlying=${u}&expiry=${expiry}&broker=dhan`)
          .then(r => r.json())
          .then((j: {
            success?: boolean;
            data?: { spot?: number; future_price?: number; future_expiry?: string; chain?: { last_price?: number; oc?: Record<string, {
              ce?: { last_price?: number; oi?: number; implied_volatility?: number; top_bid_price?: number; top_ask_price?: number; greeks?: { delta?: number } };
              pe?: { last_price?: number; oi?: number; implied_volatility?: number; top_bid_price?: number; top_ask_price?: number; greeks?: { delta?: number } };
            }> } };
          }) => {
            if (seq !== chainSeq.current) return;
            const oc = j.data?.chain?.oc;
            // A failed chain fetch surfaces as 200 OK with no `oc`. Holding the
            // last good chain beats blanking every premium on one 429.
            if (!j.success || !oc) return;
            const flat: ChainData['oc'] = {};
            // MCX: chain.last_price is a lagging snapshot (measured 4.7% behind), while the route's own
            // `spot` is the live futures quote the chain sits on, so use that for ATM and deltas.
            const lastPrice = Number(j.data?.chain?.last_price ?? 0);
            const chainSpot = UNDERLYING_META[u].segment === 'MCX_COMM' && Number(j.data?.spot) > 0 ? Number(j.data?.spot) : lastPrice;
            const market = { spot: chainSpot, future: futureQuote(j.data?.future_price, j.data?.future_expiry) };
            for (const [k, v] of Object.entries(oc)) {
              const ceOiRaw = v.ce?.oi;
              const peOiRaw = v.pe?.oi;
              flat[strikeKey(k)] = {
                ce: Number(v.ce?.last_price ?? 0),
                pe: Number(v.pe?.last_price ?? 0),
                // Keep absolute OI so non-nearest rows (WS gated off) can still
                // show OI PCR — same chain that already backs their LTP.
                ceOi: ceOiRaw != null && Number(ceOiRaw) >= 0 ? Number(ceOiRaw) : null,
                peOi: peOiRaw != null && Number(peOiRaw) >= 0 ? Number(peOiRaw) : null,
                // |delta| × 100 for AlgoTest's delta strike / SL / target / trail rules, from the central
                // pricing recipe so it matches every other page; Dhan's own delta only when the model
                // cannot price the strike (it sends 0 when it has none — read as missing).
                ceDelta: modelAbsDelta100('CE', Number(k), expiry, v.ce?.last_price, v.ce?.implied_volatility, v.ce?.greeks?.delta, market, { bid: v.ce?.top_bid_price, ask: v.ce?.top_ask_price }),
                peDelta: modelAbsDelta100('PE', Number(k), expiry, v.pe?.last_price, v.pe?.implied_volatility, v.pe?.greeks?.delta, market, { bid: v.pe?.top_bid_price, ask: v.pe?.top_ask_price }),
                // Dhan's own delta, kept for legs whose entry delta was recorded before the model delta (see legDeltaBasis).
                ceDeltaDhan: absDelta100(v.ce?.greeks?.delta),
                peDeltaDhan: absDelta100(v.pe?.greeks?.delta),
              };
            }
            setChains(prev => ({ ...prev, [expKey(u, expiry)]: { spot: chainSpot, oc: flat } }));
          })
          .catch(() => {});
      });
    };
    fetchChains();
    const t = setInterval(fetchChains, 3000);
    return () => clearInterval(t);
  }, [broker, expiryKey, activeKey, rowExpiryKey]);

  return { futQuotes, spotPrices, lotSizes, expiries, lookups, chains };
}
