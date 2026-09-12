'use client';

import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface HotkeysModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function HotkeysModal({ isOpen, onClose }: HotkeysModalProps) {
  if (!isOpen) return null;

  const hotkeys = [
    { key: 'C', label: 'Roll CE Strike Up', desc: 'Shifts active Call strike +1 step further OTM (▲)' },
    { key: 'Shift+C', label: 'Roll CE Strike Down', desc: 'Shifts active Call strike -1 step down (▼)' },
    { key: 'P', label: 'Roll PE Strike Down', desc: 'Shifts active Put strike -1 step further OTM (▼)' },
    { key: 'Shift+P', label: 'Roll PE Strike Up', desc: 'Shifts active Put strike +1 step up (▲)' },
    { key: '+ / =', label: 'Increase Lots', desc: 'Adds +1 lot across all active legs' },
    { key: '- / _', label: 'Decrease Lots', desc: 'Removes -1 lot across all active legs (min 1)' },
    { key: 'H', label: '1-Click Delta Hedge', desc: 'Neutralizes net delta skew by adjusting or hedging' },
    { key: 'W', label: 'Add Protective Wings', desc: 'Buys OTM wings to cap tail risk (converts to Iron Condor)' },
    { key: 'X', label: 'Trim Position 50%', desc: 'De-risks 50% of the active lots' },
    { key: 'Escape', label: 'FLATTEN / Square Off', desc: 'Emergency square off / flattens all active legs' },
    { key: 'A', label: 'Add Custom Leg', desc: 'Opens the strike selector to add any strike across the chain' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-sm select-none font-mono">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl text-zinc-100 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              KEYBOARD SHORTCUT BINDINGS
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 space-y-2 text-xs">
          {hotkeys.map((hk) => (
            <div
              key={hk.key}
              className="flex items-center justify-between p-2 rounded-xl bg-zinc-900/80 border border-zinc-800"
            >
              <div>
                <span className="font-bold text-white block">{hk.label}</span>
                <span className="text-[11px] text-zinc-400 font-sans">{hk.desc}</span>
              </div>
              <span className="px-2.5 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 font-bold text-xs shadow-sm">
                {hk.key}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end pt-3 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow transition-colors cursor-pointer"
          >
            GOT IT
          </button>
        </div>
      </div>
    </div>
  );
}
