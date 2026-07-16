import { TransactionTemplateBuilder } from "@hathor/wallet-lib/lib/template/transaction";
import SendTransaction from "@hathor/wallet-lib/lib/new/sendTransaction";
import { NATIVE_TOKEN_UID } from "@hathor/wallet-lib/lib/constants";
import { getGenesisWallet, getGenesisAddress } from "./genesis.service";
import {
  addTestUtxos,
  reserveLarge,
  returnChange,
  needsRefill,
  reserveUtxo,
  releaseReservation,
  populateFromUtxos,
  getPoolStats,
  type Utxo,
  type ReservedUtxo,
  type UtxoSource,
} from "./utxo-pool.service";
import { config } from "./config";
import { logger } from "./logger";
import { recordRescan, recordSplit } from "./metrics";
import { awaitTxObserved, type TxObservationWallet } from "./tx-observation";
import {
  PoolExhaustedError,
  SplitInProgressError,
  UtxoStaleError,
  FundTimeoutError,
} from "./errors";

/**
 * Injectable collaborators (DI seam — NOT `mock.module`, which is
 * process-global and leaks across Bun test files; see CLAUDE.md). Wraps the
 * three external touchpoints — the genesis wallet/address, the wallet-lib
 * template builder, and the send-transaction runner — so unit tests inject
 * plain fakes with no fullnode.
 */

/** Minimal template-builder surface used to assemble fund/split txs. */
export interface FundTemplateBuilder {
  addSetVarAction(action: { name: string; value: string }): FundTemplateBuilder;
  addRawInput(input: { txId: string; index: number }): FundTemplateBuilder;
  addTokenOutput(output: { address: string; amount: bigint }): FundTemplateBuilder;
  addCompleteAction(action: { changeAddress: string; skipSelection: boolean }): FundTemplateBuilder;
  build(): unknown;
}

/** Wallet surface fund.service needs beyond tx observation. */
export interface FundWallet extends TxObservationWallet {
  buildTxTemplate(
    template: unknown,
    options: { signTx: boolean; pinCode: string },
  ): Promise<{ hash?: string | null; outputs: Array<{ value: number | bigint }> }>;
  getUtxos(
    options: {
      token: string;
      amount_bigger_than?: bigint;
      amount_smaller_than?: bigint;
      only_available_utxos?: boolean;
    },
  ): Promise<{ utxos: Array<{ tx_id: string; index: number; amount: bigint }> }>;
}

/** The external collaborators fund.service depends on. */
export interface FundServiceDeps {
  getGenesisWallet: () => FundWallet;
  getGenesisAddress: () => string;
  newTemplateBuilder: () => FundTemplateBuilder;
  runSendTransaction: (wallet: unknown, transaction: unknown) => Promise<void>;
}

/** Production wiring: real genesis wallet + wallet-lib builder/sender. */
function defaultDeps(): FundServiceDeps {
  return {
    getGenesisWallet: () => getGenesisWallet() as unknown as FundWallet,
    getGenesisAddress,
    newTemplateBuilder: () =>
      TransactionTemplateBuilder.new() as unknown as FundTemplateBuilder,
    runSendTransaction: async (wallet, transaction) => {
      const sendTx = new SendTransaction(
        { wallet, transaction } as ConstructorParameters<typeof SendTransaction>[0],
      );
      await sendTx.runFromMining();
    },
  };
}

let deps: FundServiceDeps = defaultDeps();

/** Test-only: override fund-service collaborators (DI, not mock.module). */
export function __setFundDepsForTest(overrides: Partial<FundServiceDeps>): void {
  deps = { ...defaultDeps(), ...overrides };
}

/** Test-only: restore the production collaborators. */
export function __resetFundDepsForTest(): void {
  deps = defaultDeps();
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
  splitInProgress = false;
  rescanInProgress = null;
  lastSplitAt = null;
  lastSplitError = null;
  lastRescanAt = null;
  lastRescanError = null;
}

let splitInProgress = false;
let rescanInProgress: Promise<void> | null = null;
let backgroundRefillTimer: ReturnType<typeof setTimeout> | null = null;

let lastSplitAt: string | null = null;
let lastSplitError: string | null = null;
let lastRescanAt: string | null = null;
let lastRescanError: string | null = null;

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

/**
 * Test-only: force `splitInProgress` so unit tests can assert that a
 * pool-exhausted reservation is rewritten to {@link SplitInProgressError}.
 * Not exported through any production code path.
 */
export function __setSplitInProgressForTest(value: boolean): void {
  splitInProgress = value;
}

/** Return a point-in-time snapshot of split, rescan, and refill states. */
export function getFundingLifecycleState(): FundingLifecycleState {
  return {
    splitInProgress,
    rescanInProgress: rescanInProgress !== null,
    refillScheduled: backgroundRefillTimer !== null,
    lastSplitAt,
    lastSplitError,
    lastRescanAt,
    lastRescanError,
  };
}

