'use client';

import React from 'react';
import { BookOpen, X, ShieldCheck, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Modal guide for the NIFTYBEES Covered Call desk
export default function HowToUseModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="relative w-full max-w-3xl max-h-[85vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/80">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
              <BookOpen className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">How to Use NIFTYBEES Covered Call Desk</h2>
              <p className="text-xs text-zinc-400">Strategy overview, coverage rules, and order safety</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            aria-label="Close guide"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto p-6 space-y-5 text-xs text-zinc-300 leading-relaxed">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/80 space-y-2">
              <div className="flex items-center gap-2 font-bold text-zinc-100 text-sm">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                1. Strategy Concept
              </div>
              <p>
                You hold <b>NIFTYBEES</b> shares in your Dhan demat account and sell out-of-the-money (OTM) <b>NIFTY index calls</b> against them.
              </p>
              <p>
                The premium you collect reduces your <b>effective cost per BEES unit</b>. If Nifty stays below the strike, you keep 100% of the premium as pure cash flow.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/80 space-y-2">
              <div className="flex items-center gap-2 font-bold text-zinc-100 text-sm">
                <CheckCircle2 className="w-4 h-4 text-sky-400" />
                2. Measuring Coverage
              </div>
              <p>
                NIFTYBEES value is converted to Nifty units: <code>(BEES Qty × BEES LTP) ÷ Nifty Spot</code>.
              </p>
              <p>
                <b>1 NIFTY lot = 65 units</b>. If your holding is worth 65 units, you can safely write 1 lot. The desk displays your exact covered capacity.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/80 space-y-2">
              <div className="flex items-center gap-2 font-bold text-zinc-100 text-sm">
                <span className="text-emerald-400 font-mono">03</span>
                Writing a Call
              </div>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Choose a monthly or weekly expiry.</li>
                <li>Pick the <b>Recommended Strike</b> (around 0.25 Delta) for optimal risk-reward (~80% probability of expiring OTM).</li>
                <li>Review the upfront cash credit, yield, and downside cushion points.</li>
                <li>Click <b>Sell Call</b> to place your NRML order.</li>
              </ol>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/80 space-y-2">
              <div className="flex items-center gap-2 font-bold text-zinc-100 text-sm">
                <span className="text-emerald-400 font-mono">04</span>
                Managing &amp; Rolling
              </div>
              <ul className="list-disc pl-4 space-y-1">
                <li><b>Take Profit:</b> When decay reaches <b>70%–80%</b>, click <b>Buy Back</b> to lock in gains and free your holding.</li>
                <li><b>Roll:</b> If Nifty rallies toward the strike, use <b>Roll</b> to buy back the current call and write a further OTM call.</li>
              </ul>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 space-y-1.5">
            <div className="flex items-center gap-2 font-bold text-amber-300 text-sm">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              Safety &amp; Execution Guards
            </div>
            <p>
              • <b>No Automatic BEES Trading:</b> This desk only places NIFTY option orders. It never buys or sells your NIFTYBEES shares.
            </p>
            <p>
              • <b>Naked Call Protection:</b> If you attempt to write more lots than your NIFTYBEES holding covers, the desk flags it in amber and prompts for explicit confirmation.
            </p>
            <p>
              • <b>Real-time Confirmation:</b> Only Dhan-confirmed fills are recorded into your covered call ledger.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 py-3 border-t border-zinc-800 bg-zinc-950/80">
          <Button onClick={onClose} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-5">
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
