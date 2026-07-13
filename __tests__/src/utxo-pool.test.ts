import { describe, test, expect, beforeEach } from "bun:test";
import {
  populateFromUtxos,
  reserveUtxo,
  returnChange,
  needsRefill,
  getPoolStats,
  addTestUtxos,
  setLargeUtxo,
  releaseReservation,
  getReservedKeys,
} from "../../src/utxo-pool.service";
import { PoolExhaustedError, FundTimeoutError } from "../../src/errors";
import { config } from "../../src/config";

// Reset pool state before each test. populateFromUtxos([]) rebuilds the
// buckets but deliberately preserves reservedSet (it is the source of
// truth for in-flight UTXOs), so we also release any lingering
// reservations — otherwise a reserve in one test would leak into the
// next and silently skip a same-keyed UTXO during populate.
function resetPool() {
  for (const key of getReservedKeys()) {
    const [txId, indexStr] = key.split(":");
    releaseReservation({ txId: txId!, index: Number(indexStr) });
  }
  populateFromUtxos([]);
}

describe("utxo-pool.service", () => {
  beforeEach(() => {
    resetPool();
  });

  // Several categorization tests use fixed amounts chosen around the split
  // boundary (1000n exactly, 1050n within +10%, 950n below it). Those are only
  // valid while UTXO_SPLIT_AMOUNT is its default, and the service reads the
  // global config singleton at call time. Pin the assumption here so an env
  // override fails with one clear message instead of scattering opaque
  // assertion failures across the suite. We deliberately do NOT derive the
  // boundary amounts from config: that would re-implement isTestSized's +10%
  // rule in the test and lose the independent oracle.
  test("is built on the default split amount", () => {
    expect(config.UTXO_SPLIT_AMOUNT).toBe(1000n);
  });

  describe("populateFromUtxos", () => {
    test("categorizes test-sized UTXOs correctly", () => {
      populateFromUtxos([
        { txId: "tx1", index: 0, value: 1000n }, // exactly UTXO_SPLIT_AMOUNT
        { txId: "tx2", index: 0, value: 1050n }, // within +10%
        // 950 is BELOW UTXO_SPLIT_AMOUNT: it cannot cover a default request
        // on its own, so it must NOT land in the test bucket (here it falls
        // to leftovers, the 50000 being the large UTXO).
        { txId: "tx3", index: 0, value: 950n },
        { txId: "tx4", index: 0, value: 50000n },
      ]);

      const stats = getPoolStats();
      expect(stats.testUtxos).toBe(2);
      expect(stats.largeUtxoAmount).toBe(50000n);
      expect(stats.leftoverUtxos).toBe(1);
    });

    test("identifies the largest UTXO as largeUtxo", () => {
      populateFromUtxos([
        { txId: "tx1", index: 0, value: 1000n },
        { txId: "tx2", index: 0, value: 50000n },
        { txId: "tx3", index: 0, value: 20000n },
      ]);

      const stats = getPoolStats();
      expect(stats.testUtxos).toBe(1);
      expect(stats.largeUtxoAmount).toBe(50000n);
      // 20000 is not test-sized and not the largest, so it's leftover
      expect(stats.leftoverUtxos).toBe(1);
    });

    test("handles empty UTXO list", () => {
      populateFromUtxos([]);
      const stats = getPoolStats();
      expect(stats.testUtxos).toBe(0);
      expect(stats.largeUtxoAmount).toBeNull();
      expect(stats.leftoverUtxos).toBe(0);
    });

    test("single UTXO goes to largeUtxo if not test-sized", () => {
      populateFromUtxos([{ txId: "tx1", index: 0, value: 500000n }]);
      const stats = getPoolStats();
      expect(stats.testUtxos).toBe(0);
      expect(stats.largeUtxoAmount).toBe(500000n);
    });

    test("hands a rescan-discovered large UTXO to a parked waiter", async () => {
      populateFromUtxos([]);

      // No large UTXO yet, so this parks a waiter instead of resolving.
      const promise = reserveUtxo(50000n, { timeoutMs: 5000 });

      // A concurrent rescan now reports a large-enough UTXO. It must reach
      // the parked waiter, not merely land in the `largeUtxo` slot where the
      // already-waiting request can never see it (it would time out instead).
      populateFromUtxos([{ txId: "rescan-large", index: 0, value: 100000n }]);

      const reserved = await promise;
      expect(reserved.utxo.txId).toBe("rescan-large");
      expect(reserved.source).toBe("large");
      // The waiter consumed it, so the slot is empty.
      expect(getPoolStats().largeUtxoAmount).toBeNull();
    });
  });

  describe("reserveUtxo", () => {
    test("dequeues from testUtxos in FIFO order", async () => {
      populateFromUtxos([
        { txId: "first", index: 0, value: 1000n },
        { txId: "second", index: 0, value: 1000n },
        { txId: "third", index: 0, value: 1000n },
      ]);

      const u1 = await reserveUtxo(500n);
      expect(u1.utxo.txId).toBe("first");
      expect(u1.source).toBe("test");

      const u2 = await reserveUtxo(500n);
      expect(u2.utxo.txId).toBe("second");
      expect(u2.source).toBe("test");

      const u3 = await reserveUtxo(500n);
      expect(u3.utxo.txId).toBe("third");
      expect(u3.source).toBe("test");
    });

    test("never reserves a test UTXO smaller than the requested amount", async () => {
      // Regression: a below-target change UTXO must never fund a full-size
      // request. Funding is single-input with no top-up (skipSelection), so
      // reserving a 975 for a 1000 request builds an output larger than its
      // input and the fullnode rejects it as "invalid surplus of HTR".
      populateFromUtxos([
        { txId: "small", index: 0, value: 975n }, // -> leftover under the fix
        { txId: "full", index: 0, value: 1000n }, // -> test bucket
      ]);

      const reserved = await reserveUtxo(1000n);
      expect(reserved.utxo.amount >= 1000n).toBe(true);
      expect(reserved.utxo.txId).toBe("full");
      expect(reserved.source).toBe("test");
    });

    test("falls back to leftoverUtxos when testUtxos empty", async () => {
      populateFromUtxos([
        { txId: "leftover1", index: 0, value: 500n },
        { txId: "large1", index: 0, value: 50000n },
      ]);

      // 500 is not test-sized (too small), 50000 is the large UTXO
      // leftover1 should be a leftover
      const stats = getPoolStats();
      expect(stats.testUtxos).toBe(0);
      expect(stats.leftoverUtxos).toBe(1);

      const u = await reserveUtxo(400n);
      expect(u.utxo.txId).toBe("leftover1");
      expect(u.source).toBe("leftover");
    });

    test("throws when no UTXOs available for small amount", async () => {
      populateFromUtxos([]);

      await expect(reserveUtxo(500n)).rejects.toThrow("No available UTXOs");
    });

    test("throws PoolExhaustedError (RFC code) for empty small-amount pool", async () => {
      populateFromUtxos([]);
      await expect(reserveUtxo(500n)).rejects.toBeInstanceOf(PoolExhaustedError);
    });

    test("claims largeUtxo for large amounts", async () => {
      populateFromUtxos([{ txId: "big", index: 0, value: 100000n }]);

      const u = await reserveUtxo(50000n);
      expect(u.utxo.txId).toBe("big");
      expect(u.utxo.amount).toBe(100000n);
      expect(u.source).toBe("large");

      // largeUtxo should now be null
      const stats = getPoolStats();
      expect(stats.largeUtxoAmount).toBeNull();
    });

    test("times out when no large UTXO available", async () => {
      populateFromUtxos([]);
      await expect(
        reserveUtxo(50000n, { timeoutMs: 50 }),
      ).rejects.toThrow("Timed out");
    });

    test("throws FundTimeoutError (RFC code) when waiter expires", async () => {
      populateFromUtxos([]);
      await expect(
        reserveUtxo(50000n, { timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(FundTimeoutError);
    });
  });

  describe("returnChange", () => {
    test("adds test-sized change back to testUtxos", () => {
      populateFromUtxos([]);

      returnChange({ txId: "change1", index: 1, amount: 1000n });
      const stats = getPoolStats();
      expect(stats.testUtxos).toBe(1);
    });

    test("sets largeUtxo when returning large change", () => {
      populateFromUtxos([]);

      returnChange({ txId: "change1", index: 1, amount: 50000n });
      const stats = getPoolStats();
      expect(stats.largeUtxoAmount).toBe(50000n);
    });

    test("pushes to leftoverUtxos for small non-test amounts", () => {
      populateFromUtxos([]);

      returnChange({ txId: "change1", index: 1, amount: 200n });
      const stats = getPoolStats();
      expect(stats.leftoverUtxos).toBe(1);
    });

    test("resolves waiter when large UTXO returned", async () => {
      populateFromUtxos([]);

      // Start waiting for large UTXO
      const promise = reserveUtxo(50000n, { timeoutMs: 5000 });

      // Return a large UTXO after a short delay
      setTimeout(() => {
        returnChange({ txId: "returned", index: 0, amount: 100000n });
      }, 10);

      const reserved = await promise;
      expect(reserved.utxo.txId).toBe("returned");
      expect(reserved.source).toBe("large");
    });

    test("keeps the larger UTXO as largeUtxo and demotes the smaller", () => {
      populateFromUtxos([]);

      returnChange({ txId: "small-large", index: 0, amount: 50000n });
      expect(getPoolStats().largeUtxoAmount).toBe(50000n);

      // A bigger change comes back. The large-reservation path only ever
      // inspects `largeUtxo` (never leftovers), so the largest available
      // output must sit in `largeUtxo` or a large request can starve while
      // a sufficient UTXO hides in leftovers.
      returnChange({ txId: "big-large", index: 0, amount: 100000n });
      const stats = getPoolStats();
      expect(stats.largeUtxoAmount).toBe(100000n);
      expect(stats.leftoverUtxos).toBe(1); // the 50000 demoted, not lost
    });

    test("a large reservation can claim the largest returned change", async () => {
      populateFromUtxos([]);

      returnChange({ txId: "small-large", index: 0, amount: 50000n });
      returnChange({ txId: "big-large", index: 0, amount: 100000n });

      // Only the 100000 covers this; it must be reservable, not stranded.
      const reserved = await reserveUtxo(80000n, { timeoutMs: 200 });
      expect(reserved.utxo.txId).toBe("big-large");
      expect(reserved.source).toBe("large");
    });
  });

  describe("needsRefill", () => {
    test("returns true when below threshold", () => {
      populateFromUtxos([]);
      expect(needsRefill()).toBe(true);
    });

    test("returns false when above threshold", () => {
      // Just past the refill threshold is enough; deriving the count keeps
      // this aligned if REFILL_THRESHOLD is reconfigured. Values must be
      // test-sized so they land in the bucket needsRefill() counts.
      const count = config.REFILL_THRESHOLD + 1;
      const utxos = Array.from({ length: count }, (_, i) => ({
        txId: `tx${i}`,
        index: 0,
        value: config.UTXO_SPLIT_AMOUNT,
      }));
      populateFromUtxos(utxos);
      expect(needsRefill()).toBe(false);
    });
  });

  describe("addTestUtxos", () => {
    test("adds multiple UTXOs to the test pool", () => {
      populateFromUtxos([]);

      addTestUtxos([
        { txId: "split1", index: 0, amount: 1000n },
        { txId: "split1", index: 1, amount: 1000n },
        { txId: "split1", index: 2, amount: 1000n },
      ]);

      expect(getPoolStats().testUtxos).toBe(3);
    });
  });

  describe("setLargeUtxo", () => {
    test("overwrites the current largeUtxo", () => {
      populateFromUtxos([{ txId: "old", index: 0, value: 50000n }]);
      expect(getPoolStats().largeUtxoAmount).toBe(50000n);

      setLargeUtxo({ txId: "new", index: 0, amount: 100000n });
      expect(getPoolStats().largeUtxoAmount).toBe(100000n);
    });
  });
});
