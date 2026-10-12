import test from 'node:test';
import assert from 'node:assert/strict';
import { lastNseSessionDate, isNseLive, isNseCashLive } from './marketHours.ts';

// IST = UTC+5:30, so HH:MM IST is Date.UTC(..., HH-5, MM-30).
const ist = (y: number, m: number, d: number, hh: number, mm = 0) => Date.UTC(y, m - 1, d, hh - 5, mm - 30);

test('a trading day from 09:15 IST is its own session, through the evening', () => {
  assert.equal(lastNseSessionDate(ist(2026, 10, 12, 9, 15)), '2026-10-12'); // Mon, the open
  assert.equal(lastNseSessionDate(ist(2026, 10, 12, 11, 0)), '2026-10-12');
  assert.equal(lastNseSessionDate(ist(2026, 10, 12, 20, 32)), '2026-10-12'); // after the close, still today's session
});

test('before the open the data is still the previous session', () => {
  assert.equal(lastNseSessionDate(ist(2026, 10, 12, 9, 14)), '2026-10-09'); // Mon 09:14 -> Fri
  assert.equal(lastNseSessionDate(ist(2026, 10, 13, 8, 0)), '2026-10-12');  // Tue pre-open -> Mon
});

test('weekends map to the Friday', () => {
  assert.equal(lastNseSessionDate(ist(2026, 10, 10, 12, 0)), '2026-10-09'); // Sat
  assert.equal(lastNseSessionDate(ist(2026, 10, 11, 23, 0)), '2026-10-09'); // Sun
});

test('NSE holidays are skipped, including a holiday followed by a weekend', () => {
  // 2026-10-02 (Fri) and 2026-10-20 (Tue) are NSE holidays.
  assert.equal(lastNseSessionDate(ist(2026, 10, 20, 12, 0)), '2026-10-19');  // holiday Tue -> Mon
  assert.equal(lastNseSessionDate(ist(2026, 10, 21, 8, 0)), '2026-10-19');   // Wed pre-open -> Mon (Tue closed)
  assert.equal(lastNseSessionDate(ist(2026, 10, 5, 8, 0)), '2026-10-01');    // Mon pre-open -> Thu (Fri 2 Oct closed, then the weekend)
});

test('uses the IST date, not the UTC one, around midnight', () => {
  // 2026-10-12 19:00 UTC is 00:30 IST on Tue 13th -> pre-open Tuesday -> Monday's session.
  assert.equal(lastNseSessionDate(Date.UTC(2026, 9, 12, 19, 0)), '2026-10-12');
  // 2026-10-12 03:00 UTC is 08:30 IST Monday -> pre-open -> Friday.
  assert.equal(lastNseSessionDate(Date.UTC(2026, 9, 12, 3, 0)), '2026-10-09');
});

test('cash equity is live to 15:30 IST, F&O to 15:40, neither on a weekend or holiday', () => {
  const at = (hh: number, mm: number) => new Date(ist(2026, 10, 12, hh, mm)); // Mon
  assert.equal(isNseCashLive(at(15, 30)), true);
  assert.equal(isNseCashLive(at(15, 31)), false);
  assert.equal(isNseLive(at(15, 31)), true);        // derivatives still trading
  assert.equal(isNseLive(at(15, 40)), true);
  assert.equal(isNseLive(at(15, 41)), false);
  assert.equal(isNseCashLive(at(9, 14)), false);
  assert.equal(isNseCashLive(new Date(ist(2026, 10, 10, 11, 0))), false); // Sat
  assert.equal(isNseCashLive(new Date(ist(2026, 10, 20, 11, 0))), false); // NSE holiday
});
