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
| `GET`  | `/status`         | Operator diagnostic: readiness, pool counts, genesis address, bootstrap phase, funding lifecycle |
| `GET`  | `/ready`          | Readiness probe — `200` when ready, `503` otherwise |
| `GET`  | `/live`           | Liveness probe — always `200`                      |
| `POST` | `/fund`           | Reserve a pool UTXO and send funds to an address   |
| `GET`  | `/metrics`        | JSON snapshot of per-route and funding counters    |

A canonical OpenAPI document lands with the project-docs PR.

### `POST /fund`

Request body (`application/json`):

| Field     | Required | Type            | Meaning                                          |
| --------- | -------- | --------------- | ------------------------------------------------ |
| `address` | yes      | string          | Destination Hathor address (validated for the configured network) |
| `amount`  | no       | number \| digit-string | Amount in the smallest unit; defaults to `UTXO_SPLIT_AMOUNT`. Use a digit-only string for values beyond the JS safe-integer range |

Success (`200`): `{ "txId": "...", "amount": 1000, "utxoSource": "test" \| "large" }`.

Error body (all failures): `{ "error": <code>, "message": <text>, "retryable": <bool> }`.

| Status | `error`             | `retryable` | When                                             |
| ------ | ------------------- | ----------- | ------------------------------------------------ |
| `400`  | `INVALID_REQUEST`   | `false`     | Malformed body, bad address, or bad amount       |
| `413`  | `INVALID_REQUEST`   | `false`     | Body exceeds `MAX_REQUEST_BODY_BYTES`            |
| `503`  | `SERVICE_NOT_READY` | `true`      | Genesis wallet has not synced yet                |
| `409`  | `POOL_EXHAUSTED`    | `true`      | No UTXO available for the requested amount        |
| `409`  | `SPLIT_IN_PROGRESS` | `true`      | Test pool empty while a refill split runs; retry shortly |
| `409`  | `FUND_TIMEOUT`      | `true`      | Timed out waiting for a large UTXO               |
| `409`  | `UTXO_STALE`        | `true`      | Reserved UTXO was spent externally; rescan ran   |
| `500`  | `INTERNAL_ERROR`    | `false`     | Unexpected failure                               |

### Readiness semantics

`/ready` and `/status` share one verdict, evaluated in this order:

| `readyReason`                | `ready` | Meaning                                          |
| ---------------------------- | ------- | ------------------------------------------------ |
| `funding_disabled`           | `true`  | `FUNDING_ENABLED=false` — wallet-generation-only mode |
| `genesis_wallet_not_ready`   | `false` | Funding on, genesis still syncing (or degraded)  |
| `wallet_unfunded`            | `false` | Genesis ready, but the wallet holds no spendable UTXOs |
| `ready`                      | `true`  | Genesis ready and the wallet holds funds         |

Readiness is decoupled from the test pool: it gates on whether the
genesis *wallet* holds spendable UTXOs (a single `getUtxos` check), so
`/ready` reaches `200 ready` as soon as genesis syncs to a funded
wallet — even before the first split has refilled the test pool.

`/status` additionally reports a `startup.phase` of `idle`,
`initializing`, `ready`, `disabled`, or `degraded`, plus a `funding`
block (`splitInProgress`, `rescanInProgress`, `refillScheduled`, and the
last split/rescan timestamps and errors). A bad seed or an unreachable
fullnode lands in `degraded` **without** taking the service down — the
wallet endpoints keep serving.

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

> With `FUNDING_ENABLED=true`, `/ready` stays `503`
> (`genesis_wallet_not_ready`, then `wallet_unfunded` only if the wallet
> has no funds) until genesis has synced to a funded wallet, after which
> it reports `200 ready`. Size the healthcheck `retries` window to allow
> for genesis sync on your network.

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
