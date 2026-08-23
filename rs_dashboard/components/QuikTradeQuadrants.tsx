'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';

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

interface Toast {
  id: string;
  kind: 'success' | 'error';
  message: string;
  detail?: string;
}

// ─── Type scale (dhan-terminal-polish convention) ────────────────

const TXT_MICRO   = 'text-[8px]';  // column footnotes
const TXT_LABEL   = 'text-[9px]';  // field labels, badges
const TXT_VALUE   = 'text-[10px]'; // secondary readouts
const TXT_CAPTION = 'text-[11px]'; // primary compact values

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

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

function pctClass(pct: number | null): string {
  if (pct === null) return 'text-zinc-500';
  return pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-zinc-400';
}

// ─── Tile ─────────────────────────────────────────────────────────

// CE/PE get a fixed identity color independent of buildup-quadrant color,
// so option type reads at a glance regardless of which quadrant a tile sits in.
const OPTION_TYPE_RING: Record<'CE' | 'PE', string> = {
  CE: 'ring-1 ring-inset ring-cyan-500/30',
  PE: 'ring-1 ring-inset ring-fuchsia-500/30',
};
const OPTION_TYPE_BADGE: Record<'CE' | 'PE', string> = {
  CE: 'bg-cyan-500 text-cyan-950',
  PE: 'bg-fuchsia-500 text-fuchsia-950',
};

