'use client';

import { useState } from 'react';
import PriceLadder from './PriceLadder';

/** Two ladders to start with — ATM call and ATM put. Close ladder 2 leaves one; "Add ladder" brings the second back (at most two). */
export default function PriceLadderWorkspace() {
  const [dual, setDual] = useState(true);
  if (!dual) return <PriceLadder onAddLadder={() => setDual(true)} />;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-zinc-800 min-h-screen bg-zinc-950">
      <PriceLadder ladderId={1} dual />
      <PriceLadder ladderId={2} dual onRemoveLadder={() => setDual(false)} />
    </div>
  );
}
