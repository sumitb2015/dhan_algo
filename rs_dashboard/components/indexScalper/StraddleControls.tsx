'use client';

// Straddle pane controls on /index-scalper: Sell / Buy straddle of the pane's strike, its live P&L, and the straddle's
// exit rules (target / stop in % or rupees, exit on a candle close beyond VWAP, Trail SL / Lock / Lock & trail, stop to
// cost, time exit). Rules are evaluated by useStraddleBooks; free-typed values commit on blur / Enter only, so a
// half-typed stop never reaches a live rule (skill dhan-commit-on-blur).

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { readPref, savePref } from '@/lib/localPref';
import { DEFAULT_STRADDLE_RULES, rulesError, type StraddleRules } from '@/lib/indexScalperStraddle';
import type { TsTrailKind } from '@/lib/tripleStraddle';
import type { StraddleLegIds, StraddleView } from './useStraddleBooks';

const RULES_KEY = 'indexScalper.straddleRules.v1';
const LOTS_KEY = 'indexScalper.straddleLots';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';

function loadRules(): StraddleRules {
  try {
    const r = JSON.parse(readPref(RULES_KEY) ?? 'null') as StraddleRules | null;
    return r && !rulesError(r) ? { ...DEFAULT_STRADDLE_RULES, ...r } : DEFAULT_STRADDLE_RULES;
  } catch { return DEFAULT_STRADDLE_RULES; }
}

/** A number box that commits on blur / Enter; a refused value puts the box back. Empty = 0 (off). */
function NumBox({ label, value, onCommit, width = 'w-12', step }: { label: string; value: number | undefined; onCommit: (n: number) => boolean; width?: string; step?: string }) {
  const [draft, setDraft] = useState(value ? String(value) : '');
  useEffect(() => { setDraft(value ? String(value) : ''); }, [value]); // eslint-disable-line react-hooks/set-state-in-effect
  const commit = () => {
    const n = draft.trim() === '' ? 0 : Number(draft);
    if (!Number.isFinite(n) || n < 0 || !onCommit(n)) setDraft(value ? String(value) : '');
  };
  return (
    <input aria-label={label} inputMode="decimal" value={draft} placeholder="off" step={step}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn(width, 'h-6 px-1 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-mono text-zinc-100 text-right', FOCUS)} />
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1.5 flex-wrap">{children}</div>;
}
const lab = 'text-[11px] text-zinc-400';

export interface StraddleControlsProps {
  strike: number | null;
  ids: StraddleLegIds | null;
  intervalMin: number;
  real: boolean;
  livePremium: number | null;
  view: StraddleView | null;
  busy: boolean;
  maxLots: number;
  onEnter: (side: 'S' | 'B', strike: number, ids: StraddleLegIds, lots: number, rules: StraddleRules, intervalMin: number) => void;
  onExit: (id: string) => void;
  onForget: (id: string) => void;
  onSetRules: (id: string, r: StraddleRules) => string | null;
  onError: (text: string) => void;
}

