'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeIndianRupee, AlertTriangle } from 'lucide-react';
import NavBar from './NavBar';
import type { FreshMoneyResponse, FreshMoneyRow } from '@/app/api/fresh-money/route';
import type { FreshMoneyLive } from '@/app/api/fresh-money/live/route';
import { BUILDUP_TEXT, fmtOi, fmtOiAbs, fmtPct, intensity, type Buildup, type Intensity, type Range } from '@/lib/freshMoney';
import type { FmBroker, FmPosition, OptType, TxnSide } from '@/lib/freshMoneyTrades';
import { FM_BROKERS, OffBoardPositions, TradeBar, TradeCell, brokerLabel, lockKey, useFreshMoneyTrades } from './freshMoney/trading';
import { usePageBroker } from './BrokerPicker';
import CollectorControl from './freshMoney/CollectorControl';
import FreshChart from './freshMoney/FreshChart';
import PositionsOrders from './freshMoney/PositionsOrders';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
const MCX_UNDERLYINGS: ReadonlySet<string> = new Set(['CRUDEOIL', 'CRUDEOILM']);
type Underlying = (typeof UNDERLYINGS)[number];
const POLL_MS = 30_000;
const PREF_UNDERLYING = 'freshMoney.underlying';
const PREF_CHART_H = 'freshMoney.chartHeight.v2';
const PREF_LOTS = 'freshMoney.lots';
const PREF_CHART_COLLAPSED = 'freshMoney.chartCollapsed';
const PREF_OI_MODE = 'freshMoney.oiMode';
type OiMode = 'change' | 'total';
const PREF_POS_COLLAPSED = 'freshMoney.positionsCollapsed';
const LIVE_POLL_MS = 2_000;
const CHART_DEFAULT_H = 340;
const CHART_MIN_H = 160;
const CHART_MAX_H = 760;
/** Fallback chart span (NSE) until the board reply says which session it covers. */
const NSE_DAY = { from: 9 * 60 + 15, to: 15 * 60 + 30 };

// Literal class strings (Tailwind cannot see interpolated ones).
const BAR_CLASS: Record<'put' | 'call', Record<'fill' | 'outline', Record<Intensity, string>>> = {
  put: {
    fill: { low: 'bg-emerald-500/30', mid: 'bg-emerald-500/55', high: 'bg-emerald-500/90' },
    outline: { low: 'border border-emerald-500/35', mid: 'border border-emerald-500/60', high: 'border border-emerald-500/90' },
  },
  call: {
    fill: { low: 'bg-red-500/30', mid: 'bg-red-500/60', high: 'bg-red-500/90' },
    outline: { low: 'border border-red-500/35', mid: 'border border-red-500/60', high: 'border border-red-500/90' },
  },
};

const GRID = 'grid grid-cols-[minmax(0,1fr)_44px_76px_96px_76px_44px_minmax(0,1fr)] items-center';
// With trading on, a cell each side of the strike holds B / S, the P&L chip and × (literal string for Tailwind).
const GRID_TRADE = 'grid grid-cols-[minmax(0,1fr)_44px_76px_150px_80px_150px_76px_44px_minmax(0,1fr)] items-center';

interface RowTrade {
  put: FmPosition | undefined;
  call: FmPosition | undefined;
  showButtons: boolean;
  canOrder: boolean;
  canClose: boolean;
  armed: boolean;
  ltpSource: Record<string, 'ws' | 'rest'>;
  busy: (opt: OptType) => boolean;
  order: (opt: OptType, side: TxnSide) => void;
  close: (p: FmPosition) => void;
}

function readPref(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, v: string) {
  try { window.localStorage.setItem(key, v); } catch { /* storage blocked */ }
}


function rangeText(r: Range | null): string {
  return r ? `${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}%` : '–';
}

/** "YYYY-MM-DD HH:MM:SS" IST → epoch ms. */
function istEpoch(ts: string): number {
  return new Date(`${ts.replace(' ', 'T')}+05:30`).getTime();
}

