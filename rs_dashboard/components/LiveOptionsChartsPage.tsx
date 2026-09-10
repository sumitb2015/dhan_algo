'use client';

import { useEffect, useRef, useState } from 'react';
import { StraddlePanel } from '@/components/StraddlePanel';
import { RollingStraddlePanel } from '@/components/RollingStraddlePanel';
import { StranglePanel } from '@/components/StranglePanel';
import { StrategyPanel } from '@/components/StrategyPanel';
import { PanelStyles } from '@/components/PanelStyles';
import { type ChartUnderlying } from '@/lib/underlyings';
import NavBar from './NavBar';

const LAYOUTS = [1, 2] as const;
type LayoutCount = (typeof LAYOUTS)[number];

const SPREAD_TYPES = ['straddle', 'rolling_straddle', 'strangle', 'strategy'] as const;
type SpreadType = (typeof SPREAD_TYPES)[number];

const SPREAD_LABELS: Record<SpreadType, string> = {
  straddle: 'Straddle',
  rolling_straddle: 'Rolling',
  strangle: 'Strangle',
  strategy: 'Strategy',
};

const SPREAD_ICONS: Record<SpreadType, string> = {
  straddle: '⟺',
  rolling_straddle: '↻',
  strangle: '≈',
  strategy: '⊞',
};

/** Live options premium charts (straddle / rolling straddle / strangle / custom multi-leg
 * strategy), ported from dhanHQ_skills' straddle-chart page. Each panel independently fetches
 * combined CE+PE candles via /api/options/live-charts, which spawns
 * scripts/tools/options_chart_fetch.py per request - no persistent backend process, matching
 * this dashboard's spawn-per-request convention. */
