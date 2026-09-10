'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import {
  classifyExpiries, computeAtm, resolveFreeformLegs, computePayoffStats, buildPayoffCurve,
  buildHeatmapGrid, lookupChainLegData, STRIKE_STEP, OptType, Side, FreeformLegSpec, ChainOc, ResolvedLeg, PayoffStats,
} from '@/lib/optionsStrategy';
import {
  sortLegsForPlacement, resolveOrderRequest, type OrderLeg, type StrikeIdentifier,
} from '@/lib/basketOrders';
import { fetchMarginSummary, type MarginSummary } from '@/lib/optionsMargin';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import type { Toast } from './Scalper';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty,
} from '@/components/ui/combobox';
import { AlertTriangle, Plus, RefreshCw, RotateCcw, ShoppingBasket, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';

// Stock F&O order placement is Dhan-only today — /api/options/chain and
// /api/options/expiries both 400 for Zerodha on any underlying outside
// NIFTY/BANKNIFTY/SENSEX, so this page never offers a broker selector.
const BROKER = 'dhan' as const;

interface LegDraft {
  id: string;
  strike: number;
  type: OptType;
  side: Side;
  qtyLots: number;
}

function fmtInr(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  const abs = Math.abs(v);
  return `${sign}${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function OptionStratsStock() {
  const [underlying, setUnderlying] = useState(NIFTY50_SYMBOLS[0]);
  const [activeView, setActiveView] = useState<'table' | 'graph'>('table');

  const [expiries, setExpiries] = useState<{ date: string; kind: 'weekly' | 'monthly' }[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');

  const [spot, setSpot] = useState(0);
  const [chainOc, setChainOc] = useState<ChainOc>({});
  const [lotSize, setLotSize] = useState<number | null>(null);
  const effectiveLotSize = lotSize ?? 1;

  const [legs, setLegs] = useState<LegDraft[]>([]);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [rangePct, setRangePct] = useState(0.02); // +/- 2% of spot
  const [ivMultiplier, setIvMultiplier] = useState(1);
  const [heatmapUnit, setHeatmapUnit] = useState<'inr' | 'pct'>('inr');

  // Switching the underlying invalidates every downstream fetch — clear it
  // all so a stale strike/leg from the previous stock never leaks through.
  const handleUnderlyingChange = useCallback((next: string) => {
    if (!next || next === underlying) return;
    setUnderlying(next);
    setExpiries([]);
    setSelectedExpiry('');
    setSpot(0);
    setChainOc({});
    setLotSize(null);
    setLegs([]);
    setDuplicateWarning(null);
  }, [underlying]);

  // A blocked add/edit leaves `legs` unchanged, so this only clears the warning
  // once some other change actually goes through — not on every render.
  useEffect(() => { setDuplicateWarning(null); }, [legs]);

  // ── Order placement (Dhan only, see BROKER above) ────────────────────
  const [strikeMap, setStrikeMap] = useState<Record<string, StrikeIdentifier>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [placing, setPlacing] = useState(false);
  const [confirmPlace, setConfirmPlace] = useState(false);
  const placingRef = useRef(false);

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  useEffect(() => {
    if (!selectedExpiry) return;
    fetch(`/api/scalper/lookup?underlying=${underlying}&expiry=${selectedExpiry}`)
      .then((r) => r.json())
      .then((json) => setStrikeMap(json?.success ? (json.data?.strikes ?? {}) : {}))
      .catch(() => setStrikeMap({}));
  }, [selectedExpiry, underlying]);

  useEffect(() => {
    fetch(`/api/lotsize?symbol=${underlying}`)
      .then((r) => r.json())
      .then((json) => {
        const lot = Number(json?.lot_size);
        if (Number.isFinite(lot) && lot > 0) setLotSize(lot);
      })
      .catch(() => {});
  }, [underlying]);

  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${underlying}`)
      .then((r) => r.json())
      .then((json) => {
        const dates: string[] = json?.data ?? [];
        const classified = classifyExpiries(dates);
        setExpiries(classified);
        if (classified.length > 0) setSelectedExpiry(classified[0].date);
      })
      .catch(() => {});
  }, [underlying]);

  useEffect(() => {
    if (!selectedExpiry) return;
    fetch(`/api/options/spot?underlying=${underlying}`).then((r) => r.json()).then((json) => setSpot(json?.spot ?? 0)).catch(() => {});
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${selectedExpiry}`)
      .then((r) => r.json())
      .then((json) => setChainOc(json?.data?.chain?.oc ?? {}))
      .catch(() => {});
  }, [underlying, selectedExpiry]);

  const strikeOptions = useMemo(
    () => Object.keys(chainOc).map((k) => parseFloat(k)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b),
    [chainOc],
  );

  // Stocks don't share Nifty's fixed 50-point strike interval (it varies:
  // 2.5, 5, 10, 20, 50...) — derive it from the smallest gap between
  // consecutive strikes actually returned by the chain, falling back to the
  // shared default only until the chain has loaded at least two strikes.
  const strikeStep = useMemo(() => {
    if (strikeOptions.length < 2) return STRIKE_STEP;
    let step = Infinity;
    for (let i = 1; i < strikeOptions.length; i++) {
      const gap = strikeOptions[i] - strikeOptions[i - 1];
      if (gap > 0 && gap < step) step = gap;
    }
    return Number.isFinite(step) ? step : STRIKE_STEP;
  }, [strikeOptions]);

  const handleAddLeg = useCallback(() => {
    const atm = strikeOptions.length > 0
      ? strikeOptions.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikeOptions[0])
      : computeAtm(spot, strikeStep);
    const used = new Set(legs.map((l) => `${l.strike}-${l.type}`));

    // Search outward from ATM (0, +1, -1, +2, -2, ...) for the first strike/type
    // combo not already in use — so repeated "Add Leg" clicks build out a straddle,
    // then a strangle, etc. instead of immediately colliding with the first leg.
    let picked: { strike: number; type: OptType } | null = null;
    search:
    for (let offset = 0; offset <= 20; offset++) {
      for (const sign of offset === 0 ? [1] : [1, -1]) {
        const strike = atm + sign * offset * strikeStep;
        if (!strikeOptions.includes(strike)) continue;
        for (const type of ['CE', 'PE'] as OptType[]) {
          if (!used.has(`${strike}-${type}`)) { picked = { strike, type }; break search; }
        }
      }
    }

    if (!picked) {
      setDuplicateWarning('Every nearby strike already has a CE and PE leg — remove or edit an existing leg first.');
      return;
    }

    const { strike, type } = picked;
    setLegs((prev) => [...prev, {
      id: `${Date.now()}-${prev.length}`,
      strike,
      type,
      side: 'SELL',
      qtyLots: 1,
    }]);
  }, [strikeOptions, spot, strikeStep, legs]);

  const handleUpdateLeg = useCallback((id: string, patch: Partial<LegDraft>) => {
    const current = legs.find((l) => l.id === id);
    if (!current) return;
    const next = { ...current, ...patch };

    if (patch.strike !== undefined || patch.type !== undefined) {
      const conflict = legs.some((l) => l.id !== id && l.strike === next.strike && l.type === next.type);
      if (conflict) {
        setDuplicateWarning(`${next.strike} ${next.type} is already used by another leg — remove it first or pick a different strike/type.`);
        return;
      }
    }

    setLegs((prev) => prev.map((l) => (l.id === id ? next : l)));
  }, [legs]);

  const handleRemoveLeg = useCallback((id: string) => {
    setLegs((prev) => prev.filter((l) => l.id !== id));
  }, []);

  // Flattens already-filled legs of a trade that stopped mid-way by firing
  // opposite-side MARKET orders for each — best-effort, since a rejected or
  // network-unconfirmed leg can't otherwise be undone from this UI.
  const rollbackPlacedLegs = useCallback(async (placed: { side: Side; type: OptType; strike: number; qty: number }[]) => {
    if (!placed.length) return;
    addToast('error', `Auto-flattening ${placed.length} placed leg(s)`, 'Reversing with market orders — verify in Orders/Positions after');
    for (const p of [...placed].reverse()) {
      const label = `${p.side} ${p.strike} ${p.type}`;
      const req = resolveOrderRequest(BROKER, {
        side: p.side === 'BUY' ? 'S' : 'B', option: p.type, strike: p.strike, qty: p.qty, type: 'MARKET', underlying,
        productType: 'MARGIN',
      }, strikeMap);
      if (!req) {
        addToast('error', `Could not auto-reverse ${label}`, 'No order identifier — close manually from Orders/Positions');
        continue;
      }
      try {
        const res = await fetch(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        });
        const j = await res.json() as { success: boolean; order_id?: string; error?: string };
        if (j.success) addToast('success', `Reversed ${label}`, `ID: ${j.order_id}`);
        else addToast('error', `Reverse failed for ${label}`, `${j.error ?? 'Unknown error'} — close manually from Orders/Positions`);
      } catch (e) {
        addToast('error', `Reverse UNCONFIRMED for ${label}`, `Close manually from Orders/Positions: ${String(e)}`);
      }
    }
  }, [strikeMap, addToast, underlying]);

  const placeTrade = useCallback(async () => {
    if (legs.length === 0 || !selectedExpiry) return;
    if (!confirmPlace) {
      setConfirmPlace(true);
      setTimeout(() => setConfirmPlace(false), 4000);
      return;
    }
    setConfirmPlace(false);
    if (placingRef.current) return;

    placingRef.current = true;
    setPlacing(true);

    type QueuedLeg = { side: Side; type: OptType; strike: number; qty: number };
    const queued: QueuedLeg[] = legs.map((l) => ({ side: l.side, type: l.type, strike: l.strike, qty: l.qtyLots * effectiveLotSize }));
    const ordered = sortLegsForPlacement(queued.map((l) => ({ ...l, side: (l.side === 'BUY' ? 'B' : 'S') as 'B' | 'S' })));
    const placedLegs: QueuedLeg[] = [];

    try {
      for (const leg of ordered) {
        const origSide: Side = leg.side === 'B' ? 'BUY' : 'SELL';
        const label = `${origSide} ${leg.strike} ${leg.type}`;
        const req = resolveOrderRequest(BROKER, {
          side: leg.side, option: leg.type, strike: leg.strike, qty: leg.qty, type: 'MARKET', underlying,
          productType: 'MARGIN',
        }, strikeMap);
        if (!req) {
          addToast('error', `${label} — no order identifier resolved`, 'Strike lookup not ready yet — trade stopped');
          await rollbackPlacedLegs(placedLegs);
          return;
        }
        try {
          const res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
          });
          const j = await res.json() as { success: boolean; order_id?: string; error?: string };
          if (j.success) {
            placedLegs.push({ side: origSide, type: leg.type, strike: leg.strike, qty: leg.qty });
            addToast('success', `${label} placed`, `ID: ${j.order_id}`);
          } else {
            addToast('error', `${label} failed — trade stopped`, j.error ?? 'Unknown error');
            await rollbackPlacedLegs(placedLegs);
            return;
          }
        } catch (e) {
          addToast('error', `${label} UNCONFIRMED — trade stopped`, `Check Orders before retrying: ${String(e)}`);
          await rollbackPlacedLegs(placedLegs);
          return;
        }
      }
      addToast('success', `Trade complete: ${placedLegs.length}/${legs.length} legs placed`);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  }, [legs, selectedExpiry, confirmPlace, effectiveLotSize, strikeMap, addToast, rollbackPlacedLegs, underlying]);

  const legMarketData = useMemo(() => {
    const map = new Map<string, { price: number; iv: number | null } | null>();
    for (const leg of legs) {
      const legData = lookupChainLegData(chainOc, leg.strike, leg.type);
      map.set(leg.id, legData && typeof legData.last_price === 'number'
        ? { price: legData.last_price, iv: typeof legData.implied_volatility === 'number' ? legData.implied_volatility / 100 : null }
        : null);
    }
    return map;
  }, [legs, chainOc]);

  const { resolvedLegs, missingStrikes } = useMemo<{ resolvedLegs: ResolvedLeg[]; missingStrikes: number[] }>(() => {
    if (legs.length === 0) return { resolvedLegs: [], missingStrikes: [] };
    const specs: FreeformLegSpec[] = legs.map((l) => ({ strike: l.strike, type: l.type, side: l.side, qtyLots: l.qtyLots }));
    const { legs: resolved, missingStrikes: missing } = resolveFreeformLegs(specs, chainOc);
    return { resolvedLegs: resolved, missingStrikes: missing };
  }, [legs, chainOc]);

  const stats: PayoffStats | null = useMemo(() => {
    if (resolvedLegs.length === 0) return null;
    return computePayoffStats(resolvedLegs, spot, effectiveLotSize, selectedExpiry, strikeStep);
  }, [resolvedLegs, spot, effectiveLotSize, selectedExpiry, strikeStep]);

  // Margin is always computed against Dhan (the /api/options/margin script is
  // Dhan-only) — matches BROKER above, so this is never out of sync.
  const [margin, setMargin] = useState<MarginSummary | null>(null);
  const [marginLoading, setMarginLoading] = useState(false);

  useEffect(() => {
    if (resolvedLegs.length === 0 || missingStrikes.length > 0 || !selectedExpiry) {
      setMargin(null);
      return;
    }
    const ac = new AbortController();
    setMarginLoading(true);
    fetchMarginSummary(
      underlying,
      selectedExpiry,
      resolvedLegs.map((l) => ({ strike: l.strike, type: l.type, side: l.side, qtyLots: l.qtyLots, price: l.price })),
      ac.signal,
    )
      .then((data) => setMargin(data))
      .finally(() => setMarginLoading(false));
    return () => ac.abort();
  }, [resolvedLegs, missingStrikes, selectedExpiry, underlying]);

  const curve = useMemo(() => {
    if (resolvedLegs.length === 0) return [];
    return buildPayoffCurve(resolvedLegs, spot, effectiveLotSize, strikeStep);
  }, [resolvedLegs, spot, effectiveLotSize, strikeStep]);

  const heatmap = useMemo(() => {
    if (resolvedLegs.length === 0 || !selectedExpiry || spot <= 0) return null;
    return buildHeatmapGrid(resolvedLegs, spot, effectiveLotSize, selectedExpiry, rangePct, ivMultiplier, strikeStep);
  }, [resolvedLegs, spot, effectiveLotSize, selectedExpiry, rangePct, ivMultiplier, strikeStep]);

  // Vega-weighted average IV — weights each leg by its |vega| * lots, so a leg the
  // position is more sensitive to (bigger vega exposure) counts for more than an
  // equal-but-less-sensitive leg. Falls back to a plain mean if vega is unavailable.
  const avgIv = useMemo(() => {
    const withIv = resolvedLegs.filter((l) => l.iv !== null);
    if (withIv.length === 0) return null;
    const withVega = withIv.filter((l) => l.vega !== null);
    if (withVega.length > 0) {
      const weightSum = withVega.reduce((s, l) => s + Math.abs(l.vega as number) * l.qtyLots, 0);
      if (weightSum > 0) {
        return withVega.reduce((s, l) => s + (l.iv as number) * Math.abs(l.vega as number) * l.qtyLots, 0) / weightSum;
      }
    }
    return withIv.reduce((s, l) => s + (l.iv as number), 0) / withIv.length;
  }, [resolvedLegs]);

  const maxAbsPnl = useMemo(() => {
    if (!heatmap) return 1;
    let max = 0;
    for (const row of heatmap.cells) for (const v of row) max = Math.max(max, Math.abs(v));
    return max || 1;
  }, [heatmap]);

  function cellStyle(v: number) {
    const intensity = Math.min(1, Math.abs(v) / maxAbsPnl);
    if (v >= 0) return { backgroundColor: `rgba(16, 185, 129, ${0.08 + intensity * 0.42})` };
    return { backgroundColor: `rgba(239, 68, 68, ${0.08 + intensity * 0.42})` };
  }

  // Capital base for % view — the actual margin blocked for the trade (same
  // figure shown as "Final Margin"), not net premium, so % reads as return on capital.
  const heatmapCapitalBase = margin && margin.total_margin > 0 ? margin.total_margin : null;

  useEffect(() => {
    if (heatmapCapitalBase === null) setHeatmapUnit('inr');
  }, [heatmapCapitalBase]);

  function fmtCell(v: number): string {
    if (heatmapUnit === 'inr') return fmtInr(v);
    if (heatmapCapitalBase === null) return '—';
    const pct = (v / heatmapCapitalBase) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }

  return (
    <div className="min-h-screen text-zinc-300">
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className={cn(
            'pointer-events-auto max-w-xs rounded-xl border px-4 py-3 text-sm font-semibold shadow-2xl',
            t.type === 'success' ? 'border-emerald-500/40 bg-emerald-900/95 text-emerald-200' : 'border-rose-500/40 bg-rose-900/95 text-rose-200',
          )}
          >
            <p>{t.message}</p>
            {t.detail && <p className="mt-0.5 font-mono text-xs opacity-70">{t.detail}</p>}
          </div>
        ))}
      </div>

      <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex flex-wrap items-center gap-3">
          <h1 className="mr-2 text-sm font-bold text-white">Option Strats · Stocks</h1>

          <Combobox items={NIFTY50_SYMBOLS} value={underlying} onValueChange={(v) => v && handleUnderlyingChange(v)}>
            <ComboboxInput placeholder="Search stock…" className="w-44 font-mono" />
            <ComboboxContent>
              <ComboboxEmpty>No matching stock</ComboboxEmpty>
              <ComboboxList>
                {(item: string) => (
                  <ComboboxItem key={item} value={item}>{item}</ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>

          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 font-mono tabular-nums text-emerald-400">
            SPOT {spot > 0 ? spot.toFixed(1) : '—'}
          </Badge>
          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono tabular-nums text-zinc-400">
            LOT {lotSize ?? '…'}
          </Badge>
          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono text-zinc-400">
            DATA: {todayIso()}
          </Badge>

          <Select
            value={selectedExpiry}
            onValueChange={(v) => { if (typeof v === 'string' && v) setSelectedExpiry(v); }}
          >
            <SelectTrigger size="sm" className="min-w-56 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {expiries.map((e) => (
                <SelectItem key={e.date} value={e.date} className="font-mono">
                  {e.date} · {e.kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tabs value={activeView} onValueChange={(v) => setActiveView(v as typeof activeView)} className="ml-auto">
            <TabsList className="bg-zinc-900">
              <TabsTrigger value="table">Table</TabsTrigger>
              <TabsTrigger value="graph">Graph</TabsTrigger>
            </TabsList>
          </Tabs>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="mx-auto space-y-6 px-4 py-6">
        <Card className="bg-card/80">
          <CardHeader className="flex flex-row items-center justify-between border-b [.border-b]:pb-3">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Legs</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleAddLeg} disabled={!selectedExpiry || strikeOptions.length === 0}>
                <Plus /> Add Leg
              </Button>
              {legs.length > 0 && (
                <Button
                  size="sm"
                  onClick={placeTrade}
                  disabled={placing}
                  className={cn(confirmPlace && 'animate-pulse')}
                >
                  {placing ? <RefreshCw className="animate-spin" /> : <ShoppingBasket />}
                  {placing ? 'Placing…' : confirmPlace ? `Confirm ${legs.length} legs?` : 'Place Trade'}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-2 pt-4">
            {legs.length === 0 && (
              <p className="text-xs text-zinc-500">No legs yet — click &quot;Add Leg&quot; to start building a strategy.</p>
            )}
            {legs.map((leg) => (
              <div key={leg.id} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                <ToggleGroup
                  value={[leg.side]}
                  onValueChange={(v: unknown[]) => {
                    const next = v[v.length - 1] as Side | undefined;
                    if (next) handleUpdateLeg(leg.id, { side: next });
                  }}
                  variant="outline"
                  size="sm"
                  spacing={0}
                >
                  <ToggleGroupItem value="BUY" className="aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">BUY</ToggleGroupItem>
                  <ToggleGroupItem value="SELL" className="aria-pressed:bg-rose-500/15 aria-pressed:text-rose-400">SELL</ToggleGroupItem>
                </ToggleGroup>

                <ToggleGroup
                  value={[leg.type]}
                  onValueChange={(v: unknown[]) => {
                    const next = v[v.length - 1] as OptType | undefined;
                    if (next) handleUpdateLeg(leg.id, { type: next });
                  }}
                  variant="outline"
                  size="sm"
                  spacing={0}
                >
                  <ToggleGroupItem value="CE" className="aria-pressed:bg-emerald-500/15 aria-pressed:text-emerald-400">CE</ToggleGroupItem>
                  <ToggleGroupItem value="PE" className="aria-pressed:bg-rose-500/15 aria-pressed:text-rose-400">PE</ToggleGroupItem>
                </ToggleGroup>

                <Select
                  value={String(leg.strike)}
                  onValueChange={(v) => { if (typeof v === 'string' && v) handleUpdateLeg(leg.id, { strike: parseFloat(v) }); }}
                >
                  <SelectTrigger size="sm" className="w-28 font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {strikeOptions.map((s) => (
                      <SelectItem key={s} value={String(s)} className="font-mono">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-zinc-500">Lots</span>
                  <input
                    type="number"
                    min={1}
                    value={leg.qtyLots}
                    onChange={(e) => handleUpdateLeg(leg.id, { qtyLots: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                    className="w-16 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100"
                  />
                </div>

                {(() => {
                  const market = legMarketData.get(leg.id);
                  if (!market) return <span className="text-xs text-rose-400">Chain data unavailable</span>;
                  return (
                    <span className="font-mono text-xs text-zinc-400">
                      LTP ₹{market.price.toFixed(1)} · IV {market.iv !== null ? `${(market.iv * 100).toFixed(1)}%` : '—'}
                    </span>
                  );
                })()}

                <span className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] font-bold text-zinc-400">
                  MARGIN
                </span>

                <Button variant="outline" size="icon-xs" aria-label="Remove leg" className="ml-auto" onClick={() => handleRemoveLeg(leg.id)}>
                  <Trash2 />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        {duplicateWarning && (
          <Alert className="border-amber-800/60 bg-amber-950/60 text-amber-300">
            <AlertTriangle />
            <AlertTitle className="text-xs font-semibold text-amber-300">{duplicateWarning}</AlertTitle>
          </Alert>
        )}

        {missingStrikes.length > 0 && (
          <Alert className="border-rose-800/60 bg-rose-950/60 text-rose-300">
            <AlertTriangle />
            <AlertTitle className="text-xs font-semibold text-rose-300">
              Chain data unavailable for strike(s): {missingStrikes.join(', ')}. Try a different expiry.
            </AlertTitle>
          </Alert>
        )}

        {stats && (
          <Card className="bg-card/80">
            <CardContent className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-5">
              <Metric
                label="Net Premium"
                value={(
                  <>
                    {`₹${fmtInr(stats.netPremium * effectiveLotSize)}`}
                    {heatmapCapitalBase !== null && stats.maxProfit !== 'Unlimited' && (
                      <span className="ml-1 text-xs font-normal text-zinc-500">
                        (+{((stats.maxProfit / heatmapCapitalBase) * 100).toFixed(1)}%)
                      </span>
                    )}
                  </>
                )}
                tone={stats.netPremium >= 0 ? 'pos' : 'neg'}
              />
              <Metric label="Max Profit" value={stats.maxProfit === 'Unlimited' ? 'Unlimited' : `₹${fmtInr(stats.maxProfit)}`} tone="pos" />
              <Metric label="Max Loss" value={stats.maxLoss === 'Unlimited' ? 'Unlimited' : `₹${fmtInr(stats.maxLoss)}`} tone="neg" />
              <Metric label="Chance of Profit" value={stats.popPct !== null ? `${stats.popPct}%` : '—'} tone="neutral" />
              <Metric
                label="Breakeven"
                value={stats.breakevensExpiry.length > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {stats.breakevensExpiry.map((b) => {
                      const pct = spot > 0 ? ((b - spot) / spot) * 100 : null;
                      return (
                        <span key={b}>
                          {b.toFixed(2)}
                          {pct !== null && (
                            <span className="text-zinc-500"> ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                ) : '—'}
                tone="neutral"
              />
            </CardContent>
          </Card>
        )}

        {stats && (marginLoading || margin) && (
          <Card className="bg-card/80">
            <CardHeader className="border-b [.border-b]:pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Funds &amp; Margins</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
              {marginLoading ? (
                <div className="col-span-4 animate-pulse space-y-2">
                  <div className="h-4 w-40 rounded bg-zinc-800" />
                </div>
              ) : margin && (
                <>
                  <Metric label="Overall Margin" value={`₹${margin.overall_margin.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} tone="neutral" />
                  <Metric label="Final Margin" value={margin.total_margin > 0 ? `₹${margin.total_margin.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '— (market closed)'} tone="neutral" />
                  <Metric label="Hedge Benefit" value={`₹${margin.hedge_benefit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} tone="pos" />
                  <Metric label="Net Premium" value={`₹${fmtInr(stats.netPremium * effectiveLotSize)}`} tone={stats.netPremium >= 0 ? 'pos' : 'neg'} />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {activeView === 'graph' && stats && (
          <Card className="bg-card/80">
            <CardHeader className="border-b [.border-b]:pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Payoff at expiry</CardTitle>
            </CardHeader>
            <CardContent>
              <PayoffDiagram curve={curve} currentSpot={spot} breakevens={stats.breakevensExpiry} />
            </CardContent>
          </Card>
        )}

        {activeView === 'table' && heatmap && (
          <Card className="bg-card/80">
            <CardHeader className="flex flex-row items-center justify-between border-b [.border-b]:pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">P&amp;L heatmap</CardTitle>
              <ToggleGroup
                value={[heatmapUnit]}
                onValueChange={(v: unknown[]) => {
                  const next = v[v.length - 1] as 'inr' | 'pct' | undefined;
                  if (next) setHeatmapUnit(next);
                }}
                variant="outline"
                size="sm"
                spacing={0}
              >
                <ToggleGroupItem value="inr" className="aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">₹</ToggleGroupItem>
                <ToggleGroupItem
                  value="pct"
                  disabled={heatmapCapitalBase === null}
                  className="aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400"
                  title={heatmapCapitalBase === null ? 'Margin unavailable — cannot compute % return' : undefined}
                >
                  %
                </ToggleGroupItem>
              </ToggleGroup>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex min-w-56 flex-1 items-center gap-3">
                  <span className="whitespace-nowrap text-xs text-zinc-500">
                    Range: ±{(rangePct * 100).toFixed(1)}%
                  </span>
                  <input
                    type="range"
                    min={0.01}
                    max={0.10}
                    step={0.005}
                    value={rangePct}
                    onChange={(e) => setRangePct(parseFloat(e.target.value))}
                    className="flex-1 accent-sky-500"
                  />
                </div>
                <div className="flex min-w-56 flex-1 items-center gap-3">
                  <span className="whitespace-nowrap text-xs text-zinc-500">
                    Implied Volatility (vega-wtd): {avgIv !== null ? `${(avgIv * ivMultiplier * 100).toFixed(1)}%` : '—'}
                    {avgIv !== null && ivMultiplier === 1 && ' (current)'}
                  </span>
                  <input
                    type="range"
                    min={0.25}
                    max={3}
                    step={0.05}
                    value={ivMultiplier}
                    onChange={(e) => setIvMultiplier(parseFloat(e.target.value))}
                    className="flex-1 accent-sky-500"
                  />
                  <Button
                    variant="outline"
                    size="icon-xs"
                    aria-label="Reset IV to current"
                    disabled={ivMultiplier === 1}
                    onClick={() => setIvMultiplier(1)}
                  >
                    <RotateCcw />
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-zinc-800">
                      <th className="sticky left-0 z-10 bg-zinc-800 px-3 py-2 text-left font-bold text-white">Spot</th>
                      {heatmap.dates.map((d) => (
                        <th key={d} className="whitespace-nowrap px-2 py-2 text-right font-bold text-white">{fmtDate(d)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {heatmap.rows.map((rowSpot, ri) => (
                      <tr key={rowSpot} className={cn(Math.abs(rowSpot - Math.round(spot / strikeStep) * strikeStep) < strikeStep * 0.02 && 'outline outline-1 outline-sky-500/40')}>
                        <td className="sticky left-0 z-10 whitespace-nowrap bg-zinc-900 px-3 py-1.5 font-mono font-semibold text-zinc-200">
                          {rowSpot.toFixed(0)}
                          {spot > 0 && (
                            <span className="ml-1.5 font-normal text-zinc-500">
                              ({rowSpot >= spot ? '+' : ''}{(((rowSpot - spot) / spot) * 100).toFixed(1)}%)
                            </span>
                          )}
                        </td>
                        {heatmap.cells[ri].map((v, ci) => (
                          <td key={ci} style={cellStyle(v)} className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums text-zinc-100">
                            {fmtCell(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone: 'pos' | 'neg' | 'neutral' }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={cn(
        'font-mono text-sm font-bold tabular-nums',
        tone === 'pos' && 'text-emerald-400',
        tone === 'neg' && 'text-rose-400',
        tone === 'neutral' && 'text-zinc-100',
      )}
      >
        {value}
      </span>
    </div>
  );
}
