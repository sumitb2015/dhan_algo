import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

/** Minimal CSV parser that handles quoted fields containing commas */
function parseCSV(content: string): { columns: string[]; rows: Record<string, string | number | null>[] } {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 1) return { columns: [], rows: [] };

  function parseLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim()); current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  const columns = parseLine(lines[0]);
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const values = parseLine(line);
    const obj: Record<string, string | number | null> = {};
    columns.forEach((col, i) => {
      const raw = values[i] ?? '';
      if (raw === '' || raw === 'None' || raw === 'nan' || raw === 'NaN') {
        obj[col] = null;
      } else {
        const num = Number(raw);
        obj[col] = isNaN(num) ? raw : num;
      }
    });
    return obj;
  });

  return { columns, rows };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const file = url.searchParams.get('file');

  if (!file) {
    return NextResponse.json({ error: 'file parameter required' }, { status: 400 });
  }

  const normalised = file.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (
    normalised.includes('..') ||
    !normalised.startsWith('reports/') ||
    !normalised.endsWith('.csv')
  ) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const absPath = path.join(PROJECT_ROOT, normalised);
  if (!fs.existsSync(absPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const content = fs.readFileSync(absPath, 'utf-8');
  const { columns, rows } = parseCSV(content);

  return NextResponse.json({ success: true, columns, rows, total: rows.length });
}
