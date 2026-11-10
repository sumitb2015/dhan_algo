'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeIndianRupee, AlertTriangle } from 'lucide-react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import NavBar from './NavBar';
import type { FreshMoneyResponse, FreshMoneyRow } from '@/app/api/fresh-money/route';
import { fmtOi, fmtPct, intensity, type Intensity, type Range } from '@/lib/freshMoney';
import type { FmPosition, OptType, TxnSide } from '@/lib/freshMoneyTrades';
import { TradeBar, TradeCell, useFreshMoneyTrades } from './freshMoney/trading';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
type Underlying = (typeof UNDERLYINGS)[number];
const POLL_MS = 30_000;
const PREF_UNDERLYING = 'freshMoney.underlying';
const PREF_CHART_H = 'freshMoney.chartHeight.v2';
const PREF_LOTS = 'freshMoney.lots';
const CHART_DEFAULT_H = 340;
const CHART_MIN_H = 160;
const CHART_MAX_H = 760;
const DAY_START = 9 * 60 + 15;
const DAY_END = 15 * 60 + 30;

const PUT_COLOR = 'var(--color-emerald-400)';
const CALL_COLOR = 'var(--color-red-400)';

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
const GRID_TRADE = 'grid grid-cols-[minmax(0,1fr)_44px_76px_120px_80px_120px_76px_44px_minmax(0,1fr)] items-center';

interface RowTrade {
  put: FmPosition | undefined;
  call: FmPosition | undefined;
  showButtons: boolean;
  canOrder: boolean;
  canClose: boolean;
  armed: boolean;
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

function hhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function rangeText(r: Range | null): string {
  return r ? `${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}%` : '–';
}

/** "YYYY-MM-DD HH:MM:SS" IST → epoch ms. */
function istEpoch(ts: string): number {
  return new Date(`${ts.replace(' ', 'T')}+05:30`).getTime();
}

function Bar({ side, value, max, fresh, normal }: {
  side: 'put' | 'call'; value: number | null; max: number; fresh: number | null; normal: Range | null;
}) {
  if (value === null || value === 0 || max <= 0) return <div />;
  const w = Math.max(1.5, (Math.abs(value) / max) * 100);
  const cls = BAR_CLASS[side][value > 0 ? 'fill' : 'outline'][intensity(fresh, normal)];
  return (
    <div className={`flex h-full items-center ${side === 'put' ? 'justify-end' : 'justify-start'}`}>
      <div className={`h-[15px] ${cls}`} style={{ width: `${w}%` }} />
    </div>
  );
}

function BoardRowView({ row, max, normal, boxed, trade }: {
  row: FreshMoneyRow; max: number; normal: FreshMoneyResponse['normal']; boxed: boolean; trade: RowTrade | null;
}) {
  const p = row.put, c = row.call;
  const cell = (side: 'put' | 'call') => {
    if (!trade) return null;
    const opt: OptType = side === 'put' ? 'PE' : 'CE';
    const has = side === 'put' ? !!p : !!c;
    return (
      <TradeCell
        side={side} opt={opt} strike={row.strike} pos={side === 'put' ? trade.put : trade.call}
        showButtons={trade.showButtons && has} canOrder={trade.canOrder} canClose={trade.canClose} armed={trade.armed} busy={trade.busy(opt)}
        onBuy={() => trade.order(opt, 'BUY')} onSell={() => trade.order(opt, 'SELL')}
        onClose={() => { const pos = side === 'put' ? trade.put : trade.call; if (pos) trade.close(pos); }}
      />
    );
  };
  return (
    <div className={`${trade ? GRID_TRADE : GRID} h-[21px] text-[13px] tabular-nums`}>
      <Bar side="put" value={p?.oiMoved ?? null} max={max} fresh={p?.fresh ?? null} normal={normal.puts} />
      <span className="pr-1.5 text-right text-zinc-300">{fmtPct(p?.fresh ?? null)}</span>
      <span className="pr-2 text-right font-bold text-emerald-400">{p ? fmtOi(p.oiMoved) : '–'}</span>
      {cell('put')}
      <span className="flex justify-center">
        <span className={`px-2 leading-[18px] ${boxed ? 'border border-sky-400 text-zinc-100' : 'border border-transparent text-zinc-300'}`}>
          {row.strike}
        </span>
      </span>
      {cell('call')}
      <span className="pl-2 font-bold text-red-400">{c ? fmtOi(c.oiMoved) : '–'}</span>
      <span className="pl-1.5 text-zinc-300">{fmtPct(c?.fresh ?? null)}</span>
      <Bar side="call" value={c?.oiMoved ?? null} max={max} fresh={c?.fresh ?? null} normal={normal.calls} />
    </div>
  );
}

function SpotDivider({ spot }: { spot: number }) {
  return (
    <div className="relative flex h-[21px] items-center" aria-label={`Spot ${spot.toFixed(2)}`}>
      <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-amber-400/70" />
      <span className="relative mx-auto bg-zinc-900 px-1.5 text-[13px] font-bold tabular-nums text-amber-300">
        {spot.toFixed(2)}
      </span>
    </div>
  );
}

interface ChartPoint {
  m: number;
  puts: number | null;
  calls: number | null;
  putBand: [number, number] | null;
  callBand: [number, number] | null;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  const band = (b: [number, number] | null) => (b ? `${b[0].toFixed(0)}-${b[1].toFixed(0)}%` : '–');
  const v = (x: number | null) => (x === null ? '–' : `${x.toFixed(1)}%`);
  return (
    <div className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] tabular-nums shadow-lg">
      <div className="mb-1 font-bold text-zinc-200">{hhmm(d.m)}</div>
      <div className="text-emerald-400">puts {v(d.puts)} <span className="text-zinc-500">normal {band(d.putBand)}</span></div>
      <div className="text-red-400">calls {v(d.calls)} <span className="text-zinc-500">normal {band(d.callBand)}</span></div>
    </div>
  );
}

