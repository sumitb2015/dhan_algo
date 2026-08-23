---
name: dhan-a11y-controls
description: Use when adding buttons to a dashboard page, reviewing an existing page for accessibility, or asked to make a page "keyboard-safe" / "screen-reader friendly". Explains the FOCUS_RING pattern and icon-only-button aria-labels applied to FocusTool.tsx — the same gap exists, unfixed, on every other dense operational page.
---

# Dhan Accessibility: Focus Rings & Icon-Only Buttons

## Overview

`FocusTool.tsx` (`0982038 fix(focus-tool): visible keyboard focus and accessible
names on every control`) was the first page in this dashboard to get a real
accessibility pass. Before that commit, `<input>` elements had a visible focus
ring (`focus:ring-1 focus:ring-violet-500/40` from `RuleNumInput`/`NumInput`)
but **no `<button>` anywhere in the codebase did** — keyboard users tabbing
through Arm/Exit/Delete/EXIT ALL controls got no visual confirmation of where
focus was. On pages that place real orders, that's a safety gap, not polish.

This has not been fixed anywhere else. `components/Scalper.tsx` (26 `<button>`s)
and `components/AdvancedScalper.tsx` (14 `<button>`s) — the two other
operational order-ticket pages — currently have zero `focus-visible` and zero
`aria-label` occurrences. Any page with icon-only or densely-packed controls
has the same gap until it gets this treatment.

## When to Use

- Adding new `<button>`s to any dashboard page.
- Asked to make a page accessible / keyboard-safe / screen-reader friendly.
- Reviewing a page and noticing icon-only controls (`X`, chevrons, `+`/`-`
  steppers) with only a `title` attribute.

## The Pattern

### 1. One shared focus-ring constant per file

```ts
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';
```

Declared once near the top of the component file (see `FocusTool.tsx` next to
its other shared constants), appended via `cn()` to **every** clickable
`<button>`'s className:

```tsx
className={cn('...existing classes...', FOCUS_RING)}
```

Use `focus-visible`, not `focus` — it only shows for keyboard navigation, not
mouse clicks, matching how the inputs already behave. This needs to happen at
every call site individually for buttons that build their className inline;
for a button rendered through a shared primitive (a `GhostBtn`, `SegPill`,
`SwitchToggle`-style wrapper used across many call sites), add it once to the
primitive and every usage inherits it for free — do the primitives first, they
cover the most ground per edit.

### 2. `aria-label` on icon-only buttons

A `title` attribute only helps mouse users (hover tooltip). Any button whose
visible content is just an icon (a delete `X`, a chevron, a bare `+`/`-`) needs
a matching `aria-label` so screen readers get a real accessible name:

```tsx
<button
  onClick={onDelete}
  title="Delete this row"
  aria-label="Delete row"
  className={cn('...', FOCUS_RING)}
>
  <X className="h-3 w-3" />
</button>
```

Keep the `aria-label` text synced with the `title` text — they should say the
same thing, just for different audiences.

### 3. Leave `disabled` alone

Native `disabled` correctly removes a control from the tab order and prevents
accidental clicks — that's the right behavior for an order-placing control, not
a bug. Don't swap it for `aria-disabled` to make disabled buttons
keyboard-reachable; that's a bigger, separate decision (it makes them
focusable/click-adjacent) and wasn't part of the `FocusTool.tsx` pass.

## Verification

- Tab through the page with the mouse untouched — every actionable control
  should show a visible violet ring, including inside dense table cells.
- Check the browser's accessibility tree (or a screen reader) on icon-only
  buttons to confirm the announced name matches the action.
- `tsc --noEmit` / `eslint` — this is a pure `className`/`aria-label` addition,
  it should never touch logic, so a diff review confirming that is the real
  regression check on a real-money page.

## Common Mistakes

- Adding `FOCUS_RING` to a shared primitive but forgetting the one-off buttons
  that build their className inline elsewhere in the same file — grep
  `<button` in the file being edited and check each hit, not just the ones
  inside shared components.
- Skipping `aria-label` because the button already has a `title` — `title` is
  mouse-only, it does not satisfy the accessible-name requirement.
- Bumping a disabled trade-blocked reason (e.g. "Dry run — turn on LIVE · REAL
  MONEY to place orders") into `aria-label` — disabled buttons are correctly
  out of the tab order, so a screen-reader user won't reach that label anyway;
  it stays in `title` for mouse users only.
