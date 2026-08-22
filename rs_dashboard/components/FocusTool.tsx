'use client';

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import NavBar from './NavBar';
import {
  TrendingUp, Zap, ShieldOff, Shield, Activity,
  Clock, Plus, Check, Save, Layers, Target, Lock, RefreshCw, X,
} from 'lucide-react';
import { TabTable, type SortState } from './Scalper';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { closeOrderProduct, positionProduct } from '@/lib/positionProduct';
import { scaleBrokerPnl } from '@/lib/positionPnl';
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

// Order-routing vocabulary. SENSEX is the only BSE underlying here, and each
// broker spells the same exchange differently — Dhan takes a segment, Kite an
// exchange code, Neo a lower-case one.
const UNDERLYING_SEGMENT: Record<FocusUnderlying, string> = {
  NIFTY: 'NSE_FNO',
  BANKNIFTY: 'NSE_FNO',
  SENSEX: 'BSE_FNO',
} as const;

function orderExchange(broker: Broker, u: FocusUnderlying): string {
  const bse = u === 'SENSEX';
  if (broker === 'dhan')  return bse ? 'BSE_FNO' : 'NSE_FNO';
  if (broker === 'kotak') return bse ? 'bse_fo' : 'nse_fo';
  return bse ? 'BFO' : 'NFO';
}

// A group's product in each broker's own vocabulary. Sent on every order: an
// order route that receives no product defaults to intraday, and an intraday
// order against an NRML position does not reduce it — the broker opens a fresh
// intraday position on the other side instead (see the dhan-broker-positions
// skill). Reducing orders re-resolve this from the live position's own product.
const PRODUCT_ALIAS: Record<'INTRADAY' | 'MARGIN', Record<Broker, string>> = {
  INTRADAY: { dhan: 'INTRADAY', zerodha: 'MIS',  kotak: 'MIS'  },
  MARGIN:   { dhan: 'MARGIN',   zerodha: 'NRML', kotak: 'NRML' },
};

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

/** Whole days from today (IST) to `expiry`. Both sides are read as calendar
 *  dates, so this never drifts by an hour-of-day. */
