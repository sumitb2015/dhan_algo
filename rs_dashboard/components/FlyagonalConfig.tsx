'use client';

import React from 'react';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';

// Config for strategies/flyagonal/nifty_flyagonal.py, shared by StrategyCard and StrategyRowWide so the
// two launchers cannot drift. Every field is a string so an empty box means "use the script default"
// (a `parseFloat(v) || default` pattern would silently turn a legitimate 0, e.g. lower-call 0.0%, into
// the default). Defaults mirror the script's argparse defaults; validation mirrors parse_args().

export interface FlyConfig {
  maxLots: string;
  entryDteMin: string; entryDteMax: string; backDteMin: string;
  entryWeekday: string;              // '' = any day in the DTE window, else 0-6
  entryTime: string; strikeStep: string;
  flyLowerPct: string; flyBodyPct: string; flyUpperPct: string;
  putPct: string; diagOffset: string; maxNetDebit: string;
  targetProfit: string; adjustedTarget: string; stopLoss: string;
  exitDte: string; exitTime: string;
  maxAdjustments: string; adjustDelta: string; adjustStep: string;
  maxCumulativeLoss: string; keepOnStop: boolean; pollInterval: string;
}

export const FLY_DEFAULTS: FlyConfig = {
  maxLots: '5',
  entryDteMin: '8', entryDteMax: '10', backDteMin: '15',
  entryWeekday: '',
  entryTime: '09:30', strikeStep: '50',
  flyLowerPct: '0', flyBodyPct: '0.9', flyUpperPct: '1.9',
  putPct: '0.8', diagOffset: '50', maxNetDebit: '',
  targetProfit: '10%', adjustedTarget: '5%', stopLoss: '',
  exitDte: '4', exitTime: '15:15',
  maxAdjustments: '1', adjustDelta: '0.10', adjustStep: '50',
  maxCumulativeLoss: '', keepOnStop: false, pollInterval: '60',
};

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
const isSpec = (s: string) => /^\s*\d+(\.\d+)?\s*%?\s*$/.test(s);
const isHHMM = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim());
const roundStep = (x: number, step: number) => Math.round(x / step) * step;

