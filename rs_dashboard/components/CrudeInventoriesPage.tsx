'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Warehouse } from 'lucide-react';
import {
  Area, Bar, Cell, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import NavBar from '@/components/NavBar';
import {
  consensusByWeek, fmtMillion, fmtValue, nextRelease, seasonalBand, surpriseStats,
  toMillion, vsAvgPct, weeklyChanges, withOfficialActual,
  type ConsensusJoin, type InventoryFile, type SeriesKey,
} from '@/lib/crudeInventory';

// Re-fetch automatically when the cache is older than this (EIA publishes once a week, but the
// consensus for the next report moves during the week).
const STALE_MS = 6 * 60 * 60 * 1000;

const CHART_SERIES: SeriesKey[] = [
  'crude', 'cushing', 'gasoline', 'distillate', 'spr', 'refinery', 'production', 'imports', 'exports',
];

const SHORT_LABEL: Record<SeriesKey, string> = {
  crude: 'Crude', cushing: 'Cushing', gasoline: 'Gasoline', distillate: 'Distillate', spr: 'SPR',
  refinery: 'Refinery %', production: 'Production', imports: 'Imports', exports: 'Exports',
};

const LINE_COLOR = '#fbbf24';
const BAND_COLOR = '#f59e0b';

function todayEt(): string {
  // Release dates on the calendar are US Eastern.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function signClass(v: number | null | undefined, invert = false): string {
  if (v === null || v === undefined || v === 0) return 'text-zinc-300';
  const up = invert ? v < 0 : v > 0;
  return up ? 'text-emerald-400' : 'text-red-400';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function LevelTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>Week ending {label}</p>
      <p style={{ fontWeight: 700 }}>{fmtValue(p.value, unit)}</p>
      {p.avg !== null && (
        <>
          <p>5y avg {fmtValue(p.avg, unit)}</p>
          <p>5y range {fmtValue(p.min, unit)} – {fmtValue(p.max, unit)}</p>
        </>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChangeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as { change: number; forecast: number | null };
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>Week ending {label}</p>
      <p style={{ color: p.change <= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)', fontWeight: 700 }}>
        {p.change <= 0 ? 'Draw' : 'Build'} {fmtMillion(p.change, true, 3)}
      </p>
      {p.forecast !== null && <p>Forecast {fmtMillion(p.forecast, true, 3)}</p>}
    </div>
  );
}

function StatTile({ label, value, sub, subClass }: { label: string; value: string; sub?: string; subClass?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 truncate">{label}</p>
      <p className="text-base font-bold text-white tabular-nums font-mono mt-0.5 truncate">{value}</p>
      {sub && <p className={`text-[11px] tabular-nums font-mono mt-0.5 truncate ${subClass ?? 'text-zinc-400'}`}>{sub}</p>}
    </div>
  );
}

interface TableRow {
  week: string;
  crude: number;
  crudeChg: number | null;
  eia: ConsensusJoin | undefined;
  api: ConsensusJoin | undefined;
  cushingChg: number | null;
  gasolineChg: number | null;
  distillateChg: number | null;
  refinery: number | null;
}

const fmtM = (v: number | null | undefined) => fmtMillion(v, true, 3);

// One array drives both <th> and <td> so the counts cannot drift.
const COLUMNS: { key: string; label: string; title?: string; cell: (r: TableRow) => { text: string; cls?: string } }[] = [
  { key: 'week', label: 'Week ending', cell: r => ({ text: r.week, cls: 'text-zinc-300' }) },
  { key: 'crude', label: 'Crude stocks', cell: r => ({ text: fmtMillion(toMillion(r.crude), false, 1) }) },
  { key: 'chg', label: 'EIA Δ', title: 'Official EIA change in commercial crude', cell: r => ({ text: fmtM(r.crudeChg === null ? null : toMillion(r.crudeChg)), cls: signClass(r.crudeChg, true) }) },
  { key: 'fc', label: 'Forecast', title: 'Investing.com consensus for the EIA change', cell: r => ({ text: fmtM(r.eia?.forecast) }) },
  { key: 'surp', label: 'Surprise', title: 'Actual − forecast (negative = bigger draw than expected)', cell: r => ({ text: fmtM(r.eia?.surprise), cls: signClass(r.eia?.surprise, true) }) },
  { key: 'api', label: 'API Δ', title: 'American Petroleum Institute estimate, released the day before', cell: r => ({ text: fmtM(r.api?.actual), cls: signClass(r.api?.actual, true) }) },
  { key: 'cush', label: 'Cushing Δ', cell: r => ({ text: fmtM(r.cushingChg === null ? null : toMillion(r.cushingChg)), cls: signClass(r.cushingChg, true) }) },
  { key: 'gas', label: 'Gasoline Δ', cell: r => ({ text: fmtM(r.gasolineChg === null ? null : toMillion(r.gasolineChg)), cls: signClass(r.gasolineChg, true) }) },
  { key: 'dist', label: 'Distillate Δ', cell: r => ({ text: fmtM(r.distillateChg === null ? null : toMillion(r.distillateChg)), cls: signClass(r.distillateChg, true) }) },
  { key: 'ref', label: 'Refinery util', cell: r => ({ text: fmtValue(r.refinery, 'pct') }) },
];

export default function CrudeInventoriesPage() {
  const [data, setData] = useState<InventoryFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartKey, setChartKey] = useState<SeriesKey>('crude');
  const [weeks, setWeeks] = useState<26 | 52 | 104>(52);
  const autoRefreshed = useRef(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch('/api/crude-inventories', { method: 'POST' });
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
        const res = await fetch('/api/crude-inventories');
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

  const view = useMemo(() => {
    if (!data) return null;
    const s = data.series;
    const eiaByWeek = consensusByWeek(data.consensus?.eia ?? []);
    const apiByWeek = consensusByWeek(data.consensus?.api ?? []);
    const changes = (k: SeriesKey) => new Map(weeklyChanges(s[k]?.points ?? []).map(r => [r.week, r]));
    const crudeCh = weeklyChanges(s.crude.points);
    const cush = changes('cushing');
    const gas = changes('gasoline');
    const dist = changes('distillate');
    const ref = new Map((s.refinery?.points ?? []).map(([w, v]) => [w, v]));

    const rows: TableRow[] = crudeCh.slice(-26).reverse().map(r => ({
      week: r.week,
      crude: r.value,
      crudeChg: r.change,
      eia: withOfficialActual(eiaByWeek.get(r.week), r.change === null ? null : toMillion(r.change)),
      api: apiByWeek.get(r.week),
      cushingChg: cush.get(r.week)?.change ?? null,
      gasolineChg: gas.get(r.week)?.change ?? null,
      distillateChg: dist.get(r.week)?.change ?? null,
      refinery: ref.get(r.week) ?? null,
    }));

    const latestOf = (k: SeriesKey) => {
      const ch = weeklyChanges(s[k]?.points ?? []);
      const band = seasonalBand(s[k]?.points ?? [], 1);
      return { last: ch[ch.length - 1], band: band[0] };
    };

    return {
      rows,
      crude: latestOf('crude'),
      cushing: latestOf('cushing'),
      gasoline: latestOf('gasoline'),
      distillate: latestOf('distillate'),
      spr: latestOf('spr'),
      refinery: latestOf('refinery'),
      production: latestOf('production'),
      eiaLatest: rows[0]?.eia,
      next: nextRelease(data.consensus?.eia ?? [], todayEt(), data.latest_week),
      nextApi: nextRelease(data.consensus?.api ?? [], todayEt()),
      stats: surpriseStats(rows.map(r => r.eia).filter((j): j is ConsensusJoin => !!j)),
      eiaByWeek,
    };
  }, [data]);

  const levelData = useMemo(() => {
    if (!data?.series[chartKey]) return [];
    return seasonalBand(data.series[chartKey].points, weeks);
  }, [data, chartKey, weeks]);

  const changeData = useMemo(() => {
    if (!data || !view) return [];
    return weeklyChanges(data.series.crude.points).slice(-weeks)
      .filter(r => r.change !== null)
      .map(r => ({
        week: r.week,
        change: toMillion(r.change!),
        forecast: view.eiaByWeek.get(r.week)?.forecast ?? null,
      }));
  }, [data, view, weeks]);

  const unit = data?.series[chartKey]?.unit ?? 'kbbl';
  const crudeVsAvg = vsAvgPct(view?.crude.band);
  const fetchedAt = data ? new Date(data.fetched_at) : null;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 bg-amber-500/10 border-amber-500/25">
            <Warehouse className="w-4 h-4 text-amber-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-0.5 text-amber-400">Commodities · Crude Oil</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Crude Inventories</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Weekly EIA stocks vs the 5-year range, with API and consensus forecasts</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {view?.next && (
            <span className="text-[11px] text-zinc-400 tabular-nums" title="Next EIA report (US Eastern) and the Investing.com consensus">
              Next EIA {view.next.release} {view.next.time} ET · fcst <span className="text-zinc-200 font-semibold">{fmtM(view.next.forecast)}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh inventory data"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            {refreshing ? 'Fetching…' : 'Refresh'}
          </button>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {data?.latest_week || '—'}
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
        {data && data.consensus_status !== 'ok' && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
            Consensus (Investing.com) {data.consensus_status === 'partial' ? 'partly unavailable' : `not fetched: ${data.consensus_status}`}. EIA figures are unaffected.
          </div>
        )}
        {refreshing && data && fetchedAt && (
          <p className="text-[11px] text-zinc-500">Showing data fetched {fetchedAt.toLocaleString()} — refreshing…</p>
        )}

        {!loaded || (!data && refreshing) ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-zinc-400 text-sm">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            Downloading EIA history and consensus (about 15 s)…
          </div>
        ) : !data || !view ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-zinc-400 text-sm">
            No inventory data saved yet.
            <button type="button" onClick={() => void refresh()} className="px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800">
              Fetch now
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
              <StatTile
                label="Commercial crude"
                value={fmtValue(view.crude.last?.value, 'kbbl')}
                sub={`${fmtValue(view.crude.last?.change, 'kbbl', true)} w/w`}
                subClass={signClass(view.crude.last?.change, true)}
              />
              <StatTile
                label="vs 5y average"
                value={crudeVsAvg === null ? '—' : `${crudeVsAvg > 0 ? '+' : ''}${crudeVsAvg.toFixed(1)}%`}
                sub={`avg ${fmtValue(view.crude.band?.avg, 'kbbl')}`}
              />
              <StatTile
                label="EIA vs forecast"
                value={fmtM(view.eiaLatest?.surprise)}
                sub={view.eiaLatest ? `act ${fmtM(view.eiaLatest.actual)} · fcst ${fmtM(view.eiaLatest.forecast)}` : 'no consensus row'}
                subClass="text-zinc-400"
              />
              <StatTile
                label="API (latest)"
                value={fmtM(view.rows[0] ? view.rows[0].api?.actual : null)}
                sub={view.nextApi ? `next ${view.nextApi.release} ${view.nextApi.time} ET` : undefined}
              />
              <StatTile
                label="Cushing"
                value={fmtValue(view.cushing.last?.value, 'kbbl')}
                sub={`${fmtValue(view.cushing.last?.change, 'kbbl', true)} w/w`}
                subClass={signClass(view.cushing.last?.change, true)}
              />
              <StatTile
                label="Gasoline / Distillate"
                value={`${fmtValue(view.gasoline.last?.change, 'kbbl', true).replace(' bbl', '')} / ${fmtValue(view.distillate.last?.change, 'kbbl', true).replace(' bbl', '')}`}
                sub="w/w change"
              />
              <StatTile
                label="Refinery util"
                value={fmtValue(view.refinery.last?.value, 'pct')}
                sub={`${fmtValue(view.refinery.last?.change, 'pct', true)} w/w · wk ${view.refinery.last?.week ?? '—'}`}
              />
              <StatTile
                label="SPR"
                value={fmtValue(view.spr.last?.value, 'kbbl')}
                sub={`${fmtValue(view.spr.last?.change, 'kbbl', true)} w/w`}
              />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex rounded-md border border-zinc-800 overflow-hidden" role="tablist" aria-label="Series">
                {CHART_SERIES.map(k => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={chartKey === k}
                    onClick={() => setChartKey(k)}
                    className={`px-2.5 py-1 text-xs ${chartKey === k ? 'bg-amber-500/15 text-amber-300 font-semibold' : 'text-zinc-400 hover:bg-zinc-800'}`}
                  >
                    {SHORT_LABEL[k]}
                  </button>
                ))}
              </div>
              <div className="flex rounded-md border border-zinc-800 overflow-hidden ml-auto" role="tablist" aria-label="Lookback">
                {([26, 52, 104] as const).map(w => (
                  <button
                    key={w}
                    type="button"
                    role="tab"
                    aria-selected={weeks === w}
                    onClick={() => setWeeks(w)}
                    className={`px-2.5 py-1 text-xs tabular-nums ${weeks === w ? 'bg-amber-500/15 text-amber-300 font-semibold' : 'text-zinc-400 hover:bg-zinc-800'}`}
                  >
                    {w === 104 ? '2Y' : `${w}W`}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-xs font-bold text-zinc-200 mb-2">
                  {data.series[chartKey]?.label} <span className="text-zinc-500 font-normal">· shaded = previous 5-year range, dashed = 5-year average</span>
                </p>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={levelData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} minTickGap={40} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        width={52}
                        domain={['auto', 'auto']}
                        tickFormatter={v => unit === 'kbbl' ? `${(v / 1000).toFixed(0)}M` : unit === 'pct' ? `${v}%` : `${(v / 1000).toFixed(1)}k`}
                      />
                      <Tooltip content={<LevelTooltip unit={unit} />} cursor={{ stroke: 'var(--chart-cursor-line)' }} />
                      <Area dataKey="range" stroke="none" fill={BAND_COLOR} fillOpacity={0.12} isAnimationActive={false} connectNulls />
                      <Line dataKey="avg" stroke="var(--chart-tick)" strokeDasharray="4 4" dot={false} strokeWidth={1} isAnimationActive={false} connectNulls />
                      <Line dataKey="value" stroke={LINE_COLOR} dot={false} strokeWidth={2} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-xs font-bold text-zinc-200 mb-2">
                  Weekly change, commercial crude <span className="text-zinc-500 font-normal">· <span className="text-emerald-400">draw</span> / <span className="text-red-400">build</span>, ticks = consensus</span>
                </p>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={changeData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10 }} width={44} tickFormatter={v => `${v}M`} />
                      <Tooltip content={<ChangeTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                      <ReferenceLine y={0} stroke="var(--chart-axis)" />
                      <Bar dataKey="change" isAnimationActive={false}>
                        {changeData.map(d => (
                          <Cell key={d.week} fill={d.change <= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'} />
                        ))}
                      </Bar>
                      <Line dataKey="forecast" stroke={LINE_COLOR} strokeWidth={0} dot={{ r: 2.5, fill: LINE_COLOR }} isAnimationActive={false} connectNulls={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {view.stats.count > 0 && (
              <p className="text-[11px] text-zinc-500 tabular-nums">
                Consensus record over {view.stats.count} saved EIA releases: direction right {view.stats.hits}/{view.stats.count},
                average miss {fmtMillion(view.stats.meanAbsSurprise, false, 2)}. Investing.com lists only the last ~10 releases, so this history grows with each refresh.
              </p>
            )}

            <div className="rounded-lg border border-zinc-800 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-zinc-800">
                    {COLUMNS.map(c => (
                      <th key={c.key} title={c.title} className={`px-3 py-2 text-xs font-bold text-white whitespace-nowrap ${c.key === 'week' ? 'text-left' : 'text-right'}`}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map(r => (
                    <tr key={r.week} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                      {COLUMNS.map(c => {
                        const { text, cls } = c.cell(r);
                        return (
                          <td key={c.key} className={`px-3 py-1.5 font-mono tabular-nums whitespace-nowrap ${c.key === 'week' ? 'text-left' : 'text-right'} ${cls ?? 'text-zinc-200'}`}>
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-zinc-500">
              Sources: EIA Weekly Petroleum Status Report (official; released Wednesdays 10:30 ET, a day later in holiday weeks) ·
              API Weekly Statistical Bulletin and consensus via Investing.com (indicative). Green = inventory draw (supportive for price), red = build.
              {fetchedAt && ` Fetched ${fetchedAt.toLocaleString()}.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
