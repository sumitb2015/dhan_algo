'use client';

import { isTradedStrike } from '@/lib/priceLadder';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X, Table2 } from 'lucide-react';

// The Price Ladder's option-chain window: the chain of the ladder's current underlying + expiry, so a strike can be read
// (OI, OI change, volume, IV, price) and picked without leaving the page. Click a CE or PE price to put the ladder on
// that contract. The chain is Dhan's rate-limited REST call (~1 per 3 s), so it is fetched on open, then every 20 s
// while the window is open and the tab visible; /api/options/chain dedupes and spaces concurrent callers and
// `allowStale` serves the last good chain if Dhan refuses.

interface Side { last_price?: number; oi?: number; previous_oi?: number; volume?: number; implied_volatility?: number; previous_close_price?: number }
interface ChainData { chain?: { oc?: Record<string, { ce?: Side; pe?: Side }> }; spot?: number; future_price?: number }

const POLL_MS = 20_000;
const WINDOWS = [8, 12, 20] as const;

const fmtOi = (n: number | undefined): string => {
  if (!n) return '—';
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
};
const fmtPx = (n: number | undefined): string => (n ? n.toFixed(2) : '—');
const chg = (now: number | undefined, prev: number | undefined): number | null => (now != null && prev ? ((now - prev) / prev) * 100 : null);
const chgCls = (v: number | null) => (v == null ? 'text-zinc-600' : v >= 0 ? 'text-emerald-400' : 'text-red-400');
const chgTxt = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

