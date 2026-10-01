'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import type { BookSnapshot } from '@/lib/coveredCallEngine';

// Net Greeks + coverage for the NIFTYBEES covered-call book. Greek units follow
// dhan-position-greeks (chain-supplied, per unit × signed units — no lot or
// ×100 rescaling): Delta in Nifty units, Theta ₹/day, Vega ₹ per IV point,
// Gamma Δ per 1-pt Nifty move. NIFTYBEES contributes delta only.

const TXT_LABEL = 'text-[9px]';
const TXT_VALUE = 'text-[10px]';
const TXT_CAPTION = 'text-[11px]';

const fmtInt = (v: number) => Math.round(v).toLocaleString('en-IN');

export default function DeltaPanel({
  book,
  spot,
  beesLtp,
  lotSize,
}: {
  book: BookSnapshot | null;
  spot: number;
  beesLtp: number;
  lotSize: number;
}) {
  const net = book?.net;
  const deltaRupees = net && spot > 0 ? net.delta * spot : null;
  const deltaBees = deltaRupees != null && beesLtp > 0 ? deltaRupees / beesLtp : null;

  return (
    <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold text-zinc-100 uppercase tracking-wide">Greeks &amp; Coverage</div>
        <span className={cn(TXT_LABEL, 'text-zinc-500')}>chain Greeks · per unit × units</span>
      </div>

      <CoverageGauge book={book} lotSize={lotSize} />

      <div className="grid grid-cols-2 gap-2">
        <GreekTile
          label="Net Δ (Nifty units)"
          value={net?.delta ?? null}
          digits={2}
          sub={deltaRupees != null ? `₹${fmtInt(deltaRupees)} eq · ${deltaBees != null ? fmtInt(deltaBees) : '—'} BEES eq` : undefined}
        />
        <GreekTile
          label="Θ Theta (₹/day)"
          value={net?.theta ?? null}
          digits={0}
          sub="time decay earned by the short calls"
        />
        <GreekTile
          label="ν Vega (₹ / IV pt)"
          value={net?.vega ?? null}
          digits={0}
          sub="P&L if IV rises 1 point"
        />
        <GreekTile
          label="Γ Gamma (Δ / pt)"
          value={net?.gamma ?? null}
          digits={4}
          sub={net ? `Δ change on a 100-pt move: ${(net.gamma * 100).toFixed(2)}` : undefined}
        />
      </div>

      {book && (
        <div className="rounded-lg bg-zinc-900/60 px-2.5 py-2 space-y-1">
          <div className={cn(TXT_LABEL, 'text-zinc-500 uppercase font-bold')}>Delta breakdown</div>
          <Row label="NIFTYBEES (long)" value={`+${book.beesUnits.toFixed(2)}`} tone="pos" />
          <Row label="Short calls" value={book.callDelta.toFixed(2)} tone={book.callDelta < 0 ? 'neg' : 'flat'} />
          <Row label="Net" value={book.net.delta.toFixed(2)} tone={book.net.delta >= 0 ? 'pos' : 'neg'} bold />
        </div>
      )}

      {book && book.missingCount > 0 && (
        <div className={cn(TXT_VALUE, 'rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-300')}>
          {book.missingCount} call leg(s) have no chain Greeks — their delta is a Black-Scholes estimate and they are
          excluded from Theta/Vega/Gamma, so real exposure is larger than shown.
        </div>
      )}
      {book && book.unpricedCount > 0 && (
        <div className={cn(TXT_VALUE, 'rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-300')}>
          {book.unpricedCount} call leg(s) have no LTP yet — left out of the open MTM.
        </div>
      )}
    </div>
  );
}

function CoverageGauge({ book, lotSize }: { book: BookSnapshot | null; lotSize: number }) {
  const cov = book?.coverage ?? null;
  const MAX = 1.5;
  const pct = (v: number) => Math.min(100, Math.max(0, (v / MAX) * 100));
  const over = cov != null && cov > 1.0001;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={cn(TXT_LABEL, 'text-zinc-500 uppercase')}>Calls written vs holding</span>
        <span className={cn(TXT_CAPTION, 'font-mono font-bold', cov == null ? 'text-zinc-600' : over ? 'text-amber-400' : 'text-emerald-400')}>
          {cov == null ? '—' : `${(cov * 100).toFixed(0)}% of holding written`}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-zinc-900/80 border border-zinc-800 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-zinc-700/50" style={{ width: `${pct(1)}%` }} />
        <div className="absolute inset-y-0 w-px bg-zinc-400" style={{ left: `${pct(1)}%` }} />
        {cov != null && (
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full', over ? 'bg-amber-400/70' : 'bg-emerald-400/70')}
            style={{ width: `${pct(cov)}%` }}
          />
        )}
      </div>
      {book && (
        <div className={cn(TXT_VALUE, 'flex justify-between text-zinc-400 font-mono')}>
          <span>short {fmtInt(book.shortCallUnits)} u ({lotSize > 0 ? (book.shortCallUnits / lotSize).toFixed(2) : '—'} lots)</span>
          <span>holding ≈ {book.beesUnits.toFixed(1)} u ({lotSize > 0 ? (book.beesUnits / lotSize).toFixed(2) : '—'} lots)</span>
        </div>
      )}
      {book && book.uncoveredUnits > 0.5 && (
        <div className={cn(TXT_VALUE, 'text-amber-300')}>
          {book.uncoveredUnits.toFixed(1)} Nifty units of the short calls are NOT backed by NIFTYBEES — that slice is a
          naked short call with unlimited upside risk.
        </div>
      )}
    </div>
  );
}

function GreekTile({ label, value, digits, sub }: { label: string; value: number | null; digits: number; sub?: string }) {
  return (
    <div className="bg-zinc-900/60 rounded-lg px-2.5 py-1.5">
      <div className={cn(TXT_LABEL, 'text-zinc-500 uppercase')}>{label}</div>
      <div
        className={cn(
          'text-sm font-bold tabular-nums font-mono',
          value === null ? 'text-zinc-600' : value > 0 ? 'text-emerald-400' : value < 0 ? 'text-rose-400' : 'text-zinc-200',
        )}
      >
        {value === null ? '—' : `${value > 0 ? '+' : ''}${value.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits })}`}
      </div>
      {sub && <div className={cn(TXT_LABEL, 'text-zinc-500 truncate')} title={sub}>{sub}</div>}
    </div>
  );
}

function Row({ label, value, tone, bold }: { label: string; value: string; tone: 'pos' | 'neg' | 'flat'; bold?: boolean }) {
  return (
    <div className={cn(TXT_VALUE, 'flex justify-between font-mono', bold && 'font-bold border-t border-zinc-800/60 pt-1')}>
      <span className="text-zinc-400">{label}</span>
      <span className={tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-300'}>{value}</span>
    </div>
  );
}
