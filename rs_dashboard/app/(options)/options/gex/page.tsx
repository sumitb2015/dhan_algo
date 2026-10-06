import fs from 'fs';
import path from 'path';
import GexOiPage from '@/components/GexOiPage';

export const metadata = { title: 'GEX OI Chart' };

// Read per request so an edit to the guide shows up without a rebuild.
export const dynamic = 'force-dynamic';

// The in-app guide renders the same file that lives in the repo docs, so the two cannot drift.
function readGuide(): string {
  try {
    return fs.readFileSync(path.join(path.resolve(process.cwd(), '..'), 'docs', 'GEX_OI_GUIDE.md'), 'utf8');
  } catch {
    return '';
  }
}

export default function Page() {
  return <GexOiPage guide={readGuide()} />;
}
