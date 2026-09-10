'use client';

import React from 'react';
import { Save, FolderOpen, Trash2, ArrowUpRight } from 'lucide-react';
import type { SavedBasket } from '@/lib/basketStorage';

interface SavedBasketsPanelProps {
  saveName: string;
  onSaveNameChange: (v: string) => void;
  onSave: () => void;
  saved: SavedBasket[];
  open: boolean;
  onToggleOpen: () => void;
  onLoad: (b: SavedBasket) => void;
  onDelete: (name: string) => void;
}

export default function SavedBasketsPanel({
  saveName, onSaveNameChange, onSave, saved, open, onToggleOpen, onLoad, onDelete,
}: SavedBasketsPanelProps) {
  return (
    <div className="w-full flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">
            PRESETS & ARCHIVE
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <input
            type="text"
            value={saveName}
            onChange={e => onSaveNameChange(e.target.value)}
            placeholder="Preset name (e.g. Iron Condor 24k)"
            className="h-7 w-52 bg-zinc-950 border border-zinc-700 rounded-md px-2.5 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60 transition-colors"
          />
          <button
            type="button"
            onClick={onSave}
            className="flex items-center gap-1 h-7 px-3 text-[11px] font-mono font-bold rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-all cursor-pointer"
          >
            <Save className="w-3 h-3" />
            <span>SAVE</span>
          </button>
          <button
            type="button"
            onClick={onToggleOpen}
            className={`flex items-center gap-1.5 h-7 px-3 text-[11px] font-mono font-bold rounded-md border transition-all cursor-pointer ${
              open
                ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:text-white'
            }`}
          >
            <FolderOpen className="w-3 h-3" />
            <span>SAVED PRESETS ({saved.length})</span>
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-1 p-3 rounded-lg border border-zinc-800 bg-zinc-950/70 flex flex-col gap-2 shadow-inner">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
              STORED BASKET TEMPLATES
            </span>
            <span className="font-mono text-[9px] text-zinc-500">
              Anchors dynamically to current spot on load
            </span>
          </div>

          {saved.length === 0 ? (
            <p className="text-[11px] text-zinc-500 font-mono py-2">
              No saved baskets yet. Give this configuration a name and click &ldquo;SAVE&rdquo;.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1 scrollbar-thin">
              {saved.map(b => (
                <div
                  key={b.name}
                  className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900 transition-colors"
                >
                  <div className="flex flex-col min-w-0">
                    <button
                      type="button"
                      onClick={() => onLoad(b)}
                      className="text-left font-mono font-bold text-xs text-zinc-200 hover:text-amber-300 truncate transition-colors cursor-pointer"
                    >
                      {b.name}
                    </button>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="rounded px-1 py-0.2 font-mono text-[9px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-300">
                        {b.underlying}
                      </span>
                      <span className="rounded px-1 py-0.2 font-mono text-[9px] font-bold border border-amber-500/20 bg-amber-500/5 text-amber-400">
                        {b.category}
                      </span>
                      <span className="font-mono text-[9px] text-zinc-500">
                        {b.legs.length} legs · ×{b.multiplier}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onLoad(b)}
                      title="Load into basket builder"
                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-bold rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-all cursor-pointer"
                    >
                      <span>LOAD</span>
                      <ArrowUpRight className="w-2.5 h-2.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(b.name)}
                      className="text-zinc-600 hover:text-red-400 p-1 transition-all cursor-pointer rounded hover:bg-red-500/10"
                      aria-label={`Delete basket ${b.name}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
