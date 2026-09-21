---
name: dhan-plotly-3d-scene
description: Use when working on the Option Cube (components/OptionScatter3D.tsx, components/option-cube/*, lib/optionScatter3d.ts) or adding any other Plotly WebGL (gl3d) scene to rs_dashboard. Covers keeping the user's camera across Plotly.react polls, default framing, drag/pan tools, native-Fullscreen-API panels, a custom hover HUD, the hand-typed plotly module, and the expiry-keyed chain state. Not for lightweight-charts canvases (dhan-live-chart) or recharts pages (dhan-quant-terminal-page).
---

# Dhan Plotly 3D Scene

## Overview
The Option Cube (`/options/scatter-3d`) is the repo's only Plotly gl3d scene: every CE/PE strike of one
expiry as a point on price-% x OI-% x IV axes, with a ranked shortlist beside it. It took five commits in
one day (`ad8343f`..`a3f9999`) to get the 3D behaviour right; each fix below was a real regression.

## File Layout (copy this split for the next scene)
- `lib/optionScatter3d.ts` - pure logic (points, clipping, scoring, chain summary, `describeExpiries`) with
  `lib/optionScatter3d.test.ts`. Run with `npm test` (`node --test lib/*.test.ts`).
- `components/option-cube/buildScene.ts` - pure `buildScene(opts) -> {traces, layout}`. No React, no DOM.
- `components/option-cube/shared.ts` - colours, camera presets, `DragMode`/`ColorMode` unions, formatters.
- `components/option-cube/{ControlBar,ViewportToolbar,HoverCard,InspectorCard,CandidatesTable,BiasGauge,Guide}.tsx`
- `components/OptionScatter3D.tsx` - owns state, polling, the Plotly lifecycle. Keep it orchestration-only
  (it went 1675 -> 486 lines when split).
- `types/plotly-gl3d.d.ts` - `plotly.js-gl3d-dist-min` ships no typings. Extend this file with each new
  Plotly call you make; do not cast to `any`.

## The Invariants

### 1. Load Plotly with a dynamic `import()` inside `useEffect`
It is WebGL and client-only. Guard with an `alive` flag, keep the module in a ref, and gate rendering on a
`plotlyReady` state. Surface a failed import or a failed `Plotly.react` (no WebGL) as a visible
`renderError`, not a blank panel. Call `Plotly.purge(el)` in the unmount cleanup.

### 2. `uirevision` does NOT keep a dragged camera if the layout also names one
Passing `uirevision: viewKey` and a camera in `layout.scene.camera` snaps the camera back on every
`Plotly.react` (the 15 s poll, any layer toggle). The fix (`d933a2c`): **own the camera in a ref.**
- Before each render, read the live camera from `el._fullLayout.scene._scene.getCamera()` (private API,
  wrapped in try/catch, typed via a small `LiveSceneHost` interface) - this covers a drag still in progress.
- Bind `plotly_relayout` once per graph div and record `scene.camera` / `scene.camera.eye` into the ref.
- Pass `camera: cameraRef.current ?? undefined` into `buildScene` on every render.
Presets (iso/top/front/side/reset) go through `Plotly.relayout`, which fires the same event, so the ref
stays right.

### 3. Frame the default view so nothing clips
`DEFAULT_CAMERA` in `shared.ts` is pulled back (`eye` ~1.55,-2.7,1.15) and aims below centre
(`center.z = -0.45`) so the whole box *and its axis titles* fit at default zoom and the near edge has room
to grow when the user zooms in (`d933a2c`, `3ab6e29`). Re-check framing after adding an axis title or
changing panel height. Top/front/side presets use `0.0001` on the degenerate axis - exactly 0 makes Plotly
flip the view.

### 4. Drag tool = Plotly `dragmode`, and pan is a separate mode
`DragMode = 'turntable' | 'orbit' | 'pan'` maps straight onto `layout.scene.dragmode`. A single "rotate"
toggle left no way to reposition the graph; **Move (pan)** is what fixed it (`3ab6e29`).

### 5. Fullscreen the graph panel, not the component
The first version was a CSS overlay over filters, table and guide, and left the canvas at normal height
(`47ac8fb`). Now:
- `viewportRef.current.requestFullscreen()`; listen for `fullscreenchange` and compare
  `document.fullscreenElement === viewportRef.current`.
- If the browser refuses (promise rejects), fall back to a `fixed inset-0` overlay of *just* the panel
  and handle Escape yourself; native fullscreen handles Esc.
- Height is a style, not a class: `max(760px, calc(100vh - 200px))` normally, `flex-1 min-h-0` when
  fullscreen. The `ResizeObserver` calling `Plotly.Plots.resize(el)` must be attached to the graph div's
  container so it fires on entering/leaving fullscreen.

### 6. Custom hover HUD, not Plotly's tooltip
Set `hoverinfo: 'none'` on the main trace (it hides the label but still emits `plotly_hover`) and
`'skip'` on decoration traces. `HoverCard.tsx` renders from `hoveredKey` and is **positioned without
re-rendering the scene** (ref + style write). `removeAllListeners('plotly_hover')` before re-binding, or
handlers stack on every `Plotly.react`.

### 7. Chain state is keyed by `underlying|expiry`
See `a3f9999`. `chainKey` labels every snapshot; only render/show data whose key matches the current one.
- Header strip must not show the previous expiry's PCR/OI while the new chain loads - `onMeta` carries
  `viewKey` and the parent ignores mismatches.
- Poll guard is `inflightKey`, not a boolean `inflight`: a new expiry pre-empts a slow in-flight fetch for
  the old one; `seq` still drops out-of-order results (`dhan-polling-guards` #4).
- Paint a previously viewed expiry instantly from `lib/clientCache.ts` (`getCached`/`setCached`, cap age
  ~10 min) with a "Showing chain from HH:MM - refreshing" pill; **never cache when `spot <= 0`**.
- Keep the last good spot per key in a ref; a transient spot of 0 must not blank the plot.
- Stay mounted across expiry changes so filters, colour mode and camera survive; remount (via `key=`)
  only when the *underlying* changes.
- First load of an expiry can take ~10 s (Python chain spawn) - show a spinner with that hint.

### 8. Compute header/summary numbers from the whole chain, not the filtered points
PCR, total OI and max-OI strikes read off the filtered scatter changed as the user moved Min-OI sliders
(`b6b9ba3`). Use `computeChainSummary(oc)` on the raw chain. Likewise the `DATA:` chip shows
`lastSessionDate`, and the timestamp is set at fetch time, not render time.

### 9. Colours: data hexes are allowed; chrome comes from the hook
Series/signal colours (`CE_COLOR`, `SIGNAL_COLOR`, `BEARISH_SCALE`) are hex in `shared.ts` - allowed as
saturated data colours, but each stop must read on both dark and white surfaces. Axis, grid, background
and font colours come from `useChartChrome()` (`lib/chartTheme.ts`) passed into `buildScene` as `chrome`,
so the scene re-themes; WebGL cannot read CSS variables (same reason as `dhan-live-chart` #5). Labels on
saturated fills use `text-oncolor`.

### 10. Domain semantics: bias maps buildup to the *underlying*
Call writing and put buying are bearish; put writing and call buying are bullish. Scoring "Short buildup"
alone as bearish misread put writing (`b6b9ba3`). Any new signal-to-direction mapping needs a test in
`lib/optionScatter3d.test.ts`.

## Before You Ship
- Drag/zoom, wait for a 15 s poll, toggle a layer: does the camera hold?
- Switch expiry mid-load: no old-expiry numbers in the header, no flash of empty plot.
- Enter/leave fullscreen with the ticket panels closed and open; press Esc.
- Both themes; a table whose header count matches its cell count (the candidates table shipped with 11
  headers and 10 cells).
- `npx tsc --noEmit` and `npm test`.
