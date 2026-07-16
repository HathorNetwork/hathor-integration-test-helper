import { describe, test, expect } from "bun:test";
import {
  runInitialSplitWithRetry,
  type InitialSplitDeps,
} from "../../src/startup";
import type { ReservedUtxo, PoolStats, Utxo } from "../../src/utxo-pool.service";

// The initial split runs only when the pool is empty; its contract is to leave
// the pool seeded with >=1 test UTXO, or throw so the bootstrap degrades. These
// tests drive it through injected collaborators (no fullnode, no real backoff).

const largeReserved: ReservedUtxo = {
  utxo: { txId: "big", index: 0, amount: 100000n },
  source: "large",
};

function deps(overrides: Partial<InitialSplitDeps> = {}): InitialSplitDeps {
  return {
    reserveLargeFromWallet: async () => largeReserved,
    waitForUtxoUnlock: async () => {},
    splitUtxo: async () => {},
    refreshPool: async () => {},
    getPoolStats: (): PoolStats => ({ testUtxos: 0 }),
    sleep: async () => {}, // no real backoff wait
    ...overrides,
  };
}

describe("runInitialSplitWithRetry", () => {
  test("resolves once the split seeds the pool", async () => {
    const splitCalls: Utxo[] = [];
    let poolSeeded = false;
    await runInitialSplitWithRetry(
      3,
      deps({
        splitUtxo: async (u) => {
          splitCalls.push(u);
          poolSeeded = true;
        },
        getPoolStats: () => ({ testUtxos: poolSeeded ? 10 : 0 }),
      }),
    );
    expect(splitCalls[0]).toEqual(largeReserved.utxo);
  });

  test("throws when no large output is ever available (would-be empty pool)", async () => {
    let attempts = 0;
    await expect(
      runInitialSplitWithRetry(
        3,
        deps({
          reserveLargeFromWallet: async () => {
            attempts += 1;
            return null; // nothing splittable
          },
          getPoolStats: () => ({ testUtxos: 0 }),
        }),
      ),
    ).rejects.toThrow("could not seed the pool after 3 attempts");
    expect(attempts).toBe(3); // exhausts retries rather than returning clean
  });

  test("retries a failing split and succeeds on a later attempt", async () => {
    let calls = 0;
    let seeded = false;
    await runInitialSplitWithRetry(
      3,
      deps({
        splitUtxo: async () => {
          calls += 1;
          if (calls < 2) throw new Error("mining rejected");
          seeded = true;
        },
        getPoolStats: () => ({ testUtxos: seeded ? 10 : 0 }),
      }),
    );
    expect(calls).toBe(2);
  });

  test("treats a split that leaves the pool empty as a failure", async () => {
    // splitUtxo resolves but adds nothing (e.g. a maxOutputs<1 skip) — the pool
    // stays empty, so this must NOT be reported as a clean success.
    await expect(
      runInitialSplitWithRetry(
        2,
        deps({
          splitUtxo: async () => {}, // resolves, pools nothing
          getPoolStats: () => ({ testUtxos: 0 }),
        }),
      ),
    ).rejects.toThrow("could not seed the pool");
  });
});
