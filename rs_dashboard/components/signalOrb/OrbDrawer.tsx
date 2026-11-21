'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { RuleNumInput } from '@/components/breakdownScalper/RuleNumInput';
import { cn } from '@/lib/utils';
import { KIND_LABEL, TIMEFRAMES, defaultSpec, specLabel, type IndicatorKind, type IndicatorSpec } from '@/lib/signalOrb';
import { MAX_STRIKE_OFFSET, ORB_SYMBOLS, type OrbConfig, type OrbLedger } from '@/lib/signalOrbLedger';
import type { ReplaySummary } from '@/lib/signalOrb';
import { ReplayCard } from '@/components/signalOrb/ReplayCard';

// Signal Orb settings: indicators (add / remove / tune), timeframe, stop, loss limit, times, broker, mode. Every field commits on
// blur / Enter (dhan-commit-on-blur) and goes to the server as one setConfig patch; the server bounds and may refuse it.

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const KINDS: IndicatorKind[] = ['ema', 'supertrend', 'emaCross', 'rsi', 'stochRsi', 'adx', 'vwap'];

function TimeField({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = () => { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(draft) && draft !== value) onCommit(draft); else setDraft(value); };
  return (
    <input value={draft} aria-label={label} inputMode="numeric" placeholder="HH:MM"
      onFocus={() => { focused.current = true; }}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(value); }}
      className={cn('h-8 w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100', FOCUS)} />
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        {sub && <p className="text-[11px] text-zinc-500">{sub}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

const field = (label: string, v: number, on: (n: number) => void, step = 1, min = 1) => (
  <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
    {label}
    <RuleNumInput value={v} step={step} min={min} label={label} onCommit={s => { const n = Number(s); if (Number.isFinite(n)) on(n); }}
      className="h-7 w-14 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 text-center font-mono text-xs text-zinc-100" />
  </label>
);

function SpecEditor({ spec, onChange, onRemove }: { spec: IndicatorSpec; onChange: (s: IndicatorSpec) => void; onRemove: () => void }) {
  const set = (patch: Partial<IndicatorSpec>) => onChange({ ...spec, ...patch } as IndicatorSpec);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <span className="min-w-[88px] font-mono text-xs font-bold text-zinc-100">{specLabel(spec)}</span>
      {spec.kind === 'ema' && field('Period', spec.period, n => set({ period: n }), 1, 2)}
      {spec.kind === 'emaCross' && <>{field('Fast', spec.fast, n => set({ fast: n }), 1, 2)}{field('Slow', spec.slow, n => set({ slow: n }), 1, 3)}</>}
      {spec.kind === 'supertrend' && <>{field('Period', spec.period, n => set({ period: n }), 1, 2)}{field('Mult', spec.mult, n => set({ mult: n }), 0.5, 0.5)}</>}
      {spec.kind === 'rsi' && <>{field('Period', spec.period, n => set({ period: n }), 1, 2)}{field('Bull >', spec.upper, n => set({ upper: n }))}{field('Bear <', spec.lower, n => set({ lower: n }))}</>}
      {spec.kind === 'stochRsi' && <>
        {field('RSI', spec.rsiPeriod, n => set({ rsiPeriod: n }), 1, 2)}{field('Stoch', spec.stochPeriod, n => set({ stochPeriod: n }), 1, 2)}
        {field('K', spec.k, n => set({ k: n }))}{field('D', spec.d, n => set({ d: n }))}
      </>}
      {spec.kind === 'adx' && <>
        {field('Period', spec.period, n => set({ period: n }), 1, 2)}{field('Min ADX', spec.minAdx, n => set({ minAdx: n }), 1, 5)}
      </>}
      <button type="button" onClick={onRemove} aria-label={`Remove ${specLabel(spec)}`} title="Remove"
        className={cn('ml-auto rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400', FOCUS)}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function OrbDrawer({ open, onClose, ledger, locked, onPatch, onMode, onResetSim, error, replayed }: {
  replayed: ReplaySummary | null;
  open: boolean;
  onClose: () => void;
  ledger: OrbLedger;
  /** a position is live: broker, mode, symbol, instrument, strike and lots are pinned */
  locked: boolean;
  onPatch: (patch: Partial<OrbConfig>) => void;
  onMode: (m: 'SIM' | 'REAL') => void;
  onResetSim: () => void;
  error: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  const c = ledger.config;
  const setSpecs = (indicators: IndicatorSpec[]) => onPatch({ indicators });
  const addKind = (kind: IndicatorKind) => {
    let i = 1;
    while (c.indicators.some(s => s.id === `${kind}-${i}`)) i++;
    setSpecs([...c.indicators, defaultSpec(kind, `${kind}-${i}`)]);
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-oncolor-dark/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-label="Signal Orb settings"
        className="relative flex h-full w-full max-w-lg flex-col gap-3 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5 text-zinc-100 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-zinc-500">Signal Orb</p>
            <h2 className="text-lg font-bold text-zinc-100">Rules</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className={cn('rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100', FOCUS)}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
        <div className="flex flex-col gap-1">
          <ReplayCard r={replayed} tf={c.timeframe} compact futuresPoints={c.instrument === 'options'} />
          <p className="px-1 text-[11px] text-zinc-500">What-if, not live results: these rules replayed over the last 20 sessions (fills at the bar close, no costs). Fills/day counts every entry and exit, so a flip is 2. Use it to spot a setting that flips too often before you arm.</p>
        </div>

        <Section title="Indicators — all must agree">
          <div className="flex flex-col gap-2">
            {c.indicators.length === 0 && <p className="text-xs text-zinc-500">No indicators: the orb stays gray and nothing trades.</p>}
            {c.indicators.map((s, i) => (
              <SpecEditor key={s.id} spec={s}
                onChange={ns => setSpecs(c.indicators.map((x, j) => (j === i ? ns : x)))}
                onRemove={() => setSpecs(c.indicators.filter((_, j) => j !== i))} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {KINDS.map(k => (
              <button key={k} type="button" onClick={() => addKind(k)} disabled={c.indicators.length >= 8}
                className={cn('flex items-center gap-1 rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] font-bold text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40', FOCUS)}>
                <Plus className="h-3 w-3" />{KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">Price vs EMA · Supertrend direction (TradingView&apos;s ta.supertrend on true high / low) · fast vs slow EMA · RSI above / below its band · Stoch RSI K vs D outside its extremes · ADX / DMI trend strength & direction · price vs session VWAP (TradingView&apos;s: hlc3, resets each day). All read the future.</p>
        </Section>

        <Section title="Market">
          <Row label="Symbol" sub={locked ? 'Pinned while a position is open' : c.symbol === 'NIFTY' ? 'The indicators read the NIFTY monthly future (the index has no volume)' : 'The indicators read this future'}>
            <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
              {ORB_SYMBOLS.map(sym => (
                <button key={sym} type="button" disabled={locked} onClick={() => onPatch({ symbol: sym })} aria-pressed={c.symbol === sym}
                  className={cn('rounded-md px-3 py-1 text-xs font-bold disabled:opacity-50', FOCUS, c.symbol === sym ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{sym}</button>
              ))}
            </div>
          </Row>
          <Row label="Trade" sub={c.instrument === 'options' ? 'Green sells a PE, red sells a CE (nearest expiry)' : 'Green goes long the future, red short'}>
            <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
              {(['futures', 'options'] as const).map(k => (
                <button key={k} type="button" disabled={locked} onClick={() => onPatch({ instrument: k })} aria-pressed={c.instrument === k}
                  className={cn('rounded-md px-3 py-1 text-xs font-bold disabled:opacity-50', FOCUS, c.instrument === k ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{k === 'futures' ? 'Futures' : 'Sell options'}</button>
              ))}
            </div>
          </Row>
          {c.instrument === 'options' && (
            <Row label="Strike" sub={`0 = ATM · +N = N strikes OTM · −N = ITM (−${MAX_STRIKE_OFFSET}…${MAX_STRIKE_OFFSET})`}>
              <RuleNumInput value={c.strikeOffset} step={1} min={-MAX_STRIKE_OFFSET} max={MAX_STRIKE_OFFSET} label="Strike offset" disabled={locked}
                onCommit={s => onPatch({ strikeOffset: Number(s) })}
                className="h-8 w-16 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100 disabled:opacity-50" />
            </Row>
          )}
        </Section>

        <Section title="Timing">
          <Row label="Timeframe" sub="Signals read only closed bars">
            <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
              {TIMEFRAMES.map(tf => (
                <button key={tf} type="button" onClick={() => onPatch({ timeframe: tf })}
                  className={cn('rounded-md px-3 py-1 text-xs font-bold', FOCUS, c.timeframe === tf ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{tf === 60 ? '1h' : `${tf}m`}</button>
              ))}
            </div>
          </Row>
          <Row label="Entries from"><TimeField label="Entries from" value={c.entryStart} onCommit={v => onPatch({ entryStart: v })} /></Row>
          <Row label="Entries until"><TimeField label="Entries until" value={c.entryEnd} onCommit={v => onPatch({ entryEnd: v })} /></Row>
          <Row label="Cutoff (square off)" sub={c.symbol === 'NIFTY' ? 'NSE MIS; the broker squares off near 15:20' : 'MCX MIS; the broker squares off near 23:25'}><TimeField label="Cutoff" value={c.eodExit} onCommit={v => onPatch({ eodExit: v })} /></Row>
        </Section>

        <Section title="Risk">
          <Row label="Lots" sub={`${c.symbol} · no cap; the exchange rejects an order above its freeze quantity`}>
            <RuleNumInput value={c.lots} step={1} min={1} label="Lots" disabled={locked} onCommit={s => onPatch({ lots: Number(s) })}
              className="h-8 w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100 disabled:opacity-50" />
          </Row>
          <Row label="Hard stop (points)" sub="Points on the future's price from its entry, also for options rows (never option premium). Required for REAL. 0 = off">
            <RuleNumInput value={c.stopPts} step={5} min={0} label="Hard stop points" onCommit={s => onPatch({ stopPts: Number(s) })}
              className="h-8 w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100" />
          </Row>
          <Row label="Lock & Trail start (pts)" sub="Favorable move to activate trailing. 0 = off (fixed stop only)">
            <RuleNumInput value={c.trailStartPts ?? 0} step={5} min={0} label="Trail start points" onCommit={s => onPatch({ trailStartPts: Number(s) })}
              className="h-8 w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100" />
          </Row>
          {(c.trailStartPts ?? 0) > 0 && (
            <Row label="Trail gap (points)" sub={c.trailGapPts !== undefined && c.trailGapPts > (c.trailStartPts ?? 0) ? `Gap is larger than the start (${c.trailStartPts}): once trailing begins the stop jumps to a locked LOSS of ${c.trailGapPts - (c.trailStartPts ?? 0)} pts` : 'Distance kept behind peak profit price'}>
              <RuleNumInput value={c.trailGapPts ?? 15} step={5} min={1} label="Trail gap points" onCommit={s => onPatch({ trailGapPts: Number(s) })}
                className="h-8 w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100" />
            </Row>
          )}
          <Row label="Daily loss limit (₹)" sub="Realised + open; closes and halts">
            <RuleNumInput value={c.dailyLossLimit} step={500} min={100} label="Daily loss limit" onCommit={s => onPatch({ dailyLossLimit: Number(s) })}
              className="h-8 w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100" />
          </Row>
        </Section>

        <Section title="Account">
          <Row label="Broker" sub={locked ? 'Pinned while a position is open' : 'Orders go to this account'}>
            <select value={c.broker} disabled={locked} onChange={e => onPatch({ broker: e.target.value as OrbConfig['broker'] })} aria-label="Broker"
              className={cn('h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs font-bold text-zinc-200 disabled:opacity-50', FOCUS)}>
              <option value="dhan">Dhan</option><option value="kotak">Kotak</option><option value="zerodha">Zerodha</option>
            </select>
          </Row>
          <Row label="Mode" sub="REAL is armed again on every page load">
            <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
              {(['SIM', 'REAL'] as const).map(m => (
                <button key={m} type="button" disabled={locked} onClick={() => onMode(m)}
                  className={cn('rounded-md px-3 py-1 text-xs font-bold disabled:opacity-50', FOCUS,
                    ledger.mode === m ? (m === 'REAL' ? 'bg-red-600 text-oncolor' : 'bg-emerald-600 text-oncolor') : 'text-zinc-400 hover:text-zinc-200')}>{m}</button>
              ))}
            </div>
          </Row>
          <Row label="Clear SIM trades">
            <button type="button" onClick={onResetSim} className={cn('rounded-lg border border-zinc-700 px-3 py-1 text-xs font-bold text-zinc-300 hover:bg-zinc-800', FOCUS)}>Reset</button>
          </Row>
        </Section>

        <button type="button" onClick={onClose} className={cn('mt-auto rounded-xl bg-emerald-600 py-2.5 text-sm font-bold text-oncolor hover:bg-emerald-500', FOCUS)}>Done</button>
      </aside>
    </div>
  );
}
