'use client';

/**
 * "What-if" strike builder: lets the user stage hypothetical strikes and see
 * them reflected in the payoff chart (as a combined real+draft overlay,
 * rendered by the parent) BEFORE any broker order is placed. Mirrors
 * AddStrikePicker's expiry/strike/CE-PE/lots controls, but "Add to Draft" is
 * purely local state — no fetchStrikeMap/placeOptionOrder call happens until
 * the user explicitly commits via "Place Draft Orders".
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Broker } from '@/hooks/useBrokerSelector';
import type { ChainOc } from '@/lib/optionsStrategy';
import { fmtExpiryShort } from '@/components/crudeoil/format';

type OptType = 'CE' | 'PE';
type Side = 'BUY' | 'SELL';

export interface DraftLegSpec {
  id: string;
  expiry: string;
  strike: number;
  type: OptType;
  side: Side;
  lots: number;
}

interface Props {
  broker: Broker;
  underlying: string;
  strikeStep: number;
  spot: number;
  lotSize: number | null;
  /** Parent's chain cache, read-only — strike options come from here, keyed by expiry. */
  chains: Record<string, ChainOc>;
  draftLegs: DraftLegSpec[];
  onAddDraft: (leg: DraftLegSpec) => void;
  onRemoveDraft: (id: string) => void;
  onClearDrafts: () => void;
  /** Fires as soon as an expiry is picked, so the parent can start fetching its chain before any leg is added. */
  onExpirySelected: (expiry: string) => void;
  onPlaceDrafts: () => Promise<void>;
  placing: boolean;
  missingStrikesCount: number;
}

const STRIKE_WINDOW = 10;

