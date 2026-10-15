import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { PROJECT_ROOT, dedupe, runPythonJson } from '@/lib/pyExec';
import type { FiiDiiFile } from '@/lib/fiiDii';

// Daily FII/DII activity (cash market + F&O) for /fii-dii. GET reads the cache written by
// scripts/tools/fii_dii_fetch.py; POST re-runs that script (a few seconds once the F&O backfill
// exists, ~30 s on the first run). Sources are NSE's public reports. Read-only, no orders.

const DATA_FILE = path.join(PROJECT_ROOT, 'debug', 'fii_dii.json');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'fii_dii_fetch.py');

async function readCache(): Promise<FiiDiiFile | null> {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf-8')) as FiiDiiFile;
  } catch {
    return null;
  }
}

export async function GET() {
  return NextResponse.json({ data: await readCache() });
}

interface FetchResult { ok: boolean; error?: string; errors?: string[] }

export async function POST() {
  try {
    // Concurrent clicks / tabs share one spawn.
    const res = await dedupe('fii-dii-fetch', () => runPythonJson<FetchResult>(SCRIPT, [], 180_000));
    if (!res.ok) return NextResponse.json({ error: res.error ?? 'fetch failed', data: await readCache() }, { status: 502 });
    return NextResponse.json({ data: await readCache(), errors: res.errors ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A failed run keeps the previous cache on disk; hand it back alongside the error.
    return NextResponse.json({ error: msg.slice(0, 500), data: await readCache() }, { status: 502 });
  }
}
