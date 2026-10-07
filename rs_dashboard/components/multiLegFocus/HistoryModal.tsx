'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, History, RefreshCw, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { formatExpiryLabel, legPnl } from '@/lib/multiLegFocus';
import { summarizeArchived, pnlMultiplier, type ArchivedBasket } from '@/lib/multiLegArchive';
import { FOCUS_RING } from '@/components/Scalper';

interface Props {
  onClose: () => void;
}

const fmtMoney = (n: number) => `${n < 0 ? '-' : n > 0 ? '+' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const fmtIst = (ms: number) => new Date(ms).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const pnlCls = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-zinc-300');

async function fetchArchive(): Promise<{ data?: ArchivedBasket[]; error?: string }> {
  try {
    const res = await fetch('/api/multi-leg-focus/archive');
    const j = await res.json() as { success: boolean; data?: ArchivedBasket[]; error?: string };
    return j.success && Array.isArray(j.data) ? { data: j.data } : { error: j.error ?? 'Archive unavailable' };
  } catch (e) {
    return { error: String((e as Error).message ?? e) };
  }
}

export default function HistoryModal({ onClose }: Props) {
  const [archive, setArchive] = useState<ArchivedBasket[]>([]);
  // Mounted only while open (see MultiLegFocus), so every open starts a fresh load.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const apply = useCallback((r: { data?: ArchivedBasket[]; error?: string }) => {
    if (r.data) setArchive(r.data);
    setError(r.error ?? null);
    setLoading(false);
  }, []);
  const refresh = () => { setLoading(true); void fetchArchive().then(apply); };
  useEffect(() => {
    let alive = true;
    void fetchArchive().then(r => { if (alive) apply(r); });
    return () => { alive = false; };
  }, [apply]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return archive
      .map(b => ({ b, s: summarizeArchived(b) }))
      .filter(({ b }) => !q
        || (b.groupName ?? '').toLowerCase().includes(q)
        || (b.name ?? b.presetKey ?? '').toLowerCase().includes(q)
        || b.underlying.toLowerCase().includes(q)
        || b.broker.toLowerCase().includes(q)
        || b.legs.some(l => `${l.strike} ${l.option}`.toLowerCase().includes(q)))
      .sort((x, y) => y.s.closedAt - x.s.closedAt);
  }, [archive, query]);
  const total = rows.reduce((sum, r) => sum + r.s.realized, 0);

  const TH = 'px-2 py-1.5 text-left text-xs font-bold text-white bg-zinc-800';
  const THR = `${TH} text-right`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" aria-label="Archived strategy history"
        className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-amber-400" />
            <div>
              <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wide">Strategy History</h2>
              <p className="text-xs text-zinc-400">
                Strategies closed on earlier days. Today&apos;s closed strategies stay on the main page until tomorrow.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={refresh} disabled={loading} aria-label="Reload history"
              className={`p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 ${FOCUS_RING}`}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" onClick={onClose} aria-label="Close"
              className={`p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 ${FOCUS_RING}`}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-5 py-2.5 border-b border-zinc-800 flex flex-wrap items-center gap-3">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter by name, strike, broker…"
            aria-label="Filter archived strategies"
            className={`h-7 w-64 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs rounded px-2 focus:outline-none focus:border-amber-500 ${FOCUS_RING}`} />
          <span className="text-xs text-zinc-400">{rows.length} strateg{rows.length === 1 ? 'y' : 'ies'}</span>
          <span className="ml-auto text-xs text-zinc-400">
            Realized: <span className={`font-mono font-bold tabular-nums ${pnlCls(total)}`}>{fmtMoney(total)}</span>
          </span>
        </div>

        <div className="overflow-auto flex-1">
          {error && (
            <div className="mx-4 mt-3 px-3 py-2 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-400 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
            </div>
          )}
          {loading && archive.length === 0 ? (
            <p className="p-6 text-center text-xs text-zinc-400">Loading history…</p>
          ) : rows.length === 0 && !error ? (
            <p className="p-6 text-center text-xs text-zinc-400">
              {archive.length === 0 ? 'No archived strategies yet.' : 'No strategies match the filter.'}
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className={TH}><span className="sr-only">Expand</span></th>
                  <th className={TH}>Closed (IST)</th>
                  <th className={TH}>Strategy</th>
                  <th className={TH}>Broker</th>
                  <th className={TH}>Underlying</th>
                  <th className={TH}>Expiry</th>
                  <th className={THR}>Legs</th>
                  <th className={THR}>Realized</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ b, s }) => {
                  const isOpen = !!open[b.id];
                  const mult = pnlMultiplier(b);
                  return (
                    <React.Fragment key={b.id}>
                      <tr className="border-t border-zinc-800 hover:bg-zinc-900 cursor-pointer"
                        onClick={() => setOpen(p => ({ ...p, [b.id]: !p[b.id] }))}>
                        <td className="px-2 py-1.5">
                          <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${b.name ?? 'strategy'}`}
                            onClick={e => { e.stopPropagation(); setOpen(p => ({ ...p, [b.id]: !p[b.id] })); }}
                            className={`p-0.5 rounded text-zinc-400 hover:text-zinc-200 ${FOCUS_RING}`}>
                            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          </button>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-zinc-300 whitespace-nowrap">{fmtIst(s.closedAt)}</td>
                        <td className="px-2 py-1.5 font-bold text-zinc-100">{b.groupName?.trim() || b.name || b.presetKey || 'Strategy'}</td>
                        <td className="px-2 py-1.5 uppercase text-zinc-300">{b.broker}</td>
                        <td className="px-2 py-1.5 text-zinc-300">{b.underlying}</td>
                        <td className="px-2 py-1.5 font-mono text-zinc-300">{formatExpiryLabel(b.expiry)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-zinc-300">{b.legs.length}</td>
                        <td className={`px-2 py-1.5 text-right font-mono font-bold tabular-nums ${pnlCls(s.realized)}`}>
                          {fmtMoney(s.realized)}
                          {s.unpricedLegs > 0 && (
                            <span className="block text-[10px] font-normal text-amber-400" title="Closed legs with no recorded exit price are not in this total">
                              {s.unpricedLegs} leg{s.unpricedLegs === 1 ? '' : 's'} unpriced
                            </span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-zinc-800 bg-zinc-900">
                          <td />
                          <td colSpan={7} className="px-2 py-2">
                            <table className="w-full text-xs">
                              <thead>
                                <tr>
                                  <th className={TH}>Side</th>
                                  <th className={TH}>Contract</th>
                                  <th className={THR}>Qty</th>
                                  <th className={THR}>Entry</th>
                                  <th className={THR}>Exit</th>
                                  <th className={THR}>P&amp;L</th>
                                  <th className={TH}>Closed (IST)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {b.legs.filter(l => l.status === 'CLOSED').map(l => {
                                  const priced = !!l.closedFill;
                                  const pnl = priced ? legPnl(l, 0, mult) : null;
                                  return (
                                    <tr key={l.id} className="border-t border-zinc-800">
                                      <td className={`px-2 py-1 font-bold ${l.side === 'B' ? 'text-emerald-400' : 'text-rose-400'}`}>{l.side === 'B' ? 'BUY' : 'SELL'}</td>
                                      <td className="px-2 py-1 font-mono text-zinc-200">
                                        {l.strike} {l.option} <span className="text-zinc-500">{formatExpiryLabel(l.expiry || b.expiry)}</span>
                                      </td>
                                      <td className="px-2 py-1 text-right font-mono tabular-nums text-zinc-300">{l.closedFill?.qty ?? '—'}</td>
                                      <td className="px-2 py-1 text-right font-mono tabular-nums text-zinc-300">{l.fill?.avgPrice ? l.fill.avgPrice.toFixed(2) : '—'}</td>
                                      <td className="px-2 py-1 text-right font-mono tabular-nums text-zinc-300">{l.closedFill ? l.closedFill.exitPrice.toFixed(2) : '—'}</td>
                                      <td className={`px-2 py-1 text-right font-mono font-bold tabular-nums ${pnl == null ? 'text-zinc-500' : pnlCls(pnl)}`}>
                                        {pnl == null ? '—' : fmtMoney(pnl)}
                                      </td>
                                      <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{l.closedAt ? fmtIst(l.closedAt) : '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
