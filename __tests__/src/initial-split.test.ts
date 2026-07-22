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
    releaseReservation: () => {},
    refreshPool: async () => {},
    getPoolStats: (): PoolStats => ({ testUtxos: 0 }),
    sleep: async () => {}, // no real backoff wait
    ...overrides,
  };
}

describe("runInitialSplitWithRetry", () => {
  test("selects a locked reward and waits the lock out before splitting", async () => {
    // The seeding path must (1) query with includeLocked so a still-height-
    // locked genesis reward is a candidate, and (2) wait that lock out before
    // splitting. With the available-only filter the reward never surfaces and
    // waitForUtxoUnlock is unreachable — the exact bug this asserts against.
    const order: string[] = [];
    let seededLockedFlag: boolean | undefined;
    let unlockedTxId: string | undefined;
    let seeded = false;
    await runInitialSplitWithRetry(
      3,
      deps({
        reserveLargeFromWallet: async (_min, options) => {
          seededLockedFlag = options?.includeLocked;
          order.push("reserve");
          return largeReserved;
        },
        waitForUtxoUnlock: async (txId) => {
          unlockedTxId = txId;
          order.push("wait");
        },
        splitUtxo: async () => {
          order.push("split");
          seeded = true;
        },
        getPoolStats: () => ({ testUtxos: seeded ? 10 : 0 }),
      }),
    );
    expect(seededLockedFlag).toBe(true);
    expect(unlockedTxId).toBe(largeReserved.utxo.txId);
    expect(order).toEqual(["reserve", "wait", "split"]);
  });

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

  test("releases the reserved output when the unlock wait fails", async () => {
    // waitForUtxoUnlock runs before splitUtxo (which has its own release), so a
    // rejection here must not leave the large output wedged in reservedSet.
    const released: Array<{ txId: string; index: number }> = [];
    await expect(
      runInitialSplitWithRetry(
        2,
        deps({
          waitForUtxoUnlock: async () => {
            throw new Error("reward still locked");
          },
          releaseReservation: (u) => released.push(u),
        }),
      ),
    ).rejects.toThrow("could not seed the pool");
    // Released on every attempt (2), never left reserved.
    expect(released).toEqual([largeReserved.utxo, largeReserved.utxo]);
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
