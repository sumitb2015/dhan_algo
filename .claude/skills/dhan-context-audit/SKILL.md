---
name: dhan-context-audit
description: Use when the user asks to review/optimize CLAUDE.md, audit the skills library, or asks "what's changed that our skills/docs don't cover yet" — periodic maintenance of this repo's always-loaded context and its .claude/skills/*.md files against recent commit history. Not for auditing a single strategy or PR; this is repo-wide context hygiene.
---

# Dhan Context Audit

## Overview
`CLAUDE.md` is loaded in full on every single prompt in this repo; `.claude/skills/*/SKILL.md`
files load only when their trigger matches. Left unchecked, CLAUDE.md accumulates
detail that's only needed for rare edge cases (burning tokens every prompt), and new
commit patterns pile up with no skill covering them (so Claude re-derives the same
fix from scratch next time, or misses a convention that's become standard). This
skill is the periodic maintenance pass for both. Run it whenever the user asks to
"optimize the context," "review the skills," or after a stretch of commits you
haven't looked at through this lens.

## When to Use
- User explicitly asks to review/trim/optimize `CLAUDE.md` or the skills library.
- User asks what recent work should turn into a new or updated skill.
- Not for reviewing a single diff/PR for bugs — that's `/code-review`.

## Procedure

### 1. Size up CLAUDE.md
`wc -l -c CLAUDE.md`. If a section reads as a multi-line paragraph explaining one
specific edge case (a field-name typo trap, a broker's epoch quirk, a route's import
precedence) rather than a rule that applies broadly, it's a candidate to move out.
Every fact in CLAUDE.md costs tokens on **every prompt in this repo forever** —
detail that's only relevant when someone is actively touching that one file/route
belongs in an on-demand doc instead: `docs/API_GOTCHAS.md` (create if needed, same
pattern) or the relevant skill. Leave CLAUDE.md holding: the command reference,
directory map, cross-cutting rules genuinely relevant to most edits (theming,
strategy dry-run defaults), and a one-line pointer to wherever the deep version lives.

### 2. Check memory for CLAUDE.md duplication
If this session has an auto-memory system (`MEMORY.md` + memory files), grep it for
content that now just restates CLAUDE.md — per the memory rules, anything already in
CLAUDE.md shouldn't also be a saved memory. This happens when a memory was written
before a fact made it into CLAUDE.md, or vice versa. Trim the duplicate, keeping
whichever copy has more detail, and fix any dangling `[[link]]` references left by a
deleted memory file.

### 3. Pull recent commit history and look for clusters
```bash
git log --oneline -60
```
Read the messages for **clusters** — 2+ commits touching the same file/component/
concern within a short span (e.g. three "fix(scalper): ... MTM history" commits, or
a run of "Wire X for broker-selectable execution" commits). A single one-off fix
usually isn't worth a skill; a cluster means the same mistake or the same new
convention is going to recur. For a promising cluster, `git show --stat <hash>` on
each commit to see which files moved and how much, then skim one representative
diff (`git show <hash> -- <path> | head -80`) rather than reading full diffs.

### 4. Check each cluster against existing skills
List `.claude/skills/*/SKILL.md` and read the ones whose trigger description sounds
adjacent to the cluster you found. Three outcomes:
- **Already covered, skill is stale** — the skill exists but doesn't mention the new
  file/convention (e.g. a new integration point that's become standard but the
  skill's "Quick Reference" doesn't list it). Update it in place — add a numbered
  invariant/section or a Common Mistakes line, don't rewrite the whole skill.
- **Adjacent but distinct concern** — e.g. a skill already covers live P&L math for
  the same component, but the new cluster is about a different feature (UI pattern,
  historical reconstruction). Add a new skill scoped to the distinct files/concern
  rather than overloading the existing one — narrow triggers match better and cost
  fewer tokens per pickup than one skill trying to cover everything in a component.
- **Truly new territory, and it's a recurring pattern** (2+ commits, or a fix
  explicitly described as "the same class of bug as X") — write a new skill,
  following the existing ones' shape: frontmatter `description` naming concrete
  trigger files, an Overview citing the commit hash(es), a When to Use list, then
  the actual rules/invariants with commit-hash citations, ending in Common Mistakes.
  Keep it to roughly the size of the existing skills (~80-160 lines, 5-9KB) — a
  skill this detailed is meant to be picked up once and followed, not read cover to
  cover as reference material.

### 5. Don't write a skill for a one-off refactor opportunity
If you spot dead code, near-duplicate components, or an obvious simplification while
reading diffs, that's not a recurring pattern to document — flag it with
`spawn_task` (a background-task chip the user can action separately) instead of
forcing it into a skill.

### 6. Update the CLAUDE.md skills pointer list
If you added a new skill, add a one-clause entry to CLAUDE.md's "Skills for
recurring work" list so it stays discoverable from the always-loaded doc, matching
the terse style of the existing entries.

### 7. Report, then ask before pushing
Summarize what changed (which skills updated/added and why, what moved out of
CLAUDE.md and where) in a few bullets. This is a repo-wide maintenance change, not a
feature — confirm with the user before committing/pushing, same as any other change
that touches shared files, unless they've already said to just do it.

## Common Mistakes
- Trimming CLAUDE.md by deleting detail instead of relocating it — the information
  still needs to live somewhere on-demand (a doc file or a skill), not disappear.
- Writing a new skill for a single commit with no cluster behind it — wait for a
  second occurrence, or fold it into an existing skill's Common Mistakes list instead.
- Growing one skill indefinitely instead of splitting when the concern is genuinely
  distinct — check the existing skill's own stated scope ("Not for X — see
  dhan-other-skill") before appending to it.
- Skipping the memory-duplication check (step 2) — CLAUDE.md edits alone don't catch
  memory files that now say the same thing.
