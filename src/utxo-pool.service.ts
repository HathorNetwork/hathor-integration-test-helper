/**
 * UTXO pool with the RFC's reservation invariant.
 *
 * The genesis wallet's coins are sorted into three buckets:
 *  - `testUtxos`    — FIFO queue of ~UTXO_SPLIT_AMOUNT HTR outputs used to
 *                     fund standard test requests.
 *  - `largeUtxo`    — a single big output used as the input to split
 *                     transactions (and claimed directly for large funds).
 *  - `leftoverUtxos`— variable-amount outputs (e.g. partial-funding change).
 *
 * A `reservedSet` tracks UTXOs currently in-flight so a concurrent rescan
 * (`populateFromUtxos`) cannot re-introduce an in-flight output into a
 * bucket and hand it to a second request. This set — not the buckets — is
 * the source of truth for in-flight UTXOs and is the core of the RFC's
 * "Race-condition freedom" guarantee.
 */

import { config } from "./config";
import { logger } from "./logger";
import { PoolExhaustedError, FundTimeoutError } from "./errors";

/** An unspent transaction output identified by txId and output index. */
export interface Utxo {
  txId: string;
  index: number;
  amount: bigint;
}

/** Which pool bucket the reserved UTXO was drawn from. */
export type UtxoSource = "test" | "large" | "leftover";

/** A UTXO reserved for a funding transaction, tagged with its source bucket. */
export interface ReservedUtxo {
  utxo: Utxo;
  source: UtxoSource;
}

/** Point-in-time counts the readiness/status routes report. */
export interface PoolStats {
  readonly testUtxos: number;
  readonly leftoverUtxos: number;
  readonly largeUtxoAmount: bigint | null;
}

/** FIFO queue of ~UTXO_SPLIT_AMOUNT HTR UTXOs for standard test funding */
let testUtxos: Utxo[] = [];

/** Single large UTXO used as input for split transactions */
let largeUtxo: Utxo | null = null;

/** Variable-amount UTXOs from partial funding change */
let leftoverUtxos: Utxo[] = [];

/**
 * Set of UTXOs currently reserved by an in-flight fund/split operation,
 * keyed by `${txId}:${index}`. The set is the helper's source of truth
 * for in-flight UTXOs and must NOT be cleared by `populateFromUtxos`,
 * which only rebuilds bucket views from `wallet.getAvailableUtxos()`.
 *
 * This exists so a rescan triggered while another request is mid-flight
 * cannot re-introduce that request's UTXO into a bucket and hand it to
 * a second request. See the RFC's "Race-condition freedom" section.
 */
const reservedSet = new Set<string>();

function utxoKey(u: { txId: string; index: number }): string {
  return `${u.txId}:${u.index}`;
}

/** Mark a UTXO as in-flight. Idempotent. */
function markReserved(u: Utxo): void {
  reservedSet.add(utxoKey(u));
}

/** Release an in-flight reservation. Returns true if the entry existed. */
export function releaseReservation(u: { txId: string; index: number }): boolean {
  return reservedSet.delete(utxoKey(u));
}

/** Test helper: snapshot the current reserved set. */
export function getReservedKeys(): string[] {
  return Array.from(reservedSet);
}

/** Waiters for the large UTXO (resolved when one becomes available) */
const largeUtxoWaiters: Array<{
  amount: bigint;
  resolve: (utxo: Utxo) => void;
  reject: (err: Error) => void;
  cancel: () => void;
}> = [];

function rejectAndClearLargeUtxoWaiters(reason: string): void {
  while (largeUtxoWaiters.length > 0) {
    const waiter = largeUtxoWaiters.shift()!;
    waiter.cancel();
    waiter.reject(new PoolExhaustedError(reason));
  }
}

function dispatchLargeUtxoToWaiter(utxo: Utxo): boolean {
  const waiterIndex = largeUtxoWaiters.findIndex((waiter) => waiter.amount <= utxo.amount);
  if (waiterIndex === -1) {
    return false;
  }

  const waiter = largeUtxoWaiters.splice(waiterIndex, 1)[0];
  if (!waiter) {
    return false;
  }
  waiter.cancel();
  waiter.resolve(utxo);
  return true;
}

/**
 * Categorize a UTXO into the test-sized bucket.
 *
 * The test bucket funds standard requests, whose default amount is exactly
 * `UTXO_SPLIT_AMOUNT`. Funding uses a single reserved input with no top-up
 * selection (`skipSelection: true`), so a reserved UTXO MUST cover the
 * request on its own — otherwise the built tx carries an output larger than
 * its input and the fullnode rejects it as an "invalid surplus of HTR".
 *
 * Therefore the lower bound is `UTXO_SPLIT_AMOUNT` itself (not 90% of it):
 * a below-target output (e.g. a 975 HTR change) cannot fund a default
 * request and belongs in `leftoverUtxos`, where it still serves
 * smaller-amount requests. The +10% upper bound admits slightly-larger
 * change so it can be reused as test capacity (the excess becomes change).
 */
function isTestSized(amount: bigint): boolean {
  const target = config.UTXO_SPLIT_AMOUNT;
  return amount >= target && amount <= target * 11n / 10n;
}

/**
 * After genesis wallet syncs, scan its UTXOs and sort them into buckets.
 *
 * UTXOs currently reserved by an in-flight operation are excluded:
 * the wallet's view may still show an in-flight UTXO as available
 * (during the build/sign window or before WS observation), and
 * re-introducing it here would let a second request reserve the
 * same UTXO. The reservation owner is responsible for releasing
 * it once the consuming tx is observed.
 */
