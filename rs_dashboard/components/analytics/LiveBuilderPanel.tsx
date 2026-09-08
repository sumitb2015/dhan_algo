'use client';

/**
 * Live draft-leg builder + margin + POP for pages with no real broker book
 * (StraddleAnalysis, StrangleAnalysis) — the analytics-parity sibling of the
 * real-book + draft-overlay version in PositionsAnalysis.tsx. Since there's no
 * book to overlay a draft onto here, the resolved draft legs ARE the payoff
 * curve (fed into PositionsPayoffChart's `expiryCurve` slot, not `draftCurve`).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  buildMultiExpiryCurve, computePayoffStats, resolveFreeformLegs,
  type ChainOc, type PayoffStats, type ResolvedLeg,
} from '@/lib/optionsStrategy';
import { fetchMarginSummary } from '@/lib/optionsMargin';
import { STRIKE_STEP, lotSizeOverride, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import { fmtExpiryShort } from '@/components/crudeoil/format';
import { fetchStrikeMap } from '@/lib/strikeLookup';
import { placeOptionOrder } from '@/lib/optionOrder';
import DraftStrikeBuilder, { type DraftLegSpec } from '@/components/analytics/DraftStrikeBuilder';
import PayoffMetricStrip from '@/components/analytics/PayoffMetricStrip';
import PositionsPayoffChart, { type OiBar } from '@/components/analytics/PositionsPayoffChart';

interface Toast { id: number; type: 'success' | 'error'; message: string; detail?: string }

const SPAN_STEPS = [0.01, 0.02, 0.04, 0.06, 0.10] as const;
const DEFAULT_SPAN_INDEX = 2;
/** Matches the chain-freshness cadence PositionsAnalysis.tsx polls at. */
const CHAIN_POLL_MS = 15_000;