function FreshChart({ data, height, showBand }: { data: FreshMoneyResponse; height: number; showBand: boolean }) {
  const points = useMemo<ChartPoint[]>(() => {
    const s = new Map(data.series.map(p => [p.m, p] as const));
    const b = new Map(data.band.map(p => [p.m, p] as const));
    const out: ChartPoint[] = [];
    for (let m = DAY_START; m <= DAY_END; m++) {
      const sp = s.get(m), bp = showBand ? b.get(m) : undefined;
      out.push({
        m,
        puts: sp?.puts != null ? sp.puts * 100 : null,
        calls: sp?.calls != null ? sp.calls * 100 : null,
        putBand: bp ? [bp.putLo * 100, bp.putHi * 100] : null,
        callBand: bp ? [bp.callLo * 100, bp.callHi * 100] : null,
      });
    }
    return out;
  }, [data.series, data.band, showBand]);

  const yMax = useMemo(() => {
    let mx = 0;
    for (const p of points) {
      mx = Math.max(mx, p.puts ?? 0, p.calls ?? 0, p.putBand?.[1] ?? 0, p.callBand?.[1] ?? 0);
    }
    return Math.max(40, Math.ceil(mx / 20) * 20);
  }, [points]);
  const yTicks = useMemo(() => Array.from({ length: yMax / 20 + 1 }, (_, i) => i * 20), [yMax]);
  const xTicks = [555, 615, 675, 735, 795, 855, 915];

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} strokeDasharray="0" strokeOpacity={0.35} />
          <XAxis dataKey="m" type="number" domain={[DAY_START, DAY_END]} ticks={xTicks} tickFormatter={hhmm}
            tick={{ fontSize: 11 }} tickLine={false} />
          <YAxis domain={[0, yMax]} ticks={yTicks} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11 }}
            tickLine={false} axisLine={false} width={50} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--chart-cursor-line)', strokeWidth: 1 }} />
          {showBand && (
            <>
              <Area dataKey="putBand" stroke="none" fill={PUT_COLOR} fillOpacity={0.14} isAnimationActive={false}
                connectNulls={false} activeDot={false} />
              <Area dataKey="callBand" stroke="none" fill={CALL_COLOR} fillOpacity={0.14} isAnimationActive={false}
                connectNulls={false} activeDot={false} />
            </>
          )}
          <Line dataKey="calls" stroke={CALL_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="puts" stroke={PUT_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
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
  const [lots, setLots] = useState(1);
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
    for (const r of data?.rows ?? []) mx = Math.max(mx, Math.abs(r.put?.oiMoved ?? 0), Math.abs(r.call?.oiMoved ?? 0));
    return mx;
  }, [data]);

  const boxedStrike = useMemo(() => {
    if (!data?.spot || !data.rows.length) return null;
    let best = data.rows[0].strike;
    for (const r of data.rows) if (Math.abs(r.strike - data.spot) < Math.abs(best - data.spot)) best = r.strike;
    return best;
  }, [data]);

  const historyLabel = data ? `${Math.min(data.historyDays, 14)}d` : '14d';
  const hasNormal = !!(data?.normal.puts && data?.normal.calls);
  const staleMin = data?.isToday ? Math.floor((now - istEpoch(data.lastTs)) / 60_000) : 0;
  const nowIstMin = (() => {
    const d = new Date(now + 5.5 * 3600_000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  })();
  const isStale = !!data?.isToday && staleMin >= 3 && nowIstMin >= DAY_START && nowIstMin <= DAY_END;

  // ── trading ──
  const ts = trades.state;
  const tradable = !!ts?.tradable.includes(underlying);
  const tradeExpiry = ts?.boardExpiry[underlying] ?? null;
  // Orders only from a live board: today's snapshot, and the expiry the server will trade.
  const session = ts?.session ?? 'closed';
  const blocked = !data ? null
    : session !== 'open' ? (ts?.sessionNote ?? null)
    : !data.isToday ? "Trading opens when today's board is live (the IV snapshot collector has not written today)"
      : isStale ? 'Board snapshot is stale — orders paused until the collector writes again'
        : tradeExpiry !== data.expiry ? "The board's expiry is changing — wait for the next refresh"
          : null;
  const myPositions = useMemo(
    () => (ts?.positions ?? []).filter(p => p.underlying === underlying && (!data || p.expiry === data.expiry)),
    [ts, underlying, data],
  );
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
      armed,
      busy: opt => inflight.has(`${underlying}:${strike}:${opt}`),
      order: (opt, side) => sendOrder({ underlying, expiry: data.expiry, strike, opt, side, lots }),
      close: p => sendClose(p),
    };
  }, [tradeMode, data, posByKey, armed, tradable, blocked, session, inflight, underlying, sendOrder, sendClose, lots]);
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
              Share of each strike&apos;s volume that opened or closed positions, against a {historyLabel} normal
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
            The IV snapshot collector has not written for {staleMin} min. The board shows its last snapshot.
          </div>
        )}
        {data && !data.isToday && (
          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            No snapshot for today yet; showing {data.date}. The IV snapshot collector starts with the dashboard in market hours.
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
                maxLots={ts.maxLots} lotSize={data.lot} tradable={tradable} blocked={blocked} positions={myPositions}
              />
            )}
            <div className="px-4 pt-3">
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
              <div className="mt-0.5 text-[11.5px] text-zinc-400">
                Bar = OI moved · % = fresh share of the strike&apos;s volume · light / mid / bright = below / about / above
                normal · filled building, outline leaving
              </div>
            </div>

            <div className="overflow-x-auto px-4 pb-2 pt-2">
             <div className={tradeMode ? 'min-w-[980px]' : 'min-w-[720px]'}>
              <div className={`${tradeMode ? GRID_TRADE : GRID} h-5 whitespace-nowrap text-[11.5px] text-zinc-400`}>
                <span className="col-span-3 pr-2 text-right">PUTS: fresh · OI moved</span>
                {tradeMode && <span className="pr-1 text-right text-zinc-500">PE trade</span>}
                <span className="text-center">STRIKE</span>
                {tradeMode && <span className="pl-1 text-zinc-500">CE trade</span>}
                <span className="col-span-3 pl-2">CALLS: OI moved · fresh</span>
              </div>
              {data.rows.map((r, i) => {
                const next = data.rows[i + 1];
                const divider = data.spot !== null && next && r.strike > data.spot && next.strike <= data.spot;
                return (
                  <React.Fragment key={r.strike}>
                    <BoardRowView row={r} max={maxAbs} normal={data.normal} boxed={r.strike === boxedStrike} trade={rowTrade(r.strike)} />
                    {divider && <SpotDivider spot={data.spot!} />}
                  </React.Fragment>
                );
              })}
             </div>
            </div>

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

            <div className="px-4 pb-3">
              <div className="mb-1 text-[11.5px] text-zinc-400">Fresh money through the day · rolling 5 min</div>
              <FreshChart data={data} height={chartH} showBand={data.band.length > 0} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
