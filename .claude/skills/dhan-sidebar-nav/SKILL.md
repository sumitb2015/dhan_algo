---
name: dhan-sidebar-nav
description: Use when touching rs_dashboard/components/Sidebar.tsx, rs_dashboard/app/layout.tsx, or NavBar.tsx's relationship to either — adding a nav group/link, changing collapse/expand behavior, or debugging a sidebar that resets its open sections, flickers on navigation, or a page whose content height is wrong relative to its own header. Not for the per-page sticky header content itself (dhan-quant-terminal-page, dhan-bloomberg-dashboard-page) — this is the global rail and its lifecycle.
---

# Dhan Sidebar Nav

## Overview
The dashboard's global nav moved from a per-page `NavBar` dropdown into a
persistent collapsible `Sidebar` across 5 commits in one day (`f0a464b`,
`6955b27`, `ced1a8e`, `b2628ab`, `378f581`). The first commit did the visual
move; the next three fixed correctness bugs that only showed up because ~45
pages each render their own header independently rather than sharing one
layout. Read `ced1a8e`'s commit message in full before touching mount location
or open-section state — it documents exactly how each bug was diagnosed.

## When to Use
- Adding/removing a nav group or link in `NAV_GROUPS` (`Sidebar.tsx`).
- Changing collapse/expand, tooltip, or flyout-vs-inline submenu behavior.
- A page's content area needs to know the sidebar width or the header height.
- Debugging: the sidebar's open group resets on navigation, the rail visibly
  disappears/reappears when navigating, or a page's `h-[calc(100vh-Npx)]`
  content area is off by some pixel count.

## Invariants

1. **`<Sidebar />` mounts exactly once, from `app/layout.tsx` (the root
   layout) — never from `NavBar.tsx` or a per-page component.** It used to
   mount inside `NavBar`, which ~45 pages each instantiate independently; any
   two pages that don't share a `layout.tsx` fully unmounted and remounted it
   on navigation, visibly flickering the rail and resetting `openGroups` to
   whatever the newly-mounted page's active route happened to imply
   (`ced1a8e`). If you're adding a new page and reach for `<Sidebar />` in its
   own JSX, stop — it's already rendered by the root layout; add `<NavBar />`
   (the small per-page controls: theme toggle, sync, disconnect) instead.

2. **`openGroups` is re-derived on every pathname change, not just at mount.**
   Because the Sidebar instance now persists across navigations, computing
   which group should be open only in `useState`'s initializer would freeze it
   at whatever was true on first mount. The fix compares `pathname` against a
   tracked `prevPathname` **during render** (React's documented pattern for
   deriving state from a prop/route change) and unions in the newly-active
   group — it does not remove groups the user manually opened, so opening more
   than one section at once is expected, not a bug to collapse.

3. **`Sidebar` guards itself off `/login` directly** — both in what it renders
   and in the effect that sets `--sidebar-w` (reset to `0px` there), because
   `/login` renders no page-side padding to compensate for a nonzero rail
   width. Adding a new unauthenticated page needs the same `pathname ===
   '/your-route'` guard, not a layout-level exclusion — there isn't one, since
   the sidebar is mounted at the root.

4. **A page's content area must not hardcode the header height in pixels.**
   `app/backtest/page.tsx` used `h-[calc(100vh-53px)]`, calibrated to the old,
   taller per-page `NavBar` (a full row of dropdown buttons). Once `NavBar`
   shrank to just theme/sync/disconnect controls, 53px silently stopped
   matching reality. The fix: `h-screen flex flex-col` on the page root, the
   header gets `shrink-0`, the content row gets `flex-1 min-h-0` — the content
   area then adapts to whatever the header's real rendered height is, and
   survives the header changing size again later. Reach for this pattern
   instead of a new magic offset any time a page's layout depends on its own
   header's height.

5. **Collapsed width is communicated via the `--sidebar-w` CSS custom
   property** (`document.documentElement.style.setProperty('--sidebar-w',
   ...)`), not a prop or context — because the sidebar and the page content
   that pads around it are siblings under the root layout, not
   parent/child. A new consumer that needs the current rail width reads this
   var rather than importing collapse state from `Sidebar.tsx`.

## Common Mistakes
- Rendering `<Sidebar />` from a new page or a nested layout "to be safe" —
  it's already mounted once at the root; a second instance duplicates the
  rail and reintroduces the exact remount bug this was fixed for.
- Computing `openGroups` only in a `useState` initializer or only in a
  `useEffect` — the render-time derivation pattern in invariant 2 exists
  specifically so the open state updates in the same commit as the route
  change, not one paint late.
- Copying an old page's `h-[calc(100vh-Npx)]` header-offset pattern into a new
  page — check whether the flex-column pattern (invariant 4) fits instead;
  a hardcoded offset silently drifts the next time any shared header changes.
- Forgetting the icon-only collapsed-rail group buttons need `aria-label` —
  the collapse-toggle button already had one; the group buttons initially
  didn't (fixed in `ced1a8e`, see also `dhan-a11y-controls`).
