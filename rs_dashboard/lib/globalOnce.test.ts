import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('two module instances (two Next bundles) get the same state object', async () => {
  // A query string makes Node load a second, separate instance of the same file (what two Next bundles are).
  type Mod = typeof import('./globalOnce.ts');
  const spec = './globalOnce.ts';
  const a = (await import(`${spec}?bundle=a`)) as Mod;
  const b = (await import(`${spec}?bundle=b`)) as Mod;
  assert.notEqual(a, b);   // really two instances
  const sa = a.globalOnce('__test_shared', () => ({ hits: 0 }));
  const sb = b.globalOnce('__test_shared', () => ({ hits: 0 }));
  sa.hits++;
  assert.equal(sb.hits, 1);
  assert.equal(sa, sb);
});

test('Fresh Money trade server keeps no throttle or cache in module state (route + exit watcher are two bundles)', () => {
  const src = fs.readFileSync(new URL('./freshMoneyTradeServer.ts', import.meta.url), 'utf8');
  const topLevelMutable = src.split('\n').filter(l => /^let\s/.test(l) || /^const\s+\w+\s*(:[^=]+)?=\s*new\s+(Map|Set)\b/.test(l));
  assert.deepEqual(topLevelMutable, []);
});
