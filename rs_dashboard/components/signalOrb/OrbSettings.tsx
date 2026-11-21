'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { RuleNumInput } from '@/components/breakdownScalper/RuleNumInput';
import { ReplayCard } from '@/components/signalOrb/ReplayCard';
import { useOrbSettings } from '@/components/signalOrb/useOrbSettings';
import { cn } from '@/lib/utils';
import { KIND_LABEL, TIMEFRAMES, defaultSpec, specLabel, type IndicatorKind, type IndicatorSpec } from '@/lib/signalOrb';
import { MAX_STRIKE_OFFSET, ORB_SYMBOLS, isPremiumInstrument, type OrbConfig, type OrbLedger } from '@/lib/signalOrbLedger';
import type { PremiumConfig } from '@/lib/orbFocus';
import type { ReplaySummary } from '@/lib/signalOrb';

// /signal-orb/settings: the Signal Orb's rules on a full page. Three columns on a wide screen (market / timing / account, indicators /
// replay, risk / straddle rules), two on a laptop, one on a narrow window. Every row is a label on the left and its control in one
// fixed-width column on the right, so the controls line up down the page. Every field commits on blur / Enter
// (dhan-commit-on-blur) and goes to the server as one setConfig patch; the server bounds and may refuse it, and a refusal shows in
// a banner that stays on screen.

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const KINDS: IndicatorKind[] = ['ema', 'supertrend', 'emaCross', 'rsi', 'stochRsi', 'adx', 'vwap'];
/** One look for every number box, so they align and read alike. */
const NUM = 'h-8 w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center font-mono text-sm text-zinc-100 disabled:opacity-50';
const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function TimeField({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; });
  // a refused edit leaves `value` unchanged, so the field would keep showing what was typed: show what is saved again
  const commit = () => {
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(draft) && draft !== value) { onCommit(draft); setTimeout(() => { if (!focused.current) setDraft(valueRef.current); }, 1_000); }
    else setDraft(value);
  };
  return (
    <input value={draft} aria-label={label} inputMode="numeric" placeholder="HH:MM"
      onFocus={() => { focused.current = true; }}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(value); }}
      className={cn(NUM, FOCUS)} />
  );
}

