# PR2 — Wallet endpoints + server skeleton

**Date:** 2026-05-14
**Branch:** `pr-2-wallet-endpoints` (off `main` at `b933dde`)
**Base PR:** [#3 (PR1 foundation)](https://github.com/HathorNetwork/hathor-integration-test-helper/pull/3) — merged
**Tracking issue:** [#1 Migration plan](https://github.com/HathorNetwork/hathor-integration-test-helper/issues/1)
**Donor reference:** `tuliomir/hathor-integration-test-helper@325aeac` (file roadmap only — not a source of truth)

## Goal

Ship the first user-visible feature. After this PR, three HTTP
endpoints work end-to-end through the full observability pipeline:

- `GET /simpleWallet` — generate a 24-word BIP39 seed and 22 derived
  P2PKH addresses.
- `GET /multisigWallet?participants=N&numSignatures=M` — generate a
  complete multisig wallet set with sorted P2SH-derived addresses.
- `GET /live` — liveness probe.

The observability pipeline established here is the contract every
later route inherits: per-request `X-Test-Name` propagated via
AsyncLocalStorage to every structured log line (including
background continuations), `x-request-id` echo, per-route latency
counters, and an `INTERNAL_ERROR` 500 catch-all.

## Non-goals

- `/fund`, `/status`, `/ready`, `/metrics` endpoints (PR3–PR5).
- Genesis wallet bootstrap (PR3).
- UTXO pool primitives (PR4).
- Integration test harness against a real fullnode (PR7).

## Files

### New — `src/`

#### `wallet.service.ts`
Pure wallet-lib usage. Two exports:

```ts
export function generateSimpleWallet(): { words: string; addresses: string[] };
export function generateMultisigWallet(
  participants: number,
  numSignatures: number,
): MultisigWallet[];
```

Address count comes from `config.ADDRESS_COUNT`. Multisig pubkeys are
sorted lexicographically before P2SH derivation so all participants
derive identical addresses.

#### `wallet.cache.ts`
FIFO cache of pre-generated simple wallets, refilled asynchronously
via a `setImmediate` chain. **Hardened vs donor:**

- `generateSimpleWallet()` calls inside the refill chain are wrapped
  in try/catch.
- On error: emit a structured `logger.error({event: "wallet_cache.refill_failed", ...})`,
  clear `isRefilling`, and schedule one additional `setImmediate(refillOne)`
  so the next tick attempts progress (avoiding a hot retry loop while
  preserving self-healing).

Exports: `initializeCache()`, `getSimpleWalletFromCache()`,
`getCacheSize()`.

#### `signal-handlers.ts`
Graceful SIGINT/SIGTERM with constructor-injected `processRef` /
`setTimeoutRef` / `exitRef` for testability. **Refinement vs donor:**
the magic `200ms` drain delay is lifted into a `shutdownDrainMs`
option (default 200) — documents the intent and lets tests verify
the timing without faking real time.

#### `metrics.ts`
Subset only — request counters and per-route latency
accumulators. Strip donor's `recordFundSuccess`, `recordSplit`,
`recordRescan` and their snapshot fields entirely; those will land
in their natural PRs (PR4/PR5).

```ts
export function recordHttpRequest(route: string, status: number, latencyMs: number): void;
export function getMetricsSnapshot(): { routes: Record<string, RouteMetric> };
```

`getMetricsSnapshot` is exported but not yet served by any route in
this PR — it's read by future `/metrics` handler in PR5. The
function is exercised by unit tests.

#### `app.ts`
Two responsibilities: the `withObservability` wrapper and the
`createRoutes()` factory.

```ts
function withObservability(route: string, handler: Handler): Handler;
export function createRoutes(): BunRoutes; // three routes only
```

`withObservability` wires:

1. Read raw `x-test-name` header (no pre-normalization — PR1's
   `runWithTestName` already trims and defaults to `"unknown"`).
2. `runWithTestName(rawHeader, () => runHandler(route, req, handler))`.
3. In `runHandler`:
   - `ensureRequestId(req)` (PR1).
   - Time the call.
   - try → `await handler(req)`, capture status.
   - catch → log `http.unhandled_error`, return
     `jsonError(500, "INTERNAL_ERROR", "Internal Server Error", false)`.
   - finally → `recordHttpRequest(route, status, latencyMs)` and
     `logger.info({event:"http.request", route, method, requestId, status, latencyMs})`.
   - Return `withRequestIdHeader(res, requestId)`.

**Refinement vs donor:** the donor's `resolveTestName` helper is
removed — it duplicated trim/`"unknown"`-default logic that PR1's
`log-context.ts` already owns at the boundary.

#### `routes.ts`
Three handlers, **subset of donor**:

```ts
export function handleSimpleWallet(req: Request): Response;     // returns {...wallet, genTime}
export function handleMultisigWallet(req: Request): Response;   // returns {wallets, genTime}
export function handleLive(_req: Request): Response;            // returns {live: true}
```

**Error pattern (per donor):** handlers do **not** throw for
expected error conditions. They build an `InvalidRequestError` and
return `jsonErrorFromService(err)` directly. `withObservability`'s
`runHandler` catch-all exists for unexpected throws (programmer
errors, library faults) only — domain errors stay inside the
handler.

`handleMultisigWallet` validates query params and returns
`jsonErrorFromService(new InvalidRequestError(msg))` on:

- Missing `participants` or `numSignatures`.
- `isNaN(parseInt(...))` for either.
- `participants < 1` or `numSignatures < 1`.
- `numSignatures > participants`.
- `participants > MAX_MULTISIG_PARTICIPANTS` — **addition vs donor**.
  Constant in this file, initial value `15`. Rationale: cheap
  defensive cap; without it `participants=10000` happily burns CPU
  generating seeds (this is a test helper, not a production
  service). Cheap to remove if a reviewer disagrees.

Each handler records its own `genTime` from `performance.now()` and
includes it in the success response — matches donor and is useful
for the test helper's clients to surface in test reports.

### Modified

#### `src/errors.ts`
Add `INTERNAL_ERROR` to the `ErrorCode` union and add an
`INTERNAL_ERROR: { status: 500, retryable: false }` row to
`ERROR_TABLE`. The `satisfies Record<ErrorCode, ...>` clause on
`ERROR_TABLE` forces the row at compile time.

No new subclass is needed — `INTERNAL_ERROR` is the catch-all used
inline by `runHandler`, not thrown by domain code.

#### `index.ts`
Replace the current placeholder with:

```ts
import { config } from "./src/config";
import { logger } from "./src/logger";
import { initializeCache } from "./src/wallet.cache";
import { createRoutes } from "./src/app";
import { setupSignalHandlers } from "./src/signal-handlers";

initializeCache();
const server = Bun.serve({
  port: config.PORT,
  routes: createRoutes(),
});
setupSignalHandlers(server);
logger.info({ event: "server.started", meta: { port: server.port } });
```

`applyWalletLibBigIntPatch()` is not called — PR1 moved the BigInt
patch to install-time via `patches/`.

`bootstrapFunding()` is **not** wired — PR3.

### New tests — `__tests__/src/`

- `wallet-service.test.ts` (new, not in donor) — seed length, address
  count, multisig pubkey sort determinism, P2SH-derived address
  parity across participants.
- `wallet-cache.test.ts` — initial fill, FIFO order, refill
  scheduling. Plus a **new test for the refill-failure path**: mock
  `generateSimpleWallet` to throw, assert (a) `isRefilling` clears,
  (b) one retry is scheduled, (c) `logger.error` was called with
  `event: "wallet_cache.refill_failed"`.
- `signal-handlers.test.ts` — SIGINT, SIGTERM, double-signal
  suppression, `server.stop()` failure path, **plus** configurable
  `shutdownDrainMs`.
- `metrics.test.ts` — request counter math, error-counter math,
  average-latency calculation, snapshot shape.
- `app-test-name.test.ts` — `X-Test-Name` propagates through async
  continuations (using a mocked route that does `await
  Promise.resolve()` before logging); `unknown` default for missing
  / empty / whitespace headers.
- `__tests__/index.test.ts` — boot `Bun.serve` on an ephemeral port,
  hit the three live endpoints, assert response shape and
  `x-request-id` echo.

## Observability pipeline

```
Bun.serve → withObservability(route, handler)
  → runWithTestName(rawHeader, () =>
      runHandler:
        requestId = ensureRequestId(req)
        startedAt = performance.now()
        try:
          res = await handler(req)
          status = res.status
        catch (err):
          logger.error({event:"http.unhandled_error", route, requestId, error: err.message})
          res = jsonError(500, "INTERNAL_ERROR", "Internal Server Error", false)
          status = 500
        finally:
          latencyMs = perf.now() - startedAt
          recordHttpRequest(route, status, latencyMs)
          logger.info({event:"http.request", route, method, requestId, status, latencyMs})
        return withRequestIdHeader(res, requestId)
    )
```

Logs emitted inside `handler` or any async continuation it schedules
inherit `testName` via PR1's `AsyncLocalStorage`. The pipeline
normalizes the `X-Test-Name` header **exactly once** — at PR1's
`runWithTestName` boundary.

## Error handling

| Source | Path | Wire result |
|---|---|---|
| `InvalidRequestError` from validation in `handleMultisigWallet` | Built and returned inline via `jsonErrorFromService` | `400 INVALID_REQUEST`, `retryable:false` |
| Any other `ServiceError` constructed in a handler | Same pattern | Per `ERROR_TABLE` row |
| Unexpected throw from a handler (bug, library fault) | Caught by `runHandler` in `app.ts` | `500 INTERNAL_ERROR`, `retryable:false`, logged with full message + `requestId` |

Domain errors are returned, not thrown. `runHandler`'s catch is for
the unknown-unknowns. The 500 path is exercised by an `app-test-name`
test that mocks a route to throw.

## Acceptance criteria

1. `bun run check` (lint + typecheck + `bun test`) green at HEAD of
   `pr-2-wallet-endpoints`.
2. `curl localhost:3020/simpleWallet` → 200 with `{words, addresses, genTime}`,
   `addresses.length === config.ADDRESS_COUNT` (22), numeric `genTime`.
3. `curl 'localhost:3020/multisigWallet?participants=2&numSignatures=2'`
   → 200 with `{wallets, genTime}` — `wallets` is an array of 2
   participants each carrying `words`, `addresses`, and
   `multisigDebugData.pubkeys` (sorted; identical across participants).
4. `curl 'localhost:3020/multisigWallet?participants=1&numSignatures=2'`
   → 400 `INVALID_REQUEST` (`numSignatures must be <= participants`).
5. `curl -H 'X-Test-Name: foo' localhost:3020/live` → response body
   `{live:true}`; one log line with `event:"http.request"`,
   `route:"/live"`, `testName:"foo"`, `requestId:<uuid>`,
   numeric `latencyMs`, `status:200`.
6. `curl localhost:3020/live` (no header) → same log line shape but
   `testName:"unknown"`.
7. `curl 'localhost:3020/multisigWallet?participants=16&numSignatures=2'`
   → 400 `INVALID_REQUEST` (cap; only if reviewer accepts the
   `MAX_MULTISIG_PARTICIPANTS=15` addition — otherwise drop this AC).

## Branch and commit

- Branch name: `pr-2-wallet-endpoints`.
- Base: `main` at `b933dde`.
- Commit message (subject): `feat: serve simple and multisig wallet endpoints`.
- Conventional Commits body wrapped at 72 cols.

## Refinements vs the donor (summary)

These are deliberate divergences from
`tuliomir/hathor-integration-test-helper@325aeac`'s PR2-equivalent
files. Each is justified inline above; consolidated here for
review-rule traceability:

1. **Add `INTERNAL_ERROR` to PR1's `ErrorCode` union.** Donor's
   `app.ts` references `"UNHANDLED_ERROR"` which is not in the
   union — it wouldn't typecheck against PR1's `errors.ts`.
2. **Harden `wallet.cache.ts` against `generateSimpleWallet`
   throwing.** Donor's `refillOne` has no try/catch — a single throw
   leaves `isRefilling` true forever, silently freezing the cache.
3. **Remove donor's `resolveTestName` in `app.ts`.** PR1's
   `runWithTestName` already trims + defaults to `"unknown"`. Pass
   the raw header through.
4. **Lift signal-handlers' `200ms` magic number** into a
   `shutdownDrainMs` option.
5. **Strip metrics exports** that don't have a caller in PR2
   (`recordFundSuccess`, `recordSplit`, `recordRescan`, and their
   snapshot fields). Re-add in their natural PR.
6. **Add `wallet-service.test.ts`.** Donor only had cache + app
   tests; explicit service-level coverage costs ~50 LOC and
   documents the contract.
