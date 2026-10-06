'use client';

import { useState } from 'react';
import RuleNumInput from '@/components/multiLegFocus/RuleNumInput';
import {
  entryPremium, straddlePnl, straddlePnlPct,
  type TsPosition, type TsProduct, type TsRisk, type TsSide, type TsSlot,
} from '@/lib/tripleStraddle';
import type { TsLookup } from '@/lib/tripleStraddleClient';

const inr = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const pnlTone = (n: number | null) => (n == null ? 'text-zinc-500' : n >= 0 ? 'text-emerald-400' : 'text-red-400');

export function StraddleTradeBar({
  slot, strike, lookup, position, live, busy, realArmed, canTrade, tradableReason,
  onTrade, onExit, onRisk, onResolve,
}: {
  slot: TsSlot;
  strike: number | null;
  lookup: TsLookup | null;
  position: TsPosition | undefined;
  live: { CE?: number; PE?: number };
  busy: string | null;
  realArmed: boolean;
  canTrade: boolean;
  tradableReason: string;
  onTrade: (slot: TsSlot, side: TsSide, lots: number, product: TsProduct, risk: TsRisk) => void;
  onExit: (slot: TsSlot) => void;
  onRisk: (slot: TsSlot, risk: TsRisk) => void;
  onResolve: (slot: TsSlot, option: 'CE' | 'PE', action: 'adopt' | 'discard') => void;
}) {
  const [lots, setLots] = useState(1);
  const [product, setProduct] = useState<TsProduct>('INTRADAY');
  const [draftRisk, setDraftRisk] = useState<TsRisk>({ armed: true, slPct: 30, targetPct: 50 });

  const pnl = position ? straddlePnl(position, live) : null;
  const pnlPct = position ? straddlePnlPct(position, live) : null;
  const combined = live.CE != null && live.PE != null ? live.CE + live.PE : null;
  const risk = position ? position.risk : draftRisk;
  const setRisk = (patch: Partial<TsRisk>) => {
    const next = { ...risk, ...patch };
    if (position) onRisk(slot, next); else setDraftRisk(next);
  };
  const disabled = !!busy;
  const btn = 'h-7 px-3 rounded text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs" data-slot={slot}>
      {position ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 font-bold text-zinc-100">
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${position.mode === 'REAL' ? 'bg-red-500/15 text-red-400' : 'bg-zinc-800 text-zinc-300'}`}>
                {position.mode}
              </span>
              <span>{position.side === 'S' ? 'SHORT' : 'LONG'} {position.strike} × {position.lots} lot{position.lots > 1 ? 's' : ''}</span>
              <span className="font-mono text-zinc-400">{position.product === 'INTRADAY' ? 'MIS' : 'NRML'} · {position.expiry}</span>
            </div>
            <div className="flex items-center gap-3 font-mono">
              <span className="text-zinc-400">Entry {entryPremium(position).toFixed(2)}</span>
              <span className="text-zinc-300">Now {combined != null ? combined.toFixed(2) : '—'}</span>
              <span className={`font-bold ${pnlTone(pnl)}`}>
                {pnl == null ? '—' : inr(pnl)}{pnlPct != null ? ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)` : ''}
              </span>
            </div>
          </div>
          {position.legs.some((l) => l.unconfirmed || l.pendingExit || (l.closed && !position.legs.every((x) => x.closed))) && (
            <div className="text-amber-300 flex flex-col gap-1">
              {position.legs.map((l) => {
                const msg = l.unconfirmed
                  ? `${l.option}: order accepted but fill not confirmed. Check Orders, then say what you found.`
                  : l.pendingExit
                    ? `${l.option}: closing order ${l.pendingExit.orderId} not confirmed yet. Exit re-checks it; it will not send another.`
                    : l.closed && !position.legs.every((x) => x.closed)
                      ? `${l.option}: closed; the other leg is still open — exit again.`
                      : null;
                if (!msg) return null;
                return (
                  <div key={l.option} className="flex items-center gap-2 flex-wrap">
                    <span>{msg}</span>
                    {(l.unconfirmed || l.pendingExit) && (
                      <>
                        <button type="button" className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-100 text-[10px] font-bold" onClick={() => {
                          if (window.confirm(`Only continue if Orders/Positions show the ${l.option} leg is OPEN at the broker. Track it as open?`)) onResolve(slot, l.option, 'adopt');
                        }}>It is open — track it</button>
                        <button type="button" className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-100 text-[10px] font-bold" onClick={() => {
                          if (window.confirm(`Only continue if Orders/Positions show NOTHING open for the ${l.option} leg. Discard it from this page?`)) onResolve(slot, l.option, 'discard');
                        }}>Nothing open — discard</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1 text-zinc-300">
              SL %
              <RuleNumInput value={risk.slPct} onCommit={(v) => setRisk({ slPct: v })} className="w-14" title="Stop: exit when the loss reaches this % of the entry premium" />
            </label>
            <label className="flex items-center gap-1 text-zinc-300">
              Target %
              <RuleNumInput value={risk.targetPct} onCommit={(v) => setRisk({ targetPct: v })} className="w-14" title="Target: exit when profit reaches this % of the entry premium" />
            </label>
            <label className="flex items-center gap-1 text-zinc-300 cursor-pointer">
              <input type="checkbox" checked={risk.armed} onChange={(e) => setRisk({ armed: e.target.checked })} />
              Auto-exit
            </label>
            <span className="text-zinc-500">only while this tab is open</span>
            <button
              type="button" disabled={disabled} onClick={() => onExit(slot)}
              className={`${btn} ml-auto bg-red-600 text-oncolor hover:bg-red-500`}
              aria-label={`Exit ${slot} straddle`}
            >
              {busy === 'Exiting' ? 'Exiting…' : 'Exit'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-zinc-100">{strike ?? '—'}</span>
          <label className="flex items-center gap-1 text-zinc-300">
            Lots
            <RuleNumInput value={lots} onCommit={(v) => setLots(v && Number.isInteger(v) ? v : 1)} className="w-12" step={1} />
          </label>
          <select
            value={product} onChange={(e) => setProduct(e.target.value as TsProduct)}
            className="h-7 bg-zinc-900 border border-zinc-700 rounded px-1.5 text-xs text-zinc-100" aria-label="Product"
          >
            <option value="INTRADAY">Intraday</option>
            <option value="MARGIN">Margin (carry)</option>
          </select>
          <label className="flex items-center gap-1 text-zinc-300">
            SL %
            <RuleNumInput value={draftRisk.slPct} onCommit={(v) => setRisk({ slPct: v })} className="w-12" />
          </label>
          <label className="flex items-center gap-1 text-zinc-300">
            Tgt %
            <RuleNumInput value={draftRisk.targetPct} onCommit={(v) => setRisk({ targetPct: v })} className="w-12" />
          </label>
          <div className="flex items-center gap-1.5 ml-auto">
            <button
              type="button" disabled={disabled || !canTrade || !lookup}
              title={canTrade ? undefined : tradableReason}
              onClick={() => onTrade(slot, 'S', lots, product, draftRisk)}
              className={`${btn} bg-red-600 text-oncolor hover:bg-red-500`}
            >
              {busy ? `${busy}…` : `Sell${realArmed ? ' (REAL)' : ' (SIM)'}`}
            </button>
            <button
              type="button" disabled={disabled || !canTrade || !lookup}
              title={canTrade ? undefined : tradableReason}
              onClick={() => onTrade(slot, 'B', lots, product, draftRisk)}
              className={`${btn} bg-emerald-600 text-oncolor hover:bg-emerald-500`}
            >
              Buy{realArmed ? ' (REAL)' : ' (SIM)'}
            </button>
          </div>
          {!canTrade && <p className="w-full text-amber-300">{tradableReason}</p>}
        </div>
      )}
    </div>
  );
}
