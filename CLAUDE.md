# Hathor Integration Test Helper

HTTP service that generates test wallets and provides race-condition-free
funding for Hathor Wallet Lib integration tests.

Architecture notes are added incrementally per layer as PRs land.

## Architecture

### Genesis & readiness layer

The funding subsystem boots in the background via `bootstrapFunding()`
(`src/startup.ts`), gated by `FUNDING_ENABLED` (default `true`). It owns
a coarse lifecycle phase (`idle → initializing → ready | disabled |
degraded`) surfaced by `GET /status`. `src/genesis.service.ts` connects
and syncs the genesis wallet; a bad seed or unreachable fullnode lands in
`degraded` without taking the HTTP server down. `GET /ready` and
`/status` share the pure `computeReadiness()` verdict in `src/routes.ts`.
Readiness gates on the genesis *wallet*, not the pool: once genesis is
up, `currentReadiness()` calls `isGenesisFunded()` (a single `getUtxos`
query) and reports `wallet_unfunded` until the wallet holds spendable
UTXOs (a still-height-locked block reward counts as unfunded), or
`funds_query_error` if that query throws. Endpoint and readiness-reason
tables live in [`README.md`](README.md).

Test seams (readiness, startup) use dependency injection, not
`mock.module` — Bun's module mocks are process-global and leak across
test files.

## Specification

The service is governed by the approved RFC:
https://github.com/HathorNetwork/rfcs/blob/master/projects/hathor-wallet-lib/0000-integration-test-helper.md

The RFC is the canonical behavioral contract. Code in this repository
should follow it; deviations are bugs.

## Development conventions

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package>` instead of `npx <package>`
- Bun automatically loads `.env`, so don't use dotenv.

### Bun APIs

- `Bun.serve()` for HTTP (not express)
- `Bun.file` over `node:fs` readFile/writeFile

### Git commits

Conventional Commits format:
- Title: max 50 characters, e.g. `feat: add UTXO pool`
- Body: wrap lines at 72 characters
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Releases

**Never create or push a `v*` tag without an explicit human request for
that specific release.** Pushing a `vMAJOR.MINOR.PATCH` tag triggers
[`.github/workflows/docker.yml`](.github/workflows/docker.yml), which
publishes `hathornetwork/hathor-integration-test-helper:<version>` and
moves `:latest` on DockerHub. That is public and irreversible — a
published image can only be superseded, never unpublished.

`package.json` is the source of truth for the published version. The
workflow refuses to publish unless the pushed tag matches it exactly,
so a release is two steps: merge the `version` bump, then tag that
merged commit. Bumping the version is ordinary work; the *tag* is the
release. Agents prepare the tag command and hand it over — a human runs
it.

**Only a signed tag on a signed commit deploys.** The workflow verifies
both through GitHub's API and refuses anything else, so the release tag
must be annotated *and* signed — `git tag -s`, not `git tag`. A
lightweight tag carries no signature and is rejected outright. This is
what makes the human touch load-bearing rather than conventional:
ancestry proves the code was reviewed, the signature proves who asked
for it to ship.

Published versions are immutable. The workflow also refuses to publish
a version that already exists on DockerHub, so re-releasing is never an
option — the only way forward is a bump.

**A publish that fails after the push cannot be retried.** The
immutability check is what makes re-running the job fail, so recovery is
always "bump, merge, tag again", never "re-run the workflow". Budget for
that before cutting a release; discovering it mid-incident is expensive.
A run that fails *before* the push leaves DockerHub untouched and can be
re-run safely — every guard deliberately runs ahead of the push, and
`Build and push` is the last step. The one unrecoverable state is a
partial failure inside that step: `:<version>` lands but `:latest` does
not, and the bump-and-retag recovery leaves that version permanently
non-`latest`.

**The workflow is the only sanctioned publish path.** `make push` builds
single-arch and skips every guard, so it has no default registry and
refuses to run without an explicit `DOCKER_REGISTRY`; `:latest` is never
pushed from the Makefile. `docker push` and `make push` are on the deny
list for the same reason the tagging commands are.

Snapshot or pre-release tags (anything with a `-`, e.g.
`v0.0.1-20260728`) are skipped by the workflow rather than failed, so
they never publish and never produce a red run.

`.claude/settings.json` denies the tagging commands as a backstop, not
as a hard boundary — patterns cannot reliably see through compound
commands. It also denies read-only `git tag -l`; list tags with
`git for-each-ref refs/tags` or `git ls-remote --tags origin` instead.

## Review rules

PR review conventions live in [`docs/review-rules/`](docs/review-rules/)
— one rule per file. New conventions go there, not inline here.