/** LB / SB / SC / LU pill at a bar's outer end; full name and meaning on hover. */
function BuildupTag({ tag }: { tag: Buildup }) {
  const t = BUILDUP_TEXT[tag];
  return (
    <span title={`${t.name} — ${t.meaning}`} aria-label={t.name}
      className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] font-bold leading-[14px] tracking-wide text-zinc-300">
      {tag}
    </span>
  );
}

/** `length` sets the bar (OI moved, or total OI); `moved` (today's change) always decides filled = building vs
 *  outline = leaving, and `fresh` vs `normal` the shade — so both modes read the same way. */
function Bar({ side, length, moved, max, fresh, normal, tag }: {
  side: 'put' | 'call'; length: number | null; moved: number | null; max: number; fresh: number | null; normal: Range | null;
  tag: Buildup | null;
}) {
  if (length === null || length === 0 || max <= 0) return <div />;
  // The tag takes room at the outer end, so the bar scales within what is left.
  const w = Math.max(1.5, (Math.abs(length) / max) * (tag ? 88 : 100));
  const cls = BAR_CLASS[side][(moved ?? 0) >= 0 ? 'fill' : 'outline'][intensity(fresh, normal)];
  return (
    <div className={`flex h-full min-w-0 items-center gap-1 ${side === 'put' ? 'justify-end' : 'justify-start'}`}>
      {side === 'put' && tag && <BuildupTag tag={tag} />}
      <div className={`h-[15px] ${cls}`} style={{ width: `${w}%` }} />
      {side === 'call' && tag && <BuildupTag tag={tag} />}
    </div>
  );
}

function BoardRowView({ row, max, normal, boxed, trade, mode }: {
  row: FreshMoneyRow; max: number; normal: FreshMoneyResponse['normal']; boxed: boolean; trade: RowTrade | null; mode: OiMode;
}) {
  const shown = (sd: FreshMoneyRow['put']) => (sd ? (mode === 'total' ? sd.oi : sd.oiMoved) : null);
  const label = (sd: FreshMoneyRow['put']) => (sd ? (mode === 'total' ? fmtOiAbs(sd.oi) : fmtOi(sd.oiMoved)) : '–');
  const p = row.put, c = row.call;
  const cell = (side: 'put' | 'call') => {
    if (!trade) return null;
    const opt: OptType = side === 'put' ? 'PE' : 'CE';
    const has = side === 'put' ? !!p : !!c;
    return (
      <TradeCell
        side={side} opt={opt} strike={row.strike} pos={side === 'put' ? trade.put : trade.call}
        showButtons={trade.showButtons && has} canOrder={trade.canOrder} canClose={trade.canClose} armed={trade.armed}
        ltpSource={(() => { const p = side === 'put' ? trade.put : trade.call; return p ? trade.ltpSource[p.priceId] : undefined; })()} busy={trade.busy(opt)}
        onBuy={() => trade.order(opt, 'BUY')} onSell={() => trade.order(opt, 'SELL')}
        onClose={() => { const pos = side === 'put' ? trade.put : trade.call; if (pos) trade.close(pos); }}
      />
    );
  };
  return (
    <div className={`${trade ? `${GRID_TRADE} h-[26px]` : `${GRID} h-[21px]`} text-[13px] tabular-nums`}>
      <Bar side="put" length={shown(p)} moved={p?.oiMoved ?? null} max={max} fresh={p?.fresh ?? null} normal={normal.puts} tag={p?.buildup ?? null} />
      <span className="pr-1.5 text-right text-zinc-300">{fmtPct(p?.fresh ?? null)}</span>
      <span className="pr-2 text-right font-bold text-emerald-400">{label(p)}</span>
      {cell('put')}
      <span className="flex justify-center">
        <span className={`px-2 leading-[18px] ${boxed ? 'border border-sky-400 text-zinc-100' : 'border border-transparent text-zinc-300'}`}>
          {row.strike}
        </span>
      </span>
      {cell('call')}
      <span className="pl-2 font-bold text-red-400">{label(c)}</span>
      <span className="pl-1.5 text-zinc-300">{fmtPct(c?.fresh ?? null)}</span>
      <Bar side="call" length={shown(c)} moved={c?.oiMoved ?? null} max={max} fresh={c?.fresh ?? null} normal={normal.calls} tag={c?.buildup ?? null} />
    </div>
  );
}

