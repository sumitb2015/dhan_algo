'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlarmClock, ShieldAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CONDITIONS, DEFAULT_SOUND_SEC, MAX_ALERT_LOTS, MAX_SOUND_SEC, type AlertCondition, type InstrumentSpec, type PriceAlert } from '@/lib/priceAlerts';
import { postAlertAction, usePriceAlertsUi, type AlertDialogInit } from '@/lib/priceAlertsUi';

// "Create alert on <symbol>" — the TradingView-style dialog. Instruments are picked by name (index / underlying + expiry
// + strike); the server resolves the security id. A trade alert places ONE Dhan MARKET order when it fires, so it is always
// "Once only", and only on a day REAL orders are armed in the panel.

const INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

type Kind = InstrumentSpec['kind'];
interface Draft { kind: Kind; symbol: string; underlying: string; expiry: string; strike: string; optType: 'CE' | 'PE' }

const emptyDraft = (kind: Kind = 'index'): Draft => ({ kind, symbol: 'NIFTY', underlying: 'NIFTY', expiry: '', strike: '', optType: 'CE' });

function draftOf(spec: InstrumentSpec | undefined): Draft {
  if (!spec) return emptyDraft();
  if (spec.kind === 'index') return { ...emptyDraft('index'), symbol: spec.symbol, underlying: spec.symbol };
  if (spec.kind === 'future') return { ...emptyDraft('future'), underlying: spec.underlying, expiry: spec.expiry };
  return { kind: 'option', symbol: spec.underlying, underlying: spec.underlying, expiry: spec.expiry, strike: String(spec.strike), optType: spec.optType };
}

function specOf(d: Draft): InstrumentSpec | string {
  if (d.kind === 'index') return { kind: 'index', symbol: d.symbol };
  if (!d.underlying) return 'Pick an underlying';
  if (!d.expiry) return 'Pick an expiry';
  if (d.kind === 'future') return { kind: 'future', underlying: d.underlying, expiry: d.expiry };
  const strike = Number(d.strike);
  if (!(strike > 0)) return 'Pick a strike';
  return { kind: 'option', underlying: d.underlying, expiry: d.expiry, strike, optType: d.optType };
}

function specFromAlert(a: PriceAlert['instrument']): InstrumentSpec {
  if (a.kind === 'index') return { kind: 'index', symbol: a.underlying };
  if (a.kind === 'future') return { kind: 'future', underlying: a.underlying, expiry: a.expiry ?? '' };
  return { kind: 'option', underlying: a.underlying, expiry: a.expiry ?? '', strike: a.strike ?? 0, optType: a.optType ?? 'CE' };
}

const field = 'h-8 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60';
const label = 'text-[11px] font-semibold text-zinc-400';

function Seg<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: [T, string][]; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex rounded-md border border-zinc-700 overflow-hidden">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cn('flex-1 h-7 text-[11px] font-bold cursor-pointer transition-colors',
            value === v ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100')}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Underlying + expiry (+ strike / CE-PE) from the master list, via the P&F contract routes (read-only). */
