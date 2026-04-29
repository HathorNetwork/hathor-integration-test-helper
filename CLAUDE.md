# Hathor Integration Test Helper

HTTP service that generates test wallets and provides race-condition-free
funding for Hathor Wallet Lib integration tests.

This file is currently a stub. As subsequent PRs land (foundation
utilities, wallet endpoints, genesis lifecycle, UTXO pool, fund flow,
resilience, integration test harness, project docs), the relevant
architecture notes will be added incrementally per layer.

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