export default function LiveOptionsChartsPage() {
  const [spreadType, setSpreadType] = useState<SpreadType>('straddle');
  const [layoutCount, setLayoutCount] = useState<LayoutCount>(1);
  // Per-panel underlying, owned here rather than inside the panels so the selection survives a
  // spread-type switch (which unmounts and remounts every panel).
  const [underlyings, setUnderlyings] = useState<ChartUnderlying[]>(['NIFTY', 'BANKNIFTY']);

  function setUnderlyingAt(index: number, next: ChartUnderlying) {
    setUnderlyings((prev) => prev.map((u, i) => (i === index ? next : u)));
  }

  const gridRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(560);

  useEffect(() => {
    function updateHeight() {
      const top = gridRef.current?.getBoundingClientRect().top;
      if (top == null) return;
      setGridHeight(Math.max(360, Math.round(window.innerHeight - top - 16)));
    }
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const { cols, rows } = layoutCount === 2 ? { cols: 2, rows: 1 } : { cols: 1, rows: 1 };
  // en-CA gives YYYY-MM-DD; IST rather than toISOString()'s UTC, which reads as yesterday
  // for anyone loading the page before 05:30 IST.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  return (
    <div className="lc-page">
      {/* ─── Vertical sidebar ───────────────────────────────────────── */}
      <aside className="lc-sidebar">
        {/* Header */}
        <div className="lc-sidebar-brand">
          <span className="lc-brand-icon">◈</span>
          <span className="lc-brand-text">Charts</span>
        </div>

        {/* Date badge */}
        <span className="lc-date-badge">{today}</span>

        <div className="lc-sidebar-divider" />

        {/* Mode tabs */}
        <nav className="lc-nav">
          <span className="lc-nav-label">MODE</span>
          {SPREAD_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSpreadType(t)}
              className={`lc-nav-item${spreadType === t ? ' lc-nav-item--active' : ''}`}
            >
              <span className="lc-nav-icon">{SPREAD_ICONS[t]}</span>
              <span className="lc-nav-text">{SPREAD_LABELS[t]}</span>
              {spreadType === t && <span className="lc-nav-pip" />}
            </button>
          ))}
        </nav>

        <div className="lc-sidebar-divider" />

        {/* Layout switcher */}
        <div className="lc-layout-section">
          <span className="lc-nav-label">LAYOUT</span>
          <div className="lc-layout-btns">
            {LAYOUTS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setLayoutCount(n)}
                className={`lc-layout-btn${layoutCount === n ? ' lc-layout-btn--active' : ''}`}
                title={`${n} panel${n > 1 ? 's' : ''}`}
              >
                {n === 1 ? (
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <rect x="2" y="2" width="14" height="14" rx="2" fill="currentColor" opacity="0.9" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <rect x="2" y="2" width="6" height="14" rx="1.5" fill="currentColor" opacity="0.9" />
                    <rect x="10" y="2" width="6" height="14" rx="1.5" fill="currentColor" opacity="0.9" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* ─── Main content ────────────────────────────────────────────── */}
      <main className="lc-main">
        {/* Gradient header bar */}
        <header className="lc-header">
          <h1 className="lc-header-title">
            Live <span className="lc-header-accent">{SPREAD_LABELS[spreadType]}</span> Chart
          </h1>
          <div className="lc-header-controls">
            <span className="lc-header-divider" />
            <NavBar />
          </div>
          <div className="lc-header-glow" aria-hidden="true" />
        </header>

        {/* Chart grid */}
        <div
          ref={gridRef}
          className="lc-grid"
          style={{
            height: gridHeight,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: layoutCount }, (_, i) => {
            // Keying the panel on its underlying remounts it on a switch.
            const key = `${i}-${underlyings[i]}`;
            const panelProps = {
              underlying: underlyings[i],
              onUnderlyingChange: (u: ChartUnderlying) => setUnderlyingAt(i, u),
            };
            return (
              <div key={i} className="min-h-0 min-w-0">
                {spreadType === 'straddle' ? (
                  <StraddlePanel key={key} {...panelProps} />
                ) : spreadType === 'rolling_straddle' ? (
                  <RollingStraddlePanel key={key} {...panelProps} />
                ) : spreadType === 'strangle' ? (
                  <StranglePanel key={key} {...panelProps} />
                ) : (
                  <StrategyPanel key={key} {...panelProps} />
                )}
              </div>
            );
          })}
        </div>
      </main>

      <style>{`
        /* ── Page shell ─────────────────────────────────────────────── */
        .lc-page {
          display: flex;
          height: 100vh;
          background: #080b14;
          color: #e2e8f0;
          font-family: 'Inter', 'Geist', system-ui, sans-serif;
          overflow: hidden;
        }

        :root:not(.dark) .lc-page {
          background: var(--body-bg, #f1f5f9);
          color: #0f172a;
        }

        /* ── Sidebar ────────────────────────────────────────────────── */
        .lc-sidebar {
          width: 88px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 12px 8px;
          background: rgba(10, 14, 26, 0.95);
          border-right: 1px solid rgba(99, 102, 241, 0.12);
          backdrop-filter: blur(12px);
        }

        :root:not(.dark) .lc-sidebar {
          background: #ffffff;
          border-right: 1px solid #e2e8f0;
          box-shadow: 1px 0 4px rgba(15, 23, 42, 0.04);
        }

        .lc-sidebar-brand {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          padding: 8px 0 10px;
        }
        .lc-brand-icon {
          font-size: 20px;
          background: linear-gradient(135deg, #818cf8, #c084fc);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .lc-brand-text {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #6366f1;
        }
        .lc-date-badge {
          font-size: 9px;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          color: rgba(255,255,255,0.40);
          background: rgba(99, 102, 241, 0.06);
          border: 1px solid rgba(99, 102, 241, 0.1);
          border-radius: 4px;
          padding: 2px 5px;
          letter-spacing: 0.04em;
        }

        :root:not(.dark) .lc-date-badge {
          color: #3730a3;
          background: #e0e7ff;
          border-color: #c7d2fe;
        }

        .lc-sidebar-divider {
          width: 40px;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(99, 102, 241, 0.2), transparent);
          margin: 6px 0;
        }

        :root:not(.dark) .lc-sidebar-divider {
          background: #e2e8f0;
        }

        .lc-nav {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          width: 100%;
        }
        .lc-nav-label {
          font-size: 8px;
          font-weight: 700;
          letter-spacing: 0.15em;
          color: rgba(255,255,255,0.40);
          margin-bottom: 4px;
        }

        :root:not(.dark) .lc-nav-label {
          color: #64748b;
        }

        .lc-nav-item {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          width: 68px;
          padding: 8px 4px;
          border-radius: 10px;
          border: 1px solid transparent;
          background: transparent;
          cursor: pointer;
          transition: all 0.2s ease;
          color: rgba(255,255,255,0.65);
        }

        :root:not(.dark) .lc-nav-item {
          color: #475569;
        }

        .lc-nav-item:hover {
          background: rgba(99, 102, 241, 0.08);
          color: rgba(255,255,255,0.75);
          border-color: rgba(99, 102, 241, 0.15);
        }

        :root:not(.dark) .lc-nav-item:hover {
          background: #f1f5f9;
          color: #3730a3;
          border-color: #cbd5e1;
        }

        .lc-nav-item--active {
          background: linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(168, 85, 247, 0.12));
          color: #a5b4fc;
          border-color: rgba(99, 102, 241, 0.3);
          box-shadow: 0 0 12px rgba(99, 102, 241, 0.15), inset 0 1px 0 rgba(255,255,255,0.05);
        }

        :root:not(.dark) .lc-nav-item--active {
          background: #e0e7ff;
          color: #3730a3;
          border-color: #a5b4fc;
          box-shadow: 0 1px 3px rgba(99, 102, 241, 0.15);
        }

        .lc-nav-icon {
          font-size: 16px;
          line-height: 1;
          transition: transform 0.2s ease;
        }
        .lc-nav-item--active .lc-nav-icon {
          filter: drop-shadow(0 0 6px rgba(129, 140, 248, 0.7));
        }
        .lc-nav-text {
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .lc-nav-pip {
          position: absolute;
          bottom: 6px;
          left: 50%;
          transform: translateX(-50%);
          width: 20px;
          height: 2px;
          border-radius: 1px;
          background: linear-gradient(90deg, #818cf8, #c084fc);
          box-shadow: 0 0 6px rgba(129, 140, 248, 0.6);
        }
        .lc-layout-section {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          width: 100%;
        }
        .lc-layout-btns {
          display: flex;
          gap: 4px;
        }
        .lc-layout-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          border-radius: 7px;
          border: 1px solid rgba(99, 102, 241, 0.15);
          background: rgba(99, 102, 241, 0.04);
          color: rgba(255,255,255,0.40);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        :root:not(.dark) .lc-layout-btn {
          background: #f8fafc;
          border-color: #cbd5e1;
          color: #475569;
        }

        .lc-layout-btn:hover {
          background: rgba(99, 102, 241, 0.1);
          color: #818cf8;
          border-color: rgba(99, 102, 241, 0.3);
        }

        :root:not(.dark) .lc-layout-btn:hover {
          background: #e2e8f0;
          color: #3730a3;
          border-color: #94a3b8;
        }

        .lc-layout-btn--active {
          background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(168, 85, 247, 0.18));
          color: #a5b4fc;
          border-color: rgba(129, 140, 248, 0.4);
          box-shadow: 0 0 10px rgba(99, 102, 241, 0.2);
        }

        :root:not(.dark) .lc-layout-btn--active {
          background: #e0e7ff;
          color: #3730a3;
          border-color: #a5b4fc;
          box-shadow: 0 1px 3px rgba(99, 102, 241, 0.15);
        }

        /* ── Main content ───────────────────────────────────────────── */
        .lc-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .lc-header {
          position: relative;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 16px 8px;
          background: linear-gradient(135deg, rgba(49, 46, 129, 0.4) 0%, rgba(88, 28, 135, 0.25) 50%, rgba(8, 11, 20, 0) 100%);
          border-bottom: 1px solid rgba(99, 102, 241, 0.15);
          overflow: hidden;
        }

        :root:not(.dark) .lc-header {
          background: #ffffff;
          border-bottom: 1px solid #e2e8f0;
          box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
        }

        .lc-header-title {
          font-size: 15px;
          font-weight: 700;
          color: #e2e8f0;
          letter-spacing: -0.01em;
          position: relative;
          z-index: 1;
        }

        :root:not(.dark) .lc-header-title {
          color: #0f172a;
        }

        .lc-header-accent {
          background: linear-gradient(135deg, #818cf8, #c084fc);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        :root:not(.dark) .lc-header-accent {
          background: linear-gradient(135deg, #4f46e5, #9333ea);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .lc-header-controls {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .lc-header-divider {
          width: 1px;
          height: 20px;
          background: rgba(255, 255, 255, 0.12);
          flex-shrink: 0;
        }

        :root:not(.dark) .lc-header-divider {
          background: #e2e8f0;
        }

        .lc-header-glow {
          position: absolute;
          top: -20px;
          left: -20px;
          width: 200px;
          height: 80px;
          background: radial-gradient(ellipse, rgba(99, 102, 241, 0.12) 0%, transparent 70%);
          pointer-events: none;
        }
        .lc-grid {
          flex: 1;
          display: grid;
          gap: 10px;
          padding: 10px;
          min-height: 0;
          overflow: hidden;
        }
      `}</style>
      {/* Panel CSS injected once here rather than per panel - the lc-* rules are global. */}
      <PanelStyles />
    </div>
  );
}
