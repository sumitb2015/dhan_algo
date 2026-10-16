'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Landmark, Loader2, RefreshCw } from 'lucide-react';
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import NavBar from '@/components/NavBar';
import {
  PARTICIPANTS, cashSeries, fmtCr, fmtInt, longShortBias, metricChange, participantHistory,
  positionMetrics, statsNet, statsOiChange, streak, sumLast,
  type CashPoint, type CashSource, type FiiDiiFile, type FnoDay, type MetricKey, type Participant,
  type PositionMetrics, type StatsKey,
} from '@/lib/fiiDii';

// Auto re-fetch when the cache is older than this. NSE posts the provisional cash figures around
// 17:00-18:00 IST and the F&O participant files later in the evening.
const STALE_MS = 2 * 60 * 60 * 1000;

const FII_COLOR = '#38bdf8';
const DII_COLOR = '#f59e0b';
const CALL_COLOR = '#f87171';
const PUT_COLOR = '#34d399';

const tooltipStyle = {
  background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)',
  color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11,
  fontVariantNumeric: 'tabular-nums' as const,
};

function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return 'text-zinc-300';
  return v > 0 ? 'text-emerald-400' : 'text-red-400';
}

function StatTile({ label, value, valueClass, sub, subClass, title }: {
  label: string; value: string; valueClass?: string; sub?: string; subClass?: string; title?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 min-w-0" title={title}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 truncate">{label}</p>
      <p className={`text-base font-bold tabular-nums font-mono mt-0.5 truncate ${valueClass ?? 'text-white'}`}>{value}</p>
      {sub && <p className={`text-[11px] tabular-nums font-mono mt-0.5 truncate ${subClass ?? 'text-zinc-400'}`}>{sub}</p>}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="flex rounded-md border border-zinc-800 overflow-hidden" role="tablist" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-xs ${value === o.value ? 'bg-sky-500/15 text-sky-300 font-semibold' : 'text-zinc-400 hover:bg-zinc-800'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SectionTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap mt-2">
      <h2 className="text-sm font-bold text-white">{title}</h2>
      <p className="text-[11px] text-zinc-500">{sub}</p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CashTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as CashPoint;
  return (
    <div style={tooltipStyle}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>{label}</p>
      <p>FII {fmtCr(p.fii.net)}</p>
      <p>DII {fmtCr(p.dii.net)}</p>
      <p style={{ fontWeight: 700 }}>Total {fmtCr(p.total)}</p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FutTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as PositionMetrics;
  return (
    <div style={tooltipStyle}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>{label}</p>
      <p>Long {fmtInt(p.idxFutLong)} · Short {fmtInt(p.idxFutShort)}</p>
      <p style={{ fontWeight: 700 }}>Net {fmtInt(p.idxFutNet, true)}</p>
      <p>Long share {p.idxFutLongPct === null ? '—' : `${p.idxFutLongPct.toFixed(1)}%`}</p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function OptTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as PositionMetrics;
  return (
    <div style={tooltipStyle}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>{label}</p>
      <p>Index calls net {fmtInt(p.idxCallNet, true)}</p>
      <p>Index puts net {fmtInt(p.idxPutNet, true)}</p>
    </div>
  );
}

// ── Cash table ──────────────────────────────────────────────────────────────

const CASH_COLUMNS: { key: string; label: string; cell: (p: CashPoint) => { text: string; cls?: string } }[] = [
  { key: 'date', label: 'Date', cell: p => ({ text: p.date, cls: 'text-zinc-300' }) },
  { key: 'fb', label: 'FII Buy', cell: p => ({ text: fmtCr(p.fii.buy, false) }) },
  { key: 'fs', label: 'FII Sell', cell: p => ({ text: fmtCr(p.fii.sell, false) }) },
  { key: 'fn', label: 'FII Net', cell: p => ({ text: fmtCr(p.fii.net), cls: `${signClass(p.fii.net)} font-semibold` }) },
  { key: 'db', label: 'DII Buy', cell: p => ({ text: fmtCr(p.dii.buy, false) }) },
  { key: 'ds', label: 'DII Sell', cell: p => ({ text: fmtCr(p.dii.sell, false) }) },
  { key: 'dn', label: 'DII Net', cell: p => ({ text: fmtCr(p.dii.net), cls: `${signClass(p.dii.net)} font-semibold` }) },
  { key: 'tn', label: 'FII + DII', cell: p => ({ text: fmtCr(p.total), cls: signClass(p.total) }) },
];

// ── Participant table ───────────────────────────────────────────────────────

interface PartRow { who: Participant; m: PositionMetrics; d: Record<MetricKey, number | null> | null }

const PART_COLUMNS: { key: string; label: string; title?: string; delta?: boolean; cell: (r: PartRow) => { text: string; cls?: string } }[] = [
  { key: 'who', label: 'Participant', cell: r => ({ text: r.who, cls: 'text-white font-bold' }) },
  { key: 'fl', label: 'Idx Fut Long', cell: r => ({ text: fmtInt(r.m.idxFutLong) }) },
  { key: 'fs', label: 'Idx Fut Short', cell: r => ({ text: fmtInt(r.m.idxFutShort) }) },
  { key: 'fn', label: 'Idx Fut Net', cell: r => ({ text: fmtInt(r.m.idxFutNet, true), cls: `${signClass(r.m.idxFutNet)} font-semibold` }) },
  { key: 'fnd', delta: true, label: 'Δ Net', title: 'Change in index-futures net vs the previous session', cell: r => ({ text: fmtInt(r.d?.idxFutNet, true), cls: signClass(r.d?.idxFutNet) }) },
  { key: 'lp', label: 'Long %', title: 'Index futures long / (long + short)', cell: r => ({ text: r.m.idxFutLongPct === null ? '—' : `${r.m.idxFutLongPct.toFixed(1)}%` }) },
  { key: 'cn', label: 'Idx Call Net', title: 'Index call long − short (contracts)', cell: r => ({ text: fmtInt(r.m.idxCallNet, true), cls: signClass(r.m.idxCallNet) }) },
  { key: 'cnd', delta: true, label: 'Δ Call', cell: r => ({ text: fmtInt(r.d?.idxCallNet, true), cls: signClass(r.d?.idxCallNet) }) },
  { key: 'pn', label: 'Idx Put Net', title: 'Index put long − short (contracts)', cell: r => ({ text: fmtInt(r.m.idxPutNet, true), cls: signClass(r.m.idxPutNet) }) },
  { key: 'pnd', delta: true, label: 'Δ Put', cell: r => ({ text: fmtInt(r.d?.idxPutNet, true), cls: signClass(r.d?.idxPutNet) }) },
  { key: 'sn', label: 'Stk Fut Net', cell: r => ({ text: fmtInt(r.m.stkFutNet, true), cls: signClass(r.m.stkFutNet) }) },
  { key: 'snd', delta: true, label: 'Δ Stk Fut', cell: r => ({ text: fmtInt(r.d?.stkFutNet, true), cls: signClass(r.d?.stkFutNet) }) },
];

// ── FII derivatives statistics table ────────────────────────────────────────

const STATS_PRODUCTS: { key: StatsKey; label: string; sub?: boolean }[] = [
  { key: 'idx_fut', label: 'Index Futures' },
  { key: 'nifty_fut', label: 'NIFTY', sub: true },
  { key: 'banknifty_fut', label: 'BANKNIFTY', sub: true },
  { key: 'stk_fut', label: 'Stock Futures' },
  { key: 'idx_opt', label: 'Index Options' },
  { key: 'nifty_opt', label: 'NIFTY', sub: true },
  { key: 'banknifty_opt', label: 'BANKNIFTY', sub: true },
  { key: 'stk_opt', label: 'Stock Options' },
];

const STATS_HEADERS = ['Product', 'Buy ₹Cr', 'Sell ₹Cr', 'Net ₹Cr', 'Buy contracts', 'Sell contracts', 'OI contracts', 'Δ OI', 'OI ₹Cr'];

export default function FiiDiiPage() {
  const [data, setData] = useState<FiiDiiFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [src, setSrc] = useState<CashSource>('combined');
  const [fnoDate, setFnoDate] = useState<string | null>(null);   // null = latest
  const [basis, setBasis] = useState<'oi' | 'vol'>('oi');
  const [chartWho, setChartWho] = useState<Participant>('FII');
  const autoRefreshed = useRef(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch('/api/fii-dii', { method: 'POST' });
      const json = await res.json();
      if (json.data) setData(json.data);
      if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/fii-dii');
        const json = await res.json();
        if (cancelled) return;
        setData(json.data ?? null);
        setLoaded(true);
        const age = json.data ? Date.now() - Date.parse(json.data.fetched_at) : Infinity;
        if (age > STALE_MS && !autoRefreshed.current) {
          autoRefreshed.current = true;
          void refresh();
        }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  // The Sync Data panel updated the file: show it without a page reload.
  useEffect(() => {
    const onUpdated = () => {
      fetch('/api/fii-dii').then(r => r.json()).then(j => { if (j.data) setData(j.data); }).catch(() => {});
    };
    window.addEventListener('fii-dii:updated', onUpdated);
    return () => window.removeEventListener('fii-dii:updated', onUpdated);
  }, []);

  const cash = useMemo(() => (data ? cashSeries(data.cash, src) : []), [data, src]);
  const cashLatest = cash[cash.length - 1];

  const fno = useMemo(() => data?.fno ?? [], [data]);
  const fnoIdx = useMemo(() => {
    if (!fno.length) return -1;
    const i = fnoDate ? fno.findIndex(d => d.date === fnoDate) : -1;
    return i >= 0 ? i : fno.length - 1;
  }, [fno, fnoDate]);
  const fnoDay: FnoDay | undefined = fno[fnoIdx];
  const fnoPrev: FnoDay | undefined = fnoIdx > 0 ? fno[fnoIdx - 1] : undefined;

  const partRows: PartRow[] = useMemo(() => {
    if (!fnoDay) return [];
    const book = basis === 'oi' ? fnoDay.oi : fnoDay.vol;
    if (!book) return [];
    return PARTICIPANTS.map(who => {
      const m = positionMetrics(book[who]);
      // Day-on-day change only means something for open interest, not for a day's volume.
      const prev = basis === 'oi' && fnoPrev?.oi?.[who] ? positionMetrics(fnoPrev.oi[who]) : null;
      return { who, m, d: basis === 'oi' ? metricChange(m, prev) : null };
    });
  }, [fnoDay, fnoPrev, basis]);

  const partCols = PART_COLUMNS.filter(c => basis === 'oi' || !c.delta);
  const fiiNow = partRows.length && basis === 'oi' ? partRows.find(r => r.who === 'FII') : undefined;
  const fiiOi = fnoDay?.oi?.FII ? positionMetrics(fnoDay.oi.FII) : null;
  const fiiOiPrev = fnoPrev?.oi?.FII ? positionMetrics(fnoPrev.oi.FII) : null;
  const fiiOiChg = fiiOi ? metricChange(fiiOi, fiiOiPrev) : null;
  const bias = longShortBias(fiiOi?.idxFutLongPct ?? null);
  const history = useMemo(() => participantHistory(fno, chartWho), [fno, chartWho]);

  const fii5 = sumLast(cash, 5, 'fii');
  const dii5 = sumLast(cash, 5, 'dii');
  const fiiStreak = streak(cash, 'fii');
  const diiStreak = streak(cash, 'dii');
  const streakText = (n: number) => (n === 0 ? '—' : `${Math.abs(n)}d ${n > 0 ? 'buying' : 'selling'}`);

  const fetchedAt = data ? new Date(data.fetched_at) : null;
  const dataDate = [data?.latest_cash, data?.latest_fno].filter(Boolean).sort().pop();

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 bg-sky-500/10 border-sky-500/25">
            <Landmark className="w-4 h-4 text-sky-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-0.5 text-sky-400">Equity · Institutional Flows</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">FII / DII Activity</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Daily cash-market flows and F&amp;O participant positions from NSE</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh FII/DII data"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            {refreshing ? 'Fetching…' : 'Refresh'}
          </button>
          <span
            className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20"
            title={`Cash ${data?.latest_cash ?? '—'} · F&O ${data?.latest_fno ?? '—'}`}
          >
            DATA: {dataDate || '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1680px] w-full mx-auto">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>Fetch failed: {error}{data ? ' — showing the last saved data.' : ''}</span>
          </div>
        )}
        {data && data.errors?.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Partial data: {data.errors.join(' · ')}
          </div>
        )}
        {refreshing && data && fetchedAt && (
          <p className="text-[11px] text-zinc-500">Showing data fetched {fetchedAt.toLocaleString()} — refreshing…</p>
        )}

        {!loaded || (!data && refreshing) ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-zinc-400 text-sm">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            Downloading NSE reports (about 30 s on the first run)…
          </div>
        ) : !data ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-zinc-400 text-sm">
            No FII/DII data saved yet.
            <button type="button" onClick={() => void refresh()} className="px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800">
              Fetch now
            </button>
          </div>
        ) : (
          <>
            {/* ── Cash market ─────────────────────────────────────────── */}
            <div className="flex items-end justify-between gap-2 flex-wrap">
              <SectionTitle
                title="Capital market (cash)"
                sub={`Provisional, ₹ crore · ${src === 'combined' ? 'NSE + BSE + MSEI' : 'NSE only'} · session ${cashLatest?.date ?? '—'}`}
              />
              <Segmented
                label="Cash source"
                value={src}
                onChange={setSrc}
                options={[{ value: 'combined', label: 'NSE + BSE + MSEI' }, { value: 'nse', label: 'NSE only' }]}
              />
            </div>

            {!cashLatest ? (
              <p className="text-xs text-zinc-500">No cash-market figures saved for this source yet.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">
                <StatTile label="FII / FPI net" value={fmtCr(cashLatest.fii.net)} valueClass={signClass(cashLatest.fii.net)}
                  sub={`B ${fmtCr(cashLatest.fii.buy, false)} · S ${fmtCr(cashLatest.fii.sell, false)}`} />
                <StatTile label="DII net" value={fmtCr(cashLatest.dii.net)} valueClass={signClass(cashLatest.dii.net)}
                  sub={`B ${fmtCr(cashLatest.dii.buy, false)} · S ${fmtCr(cashLatest.dii.sell, false)}`} />
                <StatTile label="FII + DII" value={fmtCr(cashLatest.total)} valueClass={signClass(cashLatest.total)} sub="combined institutional" />
                <StatTile label="FII 5-day" value={fmtCr(fii5)} valueClass={signClass(fii5)} sub={fii5 === null ? `needs 5 sessions (have ${cash.length})` : 'sum of last 5'} />
                <StatTile label="DII 5-day" value={fmtCr(dii5)} valueClass={signClass(dii5)} sub={dii5 === null ? `needs 5 sessions (have ${cash.length})` : 'sum of last 5'} />
                <StatTile label="FII streak" value={streakText(fiiStreak)} valueClass={signClass(fiiStreak)} sub={`${cash.length} saved sessions`} />
                <StatTile label="DII streak" value={streakText(diiStreak)} valueClass={signClass(diiStreak)} sub={`${cash.length} saved sessions`} />
              </div>
            )}

            {cash.length > 0 && (
              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                  <p className="text-xs font-bold text-zinc-200 mb-2">
                    Daily net flow <span className="text-zinc-500 font-normal">· ₹ crore</span>
                  </p>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={cash.slice(-60).map(p => ({ ...p, fiiNet: p.fii.net, diiNet: p.dii.net }))} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={30} />
                        <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={v => `${(v / 1000).toFixed(1)}k`} />
                        <Tooltip content={<CashTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <ReferenceLine y={0} stroke="var(--chart-axis)" />
                        <Bar dataKey="fiiNet" name="FII" fill={FII_COLOR} isAnimationActive={false} maxBarSize={28} />
                        <Bar dataKey="diiNet" name="DII" fill={DII_COLOR} isAnimationActive={false} maxBarSize={28} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  {cash.length < 5 && (
                    <p className="text-[11px] text-zinc-500 mt-1">
                      NSE publishes only the latest session for the cash market, so this history builds up one day per
                      evening the page (or the fetch script) runs.
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-zinc-800 overflow-auto max-h-[328px]">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-zinc-800">
                        {CASH_COLUMNS.map(c => (
                          <th key={c.key} className={`px-3 py-2 text-xs font-bold text-white whitespace-nowrap ${c.key === 'date' ? 'text-left' : 'text-right'}`}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...cash].reverse().map(p => (
                        <tr key={p.date} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                          {CASH_COLUMNS.map(c => {
                            const { text, cls } = c.cell(p);
                            return (
                              <td key={c.key} className={`px-3 py-1.5 font-mono tabular-nums whitespace-nowrap ${c.key === 'date' ? 'text-left' : 'text-right'} ${cls ?? 'text-zinc-200'}`}>{text}</td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── F&O ─────────────────────────────────────────────────── */}
            <div className="flex items-end justify-between gap-2 flex-wrap mt-2">
              <SectionTitle title="F&amp;O (equity derivatives)" sub={`End of day, contracts · session ${fnoDay?.date ?? '—'}${fnoPrev ? ` vs ${fnoPrev.date}` : ''}`} />
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                  Session
                  <select
                    value={fnoDay?.date ?? ''}
                    onChange={e => setFnoDate(e.target.value === fno[fno.length - 1]?.date ? null : e.target.value)}
                    className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    {[...fno].reverse().map(d => <option key={d.date} value={d.date}>{d.date}</option>)}
                  </select>
                </label>
                <Segmented label="Basis" value={basis} onChange={setBasis}
                  options={[{ value: 'oi', label: 'Open interest' }, { value: 'vol', label: 'Day volume' }]} />
              </div>
            </div>

            {!fnoDay ? (
              <p className="text-xs text-zinc-500">No F&amp;O participant data saved yet.</p>
            ) : (
              <>
                {fiiOi && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">
                    <StatTile
                      label="FII idx fut long %"
                      value={fiiOi.idxFutLongPct === null ? '—' : `${fiiOi.idxFutLongPct.toFixed(1)}%`}
                      valueClass={bias.tone === 'bull' ? 'text-emerald-400' : bias.tone === 'bear' ? 'text-red-400' : 'text-white'}
                      sub={`${bias.label}${fiiOiChg?.idxFutLongPct != null ? ` · ${fiiOiChg.idxFutLongPct > 0 ? '+' : ''}${fiiOiChg.idxFutLongPct.toFixed(1)} pts` : ''}`}
                      title="FII index futures long / (long + short) open interest. Above 60% is usually read as bullish, below 25% as heavily short."
                    />
                    <StatTile label="FII idx fut net" value={fmtInt(fiiOi.idxFutNet, true)} valueClass={signClass(fiiOi.idxFutNet)}
                      sub={`${fmtInt(fiiOiChg?.idxFutNet, true)} d/d`} subClass={signClass(fiiOiChg?.idxFutNet)} />
                    <StatTile label="FII idx call net" value={fmtInt(fiiOi.idxCallNet, true)} valueClass={signClass(fiiOi.idxCallNet)}
                      sub={`${fmtInt(fiiOiChg?.idxCallNet, true)} d/d`} subClass={signClass(fiiOiChg?.idxCallNet)} />
                    <StatTile label="FII idx put net" value={fmtInt(fiiOi.idxPutNet, true)} valueClass={signClass(fiiOi.idxPutNet)}
                      sub={`${fmtInt(fiiOiChg?.idxPutNet, true)} d/d`} subClass={signClass(fiiOiChg?.idxPutNet)} />
                    <StatTile label="FII stk fut net" value={fmtInt(fiiOi.stkFutNet, true)} valueClass={signClass(fiiOi.stkFutNet)}
                      sub={`${fmtInt(fiiOiChg?.stkFutNet, true)} d/d`} subClass={signClass(fiiOiChg?.stkFutNet)} />
                    <StatTile label="FII idx fut ₹ net" value={fmtCr(statsNet(fnoDay, 'idx_fut'))} valueClass={signClass(statsNet(fnoDay, 'idx_fut'))}
                      sub="traded value, buy − sell" />
                    <StatTile label="FII stk fut ₹ net" value={fmtCr(statsNet(fnoDay, 'stk_fut'))} valueClass={signClass(statsNet(fnoDay, 'stk_fut'))}
                      sub="traded value, buy − sell" />
                  </div>
                )}

                <div className="rounded-lg border border-zinc-800 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-zinc-800">
                        {partCols.map(c => (
                          <th key={c.key} title={c.title} className={`px-3 py-2 text-xs font-bold text-white whitespace-nowrap ${c.key === 'who' ? 'text-left' : 'text-right'}`}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {partRows.map(r => (
                        <tr key={r.who} className={`border-t border-zinc-800 hover:bg-zinc-900/60 ${r === fiiNow ? 'bg-sky-500/5' : ''}`}>
                          {partCols.map(c => {
                            const { text, cls } = c.cell(r);
                            return (
                              <td key={c.key} className={`px-3 py-1.5 font-mono tabular-nums whitespace-nowrap ${c.key === 'who' ? 'text-left' : 'text-right'} ${cls ?? 'text-zinc-200'}`}>{text}</td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {basis === 'vol' && !fnoDay.vol && <p className="px-3 py-2 text-xs text-zinc-500">No volume file for this session.</p>}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs text-zinc-400">Charts for</p>
                  <Segmented label="Chart participant" value={chartWho} onChange={setChartWho}
                    options={PARTICIPANTS.map(p => ({ value: p, label: p }))} />
                  <p className="text-[11px] text-zinc-500 ml-auto">{history.length} sessions of open interest</p>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <p className="text-xs font-bold text-zinc-200 mb-2">
                      {chartWho} index futures <span className="text-zinc-500 font-normal">· bars = net contracts, line = long % (right axis)</span>
                    </p>
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={history} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={30} />
                          <YAxis yAxisId="n" tick={{ fontSize: 10 }} width={52} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                          <YAxis yAxisId="p" orientation="right" tick={{ fontSize: 10 }} width={36} domain={[0, 100]} tickFormatter={v => `${v}%`} />
                          <Tooltip content={<FutTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                          <ReferenceLine yAxisId="n" y={0} stroke="var(--chart-axis)" />
                          <Bar yAxisId="n" dataKey="idxFutNet" isAnimationActive={false} maxBarSize={18}>
                            {history.map(d => <Cell key={d.date} fill={d.idxFutNet >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'} />)}
                          </Bar>
                          <Line yAxisId="p" dataKey="idxFutLongPct" stroke={FII_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <p className="text-xs font-bold text-zinc-200 mb-2">
                      {chartWho} index options net <span className="text-zinc-500 font-normal">· long − short contracts</span>
                    </p>
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={history} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={30} />
                          <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                          <Tooltip content={<OptTooltip />} cursor={{ stroke: 'var(--chart-cursor-line)' }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <ReferenceLine y={0} stroke="var(--chart-axis)" />
                          <Line dataKey="idxCallNet" name="Calls" stroke={CALL_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
                          <Line dataKey="idxPutNet" name="Puts" stroke={PUT_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {fnoDay.fii_stats ? (
                  <div className="rounded-lg border border-zinc-800 overflow-x-auto">
                    <p className="px-3 py-2 text-xs font-bold text-zinc-200 bg-zinc-900/60">
                      FII derivatives statistics <span className="text-zinc-500 font-normal">· {fnoDay.date} · option values are notional (strike × qty)</span>
                    </p>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-zinc-800">
                          {STATS_HEADERS.map((h, i) => (
                            <th key={h} className={`px-3 py-2 text-xs font-bold text-white whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {STATS_PRODUCTS.map(p => {
                          const r = fnoDay.fii_stats?.[p.key];
                          const net = statsNet(fnoDay, p.key);
                          const dOi = statsOiChange(fnoDay, fnoPrev, p.key);
                          const cells: { text: string; cls?: string }[] = [
                            { text: fmtCr(r?.buy_cr, false) },
                            { text: fmtCr(r?.sell_cr, false) },
                            { text: fmtCr(net), cls: `${signClass(net)} font-semibold` },
                            { text: fmtInt(r?.buy_contracts) },
                            { text: fmtInt(r?.sell_contracts) },
                            { text: fmtInt(r?.oi_contracts) },
                            { text: fmtInt(dOi, true), cls: signClass(dOi) },
                            { text: fmtCr(r?.oi_cr, false) },
                          ];
                          return (
                            <tr key={p.key} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                              <td className={`px-3 py-1.5 whitespace-nowrap text-left ${p.sub ? 'pl-7 text-zinc-400' : 'text-white font-bold'}`}>{p.label}</td>
                              {cells.map((c, i) => (
                                <td key={STATS_HEADERS[i + 1]} className={`px-3 py-1.5 font-mono tabular-nums whitespace-nowrap text-right ${c.cls ?? 'text-zinc-200'}`}>{c.text}</td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">NSE has not published the FII derivatives statistics for {fnoDay.date} yet.</p>
                )}
              </>
            )}

            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Sources (NSE, public): cash — <span className="font-mono">nseindia.com/api/fiidiiTradeReact</span> (NSE+BSE+MSEI) and
              <span className="font-mono"> fiidiiTradeNse</span> (NSE only), provisional figures posted each evening, latest session only;
              F&amp;O — participant-wise open interest and volume (<span className="font-mono">fao_participant_oi/vol_DDMMYYYY.csv</span>) and
              FII derivatives statistics (<span className="font-mono">fii_stats_DD-Mon-YYYY.xls</span>) from nsearchives, archived per day.
              FII = foreign institutional, DII = domestic institutional, Pro = brokers&apos; own accounts, Client = everyone else.
              {fetchedAt && ` Fetched ${fetchedAt.toLocaleString()}.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
