---
id: reservation-release-on-failure
title: Release every UTXO reservation on every failure path
severity: must
applies-to:
  - src/fund.service.ts
  - src/startup.ts
rationale-summary: >-
  reservedSet is skipped by rescan and admitToPool, so a UTXO left
  reserved after a failed operation never self-heals — it is wedged
  until process restart. Every reserve must pair with a release on
  every throw path, not just the broadcast.
---

## Rule

Any code path that reserves a UTXO — `reserveUtxo`, `reserveLarge`, or
`reserveLargeFromWallet` (directly or via `reserveLargeWithTimeout`) —
MUST release that reservation (`releaseReservation`) on EVERY failure
between the reservation and the point where `scheduleReservationRelease`
takes ownership. That includes:

- template `build()` and `buildTxTemplate()` (sign) failures,
- the broadcast (`runSendTransaction`) failure,
- the reward-unlock wait (`waitForUtxoUnlock`) failure,
- the "transaction completed without a hash" branch.

A reservation is handed off exactly once: to `scheduleReservationRelease`
(deferred release once the spending tx is observed) on success, or to
`releaseReservation` on failure. There is no third state, and no path may
leave a reserved UTXO behind.

## Why

`reservedSet` is the single source of truth for in-flight UTXOs.
`populateFromUtxos` and `admitToPool` both SKIP any key in `reservedSet`
by design, so a rescan running mid-flight cannot re-hand an in-flight
output to a second request.

The cost of that design is that a leak is permanent: a UTXO left reserved
after its operation aborted is never re-pooled and never re-queried — it
is wedged until the process restarts. A standard request loses a pool
UTXO; a large or split request strands the wallet's large output.

This has been the single most recurring defect in the funding subsystem.
The reservation guard originally wrapped only the broadcast, so a throw
from build/sign, from the unlock wait, or on a missing tx-hash escaped
it. The fix each time is the same: widen the guard so every failure
between reserve and hand-off releases first.

## How to check

For each changed function in `src/fund.service.ts` / `src/startup.ts`:

1. Find every call that reserves a UTXO (`reserveUtxo`, `reserveLarge`,
   `reserveLargeFromWallet`, `reserveLargeWithTimeout`).
2. Trace every path from that call to the function's exits.
3. For each path that throws or returns without reaching
   `scheduleReservationRelease` for that UTXO, verify `releaseReservation`
   runs first. `releaseReservation` is idempotent, so a defensive double
   release is acceptable; a missing one is not.
4. Flag any throw path (build, sign, unlock, broadcast, missing-hash)
   that skips the release with severity `must`.

## How to fix

1. Wrap the whole reserve → build → sign → broadcast sequence in a `try`
   whose `catch` calls `releaseReservation` before re-throwing.
2. For a pre-broadcast await that sits outside that guard (e.g.
   `waitForUtxoUnlock`), release in its own catch too.
3. On the "completed without a hash" branch, release — but do NOT
   `returnChange`: the input may already be spent, and repopulation pools
   only the wallet's *available* set, so a rescan reconciles it while a
   permanent reservation never heals.
4. Add a test that drives the failure (a throwing fake collaborator) and
   asserts `getReservedKeys()` is empty afterwards.
