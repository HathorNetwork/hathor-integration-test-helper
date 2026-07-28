import {
  needsRefill,
  reserveUtxo,
  releaseReservation,
  returnChange,
  getPoolStats,
  type ReservedUtxo,
  type UtxoSource,
} from "./utxo-pool.service";
import { config } from "./config";
import { logger } from "./logger";
import { recordRescan, recordRefillFailure } from "./metrics";
import {
  getFundDeps,
  reserveLargeFromWallet,
  reserveLargeWithTimeout,
  splitUtxo,
  scheduleReservationRelease,
  repopulatePoolFromWallet,
  isSplitInProgress,
  getSplitStatus,
  __resetSplitStateForTest,
  type FundWallet,
} from "./split.service";
import {
  PoolExhaustedError,
  SplitInProgressError,
  UtxoStaleError,
  FundTimeoutError,
} from "./errors";

/**
 * The /fund request path: reserve a UTXO (test-sized from the pool, or large
 * wallet-sourced), build/sign/broadcast the funding tx, recover from a spent
 * UTXO by rescanning, and keep the pool topped up via background refills.
 *
 * The pool-production side — the split, wallet-sourced reservation, and the
 * shared DI seam — lives in `./split.service`, which this module depends on
 * (never the reverse).
 */

// Fund-path lifecycle state. Split-side state (splitInProgress, last split)
// lives in split.service and is read back through its accessors.
let rescanInProgress: Promise<void> | null = null;
let backgroundRefillTimer: ReturnType<typeof setTimeout> | null = null;

let lastRescanAt: string | null = null;
let lastRescanError: string | null = null;
let lastRefillAt: string | null = null;
let lastRefillError: string | null = null;

/**
 * Delay before a scheduled refill actually splits. See
 * {@link triggerBackgroundRefill} for why it exists; it is a module-level
 * binding rather than a constant so tests can collapse it to ~0 and observe
 * the timer body, which at 1.5s never runs before a test's afterEach clears it.
 */
const DEFAULT_REFILL_DELAY_MS = 1_500;
let refillDelayMs = DEFAULT_REFILL_DELAY_MS;

/** Test-only: shorten the refill delay so the timer body runs within a test. */
export function __setRefillDelayForTest(ms: number): void {
  refillDelayMs = ms;
}

/**
 * Test-only: reset the module's background-operation state so a test that
 * exercises fund/split does not leak lifecycle state (a pending refill timer,
 * `splitInProgress`, last-op timestamps) into unrelated test files.
 */
export function __resetFundStateForTest(): void {
  if (backgroundRefillTimer !== null) {
    clearTimeout(backgroundRefillTimer);
    backgroundRefillTimer = null;
  }
  rescanInProgress = null;
  lastRescanAt = null;
  lastRescanError = null;
  lastRefillAt = null;
  lastRefillError = null;
  refillDelayMs = DEFAULT_REFILL_DELAY_MS;
  __resetSplitStateForTest();
}

/** Snapshot of the funding subsystem's background operations. */
export interface FundingLifecycleState {
  splitInProgress: boolean;
  rescanInProgress: boolean;
  refillScheduled: boolean;
  lastSplitAt: string | null;
  lastSplitError: string | null;
  lastRescanAt: string | null;
  lastRescanError: string | null;
  lastRefillAt: string | null;
  lastRefillError: string | null;
}

/**
 * Return a point-in-time snapshot of split, rescan, and refill states.
 *
 * Each `last*At` is stamped on both the success and failure path of its
 * operation, so the timestamp always describes the outcome reported beside it —
 * a fresh error is never paired with an older run's timestamp.
 */
export function getFundingLifecycleState(): FundingLifecycleState {
  const split = getSplitStatus();
  return {
    splitInProgress: isSplitInProgress(),
    rescanInProgress: rescanInProgress !== null,
    refillScheduled: backgroundRefillTimer !== null,
    lastSplitAt: split.lastSplitAt,
    lastSplitError: split.lastSplitError,
    lastRescanAt,
    lastRescanError,
    lastRefillAt,
    lastRefillError,
  };
}

/** Result of a successful fund transaction. */
export interface FundResult {
  txId: string;
  /**
   * The requested amount that was sent to the recipient — echoed back for the
   * caller's convenience, not a re-read of the on-chain output. The authority
   * for what settled is `txId` on the fullnode.
   */
  amount: bigint;
  utxoSource: UtxoSource;
}

