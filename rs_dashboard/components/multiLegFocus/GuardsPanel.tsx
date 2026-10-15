'use client';

import React, { useState } from 'react';
import { FOCUS_RING } from '@/components/Scalper';
import RuleNumInput from './RuleNumInput';
import {
  addSpotTrigger, removeSpotTrigger, editSpotTrigger, setSpotArmed, addGreekBand, removeGreekBand, editGreekBand, setBandArmed,
  addLossRule, removeLossRule, editAlarm, setAlarmArmed, addMarginRule, removeMarginRule, editMarginRule, setMarginArmed,
  normalizeGuards, istDayOf, spotArmBlocker, greekBandInvalid, readGreekBand, lossLevel, marginUtilisationPct, marginLevel,
  addLegRule, removeLegRule, editLegRule, setLegRuleArmed, legRuleArmBlocker, legRuleTargetable, legRuleLabel,
  DEFAULT_WARN_PCT, SPOT_CONFIRM_MS,
  type BasketGuards, type SpotTrigger, type SpotAction, type GreekBand, type GreekMetric, type NetGreeks, type LegRule, type LegRuleKind,
} from '@/lib/multiLegGuards';
import type { MultiLegLeg } from '@/lib/multiLegFocus';

interface Props {
  guards: BasketGuards | undefined;
  /** Fresh underlying price (0 when unknown or stale). */
  spot: number;
  /** Net Greeks from live marks, or null while any leg is unpriced. */
  netGreeks: NetGreeks | null;
  /** Today's strategy P&L in rupees (what the max-loss rule measures), null when a leg is unpriced. */
  pnl: number | null;
  funds: { available: number; used: number } | null;
  /** The page's leader tab is the only one that acts; other tabs show a note. */
  isLeader: boolean;
  /** Functional update (see lib/multiLegGuards.ts reducers): the watcher writes the same object, so never replace it whole. */
  onPatch: (fn: (g: BasketGuards) => BasketGuards) => void;
  /** The group's legs, for leg rules. */
  legs: MultiLegLeg[];
  /** Live price of one leg, 0 when unknown. */
  legLtp: (leg: MultiLegLeg) => number;
  /** One open leg's P&L in rupees, null when it has no live price. */
  legPnl: (leg: MultiLegLeg) => number | null;
}

const LEG_KINDS: { value: LegRuleKind; label: string }[] = [
  { value: 'premium', label: 'its price' },
  { value: 'spot', label: 'spot' },
  { value: 'loss', label: 'its loss' },
];

const SPOT_ACTIONS: { value: SpotAction; label: string }[] = [
  { value: 'ALERT', label: 'Alert me' },
  { value: 'EXIT_CE', label: 'Close calls' },
  { value: 'EXIT_PE', label: 'Close puts' },
  { value: 'EXIT_ALL', label: 'Close all' },
];
const METRICS: { value: GreekMetric; label: string; unit: string }[] = [
  { value: 'delta', label: 'Delta (Δ)', unit: 'underlying units' },
  { value: 'gamma', label: 'Gamma (Γ)', unit: 'per point' },
  { value: 'theta', label: 'Theta (Θ)', unit: '₹ per day' },
  { value: 'vega', label: 'Vega', unit: '₹ per 1% IV' },
];

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
const fmtRs = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
const today = () => istDayOf(Date.now());
const lvlCls = (l: string) => (l === 'breach' ? 'text-rose-400 font-bold' : l === 'warn' ? 'text-amber-400 font-bold' : 'text-zinc-200');

const selCls = `h-7 bg-zinc-900 border border-zinc-700 rounded text-[11px] text-zinc-100 px-1 ${FOCUS_RING}`;
const numCls = 'h-7 text-center';
const muted = 'text-zinc-400';

