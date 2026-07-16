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
import { recordRescan } from "./metrics";
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
}

/** Return a point-in-time snapshot of split, rescan, and refill states. */
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
    await new Promise((r) => setTimeout(r, 1_000));

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

    // Test bucket empty after the rescan: refill it by splitting a large output.
    if (stats.testUtxos === 0) {
      const reserved = await reserveLargeFromWallet(config.UTXO_SPLIT_AMOUNT * 2n);
      if (reserved !== null) {
        logger.info({ event: "rescan.trigger_split_after_empty_pool" });
        await splitUtxo(reserved.utxo);
      }
    }
  })().catch((err) => {
    const message = err instanceof Error ? err.message : "Unknown rescan error";
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

/** Check whether an error indicates the UTXO was already spent externally. */
function isStaleUtxoError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("already been spent");
}

/**
 * Fund a test address by reserving a UTXO and sending a transaction.
 *
 * If the fullnode rejects the tx because the UTXO was spent externally,
 * the pool is rescanned from wallet-lib and the operation retries once.
 */
export async function fundAddress(
  address: string,
  amount: bigint,
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

  return attemptFund(address, amount, 1);
}

/** Internal: reserve a UTXO, build and send the tx, retrying once on stale-UTXO errors. */
async function attemptFund(
  address: string,
  amount: bigint,
  retriesLeft: number,
): Promise<FundResult> {
  let reserved: ReservedUtxo;
  if (amount <= config.UTXO_SPLIT_AMOUNT) {
    // Standard request: reserve synchronously from the test bucket.
    try {
      reserved = reserveUtxo(amount);
    } catch (err) {
      // RFC: when a small-amount reservation fails because the test pool is
      // empty AND a split is currently running, surface SPLIT_IN_PROGRESS so
      // clients see "pool will refill shortly" rather than "exhausted, give up".
      if (err instanceof PoolExhaustedError && isSplitInProgress()) {
        throw new SplitInProgressError();
      }
      throw err;
    }
  } else {
    // Large request: the pool serves only test-sized amounts, so source it
    // from the wallet, waiting up to FUND_TIMEOUT_MS for a covering output to
    // become available (RFC: large requests queue for a refill rather than
    // failing immediately).
    const large = await reserveLargeWithTimeout(amount);
    if (large === null) {
      throw new FundTimeoutError(config.FUND_TIMEOUT_MS);
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
      // Stale UTXO is not in wallet's available set anymore; release the
      // reservation so rescan + retry can proceed without keeping a ghost
      // entry in reservedSet.
      releaseReservation(utxo);
      await rescanUtxoPool();
      return attemptFund(address, amount, retriesLeft - 1);
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
    if (utxo.amount === config.UTXO_SPLIT_AMOUNT) {
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

  // Change is at output index 1 by construction: the template adds the
  // recipient output first, then addCompleteAction appends the change output.
  // returnChange is defensive regardless — it only re-pools an exactly
  // test-sized output, so a non-change output slipping in is dropped, not
  // mispooled.
  if (tx.outputs.length > 1) {
    const changeOutput = tx.outputs[1]!;
    const changeAmount = BigInt(changeOutput.value);
    if (changeAmount > 0n) {
      returnChange({ txId, index: 1, amount: changeAmount });
    }
  }

  if (needsRefill()) {
    triggerBackgroundRefill();
  }

  return { txId, amount, utxoSource };
}

/**
 * Trigger a background split refill (non-blocking).
 *
 * Waits 1.5s before splitting to avoid timestamp collisions: the fullnode
 * requires tx.timestamp > parent.timestamp, and the parent is typically
 * the fund transaction that just triggered this refill.
 */
function triggerBackgroundRefill(): void {
  if (backgroundRefillTimer !== null) {
    return;
  }

  backgroundRefillTimer = setTimeout(() => {
    backgroundRefillTimer = null;

    // Require at least 2 × UTXO_SPLIT_AMOUNT so the split yields at least one
    // test UTXO plus change; skip quietly when the wallet has nothing that large.
    reserveLargeFromWallet(config.UTXO_SPLIT_AMOUNT * 2n)
      .then((reserved) => {
        if (reserved === null) {
          return;
        }
        return splitUtxo(reserved.utxo);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Unknown refill error";
        logger.error({ event: "refill.failed", meta: { error: message } });
      });
  }, 1_500);
}

