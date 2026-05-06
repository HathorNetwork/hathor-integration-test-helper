---
id: dependency-pinning
title: Pin all dependency versions
severity: must
applies-to:
  - package.json
  - bun.lock
rationale-summary: >-
  Floating ranges (^, ~, latest, *) re-resolve on every install,
  exposing the project to compromised releases shipped under the
  same range. Exact versions force every upgrade to be a deliberate,
  reviewable change.
---

## Rule

Every version specifier in `package.json` MUST be an exact semver
string. This applies to `dependencies`, `devDependencies`,
`peerDependencies`, and `optionalDependencies` alike.

A specifier is acceptable if and only if it matches:

```
^\d+\.\d+\.\d+(-[\w.+-]+)?$
```

Examples that are allowed: `3.0.1`, `1.3.9`, `5.9.3`, `1.0.0-rc.2`.

Examples that are NOT allowed: `^3.0.1`, `~1.3.9`, `>=5`, `5.x`,
`*`, `latest`, `next`, `=3.0.1`.

## Why

Floating ranges resolve to whatever version satisfies the range at
install time. A compromised package published under the same range
(typosquat, account takeover, or a malicious patch release) will be
silently picked up on the next fresh install.

Pinning closes that path. An upgrade then becomes a deliberate edit
to `package.json`, visible in a PR diff, reviewable like any other
behavioural change.

The lockfile (`bun.lock`) already pins transitive dependencies to
exact versions, and CI runs `bun install --frozen-lockfile`, but
those defenses only cover the resolve step. A range left in
`package.json` still re-resolves the moment anyone runs
`bun install` without `--frozen-lockfile` (e.g. a contributor on a
fresh checkout). Pinning the manifest closes the loop.

## How to check

For each changed `package.json`:

1. Parse the four dependency blocks (`dependencies`,
   `devDependencies`, `peerDependencies`, `optionalDependencies`).
2. For every value in those blocks, verify it matches
   `^\d+\.\d+\.\d+(-[\w.+-]+)?$`.
3. If any value fails, flag the line with severity `must`.

For each changed `bun.lock`:

1. For every top-level workspace dependency, verify the pinned
   version in the lockfile matches the exact string in
   `package.json`. A mismatch means `bun install` was not run after
   editing the manifest.

## How to fix

1. Update the offending range in `package.json` to the exact
   version currently resolved in `bun.lock` (or the explicit
   version you intend to adopt).
2. Run `bun install` — `bun.lock` updates to match the manifest.
3. Run `bun run check` to confirm nothing regressed.
4. Commit `package.json` and `bun.lock` together.

When a dependency genuinely needs to move forward, treat it as a
separate, deliberate change: bump the pinned version, refresh the
lockfile, run the quality gate, and submit it on its own merits.
