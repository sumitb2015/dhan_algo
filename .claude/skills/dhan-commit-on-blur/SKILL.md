---
name: dhan-commit-on-blur
description: >-
  Use when designing, adding, or reviewing free-typed text/number/time inputs on
  dashboard pages whose values feed live rules, schedulers, exits, targets,
  stops, or order sizing. Enforces commit-on-blur/Enter (never per-keystroke)
  so partial edits cannot fire real trades. Triggers on RuleNumInput, text
  boxes, SL/CE/PE fields, lots, entry/exit times, or "typing Stop of 5000
  briefly becomes 5".
---

# Dhan Commit-on-Blur Inputs

## Overview

Any free-typed field whose committed value is read by a live executor
(scheduler tick, level-exit watcher, account Target/Stop/Trail, entry sizing,
worker config) must **not** update that state on every keystroke.

Typing `5000` into Stop briefly lands `5`. A tick in that window reads
`totalPnl <= -5` and flattens the book. Typing H↑ `25600` briefly lands `2`;
spot is always ≥ 2. Same class of bug for SL ×, CE/PE SL ×, lots, and times.

**Canonical implementation:** `RuleNumInput` in
`rs_dashboard/components/FocusTool.tsx`. Copy that pattern — do not invent a
new one per page.

## When to Use

- Adding or editing `<input type="text|number|time">` on an operational page
  (Focus Tool, scalpers, risk bars, strategy builders).
- Reviewing a page for "partial edit fired a rule / order".
- User mentions commit-on-blur, Enter-to-apply, or mid-edit triggers.

## The Rule

| Control | When to commit |
|---------|----------------|
| Free-typed text / number / time | **Blur or Enter only** |
| Escape while editing | Revert draft; do not commit |
| Select / toggle / SegPill / checkbox | Immediate (complete choice) |
| Explicit +/- stepper click | Immediate (complete ±1) |
| Discrete lot dropdown | Immediate (complete choice) |

If a value is only cosmetic (label preview nothing evaluates), immediate
`onChange` is fine — and rare on this dashboard. When unsure, use blur/Enter.

## Required Pattern

```tsx
function RuleNumInput({ value, onCommit, ... }: {
  value: string;
  onCommit: (v: string) => void;
  // ...
}) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);

  // Re-sync from props when not focused (config load / Clear) —
  // never while typing, or the draft snaps back mid-edit.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next !== value) onCommit(next);
  };

  return (
    <input
      value={draft}
      onFocus={() => { focusedRef.current = true; }}
      onChange={e => setDraft(e.target.value)}
      // Commit from the DOM value — avoids a stale React draft on fast Tab-away.
      onBlur={e => { focusedRef.current = false; commit(e.currentTarget.value); }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
```

Same shape for `type="time"` (see `TimeInput` in FocusTool).

### Do / Don't

- **Do** keep a local `draft`; only call the parent's setter / `updateRow` /
  risk `setX` from `onCommit`.
- **Do** commit via `e.currentTarget.value` on blur/Enter, not a possibly
  stale `draft` closure.
- **Do** block prop→draft sync while focused (`focusedRef`).
- **Don't** wire `onChange={e => setConfig(...)}` or
  `onChange={v => updateRow(id, { slRupees: v })}` on free-typed fields.
- **Don't** force `Math.max(1, Number(v) || 1)` inside `onChange` of a typed
  lots box — clearing `"1"` to type `"2"` snaps back to 1. Use a **select**
  for small discrete lot picks, or commit-on-blur for free type.
- **Don't** treat "it only updates React, not disk" as safe — Focus Tool
  schedulers read React state every tick, not only the saved file.

## Where This Already Applies (Focus Tool)

Reuse or mirror these; do not regress them to immediate `onChange`:

- SL ₹, SL ×, CE SL ×, PE SL ×
- H↑ / L↓ (`RuleNumStepper` text half)
- VWAP buffer %, premium targets
- Risk Target / Stop / Trigger / Lock
- Book-exit spot H/L
- Row lots (typed field)
- Entry / Exit time

Immediate is correct for: ATM offset `<select>`, side SegPill, product
select, LegLotSelect, Arm/Disarm, +/- lot *buttons*.

## Checklist Before Shipping an Input

- [ ] Free-typed? → draft + blur/Enter commit + Escape revert
- [ ] Value read by a poll/scheduler/rule/order path? → must be blur/Enter
- [ ] Blur commits `e.currentTarget.value`
- [ ] Focused field ignores external `value` prop updates
- [ ] Discrete control? → immediate OK
- [ ] Lots as free type that clamps every keystroke? → select or blur/Enter

## Anti-Patterns Seen In-Repo

1. **`onChange` → `updateRow({ slRupees })`** — partial SL fires exits.
2. **`Number(v) || 1` on every keystroke** — cannot type a multi-digit lot.
3. **Time `onChange` → `entryTime`** — partial `09:02` while aiming for `09:20`
   can enter early.
4. **"Save to disk is separate, so memory updates are fine"** — false when a
   1s scheduler reads that memory.
