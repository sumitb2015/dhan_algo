'use client';

import React, { useState, useEffect, useMemo } from 'react';
import StrikeHistoryTab, {
  type ContextMeta,
  type HoverContext,
  type StrikeSelectionMode,
} from './StrikeHistoryTab';
import NavBar from './NavBar';

const UNDERLYING = 'NIFTY';

const OFFSETS = [
  'ATM-10', 'ATM-9', 'ATM-8', 'ATM-7', 'ATM-6', 'ATM-5', 'ATM-4', 'ATM-3', 'ATM-2', 'ATM-1',
  'ATM',
  'ATM+1', 'ATM+2', 'ATM+3', 'ATM+4', 'ATM+5', 'ATM+6', 'ATM+7', 'ATM+8', 'ATM+9', 'ATM+10',
];

export default function StrikeHistoryPage() {
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiriesLoading, setExpiriesLoading] = useState(false);

  // Strike Selection Mode: 'fixed' (constant single strike) vs 'relative' (rolling ATM offset)
  const [strikeMode, setStrikeMode] = useState<StrikeSelectionMode>('fixed');
  const [availableStrikes, setAvailableStrikes] = useState<number[]>([]);
  const [fixedStrike, setFixedStrike] = useState<number | null>(null);
  const [strikeRelative, setStrikeRelative] = useState('ATM');
  const [strikesLoading, setStrikesLoading] = useState(false);

  const [optionType, setOptionType] = useState<'CE' | 'PE'>('CE');
  const [error, setError] = useState('');

  // Live contextual states fed back from the chart
  const [contextMeta, setContextMeta] = useState<ContextMeta | null>(null);
  const [hoverContext, setHoverContext] = useState<HoverContext | null>(null);

  // Fetch Expiries on mount
  useEffect(() => {
    queueMicrotask(() => {
      setExpiriesLoading(true);
      setError('');
    });

    fetch('/api/options/strike-history?mode=expiries')
      .then(r => r.json())
      .then((j: { success: boolean; expiries?: string[]; error?: string }) => {
        if (j.success && j.expiries?.length) {
          setExpiries(j.expiries);
          setExpiry(j.expiries[0]);
        } else {
          setError(j.error ?? 'Failed to load expiries');
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setExpiriesLoading(false));
  }, []);

  // Fetch available strikes when expiry changes
  useEffect(() => {
    if (!expiry) return;
    const controller = new AbortController();

    queueMicrotask(() => {
      setStrikesLoading(true);
    });

    fetch(`/api/options/strike-history?mode=strikes&expiry=${expiry}`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then((j: { success: boolean; strikes?: number[] }) => {
        if (j.success && j.strikes?.length) {
          setAvailableStrikes(j.strikes);
          setFixedStrike(prev => {
            if (prev && j.strikes!.includes(prev)) return prev;
            // Default to middle strike or nearest 24000
            const mid = j.strikes![Math.floor(j.strikes!.length / 2)];
            return mid;
          });
        }
      })
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      })
      .finally(() => setStrikesLoading(false));

    return () => controller.abort();
  }, [expiry]);

  // Compute reference ATM strike for dropdown labels
  const atmRefStrike = useMemo(() => {
    if (!contextMeta?.currentSpot) return null;
    return Math.round(contextMeta.currentSpot / 50) * 50;
  }, [contextMeta?.currentSpot]);

  const offsetToStrike = (offset: string): number | null => {
    if (!atmRefStrike) return null;
    if (offset === 'ATM') return atmRefStrike;
    const match = offset.match(/^ATM([+-]\d+)$/);
    if (!match) return null;
    const delta = parseInt(match[1], 10) * 50;
    return atmRefStrike + delta;
  };

  // Active displayed values (hovered or latest)
  const activeSpot = hoverContext ? hoverContext.spot : contextMeta?.currentSpot ?? 0;
  const activeStrike = hoverContext
    ? hoverContext.strike
    : strikeMode === 'fixed'
      ? fixedStrike ?? contextMeta?.specificStrike ?? null
      : contextMeta?.specificStrike ?? null;

  const spotChange = contextMeta?.spotChange ?? 0;
  const spotChangePct = contextMeta?.spotChangePct ?? 0;

  // Moneyness text
  const moneynessText = useMemo(() => {
    if (!activeStrike || !activeSpot) return '';
    const diff = activeStrike - activeSpot;
    const isCall = optionType === 'CE';
    const isOTM = isCall ? diff > 0 : diff < 0;
    const absDiff = Math.abs(diff);
    if (absDiff < 25) return 'ATM';
    return `${Math.round(absDiff)} pts ${isOTM ? 'OTM' : 'ITM'}`;
  }, [activeStrike, activeSpot, optionType]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ── Sticky Header ────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        {/* Title / Domain */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M3 3v18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 16l4-6 4 3 6-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
              Options · {UNDERLYING}
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Strike History &amp; Decay</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Historical decay curve, multi-timeframe OHLC &amp; underlying spot tracking
            </p>
          </div>
        </div>

        {/* Center Live Tickers: Spot & Strike */}
        {activeSpot > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* Underlying Spot Badge */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900/80 border border-cyan-500/25">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <div className="flex flex-col font-mono leading-tight">
                <span className="text-[9px] text-zinc-400 uppercase tracking-wider font-sans font-bold">
                  {hoverContext ? `Spot @ ${hoverContext.time}` : 'NIFTY Spot'}
                </span>
                <span className="text-xs font-bold text-cyan-400 tabular-nums">
                  ₹{activeSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {!hoverContext && (
                    <span
                      className={`ml-1.5 text-[10px] ${spotChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                    >
                      ({spotChange >= 0 ? '+' : ''}
                      {spotChange.toFixed(1)} / {spotChangePct.toFixed(1)}%)
                    </span>
                  )}
                </span>
              </div>
            </div>

            {/* Specific Strike Badge */}
            {activeStrike && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900/80 border border-zinc-700">
                <div className="flex flex-col font-mono leading-tight">
                  <span className="text-[9px] text-zinc-400 uppercase tracking-wider font-sans font-bold">
                    {strikeMode === 'fixed' ? 'Fixed Strike' : 'Rolling Strike'}
                  </span>
                  <span className="text-xs font-bold text-white tabular-nums flex items-center gap-1.5">
                    {activeStrike.toLocaleString('en-IN')} {optionType}
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-emerald-400 font-medium font-sans">
                      {strikeMode === 'fixed' ? 'Constant' : strikeRelative} · {moneynessText}
                    </span>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Right Controls: Mode Toggle, Expiry, Strike, Option Type */}
        <div className="flex items-center gap-2 flex-wrap">
          {expiry && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-zinc-900 text-zinc-400 border border-zinc-700 font-mono tracking-wide">
              DATA: {expiry}
            </span>
          )}

          {/* Strike Mode Switcher: Specific Strike vs Rolling Offset */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            <button
              onClick={() => setStrikeMode('fixed')}
              className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-md transition-colors ${
                strikeMode === 'fixed'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
            >
              Specific Strike
            </button>
            <button
              onClick={() => setStrikeMode('relative')}
              className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-md transition-colors ${
                strikeMode === 'relative'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
            >
              Rolling ATM Offset
            </button>
          </div>

          {/* Expiry Select */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Expiry</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              disabled={expiriesLoading}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 tabular-nums"
            >
              {expiries.map(e => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>

          {/* Strike Selector based on Mode */}
          {strikeMode === 'fixed' ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Strike</span>
              <select
                value={fixedStrike ?? ''}
                onChange={e => setFixedStrike(Number(e.target.value))}
                disabled={strikesLoading || !availableStrikes.length}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums disabled:opacity-50"
              >
                {availableStrikes.map(s => {
                  const diff = activeSpot ? s - activeSpot : null;
                  let note = '';
                  if (diff !== null) {
                    const absD = Math.abs(diff);
                    if (absD < 25) note = ' · ATM';
                    else {
                      const isOTM = optionType === 'CE' ? diff > 0 : diff < 0;
                      note = ` · ${Math.round(absD)} ${isOTM ? 'OTM' : 'ITM'}`;
                    }
                  }
                  return (
                    <option key={s} value={s}>
                      {s.toLocaleString('en-IN')}{note}
                    </option>
                  );
                })}
              </select>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Offset</span>
              <select
                value={strikeRelative}
                onChange={e => setStrikeRelative(e.target.value)}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums"
              >
                {OFFSETS.map(o => {
                  const s = offsetToStrike(o);
                  return (
                    <option key={o} value={o}>
                      {o} {s ? `(${s.toLocaleString('en-IN')})` : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* Option Type CE / PE Toggle */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {(['CE', 'PE'] as const).map(t => (
              <button
                key={t}
                onClick={() => setOptionType(t)}
                className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-md transition-colors ${
                  optionType === t
                    ? t === 'CE'
                      ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                      : 'bg-red-500/15 text-red-400 border border-red-500/25'
                    : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Main Tab Content */}
      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {expiry ? (
          <StrikeHistoryTab
            expiry={expiry}
            strikeMode={strikeMode}
            fixedStrike={fixedStrike}
            strikeRelative={strikeRelative}
            optionType={optionType}
            onContextMetaChange={setContextMeta}
            onHoverContextChange={setHoverContext}
          />
        ) : (
          !expiriesLoading && (
            <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
              Please select an expiry to display strike history.
            </div>
          )
        )}
      </div>
    </div>
  );
}