/**
 * Re-query wallet-lib for available UTXOs and repopulate the pool.
 *
 * Called when a fund attempt fails because a UTXO was spent externally
 * (e.g. by an integration test that bypasses this service). Concurrent
 * callers coalesce into a single rescan; new /fund requests wait until
 * the rescan completes.
 */
export async function rescanUtxoPool(): Promise<void> {
  if (rescanInProgress) return rescanInProgress;

  rescanInProgress = (async () => {
    // Runs straight through: this body only *reads* the wallet, and every
    // /fund request parks on it. The inter-transaction spacing a Hathor tx needs
    // (timestamp must exceed every parent's, at 1-second fullnode granularity)
    // belongs to the code that builds one — see triggerBackgroundRefill.
    logger.info({ event: "rescan.started" });
    await repopulatePoolFromWallet(getFundDeps().getGenesisWallet());
    recordRescan();
    lastRescanAt = new Date().toISOString();
    lastRescanError = null;

    const stats = getPoolStats();
    logger.info({
      event: "rescan.completed",
      meta: {
        testUtxos: stats.testUtxos,
      },
    });

    // Test bucket still empty: schedule a refill rather than awaiting one.
    // Splitting mines a transaction (proof of work + a fullnode push), and
    // every incoming /fund parks on `rescanInProgress` until this resolves —
    // awaiting the split here would block all of them for the whole mining
    // round-trip, for what is only best-effort pool repair.
    if (stats.testUtxos === 0) {
      logger.info({ event: "rescan.trigger_split_after_empty_pool" });
      triggerBackgroundRefill();
    }
  })().catch((err) => {
    const message = err instanceof Error ? err.message : "Unknown rescan error";
    lastRescanAt = new Date().toISOString();
    lastRescanError = message;
    logger.error({ event: "rescan.failed", meta: { error: message } });
    throw err;
  });

  try {
    await rescanInProgress;
  } finally {
    rescanInProgress = null;
  }
}

/**
 * Message fragments that identify "this input can no longer be spent".
 *
 * Two different producers reject a spent input, with different wording and
 * neither with a distinguishing error class, so this is necessarily a message
 * check:
 *
 *  - wallet-lib's local pre-flight (`checkUnspentInput`) throws a plain `Error`
 *    reading `Output [i] of transaction [x] is already spent` — note "is
 *    already spent", with no "been".
 *  - the fullnode rejects the push and wallet-lib relays the node's message
 *    verbatim (`new SendTxError(response.message)`). That wording is set by
 *    hathor-core, not by wallet-lib, and commonly reads "has already been
 *    spent" — so both phrasings are matched.
 *
 * Neither fragment is a substring of the other, so both entries are load-bearing.
 * Matching too narrowly is the dangerous direction: an unrecognised stale error
 * skips the rescan and falls through to the generic-failure branch, which is
 * how a spent output gets handed back to the next request.
 */
const STALE_UTXO_MESSAGES = ["already spent", "already been spent"];

/** Follow at most this many `cause` links; guards against a cyclic chain. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Check whether an error indicates the UTXO was already spent externally.
 *
 * Walks the `cause` chain: both wallet-lib and this service wrap errors
 * (`UtxoStaleError` passes `{ cause }`), so the spent-input wording is often
 * one or more levels below the outermost message.
 */
