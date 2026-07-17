import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  populateFromUtxos,
  reserveUtxo,
  reserveLarge,
  returnChange,
  needsRefill,
  getPoolStats,
  addTestUtxos,
  releaseReservation,
  getReservedKeys,
} from "../../src/utxo-pool.service";
import { PoolExhaustedError } from "../../src/errors";
import { config } from "../../src/config";

// Reset pool state before each test. populateFromUtxos([]) rebuilds the
// test bucket but deliberately preserves reservedSet (it is the source of
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

  // The pool is a process-global singleton and Bun shares module state across
  // test files. beforeEach only cleans up *before* each test, so the last
  // test's residue (this file's final test deliberately leaves testUtxos=1)
  // would otherwise leak into any later file that reads pool stats — e.g. the
  // /status envelope test asserting testUtxos===0. Reset after the file too.
  afterAll(() => {
    resetPool();
  });

  // Categorization tests use fixed amounts around the split value (1000n
  // exactly, plus 1050n/950n as near-misses). "Test-sized" means EXACTLY
  // UTXO_SPLIT_AMOUNT — there is no margin — so both near-misses are non-test.
  // Those amounts are only valid while UTXO_SPLIT_AMOUNT is its default, and
  // the service reads the global config singleton at call time. Pin it so an
  // env override fails with one clear message instead of scattering opaque
  // assertion failures across the suite.
  test("is built on the default split amount", () => {
    expect(config.UTXO_SPLIT_AMOUNT).toBe(1000n);
  });

  describe("populateFromUtxos", () => {
    test("pools only exactly-split UTXOs, ignoring everything else", () => {
      populateFromUtxos([
        { txId: "tx1", index: 0, value: 1000n }, // exactly UTXO_SPLIT_AMOUNT
        // 1050 is ABOVE the split, 950 is below it, 50000 is a large output.
        // None equals the split, so none is pooled: a UTXO is either exactly
        // the split amount or it is not the pool's concern (the wallet is the
        // source of truth for non-test outputs, and large funding queries it
        // live).
        { txId: "tx2", index: 0, value: 1050n },
        { txId: "tx3", index: 0, value: 950n },
        { txId: "tx4", index: 0, value: 50000n },
      ]);

      expect(getPoolStats().testUtxos).toBe(1);
    });

    test("handles empty UTXO list", () => {
      populateFromUtxos([]);
      expect(getPoolStats().testUtxos).toBe(0);
    });

    test("ignores a lone large UTXO (large funding is wallet-sourced)", () => {
      populateFromUtxos([{ txId: "big", index: 0, value: 500000n }]);
      expect(getPoolStats().testUtxos).toBe(0);
    });
  });

  describe("reserveUtxo", () => {
    test("dequeues from testUtxos in FIFO order", () => {
      populateFromUtxos([
        { txId: "first", index: 0, value: 1000n },
        { txId: "second", index: 0, value: 1000n },
        { txId: "third", index: 0, value: 1000n },
      ]);

      expect(reserveUtxo(500n).utxo.txId).toBe("first");
      expect(reserveUtxo(500n).utxo.txId).toBe("second");
      expect(reserveUtxo(500n).utxo.txId).toBe("third");
    });

    test("tags the reservation source as test", () => {
      populateFromUtxos([{ txId: "t", index: 0, value: 1000n }]);
      expect(reserveUtxo(500n).source).toBe("test");
    });

    test("never reserves a test UTXO smaller than the requested amount", () => {
      // Regression: a below-target change UTXO must never fund a full-size
      // request. Funding is single-input with no top-up (skipSelection), so
      // reserving a 975 for a 1000 request builds an output larger than its
      // input and the fullnode rejects it as "invalid surplus of HTR". The 975
      // is not test-sized, so it is not pooled at all — but the guard defends
      // against any below-amount UTXO slipping into the bucket.
      populateFromUtxos([
        { txId: "small", index: 0, value: 975n }, // ignored (non-test)
        { txId: "full", index: 0, value: 1000n }, // -> test bucket
      ]);

      const reserved = reserveUtxo(1000n);
      expect(reserved.utxo.amount >= 1000n).toBe(true);
      expect(reserved.utxo.txId).toBe("full");
      expect(reserved.source).toBe("test");
    });

    test("throws PoolExhaustedError when no test UTXO covers the amount", () => {
      // The only output is below-target, so it is never pooled; a small
      // request finds nothing.
      populateFromUtxos([{ txId: "dust", index: 0, value: 500n }]);
      expect(() => reserveUtxo(400n)).toThrow(PoolExhaustedError);
    });

    test("throws PoolExhaustedError for an empty test bucket", () => {
      populateFromUtxos([]);
      expect(() => reserveUtxo(500n)).toThrow(PoolExhaustedError);
    });

    test("rejects a large amount (large funding uses reserveLarge)", () => {
      populateFromUtxos([]);
      expect(() => reserveUtxo(50000n)).toThrow(/reserveLarge/);
    });

    test("rejects a non-positive amount without touching the pool", () => {
      // 0 or negative is an impossible request; without an up-front guard the
      // `>= amount` find matches the head and drains a real UTXO for a fund
      // that can never be built.
      populateFromUtxos([{ txId: "t", index: 0, value: 1000n }]);
      expect(() => reserveUtxo(0n)).toThrow(/positive/);
      expect(() => reserveUtxo(-5n)).toThrow(/positive/);
      expect(getPoolStats().testUtxos).toBe(1);
      expect(getReservedKeys()).toEqual([]);
    });
  });

  describe("reserveLarge", () => {
    test("reserves a wallet-selected large UTXO", () => {
      const reserved = reserveLarge({ txId: "big", index: 0, amount: 100000n });
      expect(reserved).not.toBeNull();
      expect(reserved!.source).toBe("large");
      expect(reserved!.utxo.txId).toBe("big");
      expect(getReservedKeys()).toEqual(["big:0"]);
    });

    test("returns null when the UTXO is already reserved (concurrency guard)", () => {
      const utxo = { txId: "big", index: 0, amount: 100000n };
      expect(reserveLarge(utxo)).not.toBeNull();
      // A second large request that queried the wallet and saw the same output
      // must not double-reserve it.
      expect(reserveLarge(utxo)).toBeNull();
    });

    test("rejects a non-large UTXO and never touches the test bucket", () => {
      // reserveLarge is for large outputs only. A candidate at or below the
      // split amount reaching it — a stale caller, a query skew, or a pooled
      // test UTXO — must be rejected, not marked in-flight. Because pooled
      // UTXOs are exactly the split amount, rejecting `<= split` also
      // guarantees reserveLarge never cannibalizes the test bucket.
      populateFromUtxos([{ txId: "pooled", index: 0, value: 1000n }]);

      expect(reserveLarge({ txId: "pooled", index: 0, amount: 1000n })).toBeNull();
      expect(reserveLarge({ txId: "fresh-split", index: 0, amount: 1000n })).toBeNull();
      expect(reserveLarge({ txId: "dust", index: 0, amount: 500n })).toBeNull();

      // Nothing was reserved, and the pooled UTXO stays available.
      expect(getReservedKeys()).toEqual([]);
      expect(getPoolStats().testUtxos).toBe(1);
    });

    test("populateFromUtxos does not re-introduce a reserved large UTXO", () => {
      const utxo = { txId: "big", index: 0, amount: 100000n };
      reserveLarge(utxo);

      // A rescan can still report the in-flight output as available; the pool
      // must skip it (it is non-test AND reserved) and never pool it.
      populateFromUtxos([{ txId: "big", index: 0, value: 100000n }]);
      expect(getPoolStats().testUtxos).toBe(0);
      expect(getReservedKeys()).toEqual(["big:0"]);
    });
  });

  describe("returnChange", () => {
    test("adds test-sized change back to testUtxos", () => {
      populateFromUtxos([]);
      returnChange({ txId: "change1", index: 1, amount: 1000n });
      expect(getPoolStats().testUtxos).toBe(1);
    });

    test("drops sub-target change (the wallet retains it on-chain)", () => {
      populateFromUtxos([]);
      returnChange({ txId: "change1", index: 1, amount: 200n });
      expect(getPoolStats().testUtxos).toBe(0);
    });

    test("ignores a large change output (large funding is wallet-sourced)", () => {
      populateFromUtxos([]);
      returnChange({ txId: "change1", index: 1, amount: 50000n });
      expect(getPoolStats().testUtxos).toBe(0);
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
    test("adds multiple exactly-split UTXOs to the test pool", () => {
      populateFromUtxos([]);
      addTestUtxos([
        { txId: "split1", index: 0, amount: 1000n },
        { txId: "split1", index: 1, amount: 1000n },
        { txId: "split1", index: 2, amount: 1000n },
      ]);
      expect(getPoolStats().testUtxos).toBe(3);
    });

    test("ignores a non-split-sized UTXO", () => {
      // addTestUtxos takes freshly-split outputs, which are exactly the split
      // amount. A differently-sized input is a caller error and must not land
      // in the FIFO (it would inflate needsRefill/stats or park an oversized
      // output where a standard request could consume it).
      populateFromUtxos([]);
      addTestUtxos([
        { txId: "ok", index: 0, amount: 1000n },
        { txId: "toobig", index: 0, amount: 1050n },
        { txId: "toosmall", index: 0, amount: 950n },
      ]);
      expect(getPoolStats().testUtxos).toBe(1);
    });
  });
});
