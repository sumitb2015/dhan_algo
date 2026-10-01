// Tiny markdown → AST parser for in-app guides (docs/*.md rendered in a side panel).
// Supports only what our guides use: headings, paragraphs, lists, blockquotes, tables, rules and
// **bold** / *italic* / `code` inline. No HTML, no links: output is a data structure the component
// renders as React nodes, so nothing is ever injected as raw HTML.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; v: string }
  | { t: 'i'; v: string }
  | { t: 'code'; v: string };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; inline: Inline[] }
  | { t: 'p'; inline: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'quote'; inline: Inline[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: 'text', v: src.slice(last, i) });
    const tok = m[0];
    if (tok.startsWith('**')) out.push({ t: 'b', v: tok.slice(2, -2) });
    else if (tok.startsWith('`')) out.push({ t: 'code', v: tok.slice(1, -1) });
    else out.push({ t: 'i', v: tok.slice(1, -1) });
    last = i + tok.length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const blank = (l: string) => l.trim() === '';

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, inline: parseInline(h[2].trim()) }); i++; continue; }

    if (/^\s*-{3,}\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }

    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i]).map(parseInline)); i++; }
      blocks.push({ t: 'table', head, rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { parts.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push({ t: 'quote', inline: parseInline(parts.join(' ').trim()) });
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && !blank(lines[i])) {
        if (/^\s*-\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*-\s+/, '').trim());
        else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += ' ' + lines[i].trim(); // wrapped item
        else break;
        i++;
      }
      blocks.push({ t: 'ul', items: items.map(parseInline) });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && !/^(#{1,3}\s|>|\s*-\s+|\s*-{3,}\s*$)/.test(lines[i]) && !(lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i].trim()); i++;
    }
    if (para.length) blocks.push({ t: 'p', inline: parseInline(para.join(' ')) });
  }
  return blocks;
}
