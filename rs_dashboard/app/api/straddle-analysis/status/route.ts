import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const STATUS_FILE = path.join(path.resolve(process.cwd(), '..'), 'debug', 'straddle_analysis_status.json');

export async function GET() {
  if (!fs.existsSync(STATUS_FILE)) {
    return NextResponse.json({ status: 'idle', pct: 0, message: '' });
  }
  try {
    return NextResponse.json(JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')));
  } catch {
    return NextResponse.json({ status: 'idle', pct: 0, message: '' });
  }
}
