'use client';

import { StrategyTemplate } from '@/lib/optionsStrategy';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Activity, LogIn, LogOut, Save, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StrategySettingsPanelProps {
  template: StrategyTemplate;
  params: Record<string, number>;
  onParamsChange: (params: Record<string, number>) => void;
  lots: number;
  onLotsChange: (lots: number) => void;
  target: number | null;
  onTargetChange: (val: number | null) => void;
  stoploss: number | null;
  onStoplossChange: (val: number | null) => void;
  mode: 'intraday' | 'positional';
  onModeChange: (mode: 'intraday' | 'positional') => void;
  tradingType: 'live' | 'demo';
  onTradingTypeChange: (val: 'live' | 'demo') => void;
  expiryKindFilter: 'weekly' | 'monthly' | 'all';
  onExpiryKindFilterChange: (k: 'weekly' | 'monthly' | 'all') => void;
  expiries: { date: string; kind: 'weekly' | 'monthly' }[];
  selectedExpiry: string;
  onExpiryChange: (expiry: string) => void;
  onAnalyze: () => void;
  onSave: () => void;
  canSave: boolean;
  onEnterTrade: () => void;
  onExitTrade: () => void;
  canEnter: boolean;
  canExit: boolean;
  entering: boolean;
  exiting: boolean;
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <Label htmlFor={htmlFor} className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </Label>
  );
}

export default function StrategySettingsPanel({
  template, params, onParamsChange, lots, onLotsChange,
  target, onTargetChange, stoploss, onStoplossChange,
  mode, onModeChange,
  tradingType, onTradingTypeChange,
  expiryKindFilter, onExpiryKindFilterChange, expiries, selectedExpiry, onExpiryChange,
  onAnalyze, onSave, canSave, onEnterTrade, onExitTrade, canEnter, canExit, entering, exiting,
}: StrategySettingsPanelProps) {
  const visibleExpiries = expiries.filter((e) => expiryKindFilter === 'all' || e.kind === expiryKindFilter);
  const live = tradingType === 'live';

  return (
    <Card
      className={cn(
        'bg-card/80 backdrop-blur-sm transition-shadow',
        live && 'ring-amber-500/40 shadow-[0_0_24px_-8px_rgba(245,158,11,0.35)]',
      )}
    >
      <CardContent className="space-y-4">
        {/* Contract row */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <FieldLabel>Expiry series</FieldLabel>
            <ToggleGroup
              value={[expiryKindFilter]}
              onValueChange={(v: unknown[]) => {
                const next = v[v.length - 1] as typeof expiryKindFilter | undefined;
                if (next) onExpiryKindFilterChange(next);
              }}
              variant="outline"
              size="sm"
              spacing={0}
            >
              {(['weekly', 'monthly', 'all'] as const).map((k) => (
                <ToggleGroupItem key={k} value={k} className="capitalize aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">
                  {k}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel>Expiry</FieldLabel>
            <Select
              value={selectedExpiry}
              onValueChange={(v) => { if (typeof v === 'string' && v) onExpiryChange(v); }}
            >
              <SelectTrigger size="sm" className="min-w-56 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {visibleExpiries.map((e) => (
                  <SelectItem key={e.date} value={e.date} className="font-mono">
                    {e.date} · {e.kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel>Mode</FieldLabel>
            <ToggleGroup
              value={[mode]}
              onValueChange={(v: unknown[]) => {
                const next = v[v.length - 1] as typeof mode | undefined;
                if (next) onModeChange(next);
              }}
              variant="outline"
              size="sm"
              spacing={0}
            >
              {(['intraday', 'positional'] as const).map((m) => (
                <ToggleGroupItem key={m} value={m} className="capitalize aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">
                  {m}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel>Execution</FieldLabel>
            <ToggleGroup
              value={[tradingType]}
              onValueChange={(v: unknown[]) => {
                const next = v[v.length - 1] as typeof tradingType | undefined;
                if (next) onTradingTypeChange(next);
              }}
              variant="outline"
              size="sm"
              spacing={0}
            >
              <ToggleGroupItem value="demo" className="aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400">
                Paper
              </ToggleGroupItem>
              <ToggleGroupItem value="live" className="aria-pressed:bg-amber-500/20 aria-pressed:text-amber-400">
                <Zap data-icon="inline-start" /> Live
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {/* Sizing & risk row */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          {template.params.map((p) => (
            <div key={p.key} className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={`param-${p.key}`}>{p.label}</FieldLabel>
              <Input
                id={`param-${p.key}`}
                type="number"
                min={p.min}
                max={p.max}
                step={p.step}
                value={params[p.key] ?? p.default}
                onChange={(e) => onParamsChange({ ...params, [p.key]: Number(e.target.value) })}
                className="h-8 w-24 font-mono tabular-nums"
              />
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="lots-input">Lots</FieldLabel>
            <Input
              id="lots-input"
              type="number"
              min={1}
              step={1}
              value={lots || ''}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '') {
                  onLotsChange(0);
                } else {
                  const parsed = parseInt(val, 10);
                  onLotsChange(isNaN(parsed) ? 1 : parsed);
                }
              }}
              className="h-8 w-20 font-mono tabular-nums"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="target-input">Target profit ₹</FieldLabel>
            <Input
              id="target-input"
              type="number"
              min={0}
              step={100}
              placeholder="Optional"
              value={target !== null ? target : ''}
              onChange={(e) => {
                const val = e.target.value;
                onTargetChange(val === '' ? null : Number(val));
              }}
              className="h-8 w-28 font-mono tabular-nums"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="stoploss-input">Stop loss ₹</FieldLabel>
            <Input
              id="stoploss-input"
              type="number"
              min={0}
              step={100}
              placeholder="Optional"
              value={stoploss !== null ? stoploss : ''}
              onChange={(e) => {
                const val = e.target.value;
                onStoplossChange(val === '' ? null : Number(val));
              }}
              className="h-8 w-28 font-mono tabular-nums"
            />
          </div>
        </div>

        <Separator />

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onAnalyze}>
            <Activity data-icon="inline-start" /> Analyze
          </Button>

          {mode === 'positional' && (
            <Button variant="outline" onClick={onSave} disabled={!canSave}>
              <Save data-icon="inline-start" /> Save strategy
            </Button>
          )}

          <div className="ms-auto flex items-center gap-2">
            {live && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                <Zap className="size-3.5" /> Live — real orders will be placed
              </span>
            )}
            <Button
              onClick={onEnterTrade}
              disabled={!canEnter || entering || exiting}
              className="bg-emerald-600 text-oncolor hover:bg-emerald-500"
            >
              <LogIn data-icon="inline-start" /> {entering ? 'Entering…' : 'Enter trade'}
            </Button>
            <Button
              variant="destructive"
              onClick={onExitTrade}
              disabled={!canExit || entering || exiting}
            >
              <LogOut data-icon="inline-start" /> {exiting ? 'Exiting…' : 'Exit trade'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
