'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown, ChevronRight, CirclePlay, LogOut, Plus, RefreshCw, RotateCcw, ShieldOff, Sprout, Trash2, X,
} from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import { useHarvestDesk, type FeedSource } from '@/components/harvestDesk/useHarvestDesk';
import {
  controlsFor, defaultControls, HD_KIND_META, HD_SECTIONS, type HdControlSpec, type HdControlValue, type HdKind,
} from '@/lib/harvestDeskControls';
import {
  algoStatus, fmtRs, HD_EXPIRY_AUTO, HD_MAX_LOTS, HD_UNDERLYINGS, isOpen, legOpenPnl, resolveExpiry, type HdAlgo, type HdLeg, type HdMarket,
  type HdStatus, type HdStrikeBy, type HdUnderlying,
} from '@/lib/harvestDesk';

// Type scale and focus ring follow dhan-terminal-polish / dhan-a11y-controls.
const TXT_MICRO = 'text-[10px]';
const TXT_LABEL = 'text-[11px]';
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';
const FIELD = 'bg-zinc-950 border border-zinc-800 rounded-md px-1.5 py-1 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed';
const ICON_BTN = 'inline-flex items-center justify-center h-6 w-6 rounded-md border border-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer';

const signed = (n: number | null | undefined): string => (n == null ? '—' : `${n >= 0 ? '+' : '-'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`);
const pnlTone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-zinc-300' : n > 0 ? 'text-emerald-400' : 'text-rose-400');
const fmtPx = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n <= 0 ? '—' : n.toFixed(2));
const istTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

/** Free-typed input: commits on blur or Enter only, Escape reverts (dhan-commit-on-blur). */
function CommitInput({ value, onCommit, className, disabled, type = 'text', ariaLabel, title, placeholder, inputMode }: {
  value: string; onCommit: (v: string) => boolean | void; className?: string; disabled?: boolean; type?: 'text' | 'time';
  ariaLabel: string; title?: string; placeholder?: string; inputMode?: 'decimal' | 'numeric' | 'text';
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  // A commit the owner rejects (out of range, not a number) puts the box back to the stored value.
  const commit = (next: string) => { if (next !== value && onCommit(next) === false) setDraft(value); };
  return (
    <input
      type={type} value={draft} disabled={disabled} aria-label={ariaLabel} title={title} placeholder={placeholder}
      inputMode={inputMode} className={cn(FIELD, className)} spellCheck={false}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => { focused.current = false; commit(e.currentTarget.value); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setDraft(value); e.currentTarget.blur(); }
      }}
    />
  );
}

function NumField({ value, onCommit, min, max, disabled, ariaLabel, title, className, allowEmpty }: {
  value: number | undefined; onCommit: (n: number | undefined) => void; min?: number; max?: number; disabled?: boolean;
  ariaLabel: string; title?: string; className?: string; allowEmpty?: boolean;
}) {
  return (
    <CommitInput
      value={value == null ? '' : String(value)} ariaLabel={ariaLabel} title={title} disabled={disabled} inputMode="decimal"
      className={className}
      onCommit={(raw) => {
        const t = raw.trim();
        if (t === '') { if (allowEmpty) { onCommit(undefined); return; } return false; }
        const n = Number(t);
        if (!Number.isFinite(n) || (min != null && n < min) || (max != null && n > max)) return false;
        onCommit(n);
      }}
    />
  );
}

function Chip({ tone, children, title }: { tone: 'zinc' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky'; children: ReactNode; title?: string }) {
  const tones = {
    zinc: 'border-zinc-700 text-zinc-300 bg-zinc-900',
    emerald: 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10',
    amber: 'border-amber-500/30 text-amber-400 bg-amber-500/10',
    rose: 'border-rose-500/30 text-rose-400 bg-rose-500/10',
    violet: 'border-violet-500/30 text-violet-300 bg-violet-500/10',
    sky: 'border-sky-500/30 text-sky-300 bg-sky-500/10',
  } as const;
  return <span title={title} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-bold uppercase tracking-wide', TXT_MICRO, tones[tone])}>{children}</span>;
}

const STATE_TONE: Record<HdStatus['state'], 'zinc' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky'> = {
  DISARMED: 'zinc', WAITING: 'sky', RUNNING: 'emerald', PAUSED: 'amber', DONE: 'violet',
};

function FeedChip({ source }: { source: FeedSource }) {
  if (source === 'ws') return <Chip tone="emerald" title="Prices come from the live tick bridge">LIVE WS</Chip>;
  if (source === 'chain') return <Chip tone="amber" title="No fresh tick feed for this expiry: prices come from the option chain, which can be up to 30 s old">CHAIN ≤30s</Chip>;
  if (source === 'stale') return <Chip tone="rose" title="The chain poll has stalled (over a minute old): nothing is entered and stops hold their last price">STALE</Chip>;
  return <Chip tone="rose" title="No prices for this underlying yet">NO FEED</Chip>;
}

