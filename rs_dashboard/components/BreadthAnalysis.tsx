'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import type { BreadthResponse, IndexStats, BreadthStats } from '@/app/api/breadth/route';
import NavBar from './NavBar';

// ─── Color tokens ─────────────────────────────────────────────────────────────

const C = {
  bg:       '#000000',
  panel:    '#0d1117',
  panelHdr: '#111418',
  border:   '#1e2530',
  amber:    '#ff9800',
  amberDim: '#b36800',
  white:    '#ffffff',
  muted:    '#8b9ab0',
  green:    '#00e676',
  red:      '#ff1744',
  yellow:   '#ffd600',
  blue:     '#2196f3',
  orange:   '#ff6d00',
};

// ─── Regime config ────────────────────────────────────────────────────────────

const REGIME_CONFIG = {
  green:  { text: C.green,  bg: 'rgba(0,230,118,0.08)',  border: 'rgba(0,230,118,0.25)',  label: 'BULL MARKET',    condition: '≥60% stocks above 200d MA',        action: 'Favour long/momentum strategies.' },
  lime:   { text: '#76ff03', bg: 'rgba(118,255,3,0.06)',  border: 'rgba(118,255,3,0.2)',   label: 'CAUTIOUS BULL',  condition: '50–60% stocks above 200d MA',       action: 'Selective longs; avoid low-quality stocks.' },
  yellow: { text: C.yellow, bg: 'rgba(255,214,0,0.07)',  border: 'rgba(255,214,0,0.2)',   label: 'CAUTION / CHOP', condition: '45–50% stocks above 200d MA',       action: 'Ideal for non-directional options (Straddles/Strangles).' },
  orange: { text: C.orange, bg: 'rgba(255,109,0,0.07)',  border: 'rgba(255,109,0,0.2)',   label: 'TRANSITION',     condition: '40–45% stocks above 200d MA',       action: 'Reduce leverage; wait for breakout confirmation.' },
  red:    { text: C.red,    bg: 'rgba(255,23,68,0.07)',  border: 'rgba(255,23,68,0.2)',   label: 'BEAR MARKET',    condition: '<40% stocks above 200d MA',         action: 'Avoid longs; hedge portfolio; favour cash.' },
} as const;

