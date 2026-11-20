'use client';

import { useEffect, useRef } from 'react';
import { emaArray } from '@/lib/indicators';
import type { GbState } from '@/lib/gearbox';

// The game's side-scrolling road: the road is the signal future's closes (EMA 8 smoothed), the fog hides the future, the sky follows
// the mode, and the car carries a LONG / SHORT flag while this page holds a leg. Colours are the --gb-* tokens in app/globals.css,
// read through getComputedStyle (re-read when the theme flips). It draws at most 10 frames a second, never while the tab is hidden,
// and freezes (one redraw per data change) while paused.

type Rgb = [number, number, number];
type Pal = { s0: Rgb; s1: Rgb; m0: Rgb; m1: Rgb; g: Rgb; d: Rgb };
type Colors = {
  pal: Record<'1' | '-1' | '0', Pal>; road: string; line: string; fog: Rgb; fogText: string; sun: string; car: string; glass: string;
  wheel: string; hub: string; smoke: Rgb; long: string; short: string; flagText: string; head: string; tail: string; blink: string; pole: string; shadow: Rgb; shine: Rgb;
};

const FPS_MS = 100;

function parseColor(s: string): Rgb {
  const v = s.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (m) { const p = m[1].split(/[ ,/]+/).map(Number); return [p[0] || 0, p[1] || 0, p[2] || 0]; }
  return [128, 128, 128];
}
const rgb = (c: Rgb, a = 1) => `rgba(${c.map(Math.round).join(',')},${a})`;

function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(`--gb-${n}`).trim() || 'gray';
  const c = (n: string) => parseColor(v(n));
  const pal = (m: string): Pal => ({ s0: c(`sky-${m}-0`), s1: c(`sky-${m}-1`), m0: c(`hill-${m}-0`), m1: c(`hill-${m}-1`), g: c(`ground-${m}`), d: c(`dirt-${m}`) });
  return {
    pal: { 1: pal('up'), '-1': pal('dn'), 0: pal('fog') }, road: v('road'), line: v('road-line'), fog: c('fog'), fogText: v('fog-text'),
    sun: v('sun'), car: v('car'), glass: v('car-glass'), wheel: v('wheel'), hub: v('hub'), smoke: c('smoke'), long: v('flag-long'),
    short: v('flag-short'), flagText: v('flag-text'), head: v('headlight'), tail: v('taillight'), blink: v('blink'), pole: v('pole'), shadow: c('shadow'), shine: c('shine'),
  };
}