/** A setting: its name and explanation on the left, its control in the right-hand column (`stack`: the control takes the full width below). */
function Row({ label, sub, children, stack }: { label: string; sub?: string; children: React.ReactNode; stack?: boolean }) {
  return (
    <div className={cn('grid items-center gap-x-4 gap-y-2 border-t border-zinc-800/70 py-3 first:border-t-0 first:pt-0 last:pb-0', stack ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_13rem]')}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        {sub && <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{sub}</p>}
      </div>
      <div className={cn('flex min-h-8 items-center gap-2', stack ? 'w-full' : 'justify-end')}>{children}</div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-400">{title}</h2>
        {hint && <span className="text-[10px] text-zinc-600">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** A segmented choice. `full`: the buttons share the whole width (the stacked rows); else it sits as wide as its labels. */
function Seg<T extends string | number>({ value, options, onPick, label, disabled, full }: {
  value: T; options: readonly { v: T; label: string }[]; onPick: (v: T) => void; label: string; disabled?: boolean; full?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5', full ? 'w-full' : 'inline-flex')}>
      {options.map(o => (
        <button key={String(o.v)} type="button" disabled={disabled} aria-pressed={value === o.v} onClick={() => onPick(o.v)}
          className={cn('whitespace-nowrap rounded-md py-1 text-xs font-bold disabled:opacity-50', full ? 'flex-1 px-1.5' : 'px-3', FOCUS, value === o.v ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Check = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <input type="checkbox" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} className={cn('h-4 w-4 accent-emerald-500', FOCUS)} />
);

const field = (label: string, v: number, on: (n: number) => void, step = 1, min = 1) => (
  <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
    {label}
    <RuleNumInput value={v} step={step} min={min} label={label} onCommit={s => { const n = Number(s); if (Number.isFinite(n)) on(n); }}
      className="h-7 w-16 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 text-center font-mono text-xs text-zinc-100" />
  </label>
);

function SpecEditor({ spec, onChange, onRemove }: { spec: IndicatorSpec; onChange: (s: IndicatorSpec) => void; onRemove: () => void }) {
  const set = (patch: Partial<IndicatorSpec>) => onChange({ ...spec, ...patch } as IndicatorSpec);
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <span className="font-mono text-xs font-bold text-zinc-100">{specLabel(spec)}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {spec.kind === 'ema' && field('Period', spec.period, n => set({ period: n }), 1, 2)}
        {spec.kind === 'emaCross' && <>{field('Fast', spec.fast, n => set({ fast: n }), 1, 2)}{field('Slow', spec.slow, n => set({ slow: n }), 1, 3)}</>}
        {spec.kind === 'supertrend' && <>{field('Period', spec.period, n => set({ period: n }), 1, 2)}{field('Mult', spec.mult, n => set({ mult: n }), 0.5, 0.5)}</>}
        {spec.kind === 'rsi' && <>{field('Period', spec.period, n => set({ period: n }), 1, 2)}{field('Bull >', spec.upper, n => set({ upper: n }))}{field('Bear <', spec.lower, n => set({ lower: n }))}</>}
        {spec.kind === 'stochRsi' && <>
          {field('RSI', spec.rsiPeriod, n => set({ rsiPeriod: n }), 1, 2)}{field('Stoch', spec.stochPeriod, n => set({ stochPeriod: n }), 1, 2)}
          {field('K', spec.k, n => set({ k: n }))}{field('D', spec.d, n => set({ d: n }))}
        </>}
        {spec.kind === 'adx' && <>{field('Period', spec.period, n => set({ period: n }), 1, 2)}{field('Min ADX', spec.minAdx, n => set({ minAdx: n }), 1, 5)}</>}
        {spec.kind === 'vwap' && <span className="text-[11px] text-zinc-500">Price vs the session VWAP</span>}
      </div>
      <button type="button" onClick={onRemove} aria-label={`Remove ${specLabel(spec)}`} title="Remove"
        className={cn('rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400', FOCUS)}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const INSTRUMENTS = [
  { v: 'futures', label: 'Futures' }, { v: 'options', label: 'Sell option' }, { v: 'synthetic', label: 'Synthetic' },
  { v: 'straddle', label: 'Straddle' }, { v: 'strangle', label: 'Strangle' },
] as const;

function Settings({ ledger, locked, onPatch, onMode, onResetSim, replayed, unitsPerLot, price }: {
  ledger: OrbLedger; locked: boolean; onPatch: (p: Partial<OrbConfig>) => void; onMode: (m: 'SIM' | 'REAL') => void; onResetSim: () => void;
  replayed: ReplaySummary | null; unitsPerLot: number; price: number | null;
}) {
  const c = ledger.config;
  const premium = isPremiumInstrument(c.instrument);
  /** A straddle / strangle rule: sent as a partial `premium` patch (the server merges and bounds it). */
  const P = (patch: Partial<PremiumConfig>) => onPatch({ premium: patch as PremiumConfig });
  // risk in rupees: a point is worth unitsPerLot x lots; the stop is measured on the future, so for a sold option this is the
  // most it can cost if the option moved one-for-one (it moves by its delta, so a real loss is smaller)
  const perPt = unitsPerLot > 0 ? unitsPerLot * c.lots : 0;
  const stopRs = perPt * c.stopPts;
  const lockPts = (c.trailStartPts ?? 0) - (c.trailGapPts ?? 15);
  const setSpecs = (indicators: IndicatorSpec[]) => onPatch({ indicators });
  const addKind = (kind: IndicatorKind) => {
    let i = 1;
    while (c.indicators.some(s => s.id === `${kind}-${i}`)) i++;
    setSpecs([...c.indicators, defaultSpec(kind, `${kind}-${i}`)]);
  };
  const tradeSub = c.instrument === 'options' ? 'Green sells a PE, red sells a CE (nearest expiry)'
    : c.instrument === 'synthetic' ? 'Green: long synthetic (buy the ATM CE, sell the ATM PE); red: short synthetic (buy the PE, sell the CE). Dhan only'
    : premium ? 'Sold at the entry time on a timer, not the signal; the Focus Tool\'s SL / target rules run on the server, so closing the tab is safe. Dhan only'
    : 'Green goes long the future, red short';

  const market = (
    <Section title="Market">
      <Row label="Symbol" stack sub={locked ? 'Pinned while a position is open' : c.symbol === 'NIFTY' ? 'The indicators read the NIFTY monthly future (the index has no volume)' : 'The indicators read this future'}>
        <Seg full label="Symbol" value={c.symbol} disabled={locked} onPick={v => onPatch({ symbol: v })} options={ORB_SYMBOLS.map(s => ({ v: s, label: s }))} />
      </Row>
      <Row label="Trade" stack sub={tradeSub}>
        <Seg full label="Trade" value={c.instrument} disabled={locked} onPick={v => onPatch({ instrument: v })} options={INSTRUMENTS} />
      </Row>
      {(c.instrument === 'options' || c.instrument === 'strangle') && (
        <Row label={c.instrument === 'strangle' ? 'Strikes OTM' : 'Strike'}
          sub={c.instrument === 'strangle' ? 'Each leg this many strikes OTM of the ATM (CE up, PE down), at least 1' : `0 = ATM · +N = N strikes OTM · −N = ITM (−${MAX_STRIKE_OFFSET}…${MAX_STRIKE_OFFSET})`}>
          <RuleNumInput value={c.strikeOffset} step={1} min={-MAX_STRIKE_OFFSET} max={MAX_STRIKE_OFFSET} label="Strike offset" disabled={locked}
            onCommit={s => onPatch({ strikeOffset: Number(s) })} className={NUM} />
        </Row>
      )}
    </Section>
  );

  const timing = (
    <Section title="Timing">
      {!premium && (
        <Row label="Timeframe" stack sub="Signals read only closed bars">
          <Seg full label="Timeframe" value={c.timeframe} onPick={v => onPatch({ timeframe: v })} options={TIMEFRAMES.map(t => ({ v: t, label: t === 60 ? '1h' : `${t}m` }))} />
        </Row>
      )}
      {!premium && <Row label="Entries from" sub="No entry before this time"><TimeField label="Entries from" value={c.entryStart} onCommit={v => onPatch({ entryStart: v })} /></Row>}
      <Row label={premium ? 'Last entry' : 'Entries until'} sub={premium ? 'No entry is taken after this time' : 'No entry from this time on'}>
        <TimeField label="Entries until" value={c.entryEnd} onCommit={v => onPatch({ entryEnd: v })} />
      </Row>
      <Row label="Cutoff (square off)" sub={c.symbol === 'NIFTY' ? 'NSE MIS; the broker squares off near 15:20' : 'MCX MIS; the broker squares off near 23:25'}>
        <TimeField label="Cutoff" value={c.eodExit} onCommit={v => onPatch({ eodExit: v })} />
      </Row>
    </Section>
  );

  const account = (
    <Section title="Account">
      <Row label="Broker" sub={locked ? 'Pinned while a position is open' : 'Orders go to this account'}>
        <select value={c.broker} disabled={locked} onChange={e => onPatch({ broker: e.target.value as OrbConfig['broker'] })} aria-label="Broker"
          className={cn('h-8 w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs font-bold text-zinc-200 disabled:opacity-50', FOCUS)}>
          <option value="dhan">Dhan</option><option value="kotak">Kotak</option><option value="zerodha">Zerodha</option>
        </select>
      </Row>
      <Row label="Mode" sub="REAL is armed again on every page load">
        <div role="group" aria-label="Mode" className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
          {(['SIM', 'REAL'] as const).map(m => (
            <button key={m} type="button" disabled={locked} aria-pressed={ledger.mode === m} onClick={() => onMode(m)}
              className={cn('rounded-md px-4 py-1 text-xs font-bold disabled:opacity-50', FOCUS,
                ledger.mode === m ? (m === 'REAL' ? 'bg-red-600 text-oncolor' : 'bg-emerald-600 text-oncolor') : 'text-zinc-400 hover:text-zinc-200')}>{m}</button>
          ))}
        </div>
      </Row>
      <Row label="Clear SIM trades" sub="Removes every paper trade from the ledger">
        <button type="button" onClick={onResetSim} className={cn('h-8 w-24 rounded-lg border border-zinc-700 px-3 text-xs font-bold text-zinc-300 hover:bg-zinc-800', FOCUS)}>Reset</button>
      </Row>
    </Section>
  );

  const indicators = (
    <Section title="Indicators — all must agree" hint={`${c.indicators.length} of 8`}>
      {premium && <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">Not used for a straddle / strangle: it is sold at its entry time, not on the signal.</p>}
      <div className={cn('flex flex-col gap-2', premium && 'opacity-50')}>
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
      <p className="mt-3 text-[11px] leading-snug text-zinc-500">Price vs EMA · Supertrend direction (TradingView&apos;s ta.supertrend on true high / low) · fast vs slow EMA · RSI above / below its band · Stoch RSI K vs D outside its extremes · ADX / DMI trend strength & direction · price vs session VWAP (TradingView&apos;s: hlc3, resets each day). All read the future.</p>
    </Section>
  );

  const replay = !premium && (
    <Section title="Replay — what if">
      <ReplayCard r={replayed} tf={c.timeframe} compact bare futuresPoints={c.instrument !== 'futures'} />
      <p className="mt-3 text-[11px] leading-snug text-zinc-500">What-if, not live results: these rules replayed over the last 20 sessions (fills at the bar close, no costs). Fills/day counts every entry and exit, so a flip is 2. Use it to spot a setting that flips too often before you arm.</p>
    </Section>
  );

  const risk = (
    <Section title="Risk">
      <Row label="Lots" sub={`${c.symbol} · no cap; the exchange rejects an order above its freeze quantity${perPt > 0 ? `. ${c.lots} × ${unitsPerLot} = ${(c.lots * unitsPerLot).toLocaleString('en-IN')} units · 1 pt = ${rs(perPt)}${price ? ` · exposure ${rs(price * c.lots * unitsPerLot)}` : ''}` : ''}`}>
        <RuleNumInput value={c.lots} step={1} min={1} label="Lots" disabled={locked} onCommit={s => onPatch({ lots: Number(s) })} className={NUM} />
      </Row>
      {!premium && (
        <>
          <Row label="Hard stop (points)" sub={`Points on the future's price from its entry, also for options rows (never option premium). Required for REAL. 0 = off${stopRs > 0 ? `. Worst case per stop ≈ ${rs(stopRs)}${c.instrument === 'options' ? ' on the future (a sold option loses less)' : ''}` : ''}`}>
            <RuleNumInput value={c.stopPts} step={5} min={0} label="Hard stop points" onCommit={s => onPatch({ stopPts: Number(s) })} className={NUM} />
          </Row>
          <Row label="Lock & Trail start (pts)" sub={(c.trailStartPts ?? 0) > 0 && lockPts > 0 ? `Favorable move to activate trailing. Once active the stop sits at least +${lockPts} pts in profit${perPt > 0 ? ` (${rs(lockPts * perPt)})` : ''}` : 'Favorable move to activate trailing. 0 = off (fixed stop only)'}>
            <RuleNumInput value={c.trailStartPts ?? 0} step={5} min={0} label="Trail start points" onCommit={s => onPatch({ trailStartPts: Number(s) })} className={NUM} />
          </Row>
          {(c.trailStartPts ?? 0) > 0 && (
            <Row label="Trail gap (points)" sub={c.trailGapPts !== undefined && c.trailGapPts > (c.trailStartPts ?? 0) ? `Gap is larger than the start (${c.trailStartPts}): once trailing begins the stop jumps to a locked LOSS of ${c.trailGapPts - (c.trailStartPts ?? 0)} pts` : 'Distance kept behind peak profit price'}>
              <RuleNumInput value={c.trailGapPts ?? 15} step={5} min={1} label="Trail gap points" onCommit={s => onPatch({ trailGapPts: Number(s) })} className={NUM} />
            </Row>
          )}
        </>
      )}
      <Row label="Daily loss limit (₹)" sub={`Realised + open; closes and halts${stopRs > 0 ? `. = ${(c.dailyLossLimit / stopRs).toFixed(1)} full stops at this size` : ''}`}>
        <RuleNumInput value={c.dailyLossLimit} step={500} min={100} label="Daily loss limit" onCommit={s => onPatch({ dailyLossLimit: Number(s) })} className={NUM} />
      </Row>
    </Section>
  );

  const rules = premium && (
    <Section title={`Short ${c.instrument} rules`} hint="Focus Tool rules, run on the server">
      <p className="mb-3 text-[11px] leading-snug text-zinc-500">The Ultimate Scalper&apos;s own rules (the same functions the Focus Tool page uses). 0 = off. A REAL run needs a leg SL or a total SL.</p>
      <Row label="Entry time" sub="Sold at the first minute at or after this, once a day (Auto must be on), or with Enter now">
        <TimeField label="Entry time" value={c.premium.entryTime} onCommit={v => P({ entryTime: v })} />
      </Row>
      <Row label="Leg SL ×" sub={`A leg exits when its premium reaches its entry × this (e.g. 1.5 = +50%). ${perPt > 0 ? `One leg moving 1 point = ${rs(perPt)}.` : ''}`}>
        <RuleNumInput value={c.premium.legSlX} step={0.1} min={0} label="Leg SL multiple" onCommit={s => P({ legSlX: Number(s) })} className={NUM} />
      </Row>
      <Row label="SL to cost" sub="After one leg's SL, the other leg's stop moves to its entry premium">
        <Check label="SL to cost" checked={c.premium.slToCost} onChange={v => P({ slToCost: v })} />
      </Row>
      <Row label="Total SL (% of premium)" sub="Exit everything when the combined premium of the legs still open is up this % over their entry. After one leg stops it measures the other leg alone: use the ₹ total SL to cap the whole loss">
        <RuleNumInput value={c.premium.totalSlPct} step={5} min={0} label="Total SL percent" onCommit={s => P({ totalSlPct: Number(s) })} className={NUM} />
      </Row>
      <Row label="Total SL (₹)" sub="Exit everything when the P&L falls to minus this (MTM)">
        <RuleNumInput value={c.premium.totalSlRs} step={500} min={0} label="Total SL rupees" onCommit={s => P({ totalSlRs: Number(s) })} className={NUM} />
      </Row>
      <Row label="Leg target (%)" sub="A leg exits when its premium has decayed this % from entry">
        <RuleNumInput value={c.premium.legTgtPct} step={5} min={0} label="Leg target percent" onCommit={s => P({ legTgtPct: Number(s) })} className={NUM} />
      </Row>
      <Row label="Overall target" sub={c.premium.targetMode === 'mtm' ? 'Exit everything at this profit in rupees' : 'Exit everything at this % of the combined entry premium'}>
        <Seg label="Overall target unit" value={c.premium.targetMode} onPick={m => P({ targetMode: m })} options={[{ v: 'premiumPct', label: '%' }, { v: 'mtm', label: '₹' }]} />
        <RuleNumInput value={c.premium.targetValue} step={c.premium.targetMode === 'mtm' ? 500 : 5} min={0} label="Overall target" onCommit={s => P({ targetValue: Number(s) })} className={NUM} />
      </Row>
      <Row label="Leg Trail SL" sub="Every X the premium falls below entry, the leg's stop moves Y closer (Y at most X)">
        <Check label="Leg trail SL" checked={c.premium.trail.enabled} onChange={v => P({ trail: { ...c.premium.trail, enabled: v } })} />
      </Row>
      {c.premium.trail.enabled && (
        <Row label="Trail every / by / start" stack sub={c.premium.trail.unit === 'pct' ? 'Percent of the leg\'s entry premium' : 'Premium points'}>
          <div className="grid w-full grid-cols-[auto_1fr_1fr_1fr] items-end gap-3">
            <Seg label="Trail unit" value={c.premium.trail.unit} onPick={u => P({ trail: { ...c.premium.trail, unit: u } })} options={[{ v: 'pts', label: 'pts' }, { v: 'pct', label: '%' }]} />
            {([['every', 'Every'], ['by', 'By'], ['startAt', 'Start at']] as const).map(([k, lab]) => (
              <label key={k} className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                {lab}
                <RuleNumInput value={c.premium.trail[k]} step={1} min={0} label={`Trail ${lab}`} onCommit={s => P({ trail: { ...c.premium.trail, [k]: Number(s) } })} className={cn(NUM, 'w-full')} />
              </label>
            ))}
          </div>
        </Row>
      )}
    </Section>
  );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <div className="flex flex-col gap-4">{market}{timing}{account}</div>
      <div className="flex flex-col gap-4">{indicators}{replay}</div>
      <div className="flex flex-col gap-4 lg:col-span-2 xl:col-span-1">{risk}{rules}</div>
    </div>
  );
}

export default function OrbSettings() {
  const s = useOrbSettings();
  const l = s.ledger;
  return (
    <div className="relative min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 bg-zinc-950/90 px-4 py-2.5 backdrop-blur sm:px-6">
        <div className="flex items-center gap-3">
          <Link href="/signal-orb" className={cn('flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100', FOCUS)}>
            <ArrowLeft className="h-3.5 w-3.5" /> Signal Orb
          </Link>
          <div>
            <h1 className="text-[11px] font-black uppercase tracking-[0.45em] text-zinc-100">Rules</h1>
            <p className="font-mono text-[10px] text-zinc-500">
              {l ? `${l.config.symbol} · ${l.config.instrument} · ${l.config.lots} lot${l.config.lots > 1 ? 's' : ''}` : 'loading…'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {s.live && <span className="whitespace-nowrap rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-400" title="A position is open: broker, mode, symbol, trade and lots are pinned">POSITION OPEN · some settings are pinned</span>}
          {l && (
            <span className={cn('whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-widest',
              l.mode === 'REAL' ? 'border-red-500/40 bg-red-500/10 text-red-400' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400')}>
              {l.mode} · {l.config.broker.toUpperCase()}
            </span>
          )}
          <NavBar />
        </div>
      </header>

      {/* sticky: a refusal must stay in view wherever on the page the edit was made */}
      {s.error && (
        <div className="sticky top-[53px] z-20 border-b border-red-500/30 bg-zinc-950 px-4 py-2 sm:px-6" role="alert">
          <p className="mx-auto max-w-[1760px] rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">Not saved: {s.error}</p>
        </div>
      )}

      <main className="mx-auto w-full max-w-[1760px] px-4 py-5 sm:px-6">
        {l ? (
          <Settings ledger={l} locked={!!s.live} onPatch={s.patch} onMode={s.setMode} onResetSim={s.resetSim}
            replayed={s.replayed} unitsPerLot={s.unitsPerLot} price={s.price} />
        ) : <p className="py-16 text-center text-sm text-zinc-500">Loading the rules…</p>}
        <p className="mt-6 text-center text-[11px] text-zinc-600">Every change is saved as you make it. The orb page picks it up within a few seconds.</p>
      </main>
    </div>
  );
}
