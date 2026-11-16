'use client';

/**
 * Canvas TPO chart: profiles laid out left to right on one shared price axis.
 *
 * Canvas, not SVG: a 50-session view is ~20k lettered cells, which SVG renders as 20k DOM
 * nodes. Colours come from the theme hooks because canvas cannot read CSS variables per
 * draw call; the saturated period colours are data colours and stay fixed across themes.
 *
 * Interaction: wheel = vertical zoom (row height), Shift + wheel = horizontal zoom (cell
 * width), drag = pan, click = select a profile, double-click = fit.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChartChrome } from '@/lib/chartTheme';
import { tpoLetter, type NakedPoc, type PowerDegree, type Profile } from '@/lib/marketProfile';

export type TpoStyle = 'letters' | 'blocks' | 'histogram';

export interface TpoOverlays {
  ib: boolean;
  va: boolean;
  singles: boolean;
  nakedPoc: boolean;
  prevVa: boolean;
  vpoc: boolean;
  stats: boolean;
}

export interface ProfileNote {
  /** Text under the profile on the time axis ("Mon 16 Nov", "W47", "Nov 2026"). */
  label: string;
  dayType: string | null;
  power: PowerDegree | null;
}

interface Props {
  profiles: Profile[];
  notes: Map<string, ProfileNote>;
  nPocs: NakedPoc[];
  style: TpoStyle;
  show: TpoOverlays;
  lastPrice: number | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** The chart re-fits (zoom + scroll to the latest profile) whenever this changes. */
  fitKey: string;
}

const PAD_TOP = 18;
const AXIS_W = 70;
const X_AXIS_H = 22;
const GAP = 34;
const IB_W = 4;
const LEFT_GUTTER = 14; // IB bar + single-print stripe + open marker
const RIGHT_GUTTER = 46; // close marker + VA labels
const MAX_PROFILE_W = 340;
const STATS_LINE_H = 12;

/** Saturated period colours — data colours, legible in all three themes. */
function markColor(i: number, alpha: number): string {
  const hue = (205 + i * 23) % 360;
  return `hsla(${hue}, 62%, 46%, ${alpha})`;
}

const POC_RED = '#ef4444';
const POC_CELL = 'hsla(0, 68%, 40%, 0.95)';
const IB_SKY = '#38bdf8';
const VA_VIOLET = '#a78bfa';
const NPOC_AMBER = '#f59e0b';
const SINGLE_AMBER = '#fbbf24';
const TAIL_SELL = '#f87171';
const TAIL_BUY = '#34d399';

function decimalsFor(rowSize: number): number {
  if (rowSize >= 1 && Number.isInteger(rowSize)) return 0;
  if (rowSize >= 0.1) return 1;
  return 2;
}

interface Layout {
  key: string;
  x: number; // content-space left edge
  w: number;
  cw: number; // cell width
  maxCount: number;
}

interface Hover {
  x: number;
  y: number;
  /** Canvas width at hit time, to keep the tooltip inside the chart. */
  w: number;
  profile: Profile;
  rowIndex: number;
}