function ContractPicker({ d, set, allowIndex, idPrefix }: { d: Draft; set: (p: Partial<Draft>) => void; allowIndex: boolean; idPrefix: string }) {
  const [suggest, setSuggest] = useState<string[]>([]);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [strikes, setStrikes] = useState<number[]>([]);
  const [uDraft, setUDraft] = useState(d.underlying);
  const segment = d.kind === 'option' ? 'options' : 'futures';

  // A new underlying picked elsewhere (kind switch, suggestion) resets the typed text — during render, not in an effect.
  const [shownU, setShownU] = useState(d.underlying);
  if (shownU !== d.underlying) { setShownU(d.underlying); setUDraft(d.underlying); }
  const typed = uDraft.trim().toUpperCase();
  const visibleSuggest = typed && typed !== d.underlying ? suggest : [];

  // Underlying suggestions as the user types.
  useEffect(() => {
    if (d.kind === 'index') return;
    const q = uDraft.trim().toUpperCase();
    if (!q || q === d.underlying) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/straddle-pnf/search?segment=${segment}&q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then(r => r.json()).then(j => setSuggest(j.success ? (j.results as { symbol: string }[]).map(x => x.symbol) : []))
        .catch(() => {});
    }, 200);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [uDraft, d.kind, d.underlying, segment]);

  // Expiries (and strikes for options) for the chosen underlying.
  useEffect(() => {
    if (d.kind === 'index' || !d.underlying) return;
    const ctl = new AbortController();
    const qs = new URLSearchParams({ kind: segment, underlying: d.underlying, nospot: '1' });
    if (d.kind === 'option' && d.expiry) qs.set('expiry', d.expiry);
    fetch(`/api/straddle-pnf/contracts?${qs}`, { signal: ctl.signal })
      .then(r => r.json())
      .then(j => {
        if (!j.success) { setExpiries([]); setStrikes([]); return; }
        setExpiries(j.expiries ?? []);
        setStrikes(j.strikes ?? []);
        if (!d.expiry || !(j.expiries ?? []).includes(d.expiry)) set({ expiry: j.expiry ?? j.expiries?.[0] ?? '' });
      })
      .catch(() => {});
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.kind, d.underlying, d.expiry, segment]);

  const kinds: [Kind, string][] = allowIndex ? [['index', 'Index'], ['future', 'Future'], ['option', 'Option']] : [['future', 'Future'], ['option', 'Option']];
  const commitUnderlying = (v: string) => {
    const u = v.trim().toUpperCase();
    setSuggest([]);
    if (u && u !== d.underlying) set({ underlying: u, expiry: '', strike: '' });
  };

  return (
    <div className="space-y-2">
      <Seg ariaLabel="Instrument type" value={d.kind} options={kinds} onChange={k => set({ kind: k, strike: '' })} />
      {d.kind === 'index' ? (
        <select aria-label="Index" className={field} value={d.symbol} onChange={e => set({ symbol: e.target.value, underlying: e.target.value })}>
          {INDICES.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
      ) : (
        <>
          <div className="relative">
            <input aria-label="Underlying" id={`${idPrefix}-und`} className={field} placeholder="Underlying (NIFTY, CRUDEOILM…)"
              value={uDraft} onChange={e => setUDraft(e.target.value.toUpperCase())}
              onBlur={() => setTimeout(() => commitUnderlying(uDraft), 150)}
              onKeyDown={e => { if (e.key === 'Enter') commitUnderlying(uDraft); }} />
            {visibleSuggest.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 shadow-xl max-h-40 overflow-y-auto">
                {visibleSuggest.map(s => (
                  <button key={s} type="button" className="block w-full text-left px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 cursor-pointer"
                    onMouseDown={e => { e.preventDefault(); setUDraft(s); commitUnderlying(s); }}>{s}</button>
                ))}
              </div>
            )}
          </div>
          <div className={cn('grid gap-2', d.kind === 'option' ? 'grid-cols-[1fr_1fr_88px]' : 'grid-cols-1')}>
            <select aria-label="Expiry" className={field} value={d.expiry} onChange={e => set({ expiry: e.target.value, strike: '' })}>
              {!expiries.length && <option value="">—</option>}
              {expiries.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            {d.kind === 'option' && (
              <>
                <select aria-label="Strike" className={field} value={d.strike} onChange={e => set({ strike: e.target.value })}>
                  <option value="">Strike</option>
                  {strikes.map(s => <option key={s} value={String(s)}>{s}</option>)}
                </select>
                <Seg ariaLabel="Option type" value={d.optType} options={[['CE', 'CE'], ['PE', 'PE']]} onChange={v => set({ optType: v })} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function AlertDialog({ init, onClose }: { init: AlertDialogInit; onClose: () => void }) {
  const { view } = usePriceAlertsUi();
  const editing = useMemo(() => (init.editId ? view?.alerts.find(a => a.id === init.editId) : undefined), [init.editId, view]);

  const [inst, setInst] = useState<Draft>(() => draftOf(editing ? specFromAlert(editing.instrument) : init.instrument));
  const [condition, setCondition] = useState<AlertCondition>(editing?.condition ?? 'cross');
  const [value, setValue] = useState(editing ? String(editing.value) : init.value ? String(init.value) : '');
  const [trigger, setTrigger] = useState<'once' | 'every'>(editing?.trigger ?? 'once');
  const [expires, setExpires] = useState(editing?.expiresAt ? toLocalInput(editing.expiresAt) : '');
  const [soundSec, setSoundSec] = useState(String(editing?.soundSec ?? view?.defaultSoundSec ?? DEFAULT_SOUND_SEC));
  const [message, setMessage] = useState(editing?.message ?? '');
  const ea = editing?.action;
  const [isTrade, setIsTrade] = useState(ea?.kind === 'trade');
  const [contract, setContract] = useState<Draft>(() => ea?.kind === 'trade' ? draftOf(specFromAlert(ea.contract)) : { ...draftOf(init.instrument), kind: init.instrument?.kind === 'future' ? 'future' : 'option' });
  const [side, setSide] = useState<'BUY' | 'SELL'>(ea?.kind === 'trade' ? ea.side : 'BUY');
  const [lots, setLots] = useState(ea?.kind === 'trade' ? String(ea.lots) : '1');
  const [product, setProduct] = useState<'INTRADAY' | 'MARGIN'>(ea?.kind === 'trade' ? ea.product : 'INTRADAY');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = inst.kind === 'index' ? inst.symbol
    : inst.kind === 'future' ? `${inst.underlying} FUT ${inst.expiry}`
      : `${inst.underlying} ${inst.strike || '—'} ${inst.optType} ${inst.expiry}`;

  const submit = async () => {
    const instrument = specOf(inst);
    if (typeof instrument === 'string') { toast.error(instrument); return; }
    let action: Record<string, unknown> = { kind: 'notify' };
    if (isTrade) {
      const c = specOf(contract);
      if (typeof c === 'string') { toast.error(`Trade: ${c}`); return; }
      action = { kind: 'trade', contract: c, side, lots: Number(lots), product };
    }
    const alert = {
      instrument, condition, value: Number(value), trigger: isTrade ? 'once' : trigger,
      expiresAt: expires ? new Date(expires).getTime() : null, soundSec: Number(soundSec), message, action,
    };
    setSaving(true);
    try {
      await postAlertAction(editing ? { action: 'update', id: editing.id, alert } : { action: 'create', alert });
      toast.success(editing ? 'Alert updated' : 'Alert created');
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-oncolor-dark/60" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={editing ? 'Edit alert' : 'Create alert'}
        className="w-[440px] max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            <AlarmClock className="h-4 w-4 text-amber-400 shrink-0" />
            <h2 className="text-sm font-bold text-white truncate">{editing ? 'Edit alert on' : 'Create alert on'} <span className="text-amber-400">{title}</span></h2>
          </div>
          <button type="button" aria-label="Close" className="text-zinc-500 hover:text-white cursor-pointer" onClick={onClose}><X className="h-4 w-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-3 items-start">
            <span className={cn(label, 'pt-2')}>Symbol</span>
            <ContractPicker d={inst} set={p => setInst(s => ({ ...s, ...p }))} allowIndex idPrefix="pa-inst" />

            <span className={cn(label, 'pt-2')}>Condition</span>
            <div className="space-y-2">
              <div className="h-8 flex items-center rounded-md border border-zinc-800 bg-zinc-900/60 px-2 text-xs text-zinc-300">Price</div>
              <select aria-label="Condition" className={field} value={condition} onChange={e => setCondition(e.target.value as AlertCondition)}>
                {(Object.keys(CONDITIONS) as AlertCondition[]).map(c => <option key={c} value={c}>{CONDITIONS[c]}</option>)}
              </select>
              <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                <span className="text-xs text-zinc-400">Value</span>
                <input aria-label="Value" type="number" inputMode="decimal" step="any" className={cn(field, 'font-mono')} value={value} onChange={e => setValue(e.target.value)} />
              </div>
            </div>

            <span className={cn(label, 'pt-1.5')}>Trigger</span>
            <div>
              <Seg ariaLabel="Trigger" value={isTrade ? 'once' : trigger} options={[['once', 'Once only'], ['every', 'Every time']]}
                onChange={v => { if (!isTrade) setTrigger(v); }} />
              {isTrade && <p className="mt-1 text-[10px] text-zinc-500">Trade alerts fire once only.</p>}
            </div>

            <span className={cn(label, 'pt-2')}>Expiration</span>
            <div className="flex items-center gap-2">
              <input aria-label="Expiration" type="datetime-local" className={field} value={expires} onChange={e => setExpires(e.target.value)} />
              {expires && <button type="button" className="text-[11px] text-zinc-500 hover:text-white cursor-pointer whitespace-nowrap" onClick={() => setExpires('')}>Open-ended</button>}
            </div>

            <span className={cn(label, 'pt-2')}>Sound</span>
            <div className="flex items-center gap-2">
              <input aria-label="Alarm length in seconds" type="number" min={1} max={MAX_SOUND_SEC} className={cn(field, 'w-20 font-mono')} value={soundSec} onChange={e => setSoundSec(e.target.value)} />
              <span className="text-xs text-zinc-400">seconds</span>
            </div>

            <span className={cn(label, 'pt-2')}>Message</span>
            <input aria-label="Message" className={field} maxLength={200} placeholder="Optional note shown when it fires" value={message} onChange={e => setMessage(e.target.value)} />

            <span className={cn(label, 'pt-1.5')}>Action</span>
            <Seg ariaLabel="Action" value={isTrade ? 'trade' : 'notify'} options={[['notify', 'Notify'], ['trade', 'Place order']]} onChange={v => {
              setIsTrade(v === 'trade');
              // A trade alert's contract defaults to the watched instrument's underlying.
              if (v === 'trade' && !contract.underlying && inst.underlying) setContract(c => ({ ...c, underlying: inst.underlying }));
            }} />
          </div>

          {isTrade && (
            <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-red-400">
                <ShieldAlert className="h-3.5 w-3.5" /> REAL Dhan MARKET order when it fires
              </div>
              <ContractPicker d={contract} set={p => setContract(s => ({ ...s, ...p }))} allowIndex={false} idPrefix="pa-trade" />
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Seg ariaLabel="Side" value={side} options={[['BUY', 'BUY'], ['SELL', 'SELL']]} onChange={setSide} />
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                  Lots
                  <input aria-label="Lots" type="number" min={1} max={MAX_ALERT_LOTS} className={cn(field, 'w-14 font-mono')} value={lots} onChange={e => setLots(e.target.value)} />
                </label>
                <Seg ariaLabel="Product" value={product} options={[['INTRADAY', 'MIS'], ['MARGIN', 'NRML']]} onChange={setProduct} />
              </div>
              <p className="text-[10px] text-zinc-400 leading-relaxed">
                Max {MAX_ALERT_LOTS} lots. Sent only during market hours and on a day REAL orders are armed in the alerts panel; otherwise it only notifies.
                An order with an unknown outcome is never resent.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button type="button" className="h-8 px-3 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:text-white cursor-pointer" onClick={onClose}>Cancel</button>
          <button type="button" disabled={saving} onClick={() => { void submit(); }}
            className={cn('h-8 px-4 rounded-lg text-xs font-bold cursor-pointer disabled:opacity-50',
              isTrade ? 'bg-red-600 hover:bg-red-500 text-oncolor' : 'bg-amber-500 hover:bg-amber-400 text-oncolor-dark')}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
