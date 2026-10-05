'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RotateCw, Sigma, Download, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import PayoffPanel from './deltaDesk/PayoffPanel';
import ExposurePanel from './deltaDesk/ExposurePanel';
import { GreeksMatrix, ExpiryBreakdown } from './deltaDesk/GreeksMatrix';
import { ScenarioLadder, LiveTrail, TrailPoint } from './deltaDesk/LadderAndTrail';
import { DeskLeg, RawLeg, Basis, BASIS_LABEL, GREEKS, aggregate, enrichLegs, fmtInr } from '@/lib/deltaDesk';

interface ApiResponse {
  has_positions: boolean;
  legs: RawLeg[];
  timestamp: string;
  error?: string;
}

// Each poll spawns a live broker request (positions + option chains + futures quote).
// Dhan's option-chain endpoint is rate-limited, so the fastest interval is 15s.
const POLL_INTERVALS = [
  { label: 'Manual', ms: 0 },
  { label: '15s', ms: 15000 },
  { label: '30s', ms: 30000 },
  { label: '60s', ms: 60000 },
] as const;

const TRAIL_MAX = 480;
const STALE_AFTER_MS = 90_000;

const istDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });

function Panel({
  title, note, children, className, flush,
}: { title: string; note?: string; children: React.ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn('rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden', className)}>
      <header className="flex items-baseline justify-between gap-3 px-4 pt-3 pb-2">
        <h2 className="text-sm font-bold text-zinc-100 tracking-tight">{title}</h2>
        {note && <p className="text-xs text-zinc-500 text-right">{note}</p>}
      </header>
      <div className={flush ? 'pb-1' : 'px-4 pb-4'}>{children}</div>
    </section>
  );
}

