'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ChainOc, ResolvedLeg,
  computePayoffStats, buildPayoffCurve, findBreakevens,
  STRIKE_STEP,
} from '@/lib/optionsStrategy';
import StrategySummaryPanel from '@/components/strategy/StrategySummaryPanel';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AlertTriangle, CheckIcon, LogIn, LogOut, Minus, Plus, Save, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

// PREVIEW ONLY — scales on-screen payoff/stat figures for the moment before
// the lot size resolves from /api/lotsize (DhanHelper.get_lot_size). It is
// deliberately NOT a trading fallback: the order paths below refuse while
// `lotSize` is null, because this literal goes stale on every exchange lot
// revision (NIFTY has been 75 and is 65 today).
const FALLBACK_LOT_SIZE = 75;
const UNDERLYING = 'NIFTY';

export interface PctStrangleTabProps {
  spot: number;
  chainOc: ChainOc;
  expiries: { date: string; kind: 'weekly' | 'monthly' }[];
  selectedExpiry: string;
  lotSize: number | null; // null until fetched — live orders are blocked until known
}

function resolveToLeg(
  spot: number,
  pct: number,
  type: 'CE' | 'PE',
  chainOc: ChainOc,
  lots: number,
  strikeOverride?: number,
): ResolvedLeg | null {
  const raw = type === 'CE' ? spot * (1 + pct / 100) : spot * (1 - pct / 100);
  const strike = strikeOverride ?? Math.round(raw / STRIKE_STEP) * STRIKE_STEP;
  const entry =
    chainOc[String(strike)] ??
    Object.entries(chainOc).find(([k]) => Math.abs(parseFloat(k) - strike) < 0.01)?.[1];
  const legData = type === 'CE' ? entry?.ce : entry?.pe;
  if (!legData || typeof legData.last_price !== 'number') return null;
  return {
    strike,
    type,
    side: 'SELL',
    qtyLots: lots,
    price: legData.last_price,
    delta: legData.greeks?.delta ?? null,
    iv: typeof legData.implied_volatility === 'number' ? legData.implied_volatility / 100 : null,
    vega: legData.greeks?.vega ?? null,
    securityId: legData.security_id ? String(legData.security_id) : null,
  };
}

