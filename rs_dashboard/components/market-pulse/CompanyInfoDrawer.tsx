'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import type { CompanyInfo } from '@/lib/dhanAnalytics';

export interface CompanyTarget {
  securityId: string;
  exchangeSegment: 'NSE_EQ' | 'BSE_EQ';
  label: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready'; info: CompanyInfo; stale: boolean };

/** null renders as a dash - never 0 - so a vendor gap cannot read as a real zero. */
function f(v: number | null, dec = 2, suffix = ''): string {
  return v == null ? '–' : `${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: dec })}${suffix}`;
}

function crore(v: number | null): string {
  if (v == null) return '–';
  if (v >= 1_00_000) return `₹${(v / 1_00_000).toFixed(2)} L Cr`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
}

function signed(v: number | null, suffix = ' pp'): { text: string; cls: string } {
  if (v == null) return { text: '–', cls: 'text-zinc-500' };
  const t = `${v > 0 ? '+' : ''}${v.toFixed(2)}${suffix}`;
  return { text: t, cls: v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-300' };
}

function Row({ k, v, vs, cls = 'text-zinc-100' }: { k: string; v: string; vs?: string; cls?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-zinc-800 last:border-b-0">
      <span className="text-[11px] text-zinc-400">{k}</span>
      <span className="text-right">
        <span className={`text-xs font-semibold tabular-nums ${cls}`}>{v}</span>
        {vs && <span className="ml-2 text-[10px] text-zinc-500 tabular-nums">industry {vs}</span>}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400 mb-1">{title}</h3>
      {children}
    </section>
  );
}

export default function CompanyInfoDrawer({ target, onClose }: { target: CompanyTarget | null; onClose: () => void }) {
  // The result is stored WITH the company it belongs to. Reading it for a different target renders 'loading' on the very first frame,
  // so a reopened drawer can never show the previous company's numbers under the new company's header.
  const targetKey = target ? `${target.exchangeSegment}:${target.securityId}` : '';
  const [loaded, setLoaded] = useState<{ key: string; state: State }>({ key: '', state: { kind: 'loading' } });
  const state: State = loaded.key === targetKey ? loaded.state : { kind: 'loading' };
  const seq = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!target) return;
    const counter = seq;
    const mine = ++counter.current;
    const isStale = () => mine !== seq.current;
    const qs = new URLSearchParams({ securityId: target.securityId, exchangeSegment: target.exchangeSegment });
    fetch(`/api/company-info?${qs}`)
      .then(async r => ({ ok: r.ok, j: await r.json().catch(() => null) as Record<string, unknown> | null }))
      .then(({ ok, j }) => {
        if (isStale()) return;
        if (!ok || !j || j.success !== true) { setLoaded({ key: targetKey, state: { kind: 'error', message: String(j?.error ?? 'Request failed') } }); return; }
        const info = j.info as CompanyInfo | null;
        setLoaded({ key: targetKey, state: info ? { kind: 'ready', info, stale: j.stale === true } : { kind: 'empty' } });
      })
      .catch(e => { if (!isStale()) setLoaded({ key: targetKey, state: { kind: 'error', message: e instanceof Error ? e.message : 'Network error' } }); });
    return () => { counter.current++; };
  }, [target, targetKey]);

  useEffect(() => {
    if (!target) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  if (!target) return null;
  const info = state.kind === 'ready' ? state.info : null;
  const ov = info?.overview, ra = info?.ratios, sh = info?.shareholding;
  const fii = signed(sh?.fiiChange ?? null), dii = signed(sh?.diiChange ?? null);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-oncolor-dark/60" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside role="dialog" aria-label={`${target.label} company info`} className="h-full w-full max-w-md overflow-y-auto bg-zinc-950 border-l border-zinc-800 p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Company · {target.exchangeSegment === 'NSE_EQ' ? 'NSE' : 'BSE'} {target.securityId}</p>
            <h2 className="text-sm font-bold text-white leading-tight">{target.label}</h2>
            {ov && (ov.sector || ov.industry) && <p className="text-[11px] text-zinc-400 mt-1">{[ov.sector, ov.industry].filter(Boolean).join(' · ')}</p>}
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {state.kind === 'loading' && (
          <div className="flex flex-col items-center gap-2 py-12">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
            <p className="text-zinc-200 font-semibold text-sm">Loading company info</p>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{state.message}</span>
          </div>
        )}
        {state.kind === 'empty' && <p className="text-sm text-zinc-400 py-8 text-center">Dhan has no company data for this security.</p>}

        {state.kind === 'ready' && (
          <>
            {state.stale && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>Dhan did not answer - showing the last saved snapshot.</span>
              </div>
            )}
            {ov && (
              <Section title="Overview">
                <Row k="Market cap" v={crore(ov.marketCapCr)} />
                <Row k="52-week range" v={ov.low52w != null && ov.high52w != null ? `${f(ov.low52w)} – ${f(ov.high52w)}` : '–'} />
                <Row k="EPS (TTM)" v={f(ov.eps)} vs={ra ? f(ra.industryEps) : undefined} />
                <Row k="Book value / share" v={f(ov.bookValue)} />
                <Row k="EBITDA (TTM)" v={crore(ov.ebitdaCr)} />
                <Row k="Dividend yield" v={f(ov.dividendYield, 2, '%')} vs={ra ? f(ra.industryDividendYield, 2, '%') : undefined} />
              </Section>
            )}
            {ra && (
              <Section title="Valuation & returns">
                <Row k="P/E" v={f(ra.pe)} />
                <Row k="P/E vs sector P/E" v={f(ra.peToSectorPe, 2, '×')} />
                <Row k="P/B" v={f(ra.pb)} vs={f(ra.industryPb)} />
                <Row k="Debt / equity" v={f(ra.debtToEquity)} vs={f(ra.industryDebtToEquity)} />
                <Row k="ROE" v={f(ra.roe, 2, '%')} />
                <Row k="ROCE" v={f(ra.roce, 2, '%')} />
                <Row k="Industry operating margin" v={f(ra.industryOperatingMargin, 2, '%')} />
              </Section>
            )}
            {sh && (
              <Section title={`Shareholding${sh.reportingPeriod ? ` · ${sh.reportingPeriod.slice(0, 4)}-${sh.reportingPeriod.slice(4)}` : ''}`}>
                <Row k="Promoter" v={f(sh.promoter, 2, '%')} />
                <Row k="FII" v={f(sh.fii, 2, '%')} />
                <Row k="FII change (QoQ)" v={fii.text} cls={fii.cls} />
                <Row k="DII" v={f(sh.dii, 2, '%')} />
                <Row k="DII change (QoQ)" v={dii.text} cls={dii.cls} />
                <Row k="Public" v={f(sh.publicHolding, 2, '%')} />
              </Section>
            )}
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              Values are exactly as Dhan returns them. A dash means Dhan sent no value. A 0 is passed through unchanged, but Dhan also
              sends 0 for ratios that do not apply (seen on bank debt/equity and promoter holding), so treat a lone 0 with caution.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