export default function OptionsDeltaPage() {
  const [legs, setLegs] = useState<DeskLeg[]>([]);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState<number>(30000);
  const [basis, setBasis] = useState<Basis>('exposure');
  const [underlying, setUnderlying] = useState<string | null>(null);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);

  const fetchData = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await fetch('/api/options/positions-delta');
      const data = (await res.json()) as ApiResponse;
      if (data.error === 'auth' || data.error === 'auth_failed') {
        setError('The Dhan access token has expired. Run login.py, then refresh.');
        return;
      }
      if (data.error) {
        setError(`The positions script failed (${data.error}). Check the dashboard terminal for details.`);
        return;
      }
      // The script returns market data only; IV and every Greek come from lib/optionsPricing.ts via enrichLegs().
      const next = enrichLegs(data.legs ?? []);
      setLegs(next);
      setTimestamp(data.timestamp ?? new Date().toISOString());
      setError(null);

      if (next.length) {
        const real = aggregate(next, 'lots');
        setTrail(prev => [
          ...prev.slice(-(TRAIL_MAX - 1)),
          { t: Date.now(), netLotDelta: real.delta, pnl: next.reduce((s, l) => s + l.pnl, 0), spot: next[0].spot },
        ]);
      }
    } catch {
      setError('Could not reach the dashboard API. Check that the dev server is running.');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    if (pollMs <= 0) return;
    const id = setInterval(fetchData, pollMs);
    return () => clearInterval(id);
  }, [fetchData, pollMs]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const underlyings = useMemo(() => [...new Set(legs.map(l => l.underlying))], [legs]);
  const activeUnder = underlying && underlyings.includes(underlying) ? underlying : underlyings[0] ?? null;
  const scoped = useMemo(() => legs.filter(l => l.underlying === activeUnder), [legs, activeUnder]);
  const spot = scoped[0]?.spot ?? 0;
  const totalPnl = useMemo(() => legs.reduce((s, l) => s + l.pnl, 0), [legs]);
  const stale = timestamp ? now - new Date(timestamp).getTime() > STALE_AFTER_MS : false;

  const exportCsv = () => {
    if (!legs.length) return;
    const head = ['Symbol', 'Expiry', 'Strike', 'Type', 'Qty', 'Lot size', 'LTP', 'Entry', 'P&L', 'IV %', ...GREEKS.map(g => `${g.name} (per unit)`)];
    const rows = legs.map(l => [
      l.symbol, l.expiry, l.strike, l.type, l.netQty, l.lotSize, l.ltp, l.entryPrice, l.pnl, l.iv ?? '',
      ...GREEKS.map(g => l[g.key] ?? ''),
    ].join(','));
    const url = URL.createObjectURL(new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolio_greeks_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Sigma className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Options · Risk</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Portfolio Greeks</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Live exposure of your open option legs, with payoff and scenarios</p>
          </div>
          {legs.length > 0 && (
            <span className={cn(
              'ml-2 px-2.5 py-1 rounded-lg border text-xs font-bold tabular-nums',
              totalPnl > 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : totalPnl < 0 ? 'bg-red-500/10 text-red-400 border-red-500/20'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-800'
            )}>
              Open P&amp;L {fmtInr(totalPnl, true)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {underlyings.length > 1 && (
            <div role="group" aria-label="Underlying" className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {underlyings.map(u => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnderlying(u)}
                  aria-pressed={activeUnder === u}
                  className={cn('px-2.5 py-1 text-xs font-semibold rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
                    activeUnder === u ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200')}
                >
                  {u}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <div role="group" aria-label="Refresh interval" className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {POLL_INTERVALS.map(({ label, ms }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setPollMs(ms)}
                  aria-pressed={pollMs === ms}
                  className={cn('px-2.5 py-1 text-xs font-semibold rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                    pollMs === ms ? 'bg-sky-500/15 text-sky-400' : 'text-zinc-400 hover:text-zinc-200')}
                >
                  {label}
                </button>
              ))}
            </div>
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-help" />}>
                <Info className="h-3.5 w-3.5 text-zinc-500" aria-label="About refresh interval" />
              </TooltipTrigger>
              <TooltipContent>Each refresh queries live broker positions, option chains and the futures price. 15s is the floor to stay clear of Dhan&apos;s rate limits.</TooltipContent>
            </Tooltip>
          </div>

          <Button onClick={fetchData} disabled={loading} variant="outline" size="icon-sm" aria-label="Refresh Greeks"
            className="bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-300">
            <RotateCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          <Button onClick={exportCsv} disabled={!legs.length} variant="outline" size="sm"
            className="gap-1.5 font-semibold border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <Download className="h-3.5 w-3.5" />Export
          </Button>

          {timestamp && (
            <span className={cn('flex items-center gap-1 text-[10px] font-mono', stale ? 'text-amber-400' : 'text-emerald-400')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-amber-400' : 'bg-emerald-400 animate-ping')} />
              {istTime(timestamp)}
            </span>
          )}
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {timestamp ? istDate(timestamp) : '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <main className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1680px] w-full mx-auto">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {stale && !error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>These numbers are more than 90 seconds old. Turn on auto-refresh or press refresh.</span>
          </div>
        )}

        {loading && legs.length === 0 && !error && (
          <div className="grid gap-4 lg:grid-cols-12" aria-busy="true">
            <div className="lg:col-span-8 h-[480px] rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
            <div className="lg:col-span-4 h-[480px] rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
          </div>
        )}

        {!loading && legs.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 py-24 text-center">
            <Sigma className="h-8 w-8 text-zinc-600" />
            <p className="text-base font-semibold text-zinc-200">No open option positions</p>
            <p className="max-w-md text-sm text-zinc-500">
              Greeks, payoff and scenarios appear here as soon as you hold an NSE F&amp;O option leg on Dhan. This page reads positions live; nothing is stored.
            </p>
          </div>
        )}

        {legs.length > 0 && (
          <>
            <div className="grid gap-4 lg:grid-cols-12">
              <Panel title="Position payoff" note={`${activeUnder} · live level marked in amber`} className="lg:col-span-8">
                <PayoffPanel legs={scoped} spot={spot} spotEstimated={scoped[0]?.spotSource === 'futures'} />
              </Panel>
              <Panel title="Net exposure" note={`${BASIS_LABEL[basis]} basis`} className="lg:col-span-4">
                <ExposurePanel legs={scoped} basis={basis} onBasis={setBasis} />
              </Panel>
            </div>

            <Panel
              title="Full Greeks profile"
              note="Per leg and for the portfolio, on the basis chosen under Net exposure"
              flush
            >
              <GreeksMatrix legs={scoped} basis={basis} />
            </Panel>

            <div className="grid gap-4 lg:grid-cols-12">
              <Panel title="If the market moves" note="Repriced now" className="lg:col-span-7" flush>
                <ScenarioLadder legs={scoped} spot={spot} />
              </Panel>
              <Panel title="Since you opened this page" note="Net delta (lots) and P&L per refresh" className="lg:col-span-5">
                <LiveTrail trail={trail} />
              </Panel>
            </div>

            <Panel title="Risk by expiry" note="So near-dated and far-dated exposure don't net away unseen" flush>
              <ExpiryBreakdown legs={scoped} basis={basis} />
            </Panel>
          </>
        )}
      </main>
    </div>
  );
}
