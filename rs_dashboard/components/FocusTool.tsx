'use client';

import React, {
  useState, useEffect, useCallback, useMemo,
} from 'react';
import NavBar from './NavBar';
import {
  TrendingUp, Zap, ShieldOff, Shield, Activity,
  Clock, Plus, Check, Save, Layers, Target, Lock,
} from 'lucide-react';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { useCopyTrade, CopyTradeControls, type CopyTradeApi } from './CopyTrade';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { cn } from '@/lib/utils';
import type {
  FocusToolConfig, FocusRow, FocusIndexGroup,
  FocusUnderlying, FocusDte, FocusSide, FocusRowStatus,
} from '@/lib/focusToolRows';

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const UNDERLYINGS: FocusUnderlying[] = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
const STRIKE_STEP: Record<FocusUnderlying, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 };

const FUT_LABELS: Record<FocusUnderlying, string> = {
  NIFTY: 'NIFTY FUT',
  BANKNIFTY: 'BANKNIFTY FUT',
  SENSEX: 'SENSEX FUT',
};

// NOTE: UNDERLYING_SEGMENT kept for future order-routing use
const UNDERLYING_SEGMENT: Record<FocusUnderlying, string> = {
  NIFTY: 'NSE_FNO',
  BANKNIFTY: 'NSE_FNO',
  SENSEX: 'BSE_FNO',
} as const;
void UNDERLYING_SEGMENT;

