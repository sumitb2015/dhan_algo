'use client';

import { cn } from '@/lib/utils';
import { istClock } from '@/lib/istTime';
import { istDateIso } from '@/lib/nseHolidays';
import type { KeyLevels, MtfTable, SignalChange } from '@/lib/signalOrbPanels';
import type { Signal, Timeframe } from '@/lib/signalOrb';

// Context beside the orb: what the chosen indicators say on every timeframe, how the orb has flipped lately, and where price sits
// against the day's levels. Information only: nothing here changes a rule or sends an order.

const tfLabel = (tf: Timeframe) => (tf === 60 ? '1h' : `${tf}m`);
const fmt = (n: number | null | undefined, dp = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const signed = (n: number, dp = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}`;
const voteTone = (v: number) => (v === 1 ? 'text-emerald-400' : v === -1 ? 'text-red-400' : 'text-zinc-600');
const sigTone = (s: Signal) => (s === 'BULL' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : s === 'BEAR' ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-400');

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 backdrop-blur">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">{title}</h2>
        {note && <span className="font-mono text-[10px] text-zinc-600">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** Indicators x timeframes: a glyph per vote (hover for the value) and the orb's own colour per timeframe at the bottom. */
export function MtfPanel({ table, active }: { table: MtfTable | null; active: Timeframe }) {
  if (!table || !table.rows.length) {
    return <Panel title="Timeframes"><p className="text-[11px] text-zinc-500">{table ? 'No indicators - open the rules to add one' : 'Loading bars…'}</p></Panel>;
  }
  const total = table.timeframes.length;
  return (
    <Panel title="Timeframes" note={`${table.bull} bull · ${table.bear} bear of ${total}`}>
      <table className="w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr>
            <th scope="col" className="pb-1 text-left text-[10px] font-bold uppercase tracking-wider text-zinc-500"><span className="sr-only">Indicator</span></th>
            {table.timeframes.map(tf => (
              <th key={tf} scope="col" className={cn('pb-1 text-center text-[10px] font-bold', tf === active ? 'text-zinc-100' : 'text-zinc-500')}>
                {tfLabel(tf)}{tf === active && <span className="ml-0.5 text-emerald-400" title="The timeframe the orb trades on">•</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(r => (
            <tr key={r.id} className="border-t border-zinc-900">
              <th scope="row" className="py-1 pr-2 text-left text-[11px] font-semibold text-zinc-300">{r.label}</th>
              {r.cells.map((c, i) => (
                <td key={i} className={cn('py-1 text-center', table.timeframes[i] === active && 'bg-zinc-900/60')} title={`${r.label} on ${tfLabel(table.timeframes[i])}: ${c.value}`}>
                  <span className={cn('text-xs font-bold', voteTone(c.vote))} aria-hidden>{c.vote === 1 ? '▲' : c.vote === -1 ? '▼' : '●'}</span>
                  <span className="sr-only">{c.vote === 1 ? 'bullish' : c.vote === -1 ? 'bearish' : 'neutral'}</span>
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-zinc-800">
            <th scope="row" className="py-1.5 pr-2 text-left text-[10px] font-bold uppercase tracking-wider text-zinc-500">Orb</th>
            {table.signals.map((s, i) => (
              <td key={i} className="py-1.5 text-center">
                <span className={cn('inline-block rounded border px-1 text-[9px] font-black', sigTone(s))}>{s === 'BULL' ? 'BULL' : s === 'BEAR' ? 'BEAR' : 'FLAT'}</span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

/** The orb's recent colour changes, newest first: when, to what, at what price, how long it held and what it was worth. */
export function HistoryPanel({ history, today }: { history: SignalChange[]; today: string }) {
  return (
    <Panel title="Signal history" note="trading timeframe">
      {!history.length ? <p className="text-[11px] text-zinc-500">No colour change in the bars loaded</p> : (
        <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
          {history.map(c => {
            const d = istDateIso(c.t * 1000);
            const when = `${d === today ? '' : `${d.slice(5)} `}${istClock(c.t * 1000).slice(0, 5)}`;
            return (
              <li key={c.t} className={cn('flex items-center gap-2 rounded px-1 py-0.5', c.now && 'bg-zinc-900')}>
                <span className="w-[5.5rem] shrink-0 text-zinc-500">{when}</span>
                <span className={cn('w-11 shrink-0 rounded border px-1 text-center text-[9px] font-black', sigTone(c.signal))}>{c.signal === 'NEUTRAL' ? 'FLAT' : c.signal}</span>
                <span className="tabular-nums text-zinc-300">{fmt(c.price, 1)}</span>
                <span className="ml-auto flex items-center gap-2 tabular-nums">
                  <span className="text-zinc-600" title="closed bars this colour held">{c.held}b{c.now ? '+' : ''}</span>
                  {c.move === null ? <span className="w-12 text-right text-zinc-700">—</span>
                    : <span className={cn('w-12 text-right font-bold', c.move >= 0 ? 'text-emerald-400' : 'text-red-400')} title={c.now ? 'Points in its favour so far' : 'Points in its favour until the next change (negative = whipsaw)'}>{signed(c.move)}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** Price against the day's range, VWAP and the previous session: a range bar with the price marker, then each level and its distance. */
export function LevelsPanel({ levels, price, today }: { levels: KeyLevels | null; price: number | null; today: string }) {
  if (!levels) return <Panel title="Key levels"><p className="text-[11px] text-zinc-500">Loading bars…</p></Panel>;
  // the live price may be past the last closed bar's range
  const hi = price === null ? levels.dayHigh : Math.max(levels.dayHigh, price);
  const lo = price === null ? levels.dayLow : Math.min(levels.dayLow, price);
  const span = hi - lo;
  const pos = price === null || span <= 0 ? null : Math.min(100, Math.max(0, ((price - lo) / span) * 100));
  const rows: { label: string; v: number | null; tone?: string }[] = [
    { label: 'Day high', v: hi, tone: 'text-emerald-400' },
    { label: 'VWAP', v: levels.vwap, tone: 'text-sky-400' },
    { label: 'Day low', v: lo, tone: 'text-red-400' },
    { label: 'Prev high', v: levels.prevHigh },
    { label: 'Prev close', v: levels.prevClose },
    { label: 'Prev low', v: levels.prevLow },
  ];
  return (
    <Panel title="Key levels" note={levels.day === today ? 'today' : `session ${levels.day.slice(5)}`}>
      <div className="relative mb-3 mt-1 h-1.5 rounded-full bg-zinc-800" role="img" aria-label={pos === null ? 'Day range' : `Price is ${Math.round(pos)}% of the way up the day range`}>
        {levels.vwap !== null && span > 0 && (
          <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-sky-400" style={{ left: `${Math.min(100, Math.max(0, ((levels.vwap - lo) / span) * 100))}%` }} title="VWAP" />
        )}
        {pos !== null && <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-zinc-950 bg-zinc-100" style={{ left: `${pos}%` }} title="Price" />}
      </div>
      <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {rows.map(r => (
          <div key={r.label} className="contents">
            <dt className="text-zinc-500">{r.label}</dt>
            <dd className={cn('text-right tabular-nums', r.tone ?? 'text-zinc-300')}>{fmt(r.v, 1)}</dd>
            <dd className={cn('w-14 text-right tabular-nums', price === null || r.v === null ? 'text-zinc-700' : price - r.v >= 0 ? 'text-emerald-400' : 'text-red-400')} title="Price minus this level, in points">
              {price === null || r.v === null ? '—' : signed(price - r.v)}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
