import { readFileSync } from 'fs';
import path from 'path';
import MultiLegFocus from '@/components/MultiLegFocus';

export const metadata = { title: 'Multi-Leg Focus' };

// The in-page "How to use" guide is this folder's README.md.
function readHelp(): string {
  try {
    return readFileSync(path.join(process.cwd(), 'app', 'multi-leg-focus', 'README.md'), 'utf8');
  } catch {
    return '';
  }
}

export default function MultiLegFocusPage() {
  return <MultiLegFocus helpMarkdown={readHelp()} />;
}
