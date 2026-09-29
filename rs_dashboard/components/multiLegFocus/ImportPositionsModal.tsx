'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { X, Download, RefreshCw, AlertTriangle } from 'lucide-react';
import { formatExpiryLabel, type MultiLegBasket, type UntrackedPosition } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';

/** An untracked broker position, with its contract verified against the broker's own strike lookup. */
export interface ImportCandidate extends UntrackedPosition {
  contract?: { underlying: string; option: 'CE' | 'PE'; strike: number; expiry: string };
  lotSize?: number;
  /** Why this row can't be imported (contract not verifiable). */
  error?: string;
}

export interface ImportRequest {
  target: { kind: 'new'; name: string } | { kind: 'existing'; basketId: string };
  items: { candidate: ImportCandidate; qty: number; avgPrice: number }[];
}

interface Props {
  onClose: () => void;
  baskets: MultiLegBasket[];
  scan: () => Promise<{ candidates: ImportCandidate[]; errors: string[] }>;
  onImport: (req: ImportRequest) => Promise<boolean>;
}

const rowKey = (c: ImportCandidate) => `${c.broker}|${c.ident}`;

export default function ImportPositionsModal({ onClose, baskets, scan, onImport }: Props) {
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [scanErrors, setScanErrors] = useState<string[]>([]);
  // Mounted only while open (see MultiLegFocus), so every open starts a fresh scan.
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [lots, setLots] = useState<Record<string, string>>({});
  const [avg, setAvg] = useState<Record<string, string>>({});
  const [targetChoice, setTarget] = useState<string>('new');
  const [name, setName] = useState('Imported Positions');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { candidates: found, errors } = await scan();
      setCandidates(found);
      setScanErrors(errors);
      setSelected({});
      setLots(Object.fromEntries(found.map(c => [rowKey(c), c.lotSize ? String(Math.floor(c.untrackedQty / c.lotSize)) : ''])));
      setAvg(Object.fromEntries(found.map(c => [rowKey(c), c.brokerAvg > 0 ? String(Math.round(c.brokerAvg * 100) / 100) : ''])));
    } finally {
      setLoading(false);
    }
  }, [scan]);
  const refresh = () => { setLoading(true); void load(); };

  useEffect(() => { void load(); }, [load]);

  const picked = candidates.filter(c => selected[rowKey(c)]);
  const groupBroker = picked[0]?.broker;
  const groupUnderlying = picked[0]?.contract?.underlying;
  const mixed = picked.some(c => c.broker !== groupBroker || c.contract?.underlying !== groupUnderlying);
  const targets = groupBroker
    ? baskets.filter(b => b.broker === groupBroker && b.underlying === groupUnderlying && b.legs.some(l => l.status === 'OPEN'))
    : [];
  // A picked strategy that no longer fits the selection falls back to "new".
  const target = targets.some(b => b.id === targetChoice) ? targetChoice : 'new';

  const rowProblem = (c: ImportCandidate): string | null => {
    const k = rowKey(c);
    const n = Number(lots[k]);
    const lot = c.lotSize ?? 0;
    if (!Number.isInteger(n) || n <= 0) return 'Lots must be a whole number above 0';
    if (n * lot > c.untrackedQty) return `Max ${Math.floor(c.untrackedQty / lot)} lots untracked`;
    if (!(Number(avg[k]) > 0)) return 'Entry price must be above 0';
    return null;
  };
  const problems = picked.map(rowProblem).filter(Boolean);
  const canSubmit = picked.length > 0 && !mixed && problems.length === 0 && !submitting
    && (target !== 'new' || name.trim().length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const ok = await onImport({
        target: target === 'new' ? { kind: 'new', name: name.trim() } : { kind: 'existing', basketId: target },
        items: picked.map(c => ({ candidate: c, qty: Number(lots[rowKey(c)]) * (c.lotSize ?? 0), avgPrice: Number(avg[rowKey(c)]) })),
      });
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const TH = 'px-2 py-1.5 text-left text-xs font-bold text-white bg-zinc-800';
  const inputCls = `h-7 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded px-1.5 focus:outline-none focus:border-sky-500 ${FOCUS_RING}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" aria-label="Import positions taken outside the tool"
        className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wide">Import Outside Positions</h2>
            <p className="text-xs text-zinc-400">
              Broker quantity no strategy tracks. Pick positions to group into a strategy. No orders are placed.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={refresh} disabled={loading} aria-label="Rescan broker positions"
              className={`p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 ${FOCUS_RING}`}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" onClick={onClose} aria-label="Close"
              className={`p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 ${FOCUS_RING}`}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="overflow-auto flex-1">
          {scanErrors.map(e => (
            <div key={e} className="mx-4 mt-3 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-400 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {e}
            </div>
          ))}
          {loading && candidates.length === 0 ? (
            <p className="p-6 text-center text-xs text-zinc-400">Scanning broker positions…</p>
          ) : candidates.length === 0 ? (
            <p className="p-6 text-center text-xs text-zinc-400">Every open option position is already tracked by a strategy.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className={TH}><span className="sr-only">Select</span></th>
                  <th className={TH}>Broker</th>
                  <th className={TH}>Contract</th>
                  <th className={TH}>Side</th>
                  <th className={`${TH} text-right`}>Broker</th>
                  <th className={`${TH} text-right`}>Tracked</th>
                  <th className={`${TH} text-right`}>Untracked</th>
                  <th className={TH}>Lots</th>
                  <th className={TH}>Entry ₹</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map(c => {
                  const k = rowKey(c);
                  const on = !!selected[k];
                  const problem = on ? rowProblem(c) : null;
                  return (
                    <tr key={k} className={`border-t border-zinc-800 ${c.error ? 'opacity-60' : ''}`}>
                      <td className="px-2 py-1.5">
                        <input type="checkbox" checked={on} disabled={!!c.error}
                          aria-label={`Select ${c.tradingSymbol}`}
                          onChange={e => setSelected(p => ({ ...p, [k]: e.target.checked }))}
                          className={`accent-sky-500 ${FOCUS_RING}`} />
                      </td>
                      <td className="px-2 py-1.5 uppercase text-zinc-300">{c.broker}</td>
                      <td className="px-2 py-1.5 font-mono text-zinc-200">
                        {c.contract
                          ? <>{c.contract.underlying} {c.contract.strike} {c.contract.option} <span className="text-zinc-500">{formatExpiryLabel(c.contract.expiry)}</span></>
                          : c.tradingSymbol}
                        {c.error && <span className="block text-[10px] text-amber-400">{c.error}</span>}
                        {c.trackedQty > 0 && !c.error && (
                          <span className="block text-[10px] text-zinc-500">Shared contract: the broker entry price is pooled, check it</span>
                        )}
                        {problem && <span className="block text-[10px] text-red-400">{problem}</span>}
                      </td>
                      <td className={`px-2 py-1.5 font-bold ${c.side === 'B' ? 'text-emerald-400' : 'text-rose-400'}`}>{c.side === 'B' ? 'BUY' : 'SELL'}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-zinc-300">{c.brokerQty}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-zinc-400">{c.trackedQty}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-zinc-100 font-bold">{c.untrackedQty}</td>
                      <td className="px-2 py-1.5">
                        <input type="number" min={1} step={1} value={lots[k] ?? ''} disabled={!!c.error}
                          aria-label={`Lots to import for ${c.tradingSymbol}`}
                          onChange={e => setLots(p => ({ ...p, [k]: e.target.value }))}
                          className={`${inputCls} w-16`} />
                        {c.lotSize ? <span className="ml-1 text-[10px] text-zinc-500">×{c.lotSize}</span> : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min={0} step="0.05" value={avg[k] ?? ''} disabled={!!c.error}
                          aria-label={`Entry price for ${c.tradingSymbol}`}
                          onChange={e => setAvg(p => ({ ...p, [k]: e.target.value }))}
                          className={`${inputCls} w-20`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-900 flex flex-wrap items-center gap-3">
          <label className="text-xs font-bold text-zinc-400" htmlFor="mlf-import-target">Add to</label>
          <select id="mlf-import-target" value={target} onChange={e => setTarget(e.target.value)}
            className={`${inputCls} min-w-[12rem]`}>
            <option value="new">New strategy</option>
            {targets.map(b => <option key={b.id} value={b.id}>{b.name || b.presetKey || b.id}</option>)}
          </select>
          {target === 'new' && (
            <input value={name} onChange={e => setName(e.target.value)} aria-label="New strategy name"
              className={`${inputCls} w-48`} />
          )}
          <span className="text-xs text-zinc-400">
            {mixed ? <span className="text-red-400">Pick positions from one broker and one underlying</span>
              : `${picked.length} selected`}
          </span>
          <button type="button" onClick={() => void submit()} disabled={!canSubmit}
            className={`ml-auto h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg border border-sky-500/40 bg-sky-600 text-oncolor hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}>
            <Download className="w-3.5 h-3.5" /> {submitting ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
