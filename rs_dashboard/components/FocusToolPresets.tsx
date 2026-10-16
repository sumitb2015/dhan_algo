'use client';

/**
 * Focus Tool: Duplicate row, rule presets (save / apply / delete) and config export / import.
 *
 * Configuration only. Nothing here places an order: a duplicate or an imported row is always a flat SIM draft, and a
 * preset is applied only to a row that holds nothing (presetBlockedReason). The page (FocusTool.tsx) owns the state
 * and the writes; the row views reach them through FocusPresetsContext so the three views' prop types stay as they are.
 */
import React, { createContext, useContext, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Copy, Download, Trash2, Upload } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { FocusRow } from '@/lib/focusToolRows';
import { PRESET_NAME_MAX, presetBlockedReason, type FocusPreset } from '@/lib/focusToolPresets';

export interface FocusPresetsApi {
  presets: FocusPreset[];
  duplicateRow: (rowId: string) => void;
  /** Open the presets panel with this row picked for "Save as preset". */
  openSavePreset: (rowId: string) => void;
  applyPreset: (rowId: string, preset: FocusPreset) => void;
}

export const FocusPresetsContext = createContext<FocusPresetsApi | null>(null);

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

/** Short label for a row in lists: "NIFTY · 09:20–15:15 · BOTH · #a1b2". */
export function rowLabel(row: FocusRow): string {
  return `${row.underlying} · ${row.entryTime}–${row.exitTime} · ${row.side} · #${row.id.slice(-4)}`;
}

