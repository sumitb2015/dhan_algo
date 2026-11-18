'use client';

import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import type { OptionChain } from './useMappedPrices';
import { toast } from 'sonner';
import {
  MAX_STRIKE_OFFSET, againstDir, correctedMap, legText, mapRisks, pickExpiry, pickStrike, withDirLeg, type IndexDir, type IndexMap, type IndexMapLeg,
} from '@/lib/pnfIndexMap';
import { expiryLabel, targetLabel } from '@/lib/pnfTarget';
import { pendingText, type HeldRow } from '@/lib/pnfIndexHeld';

// The Renko index chart's option map (lib/pnfIndexMap.ts): what a bullish and a bearish trade on the index buy or sell. Every control is
// a discrete pick (toggle / select), committed at once - nothing is free-typed. A change applies to the NEXT entry only: a held leg keeps
// its own contract, and the bar says so.

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60';
const OFFSETS = Array.from({ length: MAX_STRIKE_OFFSET * 2 + 1 }, (_, i) => i - MAX_STRIKE_OFFSET);
const offsetText = (n: number) => (n === 0 ? 'ATM' : n > 0 ? `+${n} OTM` : `${-n} ITM`);

export interface IndexMapControlsProps {
  symbol: string;
  map: IndexMap;
  onChange: (map: IndexMap) => void;
  /** The index's option chain for the map's expiry (useOptionChain, shared with the BULL / BEAR prices); null while it loads. */
  chain: OptionChain | null;
  /** The index's live price, for the strike preview (the order itself is resolved by the server at the click). */
  spot: number | null;
  held: HeldRow | null;
  /** Settle an unclear order after checking Orders / Positions: it went through (done) or it did not (none). */
  onSettle?: (as: 'done' | 'none') => void;
  /** The held option's lots THIS chart opened (the broker's net may include another page's). */
  ownLots?: number;
  /** The broker shows less of the held option than this chart opened (for 30 s+): said, with Forget. */
  mismatch?: string | null;
  /** Forget the held option (nothing is sent): the user checked Positions and it is gone. */
  onForget?: () => void;
  /** AUTO runs the chart: the map is shown, not edited. */
  disabled?: boolean;
}