// Per-underlying accent colours for group cards
const UNDERLYING_DOT: Record<FocusUnderlying, string> = {
  NIFTY: 'bg-violet-500',
  BANKNIFTY: 'bg-sky-500',
  SENSEX: 'bg-amber-500',
};
const UNDERLYING_TXT: Record<FocusUnderlying, string> = {
  NIFTY: 'text-violet-400',
  BANKNIFTY: 'text-sky-400',
  SENSEX: 'text-amber-400',
};

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function fmtInr(n: number, signed = false): string {
  if (!Number.isFinite(n)) return '\u2014';
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '\u2212' : signed && n > 0 ? '+' : '';
  return `${sign}\u20B9${str}`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '\u2014';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function newId(): string {
  return `ft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function pnlClass(n: number | null | undefined): string {
  if (n == null || n === 0) return 'text-zinc-400';
  return n > 0 ? 'text-emerald-400' : 'text-rose-400';
}

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface PosRow {
  tradingSymbol: string;
  securityId: string;
  exchangeSegment: string;
  productType: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastTradedPrice?: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

interface FutQuote {
  ltp: number;
  change_pct: number | null;
}

interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
  detail?: string;
}

// â”€â”€ Defaults â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const makeRow = (underlying: FocusUnderlying): FocusRow => ({
  id: newId(),
  underlying,
  entryTime: '09:20',
  exitTime: '15:15',
  dte: 'Any',
  expiry: '',
  strike: null,
  lots: 1,
  side: 'BOTH',
  status: 'draft',
  levelHigh: '',
  levelLow: '',
  levelVw: false,
  slRupees: '',
  slMultiplier: '1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const makeGroup = (underlying: FocusUnderlying): FocusIndexGroup => ({
  underlying,
  enabled: false,
  atmBy: 'Spot',
  product: 'INTRADAY',
  strikesOffset: 0,
  bookExit: false,
  spotHigh: '',
  spotLow: '',
});

const DEFAULT_CONFIG: FocusToolConfig = {
  groups: UNDERLYINGS.map(makeGroup),
  rows: [],
  riskEnabled: false,
  targetRupees: '',
  stopRupees: '',
  trailEnabled: false,
  triggerRupees: '',
  lockRupees: '',
  liveRealMoney: false,
  updatedAt: new Date().toISOString(),
};

// â”€â”€ Primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function LivePulse({ active }: { active: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider border',
      active
        ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
        : 'bg-zinc-800 text-zinc-500 border-zinc-700',
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-rose-400 animate-pulse' : 'bg-zinc-600')} />
      LIVE
    </span>
  );
}

function SwitchToggle({
  checked, onChange, label,
}: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-300 cursor-pointer select-none"
    >
      <span className={cn(
        'h-4 w-7 rounded-full border transition-all flex items-center px-0.5',
        checked ? 'bg-violet-600 border-violet-600' : 'bg-zinc-800 border-zinc-700',
      )}>
        <span className={cn(
          'h-3 w-3 rounded-full bg-oncolor shadow-sm transition-transform',
          checked ? 'translate-x-3' : 'translate-x-0',
        )} />
      </span>
      {label}
    </button>
  );
}

function NumInput({ value, onChange, placeholder, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        'h-7 text-[11px] font-mono font-bold px-2 border border-zinc-700 rounded-md',
        'bg-zinc-900 text-zinc-100 placeholder-zinc-600',
        'focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/40',
        className,
      )}
    />
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative flex items-center">
      <input
        type="time"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-6 text-[10px] font-mono font-bold pl-1.5 pr-5 border border-zinc-700 rounded bg-zinc-900 text-zinc-100 focus:outline-none focus:border-violet-500 w-[72px]"
      />
      <Clock className="h-3 w-3 text-zinc-600 absolute right-1.5 pointer-events-none" />
    </div>
  );
}

function SegPill<T extends string>({
  options, value, onChange,
}: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            'text-[10px] font-bold px-2.5 py-0.5 rounded-md cursor-pointer transition-colors',
            value === o ? 'bg-violet-600 text-oncolor' : 'text-zinc-400 hover:text-zinc-200',
          )}
        >{o}</button>
      ))}
    </div>
  );
}

function GhostBtn({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 cursor-pointer transition-colors"
    >
      {children}
    </button>
  );
}

// â”€â”€ Sticky Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function FocusHeader({
  futQuotes, realised, unrealised, total, wsLive, broker, setBroker, authenticatedBrokers,
}: {
  futQuotes: Record<FocusUnderlying, FutQuote | null>;
  realised: number; unrealised: number; total: number;
  wsLive: boolean;
  broker: Broker;
  setBroker: (b: Broker) => void;
  authenticatedBrokers: Broker[];
}) {
  return (
    <div className="sticky top-0 z-40 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/25 shrink-0">
          <TrendingUp className="h-4 w-4 text-violet-400" />
        </div>
        <div>
          <p className="text-[9px] font-bold text-violet-400 uppercase tracking-[0.18em] mb-0.5">
            Options &middot; Straddles &amp; Strangles
          </p>
          <h1 className="text-sm font-bold text-white tracking-tight leading-none">Focus Tool Terminal</h1>
          <p className="text-[10px] text-zinc-500 font-medium mt-0.5">
            Multi-index straddle / strangle scheduler with level exits
          </p>
        </div>
      </div>

      {/* Centre: Futures */}
      <div className="flex items-center gap-6">
        {UNDERLYINGS.map(u => {
          const q = futQuotes[u];
          const chg = q?.change_pct;
          return (
            <div key={u} className="flex flex-col items-center">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">{FUT_LABELS[u]}</span>
              <span className="text-sm font-mono font-black text-zinc-100 tabular-nums">
                {q ? q.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '\u2014'}
              </span>
              {chg != null && (
                <span className={cn('text-[9px] font-mono font-bold', chg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                  {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                </span>
              )}
            </div>
          );
        })}
        <LivePulse active={wsLive} />
      </div>

      {/* Right: Broker Selector + P&L tiles */}
      <div className="flex items-center gap-3">
        {authenticatedBrokers.length > 1 && (
          <select
            value={broker}
            onChange={e => setBroker(e.target.value as Broker)}
            className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-violet-500 w-[90px] shrink-0"
          >
            {authenticatedBrokers.map(b => (
              <option key={b} value={b}>{BROKER_LABELS[b]}</option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-1 bg-zinc-900/80 border border-zinc-800 rounded-xl px-3 py-2">
          {([
            { label: 'REALISED', value: realised },
            { label: 'UNREALISED', value: unrealised },
            { label: 'TOTAL', value: total },
          ] as const).map(({ label, value }, i) => (
            <React.Fragment key={label}>
              {i > 0 && <div className="h-6 w-px bg-zinc-800 mx-2" />}
              <div className="flex flex-col items-end min-w-[72px]">
                <span className="text-[8px] font-bold text-zinc-500 uppercase tracking-wider">{label}</span>
                <span className={cn('text-xs font-mono font-bold tabular-nums', pnlClass(value))}>
                  {fmtInr(value, true)}
                </span>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// â”€â”€ Control Strip (Positions + Risk merged) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ControlStrip({
  liveRealMoney, onToggleLive, broker,
  onExitAll, exitingAll,
  riskEnabled, onToggleRisk,
  targetRupees, setTargetRupees,
  stopRupees, setStopRupees,
  trailEnabled, onToggleTrail,
  triggerRupees, setTriggerRupees,
  lockRupees, setLockRupees,
  onSave, saving, peakMtm, lockMtm,
  copyTrade,
}: {
  liveRealMoney: boolean; onToggleLive: () => void; broker: Broker;
  onExitAll: () => void; exitingAll: boolean;
  riskEnabled: boolean; onToggleRisk: () => void;
  targetRupees: string; setTargetRupees: (v: string) => void;
  stopRupees: string; setStopRupees: (v: string) => void;
  trailEnabled: boolean; onToggleTrail: () => void;
  triggerRupees: string; setTriggerRupees: (v: string) => void;
  lockRupees: string; setLockRupees: (v: string) => void;
  onSave: () => void; saving: boolean; peakMtm: number; lockMtm: number | null;
  copyTrade: CopyTradeApi;
}) {
  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-2.5 flex items-center gap-5 flex-wrap">
      {/* Positions section */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Positions</span>
        <button
          onClick={onToggleLive}
          className={cn(
            'flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full text-oncolor transition-colors cursor-pointer',
            liveRealMoney ? 'bg-rose-600 hover:bg-rose-500' : 'bg-zinc-700 hover:bg-zinc-600',
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-oncolor animate-pulse" />
          LIVE &middot; REAL MONEY
        </button>
        <GhostBtn onClick={onExitAll}>
          <ShieldOff className="h-3.5 w-3.5 text-rose-400" />
          Exit Rules
        </GhostBtn>
        <GhostBtn>
          <Shield className="h-3.5 w-3.5 text-violet-400" />
          Risk / MTM
        </GhostBtn>
        <GhostBtn>
          <Activity className="h-3.5 w-3.5 text-zinc-400" />
          Order Book
        </GhostBtn>
        <GhostBtn>
          <Layers className="h-3.5 w-3.5 text-zinc-400" />
          Cards
        </GhostBtn>
      </div>

      <div className="h-5 w-px bg-zinc-800" />

      {/* Risk section */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Risk</span>
        <SwitchToggle checked={riskEnabled} onChange={onToggleRisk} />

        <div className="flex items-center gap-1.5">
          <Target className="h-3 w-3 text-emerald-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Target</span>
          <NumInput value={targetRupees} onChange={setTargetRupees} className="w-16" placeholder="0" />
        </div>

        <div className="flex items-center gap-1.5">
          <ShieldOff className="h-3 w-3 text-rose-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Stop</span>
          <NumInput value={stopRupees} onChange={setStopRupees} className="w-16" placeholder="0" />
        </div>

        <div className="h-4 w-px bg-zinc-800" />

        <SwitchToggle checked={trailEnabled} onChange={onToggleTrail} label="Trail" />

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-black text-zinc-500 uppercase">Trigger</span>
          <NumInput value={triggerRupees} onChange={setTriggerRupees} className="w-16" placeholder="0" />
        </div>

        <div className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-amber-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Lock</span>
          <NumInput value={lockRupees} onChange={setLockRupees} className="w-16" placeholder="0" />
        </div>

        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1 text-xs font-bold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 transition-colors cursor-pointer disabled:opacity-50"
        >
          <Save className="h-3 w-3" /> Save
        </button>

        <span className="text-[10px] font-mono text-zinc-500">
          Peak <strong className="text-zinc-300">{peakMtm}</strong>
          <span className="mx-1.5 text-zinc-700">&middot;</span>
          Lock <strong className="text-zinc-300">{lockMtm != null ? lockMtm : '\u2014'}</strong>
        </span>
      </div>

      {/* Copy Trade Controls */}
      <CopyTradeControls copyTrade={copyTrade} />
    </div>
  );
}

// â”€â”€ Index Group Bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function IndexGroupBar({
  group, onChange, onSave, spot, liveAtm, lot, dte, wsLive,
}: {
  group: FocusIndexGroup;
  onChange: (patch: Partial<FocusIndexGroup>) => void;
  onSave: () => void;
  spot: number; liveAtm: number; lot: number | null; dte: number | null; wsLive: boolean;
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Symbol */}
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', UNDERLYING_DOT[group.underlying])} />
          <span className={cn('text-base font-black', UNDERLYING_TXT[group.underlying])}>{group.underlying}</span>
        </div>

        {/* Start/Stop */}
        <button
          onClick={() => onChange({ enabled: !group.enabled })}
          className={cn(
            'flex items-center gap-1 text-xs font-black px-3 py-1 rounded-lg text-oncolor transition-colors cursor-pointer',
            group.enabled ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500',
          )}
        >
          <Zap className="h-3 w-3" />
          {group.enabled ? 'Stop' : 'Start'}
        </button>

        {group.enabled && (
          <span className="flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Running
          </span>
        )}

        <div className="h-4 w-px bg-zinc-800" />

        {/* ATM BY */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">ATM BY</span>
          <SegPill options={['Spot', 'Fut'] as const} value={group.atmBy} onChange={v => onChange({ atmBy: v })} />
        </div>

        {/* PRODUCT */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">PRODUCT</span>
          <select
            value={group.product}
            onChange={e => onChange({ product: e.target.value as 'INTRADAY' | 'MARGIN' })}
            className="text-xs font-bold h-7 px-2 border border-zinc-700 rounded-lg bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500"
          >
            <option value="INTRADAY">MIS</option>
            <option value="MARGIN">NRML</option>
          </select>
        </div>

        {/* STRIKES Â± */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">STRIKES &plusmn;</span>
          <select
            value={group.strikesOffset}
            onChange={e => onChange({ strikesOffset: Number(e.target.value) })}
            className="text-xs font-bold h-7 px-2 border border-zinc-700 rounded-lg bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500"
          >
            {[-2, -1, 0, 1, 2].map(o => (
              <option key={o} value={o}>{o > 0 ? `+${o}` : o}</option>
            ))}
          </select>
        </div>

        {/* BOOK EXIT */}
        <SwitchToggle checked={group.bookExit} onChange={v => onChange({ bookExit: v })} label="Book Exit" />

        {group.bookExit && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black text-rose-400 uppercase">Spot H&uarr;</span>
              <NumInput value={group.spotHigh} onChange={v => onChange({ spotHigh: v })} className="w-16" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black text-emerald-400 uppercase">Spot L&darr;</span>
              <NumInput value={group.spotLow} onChange={v => onChange({ spotLow: v })} className="w-16" />
            </div>
          </div>
        )}

        <button
          onClick={onSave}
          className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 cursor-pointer transition-colors"
        >
          <Check className="h-3 w-3" /> Save
        </button>
      </div>

      {/* Right stats */}
      <div className="flex items-center gap-4">
        {([
          { label: 'SPOT', val: spot > 0 ? spot.toFixed(2) : '\u2014' },
          { label: 'ATM', val: liveAtm > 0 ? liveAtm : '\u2014' },
          { label: 'LOT', val: lot ?? '\u2014' },
          { label: 'DTE', val: dte ?? '\u2014' },
        ] as const).map(({ label, val }) => (
          <div key={label} className="flex flex-col items-center">
            <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-widest">{label}</span>
            <span className="text-xs font-mono font-bold text-zinc-200 tabular-nums">{val}</span>
          </div>
        ))}
        {wsLive && (
          <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/25 uppercase tracking-wider">
            LIVE
          </span>
        )}
      </div>
    </div>
  );
}

// ── Table Row ─────────────────────────────────────────────────────────────────

const STATUS_PILL: Record<FocusRowStatus, string> = {
  draft:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  armed:   'bg-violet-500/15 text-violet-300 border-violet-500/30',
  entered: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  exited:  'bg-zinc-700/50 text-zinc-500 border-zinc-600',
};

function FocusTableRow({
  row, live, lotSize, spot, liveRealMoney, broker,
  onUpdate, onDelete, onArm, onDisarm, onExit, onAddLot, onReduceLot,
}: {
  row: FocusRow;
  live: { ltpCe: number | null; ltpPe: number | null; cePosition: PosRow | null; pePosition: PosRow | null };
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (side: 'CE' | 'PE') => void;
  onAddLot: (side: 'CE' | 'PE') => void;
  onReduceLot: (side: 'CE' | 'PE') => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);

  return (
    <tr className="border-b border-zinc-800/60 hover:bg-zinc-800/20 transition-colors">

      {/* TIMING */}
      <td className="p-3 align-top">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-zinc-600 w-8">ENTRY</span>
            <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: v })} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-zinc-600 w-8">EXIT</span>
            <TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: v })} />
          </div>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] font-black text-zinc-600 w-8">DTE</span>
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <button
                key={d}
                onClick={() => onUpdate({ dte: d })}
                className={cn(
                  'text-[10px] font-extrabold px-2 py-0.5 rounded cursor-pointer transition-colors',
                  row.dte === d
                    ? 'bg-violet-600 text-oncolor'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200',
                )}
              >{d}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onUpdate(row, true)}
              className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors"
            >
              <Check className="h-3 w-3" /> Save
            </button>
            <button
              onClick={onDelete}
              className="text-[10px] font-bold text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors"
            >
              &times; clear
            </button>
          </div>
        </div>
      </td>

      {/* STRIKE */}
      <td className="p-3 align-middle">
        <div className="h-10 w-16 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center font-mono font-black text-violet-300 text-sm">
          {row.strike ?? '\u2014'}
        </div>
      </td>

      {/* LTP */}
      <td className="p-3 align-middle">
        <div className="text-base font-mono font-black text-zinc-100 tabular-nums">
          {combinedLtp > 0 ? combinedLtp.toFixed(2) : '\u2014'}
        </div>
        <div className="text-xs font-mono font-bold mt-0.5 flex items-center gap-1">
          <span className="text-emerald-400">CE {live.ltpCe != null ? live.ltpCe.toFixed(2) : '\u2014'}</span>
          <span className="text-zinc-700">/</span>
          <span className="text-rose-400">PE {live.ltpPe != null ? live.ltpPe.toFixed(2) : '\u2014'}</span>
        </div>
      </td>

      {/* LOTS */}
      <td className="p-3 align-middle">
        <NumInput
          value={String(row.lots)}
          onChange={v => onUpdate({ lots: Number(v) || 1 })}
          className="w-12 text-center"
        />
      </td>

      {/* SIDE */}
      <td className="p-3 align-middle">
        <SegPill
          options={['CE', 'BOTH', 'PE'] as const}
          value={row.side as 'CE' | 'BOTH' | 'PE'}
          onChange={s => onUpdate({ side: s })}
        />
      </td>

      {/* STATUS / ACTIONS */}
      <td className="p-3 align-middle border-l border-r border-zinc-800">
        <div className="flex flex-col items-start gap-2">
          <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border capitalize', STATUS_PILL[row.status])}>
            {row.status}
          </span>
          {row.status === 'draft' && (
            <button
              onClick={onArm}
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 cursor-pointer transition-colors"
            >
              Arm
            </button>
          )}
          {row.status === 'armed' && (
            <button
              onClick={onDisarm}
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600 cursor-pointer transition-colors"
            >
              Disarm
            </button>
          )}
          {row.status === 'entered' && (
            <button
              onClick={() => { onExit('CE'); onExit('PE'); }}
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors"
            >
              Exit All
            </button>
          )}
        </div>
      </td>

      {/* CE */}
      <td className="p-3 align-middle">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold text-emerald-400 tabular-nums min-w-[44px]">
            {live.ltpCe != null ? live.ltpCe.toFixed(2) : '\u2014'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => onAddLot('CE')} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors">+</button>
            <button onClick={() => onReduceLot('CE')} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors">-</button>
            <button onClick={() => onExit('CE')} className="text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors">Exit</button>
          </div>
        </div>
      </td>

      {/* PE */}
      <td className="p-3 align-middle border-r border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold text-rose-400 tabular-nums min-w-[44px]">
            {live.ltpPe != null ? live.ltpPe.toFixed(2) : '\u2014'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => onAddLot('PE')} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors">+</button>
            <button onClick={() => onReduceLot('PE')} className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors">-</button>
            <button onClick={() => onExit('PE')} className="text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors">Exit</button>
          </div>
        </div>
      </td>

      {/* LEVEL EXITS */}
      <td className="p-3 align-middle">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-black text-rose-400 w-5">H&uarr;</span>
            <NumInput value={row.levelHigh} onChange={v => onUpdate({ levelHigh: v })} className="w-20" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-black text-emerald-400 w-5">L&darr;</span>
            <NumInput value={row.levelLow} onChange={v => onUpdate({ levelLow: v })} className="w-20" />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VW" />
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-black text-amber-400">SL</span>
              <NumInput value={row.slRupees} onChange={v => onUpdate({ slRupees: v })} className="w-14" />
              <span className="text-xs font-bold text-zinc-600">&times;</span>
              <NumInput value={row.slMultiplier} onChange={v => onUpdate({ slMultiplier: v })} className="w-9" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onUpdate(row, true)}
              className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors"
            >
              <Check className="h-3 w-3" /> Save
            </button>
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, slRupees: '', slMultiplier: '1' }, true)}
              className="text-[10px] font-bold text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors"
            >
              &times; clear
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// â”€â”€ Main Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function FocusTool() {
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const copyTrade = useCopyTrade(addToast);

  const [config, setConfig] = useState<FocusToolConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);

  const [positions, setPositions] = useState<PosRow[]>([]);
  const [futQuotes, setFutQuotes] = useState<Record<FocusUnderlying, FutQuote | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
  const [spotPrices, setSpotPrices] = useState<Record<FocusUnderlying, number>>({
    NIFTY: 0, BANKNIFTY: 0, SENSEX: 0,
  });
  const [lotSizes, setLotSizes] = useState<Record<FocusUnderlying, number | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
  const [expiries, setExpiries] = useState<Record<FocusUnderlying, string[]>>({
    NIFTY: [], BANKNIFTY: [], SENSEX: [],
  });
  const [exitingAll, setExitingAll] = useState(false);
  const [peakMtm, setPeakMtm] = useState(0);
  const [lockMtm, setLockMtm] = useState<number | null>(null);

  const [riskEnabled, setRiskEnabled] = useState(config.riskEnabled);
  const [targetRupees, setTargetRupees] = useState(config.targetRupees);
  const [stopRupees, setStopRupees] = useState(config.stopRupees);
  const [trailEnabled, setTrailEnabled] = useState(config.trailEnabled);
  const [triggerRupees, setTriggerRupees] = useState(config.triggerRupees);
  const [lockRupees, setLockRupees] = useState(config.lockRupees);
  const [liveRealMoney, setLiveRealMoney] = useState(config.liveRealMoney);

  const wsExpiry = useMemo(() => {
    const niftyRow = config.rows.find(r => r.underlying === 'NIFTY' && r.expiry);
    return niftyRow?.expiry ?? expiries.NIFTY?.[0] ?? '';
  }, [config.rows, expiries.NIFTY]);

  const { liveQuotes, bridgeStatus } = useLiveOptionsWS(wsExpiry, broker, authenticatedBrokers, 'NIFTY');
  const wsLive = bridgeStatus.status === 'RUNNING';

  useEffect(() => {
    fetch('/api/focus-tool/rows')
      .then(r => r.json())
      .then((j: { success: boolean; data?: FocusToolConfig }) => {
        if (j.success && j.data) {
          const d = j.data;
          setConfig(d);
          setRiskEnabled(d.riskEnabled);
          setTargetRupees(d.targetRupees);
          setStopRupees(d.stopRupees);
          setTrailEnabled(d.trailEnabled);
          setTriggerRupees(d.triggerRupees);
          setLockRupees(d.lockRupees);
          setLiveRealMoney(d.liveRealMoney);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    UNDERLYINGS.forEach(u => {
      fetch(`/api/options/expiries?underlying=${u}&broker=${broker}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (j.success && j.data) setExpiries(prev => ({ ...prev, [u]: j.data! }));
        })
        .catch(() => {});
    });
  }, [broker]);

  useEffect(() => {
    const fetchTopIndices = () => {
      fetch('/api/scalper/top-indices')
        .then(r => r.json())
        .then((j: { success?: boolean; quotes?: Record<string, { ltp: number; change_pct: number | null }> }) => {
          if (!j.quotes) return;
          const q = j.quotes;
          const KEY_MAP: Record<string, FocusUnderlying> = {
            'NIFTY FUT': 'NIFTY', 'BANKNIFTY FUT': 'BANKNIFTY', 'SENSEX FUT': 'SENSEX',
            'NIFTY 50': 'NIFTY', 'NIFTY': 'NIFTY', 'BANKNIFTY': 'BANKNIFTY', 'SENSEX': 'SENSEX',
          };
          setFutQuotes(prev => {
            const next = { ...prev };
            for (const [key, val] of Object.entries(q)) {
              const u = KEY_MAP[key];
              if (u && val?.ltp && key.includes('FUT')) {
                next[u] = { ltp: val.ltp, change_pct: val.change_pct ?? null };
              }
            }
            return next;
          });
          setSpotPrices(prev => {
            const next = { ...prev };
            for (const [key, val] of Object.entries(q)) {
              const u = KEY_MAP[key];
              if (u && val?.ltp && !key.includes('FUT')) {
                next[u] = val.ltp;
              }
            }
            if (liveQuotes?.spot) next.NIFTY = liveQuotes.spot;
            return next;
          });
        })
        .catch(() => {});
    };
    fetchTopIndices();
    const t = setInterval(fetchTopIndices, 2000);
    return () => clearInterval(t);
  }, [broker, liveQuotes?.spot]);

  const pollPositions = useCallback(() => {
    fetch(scalperRoute(broker, 'poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: PosRow[] }) => {
        if (j.success && j.positions) {
          setPositions(j.positions.filter(p => {
            const seg = String(p.exchangeSegment ?? '').toUpperCase();
            return seg.includes('FNO') || seg.includes('FO');
          }));
        }
      })
      .catch(() => {});
  }, [broker]);

  useEffect(() => {
    pollPositions();
    const t = setInterval(pollPositions, 2000);
    return () => clearInterval(t);
  }, [pollPositions]);

  const { realised, unrealised, total } = useMemo(() => {
    let r = 0, u = 0;
    for (const p of positions) { r += Number(p.realizedProfit) || 0; u += Number(p.unrealizedProfit) || 0; }
    return { realised: r, unrealised: u, total: r + u };
  }, [positions]);

  async function saveConfig(patch?: Partial<FocusToolConfig>) {
    setSaving(true);
    try {
      const body = patch ? { ...patch } : {
        riskEnabled, targetRupees, stopRupees, trailEnabled, triggerRupees, lockRupees, liveRealMoney,
        groups: config.groups,
        rows: config.rows,
      };
      const res = await fetch('/api/focus-tool/rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j.success && j.data) {
        setConfig(j.data);
        addToast('success', 'Focus Tool configuration saved');
      } else if (j.error) {
        addToast('error', 'Failed to save config', j.error);
      }
    } catch (e) {
      addToast('error', 'Network error saving config', String(e));
    } finally {
      setSaving(false);
    }
  }

  function updateRow(id: string, patch: Partial<FocusRow>, saveToDisk = false) {
    setConfig(prev => {
      const nextRows = prev.rows.map(r => r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r);
      const nextConfig = { ...prev, rows: nextRows };
      if (saveToDisk) saveConfig(nextConfig);
      return nextConfig;
    });
  }

  function deleteRow(id: string) {
    setConfig(prev => {
      const nextRows = prev.rows.filter(r => r.id !== id);
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
    addToast('success', 'Row deleted');
  }

  function addRow(underlying: FocusUnderlying) {
    const group = config.groups.find(g => g.underlying === underlying);
    const spot = spotPrices[underlying] ?? 0;
    const step = STRIKE_STEP[underlying];
    const atm = spot > 0 ? Math.round(spot / step) * step : null;
    const offset = (group?.strikesOffset ?? 0) * step;
    const row = makeRow(underlying);
    row.expiry = expiries[underlying]?.[0] ?? '';
    row.strike = atm != null ? atm + offset : null;

    setConfig(prev => {
      const nextRows = [...prev.rows, row];
      const nextConfig = { ...prev, rows: nextRows };
      saveConfig(nextConfig);
      return nextConfig;
    });
    addToast('success', `Added ${underlying} row`);
  }

  function updateGroup(underlying: FocusUnderlying, patch: Partial<FocusIndexGroup>) {
    setConfig(prev => {
      const nextGroups = prev.groups.map(g => g.underlying === underlying ? { ...g, ...patch } : g);
      return { ...prev, groups: nextGroups };
    });
  }

  const rowsByUnderlying = useMemo<Record<FocusUnderlying, FocusRow[]>>(() => {
    const m: Record<FocusUnderlying, FocusRow[]> = { NIFTY: [], BANKNIFTY: [], SENSEX: [] };
    for (const r of config.rows) m[r.underlying].push(r);
    return m;
  }, [config.rows]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col font-sans relative">
      {/* Fixed toast overlay */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs ${
            t.type === 'success'
              ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-900/95 border-rose-500/40 text-rose-200'
          }`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      {/* Nav */}
      <div className="border-b border-zinc-800 bg-zinc-950">
        <NavBar />
      </div>

      <FocusHeader
        futQuotes={futQuotes}
        realised={realised}
        unrealised={unrealised}
        total={total}
        wsLive={wsLive}
        broker={broker}
        setBroker={setBroker}
        authenticatedBrokers={authenticatedBrokers}
      />

      <ControlStrip
        liveRealMoney={liveRealMoney} onToggleLive={() => setLiveRealMoney(v => !v)} broker={broker}
        onExitAll={() => {}} exitingAll={exitingAll}
        riskEnabled={riskEnabled} onToggleRisk={() => setRiskEnabled(v => !v)}
        targetRupees={targetRupees} setTargetRupees={setTargetRupees}
        stopRupees={stopRupees} setStopRupees={setStopRupees}
        trailEnabled={trailEnabled} onToggleTrail={() => setTrailEnabled(v => !v)}
        triggerRupees={triggerRupees} setTriggerRupees={setTriggerRupees}
        lockRupees={lockRupees} setLockRupees={setLockRupees}
        onSave={() => saveConfig()} saving={saving} peakMtm={peakMtm} lockMtm={lockMtm}
        copyTrade={copyTrade}
      />

      {/* Main */}
      <div className="flex-1 px-6 py-5 flex flex-col gap-6">
        {UNDERLYINGS.map(u => {
          const group = config.groups.find(g => g.underlying === u) ?? makeGroup(u);
          const rows = rowsByUnderlying[u];

          return (
            <div key={u} className="flex flex-col gap-3">
              <IndexGroupBar
                group={group}
                onChange={patch => updateGroup(u, patch)}
                onSave={() => saveConfig()}
                spot={spotPrices[u] ?? 0}
                liveAtm={spotPrices[u] > 0 ? Math.round(spotPrices[u] / STRIKE_STEP[u]) * STRIKE_STEP[u] : 0}
                lot={lotSizes[u]} dte={5} wsLive={wsLive}
              />

              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
                <table className="w-full border-collapse text-left">
                  <thead>
                    {/* Section group headers */}
                    <tr className="border-b border-zinc-800">
                      <th colSpan={5} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r border-zinc-700">
                        Configuration
                      </th>
                      <th className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r border-zinc-700">
                        Status
                      </th>
                      <th colSpan={3} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider">
                        Positions &amp; Exits
                      </th>
                    </tr>
                    {/* Column headers */}
                    <tr className="bg-zinc-800/50 border-b border-zinc-800 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                      <th className="p-3">Timing</th>
                      <th className="p-3">Strike</th>
                      <th className="p-3">LTP</th>
                      <th className="p-3">Lots</th>
                      <th className="p-3 border-r border-zinc-800">Side</th>
                      <th className="p-3 border-r border-zinc-800">Status / Actions</th>
                      <th className="p-3">CE</th>
                      <th className="p-3 border-r border-zinc-800">PE</th>
                      <th className="p-3">Level Exits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <FocusTableRow
                        key={row.id} row={row}
                        live={{ ltpCe: null, ltpPe: null, cePosition: null, pePosition: null }}
                        lotSize={lotSizes[u]} spot={spotPrices[u] ?? 0}
                        liveRealMoney={liveRealMoney} broker={broker}
                        onUpdate={(patch, save) => updateRow(row.id, patch, save)}
                        onDelete={() => deleteRow(row.id)}
                        onArm={() => updateRow(row.id, { status: 'armed' }, true)}
                        onDisarm={() => updateRow(row.id, { status: 'draft' }, true)}
                        onExit={() => {}} onAddLot={() => {}} onReduceLot={() => {}}
                      />
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-12 text-center">
                          <div className="flex flex-col items-center gap-2">
                            <TrendingUp className="h-8 w-8 text-zinc-700" />
                            <span className="text-sm font-semibold text-zinc-500">No rows configured</span>
                            <span className="text-xs text-zinc-600">Click &ldquo;Add Row&rdquo; to schedule a straddle or strangle entry.</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <div className="px-4 py-3 bg-zinc-900/40 border-t border-zinc-800">
                  <button
                    onClick={() => addRow(u)}
                    className="flex items-center gap-1.5 text-xs font-extrabold px-3 py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 transition-colors cursor-pointer"
                  >
                    <Plus className="h-4 w-4" /> Add Row
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

