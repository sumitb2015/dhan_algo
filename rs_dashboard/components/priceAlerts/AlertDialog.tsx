'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlarmClock, Loader2, ShieldAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ALERT_BROKERS, ALERT_UNDERLYINGS, CONDITIONS, DEFAULT_SOUND_SEC, MAX_ALERT_LOTS, MAX_SOUND_SEC, alertBroker, hasIndex,
  isMcxAlertUnderlying, sessionCloseMs,
  type AlertBroker, type AlertCondition, type InstrumentSpec, type PriceAlert,
} from '@/lib/priceAlerts';
import { postAlertAction, usePriceAlertsUi, type AlertDialogInit } from '@/lib/priceAlertsUi';

// "Create alert on <symbol>" — the TradingView-style dialog, for NIFTY (index, futures, options) and MCX CRUDEOIL /
// CRUDEOILM (futures, options) only. Expiries and strikes come from master_list.csv through the P&F contract route and are
// picked automatically (nearest expiry, ATM strike); the server resolves the security id. Expiration offers the valid
// expiries (the alert stops at that day's session close). A trade alert places ONE MARKET order on Dhan or Kotak when it
// fires (Kotak: the same contract resolved server-side in Kotak's master; crude is NRML only there), so it is always
// "Once only", and only on a day REAL orders are armed in the panel.

type Kind = InstrumentSpec['kind'];
interface Draft { kind: Kind; underlying: string; expiry: string; strike: string; optType: 'CE' | 'PE' }

const UNDERLYING_LABEL: Record<string, string> = { NIFTY: 'NIFTY', CRUDEOIL: 'CRUDE OIL', CRUDEOILM: 'CRUDE MINI' };

const emptyDraft = (kind: Kind = 'index', underlying = 'NIFTY'): Draft => ({ kind, underlying, expiry: '', strike: '', optType: 'CE' });

function draftOf(spec: InstrumentSpec | undefined): Draft {
  if (!spec) return emptyDraft();
  if (spec.kind === 'index') return emptyDraft('index', spec.symbol);
  if (spec.kind === 'future') return { ...emptyDraft('future', spec.underlying), expiry: spec.expiry };
  return { kind: 'option', underlying: spec.underlying, expiry: spec.expiry, strike: String(spec.strike), optType: spec.optType };
}

function specOf(d: Draft): InstrumentSpec | string {
  if (d.kind === 'index') return { kind: 'index', symbol: d.underlying };
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

const fmtExpiry = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

const fmtShort = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: '2-digit' });

interface ContractsData { expiries: string[]; strikes: number[]; atm: number | null; expiry: string | null }

/**
 * The live expiries (and, for options, the strikes + ATM of `expiry`) of `underlying` from /api/straddle-pnf/contracts.
 * `kind` null = nothing to load. `withSpot` asks the route for the spot (one quote) so ATM is real, not the list's middle.
 * `onLoad` runs on each answer so the caller can fill in defaults (nearest expiry, ATM strike).
 */
