'use client';

import React from 'react';
import { Save, FolderOpen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
    <>
      <div className="ml-auto flex items-center gap-1.5 flex-wrap">
        <Input value={saveName} onChange={e => onSaveNameChange(e.target.value)} placeholder="Basket name"
          className="h-7 w-32 text-[11px] font-sans placeholder:text-zinc-500" />
        <Button size="sm" variant="outline" onClick={onSave} className="h-7 px-2.5 text-[11px]">
          <Save className="w-3 h-3" /> Save
        </Button>
        <Button size="sm" variant="outline" onClick={onToggleOpen}
          className={`h-7 px-2.5 text-[11px] ${open ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : ''}`}>
          <FolderOpen className="w-3 h-3" /> Load{saved.length > 0 ? ` (${saved.length})` : ''}
        </Button>
      </div>

      {open && (
        <div className="w-full px-4 py-2 border-t border-zinc-800 bg-zinc-950/40 flex flex-col gap-1">
          {saved.length === 0 && <p className="text-[11px] text-zinc-500">No saved baskets yet — name this one and press Save.</p>}
          {saved.map(b => (
            <div key={b.name} className="flex items-center gap-2">
              <button onClick={() => onLoad(b)}
                className="text-[11px] font-semibold text-zinc-300 hover:text-emerald-300 transition-all">
                {b.name}
              </button>
              <span className="text-[10px] text-zinc-600">
                {b.underlying} · {b.category} · {b.legs.length} legs · ×{b.multiplier}
              </span>
              <button onClick={() => onDelete(b.name)}
                className="ml-auto text-zinc-600 hover:text-rose-400 transition-all" aria-label={`Delete basket ${b.name}`}>
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
