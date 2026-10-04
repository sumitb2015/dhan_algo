'use client';

import { useEffect, useState } from 'react';
import { Columns3 } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { PanelStyles } from '@/components/PanelStyles';
import { StraddlePanel } from '@/components/StraddlePanel';
import { isAbortError, optionsChartApi } from '@/lib/optionsChartApi';
import { isUnderlyingLive } from '@/lib/marketHours';
import { VALID_INTERVALS } from '@/lib/optionsChartTypes';
import { CHART_UNDERLYINGS, type ChartUnderlying } from '@/lib/underlyings';

const OFFSETS_KEY = 'tripleStraddle.offsets';
const DEFAULT_OFFSETS = { left: -100, right: 100 };

function loadOffsets(): { left: number; right: number } {
  try {
    const raw = localStorage.getItem(OFFSETS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Number.isFinite(p?.left) && Number.isFinite(p?.right)) return { left: p.left, right: p.right };
    }
  } catch {
    /* storage unavailable - fall through to defaults */
  }
  return DEFAULT_OFFSETS;
}

/** Three parallel live straddle charts: ATM-offset (left), ATM (centre), ATM+offset (right).
 *  Reuses StraddlePanel in its ATM-offset mode; expiry/interval/underlying are shared. */
export default function TripleStraddlePage() {
  const [underlying, setUnderlying] = useState<ChartUnderlying>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [interval_, setInterval_] = useState('1');
  const [offsets, setOffsets] = useState(DEFAULT_OFFSETS);
  const [live, setLive] = useState(false);

  useEffect(() => {
    // Hydrate after mount so server and client first renders match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffsets(loadOffsets());
  }, []);

  function updateOffsets(next: { left: number; right: number }) {
    setOffsets(next);
    try {
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const update = () => setLive(isUnderlyingLive(underlying, new Date()));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [underlying]);

  useEffect(() => {
    const controller = new AbortController();
    optionsChartApi
      .expiries(underlying)
      .then((r) => {
        if (controller.signal.aborted) return;
        setExpiries(r.expiries);
        setExpiry((prev) => (r.expiries.includes(prev) ? prev : r.expiries[0] ?? ''));
      })
      .catch((e) => {
        if (!isAbortError(e)) setExpiries([]);
      });
    return () => controller.abort();
  }, [underlying]);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const common = { underlying, onUnderlyingChange: setUnderlying, fixedInterval: interval_ };
  const panelKey = `${underlying}-${expiry}`;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <PanelStyles />
      <style>{`
        /* Three panels share the row, so compact each toolbar: View buttons and the
           Day Δ / OHLC / PDC / SPOT stats sit on one line. */
        .triple-straddle .lc-toolbar { flex-wrap: wrap; row-gap: 4px; }
        .triple-straddle .lc-toolbar-stats { margin-left: 0; flex: 1 1 auto; justify-content: flex-end; gap: 3px; min-width: 0; }
        .triple-straddle .lc-toolbar-stats > span { gap: 3px; }
        .triple-straddle .lc-stat-card,
        .triple-straddle .lc-spot-card { padding: 1px 4px; }
        .triple-straddle .lc-stat-value,
        .triple-straddle .lc-spot-value { font-size: 10px; }
        .triple-straddle .lc-stat-label { font-size: 7px; letter-spacing: 0.06em; }
        .triple-straddle .lc-view-btn { padding: 4px 6px; font-size: 10px; }
        .triple-straddle .lc-status-pill { padding: 3px 6px; font-size: 8px; }
      `}</style>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Columns3 className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">
              Options · {underlying}
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Triple Straddle</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              ATM straddle with a lower and higher offset straddle side by side
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={underlying}
            onChange={(e) => setUnderlying(e.target.value as ChartUnderlying)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-bold text-zinc-100"
            aria-label="Underlying"
          >
            {CHART_UNDERLYINGS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-zinc-100"
            aria-label="Expiry"
          >
            {expiries.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <select
            value={interval_}
            onChange={(e) => setInterval_(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-zinc-100"
            aria-label="Interval"
          >
            {VALID_INTERVALS.map((i) => (
              <option key={i} value={i}>
                {i}m
              </option>
            ))}
          </select>
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[10px] font-bold text-zinc-300">
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
            {live ? 'LIVE' : 'CLOSED'}
          </span>
          <span className="text-[10px] font-mono font-bold text-amber-300 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 uppercase">
            DATA: {today}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      <main className="triple-straddle flex-1 grid grid-cols-1 xl:grid-cols-3 gap-3 px-4 py-3">
        {expiry ? (
          <>
            {[
              { id: 'left', offset: offsets.left, onChange: (n: number) => updateOffsets({ ...offsets, left: n }) },
              { id: 'center', offset: 0, onChange: undefined },
              { id: 'right', offset: offsets.right, onChange: (n: number) => updateOffsets({ ...offsets, right: n }) },
            ].map((p) => (
              <div key={p.id} className="min-w-0 h-[560px] xl:h-[calc(100vh-110px)] xl:min-h-[480px]">
                <StraddlePanel
                  key={`${p.id}-${panelKey}`}
                  {...common}
                  fixedExpiry={expiry}
                  atmOffset={p.offset}
                  onAtmOffsetChange={p.onChange}
                />
              </div>
            ))}
          </>
        ) : (
          <p className="text-xs text-zinc-500 xl:col-span-3">Loading expiries…</p>
        )}
      </main>
    </div>
  );
}