export function RoadScene({ states, held, paused }: { states: GbState[]; held: 'LONG' | 'SHORT' | null; paused: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const data = useRef({ states, held, paused });
  const dirty = useRef(true);
  useEffect(() => { data.current = { states, held, paused }; dirty.current = true; }, [states, held, paused]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let W = 0, H = 0, DPR = 1;
    const ro = new ResizeObserver(() => {
      const r = cv.getBoundingClientRect();
      DPR = window.devicePixelRatio || 1; W = r.width; H = r.height; cv.width = W * DPR; cv.height = H * DPR; dirty.current = true;
    });
    ro.observe(cv);
    let C = readColors(cv);
    const mo = new MutationObserver(() => { C = readColors(cv); dirty.current = true; });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    let col: Pal | null = null;
    let pos = -1, camRef = 0, ang = 0, jolt = 0, lastGear = 0, lastN = 0;
    let rd: number[] = [], rdFor: GbState[] | null = null;
    let puffs: { x: number; y: number; r: number; a: number }[] = [];

    const draw = () => {
      const { states: S, held: h, paused: p } = data.current;
      if (!W || !H) return;
      if (S !== rdFor) { rd = S.length ? emaArray(S.map(s => s.c), 8) : []; rdFor = S; }
      const n = S.length;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const s = S[n - 1];
      const tg = C.pal[String(s?.mode ?? 0) as '0'];
      if (!col) col = JSON.parse(JSON.stringify(tg)) as Pal;
      const ease = p ? 1 : 0.15;
      for (const k of Object.keys(col) as (keyof Pal)[]) for (let j = 0; j < 3; j++) col[k][j] += (tg[k][j] - col[k][j]) * ease;
      // sky
      let g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgb(col.s0)); g.addColorStop(1, rgb(col.s1)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (!n) {
        ctx.fillStyle = C.fogText; ctx.font = '600 13px Inter, sans-serif'; ctx.fillText('waiting for the road…', 16, H / 2);
        return;
      }
      const known = n - 1;
      if (n !== lastN) { if (pos < 0 || n < lastN) pos = known; lastN = n; }
      pos = p ? known : pos + (known - pos) * 0.25;
      if (s.gear !== lastGear) { jolt = s.gear > lastGear ? -1 : 1; lastGear = s.gear; }
      const dx = Math.max(7, Math.min(13, W / 75)), carX = W * 0.6, baseY = H * 0.62, sc = H * 0.28;
      const i0 = Math.max(0, Math.min(known, Math.floor(pos))), f = Math.min(1, pos - i0);
      const R = (k: number) => rd[Math.max(0, Math.min(known, k))];
      const target = R(i0) + (R(i0 + 1) - R(i0)) * f;
      camRef = camRef ? camRef + (target - camRef) * (p ? 1 : 0.2) : target;
      const X = (k: number) => carX + (k - pos) * dx, Y = (k: number) => baseY - (R(k) / camRef - 1) * 100 * sc;
      if (s.mode === 1) { ctx.fillStyle = C.sun; ctx.beginPath(); ctx.arc(W * 0.82, H * 0.18, Math.min(28, H * 0.07), 0, 7); ctx.fill(); }
      const off = pos * dx;
      ([[col.m0, 0.12, 0.45, 0.32], [col.m1, 0.3, 0.58, 0.22]] as [Rgb, number, number, number][]).forEach(([c, par, yb, amp]) => {
        ctx.fillStyle = rgb(c); ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W + 10; x += 10) { const u = (x + off * par) / W; ctx.lineTo(x, H * yb - H * amp * (0.5 + 0.3 * Math.sin(u * 5.1) + 0.2 * Math.sin(u * 13.7 + 1))); }
        ctx.lineTo(W, H); ctx.fill();
      });
      const kA = Math.max(0, Math.floor(pos - carX / dx) - 2);
      ctx.beginPath(); ctx.moveTo(X(kA), H);
      for (let k = kA; k <= known; k++) ctx.lineTo(X(k), Y(k));
      ctx.lineTo(W + 20, Y(known)); ctx.lineTo(W + 20, H); ctx.closePath();
      g = ctx.createLinearGradient(0, baseY - 40, 0, H);
      g.addColorStop(0, rgb(col.g)); g.addColorStop(0.25, rgb(col.d)); g.addColorStop(1, rgb(col.d.map(v => v * 0.6) as Rgb)); ctx.fillStyle = g; ctx.fill();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const road = () => { ctx.beginPath(); for (let k = kA; k <= known; k++) { if (k === kA) ctx.moveTo(X(k), Y(k)); else ctx.lineTo(X(k), Y(k)); } ctx.lineTo(W + 20, Y(known)); };
      road(); ctx.strokeStyle = C.road; ctx.lineWidth = 12; ctx.stroke();
      road(); ctx.strokeStyle = C.line; ctx.lineWidth = 1.6; ctx.setLineDash([10, 12]); ctx.lineDashOffset = off; ctx.stroke(); ctx.setLineDash([]);
      // fog over the future
      const fx = X(known) + 6;
      g = ctx.createLinearGradient(fx, 0, fx + Math.min(160, W * 0.3), 0);
      g.addColorStop(0, rgb(C.fog, 0)); g.addColorStop(0.35, rgb(C.fog, 0.85)); g.addColorStop(1, rgb(C.fog, 0.97)); ctx.fillStyle = g; ctx.fillRect(fx, 0, W - fx, H);
      ctx.fillStyle = C.fogText; ctx.font = '600 13px Inter, sans-serif'; ctx.fillText('fog: future unknown', Math.min(W - 140, fx + 30), Y(known) - 34);
      // car
      const cy = Y(i0) + (Y(i0 + 1) - Y(i0)) * f;
      const back = Math.max(kA, i0 - 2);
      const tgA = Math.atan2(Y(i0 + 1) - Y(back), dx * (i0 + 1 - back));
      ang += (Math.max(-0.6, Math.min(0.6, tgA)) - ang) * (p ? 1 : 0.3); jolt *= 0.8;
      if (!p && Math.random() < (s.rpm > 2 ? 0.5 : s.gear >= 4 ? 0.25 : 0.08)) puffs.push({ x: carX - 36 * Math.cos(ang), y: cy - 12 - 36 * Math.sin(ang), r: 3, a: 0.5 });
      if (!p) puffs = puffs.filter(q => (q.x -= 3, q.y -= 1, q.r += 0.6, q.a -= 0.03) > 0);
      for (const q of puffs) { ctx.fillStyle = rgb(C.smoke, q.a); ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.fill(); }
      ctx.save(); ctx.translate(carX, cy - 5); ctx.rotate(ang + jolt * 0.05);
      if (s.gear >= 4) {
        ctx.strokeStyle = rgb(C.smoke, 0.55); ctx.lineWidth = 2;
        for (let j = 0; j < 3; j++) { const L = 14 + s.gear * 4; ctx.beginPath(); ctx.moveTo(-44 - j * 4, -14 - j * 7); ctx.lineTo(-44 - j * 4 - L, -14 - j * 7); ctx.stroke(); }
      }
      ctx.fillStyle = rgb(C.shadow, 0.25); ctx.beginPath(); ctx.ellipse(0, 3, 38, 4, 0, 0, 7); ctx.fill();
      ctx.fillStyle = C.car; ctx.beginPath(); ctx.moveTo(-36, -8); ctx.lineTo(-36, -19); ctx.quadraticCurveTo(-35, -24, -27, -24); ctx.lineTo(-14, -24);
      ctx.lineTo(-4, -35); ctx.lineTo(15, -35); ctx.lineTo(26, -24); ctx.lineTo(33, -22); ctx.quadraticCurveTo(38, -20, 38, -14); ctx.lineTo(38, -8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = rgb(C.shine, 0.25); ctx.fillRect(-34, -22, 70, 3);
      ctx.fillStyle = C.glass; ctx.beginPath(); ctx.moveTo(-11, -25); ctx.lineTo(-2, -32); ctx.lineTo(4, -32); ctx.lineTo(4, -25); ctx.closePath();
      ctx.moveTo(7, -25); ctx.lineTo(7, -32); ctx.lineTo(13, -32); ctx.lineTo(22, -25); ctx.closePath(); ctx.fill();
      const blink = s.mode === 0 && Math.floor(performance.now() / 400) % 2 === 1;
      ctx.fillStyle = blink ? C.blink : C.head; ctx.fillRect(34, -19, 4, 4); ctx.fillStyle = blink ? C.blink : C.tail; ctx.fillRect(-36, -19, 3, 5);
      if (s.mode === -1) {
        const hl = parseColor(C.head);
        g = ctx.createLinearGradient(38, 0, 110, 0); g.addColorStop(0, rgb(hl, 0.5)); g.addColorStop(1, rgb(hl, 0)); ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(38, -18); ctx.lineTo(110, -30); ctx.lineTo(110, 0); ctx.fill();
      }
      const rot = (pos * dx) / 7;
      for (const wx of [-21, 22]) {
        ctx.save(); ctx.translate(wx, -6); ctx.fillStyle = C.wheel; ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7); ctx.fill();
        ctx.fillStyle = C.hub; ctx.beginPath(); ctx.arc(0, 0, 4, 0, 7); ctx.fill();
        ctx.rotate(rot); ctx.strokeStyle = C.wheel; ctx.lineWidth = 1.5;
        for (let j = 0; j < 3; j++) { ctx.rotate(2.09); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(4, 0); ctx.stroke(); }
        ctx.restore();
      }
      if (h) {
        ctx.strokeStyle = C.pole; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(5, -35); ctx.lineTo(5, -58); ctx.stroke();
        ctx.fillStyle = h === 'LONG' ? C.long : C.short; ctx.fillRect(5, -58, 44, 15);
        ctx.fillStyle = C.flagText; ctx.font = '700 11px Inter, sans-serif'; ctx.fillText(h, 9, -47);
      }
      ctx.restore();
    };

    const id = setInterval(() => {
      if (document.hidden) return;
      if (data.current.paused && !dirty.current) return;
      dirty.current = false;
      draw();
    }, FPS_MS);
    return () => { clearInterval(id); ro.disconnect(); mo.disconnect(); };
  }, []);

  return <canvas ref={ref} className="absolute inset-0 block h-full w-full" aria-label="Road scene: the signal future as a road, fog over the future" role="img" />;
}