export function LadderOptionChain({ underlying, expiry, selectedStrike, selectedOpt, onPick, onClose }: {
  underlying: string; expiry: string; selectedStrike: number | null; selectedOpt: 'CE' | 'PE';
  onPick: (strike: number, opt: 'CE' | 'PE') => void; onClose: () => void;
}) {
  const [data, setData] = useState<ChainData | null>(null);
  const [staleAge, setStaleAge] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [half, setHalf] = useState<(typeof WINDOWS)[number]>(12);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!expiry) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=dhan&allowStale=1`, { cache: 'no-store' });
      const j = await r.json() as { success?: boolean; data?: ChainData; error?: string; stale?: boolean; as_of?: number };
      if (my !== seq.current) return;
      if (!j.success || !j.data?.chain?.oc) { setError(j.error ?? 'Could not load the option chain'); return; }
      setData(j.data); setError(null); setStaleAge(j.stale && j.as_of ? Math.round((Date.now() - j.as_of) / 1000) : null);
    } catch (e) {
      if (my === seq.current) setError(String((e as Error).message ?? e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [underlying, expiry]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fetch's own loading flag
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    const invalidate = () => { seq.current++; };
    return () => { clearInterval(t); invalidate(); };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spot = Number(data?.spot) || Number(data?.future_price) || 0;
  const rows = useMemo(() => {
    const oc = data?.chain?.oc;
    if (!oc) return [];
    return Object.entries(oc).map(([k, v]) => ({ strike: Number(k), ce: v.ce, pe: v.pe })).filter(r => r.strike > 0 && isTradedStrike(underlying, r.strike)).sort((a, b) => a.strike - b.strike);
  }, [data]);
  const atm = useMemo(() => {
    if (!rows.length) return null;
    const base = spot > 0 ? spot : selectedStrike ?? rows[Math.floor(rows.length / 2)].strike;
    return rows.reduce((a, b) => (Math.abs(b.strike - base) < Math.abs(a.strike - base) ? b : a)).strike;
  }, [rows, spot, selectedStrike]);
  const shown = useMemo(() => {
    if (atm == null) return [];
    const i = rows.findIndex(r => r.strike === atm);
    return rows.slice(Math.max(0, i - half), i + half + 1);
  }, [rows, atm, half]);
  const maxOi = useMemo(() => ({
    ce: Math.max(0, ...shown.map(r => r.ce?.oi ?? 0)),
    pe: Math.max(0, ...shown.map(r => r.pe?.oi ?? 0)),
  }), [shown]);

  const th = 'px-2 py-1.5 text-xs font-bold text-white bg-zinc-800 text-right whitespace-nowrap';
  const td = 'px-2 py-1 text-right font-mono text-xs whitespace-nowrap';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-oncolor-dark/70 p-4 overflow-auto" role="dialog" aria-modal="true" aria-label={`${underlying} option chain`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-4xl rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20"><Table2 className="w-4 h-4 text-emerald-400" /></div>
            <div>
              <h2 className="text-sm font-bold text-white leading-none">{underlying} option chain · {expiry}</h2>
              <p className="text-[11px] text-zinc-400 mt-1 font-mono">
                {spot > 0 ? `Spot ${spot.toFixed(2)}` : 'Spot —'}{atm != null ? ` · ATM ${atm}` : ''}
                {staleAge != null ? <span className="text-amber-300"> · last good chain, {staleAge}s old (Dhan refused a fresh one)</span> : null}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden" role="group" aria-label="Strikes either side of ATM">
              {WINDOWS.map(w => (
                <button key={w} type="button" aria-pressed={half === w} onClick={() => setHalf(w)}
                  className={`px-2 py-0.5 text-xs font-semibold ${half === w ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>±{w}</button>
              ))}
            </div>
            <button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh the chain" title="Refresh (the chain also refreshes every 20 s)"
              className="p-1.5 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
            <button type="button" onClick={onClose} aria-label="Close the option chain" className="p-1.5 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white"><X className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        {error && <p className="px-4 py-2 text-xs text-amber-300 border-b border-zinc-800">{error}{data ? ' — showing the last chain' : ''}</p>}
        <div className="overflow-auto max-h-[70vh]">
          {!data && !error ? <p className="p-6 text-xs text-zinc-400">Loading the chain…</p> : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className={th}>OI</th><th className={th}>OI chg</th><th className={th}>Vol</th><th className={th}>IV</th><th className={`${th} text-emerald-300`}>CE ₹</th>
                  <th className={`${th} text-center`}>Strike</th>
                  <th className={`${th} text-red-300`}>PE ₹</th><th className={th}>IV</th><th className={th}>Vol</th><th className={th}>OI chg</th><th className={th}>OI</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const isAtm = r.strike === atm;
                  const pick = (opt: 'CE' | 'PE') => ({
                    onClick: () => { onPick(r.strike, opt); onClose(); },
                    title: `Put the ladder on ${underlying} ${r.strike} ${opt}`,
                  });
                  const sel = (opt: 'CE' | 'PE') => (selectedStrike === r.strike && selectedOpt === opt ? 'ring-1 ring-inset ring-emerald-400 bg-emerald-500/10' : '');
                  const ceOi = r.ce?.oi ?? 0, peOi = r.pe?.oi ?? 0;
                  return (
                    <tr key={r.strike} className={`border-b border-zinc-900 ${isAtm ? 'bg-amber-500/5' : ''}`}>
                      <td className={`${td} text-zinc-300`} style={{ background: ceOi && maxOi.ce ? `linear-gradient(to left, rgb(16 185 129 / 0.18) ${(ceOi / maxOi.ce) * 100}%, transparent 0)` : undefined }}>{fmtOi(ceOi)}</td>
                      <td className={`${td} ${chgCls(chg(r.ce?.oi, r.ce?.previous_oi))}`}>{chgTxt(chg(r.ce?.oi, r.ce?.previous_oi))}</td>
                      <td className={`${td} text-zinc-400`}>{fmtOi(r.ce?.volume)}</td>
                      <td className={`${td} text-zinc-400`}>{r.ce?.implied_volatility ? r.ce.implied_volatility.toFixed(1) : '—'}</td>
                      <td className={`${td} p-0`}><button type="button" {...pick('CE')} className={`w-full px-2 py-1 text-right font-semibold text-emerald-300 hover:bg-zinc-800 ${sel('CE')}`}>{fmtPx(r.ce?.last_price)}</button></td>
                      <td className={`${td} text-center font-bold ${isAtm ? 'text-amber-300' : 'text-zinc-100'}`}>{r.strike}</td>
                      <td className={`${td} p-0`}><button type="button" {...pick('PE')} className={`w-full px-2 py-1 text-right font-semibold text-red-300 hover:bg-zinc-800 ${sel('PE')}`}>{fmtPx(r.pe?.last_price)}</button></td>
                      <td className={`${td} text-zinc-400`}>{r.pe?.implied_volatility ? r.pe.implied_volatility.toFixed(1) : '—'}</td>
                      <td className={`${td} text-zinc-400`}>{fmtOi(r.pe?.volume)}</td>
                      <td className={`${td} ${chgCls(chg(r.pe?.oi, r.pe?.previous_oi))}`}>{chgTxt(chg(r.pe?.oi, r.pe?.previous_oi))}</td>
                      <td className={`${td} text-zinc-300`} style={{ background: peOi && maxOi.pe ? `linear-gradient(to right, rgb(239 68 68 / 0.18) ${(peOi / maxOi.pe) * 100}%, transparent 0)` : undefined }}>{fmtOi(peOi)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <p className="px-4 py-2 text-[10px] text-zinc-500 border-t border-zinc-800">Click a CE or PE price to put the ladder on that contract. OI change is against the previous day.</p>
      </div>
    </div>
  );
}
