/**
 * PanelStyles – injects the shared lc-* design system CSS used by all chart panels
 * (StraddlePanel, RollingStraddlePanel, StranglePanel, StrategyPanel).
 *
 * Rendered once by LiveOptionsChartsPage (the only mount site for those panels) rather than by
 * each panel - the rules are global, so per-panel rendering only duplicated the <style> tag.
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
        background: var(--lc-surface);
        border: 1px solid var(--lc-hairline-soft);
        border-radius: 10px;
        backdrop-filter: blur(10px);
        box-shadow: var(--lc-shadow);
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
        color: var(--lc-text-muted);
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
        background: linear-gradient(180deg, transparent, var(--lc-hairline), transparent);
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
        border: 1px solid var(--lc-hairline);
        background: var(--lc-surface-2);
        color: var(--lc-text);
        cursor: pointer;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
        appearance: auto;
      }
      .lc-select:hover {
        border-color: var(--lc-accent);
        color: var(--lc-accent-strong);
      }
      .lc-select:focus {
        border-color: var(--lc-accent);
        box-shadow: 0 0 0 2px var(--lc-hairline);
        color: var(--lc-accent-strong);
      }
      .lc-select--accent {
        color: var(--lc-accent-strong);
        font-weight: 700;
        border-color: var(--lc-hairline);
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
        border: 1px solid var(--lc-hairline);
        background: var(--lc-surface-2);
        color: var(--lc-text);
        outline: none;
        width: 52px;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        transition: border-color 0.15s;
      }
      .lc-input:focus {
        border-color: var(--lc-accent);
        box-shadow: 0 0 0 2px var(--lc-hairline);
      }

      /* ── View buttons ────────────────────────────────────────────── */
      .lc-view-btn {
        padding: 5px 10px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 6px;
        border: 1px solid var(--lc-hairline);
        background: var(--lc-surface-2);
        color: var(--lc-text-muted);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .lc-view-btn:hover {
        background: var(--lc-hover-bg);
        color: var(--lc-accent-hover);
        border-color: var(--lc-accent);
      }
      .lc-view-btn--active {
        background: var(--lc-active-bg);
        color: var(--lc-accent-strong);
        border-color: var(--lc-active-border);
        box-shadow: var(--lc-active-shadow);
      }

      /* ── Spot card ───────────────────────────────────────────────── */
      .lc-spot-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        padding: 3px 8px;
        background: var(--lc-surface-2);
        border: 1px solid var(--lc-hairline);
        border-radius: 6px;
      }
      .lc-stat-label {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--lc-text-muted);
      }
      .lc-spot-value {
        font-size: 11px;
        font-weight: 700;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        color: var(--lc-text);
      }

      /* ── Status pill ─────────────────────────────────────────────── */
      .lc-status-pill {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 8px;
        border-radius: 20px;
        border: 1px solid var(--lc-hairline-soft);
        background: var(--lc-surface-2);
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
        background: var(--lc-live);
        box-shadow: 0 0 6px rgba(52, 211, 153, 0.7);
        animation: lc-pulse 2s ease-in-out infinite;
      }
      .lc-status-dot--closed { background: var(--lc-text-faint); }
      .lc-status-live  { color: var(--lc-live); }
      .lc-status-closed { color: var(--lc-text-dim); }
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
        color: var(--lc-text-muted);
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
        color: var(--lc-danger);
      }

      /* ── Chart wrapper ───────────────────────────────────────────── */
      .lc-chart-wrap {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--lc-surface-3);
        border: 1px solid var(--lc-hairline-soft);
        border-radius: 10px;
        padding: 6px;
        overflow: hidden;
        box-shadow: var(--lc-shadow);
      }
      .lc-chart-loading {
        flex: 1;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: var(--lc-surface-3);
        border: 1px solid var(--lc-hairline-soft);
        border-radius: 10px;
        font-size: 12px;
        color: var(--lc-text-dim);
        box-shadow: var(--lc-shadow);
      }

      /* ── Legs row ────────────────────────────────────────────────── */
      .lc-legs-row {
        flex-shrink: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        background: var(--lc-surface);
        border: 1px solid var(--lc-hairline-soft);
        border-radius: 10px;
        backdrop-filter: blur(10px);
        box-shadow: var(--lc-shadow);
      }
      .lc-add-leg-btn {
        padding: 5px 10px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 6px;
        border: 1px dashed var(--lc-accent);
        background: transparent;
        color: var(--lc-accent);
        cursor: pointer;
        transition: all 0.15s;
      }
      .lc-add-leg-btn:hover:not(:disabled) {
        background: var(--lc-hover-bg);
        border-color: var(--lc-accent);
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
