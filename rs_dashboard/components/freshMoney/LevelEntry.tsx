'use client';

/**
 * Fresh Money — level entries on a strike (the XY ladder's model). REAL MONEY, but arming sends nothing: the dashboard
 * server watches the underlying's price (index, or the option month's future on MCX) every 2 s and sends this option's
 * order AT MARKET once the price has crossed the level on two checks in a row (lib/freshMoneyEntryTick.ts).
 *
 * - `LevelToggle`: the strike's MKT / LVL switch (page memory only: a reload is back on MKT, so a reload can never turn
 *   a B / S click into an armed level). Shows how many levels are armed on this option.
 * - `LevelTicket`: what a B / S click opens on a LVL strike — the level (prefilled with the price, committed on blur /
 *   Enter), whether that makes it a limit or a stop / breakout entry, and the levels already armed here with ×.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Crosshair, Loader2, X } from 'lucide-react';
import { classifyEntry, entryLabel, levelProblem, type EntryKind, type FmEntry } from '@/lib/freshMoneyEntries';
import type { FmProduct, OptType, TxnSide } from '@/lib/freshMoneyTrades';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70';
const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Everything a strike's trade cell needs for level entries (from the board). */
export interface LevelCell {
  /** This strike is on LVL: B / S open the ticket instead of sending. */
  on: boolean;
  toggle: () => void;
  /** Armed / firing entries on this strike (both options); the cell filters its own. */
  entries: FmEntry[];
  /** The board's live price (index / future) and its name; null = no live price. */
  spot: number | null;
  priceName: string;
  lots: number;
  product: FmProduct;
  /** The header's target / SL as text, stamped onto the position a fire opens. */
  exitText: string;
  arm: (opt: OptType, side: TxnSide, level: number, expect: EntryKind) => Promise<boolean>;
  cancel: (e: FmEntry) => Promise<void>;
}

export function LevelToggle({ strike, opt, cell }: { strike: number; opt: OptType; cell: LevelCell }) {
  const mine = cell.entries.filter(e => e.opt === opt);
  return (
    <button type="button" onClick={cell.toggle} aria-pressed={cell.on} data-testid={`fm-lvl-${opt.toLowerCase()}`}
      aria-label={`${cell.on ? 'Level' : 'Market'} orders on ${strike}${mine.length ? ` (${mine.length} armed on ${opt})` : ''} — switch`}
      title={(cell.on
        ? `LVL: B / S on ${strike} arm a level on ${cell.priceName} (sent at market when it is crossed). Click for MKT.`
        : `MKT: B / S on ${strike} send at market now. Click for LVL (arm a ${cell.priceName} level instead).`)
        + (mine.length ? `\nArmed on ${opt}: ${mine.map(e => entryLabel(e)).join(', ')}` : '')}
      className={`${FOCUS} relative flex h-5 min-w-[18px] items-center justify-center rounded px-0.5 text-[10px] font-bold leading-5 transition-colors ${
        cell.on ? 'bg-amber-600 text-oncolor hover:bg-amber-500' : 'border border-zinc-700 text-zinc-400 hover:text-zinc-100'}`}>
      L{mine.length > 0 && <span className="ml-px">{mine.length}</span>}
    </button>
  );
}

