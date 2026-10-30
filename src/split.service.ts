import { TransactionTemplateBuilder } from "@hathor/wallet-lib/lib/template/transaction";
import SendTransaction from "@hathor/wallet-lib/lib/new/sendTransaction";
import type { ISendOutput } from "@hathor/wallet-lib/lib/new/sendTransaction";
import {
  FEE_PER_FULL_SHIELDED_OUTPUT,
  MAX_OUTPUTS,
  NATIVE_TOKEN_UID,
} from "@hathor/wallet-lib/lib/constants";
import { OutputKind } from "@hathor/wallet-lib/lib/shielded/types";
import { getGenesisWallet, getGenesisAddress } from "./genesis.service";
import {
  addTestUtxos,
  reserveFee,
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

/** Explicit-input send: what a template can't express (shielded outputs). */
export interface SendOutputsRequest {
  outputs: ISendOutput[];
  inputs: Array<{ txId: string; index: number }>;
  changeAddress: string;
}

/** The external collaborators the fund/split services depend on. */
export interface FundServiceDeps {
  getGenesisWallet: () => FundWallet;
  getGenesisAddress: () => string;
  newTemplateBuilder: () => FundTemplateBuilder;
  runSendTransaction: (wallet: unknown, transaction: unknown) => Promise<void>;
  /**
   * Build, sign, mine and push a tx spending exactly `inputs`, with transparent
   * change. Resolves with the sent tx's hash.
   */
  sendOutputs: (
    wallet: unknown,
    request: SendOutputsRequest,
  ) => Promise<{ hash?: string | null }>;
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
    sendOutputs: async (wallet, { outputs, inputs, changeAddress }) => {
      const sendTx = new SendTransaction({
        wallet,
        outputs,
        inputs,
        changeAddress,
        // Keep change transparent: the wallet rediscovers it as a plain output.
        changeShieldedMode: OutputKind.TRANSPARENT,
        pin: config.WALLET_PIN_CODE,
      } as ConstructorParameters<typeof SendTransaction>[0]);
      return sendTx.run();
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
 * Whether the tx that created an output has a timestamp before `nowSeconds`.
 *
 * The fullnode rejects a tx whose timestamp is not strictly greater than that
 * of every tx it spends from, at 1-second granularity. Wallet-sourced outputs
 * are often change from a fund sent moments ago, so spending one in the same
 * second fails validation. Skipping it costs a short wait (large funding
 * polls) or a fallback (fee sourcing). An output whose tx the wallet can't
 * date is skipped too. The read is local wallet storage, not a fullnode call.
 */
async function createdBefore(
  wallet: Pick<FundWallet, "getTx">,
  txId: string,
  nowSeconds: number,
): Promise<boolean> {
  const tx = (await wallet.getTx(txId)) as { timestamp?: unknown } | null;
  return typeof tx?.timestamp === "number" && tx.timestamp < nowSeconds;
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const u of utxos) {
    if (!(await createdBefore(wallet, u.tx_id, nowSeconds))) continue;
    const reserved = reserveLarge({ txId: u.tx_id, index: u.index, amount: u.amount });
    if (reserved !== null) {
      return reserved;
    }
  }
  return null;
}

/**
 * Query the genesis wallet for the smallest available below-split output of at
 * least `minAmount` and reserve it to pay a shielded fund's fee. Returns `null`
 * when none is free.
 *
 * Below-split outputs are what the pool otherwise ignores: change from funds
 * smaller than `UTXO_SPLIT_AMOUNT`, and the fee seeds each split mints. Paying
 * a fee spends one and leaves its remainder as another, so they keep serving
 * fees. The smallest covering output is taken so larger ones stay usable.
 */
export async function reserveFeeFromWallet(
  minAmount: bigint,
): Promise<ReservedUtxo | null> {
  const wallet = deps.getGenesisWallet();
  const { utxos } = await wallet.getUtxos({
    token: NATIVE_TOKEN_UID,
    amount_bigger_than: minAmount - 1n,
    amount_smaller_than: config.UTXO_SPLIT_AMOUNT,
    only_available_utxos: true,
  });
  const bySize = [...utxos].sort((a, b) =>
    a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0,
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const u of bySize) {
    if (!(await createdBefore(wallet, u.tx_id, nowSeconds))) continue;
    const reserved = reserveFee({ txId: u.tx_id, index: u.index, amount: u.amount });
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
  return pollReservation(() => reserveLargeFromWallet(amount), timeoutMs, pollIntervalMs);
}

/**
 * Run `attempt` until it returns a reservation or `timeoutMs` passes, sleeping
 * `pollIntervalMs` between tries. The first try runs immediately. Returns
 * `null` at the deadline.
 */
export async function pollReservation<T>(
  attempt: () => Promise<T | null>,
  timeoutMs: number = config.FUND_TIMEOUT_MS,
  pollIntervalMs: number = LARGE_UTXO_POLL_INTERVAL_MS,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The deadline is enforced between attempts, not around each one, on
    // purpose: the wallet queries behind them are synchronous in-process
    // reads of the wallet's already-synced UTXO store (not a fullnode
    // round-trip — see genesis.service.isGenesisFunded), so they return
    // promptly and cannot hang. Wrapping a local read in an
    // AbortSignal/timeout race (wallet-lib exposes no cancellation anyway)
    // would add machinery for a stall that this call path can't produce.
    const reserved = await attempt();
    if (reserved !== null) return reserved;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }
}

/** Fee outputs each split mints for {@link reserveFeeFromWallet}. */
const FEE_SEED_COUNT = 2;

/**
 * Size of each fee seed: half a test UTXO, so below the split amount (never
 * pooled, never large) and far above any shielded fee. `null` when the split
 * amount is too small for a seed to pay the largest fee (two fully shielded
 * outputs).
 */
function feeSeedAmount(splitAmount: bigint): bigint | null {
  const seed = splitAmount / 2n;
  return seed >= FEE_PER_FULL_SHIELDED_OUTPUT * 2n ? seed : null;
}

/**
 * How many test outputs a split of `inputAmount` mints: the configured count,
 * capped so the seeds and the change output still fit the tx's output limit,
 * and so one split amount stays back for the seeds and change.
 */
export function splitOutputCount(
  inputAmount: bigint,
  splitAmount: bigint,
  configuredCount: number,
  seedCount: number,
): number {
  return Math.min(
    configuredCount,
    MAX_OUTPUTS - seedCount - 1,
    Number(inputAmount / splitAmount) - 1,
  );
}

/**
 * Split a large UTXO into many test-sized UTXOs.
 * Used at startup and whenever the pool runs low.
 *
 * Input:  1 large UTXO
 * Output: N × {genesisAddr, UTXO_SPLIT_AMOUNT}
 *         + 2 × {genesisAddr, UTXO_SPLIT_AMOUNT / 2} (fee seeds)
 *         + 1 × {genesisAddr, change}
 *
 * The fee seeds give default-size shielded funds a fee input even when no
 * smaller fund has left change behind. They fit in the split amount that
 * `maxOutputs` already keeps back from the test outputs.
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

    const seedAmount = feeSeedAmount(splitAmount);
    const seedCount = seedAmount === null ? 0 : FEE_SEED_COUNT;
    const maxOutputs = splitOutputCount(
      utxo.amount,
      splitAmount,
      config.UTXO_SPLIT_COUNT,
      seedCount,
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
    if (seedAmount !== null) {
      for (let i = 0; i < seedCount; i++) {
        builder.addTokenOutput({ address: "{addr}", amount: seedAmount });
      }
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
    // Stamped on the failure path too, so /status never shows this error beside
    // the *previous* split's timestamp.
    lastSplitAt = new Date().toISOString();
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
