import { test } from 'node:test';
import assert from 'node:assert';
import {
  rowRules, presetRules, duplicateRow, applyPresetPatch, presetBlockedReason, sanitizePreset, upsertPreset,
  removePreset, buildExport, parseImport, rowFromImport, importExpiry, typedRules, ROW_RUNTIME_KEYS, MAX_PRESETS,
  type FocusPreset,
} from './focusToolPresets.ts';
import type { FocusRow } from './focusToolRows.ts';

const base = (o: Partial<FocusRow> = {}): FocusRow => ({
  id: 'ft_base', underlying: 'NIFTY', entryTime: '09:20', exitTime: '15:15', dte: 'Any', expiry: '', strikeMode: 'ATM',
  linked: true, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '', lots: 1, side: 'BOTH', status: 'draft', mode: 'sim',
  levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1', slRupees: '', slMultiplier: '',
  ceSlMultiplier: '1.2', peSlMultiplier: '1.2', slRollStrikes: 0, slToCost: false, reSlMode: 'off', reTgtMode: 'off',
  createdAt: 't0', updatedAt: 't0', ...o,
});

const live = (): FocusRow => base({
  id: 'ft_live', expiry: '2026-10-20', status: 'entered', mode: 'real', rev: 7, lots: 4, ceOffset: 1, peOffset: -2,
  ceSlMultiplier: '1.25', reTgtMode: 'otm', reTgtOtmStrikes: 2, levelHigh: '23300', levelLow: '22900',
  ceTrailSl: { enabled: true, unit: 'pts', every: '5', by: '5' },
  fill: { ts: 'x', ceQty: 260, peQty: 195 } as FocusRow['fill'],
  overallReSlCount: 1, entryMomState: { day: 'd', ref: 1, ce: null, pe: null },
});

test('rowRules drops every runtime key and deep-copies the rest', () => {
  const src = live();
  const r = rowRules(src) as Record<string, unknown>;
  for (const k of ROW_RUNTIME_KEYS) assert.equal(k in r, false, k);
  assert.equal(r.lots, 4);
  assert.deepEqual(r.ceTrailSl, src.ceTrailSl);
  assert.notEqual(r.ceTrailSl, src.ceTrailSl);          // a copy, not the same object
  assert.equal(r.levelHigh, '23300');                    // a row copy keeps the day's levels…
  assert.equal('levelHigh' in presetRules(src), false);  // …a preset does not
});

test('duplicate is a flat SIM draft with its own id, same index and expiry', () => {
  const d = duplicateRow(live(), 'ft_new', 'now');
  assert.equal(d.id, 'ft_new');
  assert.equal(d.mode, 'sim');                           // never inherits REAL
  assert.equal(d.status, 'draft');
  assert.equal(d.fill, undefined);                       // never claims the source's position
  assert.equal(d.rev, undefined);
  assert.equal(d.overallReSlCount, undefined);
  assert.equal(d.underlying, 'NIFTY');
  assert.equal(d.expiry, '2026-10-20');
  assert.equal(d.reTgtOtmStrikes, 2);
  assert.equal(d.levelHigh, '23300');
});

test('applying a preset replaces rules, resets ones it lacks, keeps runtime and levels', () => {
  const row = base({ id: 'r1', mode: 'real', expiry: 'E', levelHigh: '23500', lots: 9, slRupees: '3000', ceTgtPct: '40' });
  const preset = presetRules(base({ lots: 2, ceSlMultiplier: '1.3', reSlMode: 'asap' }));
  const patch = applyPresetPatch(row, base({ id: 'defaults' }), preset);
  const next = { ...row, ...patch };
  assert.equal(next.lots, 2);
  assert.equal(next.ceSlMultiplier, '1.3');
  assert.equal(next.reSlMode, 'asap');
  assert.equal(next.slRupees, '');                       // back to the default, not left at 3000
  assert.equal(next.ceTgtPct, undefined);                // not in the preset or defaults → cleared
  assert.equal(next.id, 'r1');
  assert.equal(next.mode, 'real');
  assert.equal(next.expiry, 'E');
  assert.equal(next.levelHigh, '23500');
  assert.equal('fill' in patch, false);
});

test('a preset never carries runtime fields, even from a hand-edited file', () => {
  const patch = applyPresetPatch(base(), base(), { mode: 'real', fill: { ceQty: 999 }, status: 'entered', lots: 3 } as never);
  assert.equal('mode' in patch, false);
  assert.equal('fill' in patch, false);
  assert.equal('status' in patch, false);
  assert.equal(patch.lots, 3);
});

test('presets apply only to a row that holds nothing and is not mid-cycle', () => {
  assert.equal(presetBlockedReason(base()), null);
  assert.match(presetBlockedReason(base({ status: 'armed' })) ?? '', /disarm/);   // an armed row could enter next tick
  assert.equal(presetBlockedReason(base({ status: 'exited' })), null);
  assert.match(presetBlockedReason(live()) ?? '', /position/);
  assert.match(presetBlockedReason(base({ status: 'entered' })) ?? '', /cycle/);
  assert.match(presetBlockedReason(base({ fill: { cePending: { mode: 'cost' } } } as never)) ?? '', /re-entry/);
});

