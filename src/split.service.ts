import { TransactionTemplateBuilder } from "@hathor/wallet-lib/lib/template/transaction";
import SendTransaction from "@hathor/wallet-lib/lib/new/sendTransaction";
import { NATIVE_TOKEN_UID } from "@hathor/wallet-lib/lib/constants";
import { getGenesisWallet, getGenesisAddress } from "./genesis.service";
import {
  addTestUtxos,
  reserveLarge,
  releaseReservation,
  populateFromUtxos,
  type Utxo,
  type ReservedUtxo,
} from "./utxo-pool.service";
import { config } from "./config";
import { logger } from "./logger";
import { recordSplit } from "./metrics";
import { awaitTxObserved, type TxObservationWallet } from "./tx-observation";

/**
 * Pool-production layer: turn the genesis wallet's large outputs into the
 * test-sized UTXOs the pool funds standard requests from — the split, the
 * wallet-sourced large reservation, and pool repopulation — plus the shared DI
 * seam through which both this module and the /fund path build transactions.
 *
 * The /fund request path (`fund.service`) depends on this module, never the
 * reverse. The two responsibilities — producing test UTXOs vs. consuming them
 * — are independent, so they live in separate files.
 */

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

/** Wallet surface the fund/split services need beyond tx observation. */
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

/** The external collaborators the fund/split services depend on. */
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

/** Current fund/split collaborators. The fund layer reads them through this. */
export function getFundDeps(): FundServiceDeps {
  return deps;
}

/** Test-only: override fund/split collaborators (DI, not mock.module). */
export function __setFundDepsForTest(overrides: Partial<FundServiceDeps>): void {
  deps = { ...defaultDeps(), ...overrides };
}

/** Test-only: restore the production collaborators. */
export function __resetFundDepsForTest(): void {
  deps = defaultDeps();
}

// Split lifecycle state. Written here (splitUtxo); the fund layer reads it to
// map a pool-exhausted reservation to a SPLIT_IN_PROGRESS response and to
// report split status (getFundingLifecycleState).
let splitInProgress = false;
let lastSplitAt: string | null = null;
let lastSplitError: string | null = null;

/**
 * Test-only: force `splitInProgress` so unit tests can assert that a
 * pool-exhausted reservation is rewritten to a SPLIT_IN_PROGRESS response.
 * Not exported through any production code path.
 */
export function __setSplitInProgressForTest(value: boolean): void {
  splitInProgress = value;
}

/** Whether a split is currently running (read by the fund layer). */
export function isSplitInProgress(): boolean {
  return splitInProgress;
}

/** Last split's timestamp/error (read by the fund lifecycle snapshot). */
export function getSplitStatus(): {
  lastSplitAt: string | null;
  lastSplitError: string | null;
} {
  return { lastSplitAt, lastSplitError };
}

/** Test-only: reset split lifecycle state (delegated to by fund's reset). */
export function __resetSplitStateForTest(): void {
  splitInProgress = false;
  lastSplitAt = null;
  lastSplitError = null;
}

/**
 * Query the genesis wallet for a large output (>= `minAmount`) and atomically
 * reserve it through the pool. Returns the reserved UTXO, or `null` when the
 * wallet currently exposes no covering output.
 *
 * The size filter is pushed into the wallet query (`amount_bigger_than`) so
 * wallet-lib returns only covering candidates — we never materialise the full
 * UTXO set just to find one large output. `amount_bigger_than` is a strict `>`,
 * so it is set to `minAmount - 1` to keep the `>= minAmount` contract.
 *
 * `includeLocked` controls whether height-/time-locked outputs are candidates.
 * wallet-lib's `only_available_utxos: true` drops BOTH time-locked and
 * height-locked (block-reward) outputs (`memory_store` `isLocked`). The live
 * `/fund` path needs an immediately-spendable output, so it leaves this false.
 * Initial seeding sets it true: on a fresh testnet the genesis reward is still
 * height-locked, and the split path must be able to *select* it and then wait
 * the lock out via {@link waitForUtxoUnlock} — with the default filter it would
 * never surface and seeding could never proceed.
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
  options: { includeLocked?: boolean } = {},
): Promise<ReservedUtxo | null> {
  const wallet = deps.getGenesisWallet();
  const { utxos } = await wallet.getUtxos({
    token: NATIVE_TOKEN_UID,
    amount_bigger_than: minAmount - 1n,
    only_available_utxos: !options.includeLocked,
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
 * `null` at the deadline — the caller maps that to a FUND_TIMEOUT response.
 */
export async function reserveLargeWithTimeout(
  amount: bigint,
  timeoutMs: number = config.FUND_TIMEOUT_MS,
  pollIntervalMs: number = LARGE_UTXO_POLL_INTERVAL_MS,
): Promise<ReservedUtxo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The deadline is enforced between queries, not around each query, on
    // purpose: reserveLargeFromWallet's getUtxos is a synchronous in-process
    // read of the wallet's already-synced UTXO store (not a fullnode round-trip
    // — see genesis.service.isGenesisFunded), so it returns promptly and cannot
    // hang. Wrapping this local read in an AbortSignal/timeout race (wallet-lib
    // exposes no cancellation anyway) would add machinery for a stall that this
    // call path can't produce.
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
    // Release only — no returnChange: the input is always large (reserveLarge
    // rejects test-sized amounts), and the pool holds only test-sized outputs.
    // The wallet retains the output on-chain; the next split rediscovers it.
    logger.info({ event: "split.skipped_already_in_progress" });
    releaseReservation(utxo);
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
      // Release only — same rationale as the in-progress skip above: the input
      // is large-but-unsplittable, which the pool never holds.
      logger.warn({
        event: "split.skipped_small_utxo",
        meta: { txId: utxo.txId, index: utxo.index, amount: utxo.amount.toString() },
      });
      releaseReservation(utxo);
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
      // No hash means we can't observe the spending tx, so we can't defer the
      // release — release now. This is safe: repopulation only ever pools the
      // wallet's *available* outputs, so if the send did spend this input the
      // wallet won't report it and it can't be re-pooled; if it didn't spend,
      // re-pooling it is correct. Holding it reserved forever is the worse
      // option (a rescan/admit skips reserved keys, so it would never heal).
      releaseReservation(utxo);
      throw new Error("Split transaction completed without a hash");
    }

    scheduleReservationRelease(wallet, utxo, txId, "split");

    // Pool by verified output value, not by positional trust: rather than
    // assuming indices 0..maxOutputs-1 are the split outputs, read the built
    // transaction and pool exactly the outputs whose value is splitAmount.
    // This stays correct if wallet-lib ever reorders outputs, and it pools an
    // exactly-split-sized change output too — legitimate, since any later
    // wallet rescan (repopulatePoolFromWallet) would pool it anyway.
    const newTestUtxos: Utxo[] = [];
    tx.outputs.forEach((output, index) => {
      if (BigInt(output.value) === splitAmount) {
        newTestUtxos.push({ txId, index, amount: splitAmount });
      }
    });
    addTestUtxos(newTestUtxos);

    // A larger-than-split change output is excluded by the value check and
    // intentionally not pooled. It stays on-chain in the genesis wallet, and
    // the next split rediscovers it via a live wallet query
    // (reserveLargeFromWallet).

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
 * by the wallet (so a concurrent pool rescan cannot re-introduce
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
