import fs from 'fs';
import path from 'path';
import { parseResting, rollDay, isOpenOrder, type RestingLedger, type RestingRow } from '@/lib/pnfRestingLedger';
import { istDateIso } from '@/lib/nseHolidays';
import type { PnfScope } from '@/lib/pnfScope';

// The P&F resting-orders ledger file (debug/pnf_resting_state.json), read by the ledger route and by the order route, which
// uses it to refuse a modify / cancel of any broker order id this page did not place for that chart.

export const RESTING_FILE = path.join(path.resolve(process.cwd(), '..'), 'debug', 'pnf_resting_state.json');
/** The Renko page's own resting-orders ledger (lib/pnfScope.ts). */
export const RENKO_RESTING_FILE = path.join(path.resolve(process.cwd(), '..'), 'debug', 'renko_resting_state.json');
export const restingFileFor = (scope: PnfScope) => (scope === 'renko' ? RENKO_RESTING_FILE : RESTING_FILE);

export function readRestingLedger(scope: PnfScope = 'pnf'): RestingLedger {
  let led;
  try { led = parseResting(JSON.parse(fs.readFileSync(restingFileFor(scope), 'utf8'))); } catch { led = parseResting(null); }
  return rollDay(led, istDateIso(Date.now()));
}

/** The working broker-venue row this broker order id belongs to on this chart, or null (not ours / not this chart / finished). */
export function ownedBrokerOrder(scope: PnfScope, broker: string, targetKeyOf: string, orderId: string): RestingRow | null {
  return readRestingLedger(scope).rows.find(r => r.venue === 'broker' && r.broker === broker && r.targetKey === targetKeyOf && r.brokerOrderId === orderId && r.state === 'working') ?? null;
}

/** How many broker-venue orders are still open on this chart (a close should say they remain). */
export function openBrokerOrders(scope: PnfScope, broker: string, targetKeyOf: string): number {
  return readRestingLedger(scope).rows.filter(r => r.venue === 'broker' && r.broker === broker && r.targetKey === targetKeyOf && isOpenOrder(r)).length;
}
