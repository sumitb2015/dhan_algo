/**
 * PanelStyles – injects the shared lc-* design system CSS used by all chart panels
 * (StraddlePanel, RollingStraddlePanel, StranglePanel, StrategyPanel).
 *
 * Each panel renders this component so the styles are guaranteed to be present regardless
 * of which panel is mounted in a given layout slot.
 */
export function PanelStyles() {
  return (
    <style>{`
      /* ── Panel shell ─────────────────────────────────────────────── */
      .lc-panel {
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: 100%;
        min-height: 0;
      }

      /* ── Toolbar ─────────────────────────────────────────────────── */
      .lc-toolbar {
        flex-shrink: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 8px 12px;
        padding: 8px 10px;
        background: rgba(12, 16, 30, 0.85);
        border: 1px solid rgba(99, 102, 241, 0.12);
        border-radius: 10px;
        backdrop-filter: blur(10px);
      }
      .lc-toolbar-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .lc-group-label {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.14em;
        color: #374151;
        padding-left: 2px;
      }
      .lc-group-row {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .lc-toolbar-sep {
        width: 1px;
        height: 36px;
        background: linear-gradient(180deg, transparent, rgba(99,102,241,0.2), transparent);
        align-self: flex-end;
        margin-bottom: 2px;
      }
      .lc-toolbar-stats {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-left: auto;
        flex-wrap: wrap;
      }

      /* ── Selects ─────────────────────────────────────────────────── */
      .lc-select {
        padding: 5px 7px;
        font-size: 11px;
        border-radius: 6px;
        border: 1px solid rgba(99, 102, 241, 0.18);
        background: rgba(10, 14, 26, 0.9);
        color: #94a3b8;
        cursor: pointer;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
        appearance: auto;
      }
      .lc-select:hover {
        border-color: rgba(99, 102, 241, 0.35);
        color: #c7d2fe;
      }
      .lc-select:focus {
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
        color: #c7d2fe;
      }
      .lc-select--accent {
        color: #a5b4fc;
        font-weight: 700;
        border-color: rgba(129, 140, 248, 0.25);
      }
      .lc-select--mono {
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 11px;
      }
      .lc-select--narrow { max-width: 54px; }

      /* ── Inputs ──────────────────────────────────────────────────── */
      .lc-input {
        padding: 5px 7px;
        font-size: 11px;
        border-radius: 6px;
        border: 1px solid rgba(99, 102, 241, 0.18);
        background: rgba(10, 14, 26, 0.9);
        color: #94a3b8;
        outline: none;
        width: 52px;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        transition: border-color 0.15s;
      }
      .lc-input:focus {
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
      }

      /* ── View buttons ────────────────────────────────────────────── */
      .lc-view-btn {
        padding: 5px 10px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 6px;
        border: 1px solid rgba(99, 102, 241, 0.18);
        background: rgba(10, 14, 26, 0.9);
        color: #4b5563;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .lc-view-btn:hover {
        background: rgba(99, 102, 241, 0.1);
        color: #818cf8;
        border-color: rgba(99, 102, 241, 0.3);
      }
      .lc-view-btn--active {
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(168, 85, 247, 0.2));
        color: #a5b4fc;
        border-color: rgba(129, 140, 248, 0.4);
        box-shadow: 0 0 8px rgba(99, 102, 241, 0.2);
      }

      /* ── Spot card ───────────────────────────────────────────────── */
      .lc-spot-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        padding: 3px 8px;
        background: rgba(10, 14, 26, 0.8);
        border: 1px solid rgba(99, 102, 241, 0.15);
        border-radius: 6px;
      }
      .lc-stat-label {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #374151;
      }
      .lc-spot-value {
        font-size: 11px;
        font-weight: 700;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        color: #94a3b8;
      }

      /* ── Status pill ─────────────────────────────────────────────── */
      .lc-status-pill {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 8px;
        border-radius: 20px;
        border: 1px solid rgba(99, 102, 241, 0.12);
        background: rgba(10, 14, 26, 0.7);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.08em;
      }
      .lc-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .lc-status-dot--live {
        background: #34d399;
        box-shadow: 0 0 6px rgba(52, 211, 153, 0.7);
        animation: lc-pulse 2s ease-in-out infinite;
      }
      .lc-status-dot--closed { background: #374151; }
      .lc-status-live  { color: #34d399; }
      .lc-status-closed { color: #4b5563; }
      @keyframes lc-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.5; }
      }

      /* ── Legs label ──────────────────────────────────────────────── */
      .lc-legs-label {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #4b5563;
        padding-right: 4px;
      }

      /* ── Error ───────────────────────────────────────────────────── */
      .lc-error {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        background: rgba(239, 68, 68, 0.08);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 8px;
        font-size: 12px;
        color: #f87171;
      }

      /* ── Chart wrapper ───────────────────────────────────────────── */
      .lc-chart-wrap {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: rgba(8, 11, 20, 0.6);
        border: 1px solid rgba(99, 102, 241, 0.1);
        border-radius: 10px;
        padding: 6px;
        overflow: hidden;
      }
      .lc-chart-loading {
        flex: 1;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: rgba(8, 11, 20, 0.6);
        border: 1px solid rgba(99, 102, 241, 0.1);
        border-radius: 10px;
        font-size: 12px;
        color: #4b5563;
      }

      /* ── Legs row ────────────────────────────────────────────────── */
      .lc-legs-row {
        flex-shrink: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        background: rgba(12, 16, 30, 0.85);
        border: 1px solid rgba(99, 102, 241, 0.12);
        border-radius: 10px;
        backdrop-filter: blur(10px);
      }
      .lc-add-leg-btn {
        padding: 5px 10px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 6px;
        border: 1px dashed rgba(99, 102, 241, 0.3);
        background: transparent;
        color: #6366f1;
        cursor: pointer;
        transition: all 0.15s;
      }
      .lc-add-leg-btn:hover:not(:disabled) {
        background: rgba(99, 102, 241, 0.1);
        border-color: rgba(99, 102, 241, 0.5);
      }
      .lc-add-leg-btn:disabled { opacity: 0.3; cursor: not-allowed; }
      .lc-remove-btn {
        padding: 3px 7px;
        font-size: 13px;
        font-weight: 700;
        border-radius: 4px;
        border: 1px solid rgba(239, 68, 68, 0.2);
        background: rgba(239, 68, 68, 0.06);
        color: #ef4444;
        cursor: pointer;
        transition: all 0.15s;
        line-height: 1;
      }
      .lc-remove-btn:hover:not(:disabled) {
        background: rgba(239, 68, 68, 0.15);
        border-color: rgba(239, 68, 68, 0.4);
      }
      .lc-remove-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    `}</style>
  );
}