/** The ticket a B / S click opens on a LVL strike (fixed position under the clicked button). */
export function LevelTicket({ at, strike, opt, side, cell, canArm, blockedWhy, onClose }: {
  at: { x: number; y: number };
  strike: number; opt: OptType; side: TxnSide;
  cell: LevelCell;
  canArm: boolean;
  /** Why the page cannot arm right now (ARM off, session, stale board), shown instead of the Arm button. */
  blockedWhy: string | null;
  onClose: () => void;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(cell.spot ? cell.spot.toFixed(2) : '');
  // The committed level (blur / Enter): the verdict and the Arm button act on this, never on a half-typed value.
  const [level, setLevel] = useState<number | null>(cell.spot ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // The mousedown that opened it has already happened; a later one outside closes it.
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [onClose]);

  const commit = (raw: string) => {
    const n = Number(raw.replace(/,/g, ''));
    setLevel(Number.isFinite(n) && n > 0 ? n : null);
  };
  const spot = cell.spot;
  const problem = level === null ? 'Enter a level' : levelProblem(level, spot ?? NaN);
  const verdict = level !== null && spot ? classifyEntry(opt, side, level, spot) : null;
  const armed = cell.entries.filter(e => e.opt === opt);

  const doArm = async () => {
    // Read the box itself: a click straight after typing must arm what is shown, not the last committed value.
    const raw = input.current?.value ?? draft;
    const n = Number(raw.replace(/,/g, ''));
    if (!spot || !(n > 0) || levelProblem(n, spot)) { commit(raw); return; }
    const v = classifyEntry(opt, side, n, spot);
    setBusy(true);
    const ok = await cell.arm(opt, side, n, v.kind);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div ref={pop} role="dialog" aria-label={`Arm a level: ${side} ${strike} ${opt}`} data-testid="fm-level-ticket"
      style={{ position: 'fixed', left: at.x, top: at.y, width: 360 }}
      className="z-50 rounded-lg border border-amber-500/50 bg-zinc-900 text-[12px] shadow-xl">
      <p className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-1.5 font-bold text-zinc-200">
        <Crosshair className="h-3.5 w-3.5 text-amber-400" aria-hidden />
        <span className={side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>{side}</span>
        {cell.lots} lot{cell.lots === 1 ? '' : 's'} {strike} {opt} · {cell.product} · at market on the cross
      </p>
      <div className="space-y-2 px-3 py-2">
        <label className="flex items-center gap-2">
          <span className="w-28 text-zinc-400">{cell.priceName} level</span>
          <input ref={input} aria-label={`${cell.priceName} level`} inputMode="decimal" value={draft}
            onChange={e => setDraft(e.target.value.replace(/[^0-9.,]/g, ''))}
            onBlur={e => commit(e.currentTarget.value)}
            onKeyDown={e => { if (e.key === 'Enter') { commit(e.currentTarget.value); void doArm(); } }}
            className={`${FOCUS} h-7 w-32 rounded border border-zinc-700 bg-zinc-950 px-2 text-right font-bold tabular-nums text-white`} />
          <span className="text-[11px] tabular-nums text-zinc-500">now {spot ? fmt(spot) : '–'}</span>
        </label>
        <p data-testid="fm-level-verdict" className={`text-[11px] ${problem ? 'text-amber-300' : 'text-zinc-300'}`}>
          {problem ?? (verdict && level !== null && spot
            ? <>
                <span className="font-bold">{verdict.kind === 'limit' ? 'Limit entry' : 'Stop / breakout entry'}</span>
                {' '}— fires when {cell.priceName} {verdict.dir === 'above' ? '≥' : '≤'} {fmt(level)} ({fmt(Math.abs(level - spot))} pts {verdict.dir} now)
              </>
            : null)}
        </p>
        <p className="text-[11px] text-zinc-500">
          Target / SL on the fill: {cell.exitText}. Watched by the dashboard server every 2 s (two checks in a row);
          nothing rests at the broker. It stops if the dashboard stops, and expires at the {cell.product} cutoff.
        </p>
        {armed.length > 0 && (
          <div className="border-t border-zinc-800 pt-1.5">
            <p className="mb-1 text-[11px] text-zinc-400">Armed on {strike} {opt}</p>
            <ul className="space-y-1">
              {armed.map(e => (
                <li key={e.id} className="flex items-center gap-2 tabular-nums">
                  <span className={`font-bold ${e.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{entryLabel(e)}</span>
                  <span className="text-zinc-400">{e.lots} lot{e.lots === 1 ? '' : 's'} · {e.kind} · {e.state}</span>
                  {e.state === 'armed' && (
                    <button type="button" onClick={() => void cell.cancel(e)} aria-label={`Cancel level ${entryLabel(e)} on ${strike} ${opt}`}
                      className={`${FOCUS} ml-auto flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white`}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-3 py-1.5">
        {blockedWhy && <span className="mr-auto text-[11px] text-amber-300">{blockedWhy}</span>}
        <button type="button" onClick={onClose}
          className={`${FOCUS} rounded border border-zinc-700 px-2.5 py-1 text-[11px] font-bold text-zinc-300 hover:text-white`}>Close</button>
        <button type="button" onClick={() => void doArm()} disabled={!canArm || busy || !!problem}
          className={`${FOCUS} flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-bold text-oncolor disabled:cursor-not-allowed disabled:opacity-40 ${
            side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'}`}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}Arm {side}
        </button>
      </div>
    </div>
  );
}