// ── controls ─────────────────────────────────────────────────────────────────

function ControlCell({ spec, value, disabled, onChange }: {
  spec: HdControlSpec; value: HdControlValue | undefined; disabled: boolean; onChange: (v: HdControlValue) => void;
}) {
  const label = (
    <div className="flex items-center gap-1 min-w-0">
      <span className={cn('truncate text-zinc-300', TXT_LABEL)} title={spec.hint}>{spec.label}</span>
      {spec.unit && <span className={cn('text-zinc-500', TXT_MICRO)}>{spec.unit}</span>}
      {!spec.enforced && <Chip tone="amber" title="Stored and shown, but the desk does not act on it yet">doc only</Chip>}
    </div>
  );
  let input: ReactNode;
  if (spec.type === 'bool') {
    input = (
      <button
        type="button" role="switch" aria-checked={!!value} aria-label={spec.label} disabled={disabled}
        onClick={() => onChange(!value)}
        className={cn('relative h-5 w-9 rounded-full border transition-colors disabled:opacity-50 cursor-pointer', value ? 'bg-emerald-600 border-emerald-500' : 'bg-zinc-800 border-zinc-700', FOCUS_RING)}
      >
        <span className={cn('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-oncolor transition-all', value ? 'left-[18px]' : 'left-0.5')} />
      </button>
    );
  } else if (spec.type === 'select') {
    input = (
      <select value={String(value ?? '')} disabled={disabled} aria-label={spec.label} onChange={(e) => onChange(e.target.value)} className={cn(FIELD, 'w-full')}>
        {spec.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (spec.type === 'num') {
    input = (
      <NumField
        value={typeof value === 'number' ? value : Number(value)} ariaLabel={spec.label} title={spec.hint} disabled={disabled} min={spec.min} max={spec.max}
        className="w-full" onCommit={(n) => { if (n != null) onChange(n); }}
      />
    );
  } else {
    input = (
      <CommitInput
        value={String(value ?? '')} ariaLabel={spec.label} title={spec.hint} disabled={disabled} type={spec.type === 'time' ? 'time' : 'text'}
        className="w-full" onCommit={(v) => onChange(v)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1 min-w-0">
      {label}
      {input}
      <span className={cn('truncate font-mono text-zinc-600', TXT_MICRO)} title={`${spec.flag} — ${spec.hint}`}>{spec.flag}</span>
    </div>
  );
}

function ControlsPanel({ algo, disabled, onSet, onRestore }: {
  algo: HdAlgo; disabled: boolean; onSet: (key: string, v: HdControlValue) => void; onRestore: () => void;
}) {
  const specs = useMemo(() => controlsFor(algo.kind), [algo.kind]);
  return (
    <div className="space-y-3">
      {HD_SECTIONS.map((sec) => {
        const list = specs.filter((s) => s.section === sec);
        if (!list.length) return null;
        return (
          <section key={sec} className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-2.5">
            <h4 className={cn('mb-2 font-bold uppercase tracking-[0.14em] text-zinc-400', TXT_MICRO)}>{sec}</h4>
            <div className="grid gap-x-3 gap-y-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
              {list.map((s) => (
                <ControlCell key={s.key} spec={s} value={algo.controls[s.key]} disabled={disabled} onChange={(v) => onSet(s.key, v)} />
              ))}
            </div>
          </section>
        );
      })}
      <div className="flex justify-end">
        <button
          type="button" disabled={disabled} onClick={onRestore}
          className={cn('inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 cursor-pointer', TXT_LABEL, FOCUS_RING)}
        >
          <RotateCcw className="h-3 w-3" /> Restore readme defaults
        </button>
      </div>
    </div>
  );
}

// ── legs ─────────────────────────────────────────────────────────────────────

const STRIKE_BY: { value: HdStrikeBy; label: string; hint: string }[] = [
  { value: 'ATM', label: 'ATM', hint: 'At-the-money strike at entry' },
  { value: 'OFFSET', label: 'Offset', hint: 'Points from spot, away from the money (CE above, PE below)' },
  { value: 'DELTA', label: 'Delta', hint: 'OTM strike closest to this absolute delta (0-1)' },
  { value: 'PREMIUM', label: 'Premium', hint: 'OTM strike closest to this premium (₹)' },
];

function legLtp(l: HdLeg, m: HdMarket | null): number | null {
  if (!m || l.strike == null) return null;
  const q = m.quote(l.expiryUsed ?? resolveExpiry(l.expiry, m), l.strike, l.option);
  return q && q.ltp > 0 ? q.ltp : null;
}

function LegRow({ algo, leg, idx, m, disabled, expiries, act }: {
  algo: HdAlgo; leg: HdLeg; idx: number; m: HdMarket | null; disabled: boolean; expiries: string[];
  act: ReturnType<typeof useHarvestDesk>['actions'];
}) {
  const open = isOpen(leg);
  const ltp = legLtp(leg, m);
  const pnl = open && ltp != null && m ? legOpenPnl(leg, ltp, m.lotSize) : null;
  const total = pnl == null ? (open ? null : leg.realized) : pnl + leg.realized;
  const diag = algo.kind === 'diagonal_call';
  const structural = open || disabled;
  const set = (patch: Partial<HdLeg>) => act.setLeg(algo.id, leg.id, patch);
  const valuePlaceholder = leg.strikeBy === 'OFFSET' ? 'pts' : leg.strikeBy === 'DELTA' ? '0.20' : leg.strikeBy === 'PREMIUM' ? '₹' : '';
  const status = open ? 'OPEN' : leg.waitingReentry ? 'RE-ENTRY' : leg.status === 'CLOSED' ? (leg.exitReason ?? 'CLOSED') : 'IDLE';
  const statusTone = open ? 'emerald' : leg.waitingReentry ? 'sky' : leg.status === 'CLOSED' ? 'zinc' : 'zinc';
  const label = `${leg.option} ${leg.side === 'S' ? 'sell' : 'buy'} row ${idx + 1}`;

  return (
    <tr className="border-t border-zinc-800/70 align-middle hover:bg-zinc-900/40">
      <td className={cn('px-2 py-1.5 text-zinc-500', TXT_LABEL)}>{idx + 1}</td>
      <td className="px-2 py-1.5">
        <Chip tone={leg.role === 'hedge' ? 'violet' : leg.role === 'long' ? 'sky' : leg.role === 'short' ? 'amber' : 'zinc'}>{leg.role}</Chip>
      </td>
      <td className="px-2 py-1.5">
        {diag || leg.auto ? <span className="font-mono text-xs font-bold text-zinc-100">{leg.option}</span> : (
          <select value={leg.option} disabled={structural} aria-label={`${label} option type`} onChange={(e) => set({ option: e.target.value as 'CE' | 'PE' })} className={FIELD}>
            <option value="CE">CE</option><option value="PE">PE</option>
          </select>
        )}
      </td>
      <td className="px-2 py-1.5">
        {diag || leg.auto ? <span className={cn('font-mono text-xs font-bold', leg.side === 'S' ? 'text-rose-300' : 'text-emerald-300')}>{leg.side === 'S' ? 'SELL' : 'BUY'}</span> : (
          <select value={leg.side} disabled={structural} aria-label={`${label} side`} onChange={(e) => set({ side: e.target.value as 'S' | 'B' })} className={FIELD}>
            <option value="S">Sell</option><option value="B">Buy</option>
          </select>
        )}
      </td>
      <td className="px-2 py-1.5">
        {leg.auto ? <span className="font-mono text-xs text-zinc-300">{leg.expiryUsed ?? '—'}</span> : (
          <select value={leg.expiry} disabled={structural} aria-label={`${label} expiry`} onChange={(e) => set({ expiry: e.target.value })} className={cn(FIELD, 'max-w-[8.5rem]')}>
            <option value="">Nearest</option>
            {diag && <option value={HD_EXPIRY_AUTO}>Auto · DTE band</option>}
            {expiries.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        )}
      </td>
      <td className="px-2 py-1.5">
        {leg.auto ? <span className={cn('text-zinc-500', TXT_LABEL)}>hedge wing</span> : (
          <div className="flex items-center gap-1">
            <select value={leg.strikeBy} disabled={structural} aria-label={`${label} strike rule`} title={STRIKE_BY.find((s) => s.value === leg.strikeBy)?.hint}
              onChange={(e) => set({ strikeBy: e.target.value as HdStrikeBy, strikeValue: e.target.value === 'DELTA' ? 0.2 : e.target.value === 'PREMIUM' ? 50 : e.target.value === 'OFFSET' ? 200 : 0 })} className={FIELD}>
              {STRIKE_BY.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            {leg.strikeBy !== 'ATM' && (
              <NumField value={leg.strikeValue} ariaLabel={`${label} strike value`} disabled={structural} className="w-16" title={valuePlaceholder}
                onCommit={(n) => { if (n != null) set({ strikeValue: n }); }} />
            )}
          </div>
        )}
      </td>
      <td className="px-2 py-1.5">
        {leg.auto ? <span className="font-mono text-xs text-zinc-300">{leg.openLots}L</span> : (
          <NumField value={leg.lots} min={leg.role === 'short' ? 0 : 1} max={HD_MAX_LOTS} ariaLabel={`${label} lots`} disabled={structural} className="w-12"
            title={leg.role === 'short' ? '0 = size from delta (target net delta, max short lots)' : 'Lots on entry'}
            onCommit={(n) => { if (n != null && Number.isInteger(n)) set({ lots: n }); }} />
        )}
      </td>
      <td className="px-2 py-1.5">
        {leg.auto || leg.role === 'long' ? <span className="text-zinc-600">—</span> : (
          <NumField value={leg.slPct} allowEmpty min={0} ariaLabel={`${label} stop loss percent`} disabled={disabled} className="w-14"
            title="Stop: premium this % worse than the leg's entry (blank = off). In re-entry straddle mode a blank takes the Leg SL control."
            onCommit={(n) => set({ slPct: n })} />
        )}
      </td>
      <td className="px-2 py-1.5">
        {leg.auto || leg.role === 'long' ? <span className="text-zinc-600">—</span> : (
          <NumField value={leg.tgtPct} allowEmpty min={0} ariaLabel={`${label} target percent`} disabled={disabled} className="w-14"
            title="Target: premium this % better than the leg's entry (blank = off)" onCommit={(n) => set({ tgtPct: n })} />
        )}
      </td>
      <td className="px-2 py-1.5 text-center">
        {leg.auto || leg.role === 'long' ? <span className="text-zinc-600">—</span> : (
          <input type="checkbox" checked={!!leg.reentry} disabled={disabled} aria-label={`${label} re-entry`}
            title="After an SL or target exit, re-enter when the price returns to the first entry premium"
            onChange={(e) => set({ reentry: e.target.checked })} className={cn('h-3.5 w-3.5 accent-violet-500 cursor-pointer', FOCUS_RING)} />
        )}
      </td>
      <td className="px-2 py-1.5"><Chip tone={statusTone}>{status}</Chip></td>
      <td className="px-2 py-1.5 text-right font-mono text-xs text-zinc-100">
        {leg.strike ?? '—'}{open && <span className="text-zinc-500"> · {leg.openLots}L</span>}
      </td>
      <td className="px-2 py-1.5 text-right font-mono text-xs text-zinc-300">{open ? fmtPx(leg.avgEntry) : '—'}</td>
      <td className="px-2 py-1.5 text-right font-mono text-xs text-zinc-100">{open ? fmtPx(ltp) : '—'}</td>
      <td className={cn('px-2 py-1.5 text-right font-mono text-xs font-bold', pnlTone(total))}>{open || leg.realized !== 0 ? signed(total) : '—'}</td>
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-1">
          {!open && !leg.auto && (
            <button type="button" className={cn(ICON_BTN, FOCUS_RING)} disabled={disabled} aria-label={`Enter ${label} now`}
              title={disabled ? 'Read-only: another tab runs the desk' : leg.waitingReentry ? 'Re-enter this leg now at its strike' : 'Enter this leg now at the current price (skips the entry gates)'}
              onClick={() => act.enterLeg(algo.id, leg.id)}>
              {leg.waitingReentry ? <RefreshCw className="h-3 w-3" /> : <CirclePlay className="h-3 w-3" />}
            </button>
          )}
          {open && (
            <>
              <select aria-label={`Part exit ${label}`} disabled={disabled} value="" title="Exit part of this leg"
                onChange={(e) => {
                  const pct = Number(e.target.value);
                  const lots = Math.floor((leg.openLots * pct) / 100);
                  if (lots > 0) act.exitLeg(algo.id, leg.id, lots);
                }} className={cn(FIELD, 'w-12 px-0.5')}>
                <option value="">%</option>
                {[25, 50, 75].map((p) => <option key={p} value={p} disabled={Math.floor((leg.openLots * p) / 100) < 1}>{p}%</option>)}
              </select>
              <button type="button" className={cn(ICON_BTN, 'hover:text-rose-300', FOCUS_RING)} disabled={disabled} aria-label={`Exit ${label}`}
                title={disabled ? 'Read-only: another tab runs the desk' : 'Close this leg at the current price'} onClick={() => act.exitLeg(algo.id, leg.id)}>
                <LogOut className="h-3 w-3" />
              </button>
            </>
          )}
          {!open && !diag && !leg.auto && (
            <button type="button" className={cn(ICON_BTN, 'hover:text-rose-300', FOCUS_RING)} disabled={disabled} aria-label={`Remove ${label}`}
              title="Remove this row" onClick={() => act.removeLeg(algo.id, leg.id)}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

const HEAD = ['#', 'Role', 'Opt', 'Side', 'Expiry', 'Strike rule', 'Lots', 'SL %', 'Tgt %', 'RE', 'Status', 'Strike', 'Entry', 'LTP', 'P&L', ''];

function StatusStrip({ algo, st }: { algo: HdAlgo; st: HdStatus }) {
  const items: ReactNode[] = [];
  if (st.imbalance) {
    const i = st.imbalance;
    const pct = Math.min(100, (i.current / Math.max(i.trigger * 1.25, 1)) * 100);
    items.push(
      <div key="imb" className="min-w-[230px] flex-1">
        <div className={cn('flex items-center justify-between text-zinc-400', TXT_MICRO)}>
          <span>Imbalance <b className="font-mono text-zinc-100">{i.current.toFixed(1)}%</b> · baseline {i.baseline.toFixed(1)}%</span>
          <span>trigger <b className="font-mono text-zinc-100">{i.trigger.toFixed(1)}%</b>{i.atMax ? ' (strike)' : ' (lot)'}</span>
        </div>
        <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-label="Imbalance towards the next adjustment" aria-valuenow={Math.round(i.current)} aria-valuemin={0} aria-valuemax={Math.round(i.trigger)}>
          <div className={cn('h-full rounded-full', i.current > i.trigger ? 'bg-amber-400' : 'bg-violet-500')} style={{ width: `${pct}%` }} />
        </div>
        <div className={cn('mt-1 text-zinc-500', TXT_MICRO)}>winner <b className="text-zinc-300">{i.winner}</b> · next: {i.next}</div>
      </div>,
    );
  }
  if (st.vwap) {
    const v = st.vwap;
    items.push(
      <div key="vwap" className="min-w-[260px] flex-1">
        <div className={cn('text-zinc-400', TXT_MICRO)}>
          Combined <b className="font-mono text-zinc-100">{v.combined.toFixed(1)}</b> · VWAP <b className="font-mono text-zinc-100">{v.vwap.toFixed(1)}</b> · bars {v.bars}/{v.warmup}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {v.gates.map((g) => <Chip key={g.label} tone={g.ok ? 'emerald' : 'zinc'}>{g.ok ? '✓' : '·'} {g.label}</Chip>)}
        </div>
      </div>,
    );
  }
  if (st.diagonal) {
    const d = st.diagonal;
    items.push(
      <div key="diag" className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-zinc-400', TXT_MICRO)}>
        <span>Net Δ <b className="font-mono text-zinc-100">{d.portDelta == null ? '—' : d.portDelta.toFixed(1)}</b></span>
        <span>Short captured <b className="font-mono text-zinc-100">{d.shortCapturedPct == null ? '—' : `${d.shortCapturedPct.toFixed(0)}%`}</b></span>
        <span>Short DTE <b className="font-mono text-zinc-100">{d.shortDte ?? '—'}</b></span>
        <span>Long DTE <b className="font-mono text-zinc-100">{d.longDte ?? '—'}</b></span>
        <span>Drawdown <b className="font-mono text-zinc-100">{d.drawdownPct == null ? '—' : `${d.drawdownPct.toFixed(1)}%`}</b></span>
        <span>Next window <b className="font-mono text-zinc-100">{d.nextWindow ?? '—'}</b></span>
        {d.free && <Chip tone="emerald" title="Cumulative short premium has covered the long debit">free long call</Chip>}
        {d.suspended && <Chip tone="amber" title="Daily loss limit hit: only expiry and critical-delta rolls run today">adjustments suspended</Chip>}
      </div>,
    );
  }
  const facts: string[] = [];
  if (algo.entry) facts.push(`Entry ${algo.entry.premiumRs ? fmtRs(algo.entry.premiumRs) : '—'} collected`);
  if (algo.peakMtm > 0) facts.push(`Peak ${fmtRs(algo.peakMtm)}`);
  if (algo.trail.armed) facts.push(`Trail armed${algo.trail.best != null ? ` (best ${algo.trail.best.toFixed(1)})` : ''}`);
  if (st.targetRs > 0) facts.push(`Target ${fmtRs(st.targetRs)}`);
  if (st.stopRs > 0) facts.push(`Stop ${fmtRs(st.stopRs)}`);
  if (!items.length && !facts.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-zinc-800/70 bg-zinc-950/40 px-3 py-2">
      {items}
      {facts.length > 0 && <div className={cn('text-zinc-500', TXT_MICRO)}>{facts.join(' · ')}</div>}
    </div>
  );
}

// ── one algo ─────────────────────────────────────────────────────────────────

function AlgoCard({ algo, desk, tab, setTab, open, setOpen }: {
  algo: HdAlgo; desk: ReturnType<typeof useHarvestDesk>; tab: 'legs' | 'controls' | 'log'; setTab: (t: 'legs' | 'controls' | 'log') => void;
  open: boolean; setOpen: (o: boolean) => void;
}) {
  const { actions: act, readOnly, clock } = desk;
  const m = desk.marketFor(algo.underlying, clock);
  const st = algoStatus(algo, m);
  const meta = HD_KIND_META[algo.kind];
  const expiries = m?.expiries ?? [];
  const feed = desk.feedFor(algo.underlying, algo.legs.find((l) => l.expiryUsed)?.expiryUsed ?? expiries[0] ?? '');
  const hasOpen = algo.legs.some(isOpen);
  const pauseLeft = algo.phase === 'PAUSED' && algo.pausedUntil ? Math.max(0, Math.round((algo.pausedUntil - clock) / 1000)) : 0;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canAddLeg = algo.kind !== 'diagonal_call';

  return (
    <article className={cn('rounded-2xl border bg-zinc-900 shadow-sm', algo.armed ? 'border-emerald-500/30' : 'border-zinc-800')}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Collapse algo' : 'Expand algo'} className={cn(ICON_BTN, FOCUS_RING)}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CommitInput value={algo.name} ariaLabel="Algo name" disabled={readOnly} className="w-48 border-transparent bg-transparent text-sm font-bold hover:border-zinc-800"
              onCommit={(v) => { const t = v.trim(); if (t) act.edit(algo.id, (a) => ({ ...a, name: t.slice(0, 60) })); }} />
            <Chip tone="violet" title={meta.script}>{meta.label}</Chip>
            <Chip tone="zinc">{algo.underlying}</Chip>
            <Chip tone="zinc" title="Position product">{algo.product === 'INTRADAY' ? 'Intraday' : 'Positional'}</Chip>
            <Chip tone={STATE_TONE[st.state]} title={st.waiting}>{st.state}{pauseLeft > 0 ? ` ${Math.floor(pauseLeft / 60)}:${String(pauseLeft % 60).padStart(2, '0')}` : ''}</Chip>
            <FeedChip source={feed} />
          </div>
          <p className={cn('mt-0.5 text-zinc-500', TXT_LABEL)}>
            {st.waiting ? `Waiting: ${st.waiting}` : meta.summary}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          <Stat label="Cycle" value={`#${algo.cycle}`} sub={`${algo.tradesToday} trade${algo.tradesToday === 1 ? '' : 's'} today`} />
          <Stat label="Cycle MTM" value={signed(st.mtm)} tone={pnlTone(st.mtm)} />
          <Stat label="Day P&L" value={signed(st.dayPnl)} tone={pnlTone(st.dayPnl)} />
          <div className="flex items-center gap-1.5">
            <button type="button" role="switch" aria-checked={algo.armed} disabled={readOnly} onClick={() => act.toggleArm(algo.id)}
              title={algo.armed ? 'Armed: the desk may enter and adjust. Click to disarm (stops and targets keep running on open legs).' : 'Disarmed: nothing is entered or adjusted automatically'}
              className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-bold uppercase tracking-wide disabled:opacity-40 cursor-pointer', TXT_LABEL,
                algo.armed ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 bg-zinc-950 text-zinc-300', FOCUS_RING)}>
              <span className={cn('h-1.5 w-1.5 rounded-full', algo.armed ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600')} />
              {algo.armed ? 'Armed' : 'Arm'}
            </button>
            <button type="button" disabled={readOnly || algo.legs.every(isOpen)} onClick={() => act.enterNow(algo.id)}
              title="Enter the legs now at the current prices, skipping the start time and the balance / VWAP gates" aria-label="Enter now"
              className={cn('inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 cursor-pointer', TXT_LABEL, FOCUS_RING)}>
              <CirclePlay className="h-3 w-3" /> Enter now
            </button>
            <button type="button" className={cn(ICON_BTN, 'hover:text-rose-300', FOCUS_RING)} disabled={readOnly || (!hasOpen && !algo.armed)} aria-label="Exit all legs and disarm"
              title={hasOpen ? 'Close every open leg at the current price and disarm' : 'Disarm'} onClick={() => act.exitAll(algo.id)}>
              <ShieldOff className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={cn(ICON_BTN, FOCUS_RING)} disabled={readOnly || hasOpen} aria-label="Reset cycle state"
              title={hasOpen ? 'Close the open legs first' : 'Clear the cycle state (VWAP bars, trail, waiting re-entries) and disarm'} onClick={() => act.reset(algo.id)}>
              <RotateCcw className="h-3 w-3" />
            </button>
            {confirmDelete ? (
              <span className="inline-flex items-center gap-1">
                <button type="button" className={cn('rounded-md border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.5 font-bold text-rose-300 cursor-pointer', TXT_MICRO, FOCUS_RING)}
                  onClick={() => { setConfirmDelete(false); void act.deleteAlgo(algo.id); }}>Delete</button>
                <button type="button" className={cn(ICON_BTN, FOCUS_RING)} aria-label="Cancel delete" onClick={() => setConfirmDelete(false)}><X className="h-3 w-3" /></button>
              </span>
            ) : (
              <button type="button" className={cn(ICON_BTN, 'hover:text-rose-300', FOCUS_RING)} disabled={readOnly || hasOpen} aria-label="Delete algo"
                title={hasOpen ? 'Close the open legs first' : 'Delete this algo'} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </header>

      {open && (
        <div className="border-t border-zinc-800">
          <div className="flex items-center gap-1 px-3 pt-2" role="tablist">
            {(['legs', 'controls', 'log'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={cn('rounded-md px-2.5 py-1 font-bold uppercase tracking-wide cursor-pointer', TXT_LABEL,
                  tab === t ? 'bg-violet-500/15 text-violet-200' : 'text-zinc-500 hover:text-zinc-200', FOCUS_RING)}>
                {t === 'legs' ? `Legs (${algo.legs.length})` : t === 'controls' ? 'Controls' : `Log (${algo.events.length})`}
              </button>
            ))}
          </div>

          {tab === 'legs' && (
            <div className="mt-2">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] border-collapse">
                  <thead>
                    <tr>{HEAD.map((h, i) => (
                      <th key={`${h}${i}`} className={cn('px-2 py-1 text-left font-bold uppercase tracking-wide text-zinc-500', TXT_MICRO, ['Strike', 'Entry', 'LTP', 'P&L'].includes(h) && 'text-right')}
                        title={h === 'RE' ? 'Re-enter after an SL / target exit' : undefined}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {algo.legs.map((l, i) => (
                      <LegRow key={l.id} algo={algo} leg={l} idx={i} m={m} disabled={readOnly} expiries={expiries} act={act} />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                {canAddLeg ? (
                  <button type="button" disabled={readOnly} onClick={() => act.addLeg(algo.id)}
                    className={cn('inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 cursor-pointer', TXT_LABEL, FOCUS_RING)}>
                    <Plus className="h-3 w-3" /> Add leg
                  </button>
                ) : <span className={cn('text-zinc-600', TXT_LABEL)}>The diagonal is one long and one short call; the short is sized from delta.</span>}
                <span className={cn('text-zinc-600', TXT_MICRO)}>Paper fills at the quoted LTP · no order is ever sent</span>
              </div>
              <StatusStrip algo={algo} st={st} />
            </div>
          )}

          {tab === 'controls' && (
            <div className="px-3 py-3">
              <ControlsPanel algo={algo} disabled={readOnly} onSet={(k, v) => act.setControl(algo.id, k, v)}
                onRestore={() => act.edit(algo.id, (a) => ({ ...a, controls: defaultControls(a.kind) }))} />
            </div>
          )}

          {tab === 'log' && (
            <ol className="max-h-72 overflow-y-auto px-3 py-2 font-mono text-xs">
              {algo.events.length === 0 && <li className="text-zinc-600">Nothing yet.</li>}
              {[...algo.events].reverse().map((e, i) => (
                <li key={`${e.t}-${i}`} className="flex gap-2 border-b border-zinc-800/50 py-1">
                  <span className="shrink-0 text-zinc-500">{istTime(e.t)}</span>
                  <span className={cn('w-16 shrink-0 font-bold', e.k === 'ERROR' ? 'text-rose-400' : e.k === 'EXIT' ? 'text-amber-300' : 'text-violet-300')}>{e.k}</span>
                  <span className="text-zinc-300">{e.msg}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </article>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="text-right">
      <div className={cn('uppercase tracking-wide text-zinc-500', TXT_MICRO)}>{label}</div>
      <div className={cn('font-mono text-sm font-bold', tone ?? 'text-zinc-100')}>{value}</div>
      {sub && <div className={cn('text-zinc-600', TXT_MICRO)}>{sub}</div>}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function HarvestDesk() {
  const desk = useHarvestDesk();
  const { algos, loaded, loadError, isLeader, readOnly, actions } = desk;
  const [kind, setKind] = useState<HdKind>('imbalance_straddle');
  const [underlying, setUnderlying] = useState<HdUnderlying>('NIFTY');
  const [tabs, setTabs] = useState<Record<string, 'legs' | 'controls' | 'log'>>({});
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const totals = useMemo(() => {
    let day = 0; let priced = 0; let unpriced = 0; let open = 0;
    for (const a of algos) {
      const st = algoStatus(a, desk.marketFor(a.underlying, desk.clock));
      if (st.dayPnl == null) unpriced += 1; else { day += st.dayPnl; priced += 1; }
      open += a.legs.filter(isOpen).length;
    }
    return { day, priced, unpriced, open };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [algos, desk.clock]);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10">
            <Sprout className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <p className="mb-0.5 text-xs font-bold uppercase tracking-[0.16em] text-emerald-400">Strategies · Premium Harvest</p>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">Harvest Desk</h1>
            <p className="mt-1 text-xs font-medium text-zinc-500">Row-by-row legs with every documented control of the harvest strategies</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="sky" title="Fills happen at the quoted LTP. This page never calls an order route.">Paper · SIM only</Chip>
          {totals.priced + totals.unpriced > 0 && (
            <span className={cn('rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs font-bold', pnlTone(totals.day))}
              title={totals.unpriced ? `${totals.unpriced} algo(s) unpriced and excluded` : 'Day P&L across all algos'}>
              Day {signed(totals.day)}{totals.unpriced ? '*' : ''}
            </span>
          )}
          <button type="button" disabled={readOnly || (totals.open === 0 && !algos.some((a) => a.armed))} onClick={() => actions.exitEverything()}
            title="Close every open leg across all algos and disarm them" aria-label="Exit everything"
            className={cn('inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide text-rose-300 hover:bg-rose-500/20 disabled:opacity-40 cursor-pointer', FOCUS_RING)}>
            <ShieldOff className="h-3.5 w-3.5" /> Exit all algos
          </button>
          <NavBar />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 space-y-4 px-6 py-5">
        {isLeader === false && (
          <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Harvest Desk is open in another tab. That tab runs the engine; this one is read-only and refreshes every few seconds.
          </div>
        )}
        {loadError && !loaded && (
          <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            Could not load the saved algos ({loadError}). Retrying every few seconds; the engine and all actions stay off, and nothing is overwritten, until it loads.
          </div>
        )}
        {desk.lagMs > 0 && totals.open > 0 && (
          <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            The engine is running about {Math.round(desk.lagMs / 1000)} s behind (a background tab throttles timers), so stops and the square-off can fire late.
            Keep this tab in the foreground or in its own window.
          </div>
        )}

        <section aria-label="Add an algo" className="flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-3">
          <label className="flex flex-col gap-1">
            <span className={cn('uppercase tracking-wide text-zinc-500', TXT_MICRO)}>Strategy</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as HdKind)} className={cn(FIELD, 'min-w-[14rem]')} aria-label="Strategy">
              {desk.kinds.map((k) => <option key={k} value={k}>{HD_KIND_META[k].label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={cn('uppercase tracking-wide text-zinc-500', TXT_MICRO)}>Underlying</span>
            <select value={underlying} onChange={(e) => setUnderlying(e.target.value as HdUnderlying)} className={FIELD} aria-label="Underlying">
              {HD_UNDERLYINGS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <button type="button" disabled={readOnly || !loaded} onClick={() => actions.addAlgo(kind, underlying)}
            className={cn('inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 cursor-pointer', FOCUS_RING)}>
            <Plus className="h-3.5 w-3.5" /> Add algo
          </button>
          <p className="min-w-[16rem] flex-1 text-xs text-zinc-500">
            <b className="text-zinc-300">{HD_KIND_META[kind].label}</b> — {HD_KIND_META[kind].summary}{' '}
            <span className="font-mono text-zinc-600">{HD_KIND_META[kind].script}</span>
          </p>
        </section>

        {!loaded ? (
          <p className="py-10 text-center text-sm text-zinc-500">{loadError ? 'Waiting for the ledger…' : 'Loading algos…'}</p>
        ) : algos.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-zinc-800 py-12 text-center text-sm text-zinc-500">
            No algos yet. Pick a strategy above and add one: it comes with the readme&apos;s default controls and leg rows, which you can edit or extend.
          </p>
        ) : (
          algos.map((a) => (
            <AlgoCard key={a.id} algo={a} desk={desk} tab={tabs[a.id] ?? 'legs'} setTab={(t) => setTabs((p) => ({ ...p, [a.id]: t }))}
              open={!closed[a.id]} setOpen={(o) => setClosed((p) => ({ ...p, [a.id]: !o }))} />
          ))
        )}
      </main>
    </div>
  );
}
