// The position ONE chart of the P&F / Renko page owns, when both charts may trade the same contract (e.g. CRUDEOILM futures on a
// 15-pt and an 8-pt Renko, each with its own AUTO). The broker nets the contract into one position (3L + 3L = LONG 6L), so a chart
// must not read that total as its own: its rail chip, entry line and MTM guard would show, and measure, the other chart's lots too.
//
//  - The chart's own AUTO row holds the contract: the position is that row (its side, lots, entry and P&L at the chart's price).
//  - Otherwise: what is left of the contract once every AUTO row on it is taken out (lots opened by hand), or nothing.
// Pure (tested in lib/pnfChartPosition.test.ts).
import type { LadderPosition } from './pnfLadderPosition.ts';
import { heldSide, holdsPosition, isLive, markPnl, pricedKey, type AutoMode, type AutoRow } from './pnfAutoLedger.ts';

/** A row the chart shows as its position: open (adds included), or on its way out (exiting / unknown exit: still held). */
const shownHeld = (r: AutoRow) => holdsPosition(r) || r.state === 'exiting' || r.state === 'unknownExit';

/** Signed lots a live row may have at the broker: its confirmed lots plus a pending add (an entry not yet confirmed counts in full). */
function brokerLots(r: AutoRow): number {
  const pending = (r.adds ?? []).filter(a => a.status === 'pending').reduce((n, a) => n + a.lots, 0);
  return (heldSide(r) === 'BUY' ? 1 : -1) * (r.lots + pending);
}

const signedOf = (p: LadderPosition) => (p.side === 'LONG' ? p.lots : p.side === 'SHORT' ? -p.lots : 0);

export function chartOwnPosition(o: {
  chart: 1 | 2;
  /** The chart's contract (targetKey). */
  tk: string;
  mode: AutoMode;
  broker: string;
  rows: readonly AutoRow[];
  /** The contract's position: REAL = the broker's book (it includes AUTO's lots); PAPER = the page's paper book (it does not). */
  contract: LadderPosition | null;
  /** The chart's live price (a straddle's CE + PE), or null. */
  price: number | null;
}): LadderPosition | null {
  const rows = o.rows.filter(r => isLive(r) && r.mode === o.mode && (o.mode === 'PAPER' || r.broker === o.broker) && pricedKey(r) === o.tk);
  const own = rows.find(r => r.chart === o.chart && shownHeld(r));
  if (own) {
    const side = heldSide(own);
    return {
      side: side === 'BUY' ? 'LONG' : 'SHORT', lots: own.lots, avg: own.traded ? own.traded.entryPremium : own.entryPrice, entryPnl: 0,
      pnl: o.price != null && o.price > 0 ? markPnl(own, o.price) : null,
    };
  }
  const c = o.contract;
  // PAPER AUTO rows live in the AUTO ledger, never in the paper book: the book is all hand lots. No AUTO on the contract: it is as it was.
  if (!c || o.mode === 'PAPER' || rows.length === 0) return c;
  if (c.side === 'MIXED') return null;                                     // a straddle in pieces next to AUTO: not attributable
  const broker = signedOf(c);
  const hand = broker - rows.reduce((n, r) => n + brokerLots(r), 0);
  // Only lots beyond AUTO's, on the broker's own side, are hand lots (a book lagging an AUTO fill reads as flat, never as the other side)
  if (hand === 0 || Math.sign(hand) !== Math.sign(broker)) return null;
  // The broker's average and P&L blend in AUTO's lots: the hand part's are not known.
  return { side: hand > 0 ? 'LONG' : 'SHORT', lots: Math.abs(hand), avg: null, pnl: null };
}
