'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LadderBroker } from '@/lib/priceLadder';
import { toast } from 'sonner';
import PriceLadder from './PriceLadder';
import { useCopyTrade } from '@/components/CopyTrade';

/** Two ladders to start with — ATM call and ATM put. Close ladder 2 leaves one; "Add ladder" brings the second back (at most two). */
export default function PriceLadderWorkspace() {
  const [dual, setDual] = useState(true);
  // Each ladder's natural header height; both headers are held to the taller so the ladders start at the same height.
  const [heads, setHeads] = useState<[number, number]>([0, 0]);
  const head1 = useCallback((h: number) => setHeads(p => (p[0] === h ? p : [h, p[1]])), []);
  const head2 = useCallback((h: number) => setHeads(p => (p[1] === h ? p : [p[0], h])), []);
  const [rows, setRows] = useState<[number, number]>([0, 0]);
  const row1 = useCallback((h: number) => setRows(p => (p[0] === h ? p : [h, p[1]])), []);
  const row2 = useCallback((h: number) => setRows(p => (p[1] === h ? p : [p[0], h])), []);
  const rowMax = Math.max(rows[0], rows[1]);
  const [tops, setTops] = useState<[number, number]>([0, 0]);
  const top1 = useCallback((h: number) => setTops(p => (p[0] === h ? p : [h, p[1]])), []);
  const top2 = useCallback((h: number) => setTops(p => (p[1] === h ? p : [p[0], h])), []);
  const topMax = Math.max(tops[0], tops[1]);
  const [banners, setBanners] = useState<[number, number]>([0, 0]);
  const ban1 = useCallback((h: number) => setBanners(p => (p[0] === h ? p : [h, p[1]])), []);
  const ban2 = useCallback((h: number) => setBanners(p => (p[1] === h ? p : [p[0], h])), []);
  const bannerMax = Math.max(banners[0], banners[1]);
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
  // Dhan → Zerodha/Kotak copy trading: one hook (one 3 s poll) for both panes. The bridge is account-wide; ladder 1 shows the
  // ARM control, each ladder shows whether its own trades are copied. Stable notify: the hook's arm() depends on it.
  const notify = useCallback((type: 'success' | 'error', message: string) => { if (type === 'success') toast.success(message); else toast.error(message); }, []);
  const copyTrade = useCopyTrade(notify);
  if (!dual) return <PriceLadder copyTrade={copyTrade} onAddLadder={() => setDual(true)} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-zinc-800 min-h-screen bg-zinc-950">
      <PriceLadder copyTrade={copyTrade} ladderId={1} dual onBrokerChange={setFirstBroker} onHeaderHeight={head1} onRowHeight={row1} rowMinHeight={rowMax} onTopHeight={top1} onBannerHeight={ban1} headerMinHeight={headMax} topMinHeight={topMax} bannerMinHeight={bannerMax} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      <PriceLadder copyTrade={copyTrade} ladderId={2} dual peerBroker={firstBroker} onHeaderHeight={head2} onRowHeight={row2} rowMinHeight={rowMax} onTopHeight={top2} onBannerHeight={ban2} headerMinHeight={headMax} topMinHeight={topMax} bannerMinHeight={bannerMax} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} onRemoveLadder={() => setDual(false)} />
    </div>
  );
}
