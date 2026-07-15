# The north-star preview branch workflow

This repository is built as a **chain of small, reviewable PRs** cut
from a single long-lived branch that already holds the finished system:
`preview/final-state`, the *north-star* branch. This document explains
what that branch is, how it relates to `main` and to the per-feature
PRs, and — most importantly — the rules for keeping it honest as `main`
advances underneath it.

It is written to be reusable. ITH is the testing ground for this
process; the mechanics here are meant to transplant to any repository
that ships a large body of work as an ordered series of PRs.

## What the north-star branch is

`preview/final-state` is the **known-good final state** of the migration
— the whole system, working, as a linear history. Each logical chunk of
that history is destined to become one PR against `main`. The north-star
branch is therefore two things at once:

- a **reference** — proof the end state integrates and works, so each
  PR is carved with the destination already in view; and
- a **queue** — the ordered backlog of not-yet-merged work.

It is deliberately *not* a branch we merge. We never open a PR from
`preview/final-state` itself. We carve slices out of it.

## The core invariant

> At any moment, `preview/final-state` should equal
> **current `main`** + **the not-yet-merged tail**, replayed on top and
> reconciled against `main`'s reviewed reality.

Everything below follows from this one sentence. When it drifts from
being true — because a PR merged, or because we improved the north-star
directly — we do a **rebuild** to make it true again.

## Why the branch decays (and must be rebuilt)

Every time a PR merges into `main`, two things happen to that slice of
work:

1. It becomes **redundant** on the north-star branch — `main` now has
   it, so re-carrying it would duplicate merged work.
2. It becomes **authoritative elsewhere** — the *reviewed* version in
   `main` is now the source of truth, and it is usually **not** what the
   north-star branch held. Review changes real code: interfaces get
   renamed, async becomes sync, whole modules get rewritten.

So the north-star branch's merged head-slices are worse than useless:
they are a second, *diverging* copy of code that already lives in
`main`, and they fight every future rebase. The branch's only enduring
value is the **not-yet-merged tail**. A rebuild discards the merged
slices and re-bases that tail onto the new `main`.

This is the "rebuild, not transplant" principle: we do not lift the old
commits verbatim, we replay the *pending work* against the *reviewed*
base and fix it up to fit.

## The rebuild procedure

When `main` has advanced (one or more PRs merged) or the north-star
branch has picked up direct improvements, rebuild:

1. **Back up first.** Tag or branch the current tip
   (`backup/preview-YYYYMMDD`) so nothing is unrecoverable. The remote
   `origin/preview/final-state` and any state tags are also safety nets.
2. **Identify the boundary.** List the north-star commits above the old
   base. Sort each into *merged* (its reviewed form is now in `main`) or
   *pending* (still owed to `main`).
3. **Reset onto `main`.** The new base is current `origin/main`.
4. **Replay the pending tail**, commit by commit (cherry-pick or
   `rebase --onto`), reconciling each against `main` (see below).
5. **Drop the merged slices** entirely — `main` owns them now.
6. **Drop anything `main` made moot** — see the reconciliation rules.
7. **Verify the whole tree** (typecheck + tests). A clean replay is not
   a correct replay (see "Textual vs semantic conflicts").
8. Keep process/meta docs (like this file) at the **tip**, above the
   pending feature work, so they never leak into a carved feature PR.

## Reconciliation rules

A rebuild reconciles the pending tail against **two** moving fronts. Get
both, per commit, or the north-star lies.

### Base side — reconcile against `main`'s reviewed code

The pending work was written against the *old* versions of whatever
merged. Replaying it onto `main` means adapting it to the **reviewed**
interfaces. This is where the real work lives, and it is a per-commit
judgement, not a mechanical `git` operation.

### Head side — reconcile direct improvements, per commit

Improvements made directly on the north-star branch (commits above the
last state tag, amendments, fixes) must also survive the rebuild — but
they are **reconciled against the new base, not blindly carried**:

- **Keep + re-target** if the improvement still applies to `main`'s
  reviewed code, adjusting it to fit.
- **Drop** if `main`'s review already subsumed it. A head improvement
  that fixes code the base has since rewritten away re-applies to
  nothing — carrying it forward is pure conflict noise that
  re-introduces zero value.

> The rule is **"reconcile head against base," not "always carry head."**
> A fix to a line the base deleted is a fix to nothing.

This drop rule applies regardless of where the head improvement came
from — a fresh commit at the tip or one buried under an older state tag.
Obsolete is obsolete.

## Textual vs semantic conflicts

`git` only detects **textual** conflicts — two edits to the same lines.
The dangerous class in this workflow is the **semantic** conflict:

- A new file the pending work adds applies **cleanly** — `git` sees no
  conflict — yet calls an interface the base renamed, removed, or
  changed from async to sync. It compiles nowhere.
- A shared file's edit applies cleanly to text that *moved meaning*
  underneath it.

**The typecheck and the test suite are the real conflict detector here,
not `git`.** A rebuild is only done when the whole tree builds and the
tests pass — never when the replay merely applied without complaint.

## Granularity: shuffle, don't pre-squash

The pending tail is kept as an **ordered, granular series** — one
logical commit per concern — right up until a PR is actually opened.
When improvements or review fixes arrive, they are ordered next to the
commit they belong with; they are folded (squashed) into it **only at
PR-open time**.

Rationale over the alternative (folding everything into "final" commits
immediately):

- Squashing rewrites history and is **lossy** — once folded you cannot
  see what a given fix changed, and it cannot be re-reviewed in
  isolation.
- Granular commits stay individually reviewable and keep an audit trail
  of every reconciliation.
- The only irreversible step (squash) is deferred to the moment the PR
  boundary is certain.

So: **reorder freely, squash late.**

## Carving a PR from the north-star

A feature PR is a **slice** of the pending tail, diffed against current
`main`:

- The PR's content is `git diff origin/main...<slice-tip>` for the
  slice's commits.
- Because the tail was already reconciled against `main` during the
  last rebuild, the slice reflects **both** the reviewed base and any
  surviving head improvements — which is the whole point.
- Process/meta docs living at the branch tip are above every feature
  slice, so they are naturally excluded from feature PRs. (Planning and
  workflow docs are not feature-PR reviewer scope.)

## Conventions

- **Unsigned.** `preview/final-state` is pushed unsigned. It is a
  north-star reference, not a branch that becomes a PR as-is, so it
  never needs the signature a mergeable branch does. Carved feature
  PRs get signed at their own push-ready moment, not here.
- **State tags.** Snapshots of a good north-star state are tagged
  `v0.0.1-YYYYMMDD` so a rebuild has named recovery points and so
  "improvements since the last state" have a clear lower bound.
- **Commit messages** follow the repo's Conventional Commits rules.

## Checklist for a rebuild

- [ ] Backed up the current tip.
- [ ] Sorted every above-base commit into merged / pending.
- [ ] Reset onto current `origin/main`.
- [ ] Replayed the pending tail, reconciled against reviewed base.
- [ ] Dropped merged slices and base-subsumed head improvements.
- [ ] Verified: whole tree typechecks and tests pass.
- [ ] Meta/process docs sit at the tip, above feature work.
- [ ] Pushed unsigned.
