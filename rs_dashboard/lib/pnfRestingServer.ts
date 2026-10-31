import fs from 'fs';
import path from 'path';
import { parseResting, rollDay, isOpenOrder, type RestingLedger, type RestingRow } from '@/lib/pnfRestingLedger';
import { istDateIso } from '@/lib/nseHolidays';

// The P&F resting-orders ledger file (debug/pnf_resting_state.json), read by the ledger route and by the order route, which
// uses it to refuse a modify / cancel of any broker order id this page did not place for that chart.

export const RESTING_FILE = path.join(path.resolve(process.cwd(), '..'), 'debug', 'pnf_resting_state.json');

export function readRestingLedger(): RestingLedger {
  let led;
  try { led = parseResting(JSON.parse(fs.readFileSync(RESTING_FILE, 'utf8'))); } catch { led = parseResting(null); }
  return rollDay(led, istDateIso(Date.now()));
}

/** The working broker-venue row this broker order id belongs to on this chart, or null (not ours / not this chart / finished). */
export function ownedBrokerOrder(broker: string, targetKeyOf: string, orderId: string): RestingRow | null {
  return readRestingLedger().rows.find(r => r.venue === 'broker' && r.broker === broker && r.targetKey === targetKeyOf && r.brokerOrderId === orderId && r.state === 'working') ?? null;
}

/** How many broker-venue orders are still open on this chart (a close should say they remain). */
export function openBrokerOrders(broker: string, targetKeyOf: string): number {
  return readRestingLedger().rows.filter(r => r.venue === 'broker' && r.broker === broker && r.targetKey === targetKeyOf && isOpenOrder(r)).length;
}
