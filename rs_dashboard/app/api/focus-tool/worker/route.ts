import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

// Worker mode has been removed in favor of a clean, direct in-tab execution model.
// This endpoint remains as a safe stub that ensures any legacy worker files or processes
// are stopped and cleaned up.

const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const STATUS_FILE = path.join(DEBUG_DIR, 'focus_tool_rows_worker_status.json');
const STOP_TRIGGER = path.join(DEBUG_DIR, 'focus_tool_rows_worker_stop.trigger');
const LOCK_FILE = path.join(DEBUG_DIR, 'focus_tool_rows_worker_start.lock');

function cleanupLegacyFiles() {
  try {
    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    if (fs.existsSync(STATUS_FILE)) {
      fs.writeFileSync(STATUS_FILE, JSON.stringify({ status: 'DISABLED', note: 'Worker mode removed — in-tab execution only' }));
    }
  } catch {
    // Ignore cleanup errors
  }
}

export async function GET() {
  cleanupLegacyFiles();
  return NextResponse.json({
    success: true,
    status: {
      status: 'DISABLED',
      note: 'Worker mode removed in favor of in-tab direct execution',
      openRows: 0,
      rows: [],
    },
  });
}

export async function POST(request: NextRequest) {
  cleanupLegacyFiles();
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (action === 'stop') {
    return NextResponse.json({ success: true, message: 'Worker mode is disabled' });
  }

  return NextResponse.json({
    success: true,
    message: 'Worker mode has been removed — all rules execute directly in the browser terminal',
    status: 'DISABLED',
  });
}