function isStaleUtxoError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return false;
    const message = current.message.toLowerCase();
    if (STALE_UTXO_MESSAGES.some((fragment) => message.includes(fragment))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Fund a test address by reserving a UTXO and sending a transaction.
 *
 * If the fullnode rejects the tx because the UTXO was spent externally,
 * the pool is rescanned from wallet-lib and the operation retries once.
 *
 * `largeWaitMs` bounds the wait for a wallet-sourced output on a large request
 * and defaults to the configured FUND_TIMEOUT_MS; it is a parameter for the
 * same reason {@link reserveLargeWithTimeout}'s is, so a test can reach the
 * FUND_TIMEOUT mapping without waiting out the real 30s budget.
 */
export async function fundAddress(
  address: string,
  amount: bigint,
  largeWaitMs: number = config.FUND_TIMEOUT_MS,
): Promise<FundResult> {
  const pendingRescan = rescanInProgress;
  if (pendingRescan) {
    logger.info({ event: "fund.waiting_for_rescan" });
    // A rescan is best-effort pool repair; its failure must not bleed into this
    // unrelated request (it would surface as a generic 500 for every coalesced
    // waiter). Swallow it and proceed — attemptFund reserves from whatever the
    // pool holds, or raises its own domain error. The rescan logs its own
    // failure at the source.
    await pendingRescan.catch(() => {});
  }

  return attemptFund(address, amount, 1, largeWaitMs);
}

/** Internal: reserve a UTXO, build and send the tx, retrying once on stale-UTXO errors. */
async function attemptFund(
  address: string,
  amount: bigint,
  retriesLeft: number,
  largeWaitMs: number,
): Promise<FundResult> {
  let reserved: ReservedUtxo;
  if (amount <= config.UTXO_SPLIT_AMOUNT) {
    // Standard request: reserve synchronously from the test bucket.
    try {
      reserved = reserveUtxo(amount);
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        // RFC: when a small-amount reservation fails because the test pool is
        // empty AND a split is currently running, surface SPLIT_IN_PROGRESS so
        // clients see "pool will refill shortly" rather than "exhausted, give
        // up". The running split is itself the refill, so don't schedule one.
        if (isSplitInProgress()) {
          throw new SplitInProgressError();
        }
        // Otherwise nothing else will refill the pool. The success-path trigger
        // below is unreachable while every request fails here, the bootstrap
        // split runs once (its promise is memoized), and a rescan only happens
        // on the stale path — so without this the pool stays at zero and every
        // request answers POOL_EXHAUSTED forever.
        triggerBackgroundRefill();
      }
      throw err;
    }
  } else {
    // Large request: the pool serves only test-sized amounts, so source it
    // from the wallet, waiting up to FUND_TIMEOUT_MS for a covering output to
    // become available (RFC: large requests queue for a refill rather than
    // failing immediately).
    const large = await reserveLargeWithTimeout(amount, largeWaitMs);
    if (large === null) {
      throw new FundTimeoutError(largeWaitMs);
    }
    reserved = large;
  }
  const { utxo, source: utxoSource } = reserved;

  const deps = getFundDeps();
  const wallet = deps.getGenesisWallet();
  const genesisAddr = deps.getGenesisAddress();

  // Everything after the reservation is release-guarded: build, sign, and
  // broadcast can each throw (bad pin, wallet-lib error, mining rejection),
  // and a throw outside the guard would strand `utxo` in reservedSet forever
  // (rescan and admitToPool both skip reserved keys, so it never heals).
  let tx: Awaited<ReturnType<FundWallet["buildTxTemplate"]>>;
  try {
    const builder = deps.newTemplateBuilder()
      .addSetVarAction({ name: "recipient", value: address })
      .addSetVarAction({ name: "change", value: genesisAddr })
      .addRawInput({ txId: utxo.txId, index: utxo.index })
      .addTokenOutput({
        address: "{recipient}",
        amount,
      })
      .addCompleteAction({
        changeAddress: "{change}",
        skipSelection: true,
      });

    const template = builder.build();
    tx = await wallet.buildTxTemplate(template, {
      signTx: true,
      pinCode: config.WALLET_PIN_CODE,
    });

    await deps.runSendTransaction(wallet, tx);
  } catch (err) {
    if (retriesLeft > 0 && isStaleUtxoError(err)) {
      logger.warn({
        event: "fund.stale_utxo",
        meta: { txId: utxo.txId, index: utxo.index, retriesLeft },
      });
      // Hold the reservation *across* the rescan, then release. The stale
      // verdict comes from the fullnode, which sees an external spend before
      // the wallet's own UTXO store does, so `only_available_utxos` will often
      // still report this output as available — releasing first would let
      // populateFromUtxos re-pool a known-spent UTXO for the retry (and any
      // concurrent request) to trip over again. Reserved keys are skipped by
      // the rescan, so holding it is what keeps it out; releasing straight
      // after keeps it from stranding in reservedSet.
      //
      // Rescan failure is swallowed for the same reason fundAddress swallows it
      // for coalesced waiters: best-effort pool repair must not convert a
      // retryable UTXO_STALE into a non-retryable 500. The retry still runs, and
      // a second stale surfaces the documented UtxoStaleError below.
      await rescanUtxoPool().catch(() => {});
      releaseReservation(utxo);
      return attemptFund(address, amount, retriesLeft - 1, largeWaitMs);
    }
    releaseReservation(utxo);
    if (isStaleUtxoError(err)) {
      // Stale on the final attempt — RFC's UTXO_STALE response. The UTXO was
      // spent externally, so it must NOT be returned to the pool: re-pooling a
      // spent output would just fail the next request stale again.
      throw new UtxoStaleError(
        err instanceof Error ? err.message : "Reserved UTXO was already spent",
        { cause: err },
      );
    }
    // Build/sign/broadcast failed but the UTXO was never spent. A test-sized
    // input goes straight back to the pool for immediate reuse. A large input
    // is release-only: the pool never holds large outputs (returnChange would
    // warn and drop it), and the next wallet query rediscovers it on-chain.
    if (utxoSource === "test") {
      returnChange(utxo);
    }
    throw err;
  }

  const txId = tx.hash;
  if (!txId) {
    // The send resolved but the built tx has no hash: we cannot observe the
    // spending tx, so we can't defer the release. Release now and do NOT
    // returnChange a possibly-spent output. This can't re-introduce a spent
    // UTXO: repopulation pools only the wallet's *available* set, so a rescan
    // won't re-pool an input the broadcast already spent. Holding it reserved
    // forever is worse — reserved keys are skipped by rescan/admit and never heal.
    releaseReservation(utxo);
    logger.error({ event: "fund.missing_tx_hash" });
    throw new Error("Fund transaction completed without a hash");
  }

  scheduleReservationRelease(wallet, utxo, txId, "fund");

  // Genesis change is deliberately NOT re-pooled here.
  //
  // Telling change from the recipient's output requires knowing which address
  // each output pays, and a built transaction carries only scripts (wallet-lib
  // leaves `decodedScript` null until something parses it). Selecting by
  // position instead would be unsound: `returnChange`'s guard is a *size* check,
  // not an ownership check, and UTXO_SPLIT_AMOUNT is also the default request
  // amount — so on a default-sized request the recipient's output is exactly
  // test-sized and indistinguishable from change. Pooling it would hand the
  // next request a UTXO the genesis wallet does not own, which fails as "is not
  // from the wallet" — not a stale error, so the failure path would re-pool it
  // again, indefinitely.
  //
  // The change stays on-chain in the genesis wallet and is rediscovered by the
  // next repopulatePoolFromWallet (rescan or refill), which pools only outputs
  // the wallet itself reports as available.

  if (needsRefill()) {
    triggerBackgroundRefill();
  }

  return { txId, amount, utxoSource };
}