const inr = (v: number, d = 2) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** The chosen underlying's latest price and change vs the previous close (WebSocket; "–" when the previous close is
 *  not known — never a flipped close shown as 0.00%). Without a live price, the board snapshot's spot, marked as such. */
function PriceChip({ underlying, q, fallback }: { underlying: string; q: FreshMoneyLive | null; fallback: number | null }) {
  const price = q?.spot ?? fallback;
  if (price === null) return null;
  const live = !!q?.spot;
  const up = (q?.change ?? 0) > 0, down = (q?.change ?? 0) < 0;
  const tone = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-zinc-300';
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1"
      title={live ? `Live from the Dhan WebSocket${q?.prevClose ? ` · previous close ${inr(q.prevClose)}` : ''}` : 'Last board snapshot (no live price yet)'}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{q?.label ?? underlying}</span>
      {live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />}
      <span className="text-[14px] font-bold tabular-nums text-white">{inr(price)}</span>
      {live && q?.change != null && q.changePct != null ? (
        <span className={`text-[12px] font-bold tabular-nums ${tone}`}>
          {up ? '+' : down ? '−' : ''}{inr(Math.abs(q.change))} ({up ? '+' : down ? '−' : ''}{Math.abs(q.changePct).toFixed(2)}%)
        </span>
      ) : (
        <span className="text-[11px] text-zinc-500">{live ? 'chg –' : 'snapshot'}</span>
      )}
    </div>
  );
}

function SpotDivider({ spot, live }: { spot: number; live: boolean }) {
  return (
    <div className="relative flex h-[21px] items-center" aria-label={`Spot ${spot.toFixed(2)}${live ? ' (live)' : ' (last snapshot)'}`}>
      <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-amber-400/70" />
      <span
        className="relative mx-auto flex items-center gap-1 bg-zinc-900 px-1.5 text-[13px] font-bold tabular-nums text-amber-300"
        title={live ? 'Live price from the Dhan WebSocket' : 'Price from the last board snapshot (no live WebSocket price yet)'}
      >
        {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />}
        {spot.toFixed(2)}
      </span>
    </div>
  );
}