function dteFor(expiry: string): number | null {
  if (!expiry) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const ms = Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** The option chain keys strikes as '24250.000000'; every other source uses
 *  '24250'. Normalise both onto the integer form before joining them. */
function strikeKey(n: number | string): string {
  return String(Math.round(Number(n)));
}

function newId(): string {
  return `ft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function pnlClass(n: number | null | undefined): string {
  if (n == null || n === 0) return 'text-zinc-400';
  return n > 0 ? 'text-emerald-400' : 'text-rose-400';
}

/** True once neither leg carries a broker quantity — safe to delete the row. */
function legsFlat(live: RowLive): boolean {
  const ceQty = Number(live.cePosition?.netQty ?? 0);
  const peQty = Number(live.pePosition?.netQty ?? 0);
  return ceQty === 0 && peQty === 0;
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

/** Per-strike order handles from /api/scalper[/<broker>]/lookup. Dhan is the
 *  only broker that trades by numeric security id; the rest trade by symbol. */
interface StrikeRef { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }
interface LookupData { lotSize: number; strikes: Record<string, StrikeRef> }

/** Spot + per-strike premiums, flattened out of /api/options/chain. */
interface ChainData {
  spot: number;
  oc: Record<string, { ce: number; pe: number }>;
}

/** Everything the table needs to draw one row live. */
interface RowLive {
  strike: number | null;
  ltpCe: number | null;
  ltpPe: number | null;
  cePosition: PosRow | null;
  pePosition: PosRow | null;
}

const EMPTY_ROW_LIVE: RowLive = {
  strike: null, ltpCe: null, ltpPe: null, cePosition: null, pePosition: null,
};

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
    <span title={active ? 'Live tick feed connected' : 'Live tick feed not running'} className={cn(
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
  checked, onChange, label, title,
}: { checked: boolean; onChange: (v: boolean) => void; label?: string; title?: string }) {
  return (
    <button
      type="button"
      title={title}
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

function NumInput({ value, onChange, placeholder, className, title }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; title?: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      title={title}
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

function TimeInput({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }) {
  return (
    <div className="relative flex items-center">
      <input
        type="time"
        title={title}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-6 text-[10px] font-mono font-bold pl-1.5 pr-5 border border-zinc-700 rounded bg-zinc-900 text-zinc-100 focus:outline-none focus:border-violet-500 w-[72px]"
      />
      <Clock className="h-3 w-3 text-zinc-600 absolute right-1.5 pointer-events-none" />
    </div>
  );
}

function SegPill<T extends string>({
  options, value, onChange, title,
}: { options: readonly T[]; value: T; onChange: (v: T) => void; title?: string }) {
  return (
    <div title={title} className="inline-flex items-center gap-0.5 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
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

function GhostBtn({ onClick, children, title }: { onClick?: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
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
            <div key={u} className="flex flex-col items-center"
              title={`${FUT_LABELS[u]} last price and % change since previous close`}>
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
            title="Broker this terminal trades and reads positions from"
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
            { label: 'REALISED', value: realised, hint: 'Booked P&L from legs already closed today' },
            { label: 'UNREALISED', value: unrealised, hint: 'Mark-to-market P&L on legs still open' },
            { label: 'TOTAL', value: total, hint: 'Realised + unrealised for the session' },
          ] as const).map(({ label, value, hint }, i) => (
            <React.Fragment key={label}>
              {i > 0 && <div className="h-6 w-px bg-zinc-800 mx-2" />}
              <div className="flex flex-col items-end min-w-[72px]" title={hint}>
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
  riskEnabled, onToggleRisk,
  targetRupees, setTargetRupees,
  stopRupees, setStopRupees,
  trailEnabled, onToggleTrail,
  triggerRupees, setTriggerRupees,
  lockRupees, setLockRupees,
  onSave, saving, peakMtm, lockMtm,
  copyTrade,
  onOpenExitRules, onOpenRisk, onOpenOrders, onToggleViewMode, viewMode,
}: {
  liveRealMoney: boolean; onToggleLive: () => void; broker: Broker;
  riskEnabled: boolean; onToggleRisk: () => void;
  targetRupees: string; setTargetRupees: (v: string) => void;
  stopRupees: string; setStopRupees: (v: string) => void;
  trailEnabled: boolean; onToggleTrail: () => void;
  triggerRupees: string; setTriggerRupees: (v: string) => void;
  lockRupees: string; setLockRupees: (v: string) => void;
  onSave: () => void; saving: boolean; peakMtm: number; lockMtm: number | null;
  copyTrade: CopyTradeApi;
  onOpenExitRules: () => void;
  onOpenRisk: () => void;
  onOpenOrders: () => void;
  onToggleViewMode: () => void;
  viewMode: 'table' | 'cards';
}) {
  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-2.5 flex items-center gap-5 flex-wrap">
      {/* Positions section */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Positions</span>
        <button
          onClick={onToggleLive}
          title={liveRealMoney
            ? 'Live: armed rows place real orders. Click to return to dry run.'
            : 'Dry run: no orders are sent. Click to go live with real money.'}
          className={cn(
            'flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full text-oncolor transition-colors cursor-pointer',
            liveRealMoney ? 'bg-rose-600 hover:bg-rose-500' : 'bg-zinc-700 hover:bg-zinc-600',
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-oncolor animate-pulse" />
          LIVE &middot; REAL MONEY
        </button>
        <GhostBtn onClick={onOpenExitRules} title="Show every exit rule that could close a row, in firing order">
          <ShieldOff className="h-3.5 w-3.5 text-rose-400" />
          Exit Rules
        </GhostBtn>
        <GhostBtn onClick={onOpenRisk} title="Account-level P&L, target, stop and trail state">
          <Shield className="h-3.5 w-3.5 text-violet-400" />
          Risk / MTM
        </GhostBtn>
        <GhostBtn onClick={onOpenOrders} title="Today's broker order book for this account">
          <Activity className="h-3.5 w-3.5 text-zinc-400" />
          Order Book
        </GhostBtn>
        <GhostBtn onClick={onToggleViewMode} title="Toggle between Table and Cards view">
          <Layers className="h-3.5 w-3.5 text-zinc-400" />
          {viewMode === 'cards' ? 'Table' : 'Cards'}
        </GhostBtn>
      </div>

      <div className="h-5 w-px bg-zinc-800" />

      {/* Risk section */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Risk</span>
        <SwitchToggle checked={riskEnabled} onChange={onToggleRisk}
          title="Enable the account-wide target and stop below" />

        <div className="flex items-center gap-1.5">
          <Target className="h-3 w-3 text-emerald-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Target</span>
          <NumInput value={targetRupees} onChange={setTargetRupees} className="w-16" placeholder="0"
            title="Close every open row once total P&L reaches this profit (₹)" />
        </div>

        <div className="flex items-center gap-1.5">
          <ShieldOff className="h-3 w-3 text-rose-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Stop</span>
          <NumInput value={stopRupees} onChange={setStopRupees} className="w-16" placeholder="0"
            title="Close every open row once total P&L falls to this loss (₹)" />
        </div>

        <div className="h-4 w-px bg-zinc-800" />

        <SwitchToggle checked={trailEnabled} onChange={onToggleTrail} label="Trail"
          title="Ratchet a profit floor upward as P&L makes new peaks" />

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-black text-zinc-500 uppercase">Trigger</span>
          <NumInput value={triggerRupees} onChange={setTriggerRupees} className="w-16" placeholder="0"
            title="Profit (₹) at which the trail wakes up and starts locking" />
        </div>

        <div className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-amber-500" />
          <span className="text-[10px] font-black text-zinc-500 uppercase">Lock</span>
          <NumInput value={lockRupees} onChange={setLockRupees} className="w-16" placeholder="0"
            title="Profit (₹) kept back from each new peak — the floor that never falls" />
        </div>

        <button
          onClick={onSave}
          disabled={saving}
          title="Save the risk and trail settings"
          className="flex items-center gap-1 text-xs font-bold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 transition-colors cursor-pointer disabled:opacity-50"
        >
          <Save className="h-3 w-3" /> Save
        </button>

        <span className="text-[10px] font-mono text-zinc-500"
          title="Peak: best total P&L so far today. Lock: the floor the trail is currently holding.">
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
          title={group.enabled
            ? `Stop watching ${group.underlying} - armed rows stop entering`
            : `Start watching ${group.underlying} so armed rows can enter`}
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
          <SegPill options={['Spot', 'Fut'] as const} value={group.atmBy} onChange={v => onChange({ atmBy: v })}
            title="Pick the ATM strike off the index spot or off the future" />
        </div>

        {/* PRODUCT */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">PRODUCT</span>
          <select
            value={group.product}
            title="MIS is intraday and auto-squares off; NRML carries overnight"
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
            title="Strikes away from ATM: 0 is a straddle, plus/minus n a strangle n steps wide"
            onChange={e => onChange({ strikesOffset: Number(e.target.value) })}
            className="text-xs font-bold h-7 px-2 border border-zinc-700 rounded-lg bg-zinc-900 text-zinc-200 focus:outline-none focus:border-violet-500"
          >
            {[-2, -1, 0, 1, 2].map(o => (
              <option key={o} value={o}>{o > 0 ? `+${o}` : o}</option>
            ))}
          </select>
        </div>

        {/* BOOK EXIT */}
        <SwitchToggle checked={group.bookExit} onChange={v => onChange({ bookExit: v })} label="Book Exit"
          title="Close every row in this index when spot hits the levels below" />

        {group.bookExit && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black text-rose-400 uppercase">Spot H&uarr;</span>
              <NumInput value={group.spotHigh} onChange={v => onChange({ spotHigh: v })} className="w-16"
                title="Book out when spot trades at or above this level" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black text-emerald-400 uppercase">Spot L&darr;</span>
              <NumInput value={group.spotLow} onChange={v => onChange({ spotLow: v })} className="w-16"
                title="Book out when spot trades at or below this level" />
            </div>
          </div>
        )}

        <button
          onClick={onSave}
          title="Save this index's settings"
          className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 cursor-pointer transition-colors"
        >
          <Check className="h-3 w-3" /> Save
        </button>
      </div>

      {/* Right stats */}
      <div className="flex items-center gap-4">
        {([
          { label: 'SPOT', hint: 'Current index level', val: spot > 0 ? spot.toFixed(2) : '\u2014' },
          { label: 'ATM', hint: 'Nearest strike to spot right now', val: liveAtm > 0 ? liveAtm : '\u2014' },
          { label: 'LOT', hint: 'Contracts in one lot of this index', val: lot ?? '\u2014' },
          { label: 'DTE', hint: 'Days to the nearest expiry', val: dte ?? '\u2014' },
        ] as const).map(({ label, val, hint }) => (
          <div key={label} className="flex flex-col items-center" title={hint}>
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
  row, live, lotSize, spot, liveRealMoney, broker, busy,
  onUpdate, onDelete, onArm, onDisarm, onExit, onAddLot, onReduceLot,
}: {
  row: FocusRow;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onAddLot: (leg: 'CE' | 'PE') => void;
  onReduceLot: (leg: 'CE' | 'PE') => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  // Orders are only sendable once the contract and its lot size are known.
  const canTrade = liveRealMoney && !busy && live.strike != null && (lotSize ?? 0) > 0;
  const flat = legsFlat(live);

  return (
    <tr className="border-b border-zinc-800/60 hover:bg-zinc-800/20 transition-colors">

      {/* TIMING */}
      <td className="p-3 align-top">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-zinc-600 w-8">ENTRY</span>
            <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: v })}
              title="Time of day this row enters, once armed" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-zinc-600 w-8">EXIT</span>
            <TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: v })}
              title="Time of day this row closes, whatever the P&L" />
          </div>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] font-black text-zinc-600 w-8"
              title="Only enter when the nearest expiry is this many days away">DTE</span>
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <button
                key={d}
                onClick={() => onUpdate({ dte: d })}
                title={d === 'Any' ? 'Enter on any expiry' : `Enter only when expiry is ${d} day(s) away`}
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
              title="Save this row's timing settings"
              className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors"
            >
              <Check className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </td>

      {/* STRIKE */}
      <td className="p-3 align-middle">
        <div title="Strike this row will trade, picked at entry"
          className="h-10 w-16 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center font-mono font-black text-violet-300 text-sm">
          {live.strike ?? row.strike ?? '\u2014'}
        </div>
      </td>

      {/* LTP */}
      <td className="p-3 align-middle">
        <div title="Combined CE + PE premium right now"
          className="text-base font-mono font-black text-zinc-100 tabular-nums">
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
          title="Lots to trade per leg"
        />
      </td>

      {/* SIDE */}
      <td className="p-3 align-middle">
        <SegPill
          options={['CE', 'BOTH', 'PE'] as const}
          value={row.side as 'CE' | 'BOTH' | 'PE'}
          title="Which legs to trade: call only, put only, or both"
          onChange={s => onUpdate({ side: s })}
        />
      </td>

      {/* STATUS / ACTIONS */}
      <td className="p-3 align-middle border-l border-r border-zinc-800">
        <div className="flex flex-col items-start gap-2">
          <span title="Draft: not watched. Armed: waiting to enter. Entered: position open. Exited: done."
            className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border capitalize', STATUS_PILL[row.status])}>
            {row.status}
          </span>
          {row.status === 'draft' && (
            <button
              onClick={onArm}
              title="Watch this row and enter it at its entry time"
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500 cursor-pointer transition-colors"
            >
              Arm
            </button>
          )}
          {row.status === 'armed' && (
            <button
              onClick={onDisarm}
              title="Stop watching this row - it will not enter"
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600 cursor-pointer transition-colors"
            >
              Disarm
            </button>
          )}
          {row.status === 'entered' && (
            <button
              onClick={() => onExit('ALL')}
              disabled={!canTrade}
              title="Close every leg of this row at market"
              className="text-xs font-extrabold px-3 py-1 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors"
            >
              Exit All
            </button>
          )}
          {flat ? (
            <button
              onClick={onDelete}
              title="Delete this row"
              className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 hover:text-rose-400 cursor-pointer transition-colors"
            >
              <X className="h-3 w-3" /> Delete
            </button>
          ) : (
            <span
              title="Exit the CE/PE legs before this row can be deleted"
              className="flex items-center gap-1 text-[10px] font-bold text-zinc-700 cursor-not-allowed"
            >
              <X className="h-3 w-3" /> Delete
            </span>
          )}
        </div>
      </td>

      {/* CE */}
      <td className="p-3 align-middle">
        <div className="flex items-center gap-2">
          <span title="Live premium of the call leg"
            className="text-sm font-mono font-bold text-emerald-400 tabular-nums min-w-[44px]">
            {live.ltpCe != null ? live.ltpCe.toFixed(2) : '\u2014'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => onAddLot('CE')} title="Add one lot to the CE leg" className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors">+</button>
            <button onClick={() => onReduceLot('CE')} title="Reduce the CE leg by one lot" className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors">-</button>
            <button onClick={() => onExit('CE')} title="Close the CE leg at market" className="text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors">Exit</button>
          </div>
        </div>
      </td>

      {/* PE */}
      <td className="p-3 align-middle border-r border-zinc-800">
        <div className="flex items-center gap-2">
          <span title="Live premium of the put leg"
            className="text-sm font-mono font-bold text-rose-400 tabular-nums min-w-[44px]">
            {live.ltpPe != null ? live.ltpPe.toFixed(2) : '\u2014'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => onAddLot('PE')} title="Add one lot to the PE leg" className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 hover:border-violet-600 hover:text-oncolor cursor-pointer transition-colors">+</button>
            <button onClick={() => onReduceLot('PE')} title="Reduce the PE leg by one lot" className="h-6 w-6 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer transition-colors">-</button>
            <button onClick={() => onExit('PE')} title="Close the PE leg at market" className="text-xs font-bold px-2 py-1 rounded-md bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer transition-colors">Exit</button>
          </div>
        </div>
      </td>

      {/* LEVEL EXITS */}
      <td className="p-3 align-middle">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-black text-rose-400 w-5">H&uarr;</span>
            <NumInput value={row.levelHigh} onChange={v => onUpdate({ levelHigh: v })} className="w-20"
              title="Exit this row when spot trades at or above this level" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-black text-emerald-400 w-5">L&darr;</span>
            <NumInput value={row.levelLow} onChange={v => onUpdate({ levelLow: v })} className="w-20"
              title="Exit this row when spot trades at or below this level" />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VW"
              title="Exit when the combined premium crosses its session VWAP against you" />
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-black text-amber-400">SL</span>
              <NumInput value={row.slRupees} onChange={v => onUpdate({ slRupees: v })} className="w-14"
                title="Exit at this rupee loss on the pair" />
              <span className="text-xs font-bold text-zinc-600">&times;</span>
              <NumInput value={row.slMultiplier} onChange={v => onUpdate({ slMultiplier: v })} className="w-9"
                title="Exit when premium moves this multiple against you (must be above 1)" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onUpdate(row, true)}
              title="Save this row's level exits"
              className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded hover:bg-emerald-500/10 cursor-pointer transition-colors"
            >
              <Check className="h-3 w-3" /> Save
            </button>
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, slRupees: '', slMultiplier: '1' }, true)}
              title="Clear every level exit on this row"
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

// ── Card view for a single row ────────────────────────────────────────────────

function FocusRowCard({
  row, live, lotSize, spot, liveRealMoney, broker, busy,
  onUpdate, onDelete, onArm, onDisarm, onExit, onAddLot, onReduceLot,
}: {
  row: FocusRow;
  live: RowLive;
  lotSize: number | null; spot: number; liveRealMoney: boolean; broker: Broker;
  busy: boolean;
  onUpdate: (patch: Partial<FocusRow>, saveToDisk?: boolean) => void;
  onDelete: () => void; onArm: () => void; onDisarm: () => void;
  onExit: (leg: 'CE' | 'PE' | 'ALL') => void;
  onAddLot: (leg: 'CE' | 'PE') => void;
  onReduceLot: (leg: 'CE' | 'PE') => void;
}) {
  const combinedLtp = (live.ltpCe ?? 0) + (live.ltpPe ?? 0);
  const canTrade = liveRealMoney && !busy && live.strike != null && (lotSize ?? 0) > 0;
  const flat = legsFlat(live);

  return (
    <div className={cn(
      'rounded-xl border bg-zinc-900/60 p-4 flex flex-col gap-3',
      row.status === 'entered' ? 'border-emerald-500/30' : 'border-zinc-800 hover:border-zinc-700/60'
    )}>
      {/* Header Info */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
        <div className="flex flex-col">
          <span className="text-xs font-bold text-white tracking-wide">{row.underlying}</span>
          <span className="text-[10px] text-zinc-500 font-mono mt-0.5">
            {row.side} &middot; {row.lots} Lot{row.lots > 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded-full border capitalize', STATUS_PILL[row.status])}>
            {row.status}
          </span>
          <button
            onClick={onDelete}
            disabled={!flat}
            title={flat ? 'Delete this row' : 'Exit the CE/PE legs before this row can be deleted'}
            className="text-zinc-600 hover:text-rose-400 disabled:hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 font-bold text-xs p-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Timing and DTE */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-black text-zinc-500 w-9">ENTRY</span>
          <TimeInput value={row.entryTime} onChange={v => onUpdate({ entryTime: v })} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-black text-zinc-500 w-9">EXIT</span>
          <TimeInput value={row.exitTime} onChange={v => onUpdate({ exitTime: v })} />
        </div>
        <div className="col-span-2 flex items-center gap-1.5 mt-0.5">
          <span className="text-[8px] font-black text-zinc-500 w-9">DTE</span>
          <div className="flex gap-1">
            {(['Any', '0', '1', '0+1'] as FocusDte[]).map(d => (
              <button
                key={d}
                onClick={() => onUpdate({ dte: d })}
                className={cn(
                  'text-[9px] font-extrabold px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                  row.dte === d ? 'bg-violet-600 text-oncolor' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
                )}
              >{d}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Strike and LTP details */}
      <div className="flex items-center justify-between bg-zinc-950/20 rounded-xl p-3 border border-zinc-800/40">
        <div className="flex flex-col">
          <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider">Strike</span>
          <span className="font-mono font-bold text-zinc-200 text-sm mt-0.5">{live.strike ?? row.strike ?? '—'}</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[8px] font-black text-zinc-500 uppercase tracking-wider">Premium</span>
          <span className="text-sm font-mono font-black text-zinc-100 mt-0.5">{combinedLtp > 0 ? combinedLtp.toFixed(2) : '—'}</span>
        </div>
      </div>

      {/* CE and PE Legs */}
      <div className="flex flex-col gap-2 bg-zinc-950/20 border border-zinc-800/40 rounded-xl p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-emerald-400">CE</span>
            <span className="text-xs font-mono font-bold text-zinc-300">{live.ltpCe != null ? live.ltpCe.toFixed(2) : '—'}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => onAddLot('CE')} title="Add CE lot" className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 cursor-pointer">+</button>
            <button onClick={() => onReduceLot('CE')} title="Reduce CE lot" className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer">-</button>
            <button onClick={() => onExit('CE')} title="Exit CE leg" className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer">Exit</button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-rose-400">PE</span>
            <span className="text-xs font-mono font-bold text-zinc-300">{live.ltpPe != null ? live.ltpPe.toFixed(2) : '—'}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => onAddLot('PE')} title="Add PE lot" className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-violet-600 cursor-pointer">+</button>
            <button onClick={() => onReduceLot('PE')} title="Reduce PE lot" className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 font-bold flex items-center justify-center hover:bg-zinc-700 cursor-pointer">-</button>
            <button onClick={() => onExit('PE')} title="Exit PE leg" className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-oncolor hover:bg-rose-500 cursor-pointer">Exit</button>
          </div>
        </div>
      </div>

      {/* Level Exits */}
      <div className="flex flex-col gap-1 text-[11px]">
        <div className="flex justify-between items-center">
          <span className="text-rose-400 text-[9px] font-black">H&uarr;</span>
          <NumInput value={row.levelHigh} onChange={v => onUpdate({ levelHigh: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-emerald-400 text-[9px] font-black">L&darr;</span>
          <NumInput value={row.levelLow} onChange={v => onUpdate({ levelLow: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-amber-400 text-[9px] font-black">SL ₹</span>
          <NumInput value={row.slRupees} onChange={v => onUpdate({ slRupees: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-amber-500 text-[9px] font-black">SL &times;</span>
          <NumInput value={row.slMultiplier} onChange={v => onUpdate({ slMultiplier: v })} className="w-20 h-6" />
        </div>
        <div className="flex justify-between items-center mt-1">
          <SwitchToggle checked={row.levelVw} onChange={v => onUpdate({ levelVw: v })} label="VW" />
          <div className="flex gap-2">
            <button
              onClick={() => onUpdate(row, true)}
              className="text-[9px] font-bold text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded hover:bg-emerald-500/10"
            >
              Save Exits
            </button>
            <button
              onClick={() => onUpdate({ levelHigh: '', levelLow: '', levelVw: false, slRupees: '', slMultiplier: '1' }, true)}
              className="text-[9px] text-zinc-500 hover:text-zinc-400"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Row Control Actions */}
      <div className="flex justify-end gap-2 border-t border-zinc-800/80 pt-2.5 mt-1">
        {row.status === 'draft' && (
          <button onClick={onArm} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-oncolor hover:bg-violet-500">
            Arm Row
          </button>
        )}
        {row.status === 'armed' && (
          <button onClick={onDisarm} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600">
            Disarm
          </button>
        )}
        {row.status === 'entered' && (
          <button onClick={() => onExit('ALL')} disabled={!canTrade} className="text-xs font-extrabold px-3 py-1.5 rounded-lg bg-rose-600 text-oncolor hover:bg-rose-500 disabled:opacity-40">
            Exit All
          </button>
        )}
      </div>
    </div>
  );
}

// ── Side Drawer Modal ────────────────────────────────────────────────────────

function FocusModal({
  isOpen,
  onClose,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-oncolor-dark/70 backdrop-blur-sm transition-opacity">
      <div className="h-full w-full max-w-xl bg-zinc-900 border-l border-zinc-800 p-6 flex flex-col gap-4 shadow-2xl text-white overflow-y-auto">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white text-lg font-bold p-1 cursor-pointer"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

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
  const { realised, unrealised, total } = useMemo(() => {
    let r = 0, u = 0;
    for (const p of positions) { r += Number(p.realizedProfit) || 0; u += Number(p.unrealizedProfit) || 0; }
    return { realised: r, unrealised: u, total: r + u };
  }, [positions]);
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
  const [lookups, setLookups] = useState<Record<FocusUnderlying, LookupData | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
  const [chains, setChains] = useState<Record<FocusUnderlying, ChainData | null>>({
    NIFTY: null, BANKNIFTY: null, SENSEX: null,
  });
  // Rows with an order in flight — their leg buttons are disabled so a
  // double-click cannot send the same market order twice.
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  const [peakMtm, setPeakMtm] = useState(0);
  const [lockMtm, setLockMtm] = useState<number | null>(null);

  const [activeModal, setActiveModal] = useState<'exit-rules' | 'risk' | 'orderbook' | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderSort, setOrderSort] = useState<SortState>({ key: 'createTime', dir: 'desc' });

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
          // Spot only. This endpoint has no futures rows at all — the header's
          // futures strip is served by /api/focus-tool/futures below — and it
          // dropped SENSEX in favour of CRUDEOIL, so SENSEX spot comes off its
          // option chain instead (see the chain effect).
          const KEY_MAP: Record<string, FocusUnderlying> = {
            'NIFTY 50': 'NIFTY', 'NIFTY': 'NIFTY', 'BANKNIFTY': 'BANKNIFTY', 'SENSEX': 'SENSEX',
          };
          setSpotPrices(prev => {
            const next = { ...prev };
            for (const [key, val] of Object.entries(q)) {
              const u = KEY_MAP[key];
              if (u && val?.ltp) {
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

  // ── Futures strip ───────────────────────────────────────────────
  // /api/focus-tool/futures exists precisely for this header: futures contract
  // ids expire, so it resolves them once per IST day and then quotes them off
  // Dhan's batched OHLC endpoint. It serves LTP only, deliberately — Dhan's
  // `close` flips to today's at the 15:30 bell, so any % built on it reads
  // 0.00% after hours. The header hides the % when it is null.
  useEffect(() => {
    const fetchFuts = () => {
      fetch('/api/focus-tool/futures')
        .then(r => r.json())
        .then((j: { quotes?: Record<string, number> }) => {
          if (!j.quotes) return;
          setFutQuotes(prev => {
            const next = { ...prev };
            for (const u of UNDERLYINGS) {
              const ltp = Number(j.quotes?.[u] ?? 0);
              if (ltp > 0) next[u] = { ltp, change_pct: null };
            }
            return next;
          });
        })
        .catch(() => {});
    };
    fetchFuts();
    const t = setInterval(fetchFuts, 3000);
    return () => clearInterval(t);
  }, []);

  // The nearest expiry per underlying, as a scalar dep. `expiries` is replaced
  // wholesale on every fetch, so depending on the object itself would re-run
  // these effects on every poll even when nothing changed.
  const expiryKey = UNDERLYINGS.map(u => expiries[u]?.[0] ?? '').join('|');

  // ── Lot sizes + per-strike order handles ────────────────────────
  // One lookup per underlying per expiry: it carries the lot size AND the
  // ce/pe security ids (Dhan) or trading symbols (everyone else) that the leg
  // buttons need to place an order.
  const lookupSeq = React.useRef(0);
  useEffect(() => {
    const seq = ++lookupSeq.current;
    UNDERLYINGS.forEach(u => {
      const expiry = expiries[u]?.[0];
      if (!expiry) return;
      fetch(`${scalperRoute(broker, 'lookup')}?underlying=${u}&expiry=${expiry}`)
        .then(r => r.json())
        .then((j: { success?: boolean; data?: LookupData }) => {
          // Out-of-order guard: a slow lookup for the previous broker must not
          // land on top of the current one's — those ids place orders.
          if (seq !== lookupSeq.current) return;
          if (!j.success || !j.data?.strikes) return;
          setLookups(prev => ({ ...prev, [u]: j.data! }));
          if (Number(j.data.lotSize) > 0) {
            setLotSizes(prev => ({ ...prev, [u]: Number(j.data!.lotSize) }));
          }
        })
        .catch(() => {});
    });
  }, [broker, expiryKey]);

  // ── Option premiums ─────────────────────────────────────────────
  // The chain is the LTP source for every underlying, and the spot source for
  // SENSEX. NIFTY additionally has the tick bridge (useLiveOptionsWS), which is
  // preferred per-strike below because it is realtime; the chain route caches
  // 10s and is paced ~1 call/3s per underlying account-wide, so it is polled at
  // that cadence and only for underlyings that actually have rows.
  const activeUnderlyings = UNDERLYINGS.filter(u => config.rows.some(r => r.underlying === u));
  const activeKey = activeUnderlyings.join('|');
  const chainSeq = React.useRef(0);
  useEffect(() => {
    if (!activeKey) return;
    const seq = ++chainSeq.current;
    const fetchChains = () => {
      activeKey.split('|').forEach(name => {
        const u = name as FocusUnderlying;
        const expiry = expiries[u]?.[0];
        if (!expiry) return;
        fetch(`/api/options/chain?underlying=${u}&expiry=${expiry}&broker=${broker}`)
          .then(r => r.json())
          .then((j: {
            success?: boolean;
            data?: { chain?: { last_price?: number; oc?: Record<string, {
              ce?: { last_price?: number }; pe?: { last_price?: number };
            }> } };
          }) => {
            if (seq !== chainSeq.current) return;
            const oc = j.data?.chain?.oc;
            // A failed chain fetch surfaces as 200 OK with no `oc`. Holding the
            // last good chain beats blanking every premium on one 429.
            if (!j.success || !oc) return;
            const flat: ChainData['oc'] = {};
            for (const [k, v] of Object.entries(oc)) {
              flat[strikeKey(k)] = {
                ce: Number(v.ce?.last_price ?? 0),
                pe: Number(v.pe?.last_price ?? 0),
              };
            }
            setChains(prev => ({ ...prev, [u]: { spot: Number(j.data?.chain?.last_price ?? 0), oc: flat } }));
          })
          .catch(() => {});
      });
    };
    fetchChains();
    const t = setInterval(fetchChains, 3000);
    return () => clearInterval(t);
  }, [broker, expiryKey, activeKey]);

  const pollPositions = useCallback(() => {
    fetch(scalperRoute(broker, 'poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: PosRow[] }) => {
        if (j.success && j.positions) {
          setPositions(j.positions
            .filter(p => {
              const seg = String(p.exchangeSegment ?? '').toUpperCase();
              return seg.includes('FNO') || seg.includes('FO');
            })
            // A no-op for NSE/BSE F&O, but applied at the pipeline entrance so
            // it cannot be forgotten if a commodity row ever reaches here.
            .map(p => scaleBrokerPnl(p as any) as PosRow));
        }
      })
      .catch(() => {});
  }, [broker]);

  const fetchOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const res = await fetch(scalperRoute(broker, 'orders'));
      const j = await res.json();
      if (j.success && j.data) {
        setOrders(j.data);
      } else {
        setOrdersError(j.error ?? 'Failed to fetch orders');
      }
    } catch (e) {
      setOrdersError(String(e));
    } finally {
      setOrdersLoading(false);
    }
  }, [broker]);

  useEffect(() => {
    if (activeModal === 'orderbook') {
      fetchOrders();
    }
  }, [activeModal, fetchOrders]);

  useEffect(() => {
    if (total > 0) {
      setPeakMtm(prev => Math.max(prev, total));
    }
  }, [total]);

  useEffect(() => {
    const trigger = Number(triggerRupees) || 0;
    const lock = Number(lockRupees) || 0;
    if (trailEnabled && trigger > 0 && peakMtm >= trigger) {
      setLockMtm(peakMtm - lock);
    } else {
      setLockMtm(null);
    }
  }, [trailEnabled, triggerRupees, lockRupees, peakMtm]);

  const underlyingPnl = useMemo(() => {
    let nifty = 0, banknifty = 0, sensex = 0;
    for (const pos of positions) {
      const pnl = (Number(pos.realizedProfit) || 0) + (Number(pos.unrealizedProfit) || 0);
      const sym = String(pos.tradingSymbol || '').toUpperCase();
      if (sym.startsWith('NIFTY')) nifty += pnl;
      else if (sym.startsWith('BANKNIFTY')) banknifty += pnl;
      else if (sym.startsWith('SENSEX')) sensex += pnl;
    }
    return { NIFTY: nifty, BANKNIFTY: banknifty, SENSEX: sensex };
  }, [positions]);

  useEffect(() => {
    pollPositions();
    const t = setInterval(pollPositions, 2000);
    return () => clearInterval(t);
  }, [pollPositions]);

  // Spot per underlying: the top-indices poll covers NIFTY and BANKNIFTY; the
  // chain's own last_price covers SENSEX, which that endpoint no longer serves.
  const spots = useMemo<Record<FocusUnderlying, number>>(() => {
    const out = { ...spotPrices };
    for (const u of UNDERLYINGS) {
      if (!(out[u] > 0)) out[u] = Number(chains[u]?.spot ?? 0);
    }
    return out;
  }, [spotPrices, chains]);

  /**
   * Per-row strike, premiums and live broker positions, keyed by row id.
   *
   * Strike: a row that has entered keeps the strike it was stamped with at
   * entry (addRow already bakes the group's ± offset into it); a draft row
   * tracks the live ATM so the table shows what it *would* trade right now.
   *
   * Premium: the NIFTY tick bridge first when it is on this row's expiry —
   * it is realtime, where the chain route caches 10s — then the chain.
   */
  const rowLive = useMemo<Record<string, RowLive>>(() => {
    const out: Record<string, RowLive> = {};
    for (const row of config.rows) {
      const u = row.underlying;
      const group = config.groups.find(g => g.underlying === u);
      const step = STRIKE_STEP[u];
      const spot = spots[u] ?? 0;
      const atm = spot > 0 ? Math.round(spot / step) * step : null;
      const strike = row.strike ?? (atm != null ? atm + (group?.strikesOffset ?? 0) * step : null);
      if (strike == null) { out[row.id] = EMPTY_ROW_LIVE; continue; }

      const key = strikeKey(strike);
      const wsOnThisRow = u === 'NIFTY' && (!row.expiry || liveQuotes?.expiry === row.expiry);
      const ws = wsOnThisRow ? liveQuotes?.strikes?.[key] : undefined;
      const ch = chains[u]?.oc?.[key];

      const pick = (fromWs?: number, fromChain?: number): number | null => {
        if (Number(fromWs) > 0) return Number(fromWs);
        if (Number(fromChain) > 0) return Number(fromChain);
        return null;
      };

      const ref = lookups[u]?.strikes?.[key];
      const findPos = (leg: 'CE' | 'PE'): PosRow | null => {
        // Dhan is the only broker with a numeric security id; the rest join by
        // trading symbol.
        if (broker === 'dhan') {
          const id = leg === 'CE' ? ref?.ceId : ref?.peId;
          if (!id) return null;
          return positions.find(p => String(p.securityId) === String(id)) ?? null;
        }
        const sym = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
        if (!sym) return null;
        return positions.find(p => String(p.tradingSymbol) === sym) ?? null;
      };

      out[row.id] = {
        strike,
        ltpCe: pick(ws?.ce?.ltp, ch?.ce),
        ltpPe: pick(ws?.pe?.ltp, ch?.pe),
        cePosition: findPos('CE'),
        pePosition: findPos('PE'),
      };
    }
    return out;
  }, [config.rows, config.groups, spots, chains, liveQuotes, lookups, positions, broker]);



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
    if (!legsFlat(rowLive[id] ?? EMPTY_ROW_LIVE)) {
      addToast('error', 'Cannot delete row', 'Exit the CE/PE legs first — this row still holds a position');
      return;
    }
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

  // ── Leg orders ──────────────────────────────────────────────────
  //
  // The Focus Tool is a premium-selling scheduler: opening a leg is a SELL,
  // reducing one is a BUY. A reducing order re-resolves its product from the
  // live position rather than from the group, because an order booked under
  // the wrong product does not reduce the position — the broker opens a fresh
  // one on the other side, doubling exposure at the moment risk was being cut.

  /**
   * Send one market order for one leg.
   *
   * `reduce` selects both the direction and where the product comes from, and
   * a reducing order is clamped to the quantity the broker actually shows on
   * that leg — never more.
   */
  async function placeLeg(
    row: FocusRow,
    leg: 'CE' | 'PE',
    opts: { reduce: boolean; lots?: number; all?: boolean },
  ): Promise<boolean> {
    const u = row.underlying;
    const what = `${u} ${leg}`;

    if (!liveRealMoney) {
      addToast('error', 'Dry run', 'Enable LIVE · REAL MONEY to place orders');
      return false;
    }

    const live = rowLive[row.id];
    const strike = live?.strike;
    const lotSize = lotSizes[u];
    if (!strike || !lotSize) {
      addToast('error', `${what} order not sent`, 'Strike or lot size not resolved yet');
      return false;
    }

    const ref = lookups[u]?.strikes?.[strikeKey(strike)];
    const securityId = leg === 'CE' ? ref?.ceId : ref?.peId;
    const symbol     = leg === 'CE' ? ref?.ceSymbol : ref?.peSymbol;
    if (broker === 'dhan' ? !securityId : !symbol) {
      addToast('error', `${what} order not sent`, `No ${broker} contract for ${strike} ${leg}`);
      return false;
    }

    const pos = leg === 'CE' ? live.cePosition : live.pePosition;
    const netQty = Number(pos?.netQty ?? 0);

    let quantity: number;
    let side: 'BUY' | 'SELL';
    if (opts.reduce) {
      if (netQty === 0) {
        addToast('error', `${what} already flat`, 'Nothing to reduce');
        return false;
      }
      // Close against the direction the broker actually shows, not against an
      // assumed short — a row could be held long.
      side = netQty < 0 ? 'BUY' : 'SELL';
      const want = opts.all ? Math.abs(netQty) : (opts.lots ?? 1) * lotSize;
      quantity = Math.min(want, Math.abs(netQty));
    } else {
      side = 'SELL';
      quantity = (opts.lots ?? 1) * lotSize;
    }
    if (!(quantity > 0)) return false;

    // Reducing: the position's own product. Opening: the group's.
    const group = config.groups.find(g => g.underlying === u);
    const rawProduct = opts.reduce && pos
      ? positionProduct(pos as unknown as Record<string, unknown>)
      : PRODUCT_ALIAS[group?.product ?? 'INTRADAY'][broker];
    const product = closeOrderProduct(broker, rawProduct);
    if (!product) {
      addToast('error', `${what} order not sent`, `Cannot place a market order against product ${rawProduct}`);
      return false;
    }

    const exchange = orderExchange(broker, u);
    const url = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
    const body = broker === 'dhan'
      ? { securityId, quantity, side, orderType: 'MARKET', exchangeSegment: exchange, ...product.fields }
      : { tradingsymbol: symbol, quantity, side, orderType: 'MARKET', exchange, ...product.fields };

    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json() as { success?: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `${side} ${quantity} ${strike} ${leg}`, j.order_id ? `Order ${j.order_id}` : undefined);
        pollPositions();
        return true;
      }
      addToast('error', `${what} order rejected`, j.error ?? 'Unknown broker error');
      return false;
    } catch (e) {
      addToast('error', `${what} order failed`, String(e));
      return false;
    }
  }

  /** Serialise a row's orders and disable its buttons while one is in flight. */
  async function runRowAction(rowId: string, fn: () => Promise<unknown>) {
    if (busyRows.has(rowId)) return;
    setBusyRows(prev => new Set(prev).add(rowId));
    try { await fn(); }
    finally {
      setBusyRows(prev => { const next = new Set(prev); next.delete(rowId); return next; });
    }
  }

  /** Legs this row trades — `side` selects which, it is not a direction. */
  function legsOf(row: FocusRow): ('CE' | 'PE')[] {
    return row.side === 'BOTH' ? ['CE', 'PE'] : [row.side as 'CE' | 'PE'];
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
        riskEnabled={riskEnabled} onToggleRisk={() => setRiskEnabled(v => !v)}
        targetRupees={targetRupees} setTargetRupees={setTargetRupees}
        stopRupees={stopRupees} setStopRupees={setStopRupees}
        trailEnabled={trailEnabled} onToggleTrail={() => setTrailEnabled(v => !v)}
        triggerRupees={triggerRupees} setTriggerRupees={setTriggerRupees}
        lockRupees={lockRupees} setLockRupees={setLockRupees}
        onSave={() => saveConfig()} saving={saving} peakMtm={peakMtm} lockMtm={lockMtm}
        copyTrade={copyTrade}
        onOpenExitRules={() => setActiveModal('exit-rules')}
        onOpenRisk={() => setActiveModal('risk')}
        onOpenOrders={() => setActiveModal('orderbook')}
        onToggleViewMode={() => setViewMode(v => v === 'cards' ? 'table' : 'cards')}
        viewMode={viewMode}
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
                spot={spots[u] ?? 0}
                liveAtm={spots[u] > 0 ? Math.round(spots[u] / STRIKE_STEP[u]) * STRIKE_STEP[u] : 0}
                lot={lotSizes[u]} dte={dteFor(expiries[u]?.[0] ?? '')} wsLive={wsLive}
              />

              <div className={cn("bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden", viewMode === 'cards' ? 'p-4' : '')}>
                {viewMode === 'cards' ? (
                  rows.length === 0 ? (
                    <div className="py-12 text-center flex flex-col items-center justify-center gap-2">
                      <TrendingUp className="h-8 w-8 text-zinc-700" />
                      <span className="text-sm font-semibold text-zinc-500">No rows configured</span>
                      <span className="text-xs text-zinc-600">Click &ldquo;Add Row&rdquo; to schedule a straddle or strangle entry.</span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {rows.map(row => (
                        <FocusRowCard
                          key={row.id} row={row}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          onUpdate={(patch, save) => updateRow(row.id, patch, save)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => updateRow(row.id, { status: 'armed' }, true)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' }, true)}
                          onExit={leg => runRowAction(row.id, async () => {
                            const legs = leg === 'ALL' ? legsOf(row) : [leg];
                            for (const l of legs) await placeLeg(row, l, { reduce: true, all: true });
                          })}
                          onAddLot={leg => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots: 1 }))}
                          onReduceLot={leg => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots: 1 }))}
                        />
                      ))}
                    </div>
                  )
                ) : (
                  <table className="w-full border-collapse text-left">
                    <thead>
                      {/* Section group headers */}
                      <tr className="border-b border-zinc-800">
                        <th colSpan={5} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r border-zinc-700" title="How this row enters: timing, strike, size and side">
                          Configuration
                        </th>
                        <th className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider border-r border-zinc-700" title="Row state and its arm / disarm / exit control">
                          Status
                        </th>
                        <th colSpan={3} className="bg-zinc-800 px-4 py-2 text-xs font-bold text-white uppercase tracking-wider" title="Open legs and every rule that can close them">
                          Positions &amp; Exits
                        </th>
                      </tr>
                      {/* Column headers */}
                      <tr className="bg-zinc-800/50 border-b border-zinc-800 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                        <th className="p-3" title="Entry time, exit time and the expiry-days filter">Timing</th>
                        <th className="p-3" title="Strike this row trades, chosen at entry">Strike</th>
                        <th className="p-3" title="Combined premium, with the CE and PE breakdown">LTP</th>
                        <th className="p-3" title="Lots per leg">Lots</th>
                        <th className="p-3 border-r border-zinc-800" title="Trade the call, the put, or both">Side</th>
                        <th className="p-3 border-r border-zinc-800" title="Where the row stands, and its arm / exit control">Status / Actions</th>
                        <th className="p-3" title="Call leg: live premium and lot controls">CE</th>
                        <th className="p-3 border-r border-zinc-800" title="Put leg: live premium and lot controls">PE</th>
                        <th className="p-3" title="Spot, VWAP and stop-loss rules that close this row">Level Exits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => (
                        <FocusTableRow
                          key={row.id} row={row}
                          live={rowLive[row.id] ?? EMPTY_ROW_LIVE}
                          lotSize={lotSizes[u]} spot={spots[u] ?? 0}
                          liveRealMoney={liveRealMoney} broker={broker}
                          busy={busyRows.has(row.id)}
                          onUpdate={(patch, save) => updateRow(row.id, patch, save)}
                          onDelete={() => deleteRow(row.id)}
                          onArm={() => updateRow(row.id, { status: 'armed' }, true)}
                          onDisarm={() => updateRow(row.id, { status: 'draft' }, true)}
                          onExit={leg => runRowAction(row.id, async () => {
                            // 'ALL' is the row's Exit All button: close every leg
                            // this row trades, sequentially so one rejection is
                            // reported against the leg it belongs to.
                            const legs = leg === 'ALL' ? legsOf(row) : [leg];
                            for (const l of legs) await placeLeg(row, l, { reduce: true, all: true });
                          })}
                          onAddLot={leg => runRowAction(row.id, () => placeLeg(row, leg, { reduce: false, lots: 1 }))}
                          onReduceLot={leg => runRowAction(row.id, () => placeLeg(row, leg, { reduce: true, lots: 1 }))}
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
                )}

                <div className="px-4 py-3 bg-zinc-900/40 border-t border-zinc-800 mt-3">
                  <button
                    onClick={() => addRow(u)}
                    title={`Add another straddle / strangle rule for ${u}`}
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

      <FocusModal
        isOpen={activeModal === 'exit-rules'}
        onClose={() => setActiveModal(null)}
        title="Active Exit Rules"
      >
        <div className="flex flex-col gap-3">
          {config.rows.filter(r => r.status === 'armed' || r.status === 'entered').length === 0 ? (
            <div className="text-center py-12 text-zinc-500 text-xs font-semibold">
              No armed or open rows configured.
            </div>
          ) : (
            config.rows.filter(r => r.status === 'armed' || r.status === 'entered').map(row => {
              const rules: string[] = [];
              rules.push("Intraday auto-exit at 15:17");
              if (row.exitTime) rules.push(`Time of day exit at ${row.exitTime}`);
              if (row.levelHigh) rules.push(`H↑ Spot Level: exit if Spot ≥ ${row.levelHigh}`);
              if (row.levelLow) rules.push(`L↓ Spot Level: exit if Spot ≤ ${row.levelLow}`);
              if (row.levelVw) rules.push("VWAP adverse cross: exit if premium breaches session VWAP");
              if (row.slRupees) rules.push(`Rupee Stop Loss: exit if loss ≥ ₹${Number(row.slRupees).toLocaleString('en-IN')}`);
              if (row.slMultiplier && Number(row.slMultiplier) > 1) {
                rules.push(`Multiplier Stop Loss: exit if premium moves ${row.slMultiplier}x against you`);
              }

              return (
                <div key={row.id} className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white">{row.underlying}</span>
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {row.side} &middot; {row.lots} Lot{row.lots > 1 ? 's' : ''} &middot; Strike {row.strike ?? 'ATM'}
                      </span>
                    </div>
                    <span className={cn(
                      'text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border',
                      row.status === 'entered' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                    )}>
                      {row.status}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 text-xs text-zinc-300">
                    {rules.map((r, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-zinc-600 font-bold font-mono">{i + 1}.</span>
                        <span className="font-mono leading-tight">{r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </FocusModal>

      <FocusModal
        isOpen={activeModal === 'risk'}
        onClose={() => setActiveModal(null)}
        title="Risk & MTM Details"
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Realised P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(realised))}>{fmtInr(realised, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Unrealised P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(unrealised))}>{fmtInr(unrealised, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Total P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(total))}>{fmtInr(total, true)}</span>
            </div>
            <div className="bg-zinc-950/40 border border-zinc-850 rounded-xl p-3 flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Session Peak P&L</span>
              <span className={cn("text-lg font-mono font-bold mt-1", pnlClass(peakMtm))}>{fmtInr(peakMtm, true)}</span>
            </div>
          </div>

          <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">Account Budget</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Target Profit:</span>
                <span className="font-mono text-emerald-400 font-bold">{targetRupees ? `₹${Number(targetRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Stop Loss:</span>
                <span className="font-mono text-rose-400 font-bold">{stopRupees ? `-₹${Number(stopRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Trail SL Trigger:</span>
                <span className="font-mono text-amber-400 font-bold">{trailEnabled && triggerRupees ? `₹${Number(triggerRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1">
                <span className="text-zinc-500">Trail SL Lock:</span>
                <span className="font-mono text-amber-500 font-bold">{trailEnabled && lockRupees ? `₹${Number(lockRupees).toLocaleString('en-IN')}` : 'Off'}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-850 py-1 col-span-2">
                <span className="text-zinc-500">Room to Stop:</span>
                <span className={cn("font-mono font-bold", total + (Number(stopRupees) || 0) < 0 ? "text-rose-400" : "text-zinc-300")}>
                  {stopRupees ? fmtInr(total + Number(stopRupees), true) : '—'}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-1">By Underlying</h3>
            {(['NIFTY', 'BANKNIFTY', 'SENSEX'] as const).map(u => {
              const val = underlyingPnl[u];
              return (
                <div key={u} className="flex justify-between items-center text-xs border-b border-zinc-850 py-1">
                  <span className="font-semibold text-zinc-300">{u}</span>
                  <span className={cn("font-mono font-bold", pnlClass(val))}>{fmtInr(val, true)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </FocusModal>

      <FocusModal
        isOpen={activeModal === 'orderbook'}
        onClose={() => setActiveModal(null)}
        title="Broker Order Book"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider leading-tight">
              Every order on the account, not only this tool's
            </span>
            <button
              onClick={fetchOrders}
              disabled={ordersLoading}
              className="text-xs font-semibold px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer disabled:opacity-40 transition-all flex items-center gap-1"
            >
              <RefreshCw className={cn("h-3 w-3", ordersLoading && "animate-spin")} />
              Refresh
            </button>
          </div>

          {ordersError && (
            <div className="text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 font-mono">
              Error loading orders: {ordersError}
            </div>
          )}

          {ordersLoading && !orders.length ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <RefreshCw className="h-6 w-6 text-zinc-600 animate-spin" />
              <span className="text-xs text-zinc-500">Loading order book…</span>
            </div>
          ) : (
            <div className="border border-zinc-800 rounded-xl overflow-hidden max-h-[500px] overflow-y-auto">
              <TabTable
                tab="orders"
                data={orders}
                sort={orderSort}
                onSort={key => setOrderSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })}
              />
            </div>
          )}
        </div>
      </FocusModal>
    </div>
  );
}

