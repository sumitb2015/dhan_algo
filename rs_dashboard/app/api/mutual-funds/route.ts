import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const MF_FILE = path.join(PROJECT_ROOT, 'debug', 'mutual_funds.json');

export async function GET() {
  try {
    if (!fs.existsSync(MF_FILE)) {
      return NextResponse.json([]);
    }
    const raw = fs.readFileSync(MF_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return NextResponse.json(Array.isArray(data) ? data : []);
  } catch {
    return NextResponse.json([]);
  }
}
