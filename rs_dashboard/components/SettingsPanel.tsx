'use client';

import { toast } from 'sonner';
import { useEffect, useState } from 'react';
import { Settings, Sun, Moon, Coffee, Check, Clock } from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  initTheme, setThemeMode, useThemeMode, type ThemeMode,
} from '@/lib/theme';
import {
  initPreferences, setHeadingFont, useHeadingFont, HEADING_FONT_OPTIONS, type HeadingFont,
} from '@/lib/preferences';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'White', icon: Sun },
  { value: 'beige', label: 'Beige', icon: Coffee },
];

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const theme = useThemeMode();
  const headingFont = useHeadingFont();
  const [mcxCutoff, setMcxCutoff] = useState('23:15');
  const [savingCutoff, setSavingCutoff] = useState(false);

  // Preferences persist to localStorage the moment they're picked (no
  // separate Save step) — same immediacy as the standalone ThemeToggle, so
  // switching in here and via the navbar toggle can never disagree.
  useEffect(() => {
    initTheme();
    initPreferences();
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch('/api/price-ladder/settings')
      .then(r => r.json())
      .then(j => {
        if (j.success && j.settings?.mcxAutoExitTime) {
          setMcxCutoff(j.settings.mcxAutoExitTime);
        }
      })
      .catch(() => {});
  }, [open]);

  // A cutoff already passed would square off open MCX MIS positions at once: the server refuses that without
  // confirmPast, and this asks first. The picker shows what the server holds, never an unsaved choice.
  const updateCutoff = async (time: string, confirmPast = false): Promise<void> => {
    setSavingCutoff(true);
    try {
      const r = await fetch('/api/price-ladder/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcxAutoExitTime: time, confirmPast }),
      });
      const j = await r.json().catch(() => ({})) as { success?: boolean; error?: string; needsConfirm?: boolean; settings?: { mcxAutoExitTime?: string } };
      if (j.needsConfirm && !confirmPast) {
        if (window.confirm(`Set the MCX cutoff to ${time}?\n\n${j.error ?? ''}`)) await updateCutoff(time, true);
        return;
      }
      if (!j.success) { toast.error(j.error ?? 'Could not set the MCX cutoff'); return; }
      if (j.settings?.mcxAutoExitTime) setMcxCutoff(j.settings.mcxAutoExitTime);
    } catch {
      toast.error('Could not reach the server — the MCX cutoff was not changed');
    } finally {
      setSavingCutoff(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[420px] max-w-[100vw] p-0 flex flex-col bg-zinc-950 border-l border-zinc-800 gap-0"
      >
        <SheetHeader className="flex-none px-5 py-4 border-b border-zinc-800 flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <Settings className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <SheetTitle className="text-sm font-bold text-white">Settings</SheetTitle>
              <SheetDescription className="text-[10px] text-zinc-500">Saved to this browser</SheetDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="shrink-0 text-zinc-500 hover:text-white"
          >
            ×
          </Button>
        </SheetHeader>

        <div className="flex-1 flex flex-col min-h-0 px-5 py-4 gap-5 overflow-y-auto">
          {/* Trading & Sessions */}
          <div className="space-y-2.5 p-3 rounded-xl border border-amber-500/25 bg-amber-500/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                  MCX Trading Cutoff (CRUDEOILM)
                </span>
              </div>
              {savingCutoff && <span className="text-[10px] text-amber-400 font-medium">Saving…</span>}
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Orders and armed levels are permitted until this time. After this cutoff, new orders are blocked and the engine exits positions ahead of session close.
            </p>
            <div className="grid grid-cols-4 gap-2">
              {(['23:00', '23:15', '23:20', '23:25'] as const).map(time => {
                const active = mcxCutoff === time;
                return (
                  <button
                    key={time}
                    type="button"
                    onClick={() => void updateCutoff(time)}
                    className={cn(
                      'relative flex flex-col items-center justify-center py-2 px-1 rounded-xl border text-xs font-mono transition-all cursor-pointer',
                      active
                        ? 'border-amber-500/50 bg-amber-500/20 text-amber-300 font-bold ring-1 ring-amber-500/30'
                        : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700',
                    )}
                  >
                    {time}
                    <span className="text-[9px] font-sans font-normal text-zinc-500">
                      {time === '23:15' ? 'Default' : time === '23:00' ? '11:00 PM' : 'IST'}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between text-[10px] text-zinc-500 pt-1">
              <span>Active cutoff: <strong className="text-amber-300 font-mono">{mcxCutoff} IST</strong></span>
              <span>Syncs to server</span>
            </div>
          </div>

          <Separator className="bg-zinc-800/60" />

          {/* Appearance */}
          <div className="space-y-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              Appearance
            </span>
            <div className="grid grid-cols-3 gap-2">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setThemeMode(value)}
                    aria-pressed={active}
                    className={cn(
                      'relative flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-xs font-medium transition-all cursor-pointer',
                      active
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                        : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700',
                    )}
                  >
                    {active && (
                      <Check className="absolute top-1.5 right-1.5 h-3 w-3 text-amber-400" />
                    )}
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <Separator className="bg-zinc-800/60" />

          {/* Typography */}
          <div className="space-y-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              Typography — heading font
            </span>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Applies to page and panel titles. Body and table text always
              stays on Inter for legibility at small sizes.
            </p>
            <div className="space-y-1.5">
              {HEADING_FONT_OPTIONS.map(({ value, label, sample }) => (
                <HeadingFontOption
                  key={value}
                  value={value}
                  label={label}
                  sample={sample}
                  active={headingFont === value}
                  onSelect={() => setHeadingFont(value)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex-none px-5 py-3 border-t border-zinc-800/60 text-[10px] text-zinc-600">
          Appearance is saved per-browser; trading cutoff settings are synced to the server engine.
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HeadingFontOption({
  value, label, sample, active, onSelect,
}: {
  value: HeadingFont;
  label: string;
  sample: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all cursor-pointer',
        active
          ? 'border-amber-500/50 bg-amber-500/10'
          : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700',
      )}
    >
      <div className="min-w-0">
        <div className={cn('text-[10px] font-medium mb-0.5', active ? 'text-amber-400' : 'text-zinc-500')}>
          {label}
        </div>
        {/* Fixed preview token per option (app/globals.css), independent of
            --heading-font so every row shows its own font regardless of
            which one is currently applied app-wide. */}
        <div
          className="text-sm font-semibold text-zinc-100 truncate"
          style={{ fontFamily: `var(--heading-font-preview-${value})` }}
        >
          {sample}
        </div>
      </div>
      {active && <Check className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
    </button>
  );
}
