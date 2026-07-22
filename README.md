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
| `genesis_wallet_not_ready`   | `false` | Funding on, genesis still syncing (or the genesis wallet never became ready) |
| `funding_degraded`           | `false` | Genesis ready, but the funding bootstrap degraded (e.g. the initial split could not seed the pool) — never ready even if the wallet later shows funds |
| `wallet_unfunded`            | `false` | Genesis ready, but the wallet holds no spendable UTXOs (e.g. a block reward still height-locked) |
| `funds_query_error`          | `false` | Genesis ready, but the wallet funds query failed — funding state is unknown |
| `ready`                      | `true`  | Genesis ready and the wallet holds spendable UTXOs |

`/status` additionally reports a `startup.phase` of `idle`,
`initializing`, `ready`, `disabled`, or `degraded`. A bad seed or an
unreachable fullnode lands in `degraded` **without** taking the service
down — the wallet endpoints keep serving.

### Health checks

`/ready` is the endpoint to wire into a container `HEALTHCHECK` or a
docker-compose `depends_on: { condition: service_healthy }` gate — it is
a readiness probe, returning `200` only when the service can serve its
intended workload. Use `/live` for liveness (restart-if-dead), not for
gating dependents; `/status` is always `200` and is for humans.

For the wallet-provider drop-in (`FUNDING_ENABLED=false`), `/ready`
returns `200 funding_disabled` as soon as the server is up — a correct
and future-proof healthcheck (the same gate keeps working once funding
lands). Example compose service (the image ships `bun`, so no `curl`
needed):

```yaml
test-wallet-helper:
  image: hathor-ith
  environment:
    FUNDING_ENABLED: "false"
  healthcheck:
    test:
      - CMD
      - bun
      - -e
      - "fetch('http://127.0.0.1:3020/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    interval: 5s
    timeout: 3s
    retries: 10
```

> ℹ️ With `FUNDING_ENABLED=true`, `/ready` reflects the genesis wallet
> and the funding bootstrap: it returns `200 ready` once the wallet
> holds spendable UTXOs and the bootstrap completed, and `503
> wallet_unfunded` until then — including the startup window where the
> genesis block reward is still height-locked (it becomes spendable as
> blocks are mined). A bootstrap that could not seed the pool stays `503
> funding_degraded` even after the wallet shows funds — that state does
> not self-heal, so a stuck-degraded stack needs operator attention, not
> more retries. Gating a funding-enabled stack on `/ready` is
> correct; just allow enough healthcheck retries to cover that initial
> reward-lock window.

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
