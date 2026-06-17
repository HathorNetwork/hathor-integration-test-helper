# Hathor Integration Test Helper

HTTP service that generates test wallets and provides
race-condition-free funding for [hathor-wallet-lib](https://github.com/HathorNetwork/hathor-wallet-lib)
integration tests.

## Status

Bootstrap. The repository is being seeded as a chain of small,
reviewable PRs. See the tracking issue for the full PR sequence.

## Specification

The behavior of this service is governed by the approved RFC:

📐 [`HathorNetwork/rfcs` — Integration Test Helper](https://github.com/HathorNetwork/rfcs/blob/master/projects/hathor-wallet-lib/0000-integration-test-helper.md)

That RFC is the canonical contract. Anything that conflicts with the
RFC in this repository should be treated as a bug.

## Local development

Requires [Bun](https://bun.sh/) 1.3.9 or later.

```sh
bun install
bun run check    # typecheck + unit tests
bun run start    # boot the placeholder server
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the local quality gate
and PR conventions.

## Running as a wallet provider

The wallet endpoints can stand in for hathor-wallet-lib's static precalculated
wallet pool: `/simpleWallet` returns the `{ words, addresses }` shape the Lib
derives its precalculated wallets into. This serves wallet material only —
funding stays Lib-managed.

```sh
docker build -t hathor-ith .
docker run --rm -p 3020:3020 hathor-ith
```

With no env supplied the image uses defaults kept equal to wallet-lib's
integration constants (testnet, the privnet node/tx-mining URLs, and the genesis
seed), so it is plug-and-play for the Lib CI. Override any at run time, e.g.
`-e HATHOR_NODE_URL=...`.
