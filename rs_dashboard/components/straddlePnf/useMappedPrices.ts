'use client';

// A Renko index chart's option chain, and the live premium of the option each direction of its map would trade NOW (ATM +/- N at the
// index's live price) for the BULL / BEAR buttons. A preview only: the order itself is resolved by the server at the click
// (lib/pnfIndexTradeServer.ts). Read-only: the chain from /api/straddle-pnf/contracts, the contract's ids from /api/straddle-pnf/order
// (GET, ids only - no broker lookup), the price from the bridge (/api/straddle-pnf/live).

import { useEffect, useState } from 'react';
import { pickExpiry, pickStrike, type IndexDir, type IndexMap } from '@/lib/pnfIndexMap';
import { targetKey, type Target } from '@/lib/pnfTarget';
import { useTradedLive } from './useIndexHeld';

export type OptionChain = { symbol: string; want: string; expiries: string[]; expiry: string | null; strikes: number[] };
export type MappedPrice = { strike: number; opt: 'CE' | 'PE'; ltp: number | null } | null;

/** Re-read every few minutes (an expiry that lapses while the page is open drops off the list); a failed read is retried sooner. */
const CHAIN_REFRESH_MS = 5 * 60_000, CHAIN_RETRY_MS = 15_000;

/** The index's option chain for `want` ('' = nearest). ONE fetch per page, shared by the map controls and the buttons. */
export function useOptionChain(symbol: string, want: string, enabled: boolean): OptionChain | null {
  const [chain, setChain] = useState<OptionChain | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let dead = false, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let ok = false;
      try {
        const q = new URLSearchParams({ kind: 'options', underlying: symbol, nospot: '1', ...(want ? { expiry: want } : {}) });
        const j = await (await fetch(`/api/straddle-pnf/contracts?${q}`)).json() as { success?: boolean; expiries?: string[]; expiry?: string; strikes?: number[] };
        if (!dead && j.success) { setChain({ symbol, want, expiries: j.expiries ?? [], expiry: j.expiry ?? null, strikes: j.strikes ?? [] }); ok = true; }
      } catch { /* retried below */ }
      if (!dead) timer = setTimeout(() => { void load(); }, ok ? CHAIN_REFRESH_MS : CHAIN_RETRY_MS);
    };
    void load();
    return () => { dead = true; if (timer) clearTimeout(timer); };
  }, [symbol, want, enabled]);
  return chain && chain.symbol === symbol && chain.want === want ? chain : null;
}

/** `SEG:ID` of an option target from the master list (one lookup per contract; a strike change looks up the new one). */
function useIds(target: Target | null): string | null {
  const key = target ? targetKey(target) : null;
  const [got, setGot] = useState<{ key: string; ids: string } | null>(null);
  useEffect(() => {
    if (!target || !key) return;
    let dead = false;
    void (async () => {
      try {
        const q = new URLSearchParams({ broker: 'dhan', idsOnly: '1', target: JSON.stringify(target) });
        const j = await (await fetch(`/api/straddle-pnf/order?${q}`)).json() as { success?: boolean; ids?: string };
        if (!dead && j.success && j.ids && !j.ids.includes(',')) setGot({ key, ids: j.ids });
      } catch { /* no price for this one */ }
    })();
    return () => { dead = true; };
    // the target is fully described by its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return got && got.key === key ? got.ids : null;
}

/** How long the previous strike's price stays on the button while the new strike's price is fetched (then: ₹–). */
const HOLD_MS = 5_000;

/**
 * The price shown for one direction: the current strike's, or - for a moment after the ATM moved to a new strike, until its first
 * price arrives - the previous strike WITH its own strike (never a new strike next to an old price), so the button does not blink.
 */
function useShown(cur: MappedPrice): MappedPrice {
  const [last, setLast] = useState<MappedPrice>(null);
  const priced = cur !== null && cur.ltp !== null && cur.ltp > 0;
  const curKey = cur ? `${cur.strike}${cur.opt}` : '';
  const lastKey = last ? `${last.strike}${last.opt}` : '';
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the held price follows the live one: that IS its job
    if (priced) { setLast(cur); return; }
    if (!last || lastKey === curKey) return;
    const t = setTimeout(() => setLast(null), HOLD_MS);   // the new strike never priced: stop showing the old one
    return () => clearTimeout(t);
  // cur is described by its key and price
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, cur?.ltp, priced, lastKey]);
  if (priced || !last || lastKey === curKey) return cur;
  return last;
}

export function useMappedPrices(o: { chain: OptionChain | null; symbol: string; map: IndexMap; spot: number | null; enabled: boolean }): Record<IndexDir, MappedPrice> {
  const ch = o.chain;
  const expiry = ch ? pickExpiry(o.map, ch.expiries) : null;
  const strikes = ch && ch.expiry === expiry ? ch.strikes : [];
  const targetOf = (d: IndexDir): Target | null => {
    const leg = o.map[d];
    const k = o.enabled && expiry ? pickStrike(strikes, o.spot, leg.opt, leg.offset) : null;
    return k === null ? null : { kind: 'options', symbol: o.symbol, name: o.symbol, expiry: expiry!, strike: k, side: leg.opt };
  };
  const bullT = targetOf('bull'), bearT = targetOf('bear');
  const bullLive = useTradedLive(useIds(bullT)), bearLive = useTradedLive(useIds(bearT));
  const out = (t: Target | null, ltp: number | null): MappedPrice => (t && t.kind === 'options' && t.strike && (t.side === 'CE' || t.side === 'PE') ? { strike: t.strike, opt: t.side, ltp } : null);
  return { bull: useShown(out(bullT, bullLive.ltp)), bear: useShown(out(bearT, bearLive.ltp)) };
}
