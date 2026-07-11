'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────

interface ChainSide {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
}

interface ChainEntry { ce?: ChainSide; pe?: ChainSide; }

type QuadrantLabel = 'Long Buildup' | 'Short Buildup' | 'Short Covering' | 'Long Unwinding';

interface ParsedStrike {
  strike: number;
  ce: ChainSide;
  pe: ChainSide;
}

interface Tile {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  priceChgPct: number | null;
  oiChgPct: number | null;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
const POLL_MS     = 30_000;
const WINGS       = 10;

const QUADRANTS: { label: QuadrantLabel; classes: string; dot: string }[] = [
  { label: 'Long Buildup',   classes: 'border-emerald-500/25 bg-emerald-500/5', dot: 'bg-emerald-400' },
  { label: 'Short Buildup',  classes: 'border-red-500/25 bg-red-500/5',         dot: 'bg-red-400' },
  { label: 'Short Covering', classes: 'border-sky-500/25 bg-sky-500/5',         dot: 'bg-sky-400' },
  { label: 'Long Unwinding', classes: 'border-amber-500/25 bg-amber-500/5',     dot: 'bg-amber-400' },
];

const TILE_CLASSES: Record<QuadrantLabel, string> = {
  'Long Buildup':   'text-emerald-300 bg-emerald-500/10 border-emerald-500/25',
  'Short Buildup':  'text-red-300 bg-red-500/10 border-red-500/25',
  'Short Covering': 'text-sky-300 bg-sky-500/10 border-sky-500/25',
  'Long Unwinding': 'text-amber-300 bg-amber-500/10 border-amber-500/25',
};

// ─── Helpers ──────────────────────────────────────────────────────

function classifyBuildup(side: ChainSide): QuadrantLabel | null {
  const curOI  = side.oi ?? 0;
  const prevOI = side.previous_oi;
  if (!prevOI || prevOI === 0) return null;
  const oiChg    = curOI - prevOI;
  const priceChg = (side.last_price ?? 0) - (side.previous_close_price ?? 0);
  if (oiChg === 0) return null;
  if (oiChg > 0 && priceChg >= 0) return 'Long Buildup';
  if (oiChg > 0 && priceChg <  0) return 'Short Buildup';
  if (oiChg < 0 && priceChg >= 0) return 'Short Covering';
  return 'Long Unwinding';
}

function pctChg(current: number, prev: number | undefined): number | null {
  if (!prev || prev === 0) return null;
  return ((current - prev) / prev) * 100;
}

function tileFromSide(strike: number, type: 'CE' | 'PE', side: ChainSide): Tile {
  return {
    strike,
    type,
    ltp: side.last_price ?? 0,
    priceChgPct: pctChg(side.last_price ?? 0, side.previous_close_price),
    oiChgPct: pctChg(side.oi ?? 0, side.previous_oi),
  };
}

function fmtPct(pct: number | null): string {
  if (pct === null) return '—';
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}

// ─── Tile ─────────────────────────────────────────────────────────

function QuadrantTile({ tile, label }: { tile: Tile; label: QuadrantLabel }) {
  return (
    <div className={`flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border text-[11px] font-semibold tabular-nums ${TILE_CLASSES[label]}`}>
      <div className="flex items-center gap-1.5">
        <span className="font-bold">{tile.strike.toLocaleString('en-IN')}</span>
        <span className="text-[9px] px-1 py-0.5 rounded bg-black/20">{tile.type}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] opacity-90">
        <span>₹{tile.ltp.toFixed(1)}</span>
        <span>{fmtPct(tile.priceChgPct)}</span>
        <span>OI {fmtPct(tile.oiChgPct)}</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function QuilTradeQuadrants({ expiry }: { expiry: string }) {
  const [allStrikes, setAllStrikes]   = useState<ParsedStrike[]>([]);
  const [spot, setSpot]               = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, ChainEntry> }; spot: number };
        error?: string;
      };
      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const oc = json.data.chain.oc;
      const parsed: ParsedStrike[] = Object.entries(oc)
        .map(([key, entry]) => ({ strike: Number(key), entry }))
        .filter(x => !isNaN(x.strike))
        .sort((a, b) => a.strike - b.strike)
        .map(({ strike, entry }) => ({
          strike,
          ce: entry.ce ?? {},
          pe: entry.pe ?? {},
        }));

      setAllStrikes(parsed);
      setSpot(json.data.spot ?? 0);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry]);

  useEffect(() => {
    fetchChain();
    intervalRef.current = setInterval(fetchChain, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchChain]);

  const atm = spot > 0 ? Math.round(spot / STRIKE_STEP) * STRIKE_STEP : 0;

  const atmIdx = atm > 0 && allStrikes.length > 0
    ? allStrikes.reduce((best, { strike }, i) =>
        Math.abs(strike - atm) < Math.abs(allStrikes[best].strike - atm) ? i : best, 0)
    : Math.floor(allStrikes.length / 2);

  const visible = allStrikes.slice(
    Math.max(0, atmIdx - WINGS),
    Math.min(allStrikes.length, atmIdx + WINGS + 1),
  );

  const tilesByQuadrant: Record<QuadrantLabel, Tile[]> = {
    'Long Buildup': [], 'Short Buildup': [], 'Short Covering': [], 'Long Unwinding': [],
  };

  for (const row of visible) {
    const ceLabel = classifyBuildup(row.ce);
    if (ceLabel) tilesByQuadrant[ceLabel].push(tileFromSide(row.strike, 'CE', row.ce));
    const peLabel = classifyBuildup(row.pe);
    if (peLabel) tilesByQuadrant[peLabel].push(tileFromSide(row.strike, 'PE', row.pe));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 text-[10px] text-zinc-500 font-medium">
        {loading && <span className="text-zinc-400 animate-pulse">Refreshing…</span>}
        {lastUpdated && <span>Updated {lastUpdated}</span>}
        {atm > 0 && (
          <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
            ATM {atm.toLocaleString('en-IN')}
          </span>
        )}
        <span className="ml-auto">Auto-refresh: 30s · ATM ±{WINGS} strikes</span>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {QUADRANTS.map(q => (
          <div key={q.label} className={`border rounded-2xl p-4 ${q.classes}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`h-2 w-2 rounded-full ${q.dot}`} />
              <span className="text-sm font-bold text-white">{q.label}</span>
              <span className="text-[10px] text-zinc-500 ml-auto">
                {tilesByQuadrant[q.label].length} legs
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {tilesByQuadrant[q.label].map(tile => (
                <QuadrantTile key={`${tile.strike}-${tile.type}`} tile={tile} label={q.label} />
              ))}
              {tilesByQuadrant[q.label].length === 0 && (
                <span className="text-[11px] text-zinc-600 py-2">
                  {loading ? 'Loading…' : 'No legs'}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
