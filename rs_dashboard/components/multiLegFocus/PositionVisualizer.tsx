'use client';

/**
 * PositionVisualizer — where a strategy's risk sits relative to spot.
 *
 * A strike ladder: one row per strike that holds a position, highest strike on top, with puts growing
 * left and calls growing right of a centre strike column. Only occupied strikes get a row, so the chart
 * never overlaps however many legs there are. An amber divider marks where live spot sits.
 *
 * Encoding (chrome is zinc tokens only; sky/violet/amber are data colours):
 *   - bar colour = option type (CE sky, PE violet); fill = side (solid = bought, outlined = sold,
 *     dashed = planned, not filled yet). P&L green/red is reserved for P&L numbers only.
 */

import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { computeBsGreeks, calculateTimeToExpiryYears } from '@/lib/optionsMonitorMath';
import { legPnl, type MultiLegLeg } from '@/lib/multiLegFocus';

export type LadderLayout = 'vertical' | 'horizontal';
type RangePreset = 'fit' | '10' | '20' | '30';
export type BarMetric = 'lots' | 'units' | 'exposure';

export interface PositionVisualizerProps {
  strategyLabel?: string;
  underlying: string;
  basketExpiry?: string;
  legs: MultiLegLeg[];
  spot: number;
  step: number;
  lotSize: number;
  qtyMultiplier?: number;
  ltpFor: (leg: MultiLegLeg) => number;
  /** Chain IV as a fraction. When absent, Greeks are estimates at a flat IV and say so. */
  ivForStrike?: (strike: number, option: 'CE' | 'PE', expiry?: string) => number;
  /** Render the contract breakdown table under the chart. */
  showTable?: boolean;
}

interface Row {
  id: string;
  strike: number;
  option: 'CE' | 'PE';
  side: 'B' | 'S';
  lots: number;
  units: number;
  entry: number;
  ltp: number;
  /** null = no P&L to show: not filled yet, or no live price. Never a made-up zero. */
  pnl: number | null;
  planned: boolean;
  closed: boolean;
  status: string;
  expiry: string;
  iv: number;
  delta: number;
  theta: number;
  vega: number;
  distPts: number;
}

const FLAT_IV = 0.16;

const fmtMoney = (n: number) =>
  `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const fmtSigned = (n: number, digits = 1) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(digits)}`;

const fmtCompact = (n: number) => {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (a >= 100_000) return `${sign}₹${(a / 100_000).toFixed(1)}L`;
  if (a >= 1_000) return `${sign}₹${(a / 1_000).toFixed(1)}k`;
  return `${sign}₹${a.toFixed(0)}`;
};

const pnlTone = (n: number) => (n >= 0 ? 'text-emerald-400' : 'text-red-400');

