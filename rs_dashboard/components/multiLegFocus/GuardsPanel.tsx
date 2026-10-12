'use client';

import React, { useState } from 'react';
import { FOCUS_RING } from '@/components/Scalper';
import RuleNumInput from './RuleNumInput';
import {
  addSpotTrigger, removeSpotTrigger, editSpotTrigger, setSpotArmed, addGreekBand, removeGreekBand, editGreekBand, setBandArmed, editAlarm, setAlarmArmed,
  istDayOf, spotArmBlocker, greekBandInvalid, readGreekBand, lossLevel, marginUtilisationPct, marginLevel, DEFAULT_WARN_PCT,
  type BasketGuards, type SpotTrigger, type SpotAction, type GreekBand, type GreekMetric, type RiskAlarm, type NetGreeks,
} from '@/lib/multiLegGuards';

interface Props {
  guards: BasketGuards | undefined;
  /** Fresh underlying price (0 when unknown or stale). */
  spot: number;
  /** Net Greeks from live marks, or null while any leg is unpriced. */
  netGreeks: NetGreeks | null;
  /** Strategy P&L in rupees on each scope the loss alarm can use, null when a leg is unpriced. */
  pnl: { today: number | null; total: number | null };
  funds: { available: number; used: number } | null;
  /** The page's leader tab is the only one that acts; other tabs show a note. */
  isLeader: boolean;
  /** Functional update (see lib/multiLegGuards.ts reducers): the watcher writes the same object, so never replace it whole. */
  onPatch: (fn: (g: BasketGuards) => BasketGuards) => void;
}

const SPOT_ACTIONS: { value: SpotAction; label: string }[] = [
  { value: 'ALERT', label: 'Alert only' },
  { value: 'EXIT_CE', label: 'Close call side' },
  { value: 'EXIT_PE', label: 'Close put side' },
  { value: 'EXIT_ALL', label: 'Close everything' },
];
const METRICS: { value: GreekMetric; label: string; hint: string }[] = [
  { value: 'delta', label: 'Net Δ', hint: 'underlying units' },
  { value: 'gamma', label: 'Net Γ', hint: 'per point' },
  { value: 'theta', label: 'Net Θ', hint: '₹ per day' },
  { value: 'vega', label: 'Net Vega', hint: '₹ per 1% IV' },
];

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
const fmtRs = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const selCls = `h-6 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-zinc-200 px-1 disabled:opacity-50 ${FOCUS_RING}`;
const chip = 'flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-[11px]';
const iconBtn = `h-6 w-6 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 ${FOCUS_RING}`;

