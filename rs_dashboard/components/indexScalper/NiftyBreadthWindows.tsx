'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ageLabel } from '@/lib/useLiveTickerPoll';
import { contributionSummary, niftyBreadth, type BreadthSample } from '@/lib/indexScalperBreadth';
import type { ContributionRow } from '@/lib/niftyContribution';
import { DASH, PctPill, TD, TH, fmtPrice } from '../LiveTickerPanel';
import { useDraggable } from './useDraggable';
import type { ContribResp } from './useNiftyContribution';

const signed = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
const pnlCls = (v: number | null | undefined) =>
  v == null || v === 0 ? 'text-zinc-400' : v > 0 ? 'text-emerald-400' : 'text-red-400';

/** The draggable shell both windows share: title, feed chip (stock feed drives both), time, close. */
function Shell({ testId, title, data, error, initial, onClose, children }: {
  testId: string; title: string; data: ContribResp | null; error: string | null;
  initial: { x: number; y: number }; onClose: () => void; children: React.ReactNode;
}) {
  const { pos, handle } = useDraggable(initial);
  const feed = data?.feeds.stocks;
  const state = feed?.state ?? 'starting';
  const at = feed?.updatedAt ? new Date(feed.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) : null;
  const chip = state === 'live' ? 'LIVE' : state === 'stale' ? `STALE ${ageLabel(feed?.ageMs ?? Infinity)}` : state === 'stopped' ? 'STOPPED' : 'STARTING';
  return (
    <div style={{ left: pos.x, top: pos.y }} data-testid={testId} role="dialog" aria-label={title}
      className="fixed z-40 w-[360px] max-w-[calc(100vw-16px)] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl select-none">
      <div {...handle} className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-zinc-800 cursor-move">
        <span className="flex items-center gap-2 text-sm font-bold text-white">
          {title}
          <span data-testid={`${testId}-state`}
            title={state === 'live' ? 'Nifty 50 stock quotes from the Daily Market bridge (Dhan WebSocket), polled every 2 s'
              : state === 'stale' ? 'No new quote: market closed, or the bridge stalled. Numbers may be old.'
              : state === 'stopped' ? 'The Daily Market bridge is not running: numbers are from its last snapshot'
              : 'Waiting for the bridge to start'}
            className={cn('px-1.5 py-px rounded border text-[10px] font-bold',
              state === 'live' ? 'border-emerald-500/40 text-emerald-400'
                : state === 'stale' || state === 'stopped' ? 'border-amber-500/40 text-amber-300'
                : 'border-zinc-700 text-zinc-500')}>
            {chip}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {at && <span className="text-[11px] text-zinc-500 tabular-nums">{at}</span>}
          <button type="button" onClick={onClose} aria-label={`Close ${title}`} title="Close"
            className="w-6 h-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
            <X className="w-4 h-4" />
          </button>
        </span>
      </div>
      {error && !data && <div className="px-3 py-3 text-xs text-red-400">{error}</div>}
      {!error && !data && <div className="px-3 py-3 text-xs text-zinc-500">Loading…</div>}
      {data && <div className={cn(state !== 'live' && 'opacity-70')}>{children}</div>}
    </div>
  );
}

function Stat({ label, value, cls, testId }: { label: string; value: React.ReactNode; cls?: string; testId?: string }) {
  return (
    <div className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-center">
      <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">{label}</div>
      <div data-testid={testId} className={cn('text-lg font-bold tabular-nums font-mono', cls)}>{value}</div>
    </div>
  );
}

/** advances − declines through the session, zero line dashed. */
function AdLine({ history }: { history: BreadthSample[] }) {
  if (history.length < 2) {
    return <div className="h-[56px] flex items-center justify-center text-[11px] text-zinc-600">A/D line builds while the feed is live (1 point / 30 s)</div>;
  }
  const W = 336, H = 56;
  const vals = history.map(s => s.adv - s.dec);
  const lim = Math.max(1, ...vals.map(Math.abs));
  const t0 = history[0].t, t1 = history[history.length - 1].t;
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : 0);
  const y = (v: number) => H / 2 - (v / lim) * (H / 2 - 3);
  const d = history.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.adv - s.dec).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[56px]" role="img" aria-label={`A/D line, now ${signed(last, 0)}`}>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--color-zinc-700)" strokeDasharray="3 3" />
      <path d={d} fill="none" strokeWidth={1.5} className={last >= 0 ? 'stroke-emerald-400' : 'stroke-red-400'} />
    </svg>
  );
}

