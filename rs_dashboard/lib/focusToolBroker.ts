/**
 * Which broker account a Focus Tool row's REAL position belongs to.
 *
 * The page trades through ONE broker selector, saved in localStorage and shared by every dashboard page. A REAL row's
 * fill ledger therefore records the broker it opened on (`FocusRowFill.broker`), and every order path refuses a row
 * whose broker is not the page's: exits sized off the wrong account's book read the leg as flat and dropped it from
 * the ledger, leaving the real position with no stop watched. On load the page follows the broker its open rows hold.
 */
import type { FocusRow, FocusRowFill } from './focusToolRows.ts';

export type FocusBroker = NonNullable<FocusRowFill['broker']>;

type RowLike = Pick<FocusRow, 'mode' | 'fill'>;

/** A REAL row holding quantity on either leg (sim rows never touch a broker). */
export function holdsRealPosition(row: RowLike): boolean {
  if (row.mode === 'sim') return false;
  return (Number(row.fill?.ceQty) || 0) > 0 || (Number(row.fill?.peQty) || 0) > 0;
}

/**
 * The broker to record on a fill after a ledger move. Opening from flat stamps the broker the order went to; a move
 * on a held position keeps what was recorded (an add or reduce goes to the same account, the order paths ensure it);
 * flat or sim drops it. A held row recorded before this field existed stays unknown rather than being guessed.
 */
export function nextFillBroker(
  isSim: boolean,
  prev: { ceQty: number; peQty: number; broker?: FocusBroker },
  next: { ceQty: number; peQty: number },
  broker: FocusBroker,
): FocusBroker | undefined {
  if (isSim) return undefined;
  if (!(next.ceQty > 0) && !(next.peQty > 0)) return undefined;
  if (!(prev.ceQty > 0) && !(prev.peQty > 0)) return broker;
  return prev.broker;
}

/** The broker this row's open REAL position is on, when it differs from the page's — else null (ok to trade). */
export function rowBrokerMismatch(row: RowLike, broker: FocusBroker): FocusBroker | null {
  if (!holdsRealPosition(row)) return null;
  const owner = row.fill?.broker;
  return owner && owner !== broker ? owner : null;
}

/**
 * The brokers the open REAL rows sit on. `follow` is the one broker the page must be on — set only when every
 * recorded row agrees; `conflict` is true when rows sit on two brokers (the page then follows none of them, and each
 * mismatched row refuses orders until the user switches).
 */
export function heldBrokers(rows: readonly RowLike[]): { brokers: FocusBroker[]; follow: FocusBroker | null; conflict: boolean } {
  const set = new Set<FocusBroker>();
  for (const r of rows) {
    if (holdsRealPosition(r) && r.fill?.broker) set.add(r.fill.broker);
  }
  const brokers = [...set].sort();
  return { brokers, follow: brokers.length === 1 ? brokers[0] : null, conflict: brokers.length > 1 };
}

/**
 * Whether the broker selector is locked. Any open REAL row locks it (a switch would point its exits at another
 * account) — except while rows sit on two brokers: the selector is then the only way to reach the other rows.
 */
export function brokerSelectorLocked(rows: readonly RowLike[]): boolean {
  if (heldBrokers(rows).conflict) return false;
  return rows.some(holdsRealPosition);
}
