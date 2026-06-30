import { describe, test, expect } from "bun:test";
import {
  getPoolStats,
  populateFromUtxos,
  type Utxo,
} from "../../src/utxo-pool.service";

// PR3 ships a *stub* UTXO pool so /status and /ready can report a coherent
// (always-empty) pool. The real reservation pool lands in a later PR; these
// tests pin the stub contract so the routes built on top of it stay honest.
describe("utxo-pool stub", () => {
  test("getPoolStats reports an empty pool", () => {
    const stats = getPoolStats();
    expect(stats.testUtxos).toBe(0);
    expect(stats.leftoverUtxos).toBe(0);
    expect(stats.largeUtxoAmount).toBeNull();
  });

  test("populateFromUtxos is a no-op — pool stays empty", () => {
    const utxos: Utxo[] = [
      { txId: "a", index: 0, value: 1000n },
      { txId: "b", index: 1, value: 2000n },
    ];
    populateFromUtxos(utxos);
    const stats = getPoolStats();
    expect(stats.testUtxos).toBe(0);
    expect(stats.largeUtxoAmount).toBeNull();
  });
});
