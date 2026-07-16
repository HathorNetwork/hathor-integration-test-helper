# Pull request descriptions

How to write the PR **body** for this repository. The goal is a description a
reviewer can read in one pass to know exactly what this PR changes, why, and
how to judge it done — nothing more.

## Structure

A PR body has these parts, in order. Only **Acceptance criteria** is
mandatory; include the others when they carry weight.

1. **Opening paragraph** (no heading). One or two sentences: what this PR
   ships, and how it fits — what it builds on, what it defers, which milestone
   or RFC section it serves. Scope it against work already merged so a reader
   never mistakes prior work for this change (see [Scope honestly](#rules)).

2. **`## How it works`** (mechanism-heavy PRs) or **`## What's included`** /
   **`### Changes`** (module/surface lists). A bulleted, per-module list —
   `**module-name**` — one-line description of what it does or how it changed.
   Mark genuinely new files or surface as `(new)`.

3. **`## Behavioral change`** or **`### Breaking changes`** — only when the PR
   changes existing behavior. State it explicitly, including the migration for
   any consumer. Say "No existing consumers" / "No breaking changes" when that
   is itself the point.

4. **`## Acceptance criteria`** (always). Two to four bullets, each a
   verifiable outcome a reviewer can confirm. These are what "done" means.

## Rules

- **Scope honestly.** Describe only what *this* PR's diff adds. For anything it
  builds on, reference the earlier PR instead of re-describing its work as new.
  Confirm scope against the diff (`git diff --stat <base>...HEAD`,
  `git diff --name-status <base>...HEAD`) rather than from memory — in a PR
  chain it is easy to attribute a merged PR's feature to the current one.
- **Reference issues/PRs with the full `owner/repo#N` form** (e.g.
  `Closes HathorNetwork/hathor-integration-test-helper#6`), never a bare `#N`:
  bare numbers auto-link unpredictably and read ambiguously.
- **No "What to Test" / "How to Test" section.** CI runs the suite; the
  Acceptance criteria state the outcomes. Do not duplicate test steps here.
- **Be concise.** Prefer a tight per-module bullet list over prose paragraphs.
- **Preserve bot-generated blocks when editing.** CodeRabbit appends a
  `Summary by CodeRabbit` block wrapped in
  `<!-- ...auto-generated comment: release notes by coderabbit.ai... -->`
  markers. Splice new content *above* it and keep the block verbatim; never
  regenerate or drop it. Fetch the current body first
  (`gh pr view N --json body --jq .body`), edit above the block, write back.

## Metadata

- Assign new PRs to `tuliomir`.
- Labels: `enhancement` for a feature, `bug` for a bugfix, `dependencies` for
  dependency bumps. There is no `tests` label — a test-only PR takes the label
  of the change it belongs to.

## Template

```markdown
<One or two sentences: what this ships and how it fits — what it builds on,
what it defers. Reference prior work as owner/repo#N.>

## How it works

- **module-a** (new) — <what it does>.
- **module-b** — <what changed>.

## Acceptance criteria

- <verifiable outcome a reviewer can confirm>.
- <verifiable outcome a reviewer can confirm>.
```