export default function PctStrangleTab({ spot, chainOc, expiries, selectedExpiry, lotSize }: PctStrangleTabProps) {
  const effectiveLotSize = lotSize ?? FALLBACK_LOT_SIZE;
  const [cePct, setCePct] = useState(3.0);
  const [pePct, setPePct] = useState(2.0);
  const [lots, setLots] = useState(1);
  const [mode, setMode] = useState<'intraday' | 'positional'>('intraday');
  const [tradingType, setTradingType] = useState<'demo' | 'live'>('demo');
  const [ceStrikeOverride, setCeStrikeOverride] = useState<number | undefined>(undefined);
  const [peStrikeOverride, setPeStrikeOverride] = useState<number | undefined>(undefined);
  const [entering, setEntering] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orderResult, setOrderResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [breakevenMode, setBreakevenMode] = useState<'target' | 'expiry'>('expiry');
  const [margin, setMargin] = useState<{ total_margin: number; hedge_benefit: number; available_funds: number } | null>(null);
  const [marginLoading, setMarginLoading] = useState(false);

  // Own expiry + chain state — independent of parent's selectedExpiry
  const [pctExpiry, setPctExpiry] = useState(selectedExpiry || expiries[0]?.date || '');
  const [localChainOc, setLocalChainOc] = useState<ChainOc>(chainOc);
  const [chainLoading, setChainLoading] = useState(false);

  // Sync initial expiry once parent expiries load
  useEffect(() => {
    if (!pctExpiry && expiries.length > 0) {
      setPctExpiry(expiries[0].date);
    }
  }, [expiries, pctExpiry]);

  // Fetch chain whenever pctExpiry changes
  useEffect(() => {
    if (!pctExpiry) return;
    // Use parent's already-loaded chain if the expiry matches
    if (pctExpiry === selectedExpiry && Object.keys(chainOc).length > 0) {
      setLocalChainOc(chainOc);
      return;
    }
    setChainLoading(true);
    fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${pctExpiry}`)
      .then(r => r.json())
      .then((json: { success?: boolean; data?: { chain?: { oc?: ChainOc } } }) => {
        setLocalChainOc(json?.data?.chain?.oc ?? {});
      })
      .catch(() => setLocalChainOc({}))
      .finally(() => setChainLoading(false));
  }, [pctExpiry, selectedExpiry, chainOc]);

  // Also update when parent chain refreshes and expiry matches
  useEffect(() => {
    if (pctExpiry === selectedExpiry) {
      setLocalChainOc(chainOc);
    }
  }, [chainOc, pctExpiry, selectedExpiry]);

  const celeg = useMemo(
    () => resolveToLeg(spot, cePct, 'CE', localChainOc, lots, ceStrikeOverride),
    [spot, cePct, localChainOc, lots, ceStrikeOverride],
  );
  const peleg = useMemo(
    () => resolveToLeg(spot, pePct, 'PE', localChainOc, lots, peStrikeOverride),
    [spot, pePct, localChainOc, lots, peStrikeOverride],
  );

  const resolvedLegs = useMemo<ResolvedLeg[]>(
    () => [celeg, peleg].filter((l): l is ResolvedLeg => l !== null),
    [celeg, peleg],
  );

  const stats = useMemo(
    () => (resolvedLegs.length === 2 ? computePayoffStats(resolvedLegs, spot, effectiveLotSize, pctExpiry) : null),
    [resolvedLegs, spot, effectiveLotSize, pctExpiry],
  );

  const curve = useMemo(
    () => (resolvedLegs.length === 2 ? buildPayoffCurve(resolvedLegs, spot, effectiveLotSize) : []),
    [resolvedLegs, spot, effectiveLotSize],
  );

  const breakevens = useMemo(() => findBreakevens(curve), [curve]);

  // Fetch margin whenever resolved legs change
  useEffect(() => {
    if (resolvedLegs.length !== 2 || !pctExpiry) {
      setMargin(null);
      return;
    }
    setMarginLoading(true);
    fetch('/api/options/margin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        underlying: UNDERLYING,
        expiry: pctExpiry,
        legs: resolvedLegs.map(l => ({ strike: l.strike, type: l.type, side: l.side, qtyLots: l.qtyLots, price: l.price })),
      }),
    })
      .then(r => r.json())
      .then((json: { success?: boolean; data?: { total_margin: number; hedge_benefit: number; available_funds: number } }) => {
        setMargin(json?.success ? (json.data ?? null) : null);
      })
      .catch(() => setMargin(null))
      .finally(() => setMarginLoading(false));
  }, [resolvedLegs, pctExpiry]);

  const ceDefaultStrike = Math.round((spot * (1 + cePct / 100)) / STRIKE_STEP) * STRIKE_STEP;
  const peDefaultStrike = Math.round((spot * (1 - pePct / 100)) / STRIKE_STEP) * STRIKE_STEP;
  const ceActualStrike = ceStrikeOverride ?? ceDefaultStrike;
  const peActualStrike = peStrikeOverride ?? peDefaultStrike;
  const ceActualPct = spot > 0 ? ((ceActualStrike - spot) / spot * 100) : 0;
  const peActualPct = spot > 0 ? ((spot - peActualStrike) / spot * 100) : 0;

  const handleNudgeStrike = useCallback((type: 'CE' | 'PE', dir: 1 | -1) => {
    setOrderResult(null);
    if (type === 'CE') {
      setCeStrikeOverride(prev => (prev ?? ceDefaultStrike) + dir * STRIKE_STEP);
    } else {
      setPeStrikeOverride(prev => (prev ?? peDefaultStrike) + dir * STRIKE_STEP);
    }
  }, [ceDefaultStrike, peDefaultStrike]);

  const handleCePctChange = (v: number) => {
    setCePct(v);
    setCeStrikeOverride(undefined);
    setOrderResult(null);
  };

  const handlePePctChange = (v: number) => {
    setPePct(v);
    setPeStrikeOverride(undefined);
    setOrderResult(null);
  };

  const handleExpiryChange = (date: string) => {
    setPctExpiry(date);
    setCeStrikeOverride(undefined);
    setPeStrikeOverride(undefined);
    setOrderResult(null);
    setSaveResult(null);
  };

  const canEnter = resolvedLegs.length === 2 && resolvedLegs.every(l => l.securityId !== null) && !entering;
  const canExit = resolvedLegs.length === 2 && resolvedLegs.every(l => l.securityId !== null) && !exiting;
  const canSave = stats !== null && resolvedLegs.length === 2 && !saving;

  const handleEnterTrade = useCallback(() => {
    if (!canEnter) return;
    setEntering(true);
    setOrderResult(null);

    if (tradingType === 'demo') {
      setTimeout(() => {
        setOrderResult({ success: true, message: 'Demo strangle entered (Paper Trade).' });
        setEntering(false);
      }, 500);
      return;
    }

    // Guard: never place live orders with the fallback lot size
    if (lotSize === null) {
      setOrderResult({ success: false, message: 'Cannot enter — lot size not loaded yet. Wait a moment and retry.' });
      setEntering(false);
      return;
    }

    const legsPayload = resolvedLegs.map(l => ({
      securityId: l.securityId,
      quantity: l.qtyLots * lotSize,
      side: l.side,
    }));

    fetch('/api/options/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs: legsPayload, mode }),
    })
      .then(r => r.json())
      .then((json: { success: boolean; data?: { orderId: string }[]; error?: string }) => {
        if (json.success) {
          const ids = (json.data ?? []).map(o => o.orderId).join(', ');
          setOrderResult({ success: true, message: `Strangle entered. Order IDs: ${ids}` });
        } else {
          setOrderResult({ success: false, message: json.error ?? 'Order failed.' });
        }
      })
      .catch((err: unknown) => setOrderResult({ success: false, message: String(err) }))
      .finally(() => setEntering(false));
  }, [canEnter, tradingType, resolvedLegs, mode, lotSize]);

  const handleExitTrade = useCallback(() => {
    if (!canExit) return;
    setExiting(true);
    setOrderResult(null);

    if (tradingType === 'demo') {
      setTimeout(() => {
        setOrderResult({ success: true, message: 'Demo strangle exited (Paper Trade).' });
        setExiting(false);
      }, 500);
      return;
    }

    // Guard: never place live orders with the fallback lot size
    if (lotSize === null) {
      setOrderResult({ success: false, message: 'Cannot exit — lot size not loaded yet. Wait a moment and retry.' });
      setExiting(false);
      return;
    }

    const legsPayload = resolvedLegs.map(l => ({
      securityId: l.securityId,
      quantity: l.qtyLots * lotSize,
      side: (l.side === 'BUY' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
    }));

    fetch('/api/options/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs: legsPayload, mode }),
    })
      .then(r => r.json())
      .then((json: { success: boolean; data?: { orderId: string }[]; error?: string }) => {
        if (json.success) {
          const ids = (json.data ?? []).map(o => o.orderId).join(', ');
          setOrderResult({ success: true, message: `Strangle exited. Order IDs: ${ids}` });
        } else {
          setOrderResult({ success: false, message: json.error ?? 'Exit failed.' });
        }
      })
      .catch((err: unknown) => setOrderResult({ success: false, message: String(err) }))
      .finally(() => setExiting(false));
  }, [canExit, tradingType, resolvedLegs, mode, lotSize]);

  const handleSave = useCallback(() => {
    if (!canSave || !stats) return;
    setSaving(true);
    setSaveResult(null);

    const payload = {
      strategy_type: 'pct_strangle',
      display_name: `% Strangle (CE ${cePct}% / PE ${pePct}%)`,
      underlying: UNDERLYING,
      expiry: pctExpiry,
      mode: 'positional',
      lots,
      lot_size: effectiveLotSize,
      params: { cePct, pePct },
      entry_spot: spot,
      entry_net_premium: stats.netPremium,
      legs: resolvedLegs.map(l => ({
        strike: l.strike,
        option_type: l.type,
        side: l.side,
        qty_lots: l.qtyLots,
        entry_price: l.price,
        entry_delta: l.delta,
        security_id: l.securityId,
      })),
      notes: null,
    };

    fetch('/api/saved-strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(r => r.json())
      .then((json: { success: boolean; data?: { id?: string }; error?: string }) => {
        if (json.success) {
          setSaveResult({ success: true, message: `Strategy saved (ID: ${json.data?.id ?? '?'}).` });
        } else {
          setSaveResult({ success: false, message: json.error ?? 'Failed to save.' });
        }
      })
      .catch((err: unknown) => setSaveResult({ success: false, message: String(err) }))
      .finally(() => setSaving(false));
  }, [canSave, stats, cePct, pePct, pctExpiry, lots, spot, resolvedLegs, effectiveLotSize]);

  const expiry = pctExpiry || expiries[0]?.date || '';

  return (
    <div className="space-y-6">

      {/* Controls row */}
      <Card
        className={cn(
          'bg-card/80 backdrop-blur-sm transition-shadow',
          tradingType === 'live' && 'ring-amber-500/40 shadow-[0_0_24px_-8px_rgba(245,158,11,0.35)]',
        )}
      >
        <CardContent className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ce-pct" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Call OTM %</Label>
            <Input
              id="ce-pct"
              type="number" step="0.1" min="0.1" max="20"
              value={cePct}
              onChange={e => handleCePctChange(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
              className="h-8 w-24 text-center font-mono tabular-nums text-emerald-400"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pe-pct" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Put OTM %</Label>
            <Input
              id="pe-pct"
              type="number" step="0.1" min="0.1" max="20"
              value={pePct}
              onChange={e => handlePePctChange(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
              className="h-8 w-24 text-center font-mono tabular-nums text-rose-400"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Expiry</Label>
            <Select
              value={expiry}
              onValueChange={(v) => { if (typeof v === 'string' && v) handleExpiryChange(v); }}
            >
              <SelectTrigger size="sm" className="min-w-44 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {expiries.map(ex => (
                  <SelectItem key={ex.date} value={ex.date} className="font-mono">
                    {ex.date} · {ex.kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Lots</Label>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon-sm" aria-label="Decrease lots" onClick={() => setLots(l => Math.max(1, l - 1))}>
                <Minus />
              </Button>
              <span className="w-8 text-center font-mono text-sm tabular-nums text-white">{lots}</span>
              <Button variant="outline" size="icon-sm" aria-label="Increase lots" onClick={() => setLots(l => l + 1)}>
                <Plus />
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Mode</Label>
            <ToggleGroup
              value={[mode]}
              onValueChange={(v: unknown[]) => {
                const next = v[v.length - 1] as typeof mode | undefined;
                if (next) setMode(next);
              }}
              variant="outline"
              size="sm"
              spacing={0}
            >
              {(['intraday', 'positional'] as const).map(m => (
                <ToggleGroupItem key={m} value={m} className="capitalize aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">
                  {m}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Execution</Label>
            <ToggleGroup
              value={[tradingType]}
              onValueChange={(v: unknown[]) => {
                const next = v[v.length - 1] as typeof tradingType | undefined;
                if (next) setTradingType(next);
              }}
              variant="outline"
              size="sm"
              spacing={0}
            >
              <ToggleGroupItem value="demo" className="aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">
                Paper
              </ToggleGroupItem>
              <ToggleGroupItem value="live" className="aria-pressed:bg-amber-500/20 aria-pressed:text-amber-400">
                <Zap data-icon="inline-start" /> Live
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardContent>
      </Card>

      {/* Strike preview chips */}
      <div className="flex flex-wrap items-center gap-4">
        <div className={cn(
          'flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-semibold ring-1',
          celeg ? 'bg-emerald-500/10 ring-emerald-500/30 text-emerald-300' : 'bg-rose-950/60 ring-rose-800 text-rose-300',
        )}>
          <Badge variant="outline" className="rounded-md border-emerald-500/30 bg-emerald-500/15 text-[10px] font-bold text-emerald-400">CE SELL</Badge>
          {chainLoading
            ? <span className="text-xs text-zinc-500">loading…</span>
            : celeg
              ? <><span className="font-mono tabular-nums">{ceActualStrike}</span><span className="text-xs text-zinc-400">(+{ceActualPct.toFixed(1)}%)</span></>
              : <span className="text-xs">Strike {ceActualStrike} not in chain</span>
          }
        </div>

        <div className={cn(
          'flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-semibold ring-1',
          peleg ? 'bg-rose-500/10 ring-rose-500/30 text-rose-300' : 'bg-rose-950/60 ring-rose-800 text-rose-300',
        )}>
          <Badge variant="outline" className="rounded-md border-rose-500/30 bg-rose-500/15 text-[10px] font-bold text-rose-400">PE SELL</Badge>
          {chainLoading
            ? <span className="text-xs text-zinc-500">loading…</span>
            : peleg
              ? <><span className="font-mono tabular-nums">{peActualStrike}</span><span className="text-xs text-zinc-400">(−{peActualPct.toFixed(1)}%)</span></>
              : <span className="text-xs">Strike {peActualStrike} not in chain</span>
          }
        </div>
      </div>

      {resolvedLegs.length === 2 && resolvedLegs.some(l => l.securityId === null) && (
        <Alert className="border-amber-800/60 bg-amber-950/60 text-amber-300">
          <AlertTriangle />
          <AlertTitle className="text-xs font-semibold text-amber-300">
            One or more legs resolved without a security ID — chain data may be incomplete. Refresh or try a different expiry.
          </AlertTitle>
        </Alert>
      )}

      {/* Leg table */}
      {resolvedLegs.length > 0 && (
        <Card className="bg-card/80">
          <CardHeader className="border-b [.border-b]:pb-3">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Strategy legs</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table className="text-xs">
              <TableHeader>
                <TableRow className="bg-zinc-800 hover:bg-zinc-800">
                  <TableHead className="px-4 text-xs font-bold text-white">B/S</TableHead>
                  <TableHead className="text-xs font-bold text-white">Expiry</TableHead>
                  <TableHead className="w-40 text-center text-xs font-bold text-white">Strike</TableHead>
                  <TableHead className="text-xs font-bold text-white">Type</TableHead>
                  <TableHead className="text-xs font-bold text-white">LTP</TableHead>
                  <TableHead className="text-xs font-bold text-white">IV</TableHead>
                  <TableHead className="text-xs font-bold text-white">Delta</TableHead>
                  <TableHead className="text-xs font-bold text-white">Lots</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolvedLegs.map((leg, idx) => (
                  <TableRow key={idx} className="border-zinc-800/60">
                    <TableCell className="px-4 py-3">
                      <Badge variant="outline" className="rounded-md border-rose-500/30 bg-rose-500/10 text-[10px] font-bold text-rose-400">
                        SELL
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 font-mono text-zinc-300">{expiry}</TableCell>
                    <TableCell className="py-3">
                      <div className="flex items-center justify-center gap-1.5">
                        <Button
                          variant="outline"
                          size="icon-xs"
                          aria-label={`Decrease ${leg.type} strike`}
                          onClick={() => handleNudgeStrike(leg.type, -1)}
                        >
                          <Minus />
                        </Button>
                        <span className="w-16 text-center font-mono font-bold tabular-nums text-zinc-100">{leg.strike}</span>
                        <Button
                          variant="outline"
                          size="icon-xs"
                          aria-label={`Increase ${leg.type} strike`}
                          onClick={() => handleNudgeStrike(leg.type, 1)}
                        >
                          <Plus />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className={cn('py-3 font-mono font-semibold', leg.type === 'CE' ? 'text-emerald-400' : 'text-rose-400')}>
                      {leg.type}
                    </TableCell>
                    <TableCell className="py-3 font-mono tabular-nums text-zinc-200">₹{leg.price.toFixed(2)}</TableCell>
                    <TableCell className="py-3 font-mono tabular-nums text-zinc-400">
                      {leg.iv !== null ? `${(leg.iv * 100).toFixed(1)}%` : '—'}
                    </TableCell>
                    <TableCell className="py-3 font-mono tabular-nums text-zinc-400">
                      {leg.delta !== null ? leg.delta.toFixed(2) : '—'}
                    </TableCell>
                    <TableCell className="py-3 font-mono tabular-nums text-zinc-300">{leg.qtyLots}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Stats + payoff diagram */}
      {stats && (
        <>
          <StrategySummaryPanel
            stats={stats}
            targetBreakevens={null}
            breakevenMode={breakevenMode}
            onBreakevenModeChange={setBreakevenMode}
            margin={margin}
            marginLoading={marginLoading}
            spot={spot}
          />
          <Card className="bg-card/80">
            <CardHeader className="border-b [.border-b]:pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Payoff at expiry</CardTitle>
            </CardHeader>
            <CardContent>
              <PayoffDiagram
                curve={curve}
                currentSpot={spot}
                breakevens={breakevens}
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* Action bar */}
      {resolvedLegs.length === 2 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={handleEnterTrade}
            disabled={!canEnter}
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            <LogIn data-icon="inline-start" /> {entering ? 'Entering…' : 'Enter trade'}
          </Button>
          <Button variant="destructive" onClick={handleExitTrade} disabled={!canExit}>
            <LogOut data-icon="inline-start" /> {exiting ? 'Exiting…' : 'Exit trade'}
          </Button>
          <Button variant="outline" onClick={handleSave} disabled={!canSave}>
            <Save data-icon="inline-start" /> {saving ? 'Saving…' : 'Save strategy'}
          </Button>
          {tradingType === 'live' && (
            <span className="ms-auto inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
              <Zap className="size-3.5" /> Live — real orders will be placed
            </span>
          )}
        </div>
      )}

      {/* Result banners */}
      {orderResult && (
        <Alert
          className={cn(
            orderResult.success
              ? 'border-emerald-800/60 bg-emerald-950/60 text-emerald-300'
              : 'border-rose-800/60 bg-rose-950/60 text-rose-300',
          )}
        >
          {orderResult.success ? <CheckIcon /> : <AlertTriangle />}
          <AlertTitle className={cn('text-xs font-semibold', orderResult.success ? 'text-emerald-300' : 'text-rose-300')}>
            {orderResult.message}
          </AlertTitle>
        </Alert>
      )}
      {saveResult && (
        <Alert
          className={cn(
            saveResult.success
              ? 'border-sky-800/60 bg-sky-950/60 text-sky-300'
              : 'border-rose-800/60 bg-rose-950/60 text-rose-300',
          )}
        >
          {saveResult.success ? <CheckIcon /> : <AlertTriangle />}
          <AlertTitle className={cn('text-xs font-semibold', saveResult.success ? 'text-sky-300' : 'text-rose-300')}>
            {saveResult.message}
          </AlertTitle>
        </Alert>
      )}

    </div>
  );
}
