'use client';

import { useCallback, useEffect, useState } from 'react';
import { Columns3, X } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { PanelStyles } from '@/components/PanelStyles';
import { StraddlePanel } from '@/components/StraddlePanel';
import { HeaderIndexChips } from '@/components/triplestraddle/HeaderIndexChips';
import { StraddleTradeBar } from '@/components/triplestraddle/StraddleTradeBar';
import { useTripleStraddle } from '@/components/triplestraddle/useTripleStraddle';
import { isTsTradable } from '@/lib/tripleStraddleClient';
import { openPositionFor, pnlSummary, type TsSlot } from '@/lib/tripleStraddle';
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
  const [strikes, setStrikes] = useState<Record<TsSlot, number | null>>({ left: null, center: null, right: null });
  const onLeft = useCallback((k: number | null) => setStrikes((s) => (s.left === k ? s : { ...s, left: k })), []);
  const onCenter = useCallback((k: number | null) => setStrikes((s) => (s.center === k ? s : { ...s, center: k })), []);
  const onRight = useCallback((k: number | null) => setStrikes((s) => (s.right === k ? s : { ...s, right: k })), []);
  const strikeCb: Record<TsSlot, (k: number | null) => void> = { left: onLeft, center: onCenter, right: onRight };
  const ts = useTripleStraddle({ underlying, expiry, strikes });
  const tradable = isTsTradable(underlying);
  const openPositions = ts.ledger.positions.filter((p) => p.status === 'OPEN');
  const pnlFor = (mode: 'SIM' | 'REAL') => pnlSummary(ts.ledger.positions.filter((p) => p.mode === mode), ts.livePrices);
  const simPnl = pnlFor('SIM');
  const realPnl = pnlFor('REAL');

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
        /* Sizes are kept at 9px or more (the old 7-8px labels smeared on a 1x display), and the mono
           stack uses the loaded Geist Mono instead of JetBrains Mono, which is never loaded and fell
           back to whatever generic monospace the OS has. */
        .triple-straddle .lc-stat-value,
        .triple-straddle .lc-spot-value { font-size: 11px; }
        .triple-straddle .lc-stat-label { font-size: 9px; letter-spacing: 0.04em; }
        .triple-straddle .lc-group-label { font-size: 9px; }
        .triple-straddle .lc-view-btn { padding: 4px 7px; font-size: 11px; }
        .triple-straddle .lc-status-pill { padding: 3px 6px; font-size: 9px; }
        .triple-straddle .lc-select--mono,
        .triple-straddle .lc-stat-value,
        .triple-straddle .lc-spot-value { font-family: var(--font-geist-mono), ui-monospace, monospace; }
      `}</style>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Columns3 className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">
              Options · {underlying}
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Triple Straddle</h1>
            <p className="text-xs text-zinc-500 font-medium mt-1">
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
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300">
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
            {live ? 'LIVE' : 'CLOSED'}
          </span>
          <HeaderIndexChips />
          <button
            type="button"
            onClick={() => {
              if (!ts.realArmed && !window.confirm('Arm REAL MONEY? New straddles will place live Dhan orders until you turn this off or reload the page.')) return;
              ts.setRealArmed(!ts.realArmed);
            }}
            className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wide focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${ts.realArmed ? 'bg-red-500/15 border-red-500/40 text-red-400' : 'bg-zinc-900 border-zinc-800 text-zinc-300'}`}
            aria-pressed={ts.realArmed}
            title="SIM paper-fills at live prices and never calls the broker. REAL places live Dhan orders."
          >
            {ts.realArmed ? 'REAL · armed' : 'SIM mode'}
          </button>
          {(simPnl.priced + simPnl.unpriced) > 0 && (
            <span className={`text-xs font-mono font-bold px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 ${simPnl.total >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title={simPnl.unpriced ? `${simPnl.unpriced} position(s) unpriced and excluded` : undefined}>
              SIM {simPnl.total < 0 ? '-' : ''}₹{Math.abs(Math.round(simPnl.total)).toLocaleString('en-IN')}{simPnl.unpriced ? '*' : ''}
            </span>
          )}
          {(realPnl.priced + realPnl.unpriced) > 0 && (
            <span className={`text-xs font-mono font-bold px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 ${realPnl.total >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title={realPnl.unpriced ? `${realPnl.unpriced} position(s) unpriced and excluded` : undefined}>
              REAL {realPnl.total < 0 ? '-' : ''}₹{Math.abs(Math.round(realPnl.total)).toLocaleString('en-IN')}{realPnl.unpriced ? '*' : ''}
            </span>
          )}
          {openPositions.length > 0 && (
            <button
              type="button"
              onClick={() => void ts.exitAll()}
              className="px-2.5 py-1.5 rounded-lg bg-red-600 text-oncolor text-xs font-bold uppercase tracking-wide hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              Exit all {openPositions.length}
            </button>
          )}
          <span className="text-xs font-mono font-bold text-amber-300 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 uppercase">
            DATA: {today}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      {(ts.isLeader === false || ts.staleOpen) && (
        <div className="px-4 pt-2" role="status">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
            {ts.isLeader === false && 'Another tab is running stop-loss/target for this page; this tab only shows positions. '}
            {ts.staleOpen && 'Option prices are stale — stop-loss and target are paused.'}
          </div>
        </div>
      )}

      {ts.notices.length > 0 && (
        <div className="px-4 pt-2 flex flex-col gap-1" role="status" aria-live="polite">
          {ts.notices.map((n) => (
            <div key={n.id} className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs ${n.kind === 'error' ? 'border-red-500/40 bg-red-500/10 text-red-400' : n.kind === 'success' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`}>
              <span>{n.text}</span>
              <button type="button" onClick={() => ts.dismissNotice(n.id)} aria-label="Dismiss message" className="shrink-0"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}

      <main className="triple-straddle flex-1 grid grid-cols-1 xl:grid-cols-3 gap-3 px-4 py-3">
        {expiry ? (
          <>
            {[
              { id: 'left', offset: offsets.left, onChange: (n: number) => updateOffsets({ ...offsets, left: n }) },
              { id: 'center', offset: 0, onChange: undefined },
              { id: 'right', offset: offsets.right, onChange: (n: number) => updateOffsets({ ...offsets, right: n }) },
            ].map((p) => (
              <div key={p.id} className="min-w-0 flex flex-col gap-2 xl:h-[calc(100vh-110px)]">
                <div className="min-h-0 h-[500px] xl:h-auto xl:flex-1 xl:min-h-[400px]">
                  <StraddlePanel
                    key={`${p.id}-${panelKey}`}
                    {...common}
                    fixedExpiry={expiry}
                    atmOffset={p.offset}
                    onAtmOffsetChange={p.onChange}
                    onStrikeResolved={strikeCb[p.id as TsSlot]}
                  />
                </div>
                {(() => {
                  const pos = openPositionFor(ts.ledger, p.id as TsSlot);
                  return (
                    <StraddleTradeBar
                      slot={p.id as TsSlot}
                      strike={strikes[p.id as TsSlot]}
                      lookup={ts.lookups[p.id as TsSlot]}
                      position={pos}
                      live={pos ? ts.livePrices(pos) : {}}
                      busy={ts.busy[p.id as TsSlot]}
                      realArmed={ts.realArmed}
                      canTrade={tradable && ts.loaded}
                      tradableReason={!tradable ? `${underlying} cannot be traded from this page (NIFTY, BANKNIFTY, SENSEX only)` : 'Loading your positions…'}
                      onTrade={ts.trade}
                      onExit={(slot) => void ts.exit(slot)}
                      onRisk={(slot, risk) => void ts.setRisk(slot, risk)}
                      onResolve={(slot, option, action) => void ts.resolveLeg(slot, option, action)}
                    />
                  );
                })()}
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
