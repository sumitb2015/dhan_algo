'use client';

import React from 'react';
import { BookOpen, ChevronDown } from 'lucide-react';

// In-page README for the NIFTYBEES Covered Call desk. Collapsed by default so
// it doesn't push the live numbers down once you know the desk.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-bold text-zinc-100">{title}</div>
      <div className="text-[11px] leading-relaxed text-zinc-300 space-y-1">{children}</div>
    </div>
  );
}

export default function HowToUse() {
  return (
    <details className="group mx-4 mt-4 bg-zinc-950/40 border border-zinc-800/60 rounded-xl">
      <summary className="flex items-center gap-1.5 px-3 py-2 cursor-pointer select-none list-none text-xs font-bold text-zinc-100 uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 rounded-xl">
        <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
        How to use this desk
        <ChevronDown className="w-3.5 h-3.5 ml-auto text-zinc-400 transition-transform group-open:rotate-180" />
      </summary>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-3 pb-3 pt-1">
        <Section title="1. What the strategy is">
          <p>
            You hold NIFTYBEES (the long side) and sell out-of-the-money NIFTY calls against it to collect premium.
            If Nifty stays below the strike, the call decays and you keep the premium, which lowers your effective cost
            per NIFTYBEES unit. If Nifty rallies past the strike, the call loses money while the holding gains, so your
            upside is capped near the strike for the covered part.
          </p>
          <p>
            This page never buys or sells NIFTYBEES. It reads your holding from Dhan (demat + T1 + today&apos;s delivery
            buys) and only trades NIFTY calls, as NRML, held to expiry unless you buy them back.
          </p>
        </Section>

        <Section title="2. Check your coverage first">
          <p>
            NIFTYBEES trades at roughly 1/87 of Nifty, so your holding is worth a number of <b>Nifty units</b> (shown as
            &quot;Nifty-equivalent&quot; in the holding panel). One NIFTY lot is 65 units.
          </p>
          <p>
            The coverage gauge shows written calls ÷ holding. Up to 100% is covered. <b>Above 100% the extra calls are
            naked short calls</b> with unlimited upside risk — the desk warns you and asks for confirmation before such an
            order. If your holding is less than one lot, any call you sell is partly naked.
          </p>
        </Section>

        <Section title="3. Write a call">
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>Pick an expiry in the header (monthly expiries suit a covered call best).</li>
            <li>Set <b>Target Δ</b> (0.20–0.30 is typical): the desk suggests the OTM strike closest to it, or type your own strike.</li>
            <li>Check premium, yield, annualised yield, return if called away and downside cushion.</li>
            <li>Choose lots and LIMIT (recommended, seeded from LTP) or MARKET, then press <b>SELL</b> and confirm.</li>
          </ol>
          <p>
            Only fills Dhan confirms are recorded, at the order&apos;s own average price. A LIMIT that doesn&apos;t fill at
            once stays open at the broker and is recorded automatically when it fills.
          </p>
        </Section>

        <Section title="4. Manage open calls">
          <p>
            The <b>Calls Written</b> table shows decay %, MTM, delta and theta per call. Common rules of thumb (not
            automated here — buy-backs are manual):
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li><b>Buy Back</b> when most of the premium has decayed (e.g. 75–80%) to free the holding for a new call.</li>
            <li><b>Roll</b> when Nifty threatens the strike or expiry is near: pick the new strike/expiry in Write Call,
              then press ROLL on the old call. The new call is sold only after the buy-back fully fills.</li>
            <li>Watch net delta in the Greeks panel: it falls as calls go in the money, i.e. the holding&apos;s upside is being given away.</li>
          </ul>
        </Section>

        <Section title="5. Calls the desk doesn't own (ADOPT)">
          <p>
            Other strategies on this account also short NIFTY calls, so the desk only counts calls it sold or that you
            adopt. <b>ADOPT</b> records an existing short (no order is placed): pick the sell order from today&apos;s list
            so it is recorded at that order&apos;s own price, or type <code>p&lt;price&gt;</code> for a call carried
            from an earlier day. Adopt only calls you actually wrote against NIFTYBEES.
          </p>
        </Section>

        <Section title="6. When the broker shows less (SYNC)">
          <p>
            If a call is bought back elsewhere or expires, the row shows ⚠ and a <b>SYNC</b> button. Until you sync, its
            P&amp;L is counted at an estimate. SYNC records the close at the real buy trade from today&apos;s trade book;
            if none matches, it asks for the price (0 for a call that expired worthless).
          </p>
        </Section>

        <Section title="Reading the numbers">
          <ul className="list-disc pl-4 space-y-0.5">
            <li><b>Effective cost / BEES</b>: your average cost minus all call P&amp;L per unit — the real cost basis after premium.</li>
            <li><b>Total P&amp;L</b>: holding unrealized + open calls + realized calls (+ any unsynced estimate).</li>
            <li>Greeks are in Nifty units and ₹; a * on delta means Dhan&apos;s chain had no Greeks and it was estimated.</li>
          </ul>
        </Section>

        <Section title="Safety">
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Every order is real money and asks for confirmation. Max 20 lots per order; whole lots only.</li>
            <li>A buy-back is capped at that call&apos;s own open units and at what Dhan still shows short, so it can&apos;t close another strategy&apos;s position or leave you long.</li>
            <li>Selling NIFTYBEES while calls are open turns them into naked calls — buy the calls back first.</li>
          </ul>
        </Section>
      </div>
    </details>
  );
}