export default function GuardsPanel({ guards, spot, netGreeks, pnl, funds, isLeader, onPatch }: Props) {
  const [notice, setNotice] = useState<string | null>(null);
  const g: BasketGuards = guards ?? {};
  const triggers = g.spotTriggers ?? [];
  const bands = g.greekBands ?? [];
  const alarm: RiskAlarm = g.alarm ?? { armed: false };

  const apply = (fn: (g: BasketGuards) => BasketGuards) => { setNotice(null); onPatch(fn); };

  const armTrigger = (t: SpotTrigger, on: boolean) => {
    if (on) {
      const why = spotArmBlocker(t, spot);
      if (why) { setNotice(why); return; }
    }
    apply(g => setSpotArmed(g, t.id, on, istDayOf(Date.now())));
  };
  const armBand = (b: GreekBand, on: boolean) => {
    if (on) {
      const why = greekBandInvalid(b);
      if (why) { setNotice(why); return; }
    }
    apply(g => setBandArmed(g, b.id, on, istDayOf(Date.now())));
  };
  const armAlarm = (on: boolean) => {
    if (on && !(alarm.maxLoss && alarm.maxLoss > 0) && !(alarm.marginWarnPct && alarm.marginWarnPct > 0)) {
      setNotice('Set a max loss or a margin warning level first.');
      return;
    }
    apply(g => setAlarmArmed(g, on, istDayOf(Date.now())));
  };

  const lossScope = alarm.lossScope ?? 'today';
  const pnlRupees = pnl[lossScope];
  const util = marginUtilisationPct(funds);
  const lossLvl = pnlRupees != null ? lossLevel(pnlRupees, alarm) : 'ok';
  const lvlCls = (l: string) => (l === 'breach' ? 'text-rose-400 font-bold' : l === 'warn' ? 'text-amber-400 font-bold' : 'text-zinc-300');

  return (
    <div className="border-t border-zinc-800 px-3 py-2 space-y-2.5 text-[11px]">
      {!isLeader && (
        <p className="text-amber-400">Another tab runs the automatic guards. They will not fire from this one.</p>
      )}
      {notice && <p role="alert" className="text-rose-400">{notice}</p>}

      {/* Spot triggers */}
      <section aria-label="Spot triggers" className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-zinc-300 font-bold uppercase tracking-wider">Spot triggers</span>
          <span className="text-zinc-500">Spot now: <span className="font-mono text-zinc-300">{spot > 0 ? spot.toLocaleString('en-IN') : 'no live price'}</span></span>
          <button type="button" className={`${chip} text-emerald-400 hover:bg-zinc-800 ${FOCUS_RING}`}
            onClick={() => apply(g => addSpotTrigger(g, { id: newId(), level: 0, dir: 'above', action: 'ALERT', armed: false }))}>
            + Add trigger
          </button>
        </div>
        {triggers.map(t => (
          <div key={t.id} className="flex items-center gap-1.5 flex-wrap">
            <span className="text-zinc-400">When spot goes</span>
            <select aria-label="Spot direction" className={selCls} value={t.dir} onChange={e => apply(g => editSpotTrigger(g, t.id, { dir: e.target.value as 'above' | 'below' }))}>
              <option value="above">above</option>
              <option value="below">below</option>
            </select>
            <RuleNumInput value={t.level > 0 ? t.level : undefined} onCommit={v => apply(g => editSpotTrigger(g, t.id, { level: v ?? 0 }))}
              placeholder="level" min={0} step={50} className="w-20 h-6 text-center text-zinc-100" title="Underlying price level" />
            <span className="text-zinc-400">then</span>
            <select aria-label="Spot action" className={selCls} value={t.action} onChange={e => apply(g => editSpotTrigger(g, t.id, { action: e.target.value as SpotAction }))}>
              {SPOT_ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <label className={`${chip} cursor-pointer select-none`}>
              <input type="checkbox" checked={t.armed} onChange={e => armTrigger(t, e.target.checked)} className="rounded border-zinc-700 text-emerald-500 focus:ring-0" />
              <span className={t.armed ? 'text-emerald-400 font-bold' : 'text-zinc-400'}>{t.armed ? (t.firedAt ? 'Firing' : 'Armed') : 'Arm'}</span>
            </label>
            {!t.armed && t.firedAt && <span className="text-zinc-500">fired {new Date(t.firedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}</span>}
            {t.level > 0 && spot > 0 && <span className="text-zinc-500">{Math.abs(spot - t.level).toFixed(0)} pts away</span>}
            <button type="button" aria-label="Remove spot trigger" title="Remove" className={iconBtn}
              onClick={() => apply(g => removeSpotTrigger(g, t.id))}>×</button>
          </div>
        ))}
        {triggers.length === 0 && <p className="text-zinc-500">e.g. spot above 24,800 then close the call side. An exit trigger must stay past its level for 3 seconds before it acts.</p>}
      </section>

      {/* Greek bands */}
      <section aria-label="Greek guardrails" className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-zinc-300 font-bold uppercase tracking-wider">Greek guardrails</span>
          <button type="button" className={`${chip} text-emerald-400 hover:bg-zinc-800 ${FOCUS_RING}`}
            onClick={() => apply(g => addGreekBand(g, { id: newId(), metric: 'delta', action: 'ALERT', armed: false }))}>
            + Add band
          </button>
          {!netGreeks && <span className="text-zinc-500">Greeks unavailable (a leg has no live price)</span>}
        </div>
        {bands.map(b => {
          const m = METRICS.find(x => x.value === b.metric)!;
          const r = readGreekBand(b, netGreeks);
          return (
            <div key={b.id} className="flex items-center gap-1.5 flex-wrap">
              <select aria-label="Greek" className={selCls} value={b.metric} onChange={e => apply(g => editGreekBand(g, b.id, { metric: e.target.value as GreekMetric }))}>
                {METRICS.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
              <span className="text-zinc-400">stay between</span>
              <RuleNumInput value={b.min} onCommit={v => apply(g => editGreekBand(g, b.id, { min: v }))} signed placeholder="min" step={m.value === 'gamma' ? 0.001 : 1}
                className="w-20 h-6 text-center text-zinc-100" title={`Minimum (${m.hint}). Leave empty for no minimum.`} />
              <span className="text-zinc-400">and</span>
              <RuleNumInput value={b.max} onCommit={v => apply(g => editGreekBand(g, b.id, { max: v }))} signed placeholder="max" step={m.value === 'gamma' ? 0.001 : 1}
                className="w-20 h-6 text-center text-zinc-100" title={`Maximum (${m.hint}). Leave empty for no maximum.`} />
              <span className="text-zinc-500">({m.hint})</span>
              <select aria-label="Band action" className={selCls} value={b.action} onChange={e => apply(g => editGreekBand(g, b.id, { action: e.target.value as GreekBand['action'] }))}>
                <option value="ALERT">Alert only</option>
                <option value="EXIT_ALL">Close everything</option>
              </select>
              <label className={`${chip} cursor-pointer select-none`}>
                <input type="checkbox" checked={b.armed} onChange={e => armBand(b, e.target.checked)} className="rounded border-zinc-700 text-emerald-500 focus:ring-0" />
                <span className={b.armed ? 'text-emerald-400 font-bold' : 'text-zinc-400'}>{b.armed ? (b.firedAt ? 'Firing' : 'Armed') : 'Arm'}</span>
              </label>
              {r && <span className={r.breached ? 'text-rose-400 font-bold' : 'text-zinc-300'}>now {r.value.toFixed(b.metric === 'gamma' ? 4 : 0)}</span>}
              <button type="button" aria-label="Remove Greek band" title="Remove" className={iconBtn}
                onClick={() => apply(g => removeGreekBand(g, b.id))}>×</button>
            </div>
          );
        })}
        {bands.length === 0 && <p className="text-zinc-500">e.g. net Δ between -150 and 150. Net values use your open legs&apos; live marks; auto-hedging is not offered yet.</p>}
      </section>

      {/* Max loss + margin alarm */}
      <section aria-label="Max loss and margin alarm" className="space-y-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-zinc-300 font-bold uppercase tracking-wider">Loss &amp; margin alarm</span>
          <span className="text-zinc-400">Max loss ₹</span>
          <RuleNumInput value={alarm.maxLoss} onCommit={v => apply(g => editAlarm(g, { maxLoss: v }))} placeholder="₹" min={0} step={500}
            className="w-24 h-6 text-center text-rose-300" title="Maximum tolerated loss in rupees" />
          <span className="text-zinc-400">warn at</span>
          <RuleNumInput value={alarm.warnPct ?? DEFAULT_WARN_PCT} onCommit={v => apply(g => editAlarm(g, { warnPct: v }))} placeholder="%" min={1} step={5}
            className="w-14 h-6 text-center text-amber-300" title="Warn when the loss reaches this % of max loss" />
          <span className="text-zinc-400">%</span>
          <label className={`${chip} cursor-pointer select-none`} title="Also close the strategy when the full max loss is reached">
            <input type="checkbox" checked={!!alarm.exitAtMaxLoss} onChange={e => apply(g => editAlarm(g, { exitAtMaxLoss: e.target.checked }))} className="rounded border-zinc-700 text-emerald-500 focus:ring-0" />
            <span className={alarm.exitAtMaxLoss ? 'text-rose-400 font-bold' : 'text-zinc-400'}>Close at max loss</span>
          </label>
          <select aria-label="What the max loss counts" title="Today: open legs plus legs closed today (the page's Today P&L). All trades: also trades closed on earlier days."
            className={selCls} value={lossScope} onChange={e => apply(g => editAlarm(g, { lossScope: e.target.value as 'today' | 'total' }))}>
            <option value="today">Today&apos;s P&amp;L</option>
            <option value="total">All trades</option>
          </select>
          <span className="text-zinc-400">Margin warn at</span>
          <RuleNumInput value={alarm.marginWarnPct} onCommit={v => apply(g => editAlarm(g, { marginWarnPct: v }))} placeholder="%" min={1} step={5}
            className="w-14 h-6 text-center text-amber-300" title="Warn when account margin utilisation reaches this %" />
          <span className="text-zinc-400">%</span>
          <label className={`${chip} cursor-pointer select-none`}>
            <input type="checkbox" checked={alarm.armed} onChange={e => armAlarm(e.target.checked)} className="rounded border-zinc-700 text-emerald-500 focus:ring-0" />
            <span className={alarm.armed ? 'text-emerald-400 font-bold' : 'text-zinc-400'}>{alarm.armed ? 'Armed' : 'Arm'}</span>
          </label>
        </div>
        <div className="flex items-center gap-3 text-zinc-500">
          <span>P&amp;L <span className={`font-mono ${lvlCls(lossLvl)}`}>{pnlRupees != null ? fmtRs(pnlRupees) : '—'}</span>
            {alarm.maxLoss && alarm.maxLoss > 0 && pnlRupees != null && pnlRupees < 0 ? ` (${Math.min(999, Math.round((-pnlRupees / alarm.maxLoss) * 100))}% of max loss)` : ''}</span>
          <span>Margin in use <span className={`font-mono ${lvlCls(marginLevel(util, alarm))}`}>{util != null ? `${util.toFixed(0)}%` : '—'}</span>
            {funds ? ` · ${fmtRs(funds.available)} free` : ''}</span>
        </div>
      </section>
      <p className="text-zinc-500">Editing any guard disarms it; re-arm after a change. A guard armed today is disarmed at the next IST day. Guards run only while this page is open in the leader tab.</p>
    </div>
  );
}
