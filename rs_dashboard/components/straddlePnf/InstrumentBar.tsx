'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import SymbolSearch from './SymbolSearch';
import { PNF_INDICES } from '@/lib/straddlePnfSearch';
import { SEGMENTS, expiryLabel, type OptSide, type Segment, type Target } from '@/lib/pnfTarget';

// The Point & Figure page's instrument picker: Index | Equity | Futures | Options, then only that segment's controls. Futures and
// options name an underlying first; the nearest expiry (and, for options, the ATM strike) is filled in from the contract list, so
// every pick ends complete. All controls are discrete (select, toggle, stepper): nothing half-typed reaches the chart.

/** `of`: the segment|underlying the list belongs to, so a list still on screen from the previous pick is never applied to a new one. */
type Contracts = { of: string; expiries: string[]; expiry?: string; strikes?: number[]; atm?: number | null; spot?: number | null };

const SEG_BTN = (on: boolean) =>
  `px-2.5 h-6 text-[11px] font-bold rounded-md transition-colors ${on ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-100'}`;
const SELECT = 'h-7 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs font-semibold text-zinc-100';
const STEP = 'inline-flex items-center justify-center h-7 w-6 border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:pointer-events-none';
const SIDES: { id: OptSide; label: string }[] = [{ id: 'CE', label: 'CE' }, { id: 'PE', label: 'PE' }, { id: 'STRADDLE', label: 'CE+PE' }];
const fmtStrike = (k: number) => k.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function InstrumentBar({ target, onSegment, onPick }: {
  target: Target;
  onSegment: (s: Segment) => void;
  onPick: (t: Target) => void;
}) {
  const fno = target.kind === 'futures' || target.kind === 'options';
  const [list, setContracts] = useState<Contracts | null>(null);
  const of = `${target.kind}|${target.symbol}`;
  const contracts = list && list.of === of ? list : null;
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const pickRef = useRef(onPick);
  useEffect(() => { pickRef.current = onPick; });

  // The contract list for the chosen underlying (and, for options, the chosen expiry's strikes + ATM).
  const optExpiry = target.kind === 'options' ? target.expiry ?? '' : '';
  useEffect(() => {
    if (!fno) return;
    const id = ++reqRef.current;
    const q = `kind=${target.kind}&underlying=${encodeURIComponent(target.symbol)}${optExpiry ? `&expiry=${optExpiry}` : ''}`;
    fetch(`/api/straddle-pnf/contracts?${q}`)
      .then(r => r.json())
      .then((j: Omit<Contracts, 'of'> & { success?: boolean; error?: string }) => {
        if (id !== reqRef.current) return;                   // a newer pick owns the pickers
        if (!j.success) { setContracts(null); setError(j.error ?? 'No contracts'); return; }
        setContracts({ ...j, of: `${target.kind}|${target.symbol}` });
        setError(null);
      })
      .catch(() => { if (id === reqRef.current) setError('Could not load the contract list'); });
  }, [fno, target.kind, target.symbol, optExpiry]);

  // Complete the target from the list: the nearest expiry when none (or a lapsed one) is set, then the ATM strike.
  useEffect(() => {
    if (!fno || !contracts || !contracts.expiries.length) return;
    if (!target.expiry || !contracts.expiries.includes(target.expiry)) {
      pickRef.current({ ...target, expiry: contracts.expiries[0] });
      return;
    }
    if (target.kind === 'options' && contracts.expiry === target.expiry && contracts.strikes?.length) {
      if (!target.strike || !contracts.strikes.includes(target.strike)) {
        const atm = contracts.atm ?? contracts.strikes[Math.floor(contracts.strikes.length / 2)];
        pickRef.current({ ...target, strike: atm, side: target.side ?? 'CE' });
      }
    }
  }, [fno, contracts, target]);

  const strikes = target.kind === 'options' && contracts?.expiry === target.expiry ? contracts?.strikes ?? [] : [];
  const kIdx = target.strike ? strikes.indexOf(target.strike) : -1;
  const stepStrike = (d: 1 | -1) => {
    const next = strikes[kIdx + d];
    if (next !== undefined) onPick({ ...target, strike: next });
  };

  return (
    <div data-testid="pnf-instrument-bar" className="flex items-center gap-2 flex-wrap min-w-0">
      <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Segment">
        {SEGMENTS.map(s => (
          <button key={s.id} type="button" aria-pressed={target.kind === s.id} onClick={() => onSegment(s.id)} className={SEG_BTN(target.kind === s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      {target.kind === 'index' && (
        <select aria-label="Index" value={target.symbol} className={SELECT}
                onChange={e => { const i = PNF_INDICES.find(x => x.symbol === e.target.value); if (i) onPick({ kind: 'index', symbol: i.symbol, name: i.name }); }}>
          {PNF_INDICES.map(i => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
        </select>
      )}

      {target.kind !== 'index' && (
        <SymbolSearch segment={target.kind} active={{ kind: target.kind, symbol: target.symbol, name: target.name }}
                      onPick={p => onPick(target.kind === 'equity'
                        ? { kind: 'equity', symbol: p.symbol, name: p.name }
                        : { kind: target.kind, symbol: p.symbol, name: p.name, ...(target.kind === 'options' ? { side: target.side ?? 'CE' } : {}) })} />
      )}

      {fno && contracts && contracts.expiries.length > 0 && (
        <select aria-label="Expiry" value={target.expiry ?? ''} className={SELECT}
                onChange={e => onPick({ ...target, expiry: e.target.value })}>
          {contracts.expiries.map(x => <option key={x} value={x}>{expiryLabel(x)}</option>)}
        </select>
      )}

      {target.kind === 'options' && strikes.length > 0 && (
        <div className="inline-flex items-center" role="group" aria-label="Strike">
          <button type="button" aria-label="Lower strike" disabled={kIdx <= 0} onClick={() => stepStrike(-1)} className={`${STEP} rounded-l-md border-r-0`}>
            <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <select aria-label="Strike price" value={target.strike ?? ''} className={`${SELECT} rounded-none font-mono tabular-nums`}
                  onChange={e => onPick({ ...target, strike: Number(e.target.value) })}>
            {strikes.map(k => <option key={k} value={k}>{fmtStrike(k)}{k === contracts?.atm ? '  · ATM' : ''}</option>)}
          </select>
          <button type="button" aria-label="Higher strike" disabled={kIdx < 0 || kIdx >= strikes.length - 1} onClick={() => stepStrike(1)} className={`${STEP} rounded-r-md border-l-0`}>
            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {target.kind === 'options' && (
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Option side">
          {SIDES.map(s => (
            <button key={s.id} type="button" aria-pressed={target.side === s.id} onClick={() => onPick({ ...target, side: s.id })} className={SEG_BTN(target.side === s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {target.kind === 'options' && contracts?.spot ? (
        <span className="text-[11px] font-mono text-zinc-400">spot <span className="font-semibold text-zinc-200">{fmtStrike(contracts.spot)}</span></span>
      ) : null}
      {error && <span role="alert" className="text-[11px] text-red-400">{error}</span>}
    </div>
  );
}