/** Validates like the script's parse_args() and builds the argv tail. Returns {error} instead of args. */
export function buildFlyagonalArgs(c: FlyConfig, lots: number): { args: string[]; error?: string } {
  const err = (m: string) => ({ args: [] as string[], error: m });
  const n = {
    maxLots: num(c.maxLots), dteMin: num(c.entryDteMin), dteMax: num(c.entryDteMax), back: num(c.backDteMin),
    step: num(c.strikeStep), lo: num(c.flyLowerPct), body: num(c.flyBodyPct), up: num(c.flyUpperPct),
    put: num(c.putPct), diag: num(c.diagOffset), exitDte: num(c.exitDte), maxAdj: num(c.maxAdjustments),
    adjDelta: num(c.adjustDelta), adjStep: num(c.adjustStep), poll: num(c.pollInterval),
  };
  for (const [k, v] of Object.entries(n)) if (!Number.isFinite(v)) return err(`Flyagonal: "${k}" is empty or not a number.`);
  if (!(lots >= 1 && lots <= n.maxLots)) return err(`Flyagonal: Lots must be between 1 and Max Lots (${n.maxLots}).`);
  if (!(n.dteMin > 0 && n.dteMin <= n.dteMax)) return err('Flyagonal: need 0 < Entry DTE min <= Entry DTE max.');
  if (n.dteMin <= n.exitDte) return err('Flyagonal: Entry DTE min must exceed Exit DTE or it exits on entry.');
  if (n.back <= n.dteMax) return err('Flyagonal: Back-expiry min DTE must exceed Entry DTE max.');
  if (n.step <= 0 || n.adjStep <= 0 || n.diag <= 0) return err('Flyagonal: Strike step, Adjust step and Diagonal offset must be > 0.');
  if (n.poll < 5) return err('Flyagonal: Poll interval must be >= 5 seconds.');
  if (!isHHMM(c.entryTime) || !isHHMM(c.exitTime)) return err('Flyagonal: Entry/Exit time must be HH:MM.');
  if (!isSpec(c.targetProfit) || !isSpec(c.adjustedTarget)) return err('Flyagonal: Target values must be rupees or NN% (e.g. 10% or 4000).');
  if (c.stopLoss.trim() !== '' && !isSpec(c.stopLoss)) return err('Flyagonal: Stop-loss must be rupees or NN%, or empty for none.');
  for (const [label, v] of [['Max net debit', c.maxNetDebit], ['Max cumulative loss', c.maxCumulativeLoss]] as const) {
    if (v.trim() !== '' && !Number.isFinite(Number(v))) return err(`Flyagonal: ${label} must be a number or empty.`);
  }
  // Same shape check as build_structure() at a reference spot.
  const spot = 25000;
  const k1 = roundStep(spot * (1 + n.lo / 100), n.step), k2 = roundStep(spot * (1 + n.body / 100), n.step);
  const k3 = roundStep(spot * (1 + n.up / 100), n.step), ps = roundStep(spot * (1 - n.put / 100), n.step);
  if (!(k1 < k2 && k2 < k3)) return err('Flyagonal: call strikes must ascend (lower < body < upper).');
  if (!(k3 - k2 > k2 - k1)) return err('Flyagonal: upper wing must be wider than the lower wing (broken wing).');
  if (!(ps - n.diag < ps && ps < k1)) return err('Flyagonal: short put must sit below the lower call.');

  const a: string[] = [
    '--lots', String(lots), '--max-lots', c.maxLots.trim(),
    '--entry-dte-min', c.entryDteMin.trim(), '--entry-dte-max', c.entryDteMax.trim(), '--back-dte-min', c.backDteMin.trim(),
    '--entry-time', c.entryTime.trim(), '--strike-step', c.strikeStep.trim(),
    '--fly-lower-pct', c.flyLowerPct.trim(), '--fly-body-pct', c.flyBodyPct.trim(), '--fly-upper-pct', c.flyUpperPct.trim(),
    '--put-pct', c.putPct.trim(), '--diag-offset', c.diagOffset.trim(),
    '--target-profit', c.targetProfit.trim(), '--adjusted-target', c.adjustedTarget.trim(),
    '--exit-dte', c.exitDte.trim(), '--exit-time', c.exitTime.trim(),
    '--max-adjustments', c.maxAdjustments.trim(), '--adjust-delta', c.adjustDelta.trim(), '--adjust-step', c.adjustStep.trim(),
    '--poll-interval', c.pollInterval.trim(),
  ];
  if (c.entryWeekday !== '') a.push('--entry-weekday', c.entryWeekday);
  if (c.maxNetDebit.trim() !== '') a.push('--max-net-debit', c.maxNetDebit.trim());
  if (c.stopLoss.trim() !== '') a.push('--stop-loss', c.stopLoss.trim());
  if (c.maxCumulativeLoss.trim() !== '') a.push('--max-cumulative-loss', c.maxCumulativeLoss.trim());
  if (c.keepOnStop) a.push('--keep-on-stop');
  return { args: a };
}

type LabelComp = React.ComponentType<{ text: string; tip: string; className?: string }>;

interface Props {
  cfg: FlyConfig;
  setCfg: React.Dispatch<React.SetStateAction<FlyConfig>>;
  FieldLabel: LabelComp;
  fieldCls: string;
  inputCls: string;
  idPrefix: string;
  inputStyle?: React.CSSProperties;
}