function QuadrantTile({
  tile, pending, onTrade,
}: {
  tile: Tile;
  pending: boolean;
  onTrade: (tile: Tile, side: 'BUY' | 'SELL') => void;
}) {
  return (
    <div className={cn(
      'flex flex-col rounded-xl overflow-hidden bg-zinc-950/60 border border-zinc-800/80',
      OPTION_TYPE_RING[tile.type],
      pending && 'animate-pulse',
    )}>
      {/* Header: strike + type */}
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1.5">
        <span className={cn(TXT_CAPTION, 'font-black text-zinc-100 tabular-nums')}>
          {tile.strike.toLocaleString('en-IN')}
        </span>
        <span className={cn(TXT_MICRO, 'font-extrabold px-1.5 py-0.5 rounded', OPTION_TYPE_BADGE[tile.type])}>
          {tile.type}
        </span>
      </div>

      {/* Price + OI readout */}
      <div className="flex items-baseline justify-between px-2.5 pb-2 gap-1.5">
        <span className={cn(TXT_CAPTION, 'font-bold text-zinc-200 tabular-nums whitespace-nowrap')}>
          ₹{tile.ltp.toFixed(1)}
        </span>
        <span className={cn(TXT_MICRO, 'tabular-nums whitespace-nowrap', pctClass(tile.priceChgPct))}>
          {fmtPct(tile.priceChgPct)}
        </span>
        <span className={cn(TXT_MICRO, 'tabular-nums whitespace-nowrap ml-auto', pctClass(tile.oiChgPct))} title="OI change vs previous session">
          OI {fmtPct(tile.oiChgPct)}
        </span>
      </div>

      {/* Trade actions */}
      <div className="grid grid-cols-2 border-t border-zinc-800/80">
        <button
          type="button"
          disabled={pending}
          onClick={() => onTrade(tile, 'BUY')}
          title={`Buy ${tile.strike} ${tile.type}`}
          className={cn(
            'flex items-center justify-center gap-1 h-7 border-r border-zinc-800/80',
            'bg-emerald-600/90 hover:bg-emerald-500 active:bg-emerald-600 text-oncolor font-extrabold',
            TXT_VALUE, 'transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
            FOCUS_RING,
          )}
        >
          BUY
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onTrade(tile, 'SELL')}
          title={`Sell ${tile.strike} ${tile.type}`}
          className={cn(
            'flex items-center justify-center gap-1 h-7',
            'bg-rose-600/90 hover:bg-rose-500 active:bg-rose-600 text-oncolor font-extrabold',
            TXT_VALUE, 'transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
            FOCUS_RING,
          )}
        >
          SELL
        </button>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function QuikTradeQuadrants({ expiry }: { expiry: string }) {
  const [allStrikes, setAllStrikes]   = useState<ParsedStrike[]>([]);
  const [spot, setSpot]               = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [lots, setLots]               = useState(1);
  const [pendingKey, setPendingKey]   = useState<string | null>(null);
  const [toasts, setToasts]           = useState<Toast[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const addToast = useCallback((kind: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, kind, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const placeOrder = useCallback(async (tile: Tile, side: 'BUY' | 'SELL') => {
    const key = `${tile.strike}-${tile.type}`;
    setPendingKey(key);
    try {
      const res = await fetch('/api/scalper/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying: UNDERLYING,
          expiry,
          strike: tile.strike,
          option: tile.type,
          side,
          lots,
          type: 'MARKET',
        }),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `${side} ${tile.strike} ${tile.type} placed`, `ID: ${j.order_id}`);
      } else {
        addToast('error', `${side} ${tile.strike} ${tile.type} failed`, j.error ?? 'Unknown error');
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
    } finally {
      setPendingKey(null);
    }
  }, [expiry, lots, addToast]);

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
    <div className="flex flex-col gap-3 relative">
      {/* Toast overlay */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={cn(
            'pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs',
            t.kind === 'success'
              ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-900/95 border-rose-500/40 text-rose-200',
          )}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      {/* Control strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-3 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5">
          {loading && <span className={cn(TXT_VALUE, 'text-zinc-400 animate-pulse')}>Refreshing…</span>}
          {lastUpdated && <span className={cn(TXT_VALUE, 'text-zinc-500')}>Updated {lastUpdated}</span>}
          {atm > 0 && (
            <span className={cn(TXT_LABEL, 'font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20')}>
              ATM {atm.toLocaleString('en-IN')}
            </span>
          )}
          <span className={cn(TXT_MICRO, 'text-zinc-600')}>Auto-refresh 30s · ATM ±{WINGS} strikes</span>
        </div>

        <div className="ml-auto flex items-center gap-2 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5">
          <span className={cn(TXT_LABEL, 'font-black text-zinc-600 uppercase tracking-widest')}>Lots</span>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLots(v => Math.max(1, v - 1))}
              title="Reduce lots by one"
              aria-label="Reduce lots by one"
              className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors', FOCUS_RING)}
            >
              −
            </button>
            <input
              type="number" min={1} step={1}
              value={lots}
              onChange={e => setLots(Math.max(1, Number(e.target.value) || 1))}
              title="Lots to trade per leg"
              className={cn(
                'w-10 h-6 text-center bg-zinc-900 border border-zinc-700 rounded-md',
                TXT_CAPTION, 'font-bold text-zinc-100 tabular-nums',
                'focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/40',
              )}
            />
            <button
              type="button"
              onClick={() => setLots(v => v + 1)}
              title="Add one lot"
              aria-label="Add one lot"
              className={cn('h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors', FOCUS_RING)}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className={cn(TXT_VALUE, 'text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2')}>
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {QUADRANTS.map(q => (
          <div key={q.label} className={cn('border rounded-2xl p-4', q.classes)}>
            <div className="flex items-center gap-2 mb-3">
              <span className={cn('h-2 w-2 rounded-full', q.dot)} />
              <span className="text-sm font-bold text-white">{q.label}</span>
              <span className={cn(TXT_VALUE, 'text-zinc-500 ml-auto')}>
                {tilesByQuadrant[q.label].length} legs
              </span>
            </div>
            {tilesByQuadrant[q.label].length === 0 ? (
              <span className={cn(TXT_VALUE, 'text-zinc-600 py-2 block')}>
                {loading ? 'Loading…' : 'No legs'}
              </span>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {(['CE', 'PE'] as const).map(type => {
                  const legs = tilesByQuadrant[q.label].filter(t => t.type === type);
                  return (
                    <div key={type} className="flex flex-col gap-2">
                      <span className={cn(TXT_LABEL, 'font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded self-start', OPTION_TYPE_BADGE[type])}>
                        {type === 'CE' ? 'Calls' : 'Puts'}
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {legs.map(tile => (
                          <QuadrantTile
                            key={`${tile.strike}-${tile.type}`}
                            tile={tile}
                            pending={pendingKey === `${tile.strike}-${tile.type}`}
                            onTrade={placeOrder}
                          />
                        ))}
                        {legs.length === 0 && (
                          <span className={cn(TXT_VALUE, 'text-zinc-600 py-1')}>None</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
