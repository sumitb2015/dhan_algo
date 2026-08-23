'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Terminal, Plus, X, Play, Square, ChevronDown, BookOpen, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import ShiftCspModal, { type ShiftTarget } from './ShiftCspModal';
import CspGlossary from './CspGlossary';
import CspGuide from './CspGuide';
import {
  TH, TD, PctText, fmt, fmtInr, fmtCompactInr, fetchWithTimeout,
} from './cspShared';
import { SCANNER_COLUMNS, TRACKED_COLUMNS, columnTip, type ColumnDoc } from './cspColumns';

// Stock F&O order placement is Dhan-only — /api/options/chain and the
// csp_watchlist.py CLI both go through the Dhan client, so no broker selector.
const BROKER = 'dhan' as const;

const UNIVERSES = [
  { value: 'nifty500', label: 'NIFTY 500' },
  { value: 'nifty50',  label: 'NIFTY 50' },
] as const;
type Universe = typeof UNIVERSES[number]['value'];

// Offset into each symbol's own expiry list, applied after the 5-day-out
// floor — most F&O stocks only carry 2-3 months, so anything past "Far" has
// nothing left to clamp to on most names.
const EXPIRY_OFFSETS = [
  { value: 0, label: 'Near month' },
  { value: 1, label: 'Next month' },
  { value: 2, label: 'Far month' },
] as const;

interface ScanRow {
  symbol: string;
  score: number;
  ltp: number;
  expiry: string;
  dte: number;
  lotSize: number;
  /** When this row's own quote was fetched — a full sweep takes ~10 minutes,
   * so this can lag well behind the header's overall scan-completion time. */
  scannedAt?: string;
  move1d: number;
  move5d: number;
  /** Daily-history CSV hasn't refreshed recently — move1d/move5d may be
   * computed against a stale close. */
  historyStale?: boolean;
  /** Chance of trading at/below the strike at any point before expiry. */
  touchProb?: number;
  strike: number;
  premium: number;
  premiumTotal: number;
  noHitProb: number;
  iv: number;
  oi: number;
  yieldPct: number;
  /** Yield scaled to a year, so strikes on different expiries compare. */
  annYieldPct?: number;
  capitalRequired: number;
  /** Marks the strike nearest the scan's target probability for this symbol. */
  isPick?: boolean;
  rationale: string;
}

interface TrackedRow {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  qty: number;
  lotSize: number;
  entrySpot: number;
  entryDate: string;
  avgPrice: number;
  orderId?: string;
  securityId?: string;
  status: 'OPEN' | 'CLOSED' | 'ROLLED';
  exitPrice?: number;
  realizedPnl?: number;
  needsReconcile?: boolean;
  reconcileNote?: string;
}

/** A short put held at the broker with no tracked row — what an order that
 *  filled after its route timed out leaves behind. */
interface UntrackedPosition {
  securityId: string;
  tradingSymbol: string;
  symbol: string;
  netQty: number;
  avgPrice: number;
  strike: number;
  expiry: string;
  productType: string;
  exchangeSegment: string;
  lotSize: number;
}

import type { SyncRow } from '@/lib/cspTracked';

interface ScanStatus {
  message: string;
  current: number;
  total: number;
  done: boolean;
  error: string | null;
}

/** A header whose hover tooltip is looked up from the shared column docs by its
 *  own text, so the glossary modal and the tooltip can never disagree. Pass
 *  `label` when the rendered text contains an entity (&amp;) and so differs
 *  from the plain-text key. */
function docTH(columns: ColumnDoc[]) {
  return function DocTH({ children, right, label }: {
    children: React.ReactNode; right?: boolean; label?: string;
  }) {
    const term = label ?? (typeof children === 'string' ? children : '');
    const tip = columnTip(columns, term);
    // help cursor only when there is something to read, so hovering a header
    // that promises an explanation always gives one.
    return <TH right={right} title={tip} className={tip ? 'cursor-help' : undefined}>{children}</TH>;
  };
}

const ScanTH = docTH(SCANNER_COLUMNS);
const TrackTH = docTH(TRACKED_COLUMNS);

function ScoreBadge({ v }: { v: number }) {
  const tone = v >= 70 ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
    : v >= 55 ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
      : 'bg-zinc-800 text-zinc-400 border-zinc-700';
  return (
    <span className={cn('inline-flex min-w-[28px] justify-center rounded-sm border px-1.5 py-px font-mono text-[11px] font-bold tabular-nums', tone)}>
      {v}
    </span>
  );
}

/** Horizontal track showing where spot sits between the sold strike (left,
 *  danger) and the entry spot (right, safe). */
function VisualStatus({ spot, strike, entrySpot }: { spot: number; strike: number; entrySpot: number }) {
  if (!spot || !strike || !entrySpot || entrySpot <= strike) {
    return <span className="text-zinc-600">—</span>;
  }
  const pct = Math.max(0, Math.min(1, (spot - strike) / (entrySpot - strike)));
  const tone = pct > 0.66 ? 'bg-emerald-500' : pct > 0.33 ? 'bg-amber-400' : 'bg-red-500';
  return (
    <div className="relative h-1.5 w-24 rounded-full bg-zinc-800" title={`Spot ${fmt(spot)} · Strike ${strike} · Entry ${fmt(entrySpot)}`}>
      <div className={cn('absolute top-0 h-1.5 rounded-full', tone)} style={{ width: `${pct * 100}%` }} />
      <span className={cn('absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black', tone)}
        style={{ left: `${pct * 100}%` }} />
    </div>
  );
}

const blankManual = {
  symbol: '', strike: '', expiry: '', qty: '', lotSize: '', entrySpot: '', avgPrice: '',
};

// Both exceed their route's own budget, so the client never abandons a call
// that is still running server-side. The sell route waits up to 90s on a fill;
// the sync route caps itself at 240s (SYNC_MAX_MS).
const SELL_CLIENT_TIMEOUT_MS = 120_000;
const SYNC_CLIENT_TIMEOUT_MS = 300_000;