export function populateFromUtxos(
  utxos: Array<{ txId: string; index: number; value: bigint }>,
): void {
  testUtxos = [];
  largeUtxo = null;
  leftoverUtxos = [];
  rejectAndClearLargeUtxoWaiters("Pool reset");

  let largestAmount = 0n;
  let largestUtxo: Utxo | null = null;
  let skippedReserved = 0;

  for (const u of utxos) {
    if (reservedSet.has(utxoKey(u))) {
      skippedReserved += 1;
      continue;
    }

    const utxo: Utxo = { txId: u.txId, index: u.index, amount: u.value };

    if (isTestSized(u.value)) {
      testUtxos.push(utxo);
    } else if (u.value > largestAmount) {
      // Push previous largest to leftovers if it existed
      if (largestUtxo) {
        leftoverUtxos.push(largestUtxo);
      }
      largestAmount = u.value;
      largestUtxo = utxo;
    } else {
      leftoverUtxos.push(utxo);
    }
  }

  largeUtxo = largestUtxo;

  logger.info({
    event: "utxo_pool.populated",
    meta: {
      testUtxos: testUtxos.length,
      largeUtxoAmount: largeUtxo ? largeUtxo.amount.toString() : "0",
      leftoverUtxos: leftoverUtxos.length,
      skippedReserved,
    },
  });
}

/**
 * Reserve a UTXO for a funding transaction.
 *
 * - amount <= UTXO_SPLIT_AMOUNT: dequeue from testUtxos (FIFO),
 *   fallback to leftoverUtxos (find first sufficient).
 * - amount > UTXO_SPLIT_AMOUNT: claim largeUtxo or wait with timeout.
 *
 * The synchronous dequeue is atomic in the JS event loop — no races.
 */
export async function reserveUtxo(
  amount: bigint,
  options?: { timeoutMs?: number },
): Promise<ReservedUtxo> {
  const timeoutMs = options?.timeoutMs ?? config.FUND_TIMEOUT_MS;

  if (amount <= config.UTXO_SPLIT_AMOUNT) {
    // Try the test-sized pool first, but only reserve a UTXO that actually
    // covers the request. `isTestSized` already keeps the bucket at
    // >= UTXO_SPLIT_AMOUNT, so the FIFO head normally qualifies; this guard
    // defends against any below-amount UTXO slipping in (funding does not
    // top up inputs, so an insufficient reservation would build an invalid
    // tx). The first sufficient entry preserves near-FIFO ordering.
    const testIdx = testUtxos.findIndex((u) => u.amount >= amount);
    if (testIdx !== -1) {
      const utxo = testUtxos.splice(testIdx, 1)[0]!;
      markReserved(utxo);
      return { utxo, source: "test" };
    }

    // Fallback: find a sufficient leftover
    const idx = leftoverUtxos.findIndex((u) => u.amount >= amount);
    if (idx !== -1) {
      const leftover = leftoverUtxos.splice(idx, 1)[0]!;
      markReserved(leftover);
      return { utxo: leftover, source: "leftover" };
    }

    throw new PoolExhaustedError("No available UTXOs for this amount");
  }

  // Large amount: claim largeUtxo or wait
  if (largeUtxo && largeUtxo.amount >= amount) {
    const utxo = largeUtxo;
    largeUtxo = null;
    markReserved(utxo);
    return { utxo, source: "large" };
  }

  // Wait for a large UTXO to become available
  return new Promise<ReservedUtxo>((resolve, reject) => {
    let settled = false;

    const complete = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      const idx = largeUtxoWaiters.findIndex((w) => w.resolve === wrappedResolve);
      if (idx !== -1) largeUtxoWaiters.splice(idx, 1);
      complete(() => {
        reject(new FundTimeoutError(timeoutMs));
      });
    }, timeoutMs);

    const wrappedResolve = (utxo: Utxo) => {
      complete(() => {
        markReserved(utxo);
        resolve({ utxo, source: "large" });
      });
    };
    const wrappedReject = (err: Error) => {
      complete(() => reject(err));
    };

    largeUtxoWaiters.push({
      amount,
      resolve: wrappedResolve,
      reject: wrappedReject,
      cancel: () => clearTimeout(timer),
    });
  });
}

/**
 * Return a change UTXO back to the pool after a transaction.
 */
export function returnChange(utxo: Utxo): void {
  if (isTestSized(utxo.amount)) {
    testUtxos.push(utxo);
    return;
  }

  if (utxo.amount > config.UTXO_SPLIT_AMOUNT) {
    if (dispatchLargeUtxoToWaiter(utxo)) {
      return;
    }

    if (!largeUtxo) {
      largeUtxo = utxo;
    } else {
      leftoverUtxos.push(utxo);
    }
    return;
  }

  leftoverUtxos.push(utxo);
}

/**
 * Add multiple test-sized UTXOs (after a split transaction).
 */
export function addTestUtxos(utxos: Utxo[]): void {
  testUtxos.push(...utxos);
}

/**
 * Set the large UTXO (e.g. change from a split transaction).
 */
export function setLargeUtxo(utxo: Utxo): void {
  if (dispatchLargeUtxoToWaiter(utxo)) {
    return;
  }
  largeUtxo = utxo;
}

/** True when the test-sized pool drops below the configured refill threshold. */
export function needsRefill(): boolean {
  return testUtxos.length < config.REFILL_THRESHOLD;
}

/** Return current UTXO counts across all three pool buckets. */
export function getPoolStats(): PoolStats {
  return {
    testUtxos: testUtxos.length,
    leftoverUtxos: leftoverUtxos.length,
    largeUtxoAmount: largeUtxo?.amount ?? null,
  };
}
