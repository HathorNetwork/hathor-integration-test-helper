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

## Improving already-merged base code

Not every change on the north-star is new feature work. Sometimes, while
building the pending tail, you realise a *merged* interface should change
— the reviewed base got something slightly wrong, or a new capability
makes an old decision worth revisiting. The north-star is a fine place to
make that improvement, but it needs handling distinct from both feature
work and head-vs-base reconciliation:

- **It is a base-touch.** The change edits code that already lives in
  `main`, so its diff against `main` is a *modification*, not a pure
  addition. Flag it as such — a reviewer seeing a merged function change
  should know it is deliberate, not a stray rebase artifact.
- **Decide where it lands.** Two clean homes:
  - *Ride with a feature PR* that already touches the same area and whose
    story it belongs to. Lowest overhead when the improvement is part of
    the feature's reason to exist.
  - *Stand alone as a small follow-up PR* when it is orthogonal to any
    pending feature, or when you want the feature PR's diff to stay purely
    additive for easier review.
- **Keep it a separate commit** either way, so the "ride with / split
  out" decision stays reversible until carve time — same reorder-freely,
  squash-late discipline as the rest of the tail.

**Worked example (2026-07-16).** Readiness (`computeReadiness`, merged in
the genesis PR) originally gated `/ready` on the *test pool* being
non-empty. Building the funding path made a better rule obvious: gate on
whether the *wallet* holds funds — the source of truth — since the
service can fund clients (small from the pool, large wallet-sourced) even
with an empty pool between splits. That improvement edits merged base
code (`utxo_pool_empty` → `wallet_unfunded`, and the function goes from
pool-stats input to a `walletFunded` boolean). It was kept as its own
`refactor:` commit in the feature stack, riding with the fund PR because
it *is* the wallet-sourced-funding idea — but a one-commit follow-up PR
was equally available.

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

## Worked example: the fund rebuild (2026-07-15)

The first real rebuild under this workflow — replaying the funding
subsystem onto `main` after the UTXO-pool PR merged — proved out the
rules above and taught a few concrete lessons worth keeping.

**The base had drifted far.** The merged pool PR was not a tweak of the
north-star's version — review rewrote ~half the file: `reserveUtxo`
went **async → synchronous**, the whole "large UTXO slot" was removed in
favour of wallet-sourced large funding (`reserveLarge`), and the
`UtxoSource` `"leftover"` variant was dropped. The north-star's genesis
and pool commits were correspondingly stale, so they were dropped
wholesale and only the 8 pending fund commits were replayed.

**The dangerous conflicts were the ones `git` stayed silent on.** Of the
8 replayed commits, `git` flagged textual conflicts in only two files
(both just a docstring). Everything else applied "cleanly" — including a
brand-new `fund.service.ts` that called `setLargeUtxo` and
`await reserveUtxo(largeAmount)`, neither of which exists in the reviewed
pool. `git` cannot see that; **the typecheck is what surfaced it** (three
`Property 'largeUtxoAmount' does not exist on type 'PoolStats'` errors,
plus a pile of call-signature mismatches). Treat a green `git` replay as
step one, never as done.

**Reconciliation rippled into the tests, in two layers.** The stale pool
shape broke tests the typecheck caught (a fake returning
`{ testUtxos, leftoverUtxos, largeUtxoAmount }`). But it also invalidated
behavioural *assertions* the typecheck could not catch — a split test
asserting the change output landed in a large slot, another asserting a
`leftover` count. Those needed a human read of intent, not a compiler.
Two tests that had differed only by the now-deleted `largeUtxoAmount`
field collapsed into one.

**A base change can force a genuine product decision.** With large
outputs no longer visible in pool stats, `startup` could no longer cheaply
tell "empty pool but a large exists → split" from "entirely empty → skip
split, stay ready". The reconciliation had to *pick* a behaviour (kept:
an entirely-empty wallet stays `ready` with an empty pool, it does not
`degrade`) and that choice is exactly the kind of thing to flag to the
human, not bury in a rebase. Reconciliation is not always mechanical.

**Fold reconciliation into the commit that introduced the code.** To keep
each pending commit correct-against-`main` (so it stays cleanly
cherry-pickable), the fix-ups were folded into their origin commits with
autosquash rather than tacked on as a trailing "fix everything" commit:

```
git add <ported files>
git commit --fixup=<origin-sha>       # once per origin commit touched
GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <base-sha>
```

**Signing gotcha during a rebuild.** `git cherry-pick --continue` and
`git rebase` re-commit under the repo's `commit.gpgsign` setting and do
**not** honour a `--no-gpg-sign` passed to `--continue`. On a signing-by-
default setup this aborts mid-rebuild with `gpg: signing failed`. Since
the north-star is unsigned anyway, run the rebuild's git operations with
signing off — prefer the per-invocation form so no surprising persistent
state is left behind:

```
git -c commit.gpgsign=false cherry-pick ...
git -c commit.gpgsign=false rebase ...
```

**Reconciliation is a fair chance to improve the design.** Porting the
large-funding path the base now prescribes was a natural moment to
centralise "find a large wallet output and reserve it" into one helper
reused by both `startup` and `fund.service`, instead of duplicating the
old stat-reading logic in two places. Improving code you must touch
anyway is in-scope; unrelated refactoring is not.
