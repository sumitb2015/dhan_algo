import { readFileSync } from 'fs';
import path from 'path';
import FocusTool from '@/components/FocusTool';

export const metadata = { title: 'Ultimate Scalper Terminal — Straddles & Strangles' };

// The in-page "Risks & guide" is this folder's README.md.
function readHelp(): string {
  try {
    return readFileSync(path.join(process.cwd(), 'app', 'focus-tool', 'README.md'), 'utf8');
  } catch {
    return '';
  }
}

export default function FocusToolPage() {
  return <FocusTool helpMarkdown={readHelp()} />;
}
