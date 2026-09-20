/** How-to-read panel under the table. */
export function Guide() {
  return (
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 text-xs text-zinc-300 leading-relaxed grid gap-4 md:grid-cols-3 shadow-md w-full min-w-0">
        <div>
          <h3 className="font-bold text-white mb-1.5 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            3D Coordinate Structure
          </h3>
          <p className="text-zinc-400">
            <b>X-axis</b> = Premium change vs previous close (price momentum).<br />
            <b>Y-axis</b> = OI change vs previous day (institutional positioning).<br />
            <b>Z-axis</b> = Implied Volatility (vol pricing & smile).<br />
            Sphere size encodes absolute Open Interest (liquidity importance).
          </p>
        </div>

        <div>
          <h3 className="font-bold text-white mb-1.5 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400" />
            Buying Opportunities
          </h3>
          <p className="text-zinc-400">
            Target <span className="text-emerald-400 font-semibold">Long buildup</span> (Price↑ OI↑) that sits low on the Z-axis relative to neighbouring strikes. This represents aggressive buyer accumulation without having to pay a volatility premium.
          </p>
        </div>

        <div>
          <h3 className="font-bold text-white mb-1.5 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            Selling Opportunities
          </h3>
          <p className="text-zinc-400">
            Target <span className="text-rose-400 font-semibold">Short buildup</span> (Price↓ OI↑) situated high on the Z-axis (rich IV skew). This represents institutional writers actively shorting options with maximum theta and vega collection edge.
          </p>
        </div>
        <p className="md:col-span-3 text-zinc-500">
          Bias badges describe what a buildup implies for the <b>underlying</b>, not the option: call writing and put buying
          lean bearish, put writing and call buying lean bullish; positions being closed carry half the weight.
        </p>
      </div>
  );
}
