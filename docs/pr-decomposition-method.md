# Sizing and cutting PRs before you write them

A companion to [`preview-workflow.md`](preview-workflow.md). The north-star
workflow says *how* to carve slices from the finished branch; this doc says
*how big a slice should be and where to cut it* — decided **before** the code
is written, so no scope is ever re-sliced reactively.

This is process, not project: it is meant to transplant to any repository that
ships a large body of work as an ordered series of PRs.

## The failure this prevents

The `/fund` subsystem shipped as one ~840-prod-line PR, was reviewed in full,
and was **rejected for size, not correctness**. It had already been divided
once (`[pool]` then `[fund]`) and the `[fund]` half was *still* too big, so it
had to be re-sliced into three PRs after review. A scope that *feels* divided
can still be a monolith.

## The unit of size: reviewable production lines

Raw diff lines mislead. That 3.1k-line diff was only ~840 lines a reviewer had
to reason about. Bucket every planned PR:

| Bucket | Cognitive load | Counts toward size? |
| --- | --- | --- |
| Production code | high — the logic under review | **yes** |
| Tests | low per line — they verify, they don't surprise | no (but see below) |
| Comments / JSDoc | low | no |
| Blank | none | no |

Target band: **≤ ~350 prod lines per PR**, ideally near the size the team has
already reviewed comfortably (in this repo: the ~200-prod-line pool PR #13).
Treat ~840 prod lines as the known-too-big ceiling.

## Cut on the natural seam, up front

- **File/module boundaries are the cut lines.** If `a.ts` calls `b.ts`
  one-directionally, "`b` then `a`" is two PRs with no code movement. The
  `/fund` reslice was cheap precisely because `fund.service → split.service`
  was already a one-way file seam.
- **Only hunk-split the few files that genuinely span parts** — a router with
  per-feature handlers, a metrics module with per-feature counters. Everything
  else stays whole-file-per-part.
- **Verify the dependency graph is acyclic and forward** (`P3 → P2 → P1 →
  main`) before cutting. An import from a later part into an earlier one won't
  typecheck when the earlier part ships alone.

## Each part stands alone

- Merges to a **working `main`** on its own (typecheck + tests green).
- **Strictly linear** — part N builds on N−1, never a mutual pair.
- Standalone-green is the gate, **not** byte-identity with the original
  monolith. Making parts independent forces honest intermediate states (a
  metrics snapshot that lists only the counters shipped so far; a `/status`
  field added in an early part and completed in a later one). Review the
  residual diff against the original as a **compromise ledger** — every
  deviation intentional, not accidental. (Worked example in
  [`preview-workflow.md`](preview-workflow.md).)

## Tests get their own considerable PR

Review-size discipline applies to tests too. If a feature ships as several
~350-prod-line PRs, the *full* end-to-end suite that exercises it is itself a
substantial body of work — it deserves its own dedicated PR, not to be
smuggled into a feature slice nor reduced to a token smoke test. Split the two:

- a minimal **smoke** — proving the stack boots and the happy path works — can
  ride with the harness / compose-stack PR;
- the **comprehensive suite** — every error code, every invariant, under a
  real stack — is a first-class PR of its own, sized and reviewed like any
  other.

Sending 800-line feature PRs and then a one-assertion smoke test is a false
economy: the integration proof is where the real risk lives, so it earns real
review.

## Plan the whole road once

Estimate reviewable-prod-lines for **every** intended PR to the milestone
*before* writing the first one (for this project, see
[`roadmap.md`](roadmap.md)). Pre-cut anything inherently large into its slices
now — the moment a scope "feels like one feature" is the moment to check
whether it is secretly three.