export default function IndexMapControls({ symbol, map, onChange, chain, spot, held, onSettle, ownLots, mismatch, onForget, disabled = false }: IndexMapControlsProps) {
  const ch = chain && chain.symbol === symbol ? chain : null;
  const expiry = ch ? pickExpiry(map, ch.expiries) : null;
  const strikes = ch && ch.expiry === expiry ? ch.strikes : [];
  const preview = (leg: IndexMapLeg) => {
    const k = pickStrike(strikes, spot, leg.opt, leg.offset);
    return k === null ? null : `${leg.action} ${k} ${leg.opt}`;
  };
  // A leg that would trade AGAINST its direction is never built: picking BUY / SELL keeps the direction by choosing the option type, picking
  // CE / PE by choosing the side (bear + SELL -> SELL CE; bear + PE -> BUY PE), and the user is told what was picked and why. A strike
  // change never touches the side or the type: a saved risky leg stays as it is (banner, entries refused) until the user corrects it.
  const setLeg = (d: IndexDir, p: Partial<IndexMapLeg>) => {
    const want = { ...map[d], ...p };
    if ((p.action === undefined && p.opt === undefined) || !againstDir(d, want)) { onChange({ ...map, [d]: want }); return; }
    const fixed: IndexMapLeg = p.opt !== undefined ? { ...want, action: want.action === 'BUY' ? 'SELL' : 'BUY' } : withDirLeg(d, want);
    onChange({ ...map, [d]: fixed });
    toast.warning(`${want.action} ${want.opt} gains as ${symbol} ${d === 'bull' ? 'FALLS' : 'RISES'} - not allowed for ${d === 'bull' ? 'BULL' : 'BEAR'}. Set to ${fixed.action} ${fixed.opt} instead.`, { duration: 10_000 });
  };
  const risks = mapRisks(symbol, map);

  const toggle = (on: boolean, tone: 'buy' | 'sell' | 'plain') =>
    `px-1.5 h-6 text-[11px] font-bold rounded transition-colors ${FOCUS} ${on
      ? tone === 'buy' ? 'bg-emerald-500/20 text-emerald-400' : tone === 'sell' ? 'bg-red-500/20 text-red-400' : 'bg-zinc-700 text-white'
      : 'text-zinc-400 hover:text-zinc-200'}`;

  const legPicker = (d: IndexDir) => {
    const leg = map[d];
    const name = d === 'bull' ? 'Bullish' : 'Bearish';
    const p = preview(leg);
    return (
      <div className="flex items-center gap-1" role="group" aria-label={`${name} trade`} data-testid={`index-map-${d}`}>
        <span className={`text-[10px] font-bold uppercase tracking-wider ${d === 'bull' ? 'text-emerald-400' : 'text-red-400'}`}>{d === 'bull' ? 'Bull' : 'Bear'}</span>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-zinc-800 bg-zinc-950">
          <button type="button" disabled={disabled} aria-pressed={leg.action === 'BUY'} className={toggle(leg.action === 'BUY', 'buy')} onClick={() => setLeg(d, { action: 'BUY' })}>BUY</button>
          <button type="button" disabled={disabled} aria-pressed={leg.action === 'SELL'} className={toggle(leg.action === 'SELL', 'sell')} onClick={() => setLeg(d, { action: 'SELL' })}>SELL</button>
        </div>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-zinc-800 bg-zinc-950">
          <button type="button" disabled={disabled} aria-pressed={leg.opt === 'CE'} className={toggle(leg.opt === 'CE', 'plain')} onClick={() => setLeg(d, { opt: 'CE' })}>CE</button>
          <button type="button" disabled={disabled} aria-pressed={leg.opt === 'PE'} className={toggle(leg.opt === 'PE', 'plain')} onClick={() => setLeg(d, { opt: 'PE' })}>PE</button>
        </div>
        <select aria-label={`${name} strike`} disabled={disabled} value={leg.offset} onChange={e => setLeg(d, { offset: Number(e.target.value) })}
                className={`h-6 rounded border border-zinc-800 bg-zinc-950 px-1 text-[11px] font-semibold text-zinc-200 ${FOCUS}`}>
          {/* each offset with the strike it picks at the current index price (the order re-picks it at the click) */}
          {OFFSETS.map(n => {
            const k = pickStrike(strikes, spot, leg.opt, n);
            return <option key={n} value={n} disabled={k === null && strikes.length > 0 && spot !== null && spot > 0}>{offsetText(n)}{k !== null ? ` · ${k}` : ''}</option>;
          })}
        </select>
        <span className="sr-only" data-testid={`index-map-${d}-preview`}
              title={`${name} = ${legText(leg)} of ${symbol}; the strike is picked by the server at the click`}>
          {p ?? '—'}
        </span>
        {againstDir(d, leg) && (
          <span title={`${legText(leg)} gains as ${symbol} ${d === 'bull' ? 'FALLS' : 'RISES'}: refused - correct it (banner)`}>
            <ShieldAlert className="w-3.5 h-3.5 text-red-400" aria-label={`${name} leg trades against the direction: entries refused`} />
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="flex items-center gap-3 flex-wrap" data-testid="index-map">
      {risks.length > 0 && (
        <div role="alert" data-testid="index-map-risky"
             className="basis-full flex items-center gap-2 rounded-md border border-red-500/60 bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-300">
          <ShieldAlert className="w-4 h-4 shrink-0 text-red-400" aria-hidden="true" />
          <span className="flex-1">{risks.join('. ')}. New entries on this map are refused until it is corrected.{disabled ? ' Stop AUTO on this chart first: it was armed with this map.' : ''}</span>
          <button type="button" data-testid="index-map-correct" disabled={disabled} onClick={() => onChange(correctedMap(map))}
                  className={`px-2 h-6 rounded border border-red-500/60 bg-red-600 font-bold text-oncolor hover:bg-red-500 disabled:opacity-50 ${FOCUS}`}>
            Correct it
          </button>
        </div>
      )}
      {legPicker('bull')}
      {legPicker('bear')}
      <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
        Exp
        <select aria-label="Option expiry" disabled={disabled} value={map.expiry} onChange={e => onChange({ ...map, expiry: e.target.value })}
                className={`h-6 rounded border border-zinc-800 bg-zinc-950 px-1 text-[11px] font-semibold text-zinc-200 ${FOCUS}`}>
          <option value="NEAREST">Nearest{ch?.expiries[0] ? ` (${expiryLabel(ch.expiries[0])})` : ''}</option>
          {(ch?.expiries ?? []).slice(0, 8).map(e => <option key={e} value={e}>{expiryLabel(e)}</option>)}
          {map.expiry !== 'NEAREST' && ch && !ch.expiries.includes(map.expiry) && <option value={map.expiry}>{map.expiry} (expired)</option>}
        </select>
      </label>
      {held && (
        <span data-testid="index-held"
              className={`inline-flex items-center gap-1.5 rounded border px-1.5 h-6 text-[11px] font-bold ${held.state === 'open'
                ? held.dir === 'bull' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-400'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-400'}`}
              title="The contract this chart holds: Buy / Sell / Close / Reverse act on it until it is closed (a map change applies to the next entry)">
          {held.dir === 'bull' ? 'BULL' : 'BEAR'} · {held.action} {targetLabel(held.traded)}{ownLots ? ` · ${Number.isInteger(ownLots) ? ownLots : ownLots.toFixed(2)}L` : ''}
          {held.state !== 'open' && <> · {pendingText(held)} {held.state === 'unknown' ? 'UNKNOWN' : 'SENDING'}</>}
        </span>
      )}
      {held && held.state !== 'open' && onSettle && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
          Check Orders / Positions - did {pendingText(held)} go through?
          <button type="button" onClick={() => onSettle('done')} className={`px-1.5 h-6 rounded border border-zinc-700 bg-zinc-800 font-bold text-zinc-100 hover:bg-zinc-700 ${FOCUS}`}>It went through</button>
          <button type="button" onClick={() => onSettle('none')} className={`px-1.5 h-6 rounded border border-zinc-700 bg-zinc-800 font-bold text-zinc-100 hover:bg-zinc-700 ${FOCUS}`}>It did not</button>
        </span>
      )}
      {held && held.state === 'open' && mismatch && onForget && (
        <span data-testid="index-held-mismatch" className="inline-flex items-center gap-1 text-[11px] text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="max-w-[26rem] truncate" title={`${mismatch}. Another page may hold the same strike, so this is not proof the leg is gone - check Positions.`}>{mismatch}</span>
          <button type="button" onClick={onForget} title="Forget the held option: nothing is sent, the next click picks a fresh ATM"
                  className={`px-1.5 h-6 rounded border border-zinc-700 bg-zinc-800 font-bold text-zinc-100 hover:bg-zinc-700 ${FOCUS}`}>Forget</button>
        </span>
      )}
      <span data-testid="index-map-no-brackets" className="inline-flex items-center gap-1 text-[11px] text-zinc-400"
            title="An index chart has no rail yet: no Bracket / Cover and no resting levels watch the option it trades. The MTM Guard does (rupee levels on the option's P&L). Chart the option itself for brackets and rail levels.">
        <Info className="w-3.5 h-3.5" aria-hidden="true" /><span className="hidden 2xl:inline">No brackets here - MTM Guard in ₹</span>
        <span className="sr-only 2xl:hidden">No brackets on an index chart; the MTM guard takes rupee levels</span>
      </span>
    </div>
  );
}
