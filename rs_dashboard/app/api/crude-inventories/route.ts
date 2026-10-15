import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { PROJECT_ROOT, dedupe, runPythonJson } from '@/lib/pyExec';
import type { InventoryFile } from '@/lib/crudeInventory';

// Weekly US crude inventories (EIA) + Investing.com consensus, for /crude-inventories.
// GET reads the cache written by scripts/tools/crude_inventory_fetch.py; POST re-runs that
// script (~15 s: nine EIA workbooks + two Firecrawl scrapes). Read-only, no orders.

const DATA_FILE = path.join(PROJECT_ROOT, 'debug', 'crude_inventory.json');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'crude_inventory_fetch.py');

async function readCache(): Promise<InventoryFile | null> {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf-8')) as InventoryFile;
  } catch {
    return null;
  }
}

export async function GET() {
  const data = await readCache();
  return NextResponse.json({ data });
}

interface FetchResult { ok: boolean; error?: string; errors?: string[] }

export async function POST() {
  try {
    // Concurrent clicks / tabs share one spawn.
    const res = await dedupe('crude-inventory-fetch', () =>
      runPythonJson<FetchResult>(SCRIPT, [], 120_000));
    if (!res.ok) return NextResponse.json({ error: res.error ?? 'fetch failed' }, { status: 502 });
    return NextResponse.json({ data: await readCache(), errors: res.errors ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A failed run keeps the previous cache on disk; hand it back alongside the error.
    return NextResponse.json({ error: msg.slice(0, 500), data: await readCache() }, { status: 502 });
  }
}
