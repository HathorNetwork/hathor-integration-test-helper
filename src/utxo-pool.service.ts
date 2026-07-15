/**
 * UTXO pool with the RFC's reservation invariant.
 *
 * The pool exists to give many concurrent tests fast, race-free funding for
 * *standard* (test-sized) amounts. It is a pure, synchronous in-memory
 * reservation authority — it holds no wallet handle and does no I/O:
 *
 *  - `testUtxos`   — FIFO queue of ~UTXO_SPLIT_AMOUNT HTR outputs that fund
 *                    standard test requests.
 *  - `reservedSet` — keys (`${txId}:${index}`) of every UTXO an in-flight
 *                    operation holds, test OR large. This — not the bucket — is
 *                    the source of truth for in-flight UTXOs.
 *
 * Large funding is deliberately NOT mirrored here. Large requests are rare and
 * latency-tolerant, so the consumer queries the wallet live
 * (`getUtxos({ amount_bigger_than, only_available_utxos })`) and reserves a
 * chosen output through {@link reserveLarge}. The wallet, not a hand-maintained
 * slot, is the source of truth for large outputs — which removes an entire
 * class of drift bugs (a stale slot, extra larges hiding in a leftover bucket).
 *
 * Two invariants keep this race-free:
 *
 *  1. Availability XOR reservation. A UTXO's key is in `testUtxos` (available)
 *     or in `reservedSet` (in-flight), never both and never silently neither.
 *     The insert paths enforce it via {@link admitToPool}; `populateFromUtxos`
 *     skips reserved keys.
 *  2. Atomic reservation. Every reserve (`reserveUtxo`, `reserveLarge`) is
 *     synchronous, so "read state → markReserved" runs in one uninterrupted
 *     event-loop tick. Two concurrent callers can never win the same UTXO —
 *     even when a large candidate came from an async wallet query, the pick is
 *     synchronous.
 *
 * Callers follow **release-before-return**: to hand an in-flight UTXO back
 * (e.g. a failed tx), release its reservation first, then return it. Returning
 * while still reserved is misuse and {@link admitToPool} drops it defensively.
 */

import { config } from "./config";
import { logger } from "./logger";
import { PoolExhaustedError } from "./errors";

/**
 * An unspent transaction output identified by its txId and output index.
 *
 * All fields are `readonly`: `${txId}:${index}` is the reservation key, and
 * the pool's race-freedom guarantee depends on that key staying stable between
 * `markReserved` and `releaseReservation`. A mutated identifier would strand
 * the UTXO as permanently reserved; `amount` is likewise immutable for an
 * on-chain output.
 */
export interface Utxo {
  readonly txId: string;
  readonly index: number;
  readonly amount: bigint;
}

/** Which pool source a reserved UTXO was drawn from. */
export type UtxoSource = "test" | "large";

/** A UTXO reserved for a funding transaction, tagged with its source. */
export interface ReservedUtxo {
  utxo: Utxo;
  source: UtxoSource;
}

/** Point-in-time counts the readiness/status routes report. */
export interface PoolStats {
  readonly testUtxos: number;
}

/** FIFO queue of ~UTXO_SPLIT_AMOUNT HTR UTXOs for standard test funding. */
let testUtxos: Utxo[] = [];

/**
 * Keys (`${txId}:${index}`) of UTXOs held by an in-flight fund/split
 * operation, test or large. This set is the source of truth for in-flight
 * UTXOs and must NOT be cleared by `populateFromUtxos`, which only rebuilds the
 * test bucket from the wallet's reported UTXOs. Keeping it separate is what
 * lets a rescan run mid-flight without re-handing a reserved UTXO to a second
 * request. The reservation owner releases it once the consuming tx settles.
 */
const reservedSet = new Set<string>();

function utxoKey(u: { txId: string; index: number }): string {
  return `${u.txId}:${u.index}`;
}

/** Whether `key` is currently sitting in the test bucket. */
function isPooled(key: string): boolean {
  return testUtxos.some((u) => utxoKey(u) === key);
}

/**
 * Guard for the public insert paths (`returnChange`, `addTestUtxos`): a UTXO
 * may enter the bucket only when it is neither in-flight nor already pooled.
 * This preserves the pool's core invariant — a UTXO is available (in the
 * bucket) XOR in-flight (in `reservedSet`), never both — which is what stops a
 * still-reserved output from being handed to a second request.
 *
 * A rejected UTXO is dropped with a warning rather than pooled: the caller
 * either returned it before releasing (fix: release first) or a rescan already
 * pooled it. Dropped output self-heals — once released, the next rescan
 * re-introduces it — so misuse degrades to a delay, never a double-spend.
 */
