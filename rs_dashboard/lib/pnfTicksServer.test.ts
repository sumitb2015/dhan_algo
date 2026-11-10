import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readTickFile, rowsBetween } from './pnfTicksServer.ts';
import { istDateIso } from './nseHolidays.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pnf-ticks-'));

test('reads only complete lines, then only the new bytes; a shrunk file is read again', () => {
  const dir = tmp();
  const f = path.join(dir, 'IDX_I_13.jsonl');
  fs.writeFileSync(f, '[1000, 100.5, 0]\n[2000, 101, 0]\n[3000, 10');
  assert.deepEqual(readTickFile(f), [[1000, 100.5, 0], [2000, 101, 0]]);
  fs.appendFileSync(f, '2, 7]\nnot json\n[4000, 103]\n');
  assert.deepEqual(readTickFile(f), [[1000, 100.5, 0], [2000, 101, 0], [3000, 102, 7], [4000, 103, 0]]);
  fs.writeFileSync(f, '[5000, 99, 0]\n');
  assert.deepEqual(readTickFile(f), [[5000, 99, 0]]);
  assert.deepEqual(readTickFile(path.join(dir, 'missing.jsonl')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rowsBetween: after since, up to upTo (inclusive)', () => {
  const rows: [number, number, number][] = [[1000, 1, 0], [2000, 2, 0], [3000, 3, 0], [4000, 4, 0]];
  assert.deepEqual(rowsBetween(rows, 0, 2500).map(r => r[1]), [1, 2]);
  assert.deepEqual(rowsBetween(rows, 2000, 4000).map(r => r[1]), [3, 4]);
  assert.deepEqual(rowsBetween(rows, 4000, 9000), []);
});

test('the log folder is the IST day', () => {
  assert.equal(istDateIso(Date.UTC(2026, 10, 5, 18, 29)), '2026-11-05');   // 23:59 IST
  assert.equal(istDateIso(Date.UTC(2026, 10, 5, 18, 31)), '2026-11-06');   // 00:01 IST
});