/** ON / OFF / FIRING switch for one rule. */
function RuleSwitch({ on, firing, label, onToggle }: { on: boolean; firing?: boolean; label: string; onToggle: (on: boolean) => void }) {
  const tone = firing ? 'border-amber-500/50 bg-amber-500/15 text-amber-400'
    : on ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400'
    : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300';
  const dot = firing ? 'bg-amber-400' : on ? 'bg-emerald-400' : 'bg-zinc-600';
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onToggle(!on)}
      title={firing ? 'Acting now: switch off to stop it' : on ? 'On: switch off to stop this rule' : 'Off: switch on to start this rule'}
      className={`h-6 w-[4.5rem] shrink-0 inline-flex items-center justify-center gap-1.5 rounded-full border text-[10px] font-bold tracking-wider ${tone} ${FOCUS_RING}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {firing ? 'FIRING' : on ? 'ON' : 'OFF'}
    </button>
  );
}

/** One rule: switch · "If <condition>" → action · live reading · remove. */
function RuleRow({ on, firing, name, onToggle, onRemove, condition, action, reading, note }: {
  on: boolean; firing?: boolean; name: string; onToggle: (on: boolean) => void; onRemove: () => void;
  condition: React.ReactNode; action: React.ReactNode; reading?: React.ReactNode; note?: string | null;
}) {
  return (
    <li className={`rounded border px-2 py-1 ${on ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-900/40'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <RuleSwitch on={on} firing={firing} label={`${name}: ${on ? 'on' : 'off'}`} onToggle={onToggle} />
        <div className="flex items-center gap-1.5 flex-wrap">{condition}</div>
        <span aria-hidden className="text-zinc-500">→</span>
        <div className="flex items-center gap-1.5">{action}</div>
        <div className="ml-auto flex items-center gap-2">
          {reading && <span className={`font-mono ${muted}`}>{reading}</span>}
          <button type="button" aria-label={`Remove ${name}`} title="Remove rule" onClick={onRemove}
            className={`h-6 w-6 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 ${FOCUS_RING}`}>×</button>
        </div>
      </div>
      {note && <p role="alert" className="mt-1 pl-[5.25rem] text-rose-400">{note}</p>}
    </li>
  );
}