export function NiftyBreadthWindow({ data, error, history, initial, onClose }: {
  data: ContribResp | null; error: string | null; history: BreadthSample[];
  initial: { x: number; y: number }; onClose: () => void;
}) {
  const b = useMemo(() => niftyBreadth(data?.result), [data]);
  const [list, setList] = useState(false);
  const priced = b.advances + b.declines + b.unchanged;
  const movers = useMemo(() => [...(data?.result.rows ?? [])].sort((a, c) => c.changePct - a.changePct), [data]);
  return (
    <Shell testId="nifty-breadth" title="Nifty 50 Advance / Decline" data={data} error={error} initial={initial} onClose={onClose}>
      <div className="p-3 space-y-2.5">
        <div className="flex gap-2">
          <Stat label="Adv" value={b.advances} cls="text-emerald-400" testId="nifty-breadth-adv" />
          <Stat label="Dec" value={b.declines} cls="text-red-400" testId="nifty-breadth-dec" />
          <Stat label="Unch" value={b.unchanged} cls="text-zinc-300" testId="nifty-breadth-unch" />
          <Stat label="A/D" testId="nifty-breadth-ratio"
            value={b.ratio === null ? (b.advances > 0 ? 'All up' : DASH) : b.ratio.toFixed(2)}
            cls={b.ratio === null ? 'text-zinc-300' : b.ratio >= 1 ? 'text-emerald-400' : 'text-red-400'} />
        </div>
        {priced > 0 && (
          <div title={`${b.advances} up, ${b.unchanged} unchanged, ${b.declines} down of ${priced} priced`}>
            <div className="flex h-2 rounded overflow-hidden bg-zinc-800">
              <div className="bg-emerald-500" style={{ width: `${(b.advances / priced) * 100}%` }} />
              <div className="bg-zinc-600" style={{ width: `${(b.unchanged / priced) * 100}%` }} />
              <div className="bg-red-500" style={{ width: `${(b.declines / priced) * 100}%` }} />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between text-[11px] text-zinc-400"
          title="Share of Nifty's live index weight sitting in advancing vs declining stocks">
          <span>Weight up <span className="text-emerald-400 font-bold tabular-nums">{b.advWeightPct.toFixed(1)}%</span></span>
          <span>Weight down <span className="text-red-400 font-bold tabular-nums">{b.decWeightPct.toFixed(1)}%</span></span>
          <span>NIFTY <PctPill v={data?.nifty?.changePct ?? null} /></span>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-950 px-1 py-1">
          <div className="px-1 text-[10px] font-bold uppercase tracking-wide text-zinc-500">Adv − Dec today</div>
          <AdLine history={history} />
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-500">{b.missing > 0 ? `${b.missing} stock${b.missing > 1 ? 's' : ''} not priced (not counted)` : `${priced} stocks priced`}</span>
          <button type="button" onClick={() => setList(v => !v)} aria-expanded={list}
            className="text-sky-400 hover:text-sky-300 font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 rounded px-1">
            {list ? 'Hide stocks' : 'Show stocks'}
          </button>
        </div>
      </div>
      {list && (
        <div className="max-h-[40vh] overflow-auto border-t border-zinc-800">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0"><tr><TH>Stock</TH><TH right>LTP</TH><TH right>Chg%</TH><TH right>Wt%</TH></tr></thead>
            <tbody>
              {movers.map(r => (
                <tr key={r.symbol} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/30">
                  <TD><span className="text-zinc-200 font-semibold">{r.symbol}</span></TD>
                  <TD right className="text-zinc-200 tabular-nums">{fmtPrice(r.ltp)}</TD>
                  <TD right><PctPill v={r.changePct} /></TD>
                  <TD right className="text-zinc-500 tabular-nums">{r.weightPct.toFixed(2)}</TD>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

function MoverRow({ r, maxAbs }: { r: ContributionRow; maxAbs: number }) {
  const w = maxAbs > 0 ? Math.max(2, (Math.abs(r.points) / maxAbs) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-[12px]" title={`${r.name}: ${signed(r.changePct, 2)}% at weight ${r.weightPct.toFixed(2)}%`}>
      <span className="w-[86px] truncate text-zinc-200 font-semibold">{r.symbol}</span>
      <span className="flex-1 h-2 rounded bg-zinc-800 overflow-hidden">
        <span className={cn('block h-full', r.points > 0 ? 'bg-emerald-500' : 'bg-red-500')} style={{ width: `${w}%` }} />
      </span>
      <span className={cn('w-[52px] text-right font-mono tabular-nums font-bold', pnlCls(r.points))}>{signed(r.points, 1)}</span>
    </div>
  );
}

export function NiftyContributionWindow({ data, error, initial, onClose }: {
  data: ContribResp | null; error: string | null; initial: { x: number; y: number }; onClose: () => void;
}) {
  const s = useMemo(() => contributionSummary(data?.result, 5), [data]);
  const res = data?.result;
  const val = (k: 'pull' | 'drag' | 'net') => s.totals.find(t => t.kind === k)?.value ?? null;
  const net = val('net');
  return (
    <Shell testId="nifty-contrib" title="Nifty 50 Contribution" data={data} error={error} initial={initial} onClose={onClose}>
      <div className="p-3 space-y-2.5">
        <div className="flex gap-2">
          <Stat label="Pulled" value={val('pull') !== null ? signed(val('pull')!) : DASH} cls="text-emerald-400" />
          <Stat label="Dragged" value={val('drag') !== null ? signed(val('drag')!) : DASH} cls="text-red-400" />
          <Stat label="Net pts" value={net !== null ? signed(net) : DASH} cls={pnlCls(net)} testId="nifty-contrib-net" />
        </div>
        <div className="flex items-center justify-between text-[11px] text-zinc-400">
          <span>NIFTY {data?.nifty ? (
            <span className={cn('font-bold tabular-nums', pnlCls(data.nifty.change))}>{signed(data.nifty.change)} pts</span>
          ) : DASH}</span>
          {res?.concentration && <span title="How many stocks carry the move (effective contributors)">Move is <span className="text-zinc-200 font-bold">{res.concentration}</span></span>}
        </div>
        {res?.residualFlag && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-300" title="Stock contributions do not add up to the index move: the weight file may be out of date">
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden /> Off the index by {res.residual !== null ? signed(res.residual) : '?'} pts — weights may be stale
          </div>
        )}
        <div className="space-y-1" data-testid="nifty-contrib-pullers">
          <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Top pullers</div>
          {s.pullers.length ? s.pullers.map(r => <MoverRow key={r.symbol} r={r} maxAbs={s.maxAbs} />) : <div className="text-[11px] text-zinc-600">None</div>}
        </div>
        <div className="space-y-1" data-testid="nifty-contrib-draggers">
          <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Top draggers</div>
          {s.draggers.length ? s.draggers.map(r => <MoverRow key={r.symbol} r={r} maxAbs={s.maxAbs} />) : <div className="text-[11px] text-zinc-600">None</div>}
        </div>
        <div className="flex items-center justify-between text-[11px] pt-1 border-t border-zinc-800">
          <span className="text-zinc-500">{res && res.missing.length > 0 ? `${res.missing.length} not priced` : data?.weightsAsOf ? `Weights as of ${data.weightsAsOf}` : ''}</span>
          <a href="/nifty-contribution" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-bold rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
            Full view <ExternalLink className="w-3 h-3" aria-hidden />
          </a>
        </div>
      </div>
    </Shell>
  );
}
