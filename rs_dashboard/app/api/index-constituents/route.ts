import { NextResponse } from 'next/server';
import { readIndexConstituents } from '@/lib/indexConstituents';

// Read-only: NSE index membership (Nifty Bank, Nifty IT, ...) restricted to the Nifty 500 universe,
// for the RS Strategy page's index filter.
export async function GET() {
  try {
    const indices = readIndexConstituents();
    if (indices.length === 0) {
      // An expected state on a fresh checkout, not a server error: 200 so the page can show the message.
      return NextResponse.json({ success: false, error: 'Index lists not downloaded yet. Run: venv/bin/python scripts/download_index_constituents.py' });
    }
    return NextResponse.json({ success: true, data: { indices } });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not read index lists: ${String((e as Error).message ?? e)}` }, { status: 500 });
  }
}
