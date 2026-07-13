import { describe, test, expect, beforeEach } from "bun:test";
import {
  populateFromUtxos,
  reserveUtxo,
  releaseReservation,
  returnChange,
  getPoolStats,
  getReservedKeys,
} from "../../src/utxo-pool.service";
import { config } from "../../src/config";

// Each test starts from a clean pool. populateFromUtxos rebuilds the buckets
// but deliberately preserves reservedSet across calls (it is the source of
// truth for in-flight UTXOs), so a fresh reservedSet needs an explicit
// release of anything a prior test left reserved.
beforeEach(() => {
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
});

describe("reservedSet invariants", () => {
  // These tests seed test-sized 1000n UTXOs and reserve 500n small amounts.
  // Both facts hinge on the default split amount (500n is "small" only while
  // 500 <= UTXO_SPLIT_AMOUNT). Pin it so an env override fails loudly here
  // rather than silently rerouting reservations down the large-amount path.
  test("is built on the default split amount", () => {
    expect(config.UTXO_SPLIT_AMOUNT).toBe(1000n);
  });

  test("reserveUtxo records the UTXO in reservedSet", async () => {
    populateFromUtxos([{ txId: "tx-A", index: 0, value: 1000n }]);

    const { utxo } = await reserveUtxo(500n);

    expect(getReservedKeys()).toEqual([`${utxo.txId}:${utxo.index}`]);
  });

  test("populateFromUtxos does NOT re-introduce a reserved UTXO", async () => {
    // Seed: one test-sized UTXO.
    populateFromUtxos([{ txId: "in-flight-tx", index: 0, value: 1000n }]);

    // Simulate a fund request: reserve removes it from the bucket and
    // registers it in reservedSet.
    const { utxo } = await reserveUtxo(500n);
    expect(utxo.txId).toBe("in-flight-tx");
    expect(getPoolStats().testUtxos).toBe(0);

    // Simulate a rescan running while the fund is mid-flight:
    // wallet.getAvailableUtxos() can still report the in-flight UTXO because
    // wallet-lib's transient lock is set inside mineTx, not at reserveUtxo
    // time. The pool MUST refuse to re-introduce it.
    populateFromUtxos([
      { txId: "in-flight-tx", index: 0, value: 1000n }, // still visible
      { txId: "fresh-tx", index: 0, value: 1000n }, // genuinely new
    ]);

    // Bucket should contain only the genuinely-new UTXO.
    expect(getPoolStats().testUtxos).toBe(1);

    // Reserving again must hand out the fresh UTXO, not a duplicate of the
    // in-flight one.
    const { utxo: second } = await reserveUtxo(500n);
    expect(second.txId).toBe("fresh-tx");
  });

  test("releaseReservation makes the UTXO eligible for re-introduction", async () => {
    populateFromUtxos([{ txId: "tx-B", index: 0, value: 1000n }]);
    const { utxo } = await reserveUtxo(500n);

    // While reserved, rescan skips it.
    populateFromUtxos([{ txId: "tx-B", index: 0, value: 1000n }]);
    expect(getPoolStats().testUtxos).toBe(0);

    // Once released (e.g. the consuming tx is observed), a subsequent rescan
    // is allowed to put it back into a bucket.
    expect(releaseReservation(utxo)).toBe(true);
    populateFromUtxos([{ txId: "tx-B", index: 0, value: 1000n }]);
    expect(getPoolStats().testUtxos).toBe(1);
  });

  test("returnChange leaves reservedSet untouched (caller releases explicitly)", async () => {
    populateFromUtxos([{ txId: "tx-C", index: 0, value: 1000n }]);
    const { utxo } = await reserveUtxo(500n);

    returnChange(utxo);

    // returnChange manipulates buckets only; the caller (fund.service) owns
    // releaseReservation. This pins that contract so a future change to
    // returnChange doesn't quietly take over the reservation lifecycle.
    expect(getReservedKeys()).toEqual([`${utxo.txId}:${utxo.index}`]);
  });
});