/**
 * Query the genesis wallet for an available large output (>= `minAmount`) and
 * atomically reserve it through the pool. Returns the reserved UTXO, or `null`
 * when the wallet currently exposes no output that large.
 *
 * The size filter is pushed into the wallet query (`amount_bigger_than`) so
 * wallet-lib returns only covering candidates — we never materialise the full
 * UTXO set just to find one large output. `amount_bigger_than` is a strict `>`,
 * so it is set to `minAmount - 1` to keep the `>= minAmount` contract.
 *
 * The pool holds only test-sized outputs, so the wallet is the source of truth
 * for large ones and is queried live. Atomicity holds because {@link
 * reserveLarge} marks the chosen output in-flight synchronously, so two
 * concurrent callers that saw the same output from their own wallet queries
 * cannot both win it. Callers pass the minimum amount they need: the requested
 * amount for a large fund, `2 × UTXO_SPLIT_AMOUNT` for a split (an output must
 * yield at least one test UTXO plus change).
 */
export async function reserveLargeFromWallet(
  minAmount: bigint,
): Promise<ReservedUtxo | null> {
  const wallet = deps.getGenesisWallet();
  const { utxos } = await wallet.getUtxos({
    token: NATIVE_TOKEN_UID,
    amount_bigger_than: minAmount - 1n,
    only_available_utxos: true,
  });
  for (const u of utxos) {
    const reserved = reserveLarge({ txId: u.tx_id, index: u.index, amount: u.amount });
    if (reserved !== null) {
      return reserved;
    }
  }
  return null;
}

/** Poll interval while waiting for a large output to become available. */
const LARGE_UTXO_POLL_INTERVAL_MS = 500;

/**
 * Reserve a large output covering `amount`, waiting up to `timeoutMs` for one
 * to become available. Per the RFC, a large request queues for a refill rather
 * than failing immediately: large funding is wallet-sourced, so a covering
 * output can appear mid-wait — a concurrent large request releases its
 * reservation, or a split/refill leaves large change on-chain. The wait is
 * passive (polling {@link reserveLargeFromWallet}); it does not itself trigger
 * a split, which would only consume large outputs, not create them.
 *
 * The first attempt runs immediately, so the common case (a large output is
 * already available) pays no polling latency. Returns the reserved output, or
 * `null` at the deadline — the caller maps that to {@link FundTimeoutError}.
 */
export async function reserveLargeWithTimeout(
  amount: bigint,
  timeoutMs: number = config.FUND_TIMEOUT_MS,
  pollIntervalMs: number = LARGE_UTXO_POLL_INTERVAL_MS,
): Promise<ReservedUtxo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reserved = await reserveLargeFromWallet(amount);
    if (reserved !== null) return reserved;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }
}

/**
 * Split a large UTXO into many test-sized UTXOs.
 * Used at startup and whenever the pool runs low.
 *
 * Input:  1 large UTXO
 * Output: N × {genesisAddr, UTXO_SPLIT_AMOUNT} + 1 × {genesisAddr, change}
 */
