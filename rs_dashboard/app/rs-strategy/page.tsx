import fs from 'fs';
import path from 'path';
import type { Metadata } from 'next';
import RsStrategyPage from '@/components/RsStrategyPage';

export const metadata: Metadata = {
  title: 'RS Strategy',
  description: 'Nifty 500 relative strength (55) vs Nifty with Supertrend (10,2) buy and sell signals.',
};

// Read per request so an edit to the guide shows up without a rebuild.
export const dynamic = 'force-dynamic';

// The in-app guide renders the same file that lives in the repo docs, so the two cannot drift.
function readGuide(): string {
  try {
    return fs.readFileSync(path.join(path.resolve(process.cwd(), '..'), 'docs', 'RS_STRATEGY_GUIDE.md'), 'utf8');
  } catch {
    return '';
  }
}

export default function Page() {
  return <RsStrategyPage guide={readGuide()} />;
}
