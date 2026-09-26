'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Layers, RefreshCw, Flame, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import CockpitSpinner from './CockpitSpinner';

interface ChainSide {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
}

interface ChainEntry {
  ce?: ChainSide;
  pe?: ChainSide;
}

type QuadrantLabel = 'Long Buildup' | 'Short Buildup' | 'Short Covering' | 'Long Unwinding';

interface ClassifiedStrike {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  priceChg: number;
  priceChgPct: number;
  oiChg: number;
  oiChgPct: number;
  quadrant: QuadrantLabel;
}

const QUADRANTS: { label: QuadrantLabel; badge: string; text: string; dot: string }[] = [
  { label: 'Long Buildup', badge: 'bg-emerald-500/15 border-emerald-500/30', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  { label: 'Short Buildup', badge: 'bg-rose-500/15 border-rose-500/30', text: 'text-rose-400', dot: 'bg-rose-400' },
  { label: 'Short Covering', badge: 'bg-sky-500/15 border-sky-500/30', text: 'text-sky-400', dot: 'bg-sky-400' },
  { label: 'Long Unwinding', badge: 'bg-amber-500/15 border-amber-500/30', text: 'text-amber-400', dot: 'bg-amber-400' },
];

function classify(side: ChainSide): QuadrantLabel | null {
  const curOI = side.oi ?? 0;
  const prevOI = side.previous_oi ?? 0;
  if (prevOI === 0 || curOI === 0) return null;
  const oiChg = curOI - prevOI;
  const priceChg = (side.last_price ?? 0) - (side.previous_close_price ?? 0);
  if (oiChg === 0) return null;
  if (oiChg > 0 && priceChg >= 0) return 'Long Buildup';
  if (oiChg > 0 && priceChg < 0) return 'Short Buildup';
  if (oiChg < 0 && priceChg >= 0) return 'Short Covering';
  return 'Long Unwinding';
}

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(1)}Cr`;
  if (abs >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

export interface OiQuadrantsWidgetProps {
  underlying: string;
  chainOc?: Record<string, ChainEntry> | null;
  expiry?: string;
}

export default function OiQuadrantsWidget({ underlying, chainOc, expiry }: OiQuadrantsWidgetProps) {
  const [items, setItems] = useState<ClassifiedStrike[]>([]);
  const [selectedQuadrant, setSelectedQuadrant] = useState<QuadrantLabel>('Short Buildup');
  const [loading, setLoading] = useState(!chainOc);
  const [error, setError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Helper to parse OC entries into classified strikes
  const parseOc = useCallback((oc: Record<string, ChainEntry>) => {
    const list: ClassifiedStrike[] = [];
    for (const [strikeStr, entry] of Object.entries(oc)) {
      const strike = Number(strikeStr);
      if (isNaN(strike)) continue;

      if (entry.ce && entry.ce.last_price && entry.ce.previous_close_price) {
        const q = classify(entry.ce);
        if (q) {
          const pChg = entry.ce.last_price - entry.ce.previous_close_price;
          const pPct = entry.ce.previous_close_price > 0 ? (pChg / entry.ce.previous_close_price) * 100 : 0;
          const oiChg = (entry.ce.oi ?? 0) - (entry.ce.previous_oi ?? 0);
          const oiPct = entry.ce.previous_oi ? (oiChg / entry.ce.previous_oi) * 100 : 0;
          list.push({
            strike,
            type: 'CE',
            ltp: entry.ce.last_price,
            priceChg: pChg,
            priceChgPct: pPct,
            oiChg,
            oiChgPct: oiPct,
            quadrant: q,
          });
        }
      }

      if (entry.pe && entry.pe.last_price && entry.pe.previous_close_price) {
        const q = classify(entry.pe);
        if (q) {
          const pChg = entry.pe.last_price - entry.pe.previous_close_price;
          const pPct = entry.pe.previous_close_price > 0 ? (pChg / entry.pe.previous_close_price) * 100 : 0;
          const oiChg = (entry.pe.oi ?? 0) - (entry.pe.previous_oi ?? 0);
          const oiPct = entry.pe.previous_oi ? (oiChg / entry.pe.previous_oi) * 100 : 0;
          list.push({
            strike,
            type: 'PE',
            ltp: entry.pe.last_price,
            priceChg: pChg,
            priceChgPct: pPct,
            oiChg,
            oiChgPct: oiPct,
            quadrant: q,
          });
        }
      }
    }
    return list;
  }, []);

  // When parent passes or updates chainOc, process it immediately with 0 network calls!
  useEffect(() => {
    if (chainOc && Object.keys(chainOc).length > 0) {
      const parsed = parseOc(chainOc);
      setItems(parsed);
      setLoading(false);
      setError('');
    }
  }, [chainOc, parseOc]);

  const requestSeq = useRef(0);

  const fetchChain = useCallback(async (silent = false) => {
    // If parent already supplies chainOc, do not make redundant fetch
    if (chainOc && Object.keys(chainOc).length > 0) return;
    const seq = ++requestSeq.current;

    if (!silent) setLoading(true);
    else setIsRefreshing(true);

    try {
      const targetExp = expiry || 'nearest';
      const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${targetExp}`);
      const json = await res.json();
      if (seq !== requestSeq.current) return;
      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error || 'Failed to load option chain');
        return;
      }

      const oc: Record<string, ChainEntry> = json.data.chain.oc;
      const list = parseOc(oc);
      setItems(list);
      setError('');
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [underlying, expiry, chainOc, parseOc]);

  useEffect(() => {
    setItems([]);
    setLoading(true);
  }, [underlying]);

  useEffect(() => {
    if (!chainOc || Object.keys(chainOc).length === 0) {
      fetchChain();
      const timer = setInterval(() => fetchChain(true), 60_000);
      return () => clearInterval(timer);
    }
  }, [fetchChain, chainOc]);

  // Group counts
  const counts = useMemo(() => {
    const c: Record<QuadrantLabel, number> = {
      'Long Buildup': 0,
      'Short Buildup': 0,
      'Short Covering': 0,
      'Long Unwinding': 0,
    };
    for (const item of items) {
      c[item.quadrant] += 1;
    }
    return c;
  }, [items]);

  const filteredItems = useMemo(() => {
    return items
      .filter(i => i.quadrant === selectedQuadrant)
      .sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg))
      .slice(0, 10);
  }, [items, selectedQuadrant]);

  return (
    <div className="flex flex-col h-full bg-zinc-900/90 border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 bg-zinc-950/60">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
            <Flame className="w-3 h-3" />
          </div>
          <div>
            <span className="text-xs font-bold text-white tracking-tight">OI Buildup Quadrants</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => fetchChain()}
          title="Refresh Quadrants"
          className="p-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white"
        >
          <RefreshCw className={`w-2.5 h-2.5 ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`} />
        </button>
      </div>

      {/* Quadrants Selector Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 p-2 bg-zinc-950/40 border-b border-zinc-800/60 text-[10px]">
        {QUADRANTS.map(q => {
          const isSel = selectedQuadrant === q.label;
          return (
            <button
              key={q.label}
              type="button"
              onClick={() => setSelectedQuadrant(q.label)}
              className={`px-2 py-1 rounded flex items-center justify-between font-bold border transition-colors ${
                isSel ? `${q.badge} text-white` : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <div className="flex items-center gap-1.5 truncate">
                <span className={`w-1.5 h-1.5 rounded-full ${q.dot}`} />
                <span className="truncate">{q.label}</span>
              </div>
              <span className={`font-mono tabular-nums ${q.text}`}>{counts[q.label]}</span>
            </button>
          );
        })}
      </div>

      {/* Strips List */}
      <div className="flex-1 min-h-[140px] overflow-auto p-2">
        {loading && (
          <CockpitSpinner
            label={`Classifying ${underlying} Buildup`}
            sublabel="Analyzing Long/Short buildup & unwinding..."
            color="emerald"
          />
        )}

        {filteredItems.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {filteredItems.map(item => (
              <div
                key={`${item.strike}-${item.type}`}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between text-[11px] font-mono hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className={`font-bold ${item.type === 'CE' ? 'text-blue-400' : 'text-rose-400'}`}>
                    {item.strike} {item.type}
                  </span>
                  <span className="text-zinc-400 tabular-nums">₹{item.ltp.toFixed(1)}</span>
                </div>

                <div className="flex items-center gap-2 text-right">
                  <span className={`font-semibold text-[10px] ${item.priceChg >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {item.priceChg >= 0 ? '+' : ''}{item.priceChgPct.toFixed(1)}%
                  </span>
                  <span className={`font-bold tabular-nums ${item.oiChg >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {item.oiChg >= 0 ? '+' : ''}{fmtOI(item.oiChg)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
