'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';
import TopIndices from '@/components/TopIndices';
import TopWeightStocks from '@/components/TopWeightStocks';
import { NIFTY_TOP10_BY_WEIGHT } from '@/lib/nifty50';
import type { Signal } from '@/lib/signalOrb';
import { heavyweightPull, oiAgreement, oiSide, oiSummary, type EquityQuote, type OiPoint } from '@/lib/signalOrbPanels';

// Market context for the Signal Orb: the live indices, the Nifty heavyweights and what they add up to, and the cumulative-OI regime.
// Information only - none of it feeds a rule or an order. The tables are the Advanced Scalper's own panels; the bridges that feed
// them are started from here only when the user presses Start.

const CumulativeOIModal = dynamic(() => import('@/components/CumulativeOIModal'), { ssr: false });

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const sigTone = (s: Signal) => (s === 'BULL' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : s === 'BEAR' ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-400');
const signed = (n: number, dp = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}`;
const fmtOI = (n: number) => {
  const a = Math.abs(n);
  return a >= 10_000_000 ? `${(n / 10_000_000).toFixed(2)}Cr` : a >= 100_000 ? `${(n / 100_000).toFixed(1)}L` : n.toLocaleString('en-IN');
};

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 backdrop-blur">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">{title}</h2>
        {note && <span className="font-mono text-[10px] text-zinc-600">{note}</span>}
      </div>
      {children}
    </section>
  );
}

// ── Feeds ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type EquityReply = { status?: { status?: string }; quotes?: { updated_at: string | null; quotes: Record<string, EquityQuote> } };
const FEED_STALE_MS = 30_000;

/** The equity bridge's quotes (the heavyweights) and how fresh they are; polled only while the Market tab is mounted. */
function useEquityFeed() {
  const [reply, setReply] = useState<EquityReply | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/live-equity', { cache: 'no-store' });
        const j = await r.json() as EquityReply;
        if (alive) setReply(j);
      } catch { /* the next poll retries */ }
    };
    const first = setTimeout(() => { setNow(Date.now()); void load(); }, 0);
    const id = setInterval(() => { setNow(Date.now()); void load(); }, 3_000);
    return () => { alive = false; clearTimeout(first); clearInterval(id); };
  }, []);
  const at = reply?.quotes?.updated_at ? new Date(reply.quotes.updated_at).getTime() : NaN;
  const fresh = Number.isFinite(at) && now - at < FEED_STALE_MS;
  return { quotes: reply?.quotes?.quotes ?? {}, fresh, loaded: reply !== null };
}

/** Starts the two read-only bridges (indices, Nifty 50 equities); both routes are idempotent ("already running"). */
function FeedBar({ fresh, equity }: { fresh: boolean; equity: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      const calls = ['/api/live-indices', ...(equity ? ['/api/live-equity'] : [])].map(u => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }));
      await Promise.all(calls);
      setMsg('Feeds starting - quotes appear in a few seconds');
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not start the feeds'); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-[11px]">
      <span className="flex items-center gap-1.5 font-mono text-zinc-400">
        <span className={cn('h-1.5 w-1.5 rounded-full', fresh ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden />
        {msg ?? (fresh ? 'Live feeds running' : 'Live feeds off or stale')}
      </span>
      {!fresh && (
        <button type="button" onClick={() => void start()} disabled={busy}
          className={cn('rounded border border-zinc-700 px-2 py-0.5 font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50', FOCUS)}>
          {busy ? 'Starting…' : 'Start feeds'}
        </button>
      )}
    </div>
  );
}

/** What the ten heaviest names add up to in index points, and how many are up. */
function PullCard({ quotes, level, fresh }: { quotes: Record<string, EquityQuote>; level: number | null; fresh: boolean }) {
  const p = useMemo(() => heavyweightPull(NIFTY_TOP10_BY_WEIGHT, quotes, level), [quotes, level]);
  if (!p) return <Card title="Heavyweight pull"><p className="text-[11px] text-zinc-500">Waiting for the equity quotes…</p></Card>;
  const tone = p.pts > 0 ? 'text-emerald-400' : p.pts < 0 ? 'text-red-400' : 'text-zinc-300';
  const top = p.rows.slice(0, 3);
  return (
    <Card title="Heavyweight pull" note={`${fresh ? '' : 'STALE · '}${p.covered.toFixed(0)}% of the index`}>
      <p className="font-mono text-sm">
        <strong className={cn('text-base', tone)}>{signed(p.pts)} pts</strong>
        <span className="ml-2 text-[11px] text-zinc-500">{p.up} up · {p.down} down of {p.rows.length}</span>
      </p>
      <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px]">
        {top.map(r => (
          <li key={r.symbol} className="flex items-center justify-between">
            <span className="text-zinc-400">{r.name} <span className="text-zinc-600">{r.weight.toFixed(1)}%</span></span>
            <span className={r.pts >= 0 ? 'text-emerald-400' : 'text-red-400'}>{signed(r.pts)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10px] text-zinc-600">Weight × % change × index level, from the live equity feed. A few names moving the index is a narrower move than many.</p>
    </Card>
  );
}

/** Indices (NIFTY and crude both), and for NIFTY the heavyweights: the Advanced Scalper's tables plus the pull summary. */
export function MarketTab({ symbol, price }: { symbol: string; price: number | null }) {
  const nifty = symbol === 'NIFTY';
  const feed = useEquityFeed();
  return (
    <div className="flex flex-col gap-3">
      <FeedBar fresh={nifty ? feed.fresh : true} equity={nifty} />
      <TopIndices />
      {nifty && (
        <>
          <PullCard quotes={feed.quotes} level={price} fresh={feed.fresh} />
          <TopWeightStocks />
        </>
      )}
    </div>
  );
}

// ── Cumulative OI ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type OiReply = {
  success: boolean; error?: string; date?: string; atm?: number; expiry?: string;
  data?: (OiPoint & { diff?: number })[];
  regime?: { label: string; confirmed: boolean; confidence: number; confidenceLabel: string; reason: string; warmingUp: boolean; confirmationState: string };
};

/** The OI regime and the call / put picture from the cumulative-OI tool's own API, with whether it backs the orb. */
export function OiTab({ symbol, signal }: { symbol: string; signal: Signal }) {
  const underlying = symbol === 'NIFTY' ? 'NIFTY' : 'CRUDEOIL';
  const [reply, setReply] = useState<OiReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    let alive = true;
    setReply(null); setError(null);
    const load = async () => {
      try {
        const r = await fetch(`/api/options/iv-history?mode=cumulative&underlying=${underlying}&wings=10`, { cache: 'no-store' });
        const j = await r.json() as OiReply;
        if (!alive) return;
        if (j.success) { setReply(j); setError(null); } else { setReply(null); setError(j.error ?? 'No OI data collected yet today'); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Could not load the OI data'); }
    };
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, 15_000);
    return () => { alive = false; clearTimeout(first); clearInterval(id); };
  }, [underlying]);

  const pts = reply?.data ?? [];
  const sum = useMemo(() => oiSummary(pts), [pts]);
  const regime = reply?.regime;
  const side = oiSide(regime?.label, regime?.confirmed);
  const agree = oiAgreement(signal, side);
  // the call-put OI gap through the day (put OI minus call OI: rising = puts building = supportive), as a sparkline
  const spark = useMemo(() => {
    if (pts.length < 2) return null;
    const v = pts.map(p => p.peOI - p.ceOI);
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    return v.map((y, i) => `${(i / (v.length - 1)) * 100},${20 - ((y - lo) / span) * 20}`).join(' ');
  }, [pts]);

  if (error && !reply) {
    return (
      <Card title="Cumulative OI"><p className="text-[11px] text-zinc-400">{error}</p>
        {underlying === 'CRUDEOIL' && <p className="mt-1 text-[10px] text-zinc-600">Crude OI comes from its collector; start it from the crude options page.</p>}
      </Card>
    );
  }
  if (!reply || !sum) return <Card title="Cumulative OI"><p className="text-[11px] text-zinc-500">Loading…</p></Card>;
  const labelTone = regime?.label.includes('Bullish') ? 'text-emerald-400' : regime?.label.includes('Bearish') ? 'text-red-400' : 'text-zinc-300';
  return (
    <div className="flex flex-col gap-3">
      <Card title="OI regime" note={`${underlying} · ATM ${reply.atm ?? '—'} · ${reply.expiry ?? ''}`}>
        {regime ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className={cn('text-base font-bold', labelTone)}>{regime.label}</span>
              <span className="font-mono text-[10px] text-zinc-500">{regime.warmingUp ? 'warming up' : `${regime.confirmed ? 'confirmed' : 'pending'} · ${regime.confidenceLabel} confidence`}</span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">{regime.reason}</p>
            <p className="mt-2 flex items-center gap-2 text-[11px]">
              <span className="text-zinc-500">Orb</span>
              <span className={cn('rounded border px-1.5 text-[9px] font-black', sigTone(signal))}>{signal === 'NEUTRAL' ? 'FLAT' : signal}</span>
              <span className={cn('font-bold', agree === 'agree' ? 'text-emerald-400' : agree === 'conflict' ? 'text-amber-400' : 'text-zinc-500')}>
                {agree === 'agree' ? 'OI backs the orb' : agree === 'conflict' ? 'OI disagrees with the orb' : signal === 'NEUTRAL' ? 'orb is flat - nothing to compare' : 'OI has no confirmed side'}
              </span>
            </p>
          </>
        ) : <p className="text-[11px] text-zinc-500">No regime yet today.</p>}
      </Card>
      <Card title="Calls vs puts" note="ATM ±10 strikes">
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 font-mono text-[11px]">
          <dt className="text-zinc-500">Call OI</dt><dd className="text-right tabular-nums text-red-400">{fmtOI(sum.ceOI)}</dd>
          <dd className={cn('w-16 text-right tabular-nums', sum.ceChange >= 0 ? 'text-zinc-300' : 'text-zinc-500')} title="Change since the first point today">{sum.ceChange >= 0 ? '+' : '−'}{fmtOI(Math.abs(sum.ceChange))}</dd>
          <dt className="text-zinc-500">Put OI</dt><dd className="text-right tabular-nums text-emerald-400">{fmtOI(sum.peOI)}</dd>
          <dd className={cn('w-16 text-right tabular-nums', sum.peChange >= 0 ? 'text-zinc-300' : 'text-zinc-500')} title="Change since the first point today">{sum.peChange >= 0 ? '+' : '−'}{fmtOI(Math.abs(sum.peChange))}</dd>
          <dt className="text-zinc-500">PCR (OI)</dt><dd className="text-right tabular-nums text-zinc-100">{sum.pcr === null ? '—' : sum.pcr.toFixed(2)}</dd><dd />
        </dl>
        {spark && (
          <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="mt-2 h-8 w-full" role="img" aria-label="Put minus call open interest through the day">
            <polyline points={spark} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" className="text-sky-400" />
          </svg>
        )}
        <p className="mt-1 text-[10px] text-zinc-600">Line: put OI minus call OI through the day. Rising = puts building.</p>
        {underlying === 'NIFTY' && (
          <button type="button" onClick={() => setModal(true)} className={cn('mt-2 w-full rounded border border-zinc-700 py-1 text-[11px] font-bold text-zinc-300 hover:bg-zinc-800', FOCUS)}>
            Open the full cumulative OI view
          </button>
        )}
      </Card>
      {modal && <CumulativeOIModal onClose={() => setModal(false)} />}
    </div>
  );
}
