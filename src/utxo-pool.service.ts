/**
 * UTXO pool with the RFC's reservation invariant.
 *
 * The genesis wallet's coins are sorted into three buckets:
 *  - `testUtxos`     — FIFO queue of ~UTXO_SPLIT_AMOUNT HTR outputs that fund
 *                      standard test requests.
 *  - `largeUtxo`     — one big output, used as the input to split
 *                      transactions and claimed directly for large funds.
 *  - `leftoverUtxos` — variable-amount outputs (e.g. partial-funding change).
 *
 * A `reservedSet` tracks the UTXOs currently in-flight so that a concurrent
 * rescan (`populateFromUtxos`) cannot re-introduce an in-flight output into a
 * bucket and hand it to a second request. That set — not the buckets — is the
 * source of truth for in-flight UTXOs and is the heart of the RFC's
 * "Race-condition freedom" guarantee.
 */

import { config } from "./config";
import { logger } from "./logger";
import { PoolExhaustedError, FundTimeoutError } from "./errors";

/** An unspent transaction output identified by its txId and output index. */
export interface Utxo {
  txId: string;
  index: number;
  amount: bigint;
}

/** Which pool bucket a reserved UTXO was drawn from. */
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

/** FIFO queue of ~UTXO_SPLIT_AMOUNT HTR UTXOs for standard test funding. */
let testUtxos: Utxo[] = [];

/** Single large UTXO used as the input for split transactions. */
let largeUtxo: Utxo | null = null;

/** Variable-amount UTXOs, e.g. partial-funding change. */
let leftoverUtxos: Utxo[] = [];

/**
 * Keys (`${txId}:${index}`) of UTXOs held by an in-flight fund/split
 * operation. This set is the source of truth for in-flight UTXOs and must
 * NOT be cleared by `populateFromUtxos`, which only rebuilds the bucket
 * views from the wallet's reported UTXOs. Keeping it separate is what lets a
 * rescan run mid-flight without re-handing a reserved UTXO to a second
 * request. The reservation owner releases it once the consuming tx settles.
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

/** Snapshot the current reserved keys (test/observability seam). */
export function getReservedKeys(): string[] {
  return Array.from(reservedSet);
}

/**
 * Pending claims for the large UTXO. A large-amount `reserveUtxo` that finds
 * no suitable `largeUtxo` parks a waiter here; `returnChange`/`setLargeUtxo`
 * hand a newly-available output to the first waiter it fits.
 */
interface LargeUtxoWaiter {
  amount: bigint;
  resolve: (utxo: Utxo) => void;
  cancel: () => void;
}

const largeUtxoWaiters: LargeUtxoWaiter[] = [];

/**
 * Hand `utxo` to the first parked waiter whose amount it covers. Returns true
 * if a waiter took it (so the caller must not also store it in a bucket).
 */
function dispatchLargeUtxoToWaiter(utxo: Utxo): boolean {
  const idx = largeUtxoWaiters.findIndex((w) => w.amount <= utxo.amount);
  if (idx === -1) {
    return false;
  }
  const [waiter] = largeUtxoWaiters.splice(idx, 1);
  waiter!.cancel();
  waiter!.resolve(utxo);
  return true;
}

/**
 * Whether `amount` belongs in the test-sized bucket.
 *
 * The test bucket funds standard requests, whose default amount is exactly
 * `UTXO_SPLIT_AMOUNT`. Funding reserves a single input with no top-up
 * selection, so a reserved UTXO must cover the request on its own — otherwise
 * the built tx carries an output larger than its input and the fullnode
 * rejects it as an "invalid surplus of HTR". The lower bound is therefore
 * `UTXO_SPLIT_AMOUNT` itself: a below-target output (e.g. 975 HTR change)
 * belongs in `leftoverUtxos`, where it still serves smaller requests. The
 * +10% upper bound admits slightly-larger change as reusable test capacity.
 */
function isTestSized(amount: bigint): boolean {
  const target = config.UTXO_SPLIT_AMOUNT;
  return amount >= target && amount <= (target * 11n) / 10n;
}

/**
 * Rebuild the buckets from the genesis wallet's reported UTXOs.
 *
 * The largest non-test output becomes `largeUtxo`; the rest fall into the
 * test or leftover buckets by size. UTXOs currently reserved by an in-flight
 * operation are skipped: the wallet's view may still report an in-flight UTXO
 * as available (during the build/sign window or before the consuming tx is
 * observed), and re-introducing it here would let a second request reserve
 * the same UTXO. The reservation owner is responsible for releasing it once
 * the consuming tx settles.
 */
