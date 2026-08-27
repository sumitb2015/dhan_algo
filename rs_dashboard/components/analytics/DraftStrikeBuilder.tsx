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
    <div className="flex flex-col gap-2 rounded border border-violet-900/60 bg-violet-950/10 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-violet-400">Draft Strike (what-if)</span>

        <select value={expiry} onChange={(e) => setExpiry(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-xs text-zinc-200">
          {expiries.map((e) => <option key={e} value={e}>{fmtExpiryShort(e)}</option>)}
        </select>

        <select value={strike ?? ''} onChange={(e) => setStrike(Number(e.target.value))}
          disabled={!visibleStrikes.length}
          className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-xs text-zinc-200 disabled:opacity-40">
          {visibleStrikes.map((s) => <option key={s} value={s}>{s.toLocaleString('en-IN')}</option>)}
        </select>

        <div className="flex overflow-hidden rounded border border-zinc-700">
          {(['CE', 'PE'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setOptType(t)}
              className={cn('px-2 py-1 font-mono text-[10px] font-bold transition-colors',
                optType === t ? 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/30' : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300')}>
              {t}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setLots((l) => Math.max(1, l - 1))}
            className="h-6 w-6 rounded border border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:text-zinc-100">−</button>
          <span className="w-6 text-center font-mono text-xs text-zinc-200">{lots}</span>
          <button type="button" onClick={() => setLots((l) => l + 1)}
            className="h-6 w-6 rounded border border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:text-zinc-100">+</button>
        </div>

        <div className="flex gap-1">
          <button type="button" disabled={!ready} onClick={() => addDraft('BUY')}
            className="rounded border border-sky-800 bg-sky-950 px-2 py-1 font-mono text-[10px] font-bold text-sky-300 transition-colors hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-30">
            + Buy
          </button>
          <button type="button" disabled={!ready} onClick={() => addDraft('SELL')}
            className="rounded border border-rose-800 bg-rose-950 px-2 py-1 font-mono text-[10px] font-bold text-rose-300 transition-colors hover:bg-rose-900 disabled:cursor-not-allowed disabled:opacity-30">
            + Sell
          </button>
        </div>

        {!chainLoaded && expiry && (
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" /> loading strikes…
          </span>
        )}
        {chainLoaded && expiry && !visibleStrikes.length && (
          <span className="text-[10px] text-amber-400">No strikes loaded for this expiry</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-violet-900/40 pt-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Quick add</span>

        <div className="flex overflow-hidden rounded border border-zinc-700">
          {(['SELL', 'BUY'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setQuickSide(s)}
              className={cn('px-2 py-1 font-mono text-[10px] font-bold transition-colors',
                quickSide === s
                  ? s === 'SELL' ? 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30' : 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/30'
                  : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300')}>
              {s === 'SELL' ? 'Sell' : 'Buy'}
            </button>
          ))}
        </div>

        <button type="button" disabled={!ready} onClick={addStraddle}
          title={`Add both legs at ${strike?.toLocaleString('en-IN') ?? '—'} (CE + PE, same strike)`}
          className="rounded border border-violet-700 bg-violet-950 px-2 py-1 font-mono text-[10px] font-bold text-violet-300 transition-colors hover:bg-violet-900 disabled:cursor-not-allowed disabled:opacity-30">
          + Straddle
        </button>

        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-500">±</span>
          <button type="button" onClick={() => setStrangleWidth((w) => Math.max(1, w - 1))}
            className="h-6 w-6 rounded border border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:text-zinc-100">−</button>
          <span className="w-10 text-center font-mono text-[10px] text-zinc-200">{strangleWidth * strikeStep}</span>
          <button type="button" onClick={() => setStrangleWidth((w) => w + 1)}
            className="h-6 w-6 rounded border border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:text-zinc-100">+</button>
        </div>

        <button type="button" disabled={!ready} onClick={addStrangle}
          title={`Add both wings around ${strike?.toLocaleString('en-IN') ?? '—'} (CE ${strike !== null ? (strike + strangleWidth * strikeStep).toLocaleString('en-IN') : '—'}, PE ${strike !== null ? (strike - strangleWidth * strikeStep).toLocaleString('en-IN') : '—'})`}
          className="rounded border border-violet-700 bg-violet-950 px-2 py-1 font-mono text-[10px] font-bold text-violet-300 transition-colors hover:bg-violet-900 disabled:cursor-not-allowed disabled:opacity-30">
          + Strangle
        </button>
      </div>

      {draftLegs.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-violet-900/40 pt-1.5">
          <div className="flex flex-wrap gap-1.5">
            {draftLegs.map((d) => (
              <span key={d.id}
                className="flex items-center gap-1 rounded border border-violet-800 bg-violet-950/40 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">
                <span className={d.side === 'SELL' ? 'text-rose-300' : 'text-sky-300'}>{d.side === 'SELL' ? 'S' : 'B'}</span>
                {d.strike.toLocaleString('en-IN')} {d.type} × {d.lots}L
                <span className="text-violet-400/70">{fmtExpiryShort(d.expiry)}</span>
                <button type="button" onClick={() => onRemoveDraft(d.id)} aria-label={`Remove draft ${d.strike} ${d.type}`}
                  className="ml-0.5 text-violet-400 hover:text-violet-100">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>

          {missingStrikesCount > 0 && (
            <span className="text-[10px] text-amber-400">
              {missingStrikesCount} draft strike{missingStrikesCount > 1 ? 's' : ''} not found in the loaded chain yet
            </span>
          )}

          <div className="flex items-center gap-1.5">
            <button type="button" onClick={onClearDrafts}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[10px] font-bold text-zinc-400 transition-colors hover:text-zinc-200">
              Clear Drafts
            </button>
            <button type="button" disabled={placing} onClick={placeDrafts}
              className={cn('rounded border px-2 py-1 font-mono text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                armedPlace ? 'border-emerald-400 bg-emerald-500/25 text-emerald-100 hover:bg-emerald-500/35'
                  : 'border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900')}>
              {placing
                ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Placing…</span>
                : armedPlace ? 'Confirm?' : `Place Draft Orders (${draftLegs.length})`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
