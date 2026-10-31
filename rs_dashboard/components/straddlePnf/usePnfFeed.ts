'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  foldTick, inSession, mergeHistory, feedCloseTrusted, istMinuteOfDay, isWildTick, legsTick, sessionWindow,
  type LegQuote, type Market, type Tick,
} from '@/lib/straddlePnfLive';
import { isNseTradingDay, istDateIso } from '@/lib/nseHolidays';
import { sessionOf, type Bar } from '@/lib/straddlePnf';
import { isComplete, targetKey, targetLabel, targetQuery, type Target } from '@/lib/pnfTarget';

// One chart's price series on the Point & Figure page: the history (re-fetched every 30 s) and the live price from the
// WebSocket bridge folded into the open bar. Each chart runs its own, so two charts can show two instruments. A new target
// drops everything of the old one before loading, so no refresh, tick or alert crosses over. `target` null = idle.

export type Instrument = { segment: string; security_id: string };
export type Loaded = { key: number; dataDate: string | null; error?: string; instruments: Instrument[]; anchorT: number | null };
type LiveLeg = { quote: (NonNullable<LegQuote> & { prevClose: number | null }) | null; last: { ltp: number; prevClose: number | null } | null };

const POLL_MS = 30_000;
const LIVE_MS = 1_000;   // how often the chart reads the WebSocket bridge's latest price (the bridge itself is push, from the shared hub)
const FRESH_S = 180;

