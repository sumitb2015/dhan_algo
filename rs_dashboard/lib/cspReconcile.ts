import type { TrackedCsp } from './cspTracked.ts';

/** What csp_watchlist.py `reconcile` reports for one tracked row. */
export interface CspBrokerRow {
  id: string;
  found: boolean;
  /** Broker net qty on the row's securityId — POOLED across everything on that contract. */
  netQty: number;
  /** Broker average on that contract — pooled too. */
  avgPrice: number;
  productType: string;
  /** The row's OWN order, looked up only for rows still needing reconcile. */
  order?: { status: string; filledQty: number; avgPrice: number } | null;
}

const DEAD = new Set(['REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED']);
/** An order that can't fill any further. Anything else (PENDING, PART_TRADED,
 *  TRANSIT…) may still fill, so its row is not settled yet. */
const isFinal = (status: string) => status === 'TRADED' || DEAD.has(status);

/**
 * Brings OPEN order-backed CSP rows in line with the broker without writing
 * the broker's pooled position numbers into a row (2026-10-01 audit: reconcile
 * set every row's qty and avg to the position's, upward too, and the strike
 * shift then sold `row.qty` — a row sharing a contract could close quantity
 * it never opened).
 *
 * - An unconfirmed row (`needsReconcile`) is settled from its OWN order:
 *   filled qty and traded average — only once that order is final. While it
 *   is still working, the row and its contract are left alone. A dead order
 *   with nothing filled is flagged for deletion, never deleted here.
 * - Quantity only ever comes down. When the broker holds less than the CSP
 *   rows on that contract together, a lone row is cut to the broker's qty;
 *   with several rows, which one was closed is the user's call, so each is
 *   flagged instead. More at the broker than the rows track is reported,
 *   never adopted.
 * - A row keeps its own average. The broker's is used only for a row with
 *   none, and only when that row alone accounts for the broker's whole qty.
 *
 * Mutates and returns `rows` (the caller's fresh read), plus change lines.
 */
export function reconcileCspRows(rows: TrackedCsp[], broker: CspBrokerRow[], now: string): { rows: TrackedCsp[]; changes: string[] } {
  const byId = new Map(broker.map(b => [b.id, b]));
  const changes: string[] = [];
  const label = (r: TrackedCsp) => `${r.symbol} ${r.strike}PE`;

  // 1. Settle unconfirmed rows from their own order first: the group totals below need real qty.
  //    Only once the order is final — a part-filled order still working would
  //    otherwise be settled at its partial qty, and whatever fills later would
  //    never be tracked.
  const working = new Set<string>();
  const dead = new Set<string>();
  for (const row of rows) {
    const b = byId.get(row.id);
    if (!b || row.status !== 'OPEN' || !row.needsReconcile || !b.order) continue;
    const o = b.order;
    const status = o.status.toUpperCase();
    if (!isFinal(status)) {
      if (status) {
        working.add(row.id);
        row.reconcileNote = `Order ${row.orderId ?? ''} still ${status} (${o.filledQty} of ${row.qty} filled) — reconcile again once it completes.`;
        changes.push(`${label(row)}: order still ${status}, ${o.filledQty}/${row.qty} filled`);
      }
      continue;
    }
    if (o.filledQty > 0) {
      if (o.filledQty < row.qty) {
        changes.push(`${label(row)}: qty ${row.qty} → ${o.filledQty} (order filled ${o.filledQty})`);
        row.qty = o.filledQty;
      }
      if (o.avgPrice > 0) {
        if (o.avgPrice !== row.avgPrice) changes.push(`${label(row)}: avg ${row.avgPrice} → ${o.avgPrice} (order's traded average)`);
        row.avgPrice = o.avgPrice;
        delete row.needsReconcile;
      }
    } else if (DEAD.has(status)) {
      dead.add(row.id);
      row.reconcileNote = `Order ${row.orderId ?? ''} ${status} with nothing filled — this row never opened; delete it.`;
      changes.push(`${label(row)}: order ${status}, nothing filled`);
    }
  }

  // 2. Compare each contract's tracked total with the broker's position.
  const groups = new Map<string, TrackedCsp[]>();
  for (const row of rows) {
    if (row.status !== 'OPEN' || !row.securityId || !byId.has(row.id)) continue;
    if (dead.has(row.id)) continue; // dead order, holds nothing
    const g = groups.get(row.securityId) ?? [];
    g.push(row);
    groups.set(row.securityId, g);
  }
  for (const group of groups.values()) {
    // A contract with an order still working is left alone: its qty isn't final.
    if (group.some(r => working.has(r.id))) continue;
    const b = byId.get(group[0].id)!;
    for (const row of group) {
      row.reconciledAt = now;
      if (b.productType && b.productType !== row.productType) row.productType = b.productType;
    }
    if (!b.found || b.netQty >= 0) {
      // Not auto-closed: with no fill price and no exit time, any P&L would be invented.
      for (const row of group) {
        row.reconcileNote = 'Broker reports no open short for this contract — close or delete the row.';
        changes.push(`${label(row)}: broker shows flat`);
      }
      continue;
    }
    const brokerQty = Math.abs(b.netQty);
    const tracked = group.reduce((s, r) => s + r.qty, 0);
    let clearNote = true;
    if (brokerQty < tracked) {
      if (group.length === 1) {
        changes.push(`${label(group[0])}: qty ${group[0].qty} → ${brokerQty} (broker holds less)`);
        group[0].qty = brokerQty;
      } else {
        clearNote = false;
        for (const row of group) {
          row.reconcileNote = `Broker holds ${brokerQty} on this contract but ${group.length} rows track ${tracked} together — something was closed outside the dashboard. Close or edit the row it came from.`;
        }
        changes.push(`${label(group[0])}: ${group.length} rows track ${tracked}, broker holds ${brokerQty} — left for you to attribute`);
      }
    } else if (brokerQty > tracked) {
      changes.push(`${label(group[0])}: broker holds ${brokerQty - tracked} more than tracked rows — not adopted`);
    }
    // Own average wins; the broker's only prices a row with none that is the sole holder.
    for (const row of group) {
      if (row.avgPrice > 0) continue;
      if (group.length === 1 && brokerQty === row.qty && b.avgPrice > 0) {
        changes.push(`${label(row)}: avg 0 → ${b.avgPrice} (broker; sole holder)`);
        row.avgPrice = b.avgPrice;
        delete row.needsReconcile;
      } else {
        clearNote = false;
        row.reconcileNote = 'No entry price yet: the order did not report one and the broker average covers more than this row.';
      }
    }
    if (clearNote) for (const row of group) delete row.reconcileNote;
    for (const row of group) row.updatedAt = new Date().toISOString();
  }
  return { rows, changes };
}
