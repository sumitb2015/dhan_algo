/** Column definitions for the CSP screener — the single source for both the
 *  glossary modal and the `title` tooltip on every table header.
 *
 *  Kept in one place deliberately: a header tooltip and a glossary entry that
 *  disagree are worse than having only one of them.
 *
 *  Formulas are transcribed from scripts/tools/csp_scanner.py — if the scoring
 *  weights or probability model change there, change them here too, or the page
 *  will confidently document something it no longer does. */

export interface ColumnDoc {
  /** Must match the table header text exactly — that is the lookup key. */
  term: string;
  formula?: string;
  desc: string;
  /** Short, one-sentence version shown in the header's hover tooltip. Falls
   *  back to `desc` when omitted — set this whenever `desc` runs long. */
  tip?: string;
}

export const SCANNER_COLUMNS: ColumnDoc[] = [
  {
    term: 'Symbol',
    tip: 'Underlying stock — one row per liquid strike.',
    desc: 'Underlying stock. Every liquid strike gets its own row, so one symbol normally appears several times at different risk levels — tick "Best per symbol" to collapse to one.',
  },
  {
    term: 'Score',
    formula: '(no-hit×0.7 + (1−touch)×0.3)×45 + min(ann÷30,1)×40 + min(OI in lots÷200,1)×15',
    tip: '0–100 blend of safety, return and liquidity.',
    desc: 'Heuristic 0–100 blend of safety, return and liquidity. Safety blends no-hit (finishes above strike) with touch (never dips through it), since two strikes can share a no-hit% while one whipsaws through the strike and back. Liquidity is OI in lots, not shares, so it grades every symbol on the same scale regardless of lot size. Caps stop one very rich or very liquid strike from swamping the rest. It ranks attractiveness *within* whatever no-hit band you filter to — it is not a risk measure on its own.',
  },
  {
    term: 'LTP',
    tip: 'Live spot price at scan time.',
    desc: 'Live spot price of the underlying at scan time.',
  },
  {
    term: 'Expiry',
    tip: 'Expiry of the contract, per the Near/Next/Far selector.',
    desc: 'Expiry of the contract being sold — whichever of the symbol’s listed expiries the Near/Next/Far selector picked, always at least 5 days out.',
  },
  {
    term: 'DTE',
    tip: 'Calendar days to expiry.',
    desc: 'Calendar days to expiry. Every expiry the scanner can select is at least 5 days out — a 1-day contract has almost no premium left and would distort the yield ranking.',
  },
  {
    term: '1D',
    tip: '1-day % move. * means stale data.',
    desc: 'Underlying’s percentage move over the last trading session. A trailing amber * means the daily-history CSV this is computed from hasn\'t refreshed in a few days — treat 1D/5D as stale for that row.',
  },
  {
    term: '5D',
    tip: '5-day % move of the underlying.',
    desc: 'Underlying’s percentage move over the last 5 trading sessions.',
  },
  {
    term: 'Suggested Strike',
    tip: 'OTM put strike, its no-hit probability and lot size.',
    desc: 'The OTM put strike for this row, with its no-hit probability and lot size. Every liquid strike above the scan floor gets its own row, so one symbol usually appears several times at different risk levels.',
  },
  {
    term: 'Yield',
    formula: 'premium ÷ strike',
    tip: 'Premium collected as a % of the strike.',
    desc: 'Premium collected as a percentage of the strike — your return on the cash securing the put, for this contract’s duration only.',
  },
  {
    term: 'Ann.',
    formula: 'yield × (365 ÷ DTE)',
    tip: 'Yield annualised — a run-rate, not compounded.',
    desc: 'Simple annualised return — yield scaled linearly by calendar days to expiry, not compounded and not trading-day (252) based. Treat it as a run-rate, not a forecast or a CAGR: it extrapolates a ~10-day contract and assumes you keep redeploying at the same rate with no compounding.',
  },
  {
    term: 'Premium',
    formula: 'premium/share × lot size',
    tip: 'Total rupees collected for one lot.',
    desc: 'Total rupees collected for one lot, with the per-share figure beneath.',
  },
  {
    term: 'No-hit',
    formula: 'N(d₂),  d₂ = [ln(S/K) + (r − σ²/2)T] ÷ σ√T',
    tip: 'Chance the put expires worthless (Black–Scholes).',
    desc: 'Black–Scholes probability the underlying finishes ABOVE the strike at expiry — i.e. the put expires worthless and you keep the whole premium. Uses the chain’s implied volatility and a 6.5% risk-free rate.',
  },
  {
    term: 'Touch',
    formula: 'GBM first-passage probability',
    tip: 'Chance spot dips to/below the strike before expiry.',
    desc: 'Chance the underlying trades at or below the strike at ANY point before expiry. Always higher than (100 − No-hit), because a stock can dip through the strike and recover. This is the number that reflects how uncomfortable the position is likely to get, even when it ends up expiring worthless.',
  },
  {
    term: 'Capital Req.',
    formula: 'strike × lot size',
    tip: 'Cash to fully secure the put if assigned.',
    desc: 'Cash to fully secure the put — what you pay if assigned. Your broker will block margin rather than this full amount, so actual margin is lower.',
  },
  {
    term: 'Rationale',
    tip: 'One-line summary of the row.',
    desc: 'One-line summary of the row: 5-day move, strike and its no-hit probability, premium per share, and how far out of the money the strike sits.',
  },
  {
    term: 'Trade',
    tip: 'Sell places a real order. Buy is disabled.',
    desc: 'Sell places a REAL market order on Dhan and starts tracking the position. Buy is deliberately inert — a cash-secured put is sold, not bought.',
  },
];