export function populateFromUtxos(
  utxos: Array<{ txId: string; index: number; value: bigint }>,
): void {
  testUtxos = [];
  largeUtxo = null;
  leftoverUtxos = [];

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
    } else if (largestUtxo === null || u.value > largestUtxo.amount) {
      // A new largest arrived; the previous candidate becomes a leftover.
      if (largestUtxo !== null) {
        leftoverUtxos.push(largestUtxo);
      }
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
 * Reserve a UTXO that covers `amount` for a funding transaction.
 *
 * - `amount <= UTXO_SPLIT_AMOUNT`: take the first sufficient test UTXO
 *   (near-FIFO), falling back to the first sufficient leftover; throws
 *   {@link PoolExhaustedError} if neither exists.
 * - `amount > UTXO_SPLIT_AMOUNT`: claim `largeUtxo` if it covers the request,
 *   otherwise wait for one to become available and reject with
 *   {@link FundTimeoutError} after `timeoutMs`.
 *
 * The synchronous bucket dequeue is atomic within the JS event loop, so two
 * concurrent callers can never reserve the same UTXO.
 */
export async function reserveUtxo(
  amount: bigint,
  options?: { timeoutMs?: number },
): Promise<ReservedUtxo> {
  const timeoutMs = options?.timeoutMs ?? config.FUND_TIMEOUT_MS;

  if (amount <= config.UTXO_SPLIT_AMOUNT) {
    // Only reserve a UTXO that actually covers the request. `isTestSized`
    // already keeps the bucket at >= UTXO_SPLIT_AMOUNT, so the head normally
    // qualifies; the guard defends against any below-amount UTXO slipping in,
    // since funding does not top up inputs. First-sufficient keeps near-FIFO.
    const testIdx = testUtxos.findIndex((u) => u.amount >= amount);
    if (testIdx !== -1) {
      const [utxo] = testUtxos.splice(testIdx, 1);
      markReserved(utxo!);
      return { utxo: utxo!, source: "test" };
    }

    const leftoverIdx = leftoverUtxos.findIndex((u) => u.amount >= amount);
    if (leftoverIdx !== -1) {
      const [utxo] = leftoverUtxos.splice(leftoverIdx, 1);
      markReserved(utxo!);
      return { utxo: utxo!, source: "leftover" };
    }

    throw new PoolExhaustedError("No available UTXOs for this amount");
  }

  // Large amount: claim the large UTXO immediately if it covers the request.
  if (largeUtxo !== null && largeUtxo.amount >= amount) {
    const utxo = largeUtxo;
    largeUtxo = null;
    markReserved(utxo);
    return { utxo, source: "large" };
  }

  // Otherwise park a waiter until a large-enough UTXO is returned, or time out.
  return new Promise<ReservedUtxo>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = largeUtxoWaiters.findIndex((w) => w === waiter);
      if (idx !== -1) largeUtxoWaiters.splice(idx, 1);
      reject(new FundTimeoutError(timeoutMs));
    }, timeoutMs);

    const waiter: LargeUtxoWaiter = {
      amount,
      resolve: (utxo) => {
        if (settled) return;
        settled = true;
        markReserved(utxo);
        resolve({ utxo, source: "large" });
      },
      cancel: () => clearTimeout(timer),
    };

    largeUtxoWaiters.push(waiter);
  });
}

/**
 * Return an unreserved change UTXO to the pool after a transaction, routing
 * it to the bucket that matches its size. A large change output is offered to
 * any waiting large-amount reservation first.
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
    if (largeUtxo === null) {
      largeUtxo = utxo;
    } else {
      leftoverUtxos.push(utxo);
    }
    return;
  }

  leftoverUtxos.push(utxo);
}

/** Add freshly-split test-sized UTXOs to the test bucket. */
export function addTestUtxos(utxos: Utxo[]): void {
  testUtxos.push(...utxos);
}

/** Set the large UTXO (e.g. the change output of a split transaction). */
export function setLargeUtxo(utxo: Utxo): void {
  if (dispatchLargeUtxoToWaiter(utxo)) {
    return;
  }
  largeUtxo = utxo;
}

/** True when the test bucket has dropped below the configured refill threshold. */
export function needsRefill(): boolean {
  return testUtxos.length < config.REFILL_THRESHOLD;
}

/** Current UTXO counts across the three buckets. */
export function getPoolStats(): PoolStats {
  return {
    testUtxos: testUtxos.length,
    leftoverUtxos: leftoverUtxos.length,
    largeUtxoAmount: largeUtxo?.amount ?? null,
  };
}