function Segmented<T extends string>({
  label, value, options, onChange,
}: { label: string; value: T; options: { v: T; text: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">{label}</span>
      <div role="group" aria-label={label} className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
        {options.map(o => (
          <button
            key={o.v}
            type="button"
            aria-pressed={value === o.v}
            onClick={() => onChange(o.v)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400',
              value === o.v ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-bold text-white tabular-nums">{children}</div>
      {hint && <div className="text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

function SpotDivider({ spot }: { spot: number }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1" aria-label={`Spot ${spot}`}>
      <span className="h-px flex-1 bg-amber-400" />
      <span className="rounded-md border border-amber-400 bg-zinc-900 px-2 py-0.5 font-mono text-xs font-bold tabular-nums text-amber-300">
        Spot {spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
      </span>
      <span className="h-px flex-1 bg-amber-400" />
    </div>
  );
}

function LadderBar({
  r, ratio, dir, active, onHover, onPin,
}: {
  r: Row; ratio: number; dir: 'left' | 'right'; active: boolean;
  onHover: (id: string | null) => void; onPin: (fn: (p: string | null) => string | null) => void;
}) {
  const call = r.option === 'CE';
  const bought = r.side === 'B';
  const pin = () => onPin(p => (p === r.id ? null : r.id));
  return (
    <button
      type="button"
      aria-label={`${bought ? 'Bought' : 'Sold'} ${r.lots} lots ${r.strike} ${r.option}`}
      aria-pressed={active}
      onMouseEnter={() => onHover(r.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(r.id)}
      onBlur={() => onHover(null)}
      onClick={pin}
      className={cn('flex w-full items-center gap-2 cursor-pointer focus-visible:outline-none', dir === 'left' ? 'flex-row-reverse' : 'flex-row', r.closed && 'opacity-50')}
    >
      <span
        style={{ width: `${Math.max(ratio, 0.06) * 100}%` }}
        className={cn(
          'h-5 min-w-1.5 max-w-[calc(100%-5.5rem)] rounded border-2 transition-shadow',
          call ? 'border-sky-400' : 'border-violet-400',
          bought && !r.planned ? (call ? 'bg-sky-400' : 'bg-violet-400') : (call ? 'bg-sky-400/15' : 'bg-violet-400/15'),
          r.planned && 'border-dashed',
          active && 'ring-2 ring-zinc-200',
        )}
      />
      <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums">
        <b className="text-zinc-100">{bought ? 'B' : 'S'}{r.lots}</b>
        {r.pnl != null && <span className={cn('ml-1.5', pnlTone(r.pnl))}>{fmtCompact(r.pnl)}</span>}
      </span>
    </button>
  );
}

const COL_W = 64;
const HALF_H = 150;

function HorizontalLadder({
  ladder, spot, atm, metricOf, maxMetric, activeId, onHover, onPin,
}: {
  ladder: { m: Map<number, Row[]>; strikes: number[]; step: number };
  spot: number; atm: number; metricOf: (r: Row) => number; maxMetric: number;
  activeId: string | null;
  onHover: (id: string | null) => void;
  onPin: (fn: (p: string | null) => string | null) => void;
}) {
  const strikes = [...ladder.strikes].sort((a, b) => a - b);
  const n = strikes.length;

  // Every strike gets a column, so the axis is linear and spot sits at its exact position.
  const spotX = spot > 0 && n > 0 ? ((spot - strikes[0]) / ladder.step + 0.5) * COL_W : null;

  const bar = (r: Row, up: boolean) => {
    const call = r.option === 'CE';
    const bought = r.side === 'B';
    const active = activeId === r.id;
    const h = Math.max(metricOf(r) / maxMetric, 0.08) * (HALF_H - 26);
    return (
      <button
        key={r.id}
        type="button"
        aria-label={`${bought ? 'Bought' : 'Sold'} ${r.lots} lots ${r.strike} ${r.option}`}
        aria-pressed={active}
        onMouseEnter={() => onHover(r.id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(r.id)}
        onBlur={() => onHover(null)}
        onClick={() => onPin(p => (p === r.id ? null : r.id))}
        className={cn('flex flex-col items-center gap-1 cursor-pointer focus-visible:outline-none', up ? 'justify-end' : 'flex-col-reverse justify-end', r.closed && 'opacity-50')}
      >
        <span className="font-mono text-xs font-bold tabular-nums text-zinc-100">{bought ? 'B' : 'S'}{r.lots}</span>
        <span
          style={{ height: h }}
          className={cn(
            'w-5 rounded border-2',
            call ? 'border-sky-400' : 'border-violet-400',
            bought && !r.planned ? (call ? 'bg-sky-400' : 'bg-violet-400') : (call ? 'bg-sky-400/15' : 'bg-violet-400/15'),
            r.planned && 'border-dashed',
            active && 'ring-2 ring-zinc-200',
          )}
        />
      </button>
    );
  };

  return (
    <div className="overflow-x-auto px-2 pb-3 pt-4">
      <div className="relative" style={{ width: Math.max(n * COL_W, 320) }}>
        {/* calls above the axis */}
        <div className="flex" style={{ height: HALF_H }}>
          {strikes.map(k => (
            <div key={k} className="flex items-end justify-center gap-1" style={{ width: COL_W }}>
              {(ladder.m.get(k) ?? []).filter(r => r.option === 'CE').map(r => bar(r, true))}
            </div>
          ))}
        </div>

        {/* strike axis */}
        <div className="flex border-y border-zinc-700 bg-zinc-900">
          {strikes.map(k => (
            <div key={k} className={cn('py-1.5 text-center font-mono text-xs tabular-nums', ladder.m.has(k) ? 'font-bold text-white' : k === atm ? 'text-amber-300' : 'text-zinc-500')} style={{ width: COL_W }}>
              {k}
              {spot > 0 && ladder.m.has(k) && <div className="font-normal text-zinc-500">{fmtSigned(k - spot, 0)}</div>}
            </div>
          ))}
        </div>

        {/* puts below the axis */}
        <div className="flex" style={{ height: HALF_H }}>
          {strikes.map(k => (
            <div key={k} className="flex items-start justify-center gap-1" style={{ width: COL_W }}>
              {(ladder.m.get(k) ?? []).filter(r => r.option === 'PE').map(r => bar(r, false))}
            </div>
          ))}
        </div>

        {spotX != null && (
          <div className="pointer-events-none absolute inset-y-0" style={{ left: spotX }}>
            <div className="h-full border-l-2 border-dashed border-amber-400" />
            <span className="absolute -top-3 left-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-amber-400 bg-zinc-900 px-1.5 py-0.5 font-mono text-xs font-bold tabular-nums text-amber-300">
              Spot {spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
            </span>
          </div>
        )}
      </div>
      <p className="mt-2 px-2 text-xs text-zinc-500">Calls above the line, puts below. Every strike is shown; strikes without a position are dimmed.</p>
    </div>
  );
}

export default function PositionVisualizer({
  strategyLabel = 'Position map',
  underlying,
  basketExpiry = '',
  legs,
  spot,
  step = 50,
  lotSize,
  qtyMultiplier = 1,
  ltpFor,
  ivForStrike,
  showTable = false,
}: PositionVisualizerProps) {
  const [layout, setLayout] = useState<LadderLayout>('vertical');
  const [range, setRange] = useState<RangePreset>('fit');
  const [metric, setMetric] = useState<BarMetric>('lots');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinId, setPinId] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    return legs
      .filter(l => l.status !== 'FAILED' && (includeClosed || l.status !== 'CLOSED'))
      .map(l => {
        const expiry = l.expiry || basketExpiry;
        const ltp = ltpFor(l);
        const closed = l.status === 'CLOSED';
        const planned = l.status === 'DRAFT' || l.status === 'PLACING';
        const filled = !!l.fill && l.fill.qty > 0;
        const entry = l.fill?.avgPrice && l.fill.avgPrice > 0 ? l.fill.avgPrice : (l.price ?? 0);
        const units = ((filled ? l.fill!.qty : l.lots * lotSize) || 0) * qtyMultiplier;
        // legPnl owns the ledger rules (closed uses the exit fill, unfilled is 0); we only null the unfilled case.
        const pnl = planned || (!closed && (!filled || ltp <= 0)) ? null : legPnl(l, ltp, qtyMultiplier);

        const iv = ivForStrike?.(l.strike, l.option, expiry) || FLAT_IV;
        let delta = 0, theta = 0, vega = 0;
        if (!planned && !closed && spot > 0 && l.strike > 0) {
          const g = computeBsGreeks(l.option, spot, l.strike, calculateTimeToExpiryYears(expiry), iv, lotSize);
          const sign = l.side === 'B' ? 1 : -1;
          delta = g.delta * units * sign;
          theta = g.theta * units * sign;
          vega = g.vega * units * sign;
        }
        return {
          id: l.id, strike: l.strike, option: l.option, side: l.side, lots: l.lots, units, entry, ltp,
          pnl, planned, closed, status: l.status, expiry, iv, delta, theta, vega,
          distPts: spot > 0 ? l.strike - spot : 0,
        };
      });
  }, [legs, includeClosed, basketExpiry, lotSize, qtyMultiplier, ltpFor, ivForStrike, spot]);

  const live = useMemo(() => rows.filter(r => !r.planned && !r.closed), [rows]);

  const totals = useMemo(() => {
    const unpriced = live.filter(r => r.ltp <= 0).length;
    let pnl = 0, delta = 0, theta = 0, vega = 0, grossUnits = 0, long = 0, short = 0, exposure = 0;
    for (const r of rows) if (r.pnl != null) pnl += r.pnl;
    for (const r of live) {
      delta += r.delta; theta += r.theta; vega += r.vega;
      grossUnits += r.units;
      if (r.side === 'B') long += r.lots; else short += r.lots;
      exposure += r.units * (r.ltp > 0 ? r.ltp : r.entry);
    }
    const bias = grossUnits === 0 || Math.abs(delta) < grossUnits * 0.1 ? 'Neutral' : delta > 0 ? 'Bullish' : 'Bearish';
    return { pnl, delta, theta, vega, long, short, exposure, bias, unpriced };
  }, [rows, live]);

  const metricOf = (r: Row) => (metric === 'lots' ? r.lots : metric === 'units' ? r.units : r.units * (r.ltp > 0 ? r.ltp : r.entry));
  const maxMetric = Math.max(1, ...rows.map(metricOf));

  // Every strike from the lowest leg/spot to the highest, at the contract's step, so empty strikes
  // are visible too. Presets widen this to at least ±N strikes around ATM. Highest strike first.
  const ladder = useMemo(() => {
    const m = new Map<number, Row[]>();
    for (const r of rows) m.set(r.strike, [...(m.get(r.strike) ?? []), r]);
    const held = [...m.keys()];
    const anchor = spot > 0 ? spot : (held[0] ?? 0);
    const atmK = Math.round(anchor / step) * step;
    const n = range === 'fit' ? 0 : Number(range);
    const lo = Math.min(...held, anchor, atmK - n * step);
    const hi = Math.max(...held, anchor, atmK + n * step);
    const pad = range === 'fit' ? 3 : 0;
    const min = Math.floor(lo / step) * step - pad * step;
    const max = Math.ceil(hi / step) * step + pad * step;
    const strikes: number[] = [];
    if (held.length > 0 || spot > 0) for (let k = max; k >= min; k -= step) strikes.push(k);
    const spotAt = spot > 0 ? strikes.findIndex(k => k < spot) : -1;
    return { m, strikes, step, spotAt: spot > 0 ? (spotAt === -1 ? strikes.length : spotAt) : -1 };
  }, [rows, spot, step, range]);
  const atm = spot > 0 ? Math.round(spot / step) * step : 0;

  const inspected = rows.find(r => r.id === (hoverId ?? pinId)) ?? null;
  const flatIvNote = !ivForStrike;

  return (
    <div className="flex flex-col gap-4 text-white">
      {/* Summary strip: one hero number, the rest quiet */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <div className="col-span-2 sm:col-span-1">
          <div className="text-xs text-zinc-500 truncate">{strategyLabel}</div>
          <div className={cn('mt-0.5 font-mono text-2xl font-bold tabular-nums', pnlTone(totals.pnl))}>{fmtMoney(totals.pnl)}</div>
          <div className="text-xs text-zinc-500">
            {totals.unpriced > 0
              ? <span className="text-amber-300">{totals.unpriced} of {live.length} legs have no live price</span>
              : <>{underlying}{basketExpiry ? ` · ${basketExpiry}` : ''}</>}
          </div>
        </div>
        <Stat label="Spot" hint={atm ? `ATM ${atm}` : undefined}>
          <span className="text-amber-300">{spot > 0 ? spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}</span>
        </Stat>
        <Stat label="Net delta" hint={totals.bias}>{fmtSigned(totals.delta)}</Stat>
        <Stat label="Theta / day" hint={flatIvNote ? 'estimate' : undefined}>
          <span className={totals.theta >= 0 ? 'text-emerald-400' : 'text-zinc-200'}>{fmtCompact(totals.theta)}</span>
        </Stat>
        <Stat label="Vega / 1% IV" hint={flatIvNote ? 'estimate' : undefined}>{fmtCompact(totals.vega)}</Stat>
        <Stat label="Lots" hint="bought / sold">
          {totals.long} / {totals.short}
        </Stat>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Segmented<LadderLayout>
          label="Layout" value={layout} onChange={setLayout}
          options={[{ v: 'vertical', text: 'Vertical ladder' }, { v: 'horizontal', text: 'Horizontal line' }]}
        />
        <Segmented<RangePreset>
          label="Strikes" value={range} onChange={setRange}
          options={[{ v: 'fit', text: 'Fit' }, { v: '10', text: '±10' }, { v: '20', text: '±20' }, { v: '30', text: '±30' }]}
        />
        <Segmented<BarMetric>
          label="Height" value={metric} onChange={setMetric}
          options={[{ v: 'lots', text: 'Lots' }, { v: 'units', text: 'Qty' }, { v: 'exposure', text: 'Value' }]}
        />
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200">
          <input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} className="h-3.5 w-3.5 cursor-pointer accent-indigo-500" />
          Show closed legs
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        {/* Strike ladder */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950">
          {layout === 'horizontal' ? (
            <HorizontalLadder ladder={ladder} spot={spot} atm={atm} metricOf={metricOf} maxMetric={maxMetric}
              activeId={hoverId ?? pinId} onHover={setHoverId} onPin={setPinId} />
          ) : (
          <>
          <div className="grid grid-cols-[1fr_84px_1fr] items-center gap-3 border-b border-zinc-800 px-4 py-2.5 text-xs font-bold">
            <span className="text-right text-violet-400">Puts</span>
            <span className="text-center text-zinc-400">Strike</span>
            <span className="text-sky-400">Calls</span>
          </div>

          <div className="max-h-[560px] overflow-y-auto py-1">
            {ladder.strikes.map((strike, i) => {
              const group = ladder.m.get(strike) ?? [];
              const sides = { PE: group.filter(r => r.option === 'PE'), CE: group.filter(r => r.option === 'CE') };
              return (
                <React.Fragment key={strike}>
                  {ladder.spotAt === i && <SpotDivider spot={spot} />}
                  <div className={cn('grid grid-cols-[1fr_84px_1fr] items-center gap-3 px-4', group.length ? 'py-1.5' : 'py-0.5', strike === atm && 'bg-zinc-900')}>
                    <div className="flex flex-col items-end gap-1">
                      {sides.PE.map(r => <LadderBar key={r.id} r={r} ratio={metricOf(r) / maxMetric} dir="left" active={(hoverId ?? pinId) === r.id} onHover={setHoverId} onPin={setPinId} />)}
                    </div>
                    <div className={cn('text-center font-mono tabular-nums', group.length ? 'text-sm font-bold text-white' : 'text-xs text-zinc-500')}>
                      {strike}
                      {spot > 0 && group.length > 0 && <div className="text-xs font-normal text-zinc-500">{fmtSigned(strike - spot, 0)}</div>}
                    </div>
                    <div className="flex flex-col items-start gap-1">
                      {sides.CE.map(r => <LadderBar key={r.id} r={r} ratio={metricOf(r) / maxMetric} dir="right" active={(hoverId ?? pinId) === r.id} onHover={setHoverId} onPin={setPinId} />)}
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
            {ladder.spotAt === ladder.strikes.length && <SpotDivider spot={spot} />}
            {ladder.strikes.length === 0 && <p className="px-4 py-10 text-center text-sm text-zinc-500">No legs to show.</p>}
          </div>

          </>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-zinc-800 px-4 py-2 text-xs text-zinc-400">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-zinc-300" />Solid = bought</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm border border-zinc-300" />Outline = sold</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm border border-dashed border-zinc-300" />Dashed = not filled yet</span>
            <span className="ml-auto text-zinc-500">Bar length = {metric === 'lots' ? 'lots' : metric === 'units' ? 'quantity' : 'premium value'}</span>
          </div>
        </div>

        {/* Inspector */}
        <aside className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm" aria-live="polite">
          {inspected ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <div className="font-bold text-white">
                  {inspected.side === 'B' ? 'Bought' : 'Sold'} {inspected.strike} {inspected.option}
                </div>
                <div className="text-xs text-zinc-500">{inspected.status.toLowerCase()}</div>
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-mono text-xs tabular-nums">
                <dt className="text-zinc-500">Size</dt><dd className="text-right text-zinc-200">{inspected.lots} lots · {inspected.units}</dd>
                <dt className="text-zinc-500">Entry</dt><dd className="text-right text-zinc-200">{inspected.entry > 0 ? `₹${inspected.entry.toFixed(2)}` : '—'}</dd>
                <dt className="text-zinc-500">LTP</dt><dd className="text-right text-zinc-200">{inspected.ltp > 0 ? `₹${inspected.ltp.toFixed(2)}` : '—'}</dd>
                <dt className="text-zinc-500">P&amp;L</dt>
                <dd className={cn('text-right font-bold', inspected.pnl == null ? 'text-zinc-500' : pnlTone(inspected.pnl))}>
                  {inspected.pnl == null ? (inspected.planned ? 'not filled' : 'no live price') : fmtMoney(inspected.pnl)}
                </dd>
                <dt className="text-zinc-500">From spot</dt><dd className="text-right text-zinc-200">{spot > 0 ? `${fmtSigned(inspected.distPts, 0)} pts` : '—'}</dd>
                <dt className="text-zinc-500">Delta</dt><dd className="text-right text-zinc-200">{fmtSigned(inspected.delta, 2)}</dd>
                <dt className="text-zinc-500">Theta / day</dt><dd className="text-right text-zinc-200">{fmtCompact(inspected.theta)}</dd>
                <dt className="text-zinc-500">Vega</dt><dd className="text-right text-zinc-200">{fmtCompact(inspected.vega)}</dd>
                <dt className="text-zinc-500">IV</dt><dd className="text-right text-zinc-200">{(inspected.iv * 100).toFixed(1)}%{flatIvNote ? ' (assumed)' : ''}</dd>
              </dl>
            </>
          ) : (
            <div className="text-zinc-400">
              <div className="font-bold text-zinc-200">Select a bar</div>
              <p className="mt-1 text-xs leading-relaxed">
                Hover or click a bar to see its entry, P&amp;L and Greeks. Click again to unpin.
              </p>
              {flatIvNote && (
                <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                  Greeks are estimates at {FLAT_IV * 100}% IV. Open this from a strategy row to use live chain IV.
                </p>
              )}
            </div>
          )}
        </aside>
      </div>

      {showTable && (
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-zinc-800 text-xs font-bold text-white">
                  {['Side', 'Strike', 'Type', 'Lots', 'Qty', 'Entry', 'LTP', 'P&L', 'Status'].map(h => (
                    <th key={h} className={cn('px-4 py-2.5', ['Lots', 'Qty', 'Entry', 'LTP', 'P&L'].includes(h) && 'text-right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 font-mono tabular-nums">
                {rows.map(r => (
                  <tr
                    key={r.id}
                    onMouseEnter={() => setHoverId(r.id)}
                    onMouseLeave={() => setHoverId(null)}
                    className={cn('transition-colors', (hoverId ?? pinId) === r.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/60')}
                  >
                    <td className="px-4 py-2 font-bold text-zinc-200">{r.side === 'B' ? 'Buy' : 'Sell'}</td>
                    <td className="px-4 py-2 font-bold text-white">{r.strike}</td>
                    <td className={cn('px-4 py-2 font-bold', r.option === 'CE' ? 'text-sky-400' : 'text-violet-400')}>{r.option}</td>
                    <td className="px-4 py-2 text-right text-zinc-200">{r.lots}</td>
                    <td className="px-4 py-2 text-right text-zinc-400">{r.units}</td>
                    <td className="px-4 py-2 text-right text-zinc-300">{r.entry > 0 ? r.entry.toFixed(2) : '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-200">{r.ltp > 0 ? r.ltp.toFixed(2) : '—'}</td>
                    <td className={cn('px-4 py-2 text-right font-bold', r.pnl == null ? 'text-zinc-500' : pnlTone(r.pnl))}>
                      {r.pnl == null ? '—' : fmtMoney(r.pnl)}
                    </td>
                    <td className="px-4 py-2 text-zinc-400">{r.status.toLowerCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
