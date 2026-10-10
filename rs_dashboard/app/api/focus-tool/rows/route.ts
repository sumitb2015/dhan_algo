import { NextRequest, NextResponse } from 'next/server';
import { readFocusConfig, writeFocusConfig } from '@/lib/focusToolRows';
import { mergeFocusConfigWrite, type FocusConfigWrite } from '@/lib/focusToolRowsMerge';

export async function GET(): Promise<NextResponse> {
  try {
    const config = readFocusConfig();
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[/api/focus-tool/rows GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as FocusConfigWrite;
    let config = readFocusConfig();
    let conflicts: string[] = [];
    let refusedDeletes: string[] = [];

    // Rows merge per row by rev (lib/focusToolRowsMerge.ts): a second or
    // stale tab can no longer roll back other rows' fill ledgers, and a save
    // is never rejected wholesale — at worst one row's same-rev change loses
    // to the stored one and comes back in `conflicts`. Other fields stay
    // last-write-wins, and only when the save carries them.
    // (A single-row `row` upsert used to live here; no caller sent it and, with no rev, it was always
    // reported as a conflict and dropped.)
    ({ config, conflicts, refusedDeletes } = mergeFocusConfigWrite(config, body));

    writeFocusConfig(config);
    return NextResponse.json({ success: true, data: config, conflicts, refusedDeletes });
  } catch (err) {
    console.error('[/api/focus-tool/rows POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const { id } = await req.json() as { id: string };
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const config = readFocusConfig();
    const { config: next, refusedDeletes } = mergeFocusConfigWrite(config, { deleteRowIds: [id] });
    if (refusedDeletes.length) {
      return NextResponse.json({ success: false, error: 'Row still holds a position — exit it first' }, { status: 409 });
    }
    writeFocusConfig(next);
    return NextResponse.json({ success: true, data: next });
  } catch (err) {
    console.error('[/api/focus-tool/rows DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
