import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// Integrity of the committed NSE lists in index_constituents/ (written by
// scripts/download_index_constituents.py). Catches a half-finished refresh, a mixed-up file, or CSVs
// that never got committed. Reads files directly: the loader itself needs the dashboard's data layer.

const DIR = new URL('../../index_constituents/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', DIR), 'utf8')) as {
  order: string[];
  indices: Record<string, { label: string; file: string; count: number; downloaded: string }>;
};

function symbols(file: string): string[] {
  const lines = fs.readFileSync(new URL(file, DIR), 'utf8').split(/\r?\n/).filter(Boolean);
  const col = lines[0].split(',').map((h) => h.trim()).indexOf('Symbol');
  assert.ok(col >= 0, `${file}: no Symbol column`);
  return lines.slice(1).map((l) => l.split(',')[col].trim()).filter((s) => !s.startsWith('DUMMY'));
}

test('every manifest entry has a CSV whose symbol count matches the manifest and has no duplicates', () => {
  assert.ok(manifest.order.length >= 20, 'expected the full set of lists');
  for (const key of manifest.order) {
    const m = manifest.indices[key];
    assert.ok(m, `${key} missing from manifest.indices`);
    const s = symbols(m.file);
    assert.equal(s.length, m.count, `${m.label}: ${s.length} symbols vs manifest ${m.count}`);
    assert.equal(new Set(s).size, s.length, `${m.label}: duplicate symbols`);
    for (const sym of s) assert.match(sym, /^[A-Z0-9][A-Z0-9&-]*$/, `${m.label}: odd symbol "${sym}"`);
    assert.match(m.downloaded, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('nested NSE indices really nest: Nifty 50 within Nifty 100 within Nifty 200, and Nifty 100 = 50 + Next 50', () => {
  const get = (k: string) => new Set(symbols(manifest.indices[k].file));
  const n50 = get('nifty50'), nx50 = get('niftynext50'), n100 = get('nifty100'), n200 = get('nifty200');
  for (const s of n50) assert.ok(n100.has(s), `${s} in Nifty 50 but not Nifty 100`);
  for (const s of n100) assert.ok(n200.has(s), `${s} in Nifty 100 but not Nifty 200`);
  assert.deepEqual([...n100].sort(), [...new Set([...n50, ...nx50])].sort(), 'Nifty 100 should be Nifty 50 plus Next 50');
});

test('sector indices are sensible: banks are in Nifty Bank, IT names in Nifty IT', () => {
  const bank = new Set(symbols(manifest.indices.niftybank.file));
  const it = new Set(symbols(manifest.indices.niftyit.file));
  for (const s of ['HDFCBANK', 'ICICIBANK', 'SBIN']) assert.ok(bank.has(s), `${s} missing from Nifty Bank`);
  for (const s of ['TCS', 'INFY']) assert.ok(it.has(s), `${s} missing from Nifty IT`);
  assert.ok(!bank.has('TCS') && !it.has('SBIN'), 'a stock appears in the wrong sector index');
});
