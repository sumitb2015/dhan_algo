import test from 'node:test';
import assert from 'node:assert/strict';
import { isNseSessionDay, isNseTradingDay, isRegularSession, muhuratWindow } from './nseHolidays.ts';
import { sessionWindow } from './straddlePnfLive.ts';
import { autoWindow } from './pnfAuto.ts';

const at = (iso: string, hh: number, mm: number) => Date.parse(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`) / 1000;

test('2026-11-08 (a Sunday) is a live Muhurat session 14:20-15:30, not a regular day', () => {
  assert.equal(isNseTradingDay('2026-11-08'), false);
  assert.equal(isNseSessionDay('2026-11-08'), true);
  assert.equal(isRegularSession('2026-11-08'), false);
  assert.deepEqual(muhuratWindow('2026-11-08'), [14 * 60 + 20, 15 * 60 + 30]);
  assert.equal(isNseSessionDay('2026-11-07'), false);                 // an ordinary Saturday stays closed
});

test('the Muhurat window replaces the 09:15 session for AUTO', () => {
  const t = at('2026-11-08', 14, 30);
  assert.deepEqual(sessionWindow('NSE', t), [14 * 60 + 20, 15 * 60 + 30]);
  assert.deepEqual(sessionWindow('NSE_FNO', t), [14 * 60 + 20, 15 * 60 + 30]);   // F&O's usual 15:40 close is cut to the session's
  const w = autoWindow('NSE_FNO', t);
  assert.ok(w && w.open === 14 * 60 + 20 && w.eodExit <= 15 * 60 + 30 && w.entryCutoff > w.open);
  assert.equal(autoWindow('NSE_FNO', at('2026-11-07', 10, 0)), null);
});