export default function LiveBuilderPanel({ underlying }: { underlying: AnalyticsUnderlying }) {
  const strikeStep = STRIKE_STEP[underlying];

  const [chains, setChains] = useState<Record<string, ChainOc>>({});
  const [spot, setSpot] = useState(0);
  const [spotChangePct, setSpotChangePct] = useState(0);
  const [chainError, setChainError] = useState<string | null>(null);

  const [fetchedLotSize, setFetchedLotSize] = useState<number | null>(null);
  const [fetchedLotError, setFetchedLotError] = useState<string | null>(null);

  const [draftLegs, setDraftLegs] = useState<DraftLegSpec[]>([]);
  const [draftBuilderExpiry, setDraftBuilderExpiry] = useState<string | null>(null);
  const [placingDrafts, setPlacingDrafts] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [spanIndex, setSpanIndex] = useState(DEFAULT_SPAN_INDEX);
  const [showOi, setShowOi] = useState(true);
  const [standaloneMargin, setStandaloneMargin] = useState<number | null>(null);

  const spanPct = SPAN_STEPS[spanIndex];

  // ── lot size ────────────────────────────────────────────────────────────────
  const lotOverride = useMemo(() => lotSizeOverride(underlying), [underlying]);
  const lotSize = lotOverride ?? fetchedLotSize;

  useEffect(() => {
    if (lotOverride !== null) return;
    let cancelled = false;
    fetch(`/api/lotsize?symbol=${underlying}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (typeof j?.lot_size === 'number' && j.lot_size > 0) { setFetchedLotSize(j.lot_size); setFetchedLotError(null); }
        else { setFetchedLotSize(null); setFetchedLotError(j?.error ?? 'lot size unavailable'); }
      })
      .catch((e) => { if (!cancelled) setFetchedLotError(String(e)); });
    return () => { cancelled = true; };
  }, [underlying, lotOverride]);

  const addToast = useCallback((type: Toast['type'], message: string, detail?: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), type === 'error' ? 7000 : 3500);
  }, []);

  // ── chain — only the expiry the draft builder currently needs, no book to union with ──
  useEffect(() => {
    if (!draftBuilderExpiry) return;
    let cancelled = false;
    const expiry = draftBuilderExpiry;

    const fetchChain = async () => {
      try {
        const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}`);
        const json = await res.json();
        if (cancelled) return;
        if (!json?.success) { setChainError(json?.error ?? 'chain unavailable'); return; }
        const oc = (json.data?.chain?.oc ?? {}) as ChainOc;
        setChains((prev) => ({ ...prev, [expiry]: oc }));
        setSpot(json.data?.spot ?? 0);
        setSpotChangePct(json.data?.change_pct ?? 0);
        setChainError(null);
      } catch (err) {
        if (!cancelled) setChainError(String((err as Error).message ?? err));
      }
    };

    fetchChain();
    const id = setInterval(fetchChain, CHAIN_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [underlying, draftBuilderExpiry]);

  // ── draft legs — client-only, resolved against the same chain cache, never
  // touching the broker until the user commits ───────────────────────────────
  const draftGroups = useMemo(() => {
    const byExpiry = new Map<string, DraftLegSpec[]>();
    for (const d of draftLegs) {
      const arr = byExpiry.get(d.expiry) ?? [];
      arr.push(d);
      byExpiry.set(d.expiry, arr);
    }
    return byExpiry;
  }, [draftLegs]);

  const { resolvedDraftLegs, draftMissingStrikes } = useMemo(() => {
    const resolved: ResolvedLeg[] = [];
    const missing: number[] = [];
    for (const [expiry, specs] of draftGroups) {
      const oc = chains[expiry];
      if (!oc) { missing.push(...specs.map((s) => s.strike)); continue; }
      const { legs: legsFromChain, missingStrikes } = resolveFreeformLegs(
        specs.map((s) => ({ strike: s.strike, type: s.type, side: s.side, qtyLots: s.lots * (lotSize ?? 0) })),
        oc,
      );
      // resolveFreeformLegs does not stamp `.expiry` — without it a leg on a
      // later expiry would silently price at pure intrinsic downstream.
      resolved.push(...legsFromChain.map((l) => ({ ...l, expiry })));
      missing.push(...missingStrikes);
    }
    return { resolvedDraftLegs: resolved, draftMissingStrikes: missing };
  }, [draftGroups, chains, lotSize]);

  const hasResolvedDrafts = resolvedDraftLegs.length > 0;

  const finalExpiry = useMemo(() => {
    const expiries = [...new Set(resolvedDraftLegs.map((l) => l.expiry).filter((e): e is string => !!e))];
    return expiries.length ? expiries.sort().at(-1)! : null;
  }, [resolvedDraftLegs]);

  // Resolved legs already carry contract-level qtyLots (lots * lotSize), so
  // lotSize=1 here — same convention PositionsAnalysis.tsx uses to avoid
  // double-scaling.
  const payoffCurve = useMemo(
    () => (hasResolvedDrafts && spot && finalExpiry
      ? buildMultiExpiryCurve(resolvedDraftLegs, spot, 1, finalExpiry, strikeStep, spanPct)
      : []),
    [hasResolvedDrafts, resolvedDraftLegs, spot, finalExpiry, strikeStep, spanPct],
  );

  const stats = useMemo<PayoffStats | null>(
    () => (hasResolvedDrafts && spot && finalExpiry
      ? computePayoffStats(resolvedDraftLegs, spot, 1, finalExpiry, strikeStep, spanPct)
      : null),
    [hasResolvedDrafts, resolvedDraftLegs, spot, finalExpiry, strikeStep, spanPct],
  );

  // ── margin — only when the whole staged set shares one expiry, same
  // restriction PositionsAnalysis.tsx applies (Dhan's calculator takes one) ──
  useEffect(() => {
    const ctrl = new AbortController();
    const priceable = resolvedDraftLegs.length > 0 && !!draftBuilderExpiry && !!lotSize;
    (priceable
      ? fetchMarginSummary(
          underlying,
          draftBuilderExpiry!,
          resolvedDraftLegs.map((l) => ({
            strike: l.strike, type: l.type, side: l.side,
            qtyLots: Math.max(1, Math.round(l.qtyLots / lotSize!)),
            price: l.price,
          })),
          ctrl.signal,
        )
      : Promise.resolve(null)
    ).then((m) => { if (!ctrl.signal.aborted) setStandaloneMargin(m?.overall_margin ?? null); })
     .catch(() => {});
    return () => ctrl.abort();
  }, [resolvedDraftLegs, draftBuilderExpiry, lotSize, underlying]);

  // ── OI histogram from the selected expiry's chain ──────────────────────────
  const oiBars = useMemo<OiBar[]>(() => {
    const oc = draftBuilderExpiry ? chains[draftBuilderExpiry] : undefined;
    if (!oc) return [];
    return Object.entries(oc)
      .map(([k, v]) => ({ strike: Number(k), callOi: v.ce?.oi ?? 0, putOi: v.pe?.oi ?? 0 }))
      .filter((b) => Number.isFinite(b.strike) && (b.callOi > 0 || b.putOi > 0))
      .sort((a, b) => a.strike - b.strike);
  }, [chains, draftBuilderExpiry]);

  // ── place drafts (real orders, arm-then-confirm in DraftStrikeBuilder) ─────
  const handlePlaceDrafts = useCallback(async () => {
    if (!lotSize || placingDrafts || !draftLegs.length) return;
    setPlacingDrafts(true);
    for (const d of draftLegs) {
      // Sequential — avoid bursting the broker order API, keep per-leg toasts legible.
      const map = await fetchStrikeMap('dhan', underlying, d.expiry);
      const entry = map?.strikes?.[String(d.strike)];
      const label = `${d.side === 'BUY' ? 'B' : 'S'} ${d.strike} ${d.type} × ${d.lots}L`;
      if (!entry) { addToast('error', `${label} failed`, 'Strike data unavailable for this expiry'); continue; }
      const res = await placeOptionOrder({
        broker: 'dhan', underlying, side: d.side, quantity: d.lots * lotSize,
        dhanSecurityId: d.type === 'CE' ? entry.ceId : entry.peId,
        tradingSymbol: d.type === 'CE' ? entry.ceSymbol : entry.peSymbol,
      });
      if (res.ok) addToast('success', `${label} placed`, res.orderId ? `ID: ${res.orderId}` : undefined);
      else addToast('error', `${label} failed`, res.error);
    }
    setDraftLegs([]);
    setPlacingDrafts(false);
  }, [draftLegs, underlying, lotSize, placingDrafts, addToast]);

  return (
    <div className="space-y-3">
      <DraftStrikeBuilder
        broker="dhan" underlying={underlying} strikeStep={strikeStep} spot={spot} lotSize={lotSize}
        chains={chains}
        draftLegs={draftLegs}
        onAddDraft={(leg) => setDraftLegs((prev) => [...prev, leg])}
        onRemoveDraft={(id) => setDraftLegs((prev) => prev.filter((d) => d.id !== id))}
        onClearDrafts={() => setDraftLegs([])}
        onExpirySelected={setDraftBuilderExpiry}
        onPlaceDrafts={handlePlaceDrafts}
        placing={placingDrafts}
        missingStrikesCount={draftMissingStrikes.length}
      />

      {spot > 0 && (
        <div className="flex items-center gap-3 px-1 text-xs text-zinc-400">
          <span>Spot <span className="font-mono font-bold text-zinc-100">
            {spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </span></span>
          <span className={spotChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {spotChangePct >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%
          </span>
          <span>Lot {lotSize ?? '—'}</span>
        </div>
      )}

      {(chainError || fetchedLotError) && (
        <p className="px-1 text-xs text-amber-400">{chainError ?? fetchedLotError}</p>
      )}

      {stats && (
        <PayoffMetricStrip
          stats={stats} lotSize={lotSize ?? 0}
          standaloneMargin={standaloneMargin}
          standaloneMarginReason={standaloneMargin === null ? 'Add legs sharing one expiry to see required margin' : null}
          marginAvailable={null}
          spot={spot}
        />
      )}

      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
        <PositionsPayoffChart
          height={440}
          expiryCurve={payoffCurve}
          targetCurve={null}
          draftCurve={null}
          breakevens={stats?.breakevensExpiry ?? []}
          spot={spot}
          targetSpot={spot}
          expiryLabel={draftBuilderExpiry ? fmtExpiryShort(draftBuilderExpiry) : '—'}
          targetLabel=""
          oiBars={oiBars}
          showOi={showOi}
          onToggleOi={() => setShowOi((v) => !v)}
          onZoomIn={() => setSpanIndex((i) => Math.max(0, i - 1))}
          onZoomOut={() => setSpanIndex((i) => Math.min(SPAN_STEPS.length - 1, i + 1))}
          canZoomIn={spanIndex > 0}
          canZoomOut={spanIndex < SPAN_STEPS.length - 1}
          emptyReason={
            !draftBuilderExpiry ? 'Pick an expiry above to get started'
            : !hasResolvedDrafts ? 'Stage a leg above to see its payoff'
            : !spot ? 'Waiting for spot price from the option chain…'
            : undefined
          }
        />
      </div>

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {toasts.map((t) => (
            <div key={t.id}
              className={cn(
                'rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-md',
                t.type === 'success'
                  ? 'border-emerald-700 bg-emerald-950/90 text-emerald-200'
                  : 'border-rose-700 bg-rose-950/90 text-rose-200',
              )}>
              <div className="font-bold">{t.message}</div>
              {t.detail && <div className="mt-0.5 text-[11px] opacity-80">{t.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