/**
 * Trigger a background split refill (non-blocking).
 *
 * Waits {@link refillDelayMs} before splitting to avoid a timestamp collision:
 * a Hathor transaction's timestamp must be strictly greater than every parent's,
 * and the fullnode records timestamps at 1-second granularity — so a split whose
 * parent is the fund tx that just triggered it can be rejected if built within
 * the same second. The delay is the whole reason the split is deferred rather
 * than run inline, and it is why the post-rescan refill routes through here too.
 *
 * Debounced: a refill already on the clock absorbs further triggers.
 */
function triggerBackgroundRefill(): void {
  if (backgroundRefillTimer !== null) {
    return;
  }

  backgroundRefillTimer = setTimeout(() => {
    backgroundRefillTimer = null;

    void (async () => {
      try {
        // Require at least 2 × UTXO_SPLIT_AMOUNT so the split yields at least
        // one test UTXO plus change.
        const reserved = await reserveLargeFromWallet(config.UTXO_SPLIT_AMOUNT * 2n);
        if (reserved === null) {
          // The wallet holds nothing large enough to split, so the pool cannot
          // refill. Recorded as a failed refill rather than passed over: a pool
          // stuck at zero because genesis has no splittable output is exactly
          // what an operator needs to see, and reporting it as a completed
          // refill would make it indistinguishable from a healthy one.
          recordRefillFailure();
          lastRefillAt = new Date().toISOString();
          lastRefillError = "no large output available to split";
          logger.warn({ event: "refill.no_candidate" });
          return;
        }
        await splitUtxo(reserved.utxo);
        lastRefillAt = new Date().toISOString();
        lastRefillError = null;
      } catch (err) {
        // Counted here, not left to recordSplit: a refill can fail in
        // reserveLargeFromWallet's wallet query, before splitUtxo is ever
        // called, and that failure reaches no split counter at all.
        const message = err instanceof Error ? err.message : "Unknown refill error";
        recordRefillFailure();
        lastRefillAt = new Date().toISOString();
        lastRefillError = message;
        logger.error({ event: "refill.failed", meta: { error: message } });
      }
    })();
  }, refillDelayMs);
}

