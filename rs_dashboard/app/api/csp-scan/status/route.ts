import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { isPidRunning } from '@/lib/processCheck';

const STATUS_FILE = path.join(PROJECT_ROOT, 'debug', 'csp_scan_status.json');

/** Status-only poll — the scan can take ~10 minutes, so the progress poll must
 *  not re-serialise the full results array on every tick. */
export async function GET() {
  let status = null;
  try {
    if (fs.existsSync(STATUS_FILE)) {
      status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    }
  } catch {
    status = null;
  }

  const running = Boolean(status && !status.done && status.pid && isPidRunning(status.pid));
  return NextResponse.json({ success: true, running, status });
}