export async function splitUtxo(utxo: Utxo): Promise<void> {
  if (splitInProgress) {
    logger.info({ event: "split.skipped_already_in_progress" });
    releaseReservation(utxo);
    returnChange(utxo);
    return;
  }
  splitInProgress = true;

  try {
    const wallet = deps.getGenesisWallet();
    const genesisAddr = deps.getGenesisAddress();
    const splitAmount = config.UTXO_SPLIT_AMOUNT;

    const maxOutputs = Math.min(
      config.UTXO_SPLIT_COUNT,
      Number(utxo.amount / splitAmount) - 1,
    );

    if (maxOutputs < 1) {
      logger.warn({
        event: "split.skipped_small_utxo",
        meta: { txId: utxo.txId, index: utxo.index, amount: utxo.amount.toString() },
      });
      releaseReservation(utxo);
      returnChange(utxo);
      return;
    }

    logger.info({
      event: "split.started",
      meta: {
        txId: utxo.txId,
        index: utxo.index,
        amount: utxo.amount.toString(),
        maxOutputs,
        splitAmount: splitAmount.toString(),
      },
    });

    const builder = deps.newTemplateBuilder()
      .addSetVarAction({ name: "addr", value: genesisAddr })
      .addRawInput({ txId: utxo.txId, index: utxo.index });

    for (let i = 0; i < maxOutputs; i++) {
      builder.addTokenOutput({
        address: "{addr}",
        amount: splitAmount,
      });
    }

    builder.addCompleteAction({
      changeAddress: "{addr}",
      skipSelection: true,
    });

    // Release-guard the whole build → sign → broadcast sequence: any throw
    // (bad pin, wallet-lib error, mining rejection) must release the reserved
    // large output, or it stays wedged in reservedSet forever.
    let tx: Awaited<ReturnType<FundWallet["buildTxTemplate"]>>;
    try {
      const template = builder.build();
      tx = await wallet.buildTxTemplate(template, {
        signTx: true,
        pinCode: config.WALLET_PIN_CODE,
      });
      await deps.runSendTransaction(wallet, tx);
    } catch (err) {
      releaseReservation(utxo);
      throw err;
    }

    const txId = tx.hash;
    if (!txId) {
      releaseReservation(utxo);
      throw new Error("Split transaction completed without a hash");
    }

    scheduleReservationRelease(wallet, utxo, txId, "split");

    const newTestUtxos: Utxo[] = [];
    for (let i = 0; i < maxOutputs; i++) {
      newTestUtxos.push({
        txId,
        index: i,
        amount: splitAmount,
      });
    }
    addTestUtxos(newTestUtxos);

    // The large change output is intentionally not pooled — only test-sized
    // outputs are. It stays on-chain in the genesis wallet, and the next split
    // rediscovers it via a live wallet query (reserveLargeFromWallet).

    lastSplitAt = new Date().toISOString();
    lastSplitError = null;
    recordSplit(true);

    logger.info({
      event: "split.completed",
      meta: { txId, createdUtxos: newTestUtxos.length },
    });
  } catch (err) {
    // Defense-in-depth: the inner guard already releases on build/sign/send
    // failure, but a throw during builder assembly would otherwise reach here
    // unreleased. This only runs on a pre-broadcast failure — after a
    // successful send, scheduleReservationRelease owns the release and nothing
    // below it throws — so releasing here never races the observation path.
    releaseReservation(utxo);
    const message = err instanceof Error ? err.message : "Unknown split error";
    lastSplitError = message;
    recordSplit(false);
    logger.error({ event: "split.failed", meta: { error: message } });
    throw err;
  } finally {
    splitInProgress = false;
  }
}

/**
 * Defer releasing a reservation until the consuming tx has been observed
 * by the wallet (so a concurrent `rescanUtxoPool` cannot re-introduce
 * the just-spent UTXO into a bucket). Bounded by `timeoutMs` (default
 * `OBSERVATION_TIMEOUT_MS`); on timeout the reservation is released with a
 * warn log.
 *
 * Callers fire-and-forget (the release is intentionally out-of-band with the
 * fund/split response). The promise is returned only so tests can await the
 * deferred release; production code ignores it.
 */
export function scheduleReservationRelease(
  wallet: TxObservationWallet,
  utxo: { txId: string; index: number },
  spendingTxId: string,
  context: "fund" | "split",
  timeoutMs: number = config.OBSERVATION_TIMEOUT_MS,
): Promise<void> {
  return awaitTxObserved(wallet, spendingTxId, timeoutMs)
    .then((observed) => {
      releaseReservation(utxo);
      if (!observed) {
        logger.warn({
          event: "reservation.observation_timeout",
          meta: {
            context,
            parentTxId: utxo.txId,
            parentIndex: utxo.index,
            spendingTxId,
            timeoutMs,
          },
        });
      }
    })
    .catch((err) => {
      // awaitTxObserved is documented as never rejecting, but defend anyway.
      releaseReservation(utxo);
      logger.error({
        event: "reservation.release_unexpected_error",
        meta: {
          context,
          spendingTxId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    });
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
 * Rebuild the test pool from the wallet's currently-available, pool-eligible
 * outputs. The exact-size filter is pushed into the query: `amount_bigger_than`
 * and `amount_smaller_than` are both strict, so `SPLIT - 1 < amount < SPLIT + 1`
 * matches exactly `UTXO_SPLIT_AMOUNT`. Dust and large outputs are filtered by
 * the wallet, not fetched and then discarded by {@link populateFromUtxos}.
 */
export async function repopulatePoolFromWallet(
  wallet: Pick<FundWallet, "getUtxos">,
): Promise<void> {
  const split = config.UTXO_SPLIT_AMOUNT;
  const { utxos } = await wallet.getUtxos({
    token: NATIVE_TOKEN_UID,
    amount_bigger_than: split - 1n,
    amount_smaller_than: split + 1n,
    only_available_utxos: true,
  });
  populateFromUtxos(
    utxos.map((u) => ({ txId: u.tx_id, index: u.index, value: u.amount })),
  );
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
    await repopulatePoolFromWallet(deps.getGenesisWallet());
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
      if (err instanceof PoolExhaustedError && splitInProgress) {
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
    // Build/sign/broadcast failed but the UTXO was never spent — return it so
    // it can be reused immediately instead of waiting for the next rescan.
    returnChange(utxo);
    throw err;
  }

  const txId = tx.hash;
  if (!txId) {
    // The send resolved but the built tx has no hash: we cannot observe the
    // spending tx, and the input was likely already broadcast. Release the
    // reservation (a later rescan reconciles the wallet's real state) but do
    // not re-pool a possibly-spent output.
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