export default function GuardsPanel({ guards, spot, netGreeks, pnl, funds, isLeader, onPatch, legs, legLtp, legPnl }: Props) {
  // A message shown under the rule it belongs to (why it could not be switched on).
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const g = normalizeGuards(guards);
  const triggers = g.spotTriggers ?? [];
  const bands = g.greekBands ?? [];
  const loss = g.alarm;
  const margin = g.marginAlarm;
  const legRules = g.legRules ?? [];
  const openLegs = legs.filter(legRuleTargetable);
  /** What a leg rule compares against right now, null when unknown. */
  const legReading = (r: LegRule, leg: MultiLegLeg | undefined): number | null => {
    if (!leg) return null;
    if (r.kind === 'spot') return spot > 0 ? spot : null;
    if (r.kind === 'premium') { const p = legLtp(leg); return p > 0 ? p : null; }
    return legRuleTargetable(leg) ? legPnl(leg) : null;
  };

  const apply = (fn: (g: BasketGuards) => BasketGuards) => { setNotice(null); onPatch(fn); };
  /** Switches a rule on only when `blocker` finds nothing wrong; switching off always works. */
  const toggle = (key: string, on: boolean, blocker: () => string | null, fn: (g: BasketGuards) => BasketGuards) => {
    if (on) {
      const why = blocker();
      if (why) { setNotice({ key, text: why }); return; }
    }
    apply(fn);
  };
  const noteFor = (key: string) => (notice?.key === key ? notice.text : null);

  const util = marginUtilisationPct(funds);
  const lossLvl = loss && pnl != null ? lossLevel(pnl, loss) : 'ok';
  const marginLvl = marginLevel(util, margin);
  const empty = triggers.length === 0 && bands.length === 0 && !loss && !margin && legRules.length === 0;

  const addBtn = `h-6 px-2 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-emerald-400 hover:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-zinc-900 disabled:cursor-not-allowed ${FOCUS_RING}`;

  return (
    <div className="border-t border-zinc-800 px-3 py-2 space-y-2 text-[11px]">
      {/* Live readings the rules compare against */}
      <div className="flex items-center gap-3 flex-wrap text-zinc-400">
        <span>Spot <span className="font-mono text-zinc-200">{spot > 0 ? spot.toLocaleString('en-IN') : '—'}</span></span>
        <span>P&amp;L today <span className={`font-mono ${lvlCls(lossLvl)}`}>{pnl != null ? fmtRs(pnl) : '—'}</span></span>
        <span>Margin used <span className={`font-mono ${lvlCls(marginLvl)}`}>{util != null ? `${util.toFixed(0)}%` : '—'}</span></span>
        {!isLeader && <span className="text-amber-400">Another open tab runs these rules; this one only shows them.</span>}
      </div>

      {empty && <p className="text-zinc-400">No rules yet. Example: if spot goes above 24,800, close the calls.</p>}

      <ul className="space-y-1">
        {triggers.map(t => {
          const key = `spot:${t.id}`;
          return (
            <RuleRow key={t.id} name="Spot rule" on={t.armed} firing={t.armed && !!t.firedAt}
              onToggle={on => toggle(key, on, () => spotArmBlocker(t, spot), gg => setSpotArmed(gg, t.id, on, today()))}
              onRemove={() => apply(gg => removeSpotTrigger(gg, t.id))}
              note={noteFor(key)}
              condition={<>
                <span className={muted}>If spot goes</span>
                <select aria-label="Direction" className={selCls} value={t.dir} onChange={e => apply(gg => editSpotTrigger(gg, t.id, { dir: e.target.value as SpotTrigger['dir'] }))}>
                  <option value="above">above</option>
                  <option value="below">below</option>
                </select>
                <RuleNumInput value={t.level > 0 ? t.level : undefined} onCommit={v => apply(gg => editSpotTrigger(gg, t.id, { level: v ?? 0 }))}
                  placeholder="level" min={0} step={50} className={`w-24 ${numCls}`} ariaLabel="Spot level" title="Underlying price level" />
              </>}
              action={
                <select aria-label="Then" className={selCls} value={t.action} onChange={e => apply(gg => editSpotTrigger(gg, t.id, { action: e.target.value as SpotAction }))}>
                  {SPOT_ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              }
              reading={!t.armed && t.firedAt ? `fired ${fmtTime(t.firedAt)}`
                : t.level > 0 && spot > 0 ? `${Math.abs(spot - t.level).toLocaleString('en-IN', { maximumFractionDigits: 0 })} pts away` : null}
            />
          );
        })}

        {bands.map(b => {
          const key = `band:${b.id}`;
          const m = METRICS.find(x => x.value === b.metric)!;
          const r = readGreekBand(b, netGreeks);
          const step = b.metric === 'gamma' ? 0.001 : 1;
          return (
            <RuleRow key={b.id} name="Greek rule" on={b.armed} firing={b.armed && !!b.firedAt}
              onToggle={on => toggle(key, on, () => greekBandInvalid(b), gg => setBandArmed(gg, b.id, on, today()))}
              onRemove={() => apply(gg => removeGreekBand(gg, b.id))}
              note={noteFor(key)}
              condition={<>
                <span className={muted}>If net</span>
                <select aria-label="Greek" className={selCls} value={b.metric} onChange={e => apply(gg => editGreekBand(gg, b.id, { metric: e.target.value as GreekMetric }))}>
                  {METRICS.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
                <span className={muted}>goes outside</span>
                <RuleNumInput value={b.min} onCommit={v => apply(gg => editGreekBand(gg, b.id, { min: v }))} signed placeholder="lower" step={step}
                  className={`w-20 ${numCls}`} ariaLabel="Lower limit" title={`Lower limit, in ${m.unit}. Leave empty for none.`} />
                <span className={muted}>to</span>
                <RuleNumInput value={b.max} onCommit={v => apply(gg => editGreekBand(gg, b.id, { max: v }))} signed placeholder="upper" step={step}
                  className={`w-20 ${numCls}`} ariaLabel="Upper limit" title={`Upper limit, in ${m.unit}. Leave empty for none.`} />
              </>}
              action={
                <select aria-label="Then" className={selCls} value={b.action} onChange={e => apply(gg => editGreekBand(gg, b.id, { action: e.target.value as GreekBand['action'] }))}>
                  <option value="ALERT">Alert me</option>
                  <option value="EXIT_ALL">Close all</option>
                </select>
              }
              reading={r
                ? <span className={r.breached ? 'text-rose-400 font-bold' : undefined}>now {r.value.toFixed(b.metric === 'gamma' ? 4 : 0)}</span>
                : <span title="Needs a live price on every open leg">now —</span>}
            />
          );
        })}

        {loss && (
          <RuleRow name="Max-loss rule" on={loss.armed} firing={loss.armed && !!loss.firedAt}
            onToggle={on => toggle('loss', on, () => (loss.maxLoss && loss.maxLoss > 0 ? null : 'Enter the max loss first.'), gg => setAlarmArmed(gg, on, today()))}
            onRemove={() => apply(removeLossRule)}
            note={noteFor('loss')}
            condition={<>
              <span className={muted}>If today&apos;s loss reaches ₹</span>
              <RuleNumInput value={loss.maxLoss} onCommit={v => apply(gg => editAlarm(gg, { maxLoss: v }))} placeholder="amount" min={0} step={500}
                className={`w-24 ${numCls}`} ariaLabel="Max loss in rupees" title={`Today's P&L counts open legs and legs closed today. You get a heads-up at ${DEFAULT_WARN_PCT}%.`} />
            </>}
            action={
              <select aria-label="Then" className={selCls} value={loss.exitAtMaxLoss ? 'EXIT_ALL' : 'ALERT'}
                onChange={e => apply(gg => editAlarm(gg, { exitAtMaxLoss: e.target.value === 'EXIT_ALL' }))}>
                <option value="ALERT">Alert me</option>
                <option value="EXIT_ALL">Close all</option>
              </select>
            }
            reading={!loss.armed && loss.firedAt ? `closed all ${fmtTime(loss.firedAt)}`
              : loss.maxLoss && loss.maxLoss > 0 && pnl != null
                ? <span className={lvlCls(lossLvl)}>{pnl < 0 ? Math.min(999, Math.round((-pnl / loss.maxLoss) * 100)) : 0}% of limit</span>
                : null}
          />
        )}

        {margin && (
          <RuleRow name="Margin rule" on={margin.armed}
            onToggle={on => toggle('margin', on, () => (!(margin.pct && margin.pct > 0) ? 'Enter a margin % first.' : margin.pct >= 100 ? 'Use a % below 100.' : null),
              gg => setMarginArmed(gg, on, today()))}
            onRemove={() => apply(removeMarginRule)}
            note={noteFor('margin')}
            condition={<>
              <span className={muted}>If account margin used reaches</span>
              <RuleNumInput value={margin.pct} onCommit={v => apply(gg => editMarginRule(gg, v))} placeholder="%" min={1} step={5}
                className={`w-14 ${numCls}`} ariaLabel="Margin used percent" title="Share of this broker account's margin in use (all positions, not only this strategy)" />
              <span className={muted}>%</span>
            </>}
            action={<span className="text-zinc-200">Alert me</span>}
            reading={funds ? `${fmtRs(funds.available)} free` : null}
          />
        )}

        {legRules.map(r => {
          const key = `leg:${r.id}`;
          const leg = legs.find(l => l.id === r.legId);
          const open = legRuleTargetable(leg);
          const reading = legReading(r, leg);
          // Pick list: the open option legs, plus this rule's own leg if it has closed (so the row still says which).
          const choices = open || !leg ? openLegs : [...openLegs, leg];
          const lvl = r.kind === 'loss' && reading != null ? lossLevel(reading, { maxLoss: r.level }) : 'ok';
          return (
            <RuleRow key={r.id} name="Leg rule" on={r.armed} firing={r.armed && !!r.firedAt}
              onToggle={on => toggle(key, on, () => legRuleArmBlocker(r, leg, reading), gg => setLegRuleArmed(gg, r.id, on, today()))}
              onRemove={() => apply(gg => removeLegRule(gg, r.id))}
              note={noteFor(key)}
              condition={<>
                <span className={muted}>For</span>
                <select aria-label="Rule leg" className={selCls} value={r.legId} onChange={e => apply(gg => editLegRule(gg, r.id, { legId: e.target.value }))}>
                  {!leg && <option value={r.legId}>leg no longer here</option>}
                  {choices.map(l => <option key={l.id} value={l.id}>{legRuleLabel(l)}{l.status !== 'OPEN' ? ' (closed)' : ''}</option>)}
                </select>
                <span className={muted}>if</span>
                <select aria-label="Watch" className={selCls} value={r.kind} onChange={e => apply(gg => editLegRule(gg, r.id, { kind: e.target.value as LegRuleKind, level: undefined }))}>
                  {LEG_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                {r.kind === 'loss' ? <>
                  <span className={muted}>reaches ₹</span>
                  <RuleNumInput value={r.level} onCommit={v => apply(gg => editLegRule(gg, r.id, { level: v }))} placeholder="amount" min={0} step={500}
                    className={`w-24 ${numCls}`} ariaLabel="Leg max loss in rupees" title={`This leg's own P&L. You get a heads-up at ${DEFAULT_WARN_PCT}%.`} />
                </> : <>
                  <span className={muted}>goes</span>
                  <select aria-label="Direction" className={selCls} value={r.dir ?? 'above'} onChange={e => apply(gg => editLegRule(gg, r.id, { dir: e.target.value as 'above' | 'below' }))}>
                    <option value="above">above</option>
                    <option value="below">below</option>
                  </select>
                  <RuleNumInput value={r.level} onCommit={v => apply(gg => editLegRule(gg, r.id, { level: v }))} placeholder={r.kind === 'spot' ? 'level' : 'price'} min={0}
                    step={r.kind === 'spot' ? 50 : 0.5} className={`w-24 ${numCls}`} ariaLabel={r.kind === 'spot' ? 'Spot level' : 'Leg price level'}
                    title={r.kind === 'spot' ? 'Underlying price level' : "This leg's option price"} />
                </>}
              </>}
              action={
                <select aria-label="Then" className={selCls} value={r.action} onChange={e => apply(gg => editLegRule(gg, r.id, { action: e.target.value as LegRule['action'] }))}>
                  <option value="ALERT">Alert me</option>
                  <option value="EXIT_LEG">Close leg</option>
                </select>
              }
              reading={!open ? (r.firedAt ? `closed ${fmtTime(r.firedAt)}` : 'leg closed')
                : reading == null ? 'now —'
                : r.kind === 'loss' ? (r.level && r.level > 0
                  ? <span className={lvlCls(lvl)}>{reading < 0 ? Math.min(999, Math.round((-reading / r.level) * 100)) : 0}% of limit</span>
                  : `P&L ${fmtRs(reading)}`)
                : r.kind === 'spot' ? (r.level && r.level > 0 ? `${Math.abs(reading - r.level).toLocaleString('en-IN', { maximumFractionDigits: 0 })} pts away` : null)
                : `now ₹${reading.toFixed(2)}`}
            />
          );
        })}
      </ul>

      <div className="flex items-center gap-1.5 flex-wrap">
        <button type="button" className={addBtn}
          onClick={() => apply(gg => addSpotTrigger(gg, { id: newId(), level: 0, dir: 'above', action: 'ALERT', armed: false }))}>+ Spot level</button>
        <button type="button" className={addBtn}
          onClick={() => apply(gg => addGreekBand(gg, { id: newId(), metric: 'delta', action: 'ALERT', armed: false }))}>+ Greek limit</button>
        <button type="button" className={addBtn} disabled={!!loss} title={loss ? 'Already added' : undefined}
          onClick={() => apply(addLossRule)}>+ Max loss</button>
        <button type="button" className={addBtn} disabled={!!margin} title={margin ? 'Already added' : undefined}
          onClick={() => apply(addMarginRule)}>+ Margin use</button>
        <button type="button" className={addBtn} disabled={openLegs.length === 0} title={openLegs.length === 0 ? 'No open option leg in this group' : 'A rule on one leg'}
          onClick={() => apply(gg => addLegRule(gg, { id: newId(), legId: openLegs[0].id, kind: 'premium', dir: 'above', action: 'ALERT', armed: false }))}>+ Leg rule</button>
      </div>

      <p className="text-zinc-500">
        Rules run only while this page is open. An exit waits {SPOT_CONFIRM_MS / 1000} s to confirm before acting. Editing a rule turns it off, and every rule turns off at the end of the day. A leg rule also ends when its leg closes.
      </p>
    </div>
  );
}