export default function CspScreener() {
  const [scanRows, setScanRows] = useState<ScanRow[]>([]);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  // `universe` is the next-scan selection the toggle controls; `resultsUniverse`
  // is what the currently-displayed rows actually came from — they diverge
  // whenever the user flips the toggle without rescanning yet.
  const [universe, setUniverse] = useState<Universe>('nifty500');
  const [resultsUniverse, setResultsUniverse] = useState<Universe>('nifty500');
  const hasInitializedUniverseRef = useRef(false);
  // Same next-scan-vs-currently-loaded split as universe/resultsUniverse above.
  // 0 = nearest expiry at least 5 days out, 1 = the one after that, etc.
  const [expiryOffset, setExpiryOffset] = useState(0);
  const [resultsExpiryOffset, setResultsExpiryOffset] = useState(0);
  const [symbolsScanned, setSymbolsScanned] = useState<number | null>(null);
  const [scanSkipped, setScanSkipped] = useState<Record<string, string>>({});
  const [apiFailures, setApiFailures] = useState(0);
  // Defaults to the safe side of the curve, not the scanner's own 40% floor —
  // yield and safety are almost perfectly inversely correlated (see
  // cspColumns.ts Score doc), so the raw scanned universe is risk-sorted in
  // reverse until this filter is applied. 65% keeps real capital out of
  // coin-flip strikes without a manual step every session; still adjustable.
  const [minNoHit, setMinNoHit] = useState(65);
  const [maxNoHit, setMaxNoHit] = useState(100);
  // A deep-OTM strike paying 0.02% is not worth the brokerage, so the default
  // hides them rather than making every session re-filter by hand.
  const [minYield, setMinYield] = useState(0.25);
  const [minAnnYield, setMinAnnYield] = useState(0);
  const [minPremium, setMinPremium] = useState(0);
  const [bestPerSymbol, setBestPerSymbol] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanLoading, setScanLoading] = useState(true);

  const [tracked, setTracked] = useState<TrackedRow[]>([]);
  const [syncMap, setSyncMap] = useState<Record<string, SyncRow>>({});
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [untracked, setUntracked] = useState<UntrackedPosition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState(blankManual);
  const [shiftTarget, setShiftTarget] = useState<ShiftTarget | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [sell, setSell] = useState<{ row: ScanRow; lots: string; submitting: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showGlossary, setShowGlossary] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const wasRunningRef = useRef(false);

  // ── Data loading ──────────────────────────────────────────────────────
  const loadScan = useCallback(async () => {
    try {
      const res = await fetch('/api/csp-scan');
      const j = await res.json();
      if (j.success) {
        setScanRows(j.rows ?? []);
        setScannedAt(j.scannedAt ?? null);
        const resultsUni: Universe = j.universe === 'nifty50' ? 'nifty50' : 'nifty500';
        setResultsUniverse(resultsUni);
        const resultsOffset = Number.isFinite(j.expiryOffset) ? Number(j.expiryOffset) : 0;
        setResultsExpiryOffset(resultsOffset);
        // Seed the toggles from the last completed scan only once, so a page
        // reload reflects them — but don't let later polls stomp a user's
        // in-progress selection before they've rescanned.
        if (!hasInitializedUniverseRef.current) {
          hasInitializedUniverseRef.current = true;
          setUniverse(resultsUni);
          setExpiryOffset(resultsOffset);
        }
        setSymbolsScanned(j.symbolsScanned ?? null);
        setScanSkipped(j.symbolsSkipped ?? {});
        setApiFailures(Number(j.apiFailures) || 0);
        setScanRunning(Boolean(j.running));
        setScanStatus(j.status ?? null);
      }
    } catch {
      setError('Failed to load scan results');
    } finally {
      setScanLoading(false);
    }
  }, []);

  const loadTracked = useCallback(async () => {
    try {
      const res = await fetch('/api/csp-tracked');
      const j = await res.json();
      if (j.success) {
        setTracked(j.rows ?? []);
        // Marks from the last sync, so P&L is populated on load rather than
        // blank until the user manually re-syncs.
        const map: Record<string, SyncRow> = {};
        for (const r of (j.sync ?? []) as SyncRow[]) map[r.id] = r;
        setSyncMap(map);
        setSyncedAt(j.syncedAt ?? null);
      }
    } catch {
      setError('Failed to load tracked positions');
    }
  }, []);

  // Deferred by a task so the first setState doesn't cascade a render during
  // mount (matches the pattern in lib/useLiveTickerPoll.ts).
  useEffect(() => {
    const t = setTimeout(() => { loadScan(); loadTracked(); }, 0);
    return () => clearTimeout(t);
  }, [loadScan, loadTracked]);

  // Always polling, not only after *this* tab starts a scan — a scan launched
  // from another tab, a rerun, or the CLI would otherwise stay invisible here
  // until a manual reload. Idles at 10s and tightens to 3s while one is live,
  // so watching costs almost nothing (the endpoint reads one small JSON and a
  // PID check that is itself cached).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const j = await (await fetch('/api/csp-scan/status')).json();
        if (cancelled) return;
        const running = Boolean(j.running);
        setScanStatus(j.status ?? null);
        setScanRunning(running);
        // Falling edge: the scan just ended, so pull the fresh result set in.
        if (wasRunningRef.current && !running) loadScan();
        wasRunningRef.current = running;
      } catch { /* transient — keep polling */ }
      if (!cancelled) timer = setTimeout(tick, wasRunningRef.current ? 3000 : 10000);
    };

    timer = setTimeout(tick, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [loadScan]);

  const startScan = useCallback(async () => {
    setError(null);
    const res = await fetch('/api/csp-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ universe, expiryOffset }),
    });
    const j = await res.json();
    if (j.success) setScanRunning(true);
    else setError(j.error ?? 'Failed to start scan');
  }, [universe, expiryOffset]);

  const stopScan = useCallback(async () => {
    await fetch('/api/csp-scan', { method: 'DELETE' }).catch(() => {});
  }, []);

  const syncSpots = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetchWithTimeout('/api/csp-tracked/sync', SYNC_CLIENT_TIMEOUT_MS, { method: 'POST' });
      const j = await res.json();
      if (!j.success) throw new Error(j.error ?? 'Sync failed');
      const map: Record<string, SyncRow> = {};
      for (const r of (j.rows ?? []) as SyncRow[]) map[r.id] = r;
      setSyncMap(map);
      setSyncedAt(j.asOf ?? null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  const addManual = useCallback(async () => {
    const body = {
      symbol: manual.symbol.trim().toUpperCase(),
      strike: Number(manual.strike),
      expiry: manual.expiry.trim(),
      qty: Number(manual.qty),
      lotSize: Number(manual.lotSize) || 0,
      entrySpot: Number(manual.entrySpot) || 0,
      avgPrice: Number(manual.avgPrice) || 0,
    };
    const res = await fetch('/api/csp-tracked', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json();
    if (j.success) {
      setManual(blankManual);
      setShowManual(false);
      loadTracked();
    } else {
      setError(j.error ?? 'Failed to add');
    }
  }, [manual, loadTracked]);

  const submitSell = useCallback(async () => {
    if (!sell || sell.submitting) return;
    const lots = Number(sell.lots);
    if (!Number.isFinite(lots) || lots <= 0) return;
    setSell({ ...sell, submitting: true });
    setError(null);
    setNotice(null);
    try {
      const res = await fetchWithTimeout('/api/csp-tracked/sell', SELL_CLIENT_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: sell.row.symbol,
          expiry: sell.row.expiry,
          strike: sell.row.strike,
          qty: lots * sell.row.lotSize,
          lotSize: sell.row.lotSize,
          entrySpot: sell.row.ltp,
        }),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error ?? 'Order failed');
      setNotice(j.warning ?? `Sold ${sell.row.symbol} ${sell.row.strike} PE — order ${j.orderId}`);
      setSell(null);
      loadTracked();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSell((s) => (s ? { ...s, submitting: false } : s));
    }
  }, [sell, loadTracked]);

  const reconcile = useCallback(async () => {
    setReconciling(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetchWithTimeout('/api/csp-tracked/reconcile', 90_000, { method: 'POST' });
      const j = await res.json();
      if (!j.success) throw new Error(j.error ?? 'Reconcile failed');
      setUntracked(j.untracked ?? []);
      const changes: string[] = j.changes ?? [];
      setNotice(changes.length > 0
        ? `Reconciled — ${changes.join('; ')}`
        : 'Reconciled — tracked rows already match the broker.');
      loadTracked();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReconciling(false);
    }
  }, [loadTracked]);

  /** Start tracking a short put that exists at the broker but has no row —
   *  the footprint of an order that filled after its route timed out. */
  const adopt = useCallback(async (p: UntrackedPosition) => {
    const res = await fetch('/api/csp-tracked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: p.symbol,
        strike: p.strike,
        expiry: p.expiry,
        qty: Math.abs(p.netQty),
        lotSize: p.lotSize,
        avgPrice: p.avgPrice,
        securityId: p.securityId,
        exchangeSegment: p.exchangeSegment,
        productType: p.productType,
      }),
    });
    const j = await res.json();
    if (j.success) {
      setUntracked((rows) => rows.filter((r) => r.securityId !== p.securityId));
      loadTracked();
    } else {
      setError(j.error ?? 'Failed to adopt position');
    }
  }, [loadTracked]);

  const removeTracked = useCallback(async (row: TrackedRow) => {
    // Deleting an order-backed OPEN row drops the dashboard's only record of a
    // real short put — the position keeps running, untracked. Worth a prompt.
    if (row.status === 'OPEN' && row.securityId) {
      const ok = window.confirm(
        `${row.symbol} ${row.strike} PE is an OPEN position at the broker.\n\n`
        + 'Removing it only deletes the tracking row — the short put stays live and '
        + 'will no longer appear here. Use Shift to actually close it.\n\nRemove anyway?',
      );
      if (!ok) return;
    }
    await fetch('/api/csp-tracked', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }),
    });
    loadTracked();
  }, [loadTracked]);

  // ── Derived ───────────────────────────────────────────────────────────
  const openRows = useMemo(() => tracked.filter((r) => r.status === 'OPEN'), [tracked]);
  const closedRows = useMemo(() => tracked.filter((r) => r.status !== 'OPEN'), [tracked]);
  const visibleRows = showClosed ? tracked : openRows;
  const needsReconcileCount = useMemo(
    () => openRows.filter((r) => r.needsReconcile || r.reconcileNote).length,
    [openRows],
  );

  const stats = useMemo(() => {
    // A short put wins when it was bought back for less than it was sold for.
    const settled = closedRows.filter((r) => r.realizedPnl !== undefined);
    const wins = settled.filter((r) => (r.realizedPnl ?? 0) > 0).length;
    const winRate = settled.length > 0 ? (wins / settled.length) * 100 : null;

    // Full premium retained if every open put expires worthless.
    const expiryPotential = openRows.reduce((s, r) => s + r.avgPrice * r.qty, 0);

    // A failed mark comes back as peLtp 0, which would otherwise book the full
    // premium as profit. An unconfirmed fill leaves avgPrice 0, which would book
    // the entire current mark as a loss. Neither is a real number, so both are
    // counted as unmarked instead — same guard the per-row cells use.
    const marked = openRows.filter((r) => (syncMap[r.id]?.peLtp ?? 0) > 0 && r.avgPrice > 0);
    const openPnl = marked.reduce((s, r) => s + (r.avgPrice - (syncMap[r.id].peLtp ?? 0)) * r.qty, 0);
    const unmarked = openRows.length - marked.length;

    const realized = settled.reduce((s, r) => s + (r.realizedPnl ?? 0), 0);

    return {
      winRate, expiryPotential, openPnl, currentPnl: openPnl + realized,
      settledCount: settled.length, unmarked,
    };
  }, [openRows, closedRows, syncMap]);

  const scanProgress = scanStatus && scanStatus.total > 0
    ? `${scanStatus.current}/${scanStatus.total}`
    : null;

  // Results scanned before annualised yield existed don't carry it, so derive it
  // rather than silently dropping every row when the filter is on.
  const annYieldOf = (r: ScanRow) =>
    r.annYieldPct ?? (r.dte > 0 ? r.yieldPct * (365 / r.dte) : r.yieldPct);

  // A full sweep takes ~10 minutes, so a row scanned early can be well behind
  // the header's "DATA:" badge (which is stamped once, at sweep completion).
  const scanAgeLabel = (r: ScanRow) => {
    if (!r.scannedAt) return null;
    const ageMin = Math.round((Date.now() - new Date(r.scannedAt).getTime()) / 60000);
    if (ageMin < 1) return 'scanned <1m ago';
    return `scanned ${ageMin}m ago`;
  };

  const visibleScanRows = useMemo(() => {
    const q = symbolFilter.trim().toUpperCase();
    let rows = scanRows.filter((r) =>
      r.noHitProb >= minNoHit && r.noHitProb <= maxNoHit
      && r.yieldPct >= minYield
      && annYieldOf(r) >= minAnnYield
      && r.premiumTotal >= minPremium
      && (!q || r.symbol.includes(q)));
    if (bestPerSymbol) {
      // Highest-scoring surviving strike per symbol — not `isPick`, which is tied
      // to the scan's target and may sit outside the chosen no-hit window.
      const best = new Map<string, ScanRow>();
      for (const r of rows) {
        const cur = best.get(r.symbol);
        if (!cur || r.score > cur.score) best.set(r.symbol, r);
      }
      rows = [...best.values()];
    }
    return rows.sort((a, b) => b.score - a.score);
  }, [scanRows, minNoHit, maxNoHit, minYield, minAnnYield, minPremium, bestPerSymbol, symbolFilter]);

  const distinctSymbols = useMemo(
    () => new Set(visibleScanRows.map((r) => r.symbol)).size,
    [visibleScanRows],
  );
  const skippedCount = useMemo(() => Object.keys(scanSkipped).length, [scanSkipped]);

  return (
    <div className="flex min-h-screen w-full flex-1 flex-col bg-black text-zinc-100">
      <header className="sticky top-0 z-20 flex w-full flex-wrap items-center gap-2.5 border-b border-amber-900/25 bg-zinc-950 px-4 py-2 backdrop-blur-md">
        <div className="mr-1 flex items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-amber-500">
            <Terminal className="h-3.5 w-3.5 text-oncolor-dark" />
          </div>
          <span className="font-mono text-[13px] font-bold uppercase tracking-widest text-amber-400">CSP Screener</span>
        </div>
        <div className="hidden h-5 w-px bg-zinc-800 sm:block" />
        <NavBar />
        {/* Selects the universe for the *next* Rescan — does not affect the
            rows currently on screen, which stay labelled by resultsUniverse. */}
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-[11px]">
          {UNIVERSES.map((u) => (
            <button
              key={u.value}
              onClick={() => setUniverse(u.value)}
              className={cn(
                'rounded px-2.5 py-1 font-semibold transition-all',
                universe === u.value ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {u.label}
            </button>
          ))}
        </div>
        {/* Selects the expiry for the *next* Rescan — same next-scan-vs-loaded
            split as the universe toggle above. */}
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-[11px]">
          {EXPIRY_OFFSETS.map((o) => (
            <button
              key={o.value}
              onClick={() => setExpiryOffset(o.value)}
              title="Nearest expiry at least 5 days out — skips one that's about to expire even if it's still this calendar month"
              className={cn(
                'rounded px-2.5 py-1 font-semibold transition-all',
                expiryOffset === o.value ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        {expiryOffset !== resultsExpiryOffset && (
          <span className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-px font-mono text-[10px] font-bold text-amber-400">
            Rescan to apply
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden rounded-sm border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-zinc-400 md:inline">
            Broker: {BROKER}
          </span>
          <span className="hidden rounded-sm border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-zinc-400 md:inline">
            DATA: {scannedAt ? new Date(scannedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
          </span>
          <button onClick={() => { loadScan(); loadTracked(); }}
            className="flex h-6 w-6 items-center justify-center rounded-sm border border-zinc-800 bg-zinc-900 text-zinc-500 transition-all hover:border-amber-900/40 hover:text-amber-400">
            <RefreshCw className={cn('h-3 w-3', scanLoading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full flex-1 flex-col gap-3 px-3 py-2">
        {error && (
          <div className="rounded-sm border border-red-500/20 bg-red-500/5 px-3 py-1.5 font-mono text-[11px] text-red-400">
            {error}
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 rounded-sm border border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5 font-mono text-[11px] text-emerald-400">
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="text-zinc-500 hover:text-zinc-300">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* ── Scanner ─────────────────────────────────────────────── */}
        <section className="flex flex-col overflow-hidden rounded-sm border border-amber-900/20 bg-zinc-950">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-900 px-3 py-2">
            <h2 className="text-[13px] font-bold text-zinc-100">CSP Candidates</h2>
            <button
              onClick={() => setShowGuide(true)}
              title="How to use this page and choose trade candidates"
              aria-label="How to use this page"
              className="flex h-5 w-5 items-center justify-center rounded-sm border border-zinc-800 bg-zinc-900 text-zinc-500 transition-all hover:border-sky-900/40 hover:text-sky-400"
            >
              <Info className="h-3 w-3" />
            </button>
            <button
              onClick={() => setShowGlossary(true)}
              title="Column definitions — what each figure means and how it is computed"
              aria-label="Column definitions"
              className="flex h-5 w-5 items-center justify-center rounded-sm border border-zinc-800 bg-zinc-900 text-zinc-500 transition-all hover:border-amber-900/40 hover:text-amber-400"
            >
              <BookOpen className="h-3 w-3" />
            </button>
            <span className="font-mono text-[11px] text-zinc-500">
              ({visibleScanRows.length}{visibleScanRows.length !== scanRows.length && ` of ${scanRows.length}`})
            </span>
            <span className="ml-2 text-[11px] text-zinc-500">
              {`${distinctSymbols} symbols${symbolsScanned ? ` of ${symbolsScanned} scanned` : ''} · `}
              {resultsUniverse === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} F&O
              {` · ${EXPIRY_OFFSETS.find((o) => o.value === resultsExpiryOffset)?.label ?? 'Near month'}`}
            </span>
            {universe !== resultsUniverse && (
              <span className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-px font-mono text-[10px] font-bold text-amber-400">
                {`Rescan to load ${universe === 'nifty50' ? 'NIFTY 50' : 'NIFTY 500'}`}
              </span>
            )}
            {skippedCount > 0 && (
              // Without this a symbol dropped by a throttled chain call is
              // indistinguishable from one with no sellable puts, and the scan
              // silently under-reports the universe.
              <span
                title={Object.entries(scanSkipped).map(([s, why]) => `${s}: ${why}`).join('\n')}
                className={cn('cursor-help rounded-sm border px-1.5 py-px font-mono text-[10px] font-bold',
                  apiFailures > 0
                    ? 'border-red-500/30 bg-red-500/10 text-red-400'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400')}
              >
                {apiFailures > 0
                  ? `${skippedCount} skipped · ${apiFailures} API failures`
                  : `${skippedCount} skipped`}
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              {scanRunning && (
                <span className="font-mono text-[11px] font-bold text-amber-400">
                  {scanProgress ? `Scanning ${scanProgress}` : 'Starting…'}
                </span>
              )}
              {/* Without this, a scan that dies on an expired token makes
                  Rescan look like a silent no-op. */}
              {!scanRunning && scanStatus?.error && (
                <span className="max-w-[420px] truncate font-mono text-[11px] text-red-400"
                  title={scanStatus.error}>
                  Scan failed: {scanStatus.error}
                </span>
              )}
              {scanRunning ? (
                <button onClick={stopScan}
                  className="flex items-center gap-1 rounded-sm border border-red-500/30 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-red-400">
                  <Square className="h-3 w-3" /> Stop
                </button>
              ) : (
                <button onClick={startScan}
                  className="flex items-center gap-1 rounded-sm bg-amber-500 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-oncolor-dark">
                  <Play className="h-3 w-3" /> Rescan
                </button>
              )}
            </div>
          </div>

          {/* A full sweep takes ~10 minutes and the results file is only written
              at the end, so without this the page looks frozen on stale rows. */}
          {scanRunning && (
            <div className="flex flex-col gap-1.5 border-b border-amber-900/30 bg-amber-500/5 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <RefreshCw className="h-3 w-3 animate-spin text-amber-400" />
                <span className="font-bold uppercase tracking-wide text-amber-400">Scan in progress</span>
                {scanStatus && scanStatus.total > 0 && (
                  <span className="font-mono text-zinc-300">
                    {scanStatus.current} / {scanStatus.total} symbols
                    <span className="ml-1 text-zinc-500">
                      ({Math.round((scanStatus.current / scanStatus.total) * 100)}%)
                    </span>
                  </span>
                )}
                {scanStatus?.message && (
                  <span className="truncate font-mono text-zinc-500">· {scanStatus.message}</span>
                )}
                <span className="ml-auto font-mono text-[10px] text-zinc-500">
                  results replace the table when the scan finishes
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-amber-500 transition-all duration-500"
                  style={{
                    width: scanStatus && scanStatus.total > 0
                      ? `${Math.min(100, (scanStatus.current / scanStatus.total) * 100)}%`
                      : '0%',
                  }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-900 bg-zinc-950/60 px-3 py-2 text-[11px]">
            <span className="font-bold uppercase tracking-wide text-zinc-500">No-hit %</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number" min={0} max={100} value={minNoHit}
                onChange={(e) => setMinNoHit(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                className="w-16 rounded-sm border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono"
              />
              <span className="text-zinc-600">to</span>
              <input
                type="number" min={0} max={100} value={maxNoHit}
                onChange={(e) => setMaxNoHit(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                className="w-16 rounded-sm border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono"
              />
            </div>
            <input
              type="range" min={0} max={100} step={1} value={minNoHit}
              onChange={(e) => setMinNoHit(Number(e.target.value))}
              className="w-40 accent-amber-500"
              aria-label="Minimum no-hit probability"
            />
            <div className="flex items-center gap-1.5">
              {[40, 60, 65, 70, 80, 90].map((v) => (
                <button
                  key={v}
                  onClick={() => { setMinNoHit(v); setMaxNoHit(100); }}
                  className={cn('rounded-sm border px-1.5 py-0.5 font-mono',
                    minNoHit === v && maxNoHit === 100
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
                      : 'border-zinc-800 text-zinc-400 hover:text-zinc-200')}
                >
                  ≥{v}
                </button>
              ))}
            </div>
            <span className="ml-1 h-4 w-px bg-zinc-800" />

            <span className="font-bold uppercase tracking-wide text-zinc-500">Min yield</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number" min={0} step={0.05} value={minYield}
                onChange={(e) => setMinYield(Math.max(0, Number(e.target.value) || 0))}
                className="w-16 rounded-sm border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono"
                title="Minimum premium as % of strike"
              />
              <span className="text-zinc-600">%</span>
            </div>

            <span className="font-bold uppercase tracking-wide text-zinc-500">Min ann.</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number" min={0} step={1} value={minAnnYield}
                onChange={(e) => setMinAnnYield(Math.max(0, Number(e.target.value) || 0))}
                className="w-16 rounded-sm border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono"
                title="Minimum simple annualised return"
              />
              <span className="text-zinc-600">%</span>
            </div>
            <div className="flex items-center gap-1.5">
              {[0, 10, 15, 25].map((v) => (
                <button
                  key={v}
                  onClick={() => setMinAnnYield(v)}
                  className={cn('rounded-sm border px-1.5 py-0.5 font-mono',
                    minAnnYield === v
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
                      : 'border-zinc-800 text-zinc-400 hover:text-zinc-200')}
                >
                  {v === 0 ? 'any' : `≥${v}%`}
                </button>
              ))}
            </div>

            <span className="font-bold uppercase tracking-wide text-zinc-500">Min prem ₹</span>
            <input
              type="number" min={0} step={500} value={minPremium}
              onChange={(e) => setMinPremium(Math.max(0, Number(e.target.value) || 0))}
              className="w-20 rounded-sm border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono"
              title="Minimum total premium per lot-set"
            />

            <span className="ml-1 h-4 w-px bg-zinc-800" />

            <label className="flex cursor-pointer items-center gap-1.5 text-zinc-300">
              <input
                type="checkbox" checked={bestPerSymbol}
                onChange={(e) => setBestPerSymbol(e.target.checked)}
                className="accent-amber-500"
              />
              Best per symbol
            </label>
            <input
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              placeholder="Filter symbol…"
              className="w-32 rounded-sm border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono"
            />
          </div>

          <div className="max-h-[46vh] overflow-auto">
            <table className="w-full border-collapse">
              <thead>
                {/* Header text doubles as the tooltip key, so a renamed column
                    loses its tooltip rather than showing the wrong one. */}
                <tr>
                  <ScanTH>Symbol</ScanTH>
                  <ScanTH right>Score</ScanTH>
                  <ScanTH right>LTP</ScanTH>
                  <ScanTH>Expiry</ScanTH>
                  <ScanTH right>DTE</ScanTH>
                  <ScanTH right>1D</ScanTH>
                  <ScanTH right>5D</ScanTH>
                  <ScanTH>Suggested Strike</ScanTH>
                  <ScanTH right>Yield</ScanTH>
                  <ScanTH right>Ann.</ScanTH>
                  <ScanTH right>Premium</ScanTH>
                  <ScanTH right>No-hit</ScanTH>
                  <ScanTH right>Touch</ScanTH>
                  <ScanTH right>Capital Req.</ScanTH>
                  <ScanTH>Rationale</ScanTH>
                  <ScanTH>Trade</ScanTH>
                </tr>
              </thead>
              <tbody>
                {visibleScanRows.length === 0 && (
                  <tr><td colSpan={16} className="py-6 text-center text-[11px] text-zinc-600">
                    {scanLoading ? 'Loading…'
                      : scanRunning ? 'Scan in progress — results appear when it finishes.'
                        : scanRows.length > 0
                          ? `No strike matches ${minNoHit}–${maxNoHit}% no-hit at ≥${minYield}% yield`
                            + `${minAnnYield ? ` / ≥${minAnnYield}% ann.` : ''} — loosen the filters.`
                          : 'No scan results yet — click Rescan.'}
                  </td></tr>
                )}
                {visibleScanRows.map((r) => (
                  // Multiple strikes per symbol now, so the key must include one.
                  <tr key={`${r.symbol}-${r.strike}`} className="border-b border-zinc-900/80 hover:bg-zinc-900/40">
                    <TD className="font-bold text-zinc-100" title={scanAgeLabel(r) ?? undefined}>{r.symbol}</TD>
                    <TD right><ScoreBadge v={r.score} /></TD>
                    <TD right className="text-zinc-200">{fmt(r.ltp)}</TD>
                    <TD className="text-zinc-400">{r.expiry}</TD>
                    <TD right className="text-zinc-400">{r.dte}</TD>
                    <TD right>
                      <div className="flex items-center justify-end gap-1">
                        <PctText v={r.move1d} />
                        {r.historyStale && (
                          <span
                            className="text-amber-500"
                            title="Daily history CSV hasn't refreshed recently — 1D/5D may be stale"
                          >
                            *
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD right><PctText v={r.move5d} /></TD>
                    <TD>
                      <div className="flex flex-col">
                        <span className="font-bold text-sky-400">{r.strike} PE</span>
                        <span className="text-[10px] text-zinc-500">{r.noHitProb.toFixed(0)}% safe · lot {r.lotSize}</span>
                      </div>
                    </TD>
                    <TD right className="text-zinc-200">{r.yieldPct.toFixed(2)}%</TD>
                    {/* Same fallback the filter uses, so a pre-annualised scan
                        can't show "—" in a column it is being filtered on. */}
                    <TD right className="font-bold text-amber-400">{annYieldOf(r).toFixed(0)}%</TD>
                    <TD right>
                      <div className="flex flex-col items-end">
                        <span className="font-bold text-emerald-400">₹{fmtInr(r.premiumTotal)}</span>
                        <span className="text-[10px] text-zinc-500">₹{r.premium.toFixed(1)}/sh</span>
                      </div>
                    </TD>
                    <TD right className="text-zinc-200">{r.noHitProb.toFixed(1)}%</TD>
                    <TD right className="text-rose-400"
                      title="Chance spot dips to/below the strike before expiry">
                      {r.touchProb !== undefined ? `${r.touchProb.toFixed(1)}%` : '—'}
                    </TD>
                    <TD right>
                      <div className="flex flex-col items-end">
                        <span className="text-zinc-200">₹{fmtInr(r.capitalRequired)}</span>
                        <span className="text-[10px] text-zinc-500">{r.strike} × {r.lotSize}</span>
                      </div>
                    </TD>
                    <TD className="max-w-[280px] whitespace-normal text-[11px] text-zinc-400">{r.rationale}</TD>
                    <TD>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setSell({ row: r, lots: '1', submitting: false })}
                          disabled={!r.lotSize}
                          className="rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40"
                        >
                          Sell
                        </button>
                        {/* Buying the put is the opposite of a cash-secured put —
                            shown for parity with the sell action but intentionally
                            inert, so a mis-click can't open a long-premium trade. */}
                        <button
                          disabled
                          title="CSPs are sold, not bought"
                          className="cursor-not-allowed rounded-sm border border-zinc-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-600"
                        >
                          Buy
                        </button>
                      </div>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Tracked ─────────────────────────────────────────────── */}
        <section className="flex flex-col overflow-hidden rounded-sm border border-amber-900/20 bg-zinc-950">
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-900 px-3 py-2">
            <h2 className="text-[13px] font-bold text-zinc-100">
              Tracked Cash Secured Puts <span className="font-mono text-zinc-500">({visibleRows.length})</span>
            </h2>

            <div className="ml-auto flex flex-wrap items-center gap-4">
              <Stat label="Win Rate" value={stats.winRate === null ? '—' : `${stats.winRate.toFixed(1)}%`} sub={`${stats.settledCount} settled`} />
              <Stat label="Expiry Potential" value={`${fmtCompactInr(stats.expiryPotential)}`} />
              <Stat label="Current P&L" value={`${stats.currentPnl >= 0 ? '+' : ''}${fmtInr(stats.currentPnl)}`} tone={stats.currentPnl}
                sub={stats.unmarked > 0 ? `${stats.unmarked} unmarked` : undefined} />
              <Stat label="Open P&L" value={`${stats.openPnl >= 0 ? '+' : ''}${fmtInr(stats.openPnl)}`} tone={stats.openPnl}
                sub={stats.unmarked > 0 ? `${stats.unmarked} unmarked` : undefined} />

              <button onClick={() => setShowManual((v) => !v)}
                className="flex items-center gap-1 text-[11px] font-bold text-sky-400 hover:text-sky-300">
                <Plus className="h-3 w-3" /> Track manually
              </button>
              <button onClick={syncSpots} disabled={syncing}
                className="text-[11px] font-bold text-sky-400 hover:text-sky-300 disabled:opacity-40"
                title={syncedAt ? `Last synced ${new Date(syncedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'Never synced'}>
                {syncing ? 'Syncing…' : 'Sync entry spots'}
              </button>
              <button onClick={reconcile} disabled={reconciling}
                className={cn('text-[11px] font-bold hover:text-amber-300 disabled:opacity-40',
                  needsReconcileCount > 0 ? 'text-amber-400' : 'text-sky-400')}
                title="Sync qty/price from the broker; find untracked puts">
                {reconciling ? 'Reconciling…'
                  : needsReconcileCount > 0 ? `Reconcile (${needsReconcileCount})` : 'Reconcile'}
              </button>
              {syncedAt && (
                <span className="font-mono text-[10px] text-zinc-600">
                  marks @ {new Date(syncedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
                </span>
              )}
              <button onClick={loadTracked} className="text-[11px] font-bold text-sky-400 hover:text-sky-300">
                Refresh
              </button>
              <button onClick={() => setShowClosed((v) => !v)}
                className="flex items-center gap-0.5 text-[11px] font-bold text-zinc-400 hover:text-zinc-200">
                {showClosed ? 'Open only' : `Show closed (${closedRows.length})`}
                <ChevronDown className={cn('h-3 w-3 transition-transform', showClosed && 'rotate-180')} />
              </button>
            </div>
          </div>

          {untracked.length > 0 && (
            <div className="flex flex-col gap-2 border-b border-amber-900/30 bg-amber-500/5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-bold uppercase tracking-wide text-amber-400">
                  {untracked.length} short put{untracked.length > 1 ? 's' : ''} at the broker with no tracked row
                </span>
                <span className="text-zinc-400">
                  — typically an order that filled after the page gave up waiting on it.
                </span>
                <button onClick={() => setUntracked([])} className="ml-auto text-zinc-500 hover:text-zinc-300">
                  <X className="h-3 w-3" />
                </button>
              </div>
              {untracked.map((p) => (
                <div key={p.securityId} className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
                  <span className="font-bold text-zinc-100">{p.tradingSymbol || `${p.symbol} ${p.strike} PE`}</span>
                  <span className="text-zinc-400">qty {Math.abs(p.netQty)}</span>
                  <span className="text-zinc-400">avg {fmt(p.avgPrice)}</span>
                  <span className="text-zinc-500">{p.expiry}</span>
                  <button onClick={() => adopt(p)}
                    className="rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400 hover:bg-emerald-500/20">
                    Track it
                  </button>
                </div>
              ))}
            </div>
          )}

          {showManual && (
            <div className="flex flex-wrap items-end gap-2 border-b border-zinc-900 bg-zinc-950 px-3 py-2.5">
              {([
                ['symbol', 'Symbol', 'text'], ['strike', 'Strike', 'number'], ['expiry', 'Expiry (YYYY-MM-DD)', 'text'],
                ['qty', 'Qty', 'number'], ['lotSize', 'Lot size', 'number'],
                ['entrySpot', 'Entry spot', 'number'], ['avgPrice', 'Avg price', 'number'],
              ] as const).map(([key, label, type]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
                  <input
                    type={type}
                    value={manual[key]}
                    onChange={(e) => setManual((m) => ({ ...m, [key]: e.target.value }))}
                    className="w-28 rounded-sm border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono text-[12px]"
                  />
                </label>
              ))}
              <button onClick={addManual}
                className="rounded-sm bg-amber-500 px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide text-oncolor-dark">
                Add
              </button>
              <button onClick={() => { setShowManual(false); setManual(blankManual); }}
                className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300">
                Cancel
              </button>
            </div>
          )}

          <div className="max-h-[46vh] overflow-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <TrackTH>Symbol</TrackTH>
                  <TrackTH right>Strike</TrackTH>
                  <TrackTH>Expiry</TrackTH>
                  <TrackTH>Date</TrackTH>
                  <TrackTH right>LTP</TrackTH>
                  <TrackTH right>Entry Spot</TrackTH>
                  <TrackTH right>To Strike</TrackTH>
                  <TrackTH right>No-hit</TrackTH>
                  <TrackTH right>Qty</TrackTH>
                  <TrackTH right>Avg</TrackTH>
                  <TrackTH right>PE LTP</TrackTH>
                  <TrackTH>Visual Status</TrackTH>
                  <TrackTH right label="Current P&L">Current P&amp;L</TrackTH>
                  <TrackTH>Status</TrackTH>
                  <TrackTH>Order ID</TrackTH>
                  <TrackTH>Actions</TrackTH>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 && (
                  <tr><td colSpan={19} className="py-6 text-center text-[11px] text-zinc-600">
                    No tracked positions — add one with &quot;Track manually&quot;.
                  </td></tr>
                )}
                {visibleRows.map((r) => {
                  const s = syncMap[r.id];
                  const spot = s?.spot ?? 0;
                  const peLtp = s?.peLtp ?? 0;
                  const pnl = peLtp > 0 && r.avgPrice > 0
                    ? (r.avgPrice - peLtp) * r.qty
                    : (r.realizedPnl ?? null);
                  const spotDrift = spot > 0 && r.entrySpot > 0 ? ((spot - r.entrySpot) / r.entrySpot) * 100 : null;
                  const toStrike = spot > 0 ? ((spot - r.strike) / spot) * 100 : null;

                  return (
                    <tr key={r.id} className="border-b border-zinc-900/80 hover:bg-zinc-900/40">
                      <TD className="font-bold text-zinc-100">
                        <div className="flex items-center gap-1">
                          {r.symbol}
                          {/* A row that could not be priced would otherwise read
                              as a flat position rather than an unknown one. */}
                          {s?.error && (
                            <span title={s.error} className="cursor-help text-[10px] font-normal text-amber-400">⚠</span>
                          )}
                          {/* An unconfirmed fill or a broker/row mismatch: the
                              numbers on this line are requests, not facts. */}
                          {(r.needsReconcile || r.reconcileNote) && (
                            <span
                              title={r.reconcileNote
                                ?? 'Fill was never confirmed — quantity and average price are the requested ones. Click Reconcile.'}
                              className="cursor-help rounded-sm bg-amber-500/15 px-1 text-[9px] font-bold uppercase text-amber-400">
                              unconfirmed
                            </span>
                          )}
                        </div>
                      </TD>
                      <TD right className="font-bold text-sky-400">{r.strike}</TD>
                      <TD className="text-zinc-400">{r.expiry}</TD>
                      <TD className="text-zinc-500">{r.entryDate}</TD>
                      <TD right className="text-zinc-200">{spot > 0 ? fmt(spot) : '—'}</TD>
                      <TD right>
                        <div className="flex flex-col items-end">
                          <span className="text-zinc-200">{r.entrySpot > 0 ? fmt(r.entrySpot) : '—'}</span>
                          {spotDrift !== null && <span className="text-[10px]"><PctText v={spotDrift} /></span>}
                        </div>
                      </TD>
                      <TD right>{toStrike === null ? <span className="text-zinc-600">—</span> : <PctText v={toStrike} />}</TD>
                      <TD right className="text-zinc-200">
                        {s?.noHitProb !== undefined ? `${s.noHitProb.toFixed(1)}%` : <span className="text-zinc-600">—</span>}
                      </TD>
                      <TD right className="text-zinc-300">{r.qty}</TD>
                      <TD right className="text-zinc-300">{fmt(r.avgPrice)}</TD>
                      <TD right className="text-zinc-200">{peLtp > 0 ? fmt(peLtp) : '—'}</TD>
                      <TD><VisualStatus spot={spot} strike={r.strike} entrySpot={r.entrySpot} /></TD>
                      <TD right>
                        {pnl === null ? <span className="text-zinc-600">—</span> : (
                          <span className={cn('font-bold tabular-nums', pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-zinc-400')}>
                            {pnl > 0 ? '+' : ''}{fmtInr(pnl)}
                          </span>
                        )}
                      </TD>
                      <TD>
                        <span className={cn('rounded-sm px-1.5 py-px text-[10px] font-bold uppercase',
                          r.status === 'OPEN' ? 'bg-emerald-500/10 text-emerald-400'
                            : r.status === 'ROLLED' ? 'bg-sky-500/10 text-sky-400'
                              : 'bg-zinc-800 text-zinc-400')}>
                          {r.status}
                        </span>
                      </TD>
                      <TD className="text-[10px] text-zinc-500">{r.orderId ?? 'paper'}</TD>
                      <TD>
                        <div className="flex items-center gap-1.5">
                          {r.status === 'OPEN' && (
                            <button
                              onClick={() => setShiftTarget({
                                id: r.id, symbol: r.symbol, strike: r.strike, expiry: r.expiry,
                                qty: r.qty, lotSize: r.lotSize, spot, peLtp,
                                move1d: null, move5d: null, moveCycle: null,
                                securityId: r.securityId,
                              })}
                              className="rounded-sm border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-400 hover:bg-sky-500/20"
                            >
                              Shift
                            </button>
                          )}
                          <button onClick={() => removeTracked(r)} className="text-zinc-600 hover:text-red-400" aria-label="Remove">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {showGuide && <CspGuide onClose={() => setShowGuide(false)} />}
      {showGlossary && <CspGlossary onClose={() => setShowGlossary(false)} />}

      {sell && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-oncolor-dark/70 p-4 backdrop-blur-sm">
          <div className="mt-24 w-full max-w-md rounded-md border border-rose-500/30 bg-zinc-950 shadow-2xl">
            <div className="border-b border-zinc-800 px-4 py-3">
              <h2 className="text-[15px] font-bold text-zinc-100">Sell Cash Secured Put</h2>
              <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
                {sell.row.symbol} · spot {fmt(sell.row.ltp)} · expiry {sell.row.expiry}
              </p>
            </div>
            <div className="flex flex-col gap-3 px-4 py-4 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="text-zinc-400">Lots</span>
                <input
                  type="number" min={1} value={sell.lots}
                  onChange={(e) => setSell((s) => (s ? { ...s, lots: e.target.value } : s))}
                  className="w-20 rounded-sm border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono"
                />
                <span className="font-mono text-zinc-500">
                  = {(Number(sell.lots) || 0) * sell.row.lotSize} qty ({sell.row.lotSize}/lot)
                </span>
              </div>
              <div className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 font-mono text-[11px] text-amber-300">
                SELL {(Number(sell.lots) || 0) * sell.row.lotSize} qty of {sell.row.symbol} {sell.row.strike} PE at MARKET (MARGIN).
                <div className="mt-1 text-zinc-400">
                  Capital ≈ ₹{fmtInr(sell.row.capitalRequired * (Number(sell.lots) || 0))} ·
                  premium ≈ ₹{fmtInr(sell.row.premiumTotal * (Number(sell.lots) || 0))} ·
                  {sell.row.noHitProb.toFixed(0)}% no-hit
                </div>
              </div>
              <p className="text-[11px] text-zinc-500">
                This places a real order on Dhan and starts tracking the position.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
              <button onClick={() => setSell(null)} disabled={sell.submitting}
                className="rounded-sm border border-zinc-700 px-3 py-1.5 text-[12px] font-bold text-zinc-300 disabled:opacity-40">
                Cancel
              </button>
              <button onClick={submitSell} disabled={sell.submitting || !(Number(sell.lots) > 0)}
                className="rounded-sm bg-rose-600 px-3 py-1.5 text-[12px] font-bold text-oncolor disabled:opacity-40">
                {sell.submitting ? 'Placing…' : 'Confirm Sell'}
              </button>
            </div>
          </div>
        </div>
      )}

      {shiftTarget && (
        <ShiftCspModal
          target={shiftTarget}
          onClose={() => setShiftTarget(null)}
          onComplete={() => { loadTracked(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={cn('font-mono text-[13px] font-bold tabular-nums',
        tone === undefined ? 'text-zinc-100' : tone > 0 ? 'text-emerald-400' : tone < 0 ? 'text-red-400' : 'text-zinc-100')}>
        {value}
      </span>
      {sub && <span className="text-[9px] text-zinc-600">{sub}</span>}
    </div>
  );
}
