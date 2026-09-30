import { readFileSync } from 'fs';
import path from 'path';
import type { Metadata } from 'next';
import OptionsScreener from '@/components/OptionsScreener';

export const metadata: Metadata = {
  title: 'Options Screener',
};

// The in-page "How to use" guide is this folder's README.md.
function readHelp(): string {
  try {
    return readFileSync(path.join(process.cwd(), 'app', 'options-screener', 'README.md'), 'utf8');
  } catch {
    return '';
  }
}

export default function OptionsScreenerPage() {
  return <OptionsScreener helpMarkdown={readHelp()} />;
}
