'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mergeHistory, feedCloseTrusted, istMinuteOfDay, sessionWindow, type LegQuote, type Market, type Tick } from '@/lib/straddlePnfLive';
import { FEED_FRESH_S, foldLive, idsOf, liveRead, marketOf, type Instrument } from '@/lib/pnfFeedCore';
import { mergeTail } from '@/lib/pnfTail';
import { bucketTickBars, foldTickRows, newTickBuild, spliceTicks, type SecBuild, type TickRow } from '@/lib/pnfTicks';
import { isNseTradingDay, istDateIso } from '@/lib/nseHolidays';
import { sessionOf, type Bar } from '@/lib/straddlePnf';
import { isComplete, targetKey, targetLabel, targetQuery, type Target } from '@/lib/pnfTarget';

// One chart's price series on the Point & Figure page: the history (re-fetched every 30 s) and the live price from the
// WebSocket bridge folded into the open bar. Each chart runs its own, so two charts can show two instruments. A new target
// drops everything of the old one before loading, so no refresh, tick or alert crosses over. `target` null = idle.

export type { Instrument };
export type Loaded = { key: number; dataDate: string | null; error?: string; instruments: Instrument[]; anchorT: number | null; cas?: boolean };
type LiveLeg = { quote: (NonNullable<LegQuote> & { prevClose: number | null }) | null; last: { ltp: number; prevClose: number | null } | null };

const POLL_MS = 30_000;
/** Sessions the refresh of a long-history chart asks for (a holiday week and a bar revision both fit inside). */
const TAIL_SESSIONS = 4;
const LIVE_MS = 1_000;   // how often the chart reads the WebSocket bridge's latest price (the bridge itself is push, from the shared hub)
const TICKS_MS = 1_000;
const NO_BARS: Bar[] = [];  // Renko Tick mode: how often the bridge's tick log is read (/api/straddle-pnf/ticks)

/**
 * `tickSec`: Renko Tick / N-second bars — the bridge's recorded prices replace the live minute fold (lib/pnfTicks.ts): 0 = one bar per
 * recorded price, N = N-second bars; null = 1-minute bars.
 */
