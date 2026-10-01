import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { parseInline, parseMarkdown } from './miniMarkdown.ts';

test('inline: bold, italic, code and plain text keep their order', () => {
  assert.deepEqual(parseInline('a **b** c `d` *e* f'), [
    { t: 'text', v: 'a ' }, { t: 'b', v: 'b' }, { t: 'text', v: ' c ' }, { t: 'code', v: 'd' },
    { t: 'text', v: ' ' }, { t: 'i', v: 'e' }, { t: 'text', v: ' f' },
  ]);
  assert.deepEqual(parseInline('2 * 3 and 4 * 5'), [{ t: 'text', v: '2 * 3 and 4 * 5' }]); // spaced asterisks are not italics
});

test('inline output is data, never HTML: markup in the source stays literal text', () => {
  assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
});

test('blocks: headings, rule, quote, wrapped list items, paragraph joining', () => {
  const b = parseMarkdown('# T\n\npara line one\nline two\n\n---\n\n> note one\n> note two\n\n- a\n  wrapped\n- b\n\n## H2');
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'hr', 'quote', 'ul', 'h']);
  const ul = b[4] as Extract<(typeof b)[number], { t: 'ul' }>;
  assert.equal(ul.items.length, 2);
  assert.deepEqual(ul.items[0], [{ t: 'text', v: 'a wrapped' }]);
  assert.deepEqual((b[1] as { inline: unknown }).inline, [{ t: 'text', v: 'para line one line two' }]);
});

test('tables: header, separator and rows; a paragraph directly after ends the table', () => {
  const b = parseMarkdown('| A | B |\n|---|---|\n| 1 | **2** |\n| 3 | 4 |\n\nafter');
  assert.equal(b[0].t, 'table');
  const t = b[0] as Extract<(typeof b)[number], { t: 'table' }>;
  assert.equal(t.head.length, 2);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0][1], [{ t: 'b', v: '2' }]);
  assert.equal(b[1].t, 'p');
});

test('the real RS guide parses fully: no leftover table pipes, no stray markers, every table column count matches', () => {
  const src = fs.readFileSync(new URL('../../docs/RS_STRATEGY_GUIDE.md', import.meta.url), 'utf8');
  const blocks = parseMarkdown(src);
  assert.ok(blocks.filter((b) => b.t === 'table').length >= 6);
  assert.ok(blocks.filter((b) => b.t === 'h').length >= 8);
  for (const b of blocks) {
    if (b.t === 'table') for (const r of b.rows) assert.equal(r.length, b.head.length, 'ragged table row');
  }
  const text = JSON.stringify(blocks);
  assert.ok(!text.includes('"v":"|'), 'a table was not recognised');
  assert.ok(!/\*\*/.test(text.replace(/"t":"[a-z]+"/g, '')), 'unparsed bold markers remain');
});
