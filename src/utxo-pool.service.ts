/**
 * UTXO pool — STUB.
 *
 * Real implementation lands in a later PR (UTXO pool primitives with the
 * reservation invariant). This stub exists so the genesis/readiness layer
 * (`/status`, `/ready`) can ship now and report a coherent pool state: an
 * empty pool. Every reader treats "empty pool" as "not ready to fund",
 * which is exactly correct until the pool is populated for real.
 */

/** Where a funding UTXO came from — used by the real pool and fund flow. */
export type UtxoSource = "test" | "leftover" | "large";

/** A single unspent output owned by the genesis wallet. */
export interface Utxo {
  readonly txId: string;
  readonly index: number;
  readonly value: bigint;
}

/** Point-in-time counts the readiness/status routes report. */
export interface PoolStats {
  readonly testUtxos: number;
  readonly leftoverUtxos: number;
  readonly largeUtxoAmount: bigint | null;
}

/** Stub: the pool is always empty until the real implementation lands. */
export function getPoolStats(): PoolStats {
  return { testUtxos: 0, leftoverUtxos: 0, largeUtxoAmount: null };
}

/** Stub: discards the UTXOs. Real population arrives with the pool PR. */
export function populateFromUtxos(_utxos: readonly Utxo[]): void {
  // Intentionally a no-op.
}