/** Duplicate / Save as preset / Apply preset, as items inside an existing row menu (Pro view). */
export function RowPresetMenuItems({ row }: { row: FocusRow }) {
  const api = useContext(FocusPresetsContext);
  if (!api) return null;
  const mine = api.presets.filter(p => p.underlying === row.underlying);
  const blocked = presetBlockedReason(row);
  return (
    <>
      <DropdownMenuItem onClick={() => api.duplicateRow(row.id)}>
        <Copy className="size-4" /> Duplicate row
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => api.openSavePreset(row.id)}>
        <BookmarkPlus className="size-4" /> Save rules as preset…
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!!blocked} title={blocked ?? undefined}>
          <Bookmark className="size-4" /> {blocked ? 'Apply preset (unavailable)' : 'Apply preset'}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          {mine.length === 0
            ? <DropdownMenuItem disabled>No {row.underlying} presets yet</DropdownMenuItem>
            : mine.map(p => (
              <DropdownMenuItem key={p.name} onClick={() => api.applyPreset(row.id, p)}
                title={`Replace this row's rules with "${p.name}" (spot levels, expiry and SIM/REAL are kept)`}>
                {p.name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

/** The same actions behind their own icon button (Table and Cards views). */
export function RowPresetMenuButton({ row, className }: { row: FocusRow; className?: string }) {
  const api = useContext(FocusPresetsContext);
  if (!api) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <button type="button" aria-label="Duplicate row or presets" title="Duplicate row, save or apply a preset"
          className={cn('p-1 rounded text-zinc-500 hover:text-violet-300 hover:bg-violet-500/10 transition-colors cursor-pointer', FOCUS_RING, className)} />
      }>
        <Bookmark className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <RowPresetMenuItems row={row} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Contents of the Presets drawer: save a row as a preset, the preset list, export / import. */
export function PresetsPanel({
  rows, presets, initialRowId, busy, onSave, onDelete, onExport, onImport,
}: {
  rows: FocusRow[];
  presets: FocusPreset[];
  initialRowId: string | null;
  busy: boolean;
  onSave: (rowId: string, name: string) => void;
  onDelete: (p: FocusPreset) => void;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  const [rowId, setRowId] = useState(initialRowId ?? rows[0]?.id ?? '');
  const [name, setName] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const picked = rows.find(r => r.id === rowId);
  const clash = !!picked && presets.some(p => p.underlying === picked.underlying && p.name.toLowerCase() === name.trim().toLowerCase());
  const grouped = useMemo(() => {
    const m = new Map<string, FocusPreset[]>();
    for (const p of presets) m.set(p.underlying, [...(m.get(p.underlying) ?? []), p]);
    return [...m.entries()];
  }, [presets]);

  const label = 'text-[11px] font-bold uppercase tracking-wider text-zinc-500';
  const field = cn('h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100 focus:outline-none focus:border-violet-500', FOCUS_RING);
  const btn = cn('inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', FOCUS_RING);

  return (
    <div className="flex flex-col gap-6 text-xs">
      <section className="flex flex-col gap-2">
        <h3 className={label}>Save a row as a preset</h3>
        <p className="text-zinc-400">
          Saves the row&rsquo;s rules: timing, strikes, lots, stops, targets, re-entry, trail and lazy legs. It leaves out the
          day&rsquo;s spot levels, the expiry, SIM/REAL and any position. A preset only applies to rows of the same index,
          and only to a row that is not armed and holds nothing (disarm it first).
        </p>
        <select value={rowId} onChange={e => setRowId(e.target.value)} className={field} aria-label="Row to save">
          {rows.length === 0 && <option value="">No rows</option>}
          {rows.map(r => <option key={r.id} value={r.id}>{rowLabel(r)}</option>)}
        </select>
        <div className="flex gap-2">
          <input value={name} onChange={e => setName(e.target.value)} maxLength={PRESET_NAME_MAX}
            placeholder="Preset name, e.g. Nifty 20% SL + RE OTM" className={field} aria-label="Preset name"
            onKeyDown={e => { if (e.key === 'Enter' && picked && name.trim()) { onSave(picked.id, name); setName(''); } }} />
          <button type="button" disabled={!picked || !name.trim() || busy}
            onClick={() => { if (picked) { onSave(picked.id, name); setName(''); } }}
            className={cn(btn, 'bg-violet-600 text-oncolor hover:bg-violet-500 shrink-0')}>
            <BookmarkPlus className="h-3.5 w-3.5" /> {clash ? 'Replace' : 'Save'}
          </button>
        </div>
        {clash && <p className="text-amber-300">A {picked?.underlying} preset with this name exists. Saving replaces it.</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={label}>Saved presets</h3>
        {presets.length === 0 && (
          <p className="text-zinc-500">
            None yet. To use one, open a row&rsquo;s menu and choose Apply preset. Use Duplicate row in the same menu to copy a row.
          </p>
        )}
        {grouped.map(([u, list]) => (
          <div key={u} className="flex flex-col gap-1">
            <span className="text-[11px] font-black text-violet-300">{u}</span>
            {list.map(p => {
              const key = `${p.underlying}:${p.name}`;
              return (
                <div key={key} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
                  <span className="flex-1 min-w-0 truncate font-semibold text-zinc-100" title={p.name}>{p.name}</span>
                  <span className="text-zinc-500 tabular-nums">{p.savedAt.slice(0, 10)}</span>
                  {confirmDel === key ? (
                    <>
                      <button type="button" onClick={() => { onDelete(p); setConfirmDel(null); }}
                        className={cn(btn, 'h-6 px-2 bg-rose-600 text-oncolor hover:bg-rose-500')}>Delete</button>
                      <button type="button" onClick={() => setConfirmDel(null)}
                        className={cn(btn, 'h-6 px-2 text-zinc-300 hover:bg-zinc-800')}>Keep</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDel(key)} aria-label={`Delete preset ${p.name}`} title="Delete this preset"
                      className={cn('p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer', FOCUS_RING)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={label}>Backup</h3>
        <p className="text-zinc-400">
          Export saves every row&rsquo;s rules, its expiry and every preset to a JSON file. Import <b className="text-zinc-200">adds</b> the
          file&rsquo;s rows as new SIM drafts, so existing rows are never changed. A row keeps its expiry if it is still listed,
          otherwise it moves to the nearest one. Spot H↑ / L↓ levels are not restored, because they were that day&rsquo;s prices.
          Import also saves the file&rsquo;s presets, replacing any with the same name. Positions, REAL/SIM and the account
          Risk bar are not in the file.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={onExport} className={cn(btn, 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800')}>
            <Download className="h-3.5 w-3.5" /> Export
          </button>
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
            className={cn(btn, 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800')}>
            <Upload className="h-3.5 w-3.5" /> Import…
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
        </div>
      </section>
    </div>
  );
}