export default function StraddleControls(p: StraddleControlsProps) {
  const [open, setOpen] = useState(true);
  const [draftRules, setDraftRules] = useState<StraddleRules>(DEFAULT_STRADDLE_RULES);
  const [lots, setLots] = useState(1);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraftRules(loadRules());
    const l = Number(readPref(LOTS_KEY));
    if (Number.isInteger(l) && l >= 1) setLots(l);
  }, []);

  const book = p.view?.book ?? null;
  // While a straddle is open its own rules are edited; before entry, the saved defaults.
  const rules = book ? book.rules : draftRules;
  const setRules = (r: StraddleRules): boolean => {
    const err = rulesError(r);
    if (err) { p.onError(err); return false; }
    if (book) { const e = p.onSetRules(book.id, r); if (e) { p.onError(e); return false; } return true; }
    setDraftRules(r);
    savePref(RULES_KEY, JSON.stringify(r));
    return true;
  };
  const trailKind: TsTrailKind | 'none' = rules.trail?.kind ?? 'none';
  // Both legs need a live price (the bridge's, never a snapshot): with the market closed or a strike outside the bridge
  // window the buttons are greyed out instead of refusing on click.
  const noLive = p.livePremium === null;
  const canTrade = !book && p.strike !== null && !!p.ids?.ceId && !!p.ids?.peId && !p.busy && !noLive;
  const tradeTitle = noLive ? 'No live price on both legs (market closed, or this strike is outside the live window)' : undefined;
  const v = p.view;
  const fmt = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));

  return (
    <div data-testid="straddle-controls" className="absolute left-2 bottom-8 z-[58] w-[330px] rounded-md border border-violet-500/50 bg-zinc-900 shadow-xl text-zinc-200">
      <div className="flex items-center gap-2 px-2 h-7 border-b border-zinc-800">
        <button type="button" aria-expanded={open} aria-label={open ? 'Collapse straddle controls' : 'Expand straddle controls'} onClick={() => setOpen(o => !o)} className={cn('p-0.5 rounded text-zinc-400 hover:text-white', FOCUS)}>
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <span className="text-xs font-bold text-violet-300">Straddle {p.strike ?? '—'}</span>
        <span className={cn('px-1.5 rounded text-[10px] font-bold', p.real ? 'bg-rose-600 text-oncolor' : 'bg-zinc-700 text-zinc-200')}>{p.real ? 'REAL' : 'SIM'}</span>
        <span className="ml-auto text-[11px] font-mono text-zinc-300" title="CE + PE live premium">{fmt(p.livePremium)}</span>
      </div>
      {open && (
        <div className="p-2 flex flex-col gap-2">
          {book && v ? (
            <div data-testid="straddle-open" className="flex flex-col gap-1">
              <Row>
                <span className={cn('px-1.5 rounded text-[10px] font-bold text-oncolor', book.side === 'S' ? 'bg-rose-600' : 'bg-emerald-600')}>{book.side === 'S' ? 'SHORT' : 'LONG'} {book.lots}L</span>
                <span className={lab}>{book.strike} · entry</span>
                <span className="text-[11px] font-mono">{fmt(book.legs[0].entry + book.legs[1].entry)}</span>
                <span data-testid="straddle-pnl" className={cn('ml-auto text-xs font-mono font-bold', !v.mtm ? 'text-zinc-500' : v.mtm.pnlRs >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                  {v.mtm ? `${v.mtm.pnlRs >= 0 ? '+' : ''}₹${v.mtm.pnlRs.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${v.mtm.pnlPct.toFixed(1)}%)` : 'unpriced'}
                </span>
              </Row>
              <Row>
                <span className={lab}>VWAP</span><span className="text-[11px] font-mono">{fmt(v.vwapNow)}</span>
                <span className={lab}>peak</span><span className="text-[11px] font-mono">{fmt(book.peakPct ?? 0, 1)}%</span>
                <span className={lab}>{v.floor ? (v.floor.kind === 'SL' ? 'stop' : v.floor.kind === 'COST' ? 'stop at cost' : v.floor.kind === 'TRAIL' ? 'trail' : 'lock') : 'no stop'}</span>
                {v.floor && <span className="text-[11px] font-mono">{v.floor.floorPct.toFixed(1)}%</span>}
              </Row>
              {v.health !== 'OK' && (
                <div role="alert" data-testid="straddle-one-leg" className="rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                  {v.health === 'PENDING' ? 'A leg\'s order outcome is unknown: check Orders. Rules are paused (nothing is resent).' : 'ONE LEG: only one side of the straddle is open. Rules are paused.'}
                </div>
              )}
              {book.lastError && <div className="text-[11px] text-rose-400">{book.lastError}</div>}
              <div className="flex gap-1.5">
                <button type="button" disabled={book.exiting} onClick={() => p.onExit(book.id)} data-testid="straddle-exit"
                  className={cn('flex-1 h-7 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold disabled:opacity-40', FOCUS)}>
                  {book.exiting ? 'Exiting…' : v.health === 'OK' ? 'Exit straddle' : 'Exit open legs'}
                </button>
                {v.health !== 'OK' && (
                  <button type="button" onClick={() => p.onForget(book.id)} title="Drop it from this page's ledger without any order (you squared it off elsewhere)"
                    className={cn('h-7 px-2 rounded border border-zinc-600 text-xs text-zinc-300 hover:bg-zinc-800', FOCUS)}>Forget</button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className={lab}>Lots</span>
              <NumBox label="Straddle lots" value={lots} width="w-10" onCommit={n => {
                if (!Number.isInteger(n) || n < 1 || n > p.maxLots) { p.onError(`Lots must be 1 to ${p.maxLots}`); return false; }
                setLots(n); savePref(LOTS_KEY, String(n)); return true;
              }} />
              <button type="button" disabled={!canTrade} title={tradeTitle} data-testid="straddle-sell" onClick={() => p.strike !== null && p.ids && p.onEnter('S', p.strike, p.ids, lots, draftRules, p.intervalMin)}
                className={cn('flex-1 h-7 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold disabled:opacity-40', p.real && 'ring-1 ring-rose-300', FOCUS)}>Sell straddle</button>
              <button type="button" disabled={!canTrade} title={tradeTitle} data-testid="straddle-buy" onClick={() => p.strike !== null && p.ids && p.onEnter('B', p.strike, p.ids, lots, draftRules, p.intervalMin)}
                className={cn('flex-1 h-7 rounded bg-emerald-600 hover:bg-emerald-500 text-oncolor text-xs font-bold disabled:opacity-40', p.real && 'ring-1 ring-rose-300', FOCUS)}>Buy straddle</button>
              {p.busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" aria-label="Placing" />}
            </div>
          )}

          <div className="flex flex-col gap-1.5 border-t border-zinc-800 pt-2">
            <Row>
              <span className={cn(lab, 'w-12')}>Target</span>
              <NumBox label="Straddle target %" value={rules.targetPct} onCommit={n => setRules({ ...rules, targetPct: n })} /><span className={lab}>%</span>
              <NumBox label="Straddle target rupees" value={rules.targetRs} width="w-16" onCommit={n => setRules({ ...rules, targetRs: n })} /><span className={lab}>₹</span>
            </Row>
            <Row>
              <span className={cn(lab, 'w-12')}>Stop</span>
              <NumBox label="Straddle stop %" value={rules.slPct} onCommit={n => setRules({ ...rules, slPct: n })} /><span className={lab}>%</span>
              <NumBox label="Straddle stop rupees" value={rules.slRs} width="w-16" onCommit={n => setRules({ ...rules, slRs: n })} /><span className={lab}>₹</span>
            </Row>
            <Row>
              <Switch aria-label="Exit on VWAP close" checked={rules.vwap.on} onCheckedChange={on => setRules({ ...rules, vwap: { ...rules.vwap, on } })} />
              <span className={lab} title="Short: a finished candle closes above VWAP + buffer. Long: below VWAP - buffer. A live tick never triggers it.">Exit on {p.intervalMin}m close beyond VWAP, buffer</span>
              <NumBox label="VWAP buffer points" value={rules.vwap.bufferPts} width="w-10" onCommit={n => setRules({ ...rules, vwap: { ...rules.vwap, bufferPts: n } })} />
            </Row>
            <Row>
              <span className={cn(lab, 'w-12')}>Trail</span>
              <select aria-label="Trail kind" value={trailKind}
                onChange={e => {
                  const k = e.target.value as TsTrailKind | 'none';
                  setRules({ ...rules, trail: k === 'none' ? undefined : k === 'trailSl' ? { kind: k, every: 10, by: 5 } : { kind: k, reach: 15, lock: 5, ...(k === 'lockTrail' ? { every: 5, by: 5 } : {}) } });
                }}
                className={cn('h-6 px-1 rounded border border-zinc-700 bg-zinc-900 text-[11px] text-zinc-200', FOCUS)}>
                <option value="none">Off</option>
                <option value="trailSl">Trail SL</option>
                <option value="lock">Lock profit</option>
                <option value="lockTrail">Lock & trail</option>
              </select>
              {rules.trail?.kind === 'trailSl' && (<>
                <span className={lab}>every</span><NumBox label="Trail every %" value={rules.trail.every} width="w-10" onCommit={n => setRules({ ...rules, trail: { ...rules.trail!, every: n } })} />
                <span className={lab}>% by</span><NumBox label="Trail by %" value={rules.trail.by} width="w-10" onCommit={n => setRules({ ...rules, trail: { ...rules.trail!, by: n } })} /><span className={lab}>%</span>
              </>)}
              {(rules.trail?.kind === 'lock' || rules.trail?.kind === 'lockTrail') && (<>
                <span className={lab}>at</span><NumBox label="Lock reach %" value={rules.trail.reach} width="w-10" onCommit={n => setRules({ ...rules, trail: { ...rules.trail!, reach: n } })} />
                <span className={lab}>% keep</span><NumBox label="Lock keep %" value={rules.trail.lock} width="w-10" onCommit={n => setRules({ ...rules, trail: { ...rules.trail!, lock: n } })} /><span className={lab}>%</span>
              </>)}
            </Row>
            {rules.trail?.kind === 'lockTrail' && (
              <Row>
                <span className={cn(lab, 'w-12')} />
                <span className={lab}>then every</span><NumBox label="Lock trail every %" value={rules.trail.every} width="w-10" onCommit={n => setRules({ ...rules, trail: { ...rules.trail!, every: n } })} />
                <span className={lab}>% raise by</span><NumBox label="Lock trail by %" value={rules.trail.by} width="w-10" onCommit={n => setRules({ ...rules, trail: { ...rules.trail!, by: n } })} /><span className={lab}>%</span>
              </Row>
            )}
            <Row>
              <Switch aria-label="Stop to cost" checked={rules.slToCost.on} onCheckedChange={on => setRules({ ...rules, slToCost: { ...rules.slToCost, on } })} />
              <span className={lab}>Stop to cost once profit reaches</span>
              <NumBox label="Stop to cost trigger %" value={rules.slToCost.triggerPct} width="w-10" onCommit={n => setRules({ ...rules, slToCost: { ...rules.slToCost, triggerPct: n } })} /><span className={lab}>%</span>
            </Row>
            <Row>
              <Switch aria-label="Time exit" checked={rules.timeExit.on} onCheckedChange={on => setRules({ ...rules, timeExit: { ...rules.timeExit, on } })} />
              <span className={lab}>Exit at</span>
              <TimeBox value={rules.timeExit.hhmm} onCommit={hhmm => setRules({ ...rules, timeExit: { ...rules.timeExit, hhmm } })} />
              <span className={lab}>IST</span>
            </Row>
          </div>
          <p className="text-[10px] text-zinc-500 leading-snug">
            Rules run in this tab only{p.real ? ' while REAL is armed' : ''}: closing the tab stops them. % is of the entry premium; with both % and ₹ the nearer level applies.
          </p>
        </div>
      )}
    </div>
  );
}

function TimeBox({ value, onCommit }: { value: string; onCommit: (v: string) => boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]); // eslint-disable-line react-hooks/set-state-in-effect
  return (
    <input aria-label="Time exit HH:MM" value={draft} onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (!onCommit(draft.trim())) setDraft(value); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn('w-14 h-6 px-1 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-mono text-zinc-100', FOCUS)} />
  );
}

