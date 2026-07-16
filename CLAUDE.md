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

### Pull request descriptions

PR body conventions live in
[`docs/pr-descriptions.md`](docs/pr-descriptions.md) — structure, the
scope-honestly rule, metadata, and a template for writing a PR body.

## Review rules

PR review conventions live in [`docs/review-rules/`](docs/review-rules/)
— one rule per file. New conventions go there, not inline here.