export default function TpoChart({
  profiles, notes, nPocs, style, show, lastPrice, selectedKey, onSelect, fitKey,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chrome = useChartChrome();
  const [hover, setHover] = useState<Hover | null>(null);

  // View state lives in a ref: pan/zoom redraws must not re-render React.
  const view = useRef({ rowH: 10, cellW: 9, offsetX: 0, topPrice: 0, fitted: '' });
  const size = useRef({ w: 0, h: 0 });

  const rowSize = profiles[0]?.rowSize ?? 1;
  const dec = decimalsFor(rowSize);
  const fmt = useCallback((p: number) => p.toFixed(dec), [dec]);

  const layoutFor = useCallback((cellW: number): Layout[] => {
    let x = 8;
    return profiles.map((p) => {
      const maxCount = Math.max(1, ...p.rows.map((r) => r.marks.length));
      const cw = Math.min(cellW, MAX_PROFILE_W / maxCount);
      const w = LEFT_GUTTER + maxCount * cw + RIGHT_GUTTER;
      const l = { key: p.key, x, w, cw, maxCount };
      x += w + GAP;
      return l;
    });
  }, [profiles]);

  const statsLines = useCallback((p: Profile): { text: string; color?: string }[] => {
    const note = notes.get(p.key);
    const lines: { text: string; color?: string }[] = [];
    if (p.ibHigh !== null && p.ibLow !== null) {
      lines.push({ text: `IBR ${(p.ibHigh - p.ibLow).toFixed(dec === 0 ? 1 : dec)}` });
    }
    lines.push({ text: `POC ${fmt(p.poc)}`, color: POC_RED });
    if (p.ibHigh !== null && p.ibLow !== null) {
      lines.push({ text: `IB ${fmt(p.ibHigh)}▲ ${fmt(p.ibLow)}▼`, color: IB_SKY });
    }
    lines.push({ text: `VA ${fmt(p.vah)}▲ ${fmt(p.val)}▼`, color: VA_VIOLET });
    if (note?.dayType) lines.push({ text: note.dayType });
    if (note?.power && note.power.side !== 'balanced') {
      lines.push({
        text: `${note.power.side === 'bullish' ? 'Bull' : 'Bear'} power ${note.power.degree}/6`,
        color: note.power.side === 'bullish' ? TAIL_BUY : TAIL_SELL,
      });
    }
    const flags = [p.poorHigh && 'Poor high', p.poorLow && 'Poor low'].filter(Boolean).join(' · ');
    if (flags) lines.push({ text: flags, color: NPOC_AMBER });
    if (p.kind !== 'day') lines.push({ text: `${p.days.length} sessions` });
    return lines;
  }, [notes, fmt, dec]);

  const fit = useCallback(() => {
    const { w, h } = size.current;
    if (!w || !h || profiles.length === 0) return;
    const v = view.current;
    v.cellW = profiles[0].kind === 'day' ? 9 : 4;
    const layout = layoutFor(v.cellW);
    const plotW = w - AXIS_W;
    // Fit vertically on the profiles that will be on screen once scrolled to the right end.
    const contentW = layout.length ? layout[layout.length - 1].x + layout[layout.length - 1].w + 16 : 0;
    v.offsetX = Math.max(0, contentW - plotW);
    const visible = profiles.filter((_, i) => layout[i].x + layout[i].w >= v.offsetX);
    const hi = Math.max(...visible.map((p) => p.high));
    const lo = Math.min(...visible.map((p) => p.low));
    const statsH = show.stats ? 9 * STATS_LINE_H : 0;
    const plotH = h - PAD_TOP - X_AXIS_H - statsH - 10;
    const rows = Math.max(1, (hi - lo) / rowSize + 2);
    v.rowH = Math.min(22, Math.max(2, plotH / rows));
    v.topPrice = hi + rowSize * 1.5;
  }, [profiles, layoutFor, rowSize, show.stats]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h } = size.current;
    if (!canvas || !w || !h) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const v = view.current;
    const plotW = w - AXIS_W;
    const plotBottom = h - X_AXIS_H;
    const yOf = (price: number) => PAD_TOP + ((v.topPrice - price) / rowSize) * v.rowH;
    const layout = layoutFor(v.cellW);
    const byKey = new Map(layout.map((l, i) => [l.key, { l, p: profiles[i], i }]));
    const font = (px: number, weight = 500) => `${weight} ${px}px ui-monospace, SFMono-Regular, Menlo, monospace`;

    // ── price grid ──
    const stepRows = Math.max(1, Math.ceil(24 / v.rowH));
    const firstIdx = Math.floor(v.topPrice / rowSize);
    ctx.strokeStyle = chrome.gridline;
    ctx.lineWidth = 1;
    const gridPrices: number[] = [];
    for (let idx = firstIdx; ; idx--) {
      const price = idx * rowSize;
      const y = yOf(price);
      if (y > plotBottom) break;
      if (idx % stepRows !== 0) continue;
      gridPrices.push(price);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(plotW, Math.round(y) + 0.5);
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotBottom);
    ctx.clip();

    const rowGap = v.rowH >= 6 ? 1 : 0;

    // ── profiles ──
    profiles.forEach((p, pi) => {
      const l = layout[pi];
      const x0 = l.x - v.offsetX;
      if (x0 > plotW || x0 + l.w < 0) return;
      const cellsX = x0 + LEFT_GUTTER;
      const isSel = p.key === selectedKey;

      if (isSel) {
        ctx.fillStyle = chrome.gridline;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x0 - 6, 0, l.w + 12, plotBottom);
        ctx.globalAlpha = 1;
      }

      // previous profile's value area, carried across this one
      if (show.prevVa && pi > 0) {
        const prev = profiles[pi - 1];
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = VA_VIOLET;
        ctx.globalAlpha = 0.5;
        for (const price of [prev.vah + rowSize, prev.val]) {
          const y = Math.round(yOf(price)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x0 + l.w, y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }

      const pocRow = p.rows.findIndex((r) => r.price === p.poc);
      const letters = style === 'letters' && l.cw >= 7 && v.rowH >= 9;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(Math.min(11, Math.floor(v.rowH * 0.8)), 600);

      p.rows.forEach((r, ri) => {
        const yTop = yOf(r.price + rowSize);
        if (yTop > plotBottom || yTop + v.rowH < 0) return;
        const inVa = r.price >= p.val && r.price <= p.vah;
        const isPoc = ri === pocRow;
        const hgt = Math.max(1, v.rowH - rowGap);
        if (style === 'histogram') {
          ctx.fillStyle = isPoc ? POC_RED : inVa ? 'hsla(205, 70%, 55%, 0.85)' : 'hsla(205, 40%, 60%, 0.4)';
          ctx.fillRect(cellsX, yTop, r.marks.length * l.cw, hgt);
          return;
        }
        r.marks.forEach((m, mi) => {
          const cx = cellsX + mi * l.cw;
          const alpha = !show.va || inVa ? 0.95 : 0.4;
          ctx.fillStyle = isPoc ? POC_CELL : markColor(m, alpha);
          ctx.fillRect(cx, yTop, Math.max(1, l.cw - (l.cw >= 4 ? 1 : 0)), hgt);
          if (letters) {
            ctx.fillStyle = '#ffffff';
            ctx.fillText(tpoLetter(m), cx + l.cw / 2, yTop + hgt / 2 + 0.5);
          }
        });
      });

      const right = cellsX + l.maxCount * l.cw;

      // POC
      if (pocRow >= 0) {
        const y = yOf(p.poc + rowSize / 2);
        ctx.strokeStyle = POC_RED;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cellsX, y);
        ctx.lineTo(right + 6, y);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // value area edges
      if (show.va) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = VA_VIOLET;
        for (const price of [p.vah + rowSize, p.val]) {
          const y = Math.round(yOf(price)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(cellsX, y);
          ctx.lineTo(right + 6, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = font(9, 700);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = VA_VIOLET;
        ctx.fillText('VAH', right + 8, yOf(p.vah + rowSize));
        ctx.fillText('VAL', right + 8, yOf(p.val));
        ctx.fillStyle = POC_RED;
        ctx.fillText('POC', right + 8, yOf(p.poc + rowSize / 2));
      }

      // initial balance bar
      if (show.ib && p.ibHigh !== null && p.ibLow !== null) {
        const yH = yOf(Math.floor(p.ibHigh / rowSize + 1e-9) * rowSize + rowSize);
        const yL = yOf(Math.floor(p.ibLow / rowSize + 1e-9) * rowSize);
        ctx.fillStyle = IB_SKY;
        ctx.fillRect(x0 + 2, yH, IB_W, Math.max(2, yL - yH));
      }

      // single prints and tails: a stripe between the IB bar and the cells
      if (show.singles) {
        const stripe = (from: number, to: number, color: string) => {
          const yT = yOf(to + rowSize);
          const yB = yOf(from);
          ctx.fillStyle = color;
          ctx.fillRect(cellsX - 4, yT, 2, yB - yT);
        };
        p.singlePrints.forEach((s) => stripe(s.from, s.to, SINGLE_AMBER));
        if (p.sellingTail) stripe(p.sellingTail.from, p.sellingTail.to, TAIL_SELL);
        if (p.buyingTail) stripe(p.buyingTail.from, p.buyingTail.to, TAIL_BUY);
      }

      // open ▸ and ◂ close markers
      ctx.font = font(9, 700);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = chrome.textSecondary;
      const yOpen = yOf(Math.floor(p.open / rowSize + 1e-9) * rowSize + rowSize / 2);
      ctx.textAlign = 'right';
      ctx.fillText('▸', cellsX - 5, yOpen);
      const closeRow = Math.floor(p.close / rowSize + 1e-9) * rowSize;
      const closeMarks = p.rows.find((r) => r.price === closeRow)?.marks.length ?? 0;
      ctx.textAlign = 'left';
      ctx.fillText(p.developing ? '◂ LTP' : '◂ C', cellsX + closeMarks * l.cw + 2, yOf(closeRow + rowSize / 2));

      // volume POC
      if (show.vpoc && p.vpoc !== null) {
        const y = yOf(p.vpoc + rowSize / 2);
        ctx.fillStyle = VA_VIOLET;
        ctx.beginPath();
        ctx.moveTo(right + 30, y - 4);
        ctx.lineTo(right + 34, y);
        ctx.lineTo(right + 30, y + 4);
        ctx.lineTo(right + 26, y);
        ctx.closePath();
        ctx.fill();
      }

      // stats block under the profile's low
      if (show.stats) {
        let y = yOf(p.low - rowSize) + 6;
        ctx.font = font(10, 600);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (const line of statsLines(p)) {
          ctx.fillStyle = line.color ?? chrome.textMuted;
          ctx.fillText(line.text, x0 + 2, y);
          y += STATS_LINE_H;
        }
      }

      if (p.developing) {
        ctx.font = font(9, 800);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = TAIL_BUY;
        ctx.fillText('● LIVE', x0 + 2, yOf(p.high + rowSize) - 4);
      }
    });

    // ── naked POCs: dotted line from the profile to the session that revisited it ──
    if (show.nakedPoc) {
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.font = font(9, 700);
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'right';
      for (const n of nPocs) {
        const src = byKey.get(n.key);
        if (!src) continue;
        const xStart = src.l.x - v.offsetX + LEFT_GUTTER + src.l.maxCount * src.l.cw + 6;
        const end = n.touchedBy ? byKey.get(n.touchedBy) : null;
        const xEnd = end ? end.l.x - v.offsetX + LEFT_GUTTER : plotW;
        if (xEnd < 0 || xStart > plotW) continue;
        const y = Math.round(yOf(n.poc + rowSize / 2)) + 0.5;
        ctx.strokeStyle = NPOC_AMBER;
        ctx.globalAlpha = n.touchedBy ? 0.35 : 0.95;
        ctx.beginPath();
        ctx.moveTo(xStart, y);
        ctx.lineTo(xEnd, y);
        ctx.stroke();
        if (!n.touchedBy) {
          ctx.fillStyle = NPOC_AMBER;
          ctx.fillText(`nPOC ${fmt(n.poc)} · ${notes.get(n.key)?.label ?? n.key}`, plotW - 4, y - 1);
        }
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([]);
    }

    ctx.restore();

    // ── time axis ──
    ctx.fillStyle = chrome.surface;
    ctx.fillRect(0, plotBottom, plotW, X_AXIS_H);
    ctx.strokeStyle = chrome.baseline;
    ctx.beginPath();
    ctx.moveTo(0, plotBottom + 0.5);
    ctx.lineTo(plotW, plotBottom + 0.5);
    ctx.stroke();
    ctx.font = font(10, 600);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    profiles.forEach((p, pi) => {
      const l = layout[pi];
      const x0 = l.x - v.offsetX;
      if (x0 > plotW || x0 + l.w < 0) return;
      ctx.fillStyle = p.key === selectedKey ? chrome.textSecondary : chrome.textMuted;
      ctx.fillText(notes.get(p.key)?.label ?? p.key, Math.max(2, x0), plotBottom + X_AXIS_H / 2);
      if (pi > 0) {
        ctx.strokeStyle = chrome.gridline;
        ctx.beginPath();
        ctx.moveTo(Math.round(x0 - GAP / 2) + 0.5, 0);
        ctx.lineTo(Math.round(x0 - GAP / 2) + 0.5, plotBottom);
        ctx.stroke();
      }
    });

    // ── price axis ──
    ctx.fillStyle = chrome.surface;
    ctx.fillRect(plotW, 0, AXIS_W, h);
    ctx.strokeStyle = chrome.baseline;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, h);
    ctx.stroke();
    ctx.font = font(10, 500);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = chrome.textMuted;
    for (const price of gridPrices) {
      const y = yOf(price);
      if (y < 6 || y > plotBottom - 4) continue;
      ctx.fillText(fmt(price), plotW + 6, y);
    }
    if (lastPrice !== null) {
      const y = yOf(lastPrice);
      if (y > 0 && y < plotBottom) {
        ctx.fillStyle = IB_SKY;
        ctx.fillRect(plotW + 1, y - 8, AXIS_W - 2, 16);
        ctx.fillStyle = '#0f172a';
        ctx.font = font(10, 800);
        ctx.fillText(lastPrice.toFixed(2), plotW + 5, y);
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = IB_SKY;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(plotW, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
    }
  }, [profiles, layoutFor, rowSize, chrome, style, show, selectedKey, statsLines, nPocs, notes, fmt, lastPrice]);

  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);
  const raf = useRef(0);
  const schedule = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => drawRef.current());
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Fit on a new symbol / view / row size, never on a live tick (it would undo the user's zoom).
  useEffect(() => {
    if (profiles.length === 0) return;
    if (view.current.fitted !== fitKey) {
      fit();
      view.current.fitted = fitKey;
    }
    schedule();
  }, [fitKey, profiles, fit, schedule, draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const first = size.current.w === 0;
      size.current = { w: r.width, h: r.height };
      if (first) {
        fit();
        view.current.fitted = fitKey;
      }
      schedule();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit, fitKey, schedule]);

  // ── hit testing ──
  const hitTest = useCallback((x: number, y: number): Hover | null => {
    const v = view.current;
    const layout = layoutFor(v.cellW);
    for (let i = 0; i < layout.length; i++) {
      const l = layout[i];
      const x0 = l.x - v.offsetX;
      if (x < x0 - GAP / 2 || x > x0 + l.w + GAP / 2) continue;
      const p = profiles[i];
      const price = v.topPrice - ((y - PAD_TOP) / v.rowH) * rowSize;
      const idx = Math.floor(price / rowSize + 1e-9);
      const rowIndex = p.rows.findIndex((r) => Math.round(r.price / rowSize) === idx);
      return { x, y, w: size.current.w, profile: p, rowIndex };
    }
    return null;
  }, [layoutFor, profiles, rowSize]);

  // Wheel must be non-passive to stop the page scrolling under the chart.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      if (e.shiftKey) {
        const mx = e.clientX - rect.left + v.offsetX;
        const next = Math.min(18, Math.max(1, v.cellW * factor));
        v.offsetX = Math.max(0, v.offsetX + mx * (next / v.cellW - 1));
        v.cellW = next;
      } else {
        const my = e.clientY - rect.top;
        const priceAtCursor = v.topPrice - ((my - PAD_TOP) / v.rowH) * rowSize;
        const next = Math.min(30, Math.max(1.5, v.rowH * factor));
        v.rowH = next;
        v.topPrice = priceAtCursor + ((my - PAD_TOP) / next) * rowSize;
      }
      schedule();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [rowSize, schedule]);

  const drag = useRef<{ x: number; y: number; offsetX: number; topPrice: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX, y: e.clientY, offsetX: view.current.offsetX, topPrice: view.current.topPrice, moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) {
        const v = view.current;
        v.offsetX = Math.max(0, d.offsetX - dx);
        v.topPrice = d.topPrice + (dy / v.rowH) * rowSize;
        setHover(null);
        schedule();
        return;
      }
    }
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x > rect.width - AXIS_W || y > rect.height - X_AXIS_H) {
      setHover(null);
      return;
    }
    setHover(hitTest(x, y));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const rect = e.currentTarget.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) onSelect(hit.profile.key);
    }
  };
  const onDoubleClick = () => {
    fit();
    schedule();
  };

  const tip = useMemo(() => {
    if (!hover || hover.rowIndex < 0) return null;
    const p = hover.profile;
    const r = p.rows[hover.rowIndex];
    const where = r.price === p.poc ? 'POC' : r.price > p.vah ? 'above value' : r.price < p.val ? 'below value' : 'inside value';
    return { p, r, where };
  }, [hover]);

  return (
    <div ref={wrapRef} className="relative w-full h-full select-none">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-crosshair touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
        aria-label="Market profile TPO chart"
        role="img"
      />
      {tip && hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-zinc-700 bg-zinc-900/95 px-2.5 py-1.5 text-[11px] font-mono text-zinc-200 shadow-lg"
          style={{
            left: Math.min(hover.x + 14, hover.w - 230),
            top: Math.max(4, hover.y - 10),
            maxWidth: 220,
          }}
        >
          <div className="font-bold text-zinc-100">
            {fmt(tip.r.price)} – {fmt(tip.r.price + rowSize)}
          </div>
          <div className="text-zinc-400">{notes.get(tip.p.key)?.label ?? tip.p.key} · {tip.where}</div>
          <div>TPOs {tip.r.marks.length}{tip.r.volume > 0 ? ` · vol ${Math.round(tip.r.volume).toLocaleString('en-IN')}` : ''}</div>
          <div className="break-all text-zinc-300">{tip.r.marks.map(tpoLetter).join('') || '—'}</div>
        </div>
      )}
    </div>
  );
}
