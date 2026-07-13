'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';

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

// CE/PE get a fixed identity color independent of buildup-quadrant color,
// so option type reads at a glance regardless of which quadrant a tile sits in.
const OPTION_TYPE_CLASSES: Record<'CE' | 'PE', string> = {
  CE: 'border-l-4 border-l-cyan-400',
  PE: 'border-l-4 border-l-fuchsia-400',
};
const OPTION_TYPE_BADGE: Record<'CE' | 'PE', string> = {
  CE: 'bg-cyan-500 text-cyan-950',
  PE: 'bg-fuchsia-500 text-fuchsia-950',
};

function QuadrantTile({
  tile, label, pending, onTrade,
}: {
  tile: Tile;
  label: QuadrantLabel;
  pending: boolean;
  onTrade: (tile: Tile, side: 'BUY' | 'SELL') => void;
}) {
  return (
    <div className={`flex flex-col gap-1.5 px-2.5 py-2 rounded-lg border text-[11px] font-semibold tabular-nums ${TILE_CLASSES[label]} ${OPTION_TYPE_CLASSES[tile.type]}`}>
      <div className="flex items-center gap-1.5">
        <span className="font-bold">{tile.strike.toLocaleString('en-IN')}</span>
        <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded ${OPTION_TYPE_BADGE[tile.type]}`}>{tile.type}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] opacity-90">
        <span>₹{tile.ltp.toFixed(1)}</span>
        <span>{fmtPct(tile.priceChgPct)}</span>
        <span>OI {fmtPct(tile.oiChgPct)}</span>
      </div>
      <div className="flex items-center gap-1 pt-0.5 border-t border-white/10 mt-0.5">
        <Button
          size="icon-xs"
          disabled={pending}
          onClick={() => onTrade(tile, 'BUY')}
          className="flex-1 h-5 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-[10px] disabled:opacity-40"
          title={`Buy ${tile.strike} ${tile.type}`}
        >
          B
        </Button>
        <Button
          size="icon-xs"
          disabled={pending}
          onClick={() => onTrade(tile, 'SELL')}
          className="flex-1 h-5 bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-[10px] disabled:opacity-40"
          title={`Sell ${tile.strike} ${tile.type}`}
        >
          S
        </Button>
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
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold
            shadow-2xl max-w-xs
            ${t.kind === 'success'
              ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-900/95 border-rose-500/40 text-rose-200'}`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4 text-[10px] text-zinc-500 font-medium">
        {loading && <span className="text-zinc-400 animate-pulse">Refreshing…</span>}
        {lastUpdated && <span>Updated {lastUpdated}</span>}
        {atm > 0 && (
          <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
            ATM {atm.toLocaleString('en-IN')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wide">Lots</label>
          <input
            type="number" min={1} step={1}
            value={lots}
            onChange={e => setLots(Math.max(1, Number(e.target.value) || 1))}
            className="w-12 bg-zinc-900 border border-zinc-800 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-zinc-200 tabular-nums focus:outline-none focus:border-emerald-500"
          />
          <span>Auto-refresh: 30s · ATM ±{WINGS} strikes</span>
        </div>
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
            {tilesByQuadrant[q.label].length === 0 ? (
              <span className="text-[11px] text-zinc-600 py-2">
                {loading ? 'Loading…' : 'No legs'}
              </span>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {(['CE', 'PE'] as const).map(type => {
                  const legs = tilesByQuadrant[q.label].filter(t => t.type === type);
                  return (
                    <div key={type} className="flex flex-col gap-2">
                      <span className={`text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded self-start ${OPTION_TYPE_BADGE[type]}`}>
                        {type === 'CE' ? 'Calls' : 'Puts'}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {legs.map(tile => (
                          <QuadrantTile
                            key={`${tile.strike}-${tile.type}`}
                            tile={tile}
                            label={q.label}
                            pending={pendingKey === `${tile.strike}-${tile.type}`}
                            onTrade={placeOrder}
                          />
                        ))}
                        {legs.length === 0 && (
                          <span className="text-[10px] text-zinc-600 py-1">None</span>
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