export default function DraftStrikeBuilder({
  broker, underlying, strikeStep, spot, lotSize, chains, draftLegs,
  onAddDraft, onRemoveDraft, onClearDrafts, onExpirySelected, onPlaceDrafts, placing, missingStrikesCount,
}: Props) {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>('');
  const [strike, setStrike] = useState<number | null>(null);
  const [optType, setOptType] = useState<OptType>('CE');
  const [lots, setLots] = useState(1);
  const [armedPlace, setArmedPlace] = useState(false);
  const [quickSide, setQuickSide] = useState<Side>('SELL');
  const [strangleWidth, setStrangleWidth] = useState(2);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (cancelled) return;
        const data = j.data ?? [];
        if (j.success && data.length) {
          setExpiries(data);
          setExpiry((prev) => (data.includes(prev) ? prev : data[0]));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [broker, underlying]);

  useEffect(() => {
    if (expiry) onExpirySelected(expiry);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onExpirySelected is a setState wrapper from the parent, not meant to retrigger this
  }, [expiry]);

  const chainLoaded = !!chains[expiry];
  const visibleStrikes = useMemo(() => {
    const oc = chains[expiry];
    if (!oc) return [];
    const all = Object.keys(oc).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!all.length || !spot || !strikeStep) return all;
    const atm = Math.round(spot / strikeStep) * strikeStep;
    return all.filter((s) => Math.abs(s - atm) <= strikeStep * STRIKE_WINDOW);
  }, [chains, expiry, spot, strikeStep]);

  useEffect(() => {
    if (strike !== null && visibleStrikes.includes(strike)) return;
    if (!visibleStrikes.length) { setStrike(null); return; }
    const atm = spot && strikeStep ? Math.round(spot / strikeStep) * strikeStep : visibleStrikes[0];
    const nearest = visibleStrikes.reduce((best, s) => (Math.abs(s - atm) < Math.abs(best - atm) ? s : best), visibleStrikes[0]);
    setStrike(nearest);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `strike` is read but intentionally not a dep: this effect only reacts to the list changing under it.
  }, [visibleStrikes, spot, strikeStep]);

  const ready = !!lotSize && strike !== null && chainLoaded;

  const addDraft = (side: Side) => {
    if (!ready || strike === null) return;
    onAddDraft({ id: crypto.randomUUID(), expiry, strike, type: optType, side, lots });
  };

  /** Both legs at the currently selected strike — a one-click ATM straddle. */
  const addStraddle = () => {
    if (!ready || strike === null) return;
    onAddDraft({ id: crypto.randomUUID(), expiry, strike, type: 'CE', side: quickSide, lots });
    onAddDraft({ id: crypto.randomUUID(), expiry, strike, type: 'PE', side: quickSide, lots });
  };

  /** Symmetric OTM wings around the selected strike — a one-click strangle. */
  const addStrangle = () => {
    if (!ready || strike === null) return;
    const wing = strangleWidth * strikeStep;
    onAddDraft({ id: crypto.randomUUID(), expiry, strike: strike + wing, type: 'CE', side: quickSide, lots });
    onAddDraft({ id: crypto.randomUUID(), expiry, strike: strike - wing, type: 'PE', side: quickSide, lots });
  };

  const placeDrafts = () => {
    if (placing || !draftLegs.length) return;
    if (!armedPlace) {
      setArmedPlace(true);
      setTimeout(() => setArmedPlace(false), 3000);
      return;
    }
    setArmedPlace(false);
    onPlaceDrafts();
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-violet-800/40 bg-violet-950/15 p-3 shadow-inner">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[9.5px] font-bold uppercase tracking-wider text-violet-400">Draft Strike (what-if)</span>

        <select value={expiry} onChange={(e) => setExpiry(e.target.value)}
          className="rounded-lg border border-zinc-750 bg-zinc-900 px-2 py-1 font-mono text-xs font-semibold text-zinc-200 shadow-sm transition-colors hover:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500/50">
          {expiries.map((e) => <option key={e} value={e}>{fmtExpiryShort(e)}</option>)}
        </select>

        <select value={strike ?? ''} onChange={(e) => setStrike(Number(e.target.value))}
          disabled={!visibleStrikes.length}
          className="rounded-lg border border-zinc-750 bg-zinc-900 px-2 py-1 font-mono text-xs font-semibold text-zinc-200 shadow-sm transition-colors hover:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500/50 disabled:opacity-40">
          {visibleStrikes.map((s) => <option key={s} value={s}>{s.toLocaleString('en-IN')}</option>)}
        </select>

        <div className="flex overflow-hidden rounded-lg border border-zinc-750 bg-zinc-900 p-0.5 shadow-sm">
          {(['CE', 'PE'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setOptType(t)}
              className={cn('rounded-md px-2.5 py-0.5 font-mono text-[10px] font-bold transition-all',
                optType === t ? 'bg-violet-500/25 text-violet-200 shadow-sm border border-violet-500/40' : 'text-zinc-400 hover:text-zinc-200')}>
              {t}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-zinc-750 bg-zinc-900 px-1 py-0.5 shadow-sm">
          <button type="button" onClick={() => setLots((l) => Math.max(1, l - 1))}
            className="flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-800 font-mono text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white">−</button>
          <span className="w-5 text-center font-mono text-xs font-bold text-zinc-200">{lots}</span>
          <button type="button" onClick={() => setLots((l) => l + 1)}
            className="flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-800 font-mono text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white">+</button>
        </div>

        <div className="flex gap-1.5">
          <button type="button" disabled={!ready} onClick={() => addDraft('BUY')}
            className="rounded-lg border border-sky-750 bg-sky-950/80 px-2.5 py-1 font-mono text-[10px] font-bold text-sky-300 shadow-sm transition-all hover:bg-sky-900 hover:border-sky-500 disabled:cursor-not-allowed disabled:opacity-30">
            + Buy
          </button>
          <button type="button" disabled={!ready} onClick={() => addDraft('SELL')}
            className="rounded-lg border border-rose-750 bg-rose-950/80 px-2.5 py-1 font-mono text-[10px] font-bold text-rose-300 shadow-sm transition-all hover:bg-rose-900 hover:border-rose-500 disabled:cursor-not-allowed disabled:opacity-30">
            + Sell
          </button>
        </div>

        {!chainLoaded && expiry && (
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
            <Loader2 className="h-3 w-3 animate-spin" /> loading strikes…
          </span>
        )}
        {chainLoaded && expiry && !visibleStrikes.length && (
          <span className="text-[10px] text-amber-400 font-medium">No strikes loaded for this expiry</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-violet-850/50 pt-2">
        <span className="text-[9.5px] font-bold uppercase tracking-wider text-zinc-400">Quick add</span>

        <div className="flex overflow-hidden rounded-lg border border-zinc-750 bg-zinc-900 p-0.5 shadow-sm">
          {(['SELL', 'BUY'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setQuickSide(s)}
              className={cn('rounded-md px-2 py-0.5 font-mono text-[10px] font-bold transition-all',
                quickSide === s
                  ? s === 'SELL' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                  : 'text-zinc-400 hover:text-zinc-200')}>
              {s === 'SELL' ? 'Sell' : 'Buy'}
            </button>
          ))}
        </div>

        <button type="button" disabled={!ready} onClick={addStraddle}
          title={`Add both legs at ${strike?.toLocaleString('en-IN') ?? '—'} (CE + PE, same strike)`}
          className="rounded-lg border border-violet-700/80 bg-violet-950/80 px-2.5 py-1 font-mono text-[10px] font-bold text-violet-300 shadow-sm transition-all hover:bg-violet-900 hover:border-violet-500 disabled:cursor-not-allowed disabled:opacity-30">
          + Straddle
        </button>

        <div className="flex items-center gap-1 rounded-lg border border-zinc-750 bg-zinc-900 px-1 py-0.5 shadow-sm">
          <span className="text-[10px] font-bold text-zinc-500">±</span>
          <button type="button" onClick={() => setStrangleWidth((w) => Math.max(1, w - 1))}
            className="flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-800 font-mono text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white">−</button>
          <span className="w-8 text-center font-mono text-[10.5px] font-bold text-zinc-200">{strangleWidth * strikeStep}</span>
          <button type="button" onClick={() => setStrangleWidth((w) => w + 1)}
            className="flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-800 font-mono text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white">+</button>
        </div>

        <button type="button" disabled={!ready} onClick={addStrangle}
          title={`Add both wings around ${strike?.toLocaleString('en-IN') ?? '—'} (CE ${strike !== null ? (strike + strangleWidth * strikeStep).toLocaleString('en-IN') : '—'}, PE ${strike !== null ? (strike - strangleWidth * strikeStep).toLocaleString('en-IN') : '—'})`}
          className="rounded-lg border border-violet-700/80 bg-violet-950/80 px-2.5 py-1 font-mono text-[10px] font-bold text-violet-300 shadow-sm transition-all hover:bg-violet-900 hover:border-violet-500 disabled:cursor-not-allowed disabled:opacity-30">
          + Strangle
        </button>
      </div>

      {draftLegs.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-violet-850/50 pt-2">
          <div className="flex flex-wrap gap-1.5">
            {draftLegs.map((d) => (
              <span key={d.id}
                className="flex items-center gap-1.5 rounded-lg border border-violet-700/70 bg-violet-950/60 px-2 py-1 font-mono text-[10px] text-violet-200 shadow-sm">
                <span className={d.side === 'SELL' ? 'text-rose-300 font-bold' : 'text-sky-300 font-bold'}>{d.side === 'SELL' ? 'S' : 'B'}</span>
                <span className="font-semibold text-zinc-100">{d.strike.toLocaleString('en-IN')} {d.type} × {d.lots}L</span>
                <span className="text-violet-300">{fmtExpiryShort(d.expiry)}</span>
                <button type="button" onClick={() => onRemoveDraft(d.id)} aria-label={`Remove draft ${d.strike} ${d.type}`}
                  className="ml-0.5 rounded p-0.5 text-violet-400 hover:bg-violet-900 hover:text-violet-100 transition-colors">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>

          {missingStrikesCount > 0 && (
            <span className="text-[10px] text-amber-400 font-medium">
              {missingStrikesCount} draft strike{missingStrikesCount > 1 ? 's' : ''} not found in the loaded chain yet
            </span>
          )}

          <div className="flex items-center gap-2">
            <button type="button" onClick={onClearDrafts}
              className="rounded-lg border border-zinc-750 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-bold text-zinc-400 shadow-sm transition-colors hover:border-zinc-600 hover:text-zinc-200">
              Clear Drafts
            </button>
            <button type="button" disabled={placing} onClick={placeDrafts}
              className={cn('rounded-lg border px-3 py-1 font-mono text-[10px] font-bold transition-all shadow-sm disabled:cursor-not-allowed disabled:opacity-50',
                armedPlace ? 'border-emerald-400 bg-emerald-500/30 text-emerald-100 animate-pulse'
                  : 'border-emerald-700/80 bg-emerald-950/80 text-emerald-300 hover:bg-emerald-900 hover:border-emerald-500')}>
              {placing
                ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin text-emerald-400" /> Placing…</span>
                : armedPlace ? 'Confirm?' : `Place Draft Orders (${draftLegs.length})`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
