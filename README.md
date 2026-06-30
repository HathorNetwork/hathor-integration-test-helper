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

## HTTP endpoints

| Method | Path              | Purpose                                            |
| ------ | ----------------- | -------------------------------------------------- |
| `GET`  | `/simpleWallet`   | Pop a pre-generated 24-word wallet with 22 addresses |
| `GET`  | `/multisigWallet` | Generate N-of-M multisig wallets (`participants`, `numSignatures` query params) |
| `GET`  | `/status`         | Operator diagnostic: readiness, pool counts, genesis address, bootstrap phase |
| `GET`  | `/ready`          | Readiness probe — `200` when ready, `503` otherwise |
| `GET`  | `/live`           | Liveness probe — always `200`                      |

`/fund` and `/metrics` arrive with the funding milestone. A canonical
OpenAPI document lands with the project-docs PR.

### Readiness semantics

`/ready` and `/status` share one verdict, evaluated in this order:

| `readyReason`                | `ready` | Meaning                                          |
| ---------------------------- | ------- | ------------------------------------------------ |
| `funding_disabled`           | `true`  | `FUNDING_ENABLED=false` — wallet-generation-only mode |
| `genesis_wallet_not_ready`   | `false` | Funding on, genesis still syncing (or degraded)  |
| `utxo_pool_empty`            | `false` | Genesis ready, but no spendable UTXOs yet        |
| `ready`                      | `true`  | Genesis ready and the pool has funds             |

`/status` additionally reports a `startup.phase` of `idle`,
`initializing`, `ready`, `disabled`, or `degraded`. A bad seed or an
unreachable fullnode lands in `degraded` **without** taking the service
down — the wallet endpoints keep serving.

## Funding modes

`FUNDING_ENABLED` (default `true`) selects how the service runs:

- **Funding enabled** (default) — at startup the service initializes the
  genesis wallet against the configured fullnode and will offer on-chain
  funding. This targets the hathor-wallet-lib integration stack, which
  has a fullnode available.
- **Funding disabled** (`FUNDING_ENABLED=false`) — genesis is never
  touched and `/ready` reports `200 funding_disabled`. Use this for the
  wallet-provider drop-in described below, which needs no fullnode.

## Running as a wallet provider

The wallet endpoints can stand in for hathor-wallet-lib's static precalculated
wallet pool: `/simpleWallet` returns `{ words, addresses }` plus a `retrieveTimeMs`
latency field (and `/multisigWallet` returns `{ wallets, retrieveTimeMs }`). This
serves wallet material only — funding stays Lib-managed.

```sh
docker build -t hathor-ith .
docker run --rm -p 3020:3020 -e FUNDING_ENABLED=false hathor-ith
```

`FUNDING_ENABLED=false` keeps this a pure wallet provider: no fullnode is
required and `/ready` reports `200`. Leave funding enabled only when a
fullnode is reachable (e.g. the Lib integration stack).

With no other env supplied the image uses defaults kept equal to wallet-lib's
integration constants (testnet, the privnet node/tx-mining URLs, and the genesis
seed), so it is plug-and-play for the Lib CI. Override any at run time, e.g.
`-e HATHOR_NODE_URL=...`.
