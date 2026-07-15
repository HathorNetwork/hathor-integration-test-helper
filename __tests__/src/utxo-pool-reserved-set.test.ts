import { describe, test, expect, beforeEach } from "bun:test";
import {
  populateFromUtxos,
  reserveUtxo,
  reserveLarge,
  releaseReservation,
  returnChange,
  getPoolStats,
  getReservedKeys,
} from "../../src/utxo-pool.service";
import { config } from "../../src/config";

// Each test starts from a clean pool. populateFromUtxos rebuilds the test
// bucket but deliberately preserves reservedSet across calls (it is the source
// of truth for in-flight UTXOs), so a fresh reservedSet needs an explicit
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

  test("reserveUtxo records the UTXO in reservedSet", () => {
    populateFromUtxos([{ txId: "tx-A", index: 0, value: 1000n }]);

    const { utxo } = reserveUtxo(500n);

    expect(getReservedKeys()).toEqual([`${utxo.txId}:${utxo.index}`]);
  });

  test("populateFromUtxos does NOT re-introduce a reserved UTXO", () => {
    // Seed: one test-sized UTXO.
    populateFromUtxos([{ txId: "in-flight-tx", index: 0, value: 1000n }]);

    // Simulate a fund request: reserve removes it from the bucket and
    // registers it in reservedSet.
    const { utxo } = reserveUtxo(500n);
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
    expect(reserveUtxo(500n).utxo.txId).toBe("fresh-tx");
  });

  test("releaseReservation makes the UTXO eligible for re-introduction", () => {
    populateFromUtxos([{ txId: "tx-B", index: 0, value: 1000n }]);
    const { utxo } = reserveUtxo(500n);

    // While reserved, rescan skips it.
    populateFromUtxos([{ txId: "tx-B", index: 0, value: 1000n }]);
    expect(getPoolStats().testUtxos).toBe(0);

    // Once released (e.g. the consuming tx is observed), a subsequent rescan
    // is allowed to put it back into a bucket.
    expect(releaseReservation(utxo)).toBe(true);
    populateFromUtxos([{ txId: "tx-B", index: 0, value: 1000n }]);
    expect(getPoolStats().testUtxos).toBe(1);
  });

  test("returnChange refuses to pool a still-reserved UTXO (release-before-return)", () => {
    populateFromUtxos([{ txId: "tx-C", index: 0, value: 1000n }]);
    const { utxo } = reserveUtxo(500n);

    // Returning a UTXO that is still reserved violates the available-XOR-
    // reserved invariant. returnChange must NOT pool it (that would let a
    // second request grab a UTXO the owner still holds); it drops it and
    // leaves the reservation for the owner to release.
    returnChange(utxo);
    expect(getPoolStats().testUtxos).toBe(0);
    expect(getReservedKeys()).toEqual([`${utxo.txId}:${utxo.index}`]);

    // Done in the documented order — release, then return — the UTXO is pooled.
    expect(releaseReservation(utxo)).toBe(true);
    returnChange(utxo);
    expect(getPoolStats().testUtxos).toBe(1);
    expect(getReservedKeys()).toEqual([]);
  });

  test("a change output already seen by a rescan is not pooled twice", () => {
    populateFromUtxos([]);

    // A fund tx's change output is observed on-chain by a rescan first.
    populateFromUtxos([{ txId: "change", index: 1, value: 1000n }]);
    expect(getPoolStats().testUtxos).toBe(1);

    // The owner then returns the same change. It is already pooled, so
    // returnChange must drop it — two bucket copies would let two requests
    // each reserve the one physical output.
    returnChange({ txId: "change", index: 1, amount: 1000n });
    expect(getPoolStats().testUtxos).toBe(1);
  });

  test("a large reservation is race-free and re-reservable after release", () => {
    // Large funding no longer parks waiters: the consumer queries the wallet
    // and reserves a candidate through reserveLarge, which is synchronous so
    // "is-it-free? -> markReserved" is atomic. Two concurrent requests that
    // selected the same output cannot both win, and the double-hand the old
    // waiter path allowed cannot occur.
    const utxo = { txId: "big", index: 0, amount: 100000n };

    expect(reserveLarge(utxo)).not.toBeNull();
    expect(reserveLarge(utxo)).toBeNull(); // already in-flight

    // Once the consuming tx settles the owner releases it; a later wallet query
    // can legitimately hand it out again.
    expect(releaseReservation(utxo)).toBe(true);
    expect(reserveLarge(utxo)).not.toBeNull();
  });
});
