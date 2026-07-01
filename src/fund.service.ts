import { TransactionTemplateBuilder } from "@hathor/wallet-lib/lib/template/transaction";
import SendTransaction from "@hathor/wallet-lib/lib/new/sendTransaction";
import { NATIVE_TOKEN_UID } from "@hathor/wallet-lib/lib/constants";
import { getGenesisWallet, getGenesisAddress } from "./genesis.service";
import {
  addTestUtxos,
  setLargeUtxo,
  returnChange,
  needsRefill,
  reserveUtxo,
  releaseReservation,
  populateFromUtxos,
  getPoolStats,
  type Utxo,
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
  getAvailableUtxos(
    options: { token: string },
  ): AsyncIterable<{ txId: string; index: number; value: number | bigint }>;
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

    const template = builder.build();
    const tx = await wallet.buildTxTemplate(template, {
      signTx: true,
      pinCode: config.WALLET_PIN_CODE,
    });

    try {
      await deps.runSendTransaction(wallet, tx);
    } catch (err) {
      releaseReservation(utxo);
      throw err;
    }

    const txId = tx.hash!;

    scheduleReservationRelease(wallet as unknown as TxObservationWallet, utxo, txId, "split");

    const newTestUtxos: Utxo[] = [];
    for (let i = 0; i < maxOutputs; i++) {
      newTestUtxos.push({
        txId,
        index: i,
        amount: splitAmount,
      });
    }
    addTestUtxos(newTestUtxos);

    if (tx.outputs.length > maxOutputs) {
      const changeOutput = tx.outputs[maxOutputs]!;
      const changeAmount = BigInt(changeOutput.value);
      if (changeAmount > 0n) {
        setLargeUtxo({ txId, index: maxOutputs, amount: changeAmount });
      }
    }

    lastSplitAt = new Date().toISOString();
    lastSplitError = null;
    recordSplit(true);

    logger.info({
      event: "split.completed",
      meta: { txId, createdUtxos: newTestUtxos.length },
    });
  } catch (err) {
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
 * the just-spent UTXO into a bucket). Bounded by `OBSERVATION_TIMEOUT_MS`;
 * on timeout the reservation is released with a warn log.
 */
function scheduleReservationRelease(
  wallet: TxObservationWallet,
  utxo: { txId: string; index: number },
  spendingTxId: string,
  context: "fund" | "split",
): void {
  awaitTxObserved(wallet, spendingTxId, config.OBSERVATION_TIMEOUT_MS)
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
            timeoutMs: config.OBSERVATION_TIMEOUT_MS,
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
    const wallet = deps.getGenesisWallet();

    const utxos: Array<{ txId: string; index: number; value: bigint }> = [];
    for await (const utxo of wallet.getAvailableUtxos({ token: NATIVE_TOKEN_UID })) {
      utxos.push({
        txId: utxo.txId,
        index: utxo.index,
        value: BigInt(utxo.value),
      });
    }

    populateFromUtxos(utxos);
    recordRescan();
    lastRescanAt = new Date().toISOString();
    lastRescanError = null;

    const stats = getPoolStats();
    logger.info({
      event: "rescan.completed",
      meta: {
        testUtxos: stats.testUtxos,
        leftoverUtxos: stats.leftoverUtxos,
        largeUtxoAmount: stats.largeUtxoAmount?.toString() ?? null,
      },
    });

    if (stats.testUtxos === 0 && stats.largeUtxoAmount !== null) {
      logger.info({ event: "rescan.trigger_split_after_empty_pool" });
      const { utxo: largeUtxo } = await reserveUtxo(stats.largeUtxoAmount);
      await splitUtxo(largeUtxo);
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
  if (rescanInProgress) {
    logger.info({ event: "fund.waiting_for_rescan" });
    await rescanInProgress;
  }

  return attemptFund(address, amount, 1);
}

/** Internal: reserve a UTXO, build and send the tx, retrying once on stale-UTXO errors. */
async function attemptFund(
  address: string,
  amount: bigint,
  retriesLeft: number,
): Promise<FundResult> {
  let reserved;
  try {
    reserved = await reserveUtxo(amount);
  } catch (err) {
    // RFC: when a small-amount reservation fails because the test pool is
    // empty AND a split is currently running, surface SPLIT_IN_PROGRESS so
    // clients see "pool will refill shortly" rather than "exhausted, give up".
    if (err instanceof PoolExhaustedError && splitInProgress) {
      throw new SplitInProgressError();
    }
    throw err;
  }
  const { utxo, source: utxoSource } = reserved;

  const wallet = deps.getGenesisWallet();
  const genesisAddr = deps.getGenesisAddress();

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
  const tx = await wallet.buildTxTemplate(template, {
    signTx: true,
    pinCode: config.WALLET_PIN_CODE,
  });

  try {
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
    returnChange(utxo);
    if (isStaleUtxoError(err)) {
      // Stale on the final attempt — RFC's UTXO_STALE response.
      throw new UtxoStaleError(
        err instanceof Error ? err.message : "Reserved UTXO was already spent",
        { cause: err },
      );
    }
    throw err;
  }

  const txId = tx.hash!;

  scheduleReservationRelease(wallet as unknown as TxObservationWallet, utxo, txId, "fund");

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
    const stats = getPoolStats();

    if (!stats.largeUtxoAmount || stats.largeUtxoAmount <= config.UTXO_SPLIT_AMOUNT * 2n) {
      return;
    }

    reserveUtxo(stats.largeUtxoAmount)
      .then(({ utxo }) => splitUtxo(utxo))
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Unknown refill error";
        logger.error({ event: "refill.failed", meta: { error: message } });
      });
  }, 1_500);
}