export const TRACKED_COLUMNS: ColumnDoc[] = [
  {
    term: 'Symbol',
    tip: 'Underlying of the sold put.',
    desc: 'Underlying of the sold put. ⚠ marks a row the last sync could not price; UNCONFIRMED marks one whose fill was never confirmed, so its quantity and average are what was requested rather than what filled — run Reconcile.',
  },
  {
    term: 'Strike',
    tip: 'Strike you are short.',
    desc: 'Strike of the put you are short. Assignment obliges you to buy the stock at this price.',
  },
  { term: 'Expiry', desc: 'Expiry of the contract.' },
  { term: 'Date', desc: 'Date the position was opened.' },
  { term: 'LTP', tip: 'Live spot as of last Sync.', desc: 'Live spot of the underlying as of the last Sync. Dashes until you sync.' },
  {
    term: 'Entry Spot',
    tip: 'Spot when the position opened.',
    desc: 'Spot at the time the position was opened, with the underlying’s drift since then beneath it.',
  },
  {
    term: 'To Strike',
    formula: '(spot − strike) ÷ spot',
    tip: 'Headroom left before spot reaches the strike.',
    desc: 'Headroom left before the underlying reaches the strike. Negative means the put is in the money.',
  },
  {
    term: 'No-hit',
    formula: 'N(d₂),  d₂ = [ln(S/K) + (r − σ²/2)T] ÷ σ√T',
    tip: 'Chance the put expires worthless, from live mark.',
    desc: 'Probability the put expires worthless, recomputed from the live mark at the last Sync. Omitted rather than shown as 100% when implied volatility or spot is unavailable.',
  },
  {
    term: 'Qty',
    tip: 'Contract quantity (lots × lot size).',
    desc: 'Contract quantity — lots × lot size, not lots. Reconcile replaces this with the broker’s own net short, which is what an exit is sized from.',
  },
  {
    term: 'Avg',
    tip: 'Average price the put was sold at.',
    desc: 'Average price the put was sold at, taken from the order’s real traded price. A 0 with an UNCONFIRMED badge means the fill was never confirmed — run Reconcile to pull the broker’s figure.',
  },
  {
    term: 'PE LTP',
    tip: 'Current mark of the put, from last Sync.',
    desc: 'Current mark of the put itself, from the last Sync. Blank when the chain could not be priced — the P&L is then left blank rather than assuming zero.',
  },
  {
    term: 'Visual Status',
    tip: 'Where spot sits between strike and entry spot.',
    desc: 'Where spot currently sits between the sold strike (far left, danger) and the entry spot (far right, safe). Green above two-thirds, amber in the middle, red near the strike.',
  },
  {
    term: 'Current P&L',
    formula: '(avg − PE LTP) × qty',
    tip: '(avg − PE LTP) × qty, before charges.',
    desc: 'Open rows mark to the last Sync — a short put profits as the premium decays. Closed and rolled rows show realised P&L. Excludes brokerage, STT and other charges.',
  },
  {
    term: 'Status',
    tip: 'OPEN, CLOSED, or ROLLED.',
    desc: 'OPEN, CLOSED (bought back), or ROLLED (closed as leg 1 of a Shift, with a new row opened at the lower strike).',
  },
  {
    term: 'Order ID',
    tip: 'Broker order id. "paper" = manually tracked.',
    desc: 'Broker order id for the entry. "paper" means a manually tracked row with no linked contract — those cannot be exited or shifted from here.',
  },
  {
    term: 'Actions',
    tip: 'Shift rolls to a lower strike. ✕ deletes tracking only.',
    desc: 'Shift rolls to a lower strike as two real market legs (buy this one back, then sell the lower one). ✕ only deletes the tracking row — it does NOT close the position.',
  },
];

/** Short, one-sentence tooltip text for a header — `tip` when set, else
 *  `desc`. Returns undefined for an undocumented column so the header simply
 *  has no tooltip rather than an empty one. The full formula + explanation
 *  stays in the glossary modal only. */
export function columnTip(columns: ColumnDoc[], term: string): string | undefined {
  const entry = columns.find((c) => c.term === term);
  if (!entry) return undefined;
  return entry.tip ?? entry.desc;
}