function admitToPool(utxo: Utxo, via: string): boolean {
  const key = utxoKey(utxo);
  if (reservedSet.has(key)) {
    logger.warn({
      event: "utxo_pool.return_while_reserved",
      meta: { via, key, amount: utxo.amount.toString() },
    });
    return false;
  }
  if (isPooled(key)) {
    logger.warn({
      event: "utxo_pool.duplicate_insert",
      meta: { via, key, amount: utxo.amount.toString() },
    });
    return false;
  }
  return true;
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
 * Whether `amount` is a pool UTXO, i.e. exactly `UTXO_SPLIT_AMOUNT`.
 *
 * There is no margin. The split transaction mints outputs of exactly
 * `UTXO_SPLIT_AMOUNT`, so those are the only outputs the pool funds standard
 * requests with. Anything else — below-target change, a large output, or a
 * near-miss — is not the pool's concern: the wallet holds it, and large
 * funding queries the wallet live. Collapsing "test-sized" to a single exact
 * value also removes the overlap band a large query could otherwise reach into
 * (a slightly-larger pooled UTXO that also satisfies `amount_bigger_than`),
 * which would let the same output be reserved as both a test and a large UTXO.
 */
function isTestSized(amount: bigint): boolean {
  return amount === config.UTXO_SPLIT_AMOUNT;
}

/**
 * Rebuild the test bucket from the genesis wallet's reported UTXOs.
 *
 * Only test-sized outputs are pooled. Non-test outputs (below-target dust and
 * large outputs alike) are ignored: large funding queries the wallet live, so
 * mirroring large outputs here would only invite drift. UTXOs currently
 * reserved by an in-flight operation are skipped — the wallet's view may still
 * report an in-flight UTXO as available (during the build/sign window or before
 * the consuming tx is observed), and re-introducing it would let a second
 * request reserve the same UTXO. The reservation owner releases it once the
 * consuming tx settles.
 */
export function populateFromUtxos(
  utxos: Array<{ txId: string; index: number; value: bigint }>,
): void {
  testUtxos = [];

  const seen = new Set<string>();
  let skippedReserved = 0;
  let skippedDuplicate = 0;
  let skippedNonTest = 0;

  for (const u of utxos) {
    const key = utxoKey(u);
    if (reservedSet.has(key)) {
      skippedReserved += 1;
      continue;
    }
    if (!isTestSized(u.value)) {
      skippedNonTest += 1;
      continue;
    }
    if (seen.has(key)) {
      // The wallet reported the same output twice; pooling it twice would let
      // two requests reserve one physical UTXO.
      skippedDuplicate += 1;
      continue;
    }
    seen.add(key);
    testUtxos.push({ txId: u.txId, index: u.index, amount: u.value });
  }

  logger.info({
    event: "utxo_pool.populated",
    meta: {
      testUtxos: testUtxos.length,
      skippedReserved,
      skippedDuplicate,
      skippedNonTest,
    },
  });
}

/**
 * Reserve a test-sized UTXO that covers `amount` for a funding transaction.
 *
 * Synchronous, FIFO. Every pooled UTXO is exactly `UTXO_SPLIT_AMOUNT`, so for a
 * standard request (`amount <= UTXO_SPLIT_AMOUNT`) the head always covers it.
 * The `>= amount` find is defense-in-depth against a below-amount UTXO ever
 * slipping into the bucket — funding does not top up inputs, so an undersized
 * input would build a tx the fullnode rejects as "invalid surplus of HTR".
 * Throws {@link PoolExhaustedError} when the bucket is empty.
 *
 * Rejects a non-positive `amount` (an impossible request that would otherwise
 * match and drain the head). This path is for standard amounts only; a larger
 * amount is misuse — large funding is wallet-sourced via {@link reserveLarge}.
 */
export function reserveUtxo(amount: bigint): ReservedUtxo {
  if (amount <= 0n) {
    throw new Error(`reserveUtxo requires a positive amount, got ${amount}`);
  }
  if (amount > config.UTXO_SPLIT_AMOUNT) {
    throw new Error(
      `reserveUtxo serves amounts <= UTXO_SPLIT_AMOUNT; use reserveLarge for ${amount}`,
    );
  }

  const testIdx = testUtxos.findIndex((u) => u.amount >= amount);
  if (testIdx === -1) {
    throw new PoolExhaustedError("No available UTXOs for this amount");
  }

  const [utxo] = testUtxos.splice(testIdx, 1);
  markReserved(utxo!);
  return { utxo: utxo!, source: "test" };
}

/**
 * Reserve a specific large UTXO the caller selected from a live wallet query.
 *
 * Synchronous so the "is it free? → markReserved" decision is atomic within one
 * event-loop tick: two concurrent large requests that queried the wallet and
 * saw the same output cannot both win. Returns `null` (so the caller tries the
 * next candidate, or re-queries and waits up to its own funding timeout) when:
 *
 *  - the UTXO is not actually large (`<= UTXO_SPLIT_AMOUNT`). Large funding is
 *    served from large outputs; a test-sized or dust candidate reaching here is
 *    a caller/query error, so it is rejected (with a warn) rather than marked
 *    in-flight. This also keeps reserveLarge from ever touching the test
 *    bucket: pooled UTXOs are exactly the split amount, so `> UTXO_SPLIT_AMOUNT`
 *    implies "not pooled" — the available-XOR-reserved invariant holds without
 *    a separate bucket scan.
 *  - the UTXO is already in-flight.
 *
 * Coverage of the specific request amount stays the caller's responsibility —
 * it filtered the wallet query by `amount_bigger_than`.
 */
export function reserveLarge(utxo: Utxo): ReservedUtxo | null {
  const key = utxoKey(utxo);
  if (utxo.amount <= config.UTXO_SPLIT_AMOUNT) {
    logger.warn({
      event: "utxo_pool.non_large_reserve_rejected",
      meta: { key, amount: utxo.amount.toString() },
    });
    return null;
  }
  if (reservedSet.has(key)) {
    return null;
  }
  markReserved(utxo);
  return { utxo, source: "large" };
}

/**
 * Return a change UTXO to the pool after a transaction. Only test-sized change
 * is pooled (into the FIFO). Larger change belongs to wallet-sourced large
 * funding, and sub-target dust is not worth tracking — both are retained
 * on-chain by the genesis wallet.
 *
 * Follows release-before-return: the UTXO must not still be reserved (nor
 * already pooled). {@link admitToPool} drops it otherwise, keeping the
 * available-XOR-reserved invariant intact even under caller misuse.
 */
export function returnChange(utxo: Utxo): void {
  if (!admitToPool(utxo, "returnChange")) {
    return;
  }

  if (isTestSized(utxo.amount)) {
    testUtxos.push(utxo);
    return;
  }

  if (utxo.amount > config.UTXO_SPLIT_AMOUNT) {
    // A large change output should never be returned here — large funding is
    // wallet-sourced. Flag the misuse; the wallet already holds it on-chain.
    logger.warn({
      event: "utxo_pool.large_change_ignored",
      meta: { key: utxoKey(utxo), amount: utxo.amount.toString() },
    });
  }
  // Sub-target dust is dropped silently: it cannot fund a standard request and
  // the genesis wallet retains it on-chain.
}

/**
 * Add freshly-split UTXOs to the test bucket. Split outputs are exactly
 * `UTXO_SPLIT_AMOUNT`; a differently-sized input is a caller error and is
 * rejected (not silently pooled) so the bucket only ever holds standard-size
 * UTXOs — matching what `populateFromUtxos` admits.
 */
export function addTestUtxos(utxos: Utxo[]): void {
  for (const utxo of utxos) {
    if (!isTestSized(utxo.amount)) {
      logger.warn({
        event: "utxo_pool.non_test_add_ignored",
        meta: { key: utxoKey(utxo), amount: utxo.amount.toString() },
      });
      continue;
    }
    if (admitToPool(utxo, "addTestUtxos")) {
      testUtxos.push(utxo);
    }
  }
}

/** True when the test bucket has dropped below the configured refill threshold. */
export function needsRefill(): boolean {
  return testUtxos.length < config.REFILL_THRESHOLD;
}

/** Current UTXO count in the test bucket. */
export function getPoolStats(): PoolStats {
  return {
    testUtxos: testUtxos.length,
  };
}