function useContracts(kind: 'futures' | 'options' | null, underlying: string, expiry: string, withSpot: boolean, onLoad?: (d: ContractsData) => void) {
  // `keys`: every key this answer serves. An options answer asked WITHOUT an expiry is also the answer for the expiry the
  // route picked, so filling that expiry in (defaultsFor) does not fetch the same list — and spend a spot quote — again.
  const [got, setGot] = useState<{ keys: string[]; d: ContractsData | null; error: string | null }>({ keys: [], d: null, error: null });
  const key = kind ? `${kind}|${underlying}|${kind === 'options' ? expiry : ''}` : '';
  const gotKeys = useRef<string[]>([]);
  const cb = useRef(onLoad);
  useEffect(() => { cb.current = onLoad; });
  useEffect(() => {
    if (!kind || gotKeys.current.includes(key)) return;
    const ctl = new AbortController();
    const qs = new URLSearchParams({ kind, underlying });
    if (kind === 'options' && expiry) qs.set('expiry', expiry);
    if (!withSpot) qs.set('nospot', '1');
    const done = (keys: string[], d: ContractsData | null, error: string | null) => { gotKeys.current = keys; setGot({ keys, d, error }); };
    fetch(`/api/straddle-pnf/contracts?${qs}`, { signal: ctl.signal })
      .then(r => r.json())
      .then(j => {
        if (!j.success) { done([key], null, j.error ?? 'No contracts'); return; }
        // ATM only from a real spot: without one the route answers the list's middle strike, which is not ATM.
        const d: ContractsData = { expiries: j.expiries ?? [], strikes: j.strikes ?? [], atm: j.spot > 0 ? j.atm ?? null : null, expiry: j.expiry ?? j.expiries?.[0] ?? null };
        done(kind === 'options' && !expiry && d.expiry ? [key, `${kind}|${underlying}|${d.expiry}`] : [key], d, null);
        cb.current?.(d);
      })
      .catch(() => { if (!ctl.signal.aborted) done([key], null, 'Could not load the contract list'); });
    return () => ctl.abort();
    // `key` covers kind / underlying / expiry; withSpot only changes what one request asks for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = got.keys.includes(key);
  return { data: fresh ? got.d : null, loading: !!kind && !fresh, error: fresh ? got.error : null };
}

/** Fills a draft's expiry (nearest when unset / no longer listed) and option strike (ATM when unset / not listed, and only from a live spot). */
function defaultsFor(d: Draft, c: ContractsData): Partial<Draft> | null {
  const patch: Partial<Draft> = {};
  if (!d.expiry || !c.expiries.includes(d.expiry)) patch.expiry = c.expiry ?? c.expiries[0] ?? '';
  // The strikes answered are for c.expiry: usable when that is (or becomes) the draft's expiry.
  const expiry = patch.expiry ?? d.expiry;
  // No spot = no ATM: the strike is left for the user to pick (never a guessed middle strike).
  if (d.kind === 'option' && expiry === c.expiry && c.atm !== null && !c.strikes.includes(Number(d.strike))) {
    patch.strike = String(c.atm);
  }
  return Object.keys(patch).length ? patch : null;
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

/** Underlying, Index / Future / Option, expiry (+ strike / CE-PE); the lists come from `c` (useContracts in the dialog). */
function ContractPicker({ d, set, allowIndex, c }: {
  d: Draft; set: (p: Partial<Draft>) => void; allowIndex: boolean; c: ReturnType<typeof useContracts>;
}) {
  const indexOk = allowIndex && hasIndex(d.underlying);
  const kinds: [Kind, string][] = indexOk ? [['index', 'Index'], ['future', 'Future'], ['option', 'Option']] : [['future', 'Future'], ['option', 'Option']];
  const expiries = c.data?.expiries ?? [];
  const strikes = c.data?.strikes ?? [];
  return (
    <div className="space-y-2">
      <Seg ariaLabel="Underlying" value={d.underlying} options={ALERT_UNDERLYINGS.map(u => [u, UNDERLYING_LABEL[u]] as [string, string])}
        onChange={u => set({ underlying: u, expiry: '', strike: '', ...(d.kind === 'index' && !hasIndex(u) ? { kind: 'future' as Kind } : {}) })} />
      <Seg ariaLabel="Instrument type" value={d.kind} options={kinds} onChange={k => set({ kind: k, expiry: '', strike: '' })} />
      {d.kind !== 'index' && (
        <div className={cn('grid gap-2', d.kind === 'option' ? 'grid-cols-[92px_1fr_80px]' : 'grid-cols-1')}>
          <select aria-label="Expiry" className={field} value={d.expiry} disabled={!expiries.length} onChange={e => set({ expiry: e.target.value, strike: '' })}>
            {!expiries.length && <option value="">{c.loading ? 'Loading expiries…' : 'No expiries'}</option>}
            {expiries.map(x => <option key={x} value={x}>{fmtShort(x)}</option>)}
          </select>
          {d.kind === 'option' && (
            <>
              <select aria-label="Strike" className={field} value={d.strike} disabled={!strikes.length} onChange={e => set({ strike: e.target.value })}>
                {!d.strike && <option value="">{c.loading ? 'Loading…' : 'Strike'}</option>}
                {strikes.map(k => <option key={k} value={String(k)}>{k}{k === c.data?.atm ? ' (ATM)' : ''}</option>)}
              </select>
              <Seg ariaLabel="Option type" value={d.optType} options={[['CE', 'CE'], ['PE', 'PE']]} onChange={v => set({ optType: v })} />
            </>
          )}
        </div>
      )}
      {c.loading && d.kind !== 'index' && <div className="flex items-center gap-1 text-[10px] text-zinc-500"><Loader2 className="h-3 w-3 animate-spin" /> Loading contracts…</div>}
      {c.error && <div className="text-[11px] text-red-400">{c.error}</div>}
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
  // Expiration: 'default' (the watched contract's own expiry; the nearest expiry for the index), 'open', 'today',
  // 'exp:<iso>' (that day's session close) or 'custom' (customAt). An edited alert keeps its own time as 'custom'.
  const [expMode, setExpMode] = useState<string>(editing ? (editing.expiresAt ? 'custom' : 'open') : 'default');
  const [customAt, setCustomAt] = useState(editing?.expiresAt ? toLocalInput(editing.expiresAt) : '');
  const [soundSec, setSoundSec] = useState(String(editing?.soundSec ?? view?.defaultSoundSec ?? DEFAULT_SOUND_SEC));
  const [message, setMessage] = useState(editing?.message ?? '');
  const ea = editing?.action;
  const [isTrade, setIsTrade] = useState(ea?.kind === 'trade');
  const [contract, setContract] = useState<Draft>(() => {
    if (ea?.kind === 'trade') return draftOf(specFromAlert(ea.contract));
    const d = draftOf(init.instrument);
    return d.kind === 'index' ? { ...d, kind: 'option', expiry: '', strike: '' } : d;
  });
  const [side, setSide] = useState<'BUY' | 'SELL'>(ea?.kind === 'trade' ? ea.side : 'BUY');
  const [lots, setLots] = useState(ea?.kind === 'trade' ? String(ea.lots) : '1');
  const [product, setProduct] = useState<'INTRADAY' | 'MARGIN'>(ea?.kind === 'trade' ? ea.product : 'INTRADAY');
  const [broker, setBroker] = useState<AlertBroker>(ea?.kind === 'trade' ? alertBroker(ea) : init.broker === 'kotak' ? 'kotak' : 'dhan');
  // Kotak rejects a fresh MIS crude order after accepting it: a Kotak crude alert is NRML only.
  const nrmlOnly = broker === 'kotak' && isMcxAlertUnderlying(contract.underlying);
  const effProduct = nrmlOnly ? 'MARGIN' : product;
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setInstP = (p: Partial<Draft>) => setInst(s => ({ ...s, ...p }));
  const setContractP = (p: Partial<Draft>) => setContract(s => ({ ...s, ...p }));
  const apiKind = (d: Draft) => (d.kind === 'option' ? 'options' : d.kind === 'future' ? 'futures' : null);
  const instC = useContracts(apiKind(inst), inst.underlying, inst.expiry, inst.kind === 'option',
    c => { const p = defaultsFor(inst, c); if (p) setInstP(p); });
  const tradeC = useContracts(isTrade ? apiKind(contract) : null, contract.underlying, contract.expiry, contract.kind === 'option',
    c => { const p = defaultsFor(contract, c); if (p) setContractP(p); });
  // The index has no expiry of its own: its Expiration choices are the NIFTY option expiries.
  const indexC = useContracts(inst.kind === 'index' ? 'options' : null, inst.underlying, '', false);

  // Expiration choices: the valid expiries (a contract's: up to its own), each meaning that day's session close.
  const expiryChoices = useMemo(() => {
    const list = (inst.kind === 'index' ? indexC.data?.expiries : instC.data?.expiries) ?? [];
    return (inst.kind === 'index' ? list : list.filter(x => !inst.expiry || x <= inst.expiry)).slice(0, 8);
  }, [inst.kind, inst.expiry, indexC.data, instC.data]);
  const defaultExpiry = inst.kind === 'index' ? expiryChoices[0] : inst.expiry;
  const expValue = expMode === 'default' ? (defaultExpiry ? `exp:${defaultExpiry}` : 'open') : expMode;
  const expiresAt = (): number | null | string => {
    if (expValue === 'open') return null;
    if (expValue === 'custom') return customAt ? new Date(customAt).getTime() : 'Pick the expiration date and time';
    const iso = expValue === 'today' ? new Date(Date.now() + 19_800_000).toISOString().slice(0, 10) : expValue.slice(4);
    const at = sessionCloseMs(inst.underlying, iso);
    return at > Date.now() ? at : `${expValue === 'today' ? "Today's session" : fmtExpiry(iso)} has already closed — pick a later expiration`;
  };

  const title = inst.kind === 'index' ? inst.underlying
    : inst.kind === 'future' ? `${inst.underlying} FUT ${inst.expiry}`
      : `${inst.underlying} ${inst.strike || '—'} ${inst.optType} ${inst.expiry}`;

  const submit = async () => {
    const instrument = specOf(inst);
    if (typeof instrument === 'string') { toast.error(instrument); return; }
    let action: Record<string, unknown> = { kind: 'notify' };
    if (isTrade) {
      const c = specOf(contract);
      if (typeof c === 'string') { toast.error(`Trade: ${c}`); return; }
      action = { kind: 'trade', contract: c, side, lots: Number(lots), product: effProduct, broker };
    }
    const exp = expiresAt();
    if (typeof exp === 'string') { toast.error(exp); return; }
    const alert = {
      instrument, condition, value: Number(value), trigger: isTrade ? 'once' : trigger,
      expiresAt: exp, soundSec: Number(soundSec), message, action,
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
            <ContractPicker d={inst} set={setInstP} allowIndex c={instC} />

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
            <div className="space-y-2">
              <select aria-label="Expiration" className={field} value={expValue} onChange={e => setExpMode(e.target.value)}>
                {expiryChoices.map(x => (
                  <option key={x} value={`exp:${x}`}>{x === inst.expiry ? 'Contract expiry' : 'Expiry'} — {fmtExpiry(x)}</option>
                ))}
                {defaultExpiry && !expiryChoices.includes(defaultExpiry) && <option value={`exp:${defaultExpiry}`}>Expiry — {fmtExpiry(defaultExpiry)}</option>}
                <option value="today">Today&apos;s close</option>
                <option value="open">Open-ended{inst.kind !== 'index' ? ' (until the contract expires)' : ''}</option>
                <option value="custom">Custom date &amp; time…</option>
              </select>
              {expValue === 'custom' && (
                <input aria-label="Expiration date and time" type="datetime-local" className={field} value={customAt} onChange={e => setCustomAt(e.target.value)} />
              )}
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
                <ShieldAlert className="h-3.5 w-3.5" /> REAL {ALERT_BROKERS[broker]} MARKET order when it fires
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-400">Broker</span>
                <Seg ariaLabel="Broker" value={broker} options={[['dhan', 'Dhan'], ['kotak', 'Kotak']]} onChange={setBroker} />
              </div>
              <ContractPicker d={contract} set={setContractP} allowIndex={false} c={tradeC} />
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Seg ariaLabel="Side" value={side} options={[['BUY', 'BUY'], ['SELL', 'SELL']]} onChange={setSide} />
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                  Lots
                  <input aria-label="Lots" type="number" min={1} max={MAX_ALERT_LOTS} className={cn(field, 'w-14 font-mono')} value={lots} onChange={e => setLots(e.target.value)} />
                </label>
                <Seg ariaLabel="Product" value={effProduct} options={nrmlOnly ? [['MARGIN', 'NRML']] : [['INTRADAY', 'MIS'], ['MARGIN', 'NRML']]} onChange={setProduct} />
              </div>
              <p className="text-[10px] text-zinc-400 leading-relaxed">
                Max {MAX_ALERT_LOTS} lots. Sent only during market hours and on a day REAL orders are armed in the alerts panel; otherwise it only notifies.
                An order with an unknown outcome is never resent.
                {broker === 'kotak' && <> Kotak: the contract is looked up in Kotak&apos;s own instrument list when you save; needs a live Kotak session when it fires{nrmlOnly ? '; crude is NRML only' : ''}.</>}
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