export function usePnfFeed(target: Target | null, recenter: number, now: number, tickSec: number | null = null) {
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
  // Tick mode only: the live route's latest in-session price, for the header.
  const [headTick, setHeadTick] = useState<{ ce: number; pe: number } | null>(null);
  // The newest WebSocket price; kept so a history refresh (which replaces the bars) can lay it back on top.
  const tickRef = useRef<Tick | null>(null);
  // The last bar's close, for the live poll's bad-tick check (kept in a ref so the poll interval need not restart per tick).
  const lastCloseRef = useRef<number | undefined>(undefined);
  const tickMode = tickSec !== null;
  const reqRef = useRef(0);
  // An index carries two years of 1-minute bars: the first load takes them all, the 30 s refresh only the last few sessions.
  const fullRef = useRef(false);

  const complete = target !== null && isComplete(target);
  const tKey = target ? targetKey(target) : '';   // any field changing is a new instrument

  // A new instrument: everything on screen belongs to the old one. Runs before the load effect below (same commit).
  useEffect(() => {
    reqRef.current++;
    tickRef.current = null;
    fullRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeedPrevClose(null); setOutQuote(null); setLoaded(null); setBars([]); setName(null); setLoadError(null); setLoading(true);
  }, [tKey]);

  // reset = new instrument / Re-center (alerts restart); otherwise a quiet refresh.
  const load = useCallback(async (reset: boolean) => {
    if (!complete || !target) return;     // a future / option waits for its contract (the pickers fill it in)
    const id = ++reqRef.current;
    if (reset) { setLoading(true); setLoadError(null); }
    try {
      const tail = !reset && fullRef.current && target.kind === 'index';
      const res = await fetch(`/api/straddle-pnf?${targetQuery(target)}${tail ? `&tail=${TAIL_SESSIONS}` : ''}`);
      const j = await res.json() as {
        success?: boolean; error?: string; strikes: number[]; dataDate: string | null; name?: string; instruments?: Instrument[];
        instrument?: Instrument | null; anchorT?: number | null; cas?: boolean; bars: Record<string, Bar[]>; errors: Record<string, string>;
      };
      if (id !== reqRef.current) return; // a newer request owns the screen
      if (!j.success) throw new Error(j.error ?? 'Failed to load price history');
      const key = j.strikes[0] ?? 0;
      const hist = j.bars[String(key)] ?? [];
      const tk = tickRef.current;
      const instruments = j.instruments ?? (j.instrument ? [j.instrument] : []);
      if (!tail) fullRef.current = true;
      setBars(prev => mergeHistory(tail ? mergeTail(prev, hist) : hist, prev, tk, instruments.length < 2));
      setHistVersion(v => v + 1);
      if (reset) setEpoch(n => n + 1);
      setLoaded({ key, dataDate: j.dataDate, error: j.errors?.[String(key)], instruments, anchorT: j.anchorT ?? null, cas: j.cas === true });
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
  const ids = idsOf(instruments);
  const single = instruments.length < 2;
  // The session clock follows the contract: MCX for a commodity future / option, NSE otherwise; a stock with derivatives stops
  // trading continuously at 15:15 (Closing Auction Session), so no live bar is built from its 15:15-15:30 ticks.
  const market: Market = marketOf(instruments, loaded?.cas);
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
        // lib/pnfFeedCore.ts liveRead: a wild print never reaches the chart (the next history load has the truth); a pre-open /
        // post-close price is indicative and goes to the header only; in Tick mode the bars come from the tick log (below) and this
        // read's price, which can be a moment ahead of the log, is the header's.
        const quotes: LegQuote[] = legs.map(l => l.quote);
        const r = liveRead(lastCloseRef.current, quotes, market, tickMode);
        if (r.kind === 'none') { setOutQuote(null); return; }
        if (r.kind === 'wild') return;
        const tick = r.tick;
        if (r.kind === 'out') { setOutQuote({ ce: tick.ce, pe: tick.pe, t: tick.t }); return; }
        setOutQuote(null);
        if (r.kind === 'head') { setHeadTick({ ce: tick.ce, pe: tick.pe }); return; }
        tickRef.current = tick;
        setBars(prev => foldLive(prev, tick, single));
      } catch { /* the header keeps the last price and shows Stale until the next read lands */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, LIVE_MS);
    return () => { dead = true; clearInterval(id); };
  }, [ids, market, single, tickMode]);

  // ── Renko Tick / N sec: the bridge's tick log → closed bars (one per recorded price, or N-second buckets) ──
  // null until the first read of the log has landed: until then the chart has NO bars (not minute closes), so a restored AUTO or an
  // alert can never act on a minute-close brick the tick chart does not have.
  const [tickBars, setTickBars] = useState<Bar[] | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);
  // The history's last bar, read by the tick poll: its close is the bad-print reference and its legs the seed of a leg with no row yet.
  const histLastRef = useRef<Bar | undefined>(undefined);
  useEffect(() => { histLastRef.current = bars[bars.length - 1]; });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTickBars(null); setHeadTick(null); setTickError(null);
    if (!tickMode || !ids) return;
    let dead = false;
    let since = 0;
    let day = '';
    let build = newTickBuild(instruments.length);
    let sec: SecBuild | null = null;   // N-second buckets over build.bars (a closed bucket keeps its object: the chart carries on)
    let shown: Bar[] | null = null;
    let busy = false;
    let fails = 0;
    const poll = async () => {
      if (busy) return;            // a slow read is never overtaken by the next one (the cursor must move in order)
      busy = true;
      try {
        const res = await fetch(`/api/straddle-pnf/ticks?ids=${ids}&since=${since}`);
        const j = await res.json() as { success?: boolean; error?: string; day?: string; upTo?: number; legs?: TickRow[][] };
        if (dead) return;
        if (!j.success || !j.legs || typeof j.upTo !== 'number') throw new Error(j.error ?? `tick log read failed (HTTP ${res.status})`);
        if (j.day !== day) { day = j.day ?? ''; build = newTickBuild(instruments.length); sec = null; }   // a new session's log
        const h = histLastRef.current;
        build = foldTickRows(build, j.legs, market, h?.straddle, h ? [h.ce, h.pe] : undefined);
        since = j.upTo;
        // A bucket closes once the route has served every row up to its end (upTo, the server's cut-off), new rows or not.
        if (tickSec) sec = bucketTickBars(sec, build.bars, tickSec, j.upTo / 1000);
        const next = tickSec ? sec!.bars : build.bars;
        if (next !== shown) { shown = next; setTickBars(next); }
        if (fails) { fails = 0; setTickError(null); }
      } catch (e) {
        // the next read carries on from the same cursor; a log that keeps failing is said on the chart (it stops drawing new bricks)
        if (!dead && ++fails === 5) setTickError(`Live tick log unavailable (${e instanceof Error ? e.message : 'read failed'}) - no new bricks until it recovers`);
      } finally { busy = false; }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, TICKS_MS);
    return () => { dead = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, market, tickMode, tickSec]);

  // The chart's bars: in Tick / N-second mode the history up to the tick log, then the recorded prices; none before the first read.
  const nowMinute = Math.floor(now / 60_000);
  const chartBars = useMemo(
    () => (!tickMode ? bars : tickBars === null ? NO_BARS : spliceTicks(bars, tickBars, nowMinute > 0 ? nowMinute * 60 : Infinity)),
    [tickMode, bars, tickBars, nowMinute],
  );

  const last = chartBars[chartBars.length - 1];
  useEffect(() => { lastCloseRef.current = last?.straddle; });

  const stale = now === 0 || !last || now / 1000 - last.t > FEED_FRESH_S;
  const live = outQuote ? { ce: outQuote.ce, pe: outQuote.pe } : tickMode && headTick ? headTick : last ? { ce: last.ce, pe: last.pe } : null;
  const sessionTag = outQuote ? (istMinuteOfDay(outQuote.t) < sessionWindow(market, outQuote.t)[0] ? 'Pre-open' : 'Post-close') : null;
  // The feed's previous close is the official one (a stock's closing price is not its last 1-min close), but only until the bell.
  const tradingDay = market !== 'MCX' ? isNseTradingDay(istDateIso(now)) : true;
  // Before today's first price the header shows the last session's close, measured (from history) against the session before it.
  const priceToday = (outQuote ? sessionOf(outQuote.t) : last ? sessionOf(last.t) : null) === istDateIso(now);
  const trustedPrevClose = now > 0 && priceToday && feedCloseTrusted(now / 1000, market, tradingDay) ? feedPrevClose : null;
  // The chart's name for the alert log and the header's scrip: the symbol (with its full name for an index / stock), or the contract.
  const label = target ? targetLabel(target) : '';
  const fno = target?.kind === 'futures' || target?.kind === 'options';
  const scrip = !target ? '' : fno ? label : name && name !== target.symbol ? `${target.symbol} · ${name}` : target.symbol;

  return {
    bars: chartBars, loaded, name, loading, loadError: loadError ?? (tickMode ? tickError : null), histVersion, epoch, market, complete, live, stale, sessionTag, trustedPrevClose, label, scrip,
  };
}

export type PnfFeed = ReturnType<typeof usePnfFeed>;
