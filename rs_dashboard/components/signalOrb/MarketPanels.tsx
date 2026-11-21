'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import TopIndices from '@/components/TopIndices';
import type { Signal } from '@/lib/signalOrb';
import type { ContributionResult } from '@/lib/niftyContribution';
import { oiAgreement, oiSide, oiSummary, type OiPoint } from '@/lib/signalOrbPanels';

// Market context for the Signal Orb: the live indices, the Nifty contribution list (shared with the Nifty Contribution page) and the cumulative-OI regime.
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

// ── Feeds and the Nifty contribution ─────────────────────────────────────────────────────────────────────────────────────

type FeedState = 'live' | 'starting' | 'stale' | 'stopped';
type ContribReply = {
  success: boolean; error?: string;
  feeds?: { stocks: { state: FeedState }; indices: { state: FeedState } };
  nifty?: { ltp: number; change: number; changePct: number } | null;
  result?: ContributionResult;
};

/** The Nifty Contribution page's own API (all 50 names, free-float weighted, with its stale-weights alarm); polled while the Market tab is mounted. */
function useContribution() {
  const [reply, setReply] = useState<ContribReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const r = await fetch('/api/nifty-contribution', { cache: 'no-store' });
      const j = await r.json() as ContribReply;
      setReply(j); setError(j.success ? null : (j.error ?? 'Contribution unavailable'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Contribution unavailable'); }
  };
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, 3_000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);
  return { reply, error, reload: load };
}

/** Starts the read-only bridges the panels need (indices; and the stocks feed for the contribution); both routes are idempotent. */
function FeedBar({ feeds, stocks, onStarted }: { feeds: ContribReply['feeds']; stocks: boolean; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const needed: FeedState[] = [feeds?.indices.state ?? 'stopped', ...(stocks ? [feeds?.stocks.state ?? 'stopped'] : [])];
  const live = needed.every(s => s === 'live' || s === 'starting');
  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      const routes = ['/api/live-indices', ...(stocks ? ['/api/daily-market'] : [])];
      await Promise.all(routes.map(u => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) })));
      setMsg('Feeds starting - quotes appear in a few seconds');
      setTimeout(onStarted, 2_000);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not start the feeds'); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-[11px]">
      <span className="flex items-center gap-1.5 font-mono text-zinc-400">
        <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden />
        {msg ?? (live ? 'Live feeds running' : 'Live feeds off or stale')}
      </span>
      {!live && (
        <button type="button" onClick={() => void start()} disabled={busy}
          className={cn('rounded border border-zinc-700 px-2 py-0.5 font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50', FOCUS)}>
          {busy ? 'Starting…' : 'Start feeds'}
        </button>
      )}
    </div>
  );
}

const CONCENTRATION: Record<'narrow' | 'moderate' | 'broad', { label: string; cls: string; hint: string }> = {
  narrow: { label: 'Narrow', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300', hint: 'A few heavyweights carry the move - such rallies and falls tend not to hold.' },
  moderate: { label: 'Moderate', cls: 'border-zinc-700 bg-zinc-900 text-zinc-300', hint: 'The move is shared by a fair number of stocks.' },
  broad: { label: 'Broad', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', hint: 'Many stocks are moving the index the same way.' },
};

/** How many index points each Nifty 50 stock adds or takes: the net, whether the move is narrow or broad, and the top pullers and draggers. */
function ContributionCard({ reply, error }: { reply: ContribReply | null; error: string | null }) {
  const res = reply?.result;
  if (error && !res) return <Card title="Nifty contribution"><p className="text-[11px] text-zinc-400">{error}</p></Card>;
  if (!res || !res.rows.length) return <Card title="Nifty contribution"><p className="text-[11px] text-zinc-500">{reply ? 'No priced stocks yet - start the feeds.' : 'Loading…'}</p></Card>;
  if (res.rows.every(r => r.points === 0)) return <Card title="Nifty contribution" note={reply?.feeds ? `stocks ${reply.feeds.stocks.state}` : undefined}><p className="text-[11px] text-zinc-500">No price movement against the previous close yet (market closed or before the open).</p></Card>;
  const conc = res.concentration ? CONCENTRATION[res.concentration] : null;
  // the index-vs-stocks gap only means something while both feeds tick: a feed that is starting or stale shows a zero index move
  const live = reply?.feeds?.stocks.state === 'live' && reply?.feeds?.indices.state === 'live';
  const tone = res.net > 0 ? 'text-emerald-400' : res.net < 0 ? 'text-red-400' : 'text-zinc-300';
  const col = (rows: ContributionResult['rows'], good: boolean) => rows.slice(0, 5).map(r => (
    <li key={r.symbol} className="flex items-center justify-between gap-2">
      <span className="truncate text-zinc-400" title={`${r.name} ${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%`}>{r.symbol}</span>
      <span className={cn('tabular-nums', good ? 'text-emerald-400' : 'text-red-400')}>{signed(r.points)}</span>
    </li>
  ));
  return (
    <Card title="Nifty contribution" note={reply?.feeds ? `stocks ${reply.feeds.stocks.state}` : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono"><strong className={cn('text-base', tone)}>{signed(res.net)} pts</strong><span className="ml-2 text-[11px] text-zinc-500">from {res.rows.length} stocks</span></p>
        {conc && <span className={cn('rounded border px-1.5 text-[9px] font-black uppercase', conc.cls)} title={conc.hint}>{conc.label}</span>}
      </div>
      {reply?.nifty && (
        <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
          Nifty {signed(reply.nifty.change)} ({signed(reply.nifty.changePct, 2)}%)
          {live && res.residual !== null && <span className={res.residualFlag ? ' text-amber-400' : ''}> · gap {signed(res.residual)}</span>}
        </p>
      )}
      {!live && <p className="mt-1 text-[10px] text-zinc-500">Feeds are not both live yet: these numbers are the last snapshot.</p>}
      {live && res.residualFlag && <p className="mt-1 text-[10px] text-amber-400">The stock total and the index disagree by more than usual - the weights may be out of date after a rebalance.</p>}
      <div className="mt-2 grid grid-cols-2 gap-3 font-mono text-[11px]">
        <div><p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-600">Pulling up</p><ul className="flex flex-col gap-0.5">{col(res.pullers, true)}</ul></div>
        <div><p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-600">Dragging down</p><ul className="flex flex-col gap-0.5">{col(res.draggers, false)}</ul></div>
      </div>
      {res.missing.length > 0 && <p className="mt-1.5 text-[10px] text-zinc-600">{res.missing.length} name{res.missing.length > 1 ? 's' : ''} without a price are held at their last weight.</p>}
      <Link href="/nifty-contribution" target="_blank" rel="noreferrer" className={cn('mt-2 block text-center text-[11px] font-bold text-zinc-400 hover:text-zinc-200', FOCUS)}>Open the full contribution page ↗</Link>
    </Card>
  );
}

/** Indices (NIFTY and crude both) and, for NIFTY, the contribution list (the Nifty Contribution page's own data). */
export function MarketTab({ symbol }: { symbol: string }) {
  const nifty = symbol === 'NIFTY';
  const c = useContribution();
  return (
    <div className="flex flex-col gap-3">
      <FeedBar feeds={c.reply?.feeds} stocks={nifty} onStarted={c.reload} />
      <TopIndices />
      {nifty && <ContributionCard reply={c.reply} error={c.error} />}
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
