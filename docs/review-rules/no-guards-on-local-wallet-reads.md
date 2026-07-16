---
id: no-guards-on-local-wallet-reads
title: Do not guard local wallet reads with timeout/abort machinery
severity: should
applies-to:
  - src/**/*.ts
rationale-summary: >-
  getUtxos reads the wallet's already-synced in-process UTXO store, not
  the fullnode, so it returns promptly and cannot hang. Wrapping it in
  AbortSignal/timeout/retry logic adds machinery for a stall the call
  path cannot produce.
---

## Rule

Do NOT wrap a local wallet read in `AbortSignal`, a per-request timeout
race, or retry machinery. A "local wallet read" reads the wallet's
already-synced in-process state, chiefly:

- `wallet.getUtxos(...)` — used by `reserveLargeFromWallet`,
  `repopulatePoolFromWallet`, and `isGenesisFunded`.

Reserve timeout / abort / retry logic for calls that genuinely hit the
network or the miner — e.g. `SendTransaction.runFromMining` (broadcast)
and the fullnode connection / sync path.

A bounded *poll loop* around a local read (as in
`reserveLargeWithTimeout`) is fine and is NOT what this rule forbids: it
enforces its deadline *between* quick, non-blocking reads. What this rule
forbids is adding a guard *around the individual read* on the theory that
it might hang.

## Why

`getUtxos` returns from the wallet's local, already-synced UTXO store —
an in-process lookup, not a fullnode round-trip (see the note on
`genesis.service.isGenesisFunded`). It returns promptly and cannot hang,
so an `AbortSignal` or per-call timeout guards against a failure mode
this call path cannot produce. `@hathor/wallet-lib` 3.0.1 exposes no
cancellation for it anyway, so such a guard would also have to fake one.

Reviewers (human and bot) repeatedly suggest these guards because "an
await with no timeout" is a common smell. Here it is a false positive:
the guard adds real complexity and latency-branching for zero benefit,
and the simpler synchronous-style read is both faster and easier to
reason about.

## How to check

1. Find awaits on `wallet.getUtxos(...)` or its wrappers
   (`reserveLargeFromWallet`, `repopulatePoolFromWallet`,
   `isGenesisFunded`).
2. If a change adds an `AbortController` / `AbortSignal`, a
   `Promise.race` against a timer, or a retry loop *around that read*,
   flag it `should`.
3. Distinguish the legitimate poll-loop deadline in
   `reserveLargeWithTimeout` (deadline between reads, not around one) —
   that is allowed.

## How to fix

1. Remove the abort / timeout / retry wrapper from the local read.
2. If a caller needs an overall deadline (as large funding does), bound
   it with a poll loop that checks the deadline between reads, not by
   racing each read.
3. Leave a one-line comment noting the read is local (not a fullnode
   round-trip) so the next reviewer does not re-flag it.