export function usePnfFeed(target: Target | null, recenter: number, now: number) {
  const [bars, setBars] = useState<Bar[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [name, setName] = useState<string | null>(null);   // the full name the server resolved for the chosen symbol
  // Bumped on every history load: the confirmed chart is rebuilt then (the API may have revised closed bars).
  const [histVersion, setHistVersion] = useState(0);
  // Bumped on every reset load (new instrument / Re-center): the alerts re-baseline on it, so history never alerts.
  const [epoch, setEpoch] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedPrevClose, setFeedPrevClose] = useState<number | null>(null);
  // A feed price outside the trading session (NSE pre-open, post-close): shown in the header, never folded into a chart bar.
  const [outQuote, setOutQuote] = useState<{ ce: number; pe: number; t: number } | null>(null);
  // The newest WebSocket price; kept so a history refresh (which replaces the bars) can lay it back on top.
  const tickRef = useRef<Tick | null>(null);
  // The last bar's close, for the live poll's bad-tick check (kept in a ref so the poll interval need not restart per tick).
  const lastCloseRef = useRef<number | undefined>(undefined);
  const reqRef = useRef(0);

  const complete = target !== null && isComplete(target);
  const tKey = target ? targetKey(target) : '';   // any field changing is a new instrument

  // A new instrument: everything on screen belongs to the old one. Runs before the load effect below (same commit).
  useEffect(() => {
    reqRef.current++;
    tickRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeedPrevClose(null); setOutQuote(null); setLoaded(null); setBars([]); setName(null); setLoadError(null); setLoading(true);
  }, [tKey]);

  // reset = new instrument / Re-center (alerts restart); otherwise a quiet refresh.
  const load = useCallback(async (reset: boolean) => {
    if (!complete || !target) return;     // a future / option waits for its contract (the pickers fill it in)
    const id = ++reqRef.current;
    if (reset) { setLoading(true); setLoadError(null); }
    try {
      const res = await fetch(`/api/straddle-pnf?${targetQuery(target)}`);
      const j = await res.json() as {
        success?: boolean; error?: string; strikes: number[]; dataDate: string | null; name?: string; instruments?: Instrument[];
        instrument?: Instrument | null; anchorT?: number | null; bars: Record<string, Bar[]>; errors: Record<string, string>;
      };
      if (id !== reqRef.current) return; // a newer request owns the screen
      if (!j.success) throw new Error(j.error ?? 'Failed to load price history');
      const key = j.strikes[0] ?? 0;
      const hist = j.bars[String(key)] ?? [];
      const tk = tickRef.current;
      const instruments = j.instruments ?? (j.instrument ? [j.instrument] : []);
      setBars(prev => mergeHistory(hist, prev, tk, instruments.length < 2));
      setHistVersion(v => v + 1);
      if (reset) setEpoch(n => n + 1);
      setLoaded({ key, dataDate: j.dataDate, error: j.errors?.[String(key)], instruments, anchorT: j.anchorT ?? null });
      if (j.name) setName(j.name);
      setLoadError(null);
    } catch (e) {
      if (id !== reqRef.current) return;
      setLoadError(e instanceof Error ? e.message : 'Failed to load price history');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tKey, complete]);

  // The load is the effect's job (instrument changed / Re-center); its loading flag is set synchronously on purpose.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(true); }, [load, recenter]);
  useEffect(() => {
    if (!complete) return;
    const id = setInterval(() => { void load(false); }, POLL_MS);
    return () => clearInterval(id);
  }, [load, complete]);

  // ── live price over the WebSocket bridge → the open bar ─────────────────
  const instruments = loaded?.instruments ?? [];
  const ids = instruments.map(i => `${i.segment}:${i.security_id}`).join(',');
  const single = instruments.length < 2;
  // The session clock follows the contract: MCX for a commodity future / option, NSE otherwise.
  const market: Market = instruments[0]?.segment === 'MCX_COMM' ? 'MCX' : 'NSE';
  useEffect(() => {
    if (!ids) return;
    let dead = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/straddle-pnf/live?ids=${ids}`);
        const j = await res.json() as { success?: boolean; legs?: LiveLeg[] };
        if (dead || !j.success || !j.legs) return;
        const legs = j.legs;
        // A straddle's previous close is the sum of both legs', and only when both have one.
        const closes = legs.map(l => l.quote?.prevClose ?? l.last?.prevClose ?? null);
        setFeedPrevClose(closes.every(c => c !== null) ? closes.reduce((a, c) => a + (c as number), 0) : null);
        const tick = legsTick(legs.map(l => l.quote));
        if (!tick) { setOutQuote(null); return; }
        // A print 10x away from the last bar is a bad tick, not a move: it never reaches the chart (the next history load has the truth).
        if (isWildTick(lastCloseRef.current, tick.ce + tick.pe)) return;
        // Pre-open values are indicative, not trades, and the history API has no bars for them: header only.
        if (!inSession(tick.t, market)) { setOutQuote({ ce: tick.ce, pe: tick.pe, t: tick.t }); return; }
        setOutQuote(null);
        tickRef.current = tick;
        setBars(prev => (prev.length ? foldTick(prev, tick, single).bars : prev));
      } catch { /* the header keeps the last price and shows Stale until the next read lands */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, LIVE_MS);
    return () => { dead = true; clearInterval(id); };
  }, [ids, market, single]);

  const last = bars[bars.length - 1];
  useEffect(() => { lastCloseRef.current = last?.straddle; });

  const stale = now === 0 || !last || now / 1000 - last.t > FRESH_S;
  const live = outQuote ? { ce: outQuote.ce, pe: outQuote.pe } : last ? { ce: last.ce, pe: last.pe } : null;
  const sessionTag = outQuote ? (istMinuteOfDay(outQuote.t) < sessionWindow(market, outQuote.t)[0] ? 'Pre-open' : 'Post-close') : null;
  // The feed's previous close is the official one (a stock's closing price is not its last 1-min close), but only until the bell.
  const tradingDay = market === 'NSE' ? isNseTradingDay(istDateIso(now)) : true;
  // Before today's first price the header shows the last session's close, measured (from history) against the session before it.
  const priceToday = (outQuote ? sessionOf(outQuote.t) : last ? sessionOf(last.t) : null) === istDateIso(now);
  const trustedPrevClose = now > 0 && priceToday && feedCloseTrusted(now / 1000, market, tradingDay) ? feedPrevClose : null;
  // The chart's name for the alert log and the header's scrip: the symbol (with its full name for an index / stock), or the contract.
  const label = target ? targetLabel(target) : '';
  const fno = target?.kind === 'futures' || target?.kind === 'options';
  const scrip = !target ? '' : fno ? label : name && name !== target.symbol ? `${target.symbol} · ${name}` : target.symbol;

  return {
    bars, loaded, name, loading, loadError, histVersion, epoch, market, complete, live, stale, sessionTag, trustedPrevClose, label, scrip,
  };
}

export type PnfFeed = ReturnType<typeof usePnfFeed>;