test('preset list: validate, upsert by name + index (case-insensitive), remove', () => {
  assert.equal(sanitizePreset({ name: '  ', underlying: 'NIFTY', rules: {} }), null);
  assert.equal(sanitizePreset({ name: 'x', underlying: 'DOGE', rules: {} }), null);
  assert.equal(sanitizePreset({ name: 'x', underlying: 'NIFTY', rules: [] }), null);
  const a = sanitizePreset({ name: ' Std  20 ', underlying: 'NIFTY', rules: { lots: 1, fill: {} }, savedAt: '1' }) as FocusPreset;
  assert.equal(a.name, 'Std 20');
  assert.equal('fill' in a.rules, false);
  const b = { ...a, underlying: 'BANKNIFTY' as const };
  let list = upsertPreset(upsertPreset([], a)!, b)!;
  assert.equal(list.length, 2);                          // same name, different index → both kept
  list = upsertPreset(list, { ...a, name: 'STD 20', savedAt: '2' })!;
  assert.equal(list.length, 2);
  assert.equal(list[0].savedAt, '2');
  assert.equal(removePreset(list, { name: 'std 20', underlying: 'NIFTY' }).length, 1);
});

test('a full preset list refuses a NEW name instead of dropping an old preset; replacing still works', () => {
  const full = Array.from({ length: MAX_PRESETS }, (_, i) => sanitizePreset({ name: `p${i}`, underlying: 'NIFTY', rules: {} }) as FocusPreset);
  assert.equal(upsertPreset(full, { ...full[0], name: 'brand new' }), null);
  const replaced = upsertPreset(full, { ...full[50], savedAt: 'later' });
  assert.equal(replaced?.length, MAX_PRESETS);
  assert.equal(replaced?.[0].savedAt, 'later');
});

test('untrusted rules: wrong types fall back to the default, lots and Qty × must be whole numbers in range', () => {
  const r = typedRules({
    lots: 'abc', entryTime: 5, side: 'BOTH', ceLots: 400, peLots: 3, qtyMultiplier: 11, ceTgtPct: '40', linked: 'yes',
  } as never, base()) as Record<string, unknown>;
  assert.equal('lots' in r, false);
  assert.equal('entryTime' in r, false);
  assert.equal('ceLots' in r, false);
  assert.equal('qtyMultiplier' in r, false);
  assert.equal('linked' in r, false);
  assert.equal(r.side, 'BOTH');
  assert.equal(r.peLots, 3);
  assert.equal(r.ceTgtPct, '40');                        // optional rule the defaults do not set: kept
  const row = rowFromImport(base(), { lots: 'abc', qtyMultiplier: 3 } as never);
  assert.equal(row.lots, 1);
  assert.equal(row.qtyMultiplier, 3);
  const patch = applyPresetPatch(base(), base(), { lots: -2 } as never);
  assert.equal(patch.lots, 1);                           // bad preset value → the default, not -2
});

test('export → import round trip: rules come back as new SIM drafts, presets intact', () => {
  const p = sanitizePreset({ name: 'A', underlying: 'NIFTY', rules: { lots: 2 }, savedAt: 's' }) as FocusPreset;
  const exp = buildExport([live()], [p], 'now');
  const text = JSON.stringify(exp);
  assert.equal(text.includes('"fill"'), false);
  assert.equal(text.includes('"real"'), false);
  const back = parseImport(text);
  assert.ok(back.ok);
  if (!back.ok) return;
  assert.equal(back.rows.length, 1);
  assert.equal('levelHigh' in back.rows[0].rules, false); // the day's spot levels are never restored
  assert.equal(back.rows[0].expiry, '2026-10-20');       // the row's own expiry is in the file
  assert.deepEqual(back.presets, [p]);
  const row = rowFromImport(base({ id: 'fresh', expiry: 'E2' }), back.rows[0].rules);
  assert.equal(row.id, 'fresh');
  assert.equal(row.mode, 'sim');
  assert.equal(row.status, 'draft');
  assert.equal(row.expiry, 'E2');
  assert.equal(row.lots, 4);
});

test('import expiry: keep the exported one while listed, else the nearest', () => {
  assert.deepEqual(importExpiry('2026-10-27', ['2026-10-20', '2026-10-27']), { expiry: '2026-10-27', kept: true });
  assert.deepEqual(importExpiry('2026-10-13', ['2026-10-20', '2026-10-27']), { expiry: '2026-10-20', kept: false });
  assert.deepEqual(importExpiry(undefined, ['2026-10-20']), { expiry: '2026-10-20', kept: true });
  assert.deepEqual(importExpiry('2026-10-20', []), { expiry: '', kept: false });
});

test('import rejects foreign or newer files and skips bad entries', () => {
  assert.equal(parseImport('nope').ok, false);
  assert.equal(parseImport('{"kind":"other"}').ok, false);
  assert.equal(parseImport('{"kind":"focus-tool-export","version":99}').ok, false);
  const r = parseImport(JSON.stringify({ kind: 'focus-tool-export', version: 1, rows: [{ underlying: 'X', rules: {} }, { underlying: 'NIFTY', rules: { lots: 1 } }], presets: [{}] }));
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.rows.length, 1); assert.equal(r.skipped, 2); }
});
