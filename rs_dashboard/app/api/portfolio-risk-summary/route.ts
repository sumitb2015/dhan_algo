import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DEBUG_DIR = path.join(process.cwd(), '..', 'debug');
const SUMMARY_FILE = path.join(DEBUG_DIR, 'portfolio_risk_summary.json');

export async function GET() {
  try {
    if (!fs.existsSync(SUMMARY_FILE)) {
      return NextResponse.json({ success: true, available: false });
    }
    const data = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf-8'));
    return NextResponse.json({ success: true, available: true, ...data });
  } catch {
    return NextResponse.json({ success: true, available: false });
  }
}
