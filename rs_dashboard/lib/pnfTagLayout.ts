// Label placement for the tags drawn at the chart's right edge (resting orders, their planned exits, the open position): tags whose
// levels are closer than `gap` pixels would print over each other, so a cluster is spread to `gap` apart and re-centred on where its
// levels really are. The level lines themselves stay at the true price; only the tag moves. Pure (tested in lib/pnfTagLayout.test.ts).

export interface TagSlot { key: string; /** The y of the level the tag belongs to. */ y: number }

export function layoutTags(items: TagSlot[], gap = 18): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...items].sort((a, b) => a.y - b.y);
  // forward pass: no tag closer than `gap` to the one above it
  const placed = sorted.map(s => s.y);
  for (let i = 1; i < placed.length; i++) if (placed[i] < placed[i - 1] + gap) placed[i] = placed[i - 1] + gap;
  // each cluster (a run that was pushed) is shifted back so its tags straddle their levels instead of all hanging below them
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && placed[end + 1] - placed[end] <= gap + 1e-9 && placed[end + 1] !== sorted[end + 1].y) end++;
    if (end > start) {
      const shift = (placed.slice(start, end + 1).reduce((a, v) => a + v, 0) - sorted.slice(start, end + 1).reduce((a, s) => a + s.y, 0)) / (end - start + 1);
      for (let i = start; i <= end; i++) placed[i] -= shift;
    }
    start = end + 1;
  }
  // the shift can pull the first tag onto the one above the cluster: one more downward pass keeps the gap
  for (let i = 1; i < placed.length; i++) if (placed[i] < placed[i - 1] + gap) placed[i] = placed[i - 1] + gap;
  sorted.forEach((s, i) => out.set(s.key, placed[i]));
  return out;
}
