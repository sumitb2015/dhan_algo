'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LadderBroker } from '@/lib/priceLadder';
import PriceLadder from './PriceLadder';

/** Two ladders to start with — ATM call and ATM put. Close ladder 2 leaves one; "Add ladder" brings the second back (at most two). */
export default function PriceLadderWorkspace() {
  const [dual, setDual] = useState(true);
  // Each ladder's natural header height; both headers are held to the taller so the ladders start at the same height.
  const [heads, setHeads] = useState<[number, number]>([0, 0]);
  const head1 = useCallback((h: number) => setHeads(p => (p[0] === h ? p : [h, p[1]])), []);
  const head2 = useCallback((h: number) => setHeads(p => (p[1] === h ? p : [p[0], h])), []);
  const headMax = Math.max(heads[0], heads[1]);
  // The header's control rows fold away to leave more room for the ladder; one setting for both panes, remembered.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount so the first render matches the server HTML
    try { setCollapsed(localStorage.getItem('price-ladder-head-collapsed') === '1'); } catch { /* none */ }
  }, []);
  const toggleCollapsed = useCallback(() => setCollapsed(c => {
    try { localStorage.setItem('price-ladder-head-collapsed', c ? '0' : '1'); } catch { /* best effort */ }
    return !c;
  }), []);
  const [firstBroker, setFirstBroker] = useState<LadderBroker | null>(null);
  if (!dual) return <PriceLadder onAddLadder={() => setDual(true)} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-zinc-800 min-h-screen bg-zinc-950">
      <PriceLadder ladderId={1} dual onBrokerChange={setFirstBroker} onHeaderHeight={head1} headerMinHeight={headMax} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      <PriceLadder ladderId={2} dual peerBroker={firstBroker} onHeaderHeight={head2} headerMinHeight={headMax} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} onRemoveLadder={() => setDual(false)} />
    </div>
  );
}
