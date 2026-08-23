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
}

export const SCANNER_COLUMNS: ColumnDoc[] = [
  {
    term: 'Symbol',
    desc: 'Underlying stock. Every liquid strike gets its own row, so one symbol normally appears several times at different risk levels — tick "Best per symbol" to collapse to one.',
  },
  {
    term: 'Score',
    formula: 'no-hit×45 + min(ann÷30, 1)×40 + min(OI÷5000, 1)×15',
    desc: 'Heuristic 0–100 blend of safety, return and liquidity. Caps stop one very rich or very liquid strike from swamping the rest. It ranks attractiveness *within* whatever no-hit band you filter to — it is not a risk measure on its own.',
  },
  {
    term: 'LTP',
    desc: 'Live spot price of the underlying at scan time.',
  },
  {
    term: 'Expiry',
    desc: 'Expiry of the contract being sold — the nearest one at least 5 days out.',
  },
  {
    term: 'DTE',
    desc: 'Calendar days to expiry. The scanner picks the nearest expiry at least 5 days out — a 1-day contract has almost no premium left and would distort the yield ranking.',
  },
  {
    term: '1D',
    desc: 'Underlying’s percentage move over the last trading session. A trailing amber * means the daily-history CSV this is computed from hasn\'t refreshed in a few days — treat 1D/5D as stale for that row.',
  },
  {
    term: '5D',
    desc: 'Underlying’s percentage move over the last 5 trading sessions.',
  },
  {
    term: 'Suggested Strike',
    desc: 'The OTM put strike for this row, with its no-hit probability and lot size. Every liquid strike above the scan floor gets its own row, so one symbol usually appears several times at different risk levels.',
  },
  {
    term: 'Yield',
    formula: 'premium ÷ strike',
    desc: 'Premium collected as a percentage of the strike — your return on the cash securing the put, for this contract’s duration only.',
  },
  {
    term: 'Ann.',
    formula: 'yield × (365 ÷ DTE)',
    desc: 'Simple annualised return — yield scaled linearly by calendar days to expiry, not compounded and not trading-day (252) based. Treat it as a run-rate, not a forecast or a CAGR: it extrapolates a ~10-day contract and assumes you keep redeploying at the same rate with no compounding.',
  },
  {
    term: 'Premium',
    formula: 'premium/share × lot size',
    desc: 'Total rupees collected for one lot, with the per-share figure beneath.',
  },
  {
    term: 'No-hit',
    formula: 'N(d₂),  d₂ = [ln(S/K) + (r − σ²/2)T] ÷ σ√T',
    desc: 'Black–Scholes probability the underlying finishes ABOVE the strike at expiry — i.e. the put expires worthless and you keep the whole premium. Uses the chain’s implied volatility and a 6.5% risk-free rate.',
  },
  {
    term: 'Touch',
    formula: 'GBM first-passage probability',
    desc: 'Chance the underlying trades at or below the strike at ANY point before expiry. Always higher than (100 − No-hit), because a stock can dip through the strike and recover. This is the number that reflects how uncomfortable the position is likely to get, even when it ends up expiring worthless.',
  },
  {
    term: 'Capital Req.',
    formula: 'strike × lot size',
    desc: 'Cash to fully secure the put — what you pay if assigned. Your broker will block margin rather than this full amount, so actual margin is lower.',
  },
  {
    term: 'Rationale',
    desc: 'One-line summary of the row: 5-day move, strike and its no-hit probability, premium per share, and how far out of the money the strike sits.',
  },
  {
    term: 'Trade',
    desc: 'Sell places a REAL market order on Dhan and starts tracking the position. Buy is deliberately inert — a cash-secured put is sold, not bought.',
  },
];

export const TRACKED_COLUMNS: ColumnDoc[] = [
  {
    term: 'Symbol',
    desc: 'Underlying of the sold put. ⚠ marks a row the last sync could not price; UNCONFIRMED marks one whose fill was never confirmed, so its quantity and average are what was requested rather than what filled — run Reconcile.',
  },
  {
    term: 'Strike',
    desc: 'Strike of the put you are short. Assignment obliges you to buy the stock at this price.',
  },
  { term: 'Expiry', desc: 'Expiry of the contract.' },
  { term: 'Date', desc: 'Date the position was opened.' },
  { term: 'LTP', desc: 'Live spot of the underlying as of the last Sync. Dashes until you sync.' },
  {
    term: 'Entry Spot',
    desc: 'Spot at the time the position was opened, with the underlying’s drift since then beneath it.',
  },
  {
    term: 'To Strike',
    formula: '(spot − strike) ÷ spot',
    desc: 'Headroom left before the underlying reaches the strike. Negative means the put is in the money.',
  },
  {
    term: 'No-hit',
    formula: 'N(d₂),  d₂ = [ln(S/K) + (r − σ²/2)T] ÷ σ√T',
    desc: 'Probability the put expires worthless, recomputed from the live mark at the last Sync. Omitted rather than shown as 100% when implied volatility or spot is unavailable.',
  },
  {
    term: 'Qty',
    desc: 'Contract quantity — lots × lot size, not lots. Reconcile replaces this with the broker’s own net short, which is what an exit is sized from.',
  },
  {
    term: 'Avg',
    desc: 'Average price the put was sold at, taken from the order’s real traded price. A 0 with an UNCONFIRMED badge means the fill was never confirmed — run Reconcile to pull the broker’s figure.',
  },
  {
    term: 'PE LTP',
    desc: 'Current mark of the put itself, from the last Sync. Blank when the chain could not be priced — the P&L is then left blank rather than assuming zero.',
  },
  {
    term: 'Visual Status',
    desc: 'Where spot currently sits between the sold strike (far left, danger) and the entry spot (far right, safe). Green above two-thirds, amber in the middle, red near the strike.',
  },
  {
    term: 'Current P&L',
    formula: '(avg − PE LTP) × qty',
    desc: 'Open rows mark to the last Sync — a short put profits as the premium decays. Closed and rolled rows show realised P&L. Excludes brokerage, STT and other charges.',
  },
  {
    term: 'Status',
    desc: 'OPEN, CLOSED (bought back), or ROLLED (closed as leg 1 of a Shift, with a new row opened at the lower strike).',
  },
  {
    term: 'Order ID',
    desc: 'Broker order id for the entry. "paper" means a manually tracked row with no linked contract — those cannot be exited or shifted from here.',
  },
  {
    term: 'Actions',
    desc: 'Shift rolls to a lower strike as two real market legs (buy this one back, then sell the lower one). ✕ only deletes the tracking row — it does NOT close the position.',
  },
];

/** Tooltip text for a header: formula first, then the explanation. Returns
 *  undefined for an undocumented column so the header simply has no tooltip
 *  rather than an empty one. */
export function columnTip(columns: ColumnDoc[], term: string): string | undefined {
  const entry = columns.find((c) => c.term === term);
  if (!entry) return undefined;
  return entry.formula ? `${entry.formula}\n\n${entry.desc}` : entry.desc;
}