export default function FreshMoneyBoard() {
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [data, setData] = useState<FreshMoneyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartH, setChartH] = useState(CHART_DEFAULT_H);
  // REAL-money arm: per page load, never persisted, dropped on an underlying switch.
  const [armed, setArmed] = useState(false);
  // Account for NEW orders (remembered per browser). An open position keeps the broker it was opened on.
  const [broker, setBrokerRaw, brokerReady] = usePageBroker<FmBroker>('freshMoney.broker', FM_BROKERS);
  // Switching account disarms: an armed page must never quietly start sending to a different account.
  const setBroker = useCallback((b: FmBroker) => { setArmed(false); setBrokerRaw(b); }, [setBrokerRaw]);
  const [lots, setLots] = useState(1);
  // Collapsed panels (remembered per browser).
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const [posCollapsed, setPosCollapsed] = useState(false);
  // What the board's numbers and bar lengths show: today's OI change (default) or total OI outstanding.
  const [oiMode, setOiMode] = useState<OiMode>('change');
  const pickOiMode = (m: OiMode) => { setOiMode(m); writePref(PREF_OI_MODE, m); };
  const toggleChart = () => setChartCollapsed(c => { writePref(PREF_CHART_COLLAPSED, c ? '0' : '1'); return !c; });
  const togglePos = () => setPosCollapsed(c => { writePref(PREF_POS_COLLAPSED, c ? '0' : '1'); return !c; });
  const trades = useFreshMoneyTrades();
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  // Restore preferences after mount (SSR renders the defaults).
  useEffect(() => {
    const u = readPref(PREF_UNDERLYING);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    if (u && (UNDERLYINGS as readonly string[]).includes(u)) setUnderlying(u as Underlying);
    const h = Number(readPref(PREF_CHART_H));
    if (Number.isFinite(h) && h >= CHART_MIN_H && h <= CHART_MAX_H) setChartH(h);
    const l = Number(readPref(PREF_LOTS));
    if (Number.isInteger(l) && l >= 1 && l <= 20) setLots(l);
    setChartCollapsed(readPref(PREF_CHART_COLLAPSED) === '1');
    setPosCollapsed(readPref(PREF_POS_COLLAPSED) === '1');
    if (readPref(PREF_OI_MODE) === 'total') setOiMode('total');
  }, []);

  const load = useCallback(async (u: Underlying, signal?: AbortSignal) => {
    const my = ++seq.current;
    try {
      const res = await fetch(`/api/fresh-money?underlying=${u}`, { cache: 'no-store', signal });
      const body = await res.json();
      if (my !== seq.current) return; // a newer request (or underlying switch) superseded this one
      if (!res.ok || body.error) { setError(body.error ?? `HTTP ${res.status}`); setData(null); }
      else { setData(body as FreshMoneyResponse); setError(null); }
    } catch (e) {
      if (my !== seq.current || (e as Error).name === 'AbortError') return;
      setError(String((e as Error).message ?? e));
    } finally {
      if (my === seq.current) { setLoading(false); setNow(Date.now()); }
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its fetch resolves
    load(underlying, ac.signal);
    const id = setInterval(() => { if (!document.hidden) load(underlying, ac.signal); }, POLL_MS);
    return () => { ac.abort(); clearInterval(id); };
  }, [underlying, load]);

  const pickUnderlying = (u: Underlying) => {
    if (u === underlying) return;
    setLoading(true);
    setData(null);
    setError(null);
    setArmed(false);
    setUnderlying(u);
    writePref(PREF_UNDERLYING, u);
  };

  // Drag the grip to resize the chart; persist on release.
  const drag = useRef<{ y: number; h: number } | null>(null);
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: chartH };
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const h = Math.min(CHART_MAX_H, Math.max(CHART_MIN_H, drag.current.h - (e.clientY - drag.current.y)));
    setChartH(h);
  };
  const onGripUp = () => {
    if (drag.current) writePref(PREF_CHART_H, String(chartH));
    drag.current = null;
  };
  const onGripKey = (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowUp' ? 20 : e.key === 'ArrowDown' ? -20 : 0;
    if (!d) return;
    e.preventDefault();
    const h = Math.min(CHART_MAX_H, Math.max(CHART_MIN_H, chartH + d));
    setChartH(h);
    writePref(PREF_CHART_H, String(h));
  };

  const maxAbs = useMemo(() => {
    let mx = 0;
    const v = (sd: FreshMoneyRow['put']) => Math.abs((oiMode === 'total' ? sd?.oi : sd?.oiMoved) ?? 0);
    for (const r of data?.rows ?? []) mx = Math.max(mx, v(r.put), v(r.call));
    return mx;
  }, [data, oiMode]);

  // Live spot from the WebSocket (today's board only: a live price over an old session's OI would mislead). Falls back
  // to the board snapshot's spot when there is no fresh WebSocket price.
  // Polled whenever a board is shown (the header price); the board itself uses it only on today's board.
  const [live, setLive] = useState<{ key: string; q: FreshMoneyLive } | null>(null);
  const liveKey = data ? `${underlying}|${data.expiry}` : null;
  useEffect(() => {
    if (!liveKey) return;
    const [u, expiry] = liveKey.split('|');
    let alive = true;
    let my = 0;
    const tick = async () => {
      if (document.hidden) return;
      const n = ++my;
      try {
        const r = await fetch(`/api/fresh-money/live?underlying=${u}&expiry=${expiry}`, { cache: 'no-store' });
        const j = (await r.json()) as FreshMoneyLive;
        if (!alive || n !== my) return;
        setLive({ key: liveKey, q: j });
      } catch { /* keep the last value; the next tick retries */ }
    };
    tick();
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [liveKey]);
  const liveQ = live && live.key === liveKey ? live.q : null;
  const liveSpot = data?.isToday && liveQ?.spot && liveQ.spot > 0 ? liveQ.spot : null;
  const spot = liveSpot ?? data?.spot ?? null;

  const boxedStrike = useMemo(() => {
    if (!spot || !data?.rows.length) return null;
    let best = data.rows[0].strike;
    for (const r of data.rows) if (Math.abs(r.strike - spot) < Math.abs(best - spot)) best = r.strike;
    return best;
  }, [data, spot]);

  const historyLabel = data ? `${Math.min(data.historyDays, 14)}d` : '14d';
  const hasNormal = !!(data?.normal.puts && data?.normal.calls);
  const staleMin = data?.isToday ? Math.floor((now - istEpoch(data.lastTs)) / 60_000) : 0;
  const nowIstMin = (() => {
    const d = new Date(now + 5.5 * 3600_000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  })();
  const day = data?.day ?? NSE_DAY;
  const isMcx = MCX_UNDERLYINGS.has(underlying);
  const collectorName = isMcx ? `${underlying} OI collector` : 'IV snapshot collector';
  const isStale = !!data?.isToday && staleMin >= 3 && nowIstMin >= day.from && nowIstMin <= day.to;

  // ── trading ──
  const ts = trades.state;
  const tradable = !!ts?.tradable.includes(underlying);
  const tradeExpiry = ts?.boardExpiry[underlying] ?? null;
  // Orders only from a live board: today's snapshot, and the expiry the server will trade.
  const session = ts?.sessions[underlying]?.gate ?? 'closed';
  const blocked = !data ? null
    : ts && !ts.brokers[broker] ? `${brokerLabel(broker)} is not logged in — log in from Autologin, then refresh`
    : session !== 'open' ? (ts?.sessions[underlying]?.note ?? null)
    : !data.isToday ? `Trading opens when today's board is live (the ${collectorName} has not written today)`
      : isStale ? 'Board snapshot is stale — orders paused until the collector writes again'
        : tradeExpiry !== data.expiry ? "The board's expiry is changing — wait for the next refresh"
          : null;
  // This underlying's positions on every expiry: they all count in the bar's P&L.
  // The bar and the board show the selected broker; positions on other brokers are listed under the bar.
  const underlyingPositions = useMemo(
    () => (ts?.positions ?? []).filter(p => p.underlying === underlying && p.broker === broker), [ts, underlying, broker]);
  // On the board: the board's expiry AND a strike the board has a row for. Everything else that is still open is listed
  // under the bar (with its own ×) — a position must never become invisible because spot moved or the expiry rolled.
  const boardStrikes = useMemo(() => new Set((data?.rows ?? []).map(r => r.strike)), [data]);
  const myPositions = useMemo(
    () => underlyingPositions.filter(p => !!data && p.expiry === data.expiry && boardStrikes.has(p.strike)),
    [underlyingPositions, data, boardStrikes],
  );
  const offBoard = useMemo(() => {
    const on = new Set(myPositions.map(p => p.key));
    return (ts?.positions ?? []).filter(p => p.netQty !== 0 && !on.has(p.key));
  }, [ts, myPositions]);
  const posByKey = useMemo(() => new Map(myPositions.map(p => [`${p.strike}:${p.opt}`, p] as const)), [myPositions]);
  const tradeMode = armed || myPositions.length > 0;
  const { order: sendOrder, close: sendClose, inflight } = trades;
  const rowTrade = useCallback((strike: number): RowTrade | null => {
    if (!tradeMode || !data) return null;
    return {
      put: posByKey.get(`${strike}:PE`),
      call: posByKey.get(`${strike}:CE`),
      showButtons: armed && tradable,
      canOrder: armed && tradable && !blocked,
      canClose: armed && session !== 'closed',
      ltpSource: ts?.ltpSource ?? {},
      armed,
      busy: opt => inflight.has(lockKey(broker, underlying, strike, opt)),
      order: (opt, side) => sendOrder({ broker, underlying, expiry: data.expiry, strike, opt, side, lots }),
      close: p => sendClose(p),
    };
  }, [tradeMode, data, posByKey, armed, tradable, blocked, session, inflight, underlying, broker, sendOrder, sendClose, lots, ts]);
  const setLotsPref = (n: number) => { setLots(n); writePref(PREF_LOTS, String(n)); };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10">
            <BadgeIndianRupee className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400">Options · {underlying}</p>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">Fresh Money Board</h1>
            <p className="mt-1 text-[10px] font-medium text-zinc-500">
              Share of each strike&apos;s volume that opened or closed positions{data && data.historyDays >= 5 ? `, against a ${historyLabel} normal` : ' · normal range after 5 days of data'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Underlying" className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
            {UNDERLYINGS.map(u => (
              <button key={u} role="tab" aria-selected={u === underlying} onClick={() => pickUnderlying(u)}
                className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  u === underlying ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                {u}
              </button>
            ))}
          </div>
          <PriceChip underlying={underlying} q={liveQ} fallback={data?.spot ?? null} />
          {MCX_UNDERLYINGS.has(underlying) && <CollectorControl key={underlying} underlying={underlying} />}
          {data && (
            <span className="text-[10px] font-mono text-zinc-400">
              {data.lastTs.slice(11)} · exp {data.expiry} · OI in {data.oiUnit}
            </span>
          )}
          <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300">
            DATA: {data?.date ?? '—'}{data && !data.isToday ? ' · last session' : ''}
          </span>
          <span className="h-5 w-px shrink-0 bg-zinc-800" />
          <NavBar />
        </div>
      </div>

      <div className={`mx-auto flex w-full ${tradeMode ? 'max-w-[1320px]' : 'max-w-[1100px]'} flex-1 flex-col gap-3 px-6 py-5`}>
        {isStale && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            The {collectorName} has not written for {staleMin} min. The board shows its last snapshot.
          </div>
        )}
        {data && !data.isToday && (
          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            No snapshot for today yet; showing {data.date}.{' '}
            {isMcx ? `Start the ${collectorName} (top right) during MCX hours.` : 'The IV snapshot collector starts with the dashboard in market hours.'}
          </div>
        )}

        {error && !data && !loading && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-3 text-sm text-red-300">{error}</div>
        )}

        {loading && !data && (
          <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="h-5 w-80 animate-pulse rounded bg-zinc-800" />
            <div className="mb-3 h-3 w-[32rem] max-w-full animate-pulse rounded bg-zinc-800" />
            {Array.from({ length: 16 }, (_, i) => <div key={i} className="h-[17px] animate-pulse rounded bg-zinc-800/60" />)}
          </div>
        )}

        {data && (
          <div className={`overflow-hidden rounded-lg border bg-zinc-900 ${armed ? 'border-red-500/50' : 'border-zinc-800'}`}>
            {ts && (
              <TradeBar
                underlying={underlying} armed={armed} onArm={setArmed} lots={lots} onLots={setLotsPref}
                maxLots={ts.maxLots} lotSize={data.lot} mcxMult={data.mult} tradable={tradable} blocked={blocked} positions={underlyingPositions}
                broker={broker} onBroker={setBroker} brokerReady={brokerReady} brokerSessions={ts.brokers ?? null}
              />
            )}
            {ts && offBoard.length > 0 && (
              <OffBoardPositions
                positions={offBoard} armed={armed} inflight={inflight}
                canClose={p => (ts.sessions[p.underlying]?.gate ?? 'closed') !== 'closed' && !!ts.brokers?.[p.broker]} onClose={sendClose}
              />
            )}
            <div className="px-4 pt-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="text-[15px] text-zinc-200">
                Board fresh money:{' '}
                <span className="font-bold text-emerald-400">puts {fmtPct(data.board.puts)}</span>
                <span className="text-zinc-400"> · </span>
                <span className="font-bold text-red-400">calls {fmtPct(data.board.calls)}</span>
                <span className="text-zinc-400">
                  {'  '}({hasNormal
                    ? `normal ${historyLabel}: puts ${rangeText(data.normal.puts)} · calls ${rangeText(data.normal.calls)}`
                    : `normal: needs ≥5 days of snapshots, have ${data.historyDays}`})
                </span>
              </div>
              <div role="tablist" aria-label="Bars and numbers show" className="ml-auto flex rounded-md border border-zinc-800 bg-zinc-950/40 p-0.5">
                {([['change', 'OI change'], ['total', 'Total OI']] as const).map(([m, name]) => (
                  <button key={m} type="button" role="tab" aria-selected={oiMode === m} onClick={() => pickOiMode(m)}
                    title={m === 'change' ? "Today's change in open interest vs the previous close" : 'Open interest outstanding now'}
                    className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                      oiMode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
                    {name}
                  </button>
                ))}
              </div>
              </div>
              <div className="mt-0.5 text-[11.5px] text-zinc-400">
                {oiMode === 'total' ? 'Bar = total OI (shade and fill still from today\'s change)' : 'Bar = OI moved'} · % = fresh share of the strike&apos;s volume · light / mid / bright = below / about / above
                normal · filled building, outline leaving
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {data.hasBuildup
                  ? <>Tags (option&apos;s own premium vs its previous close): <span className="font-bold text-zinc-300">LB</span> long buildup ·{' '}
                      <span className="font-bold text-zinc-300">SB</span> short buildup · <span className="font-bold text-zinc-300">SC</span> short covering ·{' '}
                      <span className="font-bold text-zinc-300">LU</span> long unwinding — hover a tag for its meaning</>
                  : data.isToday
                    ? 'Buildup tags (LB / SB / SC / LU) start once the collector records option previous closes — after its next restart.'
                    : 'No buildup tags for this day: option previous closes were not recorded for it.'}
              </div>
            </div>

            <div className="overflow-x-auto px-4 pb-2 pt-2">
             <div className={tradeMode ? 'min-w-[1040px]' : 'min-w-[720px]'}>
              <div className={`${tradeMode ? GRID_TRADE : GRID} h-5 whitespace-nowrap text-[11.5px] text-zinc-400`}>
                <span className="col-span-3 pr-2 text-right">PUTS: fresh · {oiMode === 'total' ? 'total OI' : 'OI moved'}</span>
                {tradeMode && <span className="pr-1 text-right text-zinc-400">PE trade</span>}
                <span className="text-center">STRIKE</span>
                {tradeMode && <span className="pl-1 text-zinc-400">CE trade</span>}
                <span className="col-span-3 pl-2">CALLS: {oiMode === 'total' ? 'total OI' : 'OI moved'} · fresh</span>
              </div>
              {data.rows.map((r, i) => {
                const next = data.rows[i + 1];
                const divider = spot !== null && next && r.strike > spot && next.strike <= spot;
                return (
                  <React.Fragment key={r.strike}>
                    <BoardRowView row={r} max={maxAbs} normal={data.normal} boxed={r.strike === boxedStrike} trade={rowTrade(r.strike)} mode={oiMode} />
                    {divider && <SpotDivider spot={spot!} live={liveSpot !== null} />}
                  </React.Fragment>
                );
              })}
             </div>
            </div>

            {!chartCollapsed && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize chart"
              aria-valuenow={chartH}
              aria-valuemin={CHART_MIN_H}
              aria-valuemax={CHART_MAX_H}
              tabIndex={0}
              onPointerDown={onGripDown}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
              onPointerCancel={onGripUp}
              onKeyDown={onGripKey}
              className="group flex h-3 cursor-row-resize touch-none items-center justify-center border-t border-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <span className="text-[10px] leading-none tracking-[0.2em] text-zinc-500 group-hover:text-zinc-300">•••</span>
            </div>
            )}

            <div className={`px-4 pb-3 ${chartCollapsed ? 'border-t border-zinc-800 pt-2.5' : ''}`}>
              <FreshChart data={data} height={chartH} collapsed={chartCollapsed} onToggle={toggleChart} />
            </div>
          </div>
        )}

        {ts && (
          <PositionsOrders
            state={ts} armed={armed} inflight={inflight} onClose={sendClose}
            collapsed={posCollapsed} onToggle={togglePos}
            canClose={p => (ts.sessions[p.underlying]?.gate ?? 'closed') !== 'closed' && !!ts.brokers?.[p.broker]}
          />
        )}
      </div>
    </div>
  );
}
