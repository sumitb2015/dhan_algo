'use client';

import React from 'react';
import { X, Sliders, Filter, Eye, Zap, Target, CalendarClock } from 'lucide-react';

interface ReadmeModalProps {
  onClose: () => void;
}

const SECTIONS: { icon: React.ElementType; title: string; body: string[] }[] = [
  {
    icon: CalendarClock,
    title: 'Pick a contract',
    body: [
      'Choose NIFTY or SENSEX, then an expiry from the dropdown next to it. The two indices trade different expiry calendars, so the scanner works one contract at a time.',
      'Press "Scan Option Chains" to fetch that contract\'s live chain. Changing the underlying, expiry, or any filter below does not re-scan by itself — you choose when to spend a fresh chain fetch.',
    ],
  },
  {
    icon: Sliders,
    title: 'Set your thresholds',
    body: [
      'Min. Profit / RoM % — the lowest return on margin per expiry cycle a setup must clear to show up.',
      'Distance Threshold — how far out of the money (OTM) the short strikes must sit, as a Min and Max % of spot. Short Straddle sells at-the-money by definition, so it will always read 0 here unless Min is 0%.',
      'Risk Profile — narrows results by probability of profit and risk tier (Conservative / Moderate / Aggressive).',
    ],
  },
  {
    icon: Filter,
    title: 'Filter by strategy',
    body: [
      'Clicking a strategy pill (Short Strangle, Iron Condor, etc.) instantly filters the candidates already on screen — it does not trigger a new scan. Click "Scan Option Chains" again after changing the underlying, expiry, or thresholds to fetch a fresh set.',
    ],
  },
  {
    icon: Target,
    title: 'Read a candidate',
    body: [
      'Each card shows RoM % (and its annualized figure), margin, probability of profit, distance from spot, and the individual legs with live LTPs, breakevens, and a risk tier.',
      'A green dot next to "Live Margin" means that figure came from Dhan\'s own margin calculator for this exact combo — accurate, but only priced for the top candidates shown (fetching it for every combo evaluated would be far too slow). Cards without the dot show "Est. Margin" — a flat per-strategy formula, useful for ranking but not the real number your broker would block.',
    ],
  },
  {
    icon: Eye,
    title: 'Watchlist',
    body: [
      '"Add to Watchlist" saves a candidate with default exit rules (50% target profit, 100% stop loss, 15:15 auto-exit). Open the Watchlist tab to edit those rules, monitor live P&L, or remove a setup.',
    ],
  },
  {
    icon: Zap,
    title: 'Trade it',
    body: [
      '"Focus Trade" sends a candidate straight to the Multi-Leg Focus terminal as a draft basket for review and execution. This places a real order once you confirm it there — it is not a paper trade.',
    ],
  },
];

export default function ReadmeModal({ onClose }: ReadmeModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-900/95 backdrop-blur rounded-t-2xl">
          <h2 className="text-sm font-bold text-white">How to use the Ultimate Scanner</h2>
          <button
            onClick={onClose}
            aria-label="Close guide"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {SECTIONS.map((section, idx) => {
            const Icon = section.icon;
            return (
              <div key={idx} className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="flex flex-col gap-1">
                  <h3 className="text-xs font-bold text-white">{section.title}</h3>
                  {section.body.map((p, i) => (
                    <p key={i} className="text-xs text-zinc-400 leading-relaxed">{p}</p>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
