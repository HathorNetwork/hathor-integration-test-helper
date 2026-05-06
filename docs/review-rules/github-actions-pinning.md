---
id: github-actions-pinning
title: Pin GitHub Actions and reusable workflows to commit SHAs
severity: must
applies-to:
  - .github/workflows/*.yml
  - .github/workflows/*.yaml
  - .github/actions/**/*.yml
  - .github/actions/**/*.yaml
rationale-summary: >-
  Mutable tags (@v4, @main) can be re-pointed by a compromised
  maintainer to malicious code that runs with the workflow's
  secrets. Commit-SHA pins freeze the exact code that executes.
---

## Rule

Every `uses:` reference to an external GitHub Action or reusable
workflow MUST be pinned to a full 40-character commit SHA, with a
human-readable version comment alongside it.

Required form:

```
uses: owner/repo@<40-hex-sha> # <human-readable-tag-or-version>
```

For example:

```yaml
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

The `# <version>` comment is not decorative — Dependabot reads it to
bump the SHA and the version label together in the same PR. A pinned
action without the comment still updates safely, but the maintainer
loses the human-readable trail.

This rule applies to:

- Top-level actions: `uses: owner/repo@<ref>`
- Reusable workflows: `uses: owner/repo/.github/workflows/foo.yml@<ref>`

Exceptions (out of scope for this rule):

- Local actions referenced by path: `uses: ./.github/actions/foo`.
  The ref is the working tree, so a SHA pin is meaningless.
- Docker image refs: `uses: docker://image:tag`. Image-digest
  pinning is a separate threat model and would belong in its own
  rule.

## Why

GitHub Actions tags such as `@v4` are git refs on the action's
repository — they are mutable. A compromised maintainer (or an
attacker holding a stolen token) can re-point `@v4` to a malicious
commit. Every workflow consuming `@v4` will then run that code on
its next trigger, with full access to whatever secrets the workflow
binds to it (`GITHUB_TOKEN`, deploy keys, registry credentials).

A 40-character commit SHA is content-addressable: the same SHA
always resolves to the same source tree. Pinning closes the
re-targeting path entirely.

The trade-off is that pinned actions do not auto-update. That is
why this repository ships a Dependabot configuration
(`.github/dependabot.yml`) for the `github-actions` ecosystem.
Dependabot recognises the `@<sha> # <version>` convention and opens
PRs that bump both the SHA and the human-readable comment in
lockstep. The result is the safety of SHA pinning combined with a
structured, reviewable update flow.

## How to check

For each changed file matching `applies-to`:

1. Parse every `uses:` value in the YAML document.
2. If the ref is a local path (starts with `./` or `../`) or a
   docker URI (starts with `docker://`), skip it.
3. Otherwise, take the substring after the last `@`. It MUST match
   `^[a-f0-9]{40}$`.
4. The same `uses:` line MUST contain a trailing comment of the form
   `# <token>` immediately after the ref (on the same physical
   line). Dependabot relies on this comment.
5. Flag any failure with severity `must`.

## How to fix

1. Open the action's repository on GitHub (e.g.
   `https://github.com/actions/checkout`).
2. Pick the release you want — a tag like `v6.0.2`. Every release
   page lists the commit SHA the tag points at.
3. Rewrite the ref:

   Before:

   ```yaml
   uses: actions/checkout@v4
   ```

   After:

   ```yaml
   uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
   ```

4. Commit the workflow change. From this point on, Dependabot will
   keep the pin current — see `.github/dependabot.yml`. If
   Dependabot is disabled or misconfigured, fix that first; without
   it, SHA-pinned workflows silently drift behind upstream security
   fixes.
