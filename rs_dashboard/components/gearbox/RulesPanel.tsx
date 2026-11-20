import type { McxSession } from '@/lib/mcxSession';
import { ENTRY_AFTER_OPEN_MIN, ENTRY_BEFORE_EXIT_MIN } from '@/lib/gearbox';
import { hhmmToMin } from '@/lib/gearboxBars';

// How the car reads the market — the game's rules table, with today's MCX times for the ghost's entry window and square-off.

const TH = 'px-2.5 py-2 text-left text-xs font-bold text-white';
const TD = 'border-t border-zinc-800 px-2.5 py-2 align-top';
const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const ROWS: [string, string, string][] = [
  ['Road direction & sky', 'Mode', 'Blue sky climbing: 2 closes above EMA200 and EMA200 not falling. Dusk descending: the mirror. Fog: within 0.3 ATR of EMA200 or the slope disagrees.'],
  ['Gear shifter', 'Trend strength', '1 + the count of EMA 9/20/50/100 price is beyond in the trend\'s direction. N when neutral.'],
  ['Speedometer', 'Speed', 'Slope of EMA9 over 3 bars, in basis points per bar.'],
  ['Acceleration', 'Change in speed', 'Speed now minus speed 3 bars ago.'],
  ['Tachometer', 'Stretch', 'Distance from EMA9 in ATRs. Over 2 is over-revving: partial-profit territory.'],
  ['Altimeter', 'Distance from the ridge', '(Close − EMA200) ÷ ATR.'],
];

export function RulesPanel({ session }: { session: McxSession | null }) {
  const open = session && session.open !== session.close ? hhmmToMin(session.open) : null;
  const exit = session && session.open !== session.close ? hhmmToMin(session.autoExit) : null;
  const from = open !== null ? clock(open + ENTRY_AFTER_OPEN_MIN) : `open + ${ENTRY_AFTER_OPEN_MIN} min`;
  const to = exit !== null ? clock(exit - ENTRY_BEFORE_EXIT_MIN) : `square-off − ${ENTRY_BEFORE_EXIT_MIN} min`;
  const sq = session && session.open !== session.close ? session.autoExitLabel : 'the MCX square-off';
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4" aria-labelledby="gb-rules">
      <h2 id="gb-rules" className="mb-2.5 text-lg font-bold text-zinc-100">How the car reads the market</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800"><tr><th className={TH}>Instrument</th><th className={TH}>Market meaning</th><th className={TH}>Rule used</th></tr></thead>
          <tbody>
            {ROWS.map(([a, b, c]) => (
              <tr key={a}><td className={`${TD} font-semibold text-zinc-200`}>{a}</td><td className={`${TD} text-zinc-300`}>{b}</td><td className={`${TD} text-zinc-300`}>{c}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="mt-3.5 text-sm text-zinc-300">
        <summary className="flex min-h-9 cursor-pointer items-center font-semibold text-zinc-100">The ghost driver&apos;s strategy</summary>
        <ol className="list-decimal space-y-1.5 pl-6">
          <li>Setup arms when the gear has reached 4–5 in the current mode, then drops to 2 or 3.</li>
          <li>Entry on the next upshift if VWAP and Supertrend agree, it is between {from} and {to} IST, and the mode is more than 3 bars old.</li>
          <li>Stop: the tighter of the 10-bar swing and the Supertrend line; trailed with Supertrend at gears 4–5. The stop is tested on the bar&apos;s low / high.</li>
          <li>Exit on stop, mode flip, gear collapsing to 1, or the {sq} square-off.</li>
          <li>P&amp;L is in futures points per unit, on paper, without costs or slippage. The rules are not validated by a backtest.</li>
        </ol>
      </details>
      <p className="mt-3 text-xs text-zinc-400">
        Your trades: ↑ / ↓ buy or sell the option or future set in the direction map (options: nearest expiry after today, ATM from the server&apos;s futures price; FUT: the signal future itself).
        REAL is Dhan only, 1 lot, and must be armed on every page load. The server squares off open legs at {sq}. Keys: ↑ long · ↓ short · X exit · Space pause.
      </p>
    </section>
  );
}