function getRegime(color: BreadthResponse['regimeColor']) {
  return REGIME_CONFIG[color];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function valueColor(n: number): string {
  return n > 0 ? C.green : n < 0 ? C.red : C.muted;
}

function pctToColor(pct: number): string {
  if (pct >= 60) return C.green;
  if (pct >= 50) return '#76ff03';
  if (pct >= 45) return C.yellow;
  if (pct >= 40) return C.orange;
  return C.red;
}

function adxLabel(adx: number | null): { label: string; color: string } {
  if (adx === null) return { label: 'N/A', color: C.muted };
  if (adx >= 40) return { label: 'Strong Trend', color: C.green };
  if (adx >= 25) return { label: 'Trending', color: '#76ff03' };
  if (adx >= 20) return { label: 'Weak Trend', color: C.yellow };
  return { label: 'No Trend / Choppy', color: C.orange };
}

function chopLabel(chop: number | null): { label: string; color: string } {
  if (chop === null) return { label: 'N/A', color: C.muted };
  if (chop < 38.2) return { label: 'Trending', color: C.green };
  if (chop < 61.8) return { label: 'Transitioning', color: C.yellow };
  return { label: 'Choppy', color: C.orange };
}

function trendStateColor(state: string): string {
  if (state === 'Strong Uptrend') return C.green;
  if (state === 'Uptrend') return '#76ff03';
  if (state === 'Above EMA 200') return C.yellow;
  if (state === 'Below EMA 200') return C.orange;
  if (state === 'Downtrend') return C.red;
  return C.muted;
}

function advDecLabel(ratio: number): { label: string; color: string } {
  if (ratio >= 3) return { label: 'Strongly Bullish', color: C.green };
  if (ratio >= 2) return { label: 'Bullish', color: '#76ff03' };
  if (ratio >= 1) return { label: 'Neutral-Bullish', color: C.yellow };
  if (ratio >= 0.5) return { label: 'Neutral-Bearish', color: C.orange };
  return { label: 'Bearish', color: C.red };
}

function getTrendStrengthScore(stats: IndexStats): number {
  let score = 50;
  if (stats.trendState === 'Strong Uptrend') score += 20;
  else if (stats.trendState === 'Uptrend') score += 10;
  else if (stats.trendState === 'Above EMA 200') score += 5;
  else if (stats.trendState === 'Below EMA 200') score -= 10;
  else if (stats.trendState === 'Downtrend') score -= 20;

  if (stats.adx14 !== null) {
    if (stats.adx14 >= 25) score += 15;
    else if (stats.adx14 < 20) score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

function participationLabel(score: number): { label: string; color: string } {
  if (score >= 70) return { label: 'Strong Participation', color: C.green };
  if (score >= 55) return { label: 'Good Participation', color: '#76ff03' };
  if (score >= 45) return { label: 'Neutral', color: C.yellow };
  if (score >= 35) return { label: 'Weak Participation', color: C.orange };
  return { label: 'Very Weak', color: C.red };
}

function interpolateHex(a: string, b: string, t: number): string {
  const r1 = parseInt(a.slice(1, 3), 16), g1 = parseInt(a.slice(3, 5), 16), b1 = parseInt(a.slice(5, 7), 16);
  const r2 = parseInt(b.slice(1, 3), 16), g2 = parseInt(b.slice(3, 5), 16), b2 = parseInt(b.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bv = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bv.toString(16).padStart(2, '0')}`;
}

function gaugeColor(pct: number): string {
  if (pct <= 33) return C.red;
  if (pct <= 50) return interpolateHex(C.red, C.yellow, (pct - 33) / 17);
  if (pct <= 67) return interpolateHex(C.yellow, C.green, (pct - 50) / 17);
  return C.green;
}

// ─── SVG Semi-circle Gauge ────────────────────────────────────────────────────

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function SemiCircleGauge({ value, label, sublabel }: { value: number; label: string; sublabel?: string }) {
  const cx = 100, cy = 100, r = 75, sw = 10;
  // Arc: 180° (left, value=0) to 0° (right, value=100)
  // endAngle for value: 180 - (value/100)*180  → maps to SVG angles
  // But polarToCartesian uses (angle-90)*π/180, so we use direct degree mapping:
  // 0% → leftmost = 270° in our system (pointing left from top-pivot)
  // Use: angle = 270 - (value/100)*180, clamped
  const needleAngle = -90 + (value / 100) * 180;
  const color = gaugeColor(value);

  // Background arcs: red 180→120, yellow 120→60, green 60→0 (in "standard" angle space)
  // In our polarToCartesian (0° = top, 90° = right):
  // left = 270° = -90°, right = 90°
  // So: 0% → 270°(-90°), 100% → 90°
  // red zone: -90° to -30° (0–33%)
  // yellow zone: -30° to +30° (33–67%)
  // green zone: +30° to +90° (67–100%)
  const bgOpacity = 0.15;
  const zones = [
    { from: -90, to: -30, color: C.red },
    { from: -30, to: 30, color: C.yellow },
    { from: 30, to: 90, color: C.green },
  ];

  // Foreground arc from -90° to needle angle
  const fgEndAngle = -90 + (value / 100) * 180;
  const fgPath = value > 0 ? describeArc(cx, cy, r, -90, fgEndAngle) : '';

  // Needle pivot: transform from top (pointing up when angle=0)
  const needleX2 = cx + (r - 5) * Math.cos((needleAngle) * Math.PI / 180);
  const needleY2 = cy + (r - 5) * Math.sin((needleAngle) * Math.PI / 180);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 110" width="100%" style={{ maxWidth: 220, display: 'block' }}>
        {/* Background track zones */}
        {zones.map((z, i) => (
          <path
            key={i}
            d={describeArc(cx, cy, r, z.from, z.to)}
            fill="none"
            stroke={z.color}
            strokeWidth={sw}
            strokeLinecap="round"
            opacity={bgOpacity}
          />
        ))}
        {/* Foreground arc */}
        {fgPath && (
          <path
            d={fgPath}
            fill="none"
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
            opacity={0.9}
          />
        )}
        {/* Tick marks */}
        {[0, 25, 50, 75, 100].map((v) => {
          const a = (-90 + (v / 100) * 180) * Math.PI / 180;
          const x1 = cx + (r + 4) * Math.cos(a);
          const y1 = cy + (r + 4) * Math.sin(a);
          const x2 = cx + (r + 10) * Math.cos(a);
          const y2 = cy + (r + 10) * Math.sin(a);
          return <line key={v} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.border} strokeWidth={1} />;
        })}
        {/* Needle */}
        <line
          x1={cx} y1={cy}
          x2={needleX2} y2={needleY2}
          stroke={C.white}
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={5} fill={C.white} />
        <circle cx={cx} cy={cy} r={3} fill={C.panelHdr} />
        {/* Center value */}
        <text x={cx} y={cy - 12} textAnchor="middle" fontSize="24" fontWeight="bold"
          fill={color} fontFamily="monospace">{value.toFixed(0)}</text>
        {/* Label */}
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize="9" fill={C.muted}
          fontFamily="monospace" letterSpacing="1">{label.toUpperCase()}</text>
        {sublabel && (
          <text x={cx} y={cy + 21} textAnchor="middle" fontSize="8" fill={C.border}
            fontFamily="monospace" letterSpacing="0.5">{sublabel.toUpperCase()}</text>
        )}
        {/* Scale labels */}
        <text x="18" y="104" textAnchor="middle" fontSize="9" fill={C.muted} fontFamily="monospace">0</text>
        <text x="182" y="104" textAnchor="middle" fontSize="9" fill={C.muted} fontFamily="monospace">100</text>
        <text x="100" y="22" textAnchor="middle" fontSize="9" fill={C.muted} fontFamily="monospace">50</text>
      </svg>
    </div>
  );
}

// ─── Stacked Bar ──────────────────────────────────────────────────────────────

interface BarSegment { label: string; count: number; pct: number; color: string; }

function StackedBar({ title, segments, total }: { title: string; segments: BarSegment[]; total: number }) {
  return (
    <div className="mb-4">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontFamily: 'monospace', letterSpacing: 2, textTransform: 'uppercase', color: C.muted }}>{title}</span>
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: C.muted }}>{total.toLocaleString()}</span>
      </div>
      <div style={{ display: 'flex', height: 18, borderRadius: 2, overflow: 'hidden', gap: 1, background: C.border }}>
        {segments.map((seg) => (
          <div
            key={seg.label}
            style={{ width: `${seg.pct}%`, background: seg.color, minWidth: seg.pct > 0 ? 1 : 0 }}
            title={`${seg.label}: ${seg.count} (${seg.pct.toFixed(1)}%)`}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, flexWrap: 'wrap', gap: 4 }}>
        {segments.map((seg) => (
          <span key={seg.label} style={{ fontSize: 13, fontFamily: 'monospace', color: seg.color }}>
            {seg.label} {seg.count} ({seg.pct.toFixed(0)}%)
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Terminal Panel ───────────────────────────────────────────────────────────

function TerminalPanel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className} style={{ border: `1px solid ${C.border}`, background: C.panel, borderRadius: 0 }}>
      <div style={{ background: C.panelHdr, borderBottom: `1px solid ${C.border}`, padding: '7px 12px' }}>
        <span style={{ fontSize: 11, fontFamily: 'monospace', letterSpacing: 3, textTransform: 'uppercase', color: C.amber }}>
          {title}
        </span>
      </div>
      <div style={{ padding: '12px' }}>
        {children}
      </div>
    </div>
  );
}

// ─── Stat Row ────────────────────────────────────────────────────────────────

function StatRow({ label, value, valueColor: vc = C.white }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: `1px solid ${C.border}22` }}>
      <span style={{ fontSize: 12, color: C.muted, fontFamily: 'monospace' }}>{label}</span>
      <span style={{ fontSize: 12, color: vc, fontFamily: 'monospace', fontWeight: 600, tabularNums: 'tabular-nums' } as React.CSSProperties}>{value}</span>
    </div>
  );
}

// ─── Mini bar (for RSI zones) ─────────────────────────────────────────────────

function MiniBar({ label, count, pct, total, color }: { label: string; count: number; pct: number; total: number; color: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: C.muted, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: 'monospace', color }}>
          {count} / {total} &nbsp; <span style={{ fontWeight: 700 }}>{pct.toFixed(1)}%</span>
        </span>
      </div>
      <div style={{ height: 8, background: `${C.border}44`, borderRadius: 1 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 1, transition: 'width 0.5s' }} />
      </div>
    </div>
  );
}

// ─── Ticker Bar ───────────────────────────────────────────────────────────────

function TickerBar({ nifty50, breadth, regimeColor }: { nifty50: IndexStats; breadth: BreadthStats; regimeColor: BreadthResponse['regimeColor'] }) {
  const regime = getRegime(regimeColor);
  const adInfo = adxLabel(nifty50.adx14);
  const adRatioInfo = advDecLabel(breadth.advDecRatio);
  const items = [
    { label: 'NIFTY 50', value: fmt(nifty50.close, 2), color: C.amber },
    { label: 'VS EMA200', value: fmtPct(nifty50.pctVsEma200), color: valueColor(nifty50.pctVsEma200) },
    { label: 'ADX(14)', value: nifty50.adx14?.toFixed(1) ?? 'N/A', color: adInfo.color },
    { label: 'TREND', value: nifty50.trendState, color: trendStateColor(nifty50.trendState) },
    { label: 'ADV/DEC', value: breadth.advDecRatio.toFixed(2) + 'x', color: adRatioInfo.color },
    { label: 'ABOVE 200d', value: breadth.aboveEma200Pct + '%', color: pctToColor(breadth.aboveEma200Pct) },
    { label: 'N50 BREADTH', value: nifty50.nifty50BreadthPct + '%', color: pctToColor(nifty50.nifty50BreadthPct) },
    { label: 'REGIME', value: regime.label, color: regime.text },
  ];

  return (
    <div style={{ background: C.panelHdr, borderBottom: `1px solid ${C.border}`, padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap', overflowX: 'auto' }}>
      {items.map((item, i) => (
        <React.Fragment key={item.label}>
          <div style={{ display: 'flex', flexDirection: 'column', padding: '0 14px' }}>
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 1.5, textTransform: 'uppercase' }}>{item.label}</span>
            <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: item.color, whiteSpace: 'nowrap' }}>{item.value}</span>
          </div>
          {i < items.length - 1 && (
            <div style={{ width: 1, height: 28, background: C.border, flexShrink: 0 }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Regime Banner ────────────────────────────────────────────────────────────

function RegimeBanner({ label, color, participationScore, advDecRatio, dataDate }:
  { label: string; color: BreadthResponse['regimeColor']; participationScore: number; advDecRatio: number; dataDate: string }) {
  const regime = getRegime(color);
  const partInfo = participationLabel(participationScore);
  const adInfo = advDecLabel(advDecRatio);

  return (
    <div style={{ background: regime.bg, border: `1px solid ${regime.border}`, borderLeft: `3px solid ${regime.text}`, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 32, flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>Market Regime</div>
        <div style={{ fontSize: 26, fontFamily: 'monospace', fontWeight: 800, color: regime.text, letterSpacing: 3 }}>{regime.label}</div>
      </div>
      <div style={{ width: 1, height: 40, background: regime.border }} />
      <div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>Participation Score</div>
        <div style={{ fontSize: 24, fontFamily: 'monospace', fontWeight: 700, color: partInfo.color }}>{participationScore}<span style={{ fontSize: 12, color: C.muted }}>/100</span></div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: partInfo.color }}>{partInfo.label}</div>
      </div>
      <div style={{ width: 1, height: 40, background: regime.border }} />
      <div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>A/D Ratio</div>
        <div style={{ fontSize: 24, fontFamily: 'monospace', fontWeight: 700, color: adInfo.color }}>{advDecRatio.toFixed(2)}x</div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: adInfo.color }}>{adInfo.label}</div>
      </div>
      <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 1 }}>DATA AS OF</div>
        <div style={{ fontSize: 13, fontFamily: 'monospace', color: C.muted }}>{dataDate}</div>
      </div>
    </div>
  );
}

// ─── Nifty 50 Card ────────────────────────────────────────────────────────────

function Nifty50Card({ stats }: { stats: IndexStats }) {
  const score = getTrendStrengthScore(stats);
  const adInfo = adxLabel(stats.adx14);
  const chopInfo = chopLabel(stats.chopIndex);

  return (
    <TerminalPanel title="Nifty 50 Index — Trend Analysis">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        <div>
          <SemiCircleGauge value={score} label="Trend Strength" sublabel="Nifty 50 Index" />
          <div style={{ textAlign: 'center', marginTop: 4 }}>
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: trendStateColor(stats.trendState), textTransform: 'uppercase', letterSpacing: 1 }}>
              {stats.trendState}
            </span>
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 2 }}>Close</div>
            <div style={{ fontSize: 24, fontFamily: 'monospace', fontWeight: 800, color: C.white }}>{fmt(stats.close)}</div>
          </div>
          <StatRow label="EMA 20" value={fmt(stats.ema20)} valueColor={C.white} />
          <StatRow label="EMA 50" value={fmt(stats.ema50)} valueColor={C.white} />
          <StatRow label="EMA 200" value={fmt(stats.ema200)} valueColor={C.white} />
          <StatRow label="% vs EMA 20" value={fmtPct(stats.pctVsEma20)} valueColor={valueColor(stats.pctVsEma20)} />
          <StatRow label="% vs EMA 50" value={fmtPct(stats.pctVsEma50)} valueColor={valueColor(stats.pctVsEma50)} />
          <StatRow label="% vs EMA 200" value={fmtPct(stats.pctVsEma200)} valueColor={valueColor(stats.pctVsEma200)} />
          <StatRow label={`ADX(14) — ${adInfo.label}`} value={stats.adx14?.toFixed(2) ?? 'N/A'} valueColor={adInfo.color} />
          <StatRow label={`Chop — ${chopInfo.label}`} value={stats.chopIndex?.toFixed(2) ?? 'N/A'} valueColor={chopInfo.color} />
          <StatRow label="N50 Stocks Above 200d" value={`${stats.nifty50BreadthPct}%`} valueColor={pctToColor(stats.nifty50BreadthPct)} />
        </div>
      </div>
    </TerminalPanel>
  );
}

// ─── Nifty 500 Breadth Card ───────────────────────────────────────────────────

function Nifty500BreadthCard({ stats }: { stats: BreadthStats }) {
  const partInfo = participationLabel(stats.participationScore);

  return (
    <TerminalPanel title="Nifty 500 Universe — Breadth Health">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        <div>
          <SemiCircleGauge value={stats.aboveEma200Pct} label="% Above 200d MA" sublabel="Nifty 500 Universe" />
          <div style={{ textAlign: 'center', marginTop: 4 }}>
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: pctToColor(stats.aboveEma200Pct), textTransform: 'uppercase', letterSpacing: 1 }}>
              {stats.aboveEma200Count} / {stats.totalScanned} stocks
            </span>
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 2 }}>Participation Score</div>
            <div style={{ fontSize: 24, fontFamily: 'monospace', fontWeight: 800, color: partInfo.color }}>{stats.participationScore}<span style={{ fontSize: 12, color: C.muted }}>/100</span></div>
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: partInfo.color }}>{partInfo.label}</div>
          </div>
          <StatRow label="Universe Scanned" value={stats.totalScanned} />
          <StatRow label="Above EMA 200" value={`${stats.aboveEma200Count} (${stats.aboveEma200Pct}%)`} valueColor={pctToColor(stats.aboveEma200Pct)} />
          <StatRow label="Bull Power (all 3 MAs aligned ↑)" value={`${stats.bullPowerCount} (${stats.bullPowerPct}%)`} valueColor={C.green} />
          <StatRow label="Bear Power (all 3 MAs aligned ↓)" value={`${stats.bearPowerCount} (${stats.bearPowerPct}%)`} valueColor={C.red} />
          <StatRow label="Net Advance-Decline" value={(stats.netAdvanceDecline > 0 ? '+' : '') + stats.netAdvanceDecline} valueColor={valueColor(stats.netAdvanceDecline)} />
          <StatRow label="New 52W Highs" value={stats.new52WHighCount} valueColor={C.green} />
          <StatRow label="New 52W Lows" value={stats.new52WLowCount} valueColor={C.red} />
          <StatRow
            label="H/L Ratio"
            value={stats.new52WLowCount > 0 ? (stats.new52WHighCount / stats.new52WLowCount).toFixed(2) + 'x' : `${stats.new52WHighCount}H / 0L`}
            valueColor={stats.new52WHighCount >= stats.new52WLowCount ? C.green : C.red}
          />
        </div>
      </div>
    </TerminalPanel>
  );
}

// ─── Breadth Bars Panel ───────────────────────────────────────────────────────

function BreadthBarsPanel({ stats }: { stats: BreadthStats }) {
  const total = stats.totalScanned;
  const adTotal = stats.advancing1W + stats.declining1W + stats.unchanged1W;

  const adSegments: BarSegment[] = [
    { label: 'Advancing', count: stats.advancing1W, pct: adTotal > 0 ? (stats.advancing1W / adTotal) * 100 : 0, color: C.green },
    { label: 'Unchanged', count: stats.unchanged1W, pct: adTotal > 0 ? (stats.unchanged1W / adTotal) * 100 : 0, color: C.muted },
    { label: 'Declining', count: stats.declining1W, pct: adTotal > 0 ? (stats.declining1W / adTotal) * 100 : 0, color: C.red },
  ];
  const ema20Segs: BarSegment[] = [
    { label: 'Above MA20', count: stats.aboveEma20Count, pct: stats.aboveEma20Pct, color: C.green },
    { label: 'Below', count: total - stats.aboveEma20Count, pct: 100 - stats.aboveEma20Pct, color: `${C.red}44` },
  ];
  const ema50Segs: BarSegment[] = [
    { label: 'Above MA50', count: stats.aboveEma50Count, pct: stats.aboveEma50Pct, color: C.blue },
    { label: 'Below', count: total - stats.aboveEma50Count, pct: 100 - stats.aboveEma50Pct, color: `${C.border}88` },
  ];
  const ema200Segs: BarSegment[] = [
    { label: 'Above MA200', count: stats.aboveEma200Count, pct: stats.aboveEma200Pct, color: pctToColor(stats.aboveEma200Pct) },
    { label: 'Below', count: total - stats.aboveEma200Count, pct: 100 - stats.aboveEma200Pct, color: `${C.border}88` },
  ];

  return (
    <TerminalPanel title="Market Breadth Bars — Nifty 500 Universe">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 40px' }}>
        <div>
          <StackedBar title="Advance / Decline (1-Week)" segments={adSegments} total={adTotal} />
          <StackedBar title="Stocks Above MA 20 (Short-Term)" segments={ema20Segs} total={total} />
        </div>
        <div>
          <StackedBar title="Stocks Above MA 50 (Medium-Term)" segments={ema50Segs} total={total} />
          <StackedBar title="Stocks Above MA 200 (Long-Term)" segments={ema200Segs} total={total} />
        </div>
      </div>
    </TerminalPanel>
  );
}

// ─── 52-Week Extremes Card ────────────────────────────────────────────────────

function ExtremesCard({ stats }: { stats: BreadthStats }) {
  const ratio = stats.new52WLowCount > 0 ? stats.new52WHighCount / stats.new52WLowCount : stats.new52WHighCount;
  const ratioColor = ratio >= 2 ? C.green : ratio >= 1 ? C.yellow : C.red;
  const highPct = (stats.new52WHighCount / stats.totalScanned) * 100;
  const lowPct = (stats.new52WLowCount / stats.totalScanned) * 100;

  return (
    <TerminalPanel title="52-Week Extremes">
      <MiniBar label="New 52W Highs" count={stats.new52WHighCount} pct={highPct} total={stats.totalScanned} color={C.green} />
      <MiniBar label="New 52W Lows" count={stats.new52WLowCount} pct={lowPct} total={stats.totalScanned} color={C.red} />
      <div style={{ marginTop: 12, padding: '8px 10px', background: `${C.panelHdr}`, border: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>H/L Ratio</div>
        <div style={{ fontSize: 22, fontFamily: 'monospace', fontWeight: 800, color: ratioColor }}>
          {ratio.toFixed(2)}<span style={{ fontSize: 11, color: C.muted }}>x</span>
        </div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: ratioColor, marginTop: 2 }}>
          {ratio >= 3 ? 'Very Bullish — broad buying interest' :
           ratio >= 2 ? 'Bullish — new highs dominating' :
           ratio >= 1 ? 'Slightly Bullish' :
           ratio >= 0.5 ? 'Slightly Bearish' : 'Bearish — lows dominating'}
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <StatRow label="Universe Scanned" value={stats.totalScanned} />
        <StatRow label="Highs as % of Universe" value={highPct.toFixed(1) + '%'} valueColor={C.green} />
        <StatRow label="Lows as % of Universe" value={lowPct.toFixed(1) + '%'} valueColor={C.red} />
      </div>
    </TerminalPanel>
  );
}

// ─── RSI Distribution Card ────────────────────────────────────────────────────

function RSICard({ stats }: { stats: BreadthStats }) {
  const total = stats.totalScanned;
  return (
    <TerminalPanel title="RSI Distribution (14-Period)">
      <MiniBar label="Overbought RSI > 70" count={stats.rsiOverbought} pct={(stats.rsiOverbought / total) * 100} total={total} color={C.red} />
      <MiniBar label="Elevated  RSI 60–70" count={stats.rsiAbove60 - stats.rsiOverbought} pct={((stats.rsiAbove60 - stats.rsiOverbought) / total) * 100} total={total} color={C.orange} />
      <MiniBar label="Neutral   RSI 40–60" count={stats.rsiNeutral - (stats.rsiAbove60 - stats.rsiOverbought)} pct={((stats.rsiNeutral - (stats.rsiAbove60 - stats.rsiOverbought)) / total) * 100} total={total} color={C.muted} />
      <MiniBar label="Oversold  RSI < 40" count={stats.rsiOversold} pct={(stats.rsiOversold / total) * 100} total={total} color={C.green} />
      <div style={{ marginTop: 10 }}>
        <StatRow label="RSI Above 60 (Bullish Momentum)" value={`${stats.rsiAbove60} (${stats.rsiAbove60Pct}%)`} valueColor={C.orange} />
        <StatRow label="RSI Below 40 (Potential Reversal)" value={`${stats.rsiBelow40} (${stats.rsiBelow40Pct}%)`} valueColor={C.green} />
      </div>
    </TerminalPanel>
  );
}

// ─── Signals Card ─────────────────────────────────────────────────────────────

function SignalsCard({ stats, regimeColor }: { stats: BreadthStats; regimeColor: BreadthResponse['regimeColor'] }) {
  const regime = getRegime(regimeColor);
  const partInfo = participationLabel(stats.participationScore);
  const adInfo = advDecLabel(stats.advDecRatio);

  return (
    <TerminalPanel title="Breadth Signals & Interpretation">
      <div style={{ marginBottom: 14, padding: '10px', background: `${regime.text}11`, border: `1px solid ${regime.border}`, borderLeft: `3px solid ${regime.text}` }}>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 3 }}>Recommended Action</div>
        <div style={{ fontSize: 12, fontFamily: 'monospace', color: C.white }}>{regime.action}</div>
      </div>
      <StatRow label="Participation Score" value={`${stats.participationScore}/100 — ${partInfo.label}`} valueColor={partInfo.color} />
      <StatRow label="Net Advance-Decline" value={(stats.netAdvanceDecline > 0 ? '+' : '') + stats.netAdvanceDecline} valueColor={valueColor(stats.netAdvanceDecline)} />
      <StatRow label="A/D Ratio Signal" value={`${stats.advDecRatio.toFixed(2)}x — ${adInfo.label}`} valueColor={adInfo.color} />
      <StatRow label="Bull Power (Fully Aligned)" value={`${stats.bullPowerCount} stocks (${stats.bullPowerPct}%)`} valueColor={C.green} />
      <StatRow label="Bear Power (Fully Aligned)" value={`${stats.bearPowerCount} stocks (${stats.bearPowerPct}%)`} valueColor={C.red} />
      <StatRow label="Bull/Bear Power Ratio" value={stats.bearPowerCount > 0 ? (stats.bullPowerCount / stats.bearPowerCount).toFixed(2) + 'x' : `${stats.bullPowerCount}B / 0Be`} valueColor={stats.bullPowerCount >= stats.bearPowerCount ? C.green : C.red} />
      <StatRow label="RSI Momentum (>60)" value={`${stats.rsiAbove60Pct}% of universe`} valueColor={stats.rsiAbove60Pct > 40 ? C.orange : C.muted} />
    </TerminalPanel>
  );
}

// ─── Regime Guide ─────────────────────────────────────────────────────────────

function RegimeGuide({ activeColor }: { activeColor: BreadthResponse['regimeColor'] }) {
  const regimes = Object.entries(REGIME_CONFIG) as [BreadthResponse['regimeColor'], typeof REGIME_CONFIG[keyof typeof REGIME_CONFIG]][];
  return (
    <TerminalPanel title="Regime Interpretation Guide">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
        <thead>
          <tr style={{ background: C.panelHdr }}>
            {['Regime', 'Condition', 'Trading Action'].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: C.amber, letterSpacing: 2, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}` }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {regimes.map(([key, cfg]) => {
            const isActive = key === activeColor;
            return (
              <tr key={key} style={{ background: isActive ? cfg.bg : 'transparent', borderLeft: isActive ? `3px solid ${cfg.text}` : '3px solid transparent' }}>
                <td style={{ padding: '9px 12px', fontSize: 12, fontWeight: isActive ? 800 : 400, color: isActive ? cfg.text : C.muted, borderBottom: `1px solid ${C.border}22` }}>
                  {isActive && <span style={{ marginRight: 6 }}>▶</span>}{cfg.label}
                </td>
                <td style={{ padding: '9px 12px', fontSize: 12, color: isActive ? C.white : C.muted, borderBottom: `1px solid ${C.border}22` }}>
                  {cfg.condition}
                </td>
                <td style={{ padding: '9px 12px', fontSize: 12, color: isActive ? C.muted : `${C.muted}77`, borderBottom: `1px solid ${C.border}22` }}>
                  {cfg.action}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TerminalPanel>
  );
}

// ─── EMA Penetration Detail Table ─────────────────────────────────────────────

function EMAPenetrationDetail({ stats }: { stats: BreadthStats }) {
  const total = stats.totalScanned;
  const rows = [
    {
      label: 'Above MA 20', count: stats.aboveEma20Count, pct: stats.aboveEma20Pct,
      interp: stats.aboveEma20Pct > 60 ? 'Short-term momentum: broadly bullish' : stats.aboveEma20Pct > 40 ? 'Mixed; watch for expansion' : 'Short-term breadth weak',
    },
    {
      label: 'Above MA 50', count: stats.aboveEma50Count, pct: stats.aboveEma50Pct,
      interp: stats.aboveEma50Pct > 55 ? 'Medium-term: healthy market breadth' : stats.aboveEma50Pct > 40 ? 'Medium-term neutral; caution' : 'Medium-term deteriorating',
    },
    {
      label: 'Above MA 200', count: stats.aboveEma200Count, pct: stats.aboveEma200Pct,
      interp: stats.aboveEma200Pct >= 60 ? 'Structural bull — core indicator of market health' : stats.aboveEma200Pct >= 50 ? 'Cautiously positive' : stats.aboveEma200Pct >= 40 ? 'Transition zone' : 'Structural bear',
    },
  ];

  return (
    <TerminalPanel title="MA Penetration Detail — Nifty 500">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
        <thead>
          <tr style={{ background: C.panelHdr }}>
            {['Indicator', 'Count', '% Universe', 'Below', 'Interpretation'].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '7px 10px', fontSize: 11, color: C.amber, letterSpacing: 2, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} style={{ borderBottom: `1px solid ${C.border}33` }}>
              <td style={{ padding: '8px 10px', fontSize: 12, color: C.white }}>{row.label}</td>
              <td style={{ padding: '8px 10px', fontSize: 12, color: C.white, fontWeight: 700 }}>{row.count}</td>
              <td style={{ padding: '8px 10px', fontSize: 12, color: pctToColor(row.pct), fontWeight: 700 }}>{row.pct}%</td>
              <td style={{ padding: '8px 10px', fontSize: 12, color: C.muted }}>{total - row.count} ({(100 - row.pct).toFixed(1)}%)</td>
              <td style={{ padding: '8px 10px', fontSize: 11, color: C.muted }}>{row.interp}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TerminalPanel>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function BreadthAnalysis() {
  const [data, setData] = useState<BreadthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/breadth');
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        setLastUpdated(new Date());
      } else {
        setError(json.error ?? 'Failed to load breadth data');
      }
    } catch {
      setError('Network error. Failed to load breadth data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* ── Header ── */}
      <header style={{ background: C.panelHdr, borderBottom: `1px solid ${C.border}`, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 6, height: 28, background: C.amber }} />
          <div>
            <div style={{ fontSize: 16, fontFamily: 'monospace', fontWeight: 800, color: C.amber, letterSpacing: 3, textTransform: 'uppercase' }}>
              Market Breadth Terminal
            </div>
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: C.amberDim, letterSpacing: 2, textTransform: 'uppercase' }}>
              Nifty 50 · Nifty 500 Universe
            </div>
          </div>
        </div>
        <NavBar />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastUpdated && (
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: C.muted }}>
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} IST
            </span>
          )}
          <button
            onClick={fetchData}
            style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.panel, border: `1px solid ${C.border}`, cursor: 'pointer', color: loading ? C.amber : C.muted }}
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      {/* ── Loading ── */}
      {loading && !data && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 13, fontFamily: 'monospace', color: C.amber, letterSpacing: 3 }}>COMPUTING BREADTH…</div>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: C.muted, letterSpacing: 2 }}>SCANNING NIFTY 500 UNIVERSE</div>
          <RefreshCw size={18} style={{ color: C.amber }} className="animate-spin" />
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{ margin: 16, padding: '10px 14px', border: `1px solid ${C.red}55`, background: `${C.red}11`, fontFamily: 'monospace', fontSize: 13, color: C.red }}>
          ERROR: {error}
        </div>
      )}

      {/* ── Content ── */}
      {data && (
        <main style={{ flex: 1, overflowY: 'auto', padding: '0 0 24px 0' }}>
          {/* Ticker Bar */}
          <TickerBar nifty50={data.nifty50} breadth={data.nifty500Breadth} regimeColor={data.regimeColor} />

          <div style={{ padding: '0 16px' }}>
            {/* Regime Banner */}
            <div style={{ marginTop: 12 }}>
              <RegimeBanner
                label={data.regimeLabel}
                color={data.regimeColor}
                participationScore={data.nifty500Breadth.participationScore}
                advDecRatio={data.nifty500Breadth.advDecRatio}
                dataDate={data.dataDate}
              />
            </div>

            {/* Row 1: Index + 500 Breadth */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <Nifty50Card stats={data.nifty50} />
              <Nifty500BreadthCard stats={data.nifty500Breadth} />
            </div>

            {/* Row 2: Breadth Bars */}
            <div style={{ marginTop: 12 }}>
              <BreadthBarsPanel stats={data.nifty500Breadth} />
            </div>

            {/* Row 3: Extremes + RSI + Signals */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
              <ExtremesCard stats={data.nifty500Breadth} />
              <RSICard stats={data.nifty500Breadth} />
              <SignalsCard stats={data.nifty500Breadth} regimeColor={data.regimeColor} />
            </div>

            {/* Row 4: EMA Penetration Detail */}
            <div style={{ marginTop: 12 }}>
              <EMAPenetrationDetail stats={data.nifty500Breadth} />
            </div>

            {/* Row 5: Regime Guide */}
            <div style={{ marginTop: 12 }}>
              <RegimeGuide activeColor={data.regimeColor} />
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
