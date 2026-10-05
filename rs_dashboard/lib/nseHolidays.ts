/**
 * NSE equity-segment trading holidays (weekdays the exchange is closed).
 *
 * Source: https://www.nseindia.com/resources/exchange-communication-holidays,
 * read 2026-10-05. Weekend-only entries (Mahashivratri 15-Feb-2026, Diwali
 * Laxmi Pujan 08-Nov-2026 with its Muhurat session) are left out — weekends are
 * already non-trading days. A year missing here degrades to weekdays-only, so
 * add the next year's list when NSE publishes it.
 */
export const NSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
  '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02',
  '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
]);