export default function FlyagonalFields({ cfg, setCfg, FieldLabel, fieldCls, inputCls, idPrefix, inputStyle }: Props) {
  const set = <K extends keyof FlyConfig>(k: K) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg((p) => ({ ...p, [k]: e.target.value }));
  const txt = (k: keyof FlyConfig, w = 64, ph?: string) => (
    <Input type="text" inputMode="decimal" value={String(cfg[k])} onChange={set(k)} placeholder={ph}
      className={inputCls} style={{ width: w, ...inputStyle }} />
  );
  const F = (label: string, tip: string, child: React.ReactNode) => (
    <div className={fieldCls}><FieldLabel text={label} tip={tip} />{child}</div>
  );
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <>
      {F('Max Lots', 'Hard cap on Lots (--max-lots). Lots above it are refused before launch. The 2-lot short call means margin and freeze quantity scale 2x the lot count.', txt('maxLots'))}
      {F('Entry DTE Min', 'Front expiry must be at least this many calendar days out (--entry-dte-min, default 8).', txt('entryDteMin'))}
      {F('Entry DTE Max', 'Front expiry must be at most this many calendar days out (--entry-dte-max, default 10). Entry fires on the first day an expiry is inside the window.', txt('entryDteMax'))}
      {F('Back DTE Min', 'Back expiry for the long put: first expiry after the front that is at least this many days out (--back-dte-min, default 15, roughly double the front).', txt('backDteMin'))}
      {F('Entry Weekday', 'Restrict entry to one weekday (--entry-weekday). Any = first day the front expiry is inside the DTE window.', (
        <Select value={cfg.entryWeekday === '' ? 'any' : cfg.entryWeekday}
          onValueChange={(v) => v && setCfg((p) => ({ ...p, entryWeekday: v === 'any' ? '' : v }))}>
          <SelectTrigger className={inputCls} style={{ width: 80, ...inputStyle }}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            {DAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
          </SelectContent>
        </Select>
      ))}
      {F('Entry Time', 'Earliest entry time HH:MM IST (--entry-time, default 09:30).', txt('entryTime', 64, '09:30'))}
      {F('Strike Step', 'Strike spacing in points that strikes are rounded to (--strike-step, Nifty = 50).', txt('strikeStep'))}
      {F('Lower Call %', 'Long lower call strike vs spot, percent (--fly-lower-pct). 0 = at the money.', txt('flyLowerPct'))}
      {F('Body Call %', 'Short 2x call body strike vs spot, percent (--fly-body-pct, default 0.9).', txt('flyBodyPct'))}
      {F('Upper Call %', 'Long upper call strike vs spot, percent (--fly-upper-pct, default 1.9). Must give a wider upper wing than lower wing (broken wing).', txt('flyUpperPct'))}
      {F('Short Put %', 'Short front put this far BELOW spot, percent (--put-pct, default 0.8).', txt('putPct'))}
      {F('Diagonal Offset', 'Long back put sits this many points BELOW the short put (--diag-offset, default 50). Keeps the put pair risk-defined at the front expiry.', txt('diagOffset'))}
      {F('Max Net Debit', 'Skip entry if the structure costs more than this many index points per unit (--max-net-debit). Empty = no limit.', txt('maxNetDebit', 72, 'none'))}
      {F('Target', 'Profit target: rupees or % of the entry max loss (--target-profit, default 10%). Exits the whole book when reached.', txt('targetProfit', 72, '10% or 4000'))}
      {F('Target After Adjust', 'Target used once an adjustment has happened (--adjusted-target, default 5%).', txt('adjustedTarget', 72, '5%'))}
      {F('Stop Loss', 'Rupees or % of entry max loss (--stop-loss). Empty = none (the source strategy has none; risk is only the defined-risk structure and the time exit).', txt('stopLoss', 72, 'none'))}
      {F('Exit DTE', 'Close when the front expiry is this many days away (--exit-dte, default 4), at Exit Time on that day.', txt('exitDte'))}
      {F('Exit Time', 'Time-exit clock HH:MM IST on the Exit-DTE day (--exit-time, default 15:15).', txt('exitTime', 64, '15:15'))}
      {F('Max Adjustments', 'Put roll-ups allowed per cycle (--max-adjustments). 0 disables the adjustment rule. Rolls the short put up when net delta per lot falls to -Adjust Delta.', txt('maxAdjustments'))}
      {F('Adjust Delta', 'Roll the short put up when net position delta per lot is at or below minus this (--adjust-delta, default 0.10).', txt('adjustDelta'))}
      {F('Adjust Step', 'Points the short put is rolled up on an adjustment (--adjust-step, default 50).', txt('adjustStep'))}
      {F('Max Cum. Loss ₹', 'Halt all new entries once cumulative closed-cycle P&L is at or below minus this (--max-cumulative-loss). Empty = off.', txt('maxCumulativeLoss', 80, 'off'))}
      {F('Poll (s)', 'Seconds between chain polls and exit checks (--poll-interval, min 5, default 60). The only protection window on Zerodha/Kotak.', txt('pollInterval'))}
      <div className={fieldCls}>
        <FieldLabel text="Stop Behaviour" tip="ON: the Stop button leaves the position in place and a restart reconciles it (--keep-on-stop). OFF (default): Stop flattens all five legs." />
        <div className="flex items-center gap-2 h-7">
          <input type="checkbox" id={`fly-keep-${idPrefix}`} checked={cfg.keepOnStop}
            onChange={(e) => setCfg((p) => ({ ...p, keepOnStop: e.target.checked }))}
            className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
          <label htmlFor={`fly-keep-${idPrefix}`} className="text-xs text-zinc-400">Keep position on Stop</label>
        </div>
      </div>
    </>
  );
}
