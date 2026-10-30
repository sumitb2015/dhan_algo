'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ArrowUpRight, ArrowDownRight, XCircle } from 'lucide-react';
import { useBrokerSelector, BROKER_LABELS, BROKERS, scalperRoute } from '@/hooks/useBrokerSelector';
import { MAX_PNF_LOTS, type PnfLegInput } from '@/lib/pnfOrderLogic';
import type { Target } from '@/lib/pnfTarget';

export interface PnfTradeBarProps {
  target: Target;
  legs: PnfLegInput[];
  live: { ce: number; pe: number } | null;
  mode?: 'PAPER' | 'REAL';
  onModeChange?: (mode: 'PAPER' | 'REAL') => void;
  onPnlChange?: (pnl: number) => void;
  onSwitchTarget?: (target: Target) => void;
}

const inr = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const pnlTone = (n: number | null) => (n == null || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-red-400');

export default function PnfTradeBar({
  target,
  legs,
  live,
  mode: propMode,
  onModeChange,
  onPnlChange,
  onSwitchTarget,
}: PnfTradeBarProps) {
  const { broker, setBroker } = useBrokerSelector();
  const [internalMode, setInternalMode] = useState<'PAPER' | 'REAL'>('PAPER');
  const mode = propMode ?? internalMode;
  const [product, setProduct] = useState<'INTRADAY' | 'MARGIN' | 'CNC'>('INTRADAY');
  const [lots, setLots] = useState(1);
  const [lotsDraft, setLotsDraft] = useState('1');
  const [busy, setBusy] = useState(false);

  // Read saved trade mode on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('straddle-pnf-trade-mode') as 'PAPER' | 'REAL' | null;
      if (saved === 'PAPER' || saved === 'REAL') {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setInternalMode(saved);
        onModeChange?.(saved);
      }
    } catch { /* storage unavailable */ }
  }, [onModeChange]);

  const toggleMode = (m: 'PAPER' | 'REAL') => {
    setInternalMode(m);
    onModeChange?.(m);
    try { localStorage.setItem('straddle-pnf-trade-mode', m); } catch { /* ignore */ }
  };

  const isStraddle = target.kind === 'options' && target.side === 'STRADDLE';
  const isIndex = target.kind === 'index';
  const isEquity = target.kind === 'equity';

  // Sizing limits: 1..20 for lots, 1..500 for shares
  const maxCap = isEquity ? 500 : MAX_PNF_LOTS;
  const commitLots = (raw: string) => {
    const val = parseInt(raw, 10);
    const clamped = Math.max(1, Math.min(maxCap, Number.isNaN(val) ? 1 : val));
    setLots(clamped);
    setLotsDraft(String(clamped));
  };

  const stepLots = (delta: number) => {
    const next = Math.max(1, Math.min(maxCap, lots + delta));
    setLots(next);
    setLotsDraft(String(next));
  };

  // ── Open positions detection ──────────────────────────────────────────────
  const [brokerPositions, setBrokerPositions] = useState<Array<{ securityId?: string; netQty: number; avgPrice?: number; unrealizedProfit?: number }>>([]);
  const [paperPositions, setPaperPositions] = useState<Record<string, { netQty: number; avgPrice: number }>>({});

  // Poll broker positions every 3s
  useEffect(() => {
    if (mode === 'PAPER' || isIndex || !legs.length) return;
    let dead = false;
    const poll = async () => {
      try {
        const res = await fetch(scalperRoute(broker, 'positions'));
        const j = await res.json() as { success?: boolean; data?: Array<Record<string, unknown>> };
        if (dead || !j.success || !Array.isArray(j.data)) return;
        const mapped = j.data.map(p => ({
          securityId: String(p.securityId ?? p.security_id ?? ''),
          netQty: Number(p.netQty ?? p.net_qty ?? p.quantity ?? 0),
          avgPrice: Number(p.costPrice ?? p.buyAvg ?? p.buy_price ?? 0),
          unrealizedProfit: Number(p.unrealizedProfit ?? p.unrealized_profit ?? p.pnl ?? 0),
        }));
        setBrokerPositions(mapped);
      } catch { /* ignore poll failure */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, 3000);
    return () => { dead = true; clearInterval(id); };
  }, [broker, mode, isIndex, legs]);

  // Read matching position on current instrument
  const activePosition = useMemo(() => {
    if (isIndex || !legs.length) return null;
    if (mode === 'PAPER') {
      const legPositions = legs.map(l => paperPositions[l.securityId] ?? { netQty: 0, avgPrice: 0 });
      const totalNet = legPositions.reduce((a, b) => a + b.netQty, 0);
      if (totalNet === 0) return null;
      return {
        side: totalNet > 0 ? ('LONG' as const) : ('SHORT' as const),
        netQty: totalNet,
        avgPrice: legPositions[0]?.avgPrice ?? 0,
        unrealizedProfit: live ? (live.ce + live.pe - (legPositions[0]?.avgPrice ?? 0)) * totalNet : 0,
      };
    }

    const legIds = new Set(legs.map(l => String(l.securityId)));
    const matched = brokerPositions.filter(p => p.securityId && legIds.has(p.securityId));
    if (!matched.length) return null;
    const totalNet = matched.reduce((a, b) => a + b.netQty, 0);
    if (totalNet === 0) return null;
    const totalPnl = matched.reduce((a, b) => a + (b.unrealizedProfit ?? 0), 0);
    return {
      side: totalNet > 0 ? ('LONG' as const) : ('SHORT' as const),
      netQty: totalNet,
      avgPrice: matched[0]?.avgPrice ?? 0,
      unrealizedProfit: totalPnl,
    };
  }, [brokerPositions, paperPositions, mode, isIndex, legs, live]);

  useEffect(() => {
    onPnlChange?.(activePosition?.unrealizedProfit ?? 0);
  }, [activePosition?.unrealizedProfit, onPnlChange]);

  // ── Order Dispatch ────────────────────────────────────────────────────────
  const executeOrder = async (action: 'BUY' | 'SELL') => {
    if (isIndex) return;
    if (!legs.length) {
      toast.error('No contract resolved for execution');
      return;
    }

    const currentLivePrice = live ? live.ce + live.pe : 0;
    setBusy(true);

    try {
      const idempotencyKey = `pnf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const res = await fetch('/api/straddle-pnf/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker,
          mode,
          action,
          productType: isEquity && product === 'CNC' ? 'CNC' : product,
          lots,
          legs,
          idempotencyKey,
        }),
      });

      const json = await res.json() as { success: boolean; error?: string; message?: string; mode?: string };
      if (!json.success) {
        toast.error(`Order Failed: ${json.error ?? 'Unknown error'}`);
        return;
      }

      // Update paper ledger if in simulation mode
      if (mode === 'PAPER') {
        setPaperPositions(prev => {
          const next = { ...prev };
          for (const l of legs) {
            const current = next[l.securityId] ?? { netQty: 0, avgPrice: 0 };
            const delta = action === 'BUY' ? lots : -lots;
            const newQty = current.netQty + delta;
            next[l.securityId] = {
              netQty: newQty,
              avgPrice: newQty !== 0 ? (currentLivePrice > 0 ? currentLivePrice : current.avgPrice) : 0,
            };
          }
          return next;
        });
        toast.success(`[PAPER] ${action} ${lots} ${isEquity ? 'shares' : 'lot' + (lots > 1 ? 's' : '')} @ ${currentLivePrice.toFixed(2)}`);
      } else {
        toast.success(`[${BROKER_LABELS[broker].toUpperCase()}] ${action} ${lots} ${isEquity ? 'shares' : 'lot' + (lots > 1 ? 's' : '')} placed at market`);
      }
    } catch (err) {
      toast.error(`Order error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const executeSquareOff = async () => {
    if (!activePosition) return;
    const closeAction = activePosition.netQty > 0 ? 'SELL' : 'BUY';
    await executeOrder(closeAction);
  };

  const pill = (active: boolean) =>
    `px-2 h-6 text-[11px] font-bold rounded transition-colors ${active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`;

  return (
    <div data-testid="pnf-trade-bar" className="flex items-center gap-x-4 gap-y-2 flex-wrap px-6 py-2 bg-zinc-900/70 border-b border-zinc-800 text-xs">
      {/* 1. Broker & Trading Mode */}
      <div className="flex items-center gap-2">
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Broker">
          {BROKERS.map(b => (
            <button
              key={b}
              type="button"
              className={pill(broker === b)}
              onClick={() => setBroker(b)}
            >
              {BROKER_LABELS[b]}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Execution mode">
          <button
            type="button"
            className={pill(mode === 'PAPER')}
            onClick={() => toggleMode('PAPER')}
            title="Simulate orders without placing real trades"
          >
            PAPER
          </button>
          <button
            type="button"
            className={`px-2 h-6 text-[11px] font-bold rounded transition-colors ${mode === 'REAL' ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'text-zinc-400 hover:text-zinc-200'}`}
            onClick={() => toggleMode('REAL')}
            title="Place live orders with real capital"
          >
            REAL
          </button>
        </div>
      </div>

      <span className="w-px h-5 bg-zinc-800 shrink-0" />

      {/* 2. Product & Lot Sizing */}
      {!isIndex && (
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Product">
            <button
              type="button"
              className={pill(product === 'INTRADAY')}
              onClick={() => setProduct('INTRADAY')}
            >
              MIS
            </button>
            <button
              type="button"
              className={pill(product === 'MARGIN')}
              onClick={() => setProduct('MARGIN')}
            >
              NRML
            </button>
            {isEquity && (
              <button
                type="button"
                className={pill(product === 'CNC')}
                onClick={() => setProduct('CNC')}
              >
                CNC
              </button>
            )}
          </div>

          {/* Sizing Input with commit-on-blur */}
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400 text-[11px] font-medium">{isEquity ? 'Qty' : 'Lots'}:</span>
            <div className="inline-flex items-center rounded border border-zinc-700 bg-zinc-950">
              <button
                type="button"
                aria-label={`Decrease ${isEquity ? 'quantity' : 'lots'}`}
                className="w-6 h-6 flex items-center justify-center text-zinc-300 hover:bg-zinc-800 rounded-l"
                onClick={() => stepLots(-1)}
              >
                −
              </button>
              <input
                type="text"
                aria-label={isEquity ? 'Order quantity' : 'Order lots'}
                value={lotsDraft}
                onChange={e => setLotsDraft(e.target.value)}
                onBlur={e => commitLots(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    commitLots((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') setLotsDraft(String(lots));
                }}
                className="w-10 h-6 text-center text-xs font-mono font-bold bg-transparent text-white focus:outline-none"
              />
              <button
                type="button"
                aria-label={`Increase ${isEquity ? 'quantity' : 'lots'}`}
                className="w-6 h-6 flex items-center justify-center text-zinc-300 hover:bg-zinc-800 rounded-r"
                onClick={() => stepLots(1)}
              >
                +
              </button>
            </div>

            {/* Quick lot presets */}
            <div className="flex items-center gap-1">
              {(isEquity ? [10, 50, 100] : [1, 2, 5, 10]).map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { setLots(n); setLotsDraft(String(n)); }}
                  className={`px-1.5 h-6 rounded text-[10px] font-mono border ${lots === n ? 'border-zinc-500 bg-zinc-800 text-white' : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}
                >
                  {isEquity ? n : `${n}L`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3. Action Buttons */}
      <div className="flex items-center gap-2 ml-auto">
        {isIndex ? (
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 text-[11px] italic">Index spot is non-tradable directly.</span>
            {onSwitchTarget && (
              <>
                <button
                  type="button"
                  onClick={() => onSwitchTarget({ kind: 'options', symbol: target.symbol, name: target.name || target.symbol, side: 'STRADDLE' })}
                  className="px-2.5 h-7 rounded text-[11px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors"
                >
                  Trade ATM Straddle
                </button>
                <button
                  type="button"
                  onClick={() => onSwitchTarget({ kind: 'futures', symbol: target.symbol, name: target.name || target.symbol })}
                  className="px-2.5 h-7 rounded text-[11px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors"
                >
                  Trade Near Future
                </button>
              </>
            )}
          </div>
        ) : isStraddle ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => executeOrder('SELL')}
              className="flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-red-600 hover:bg-red-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed shadow transition-colors"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
              <span>SHORT STRADDLE</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => executeOrder('BUY')}
              className="flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed shadow transition-colors"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
              <span>LONG STRADDLE</span>
            </button>
            {activePosition && (
              <button
                type="button"
                disabled={busy}
                onClick={executeSquareOff}
                className="flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-amber-600 hover:bg-amber-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>SQUARE OFF</span>
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => executeOrder('BUY')}
              className="flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed shadow transition-colors"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
              <span>BUY MARKET</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => executeOrder('SELL')}
              className="flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-red-600 hover:bg-red-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed shadow transition-colors"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
              <span>SELL MARKET</span>
            </button>
            {activePosition && (
              <button
                type="button"
                disabled={busy}
                onClick={executeSquareOff}
                className="flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-amber-600 hover:bg-amber-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>SQUARE OFF</span>
              </button>
            )}
          </>
        )}

        {/* 4. Active Position & P&L readout */}
        {!isIndex && (
          <div className="flex items-center gap-2 pl-3 border-l border-zinc-800 font-mono text-[11px]">
            {activePosition ? (
              <div className="flex items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded font-bold ${activePosition.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                  {activePosition.side} {Math.abs(activePosition.netQty)} {isEquity ? 'sh' : 'lots'}
                </span>
                <span className={`font-bold ${pnlTone(activePosition.unrealizedProfit)}`}>
                  {inr(activePosition.unrealizedProfit)}
                </span>
              </div>
            ) : (
              <span className="text-zinc-500">FLAT</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
