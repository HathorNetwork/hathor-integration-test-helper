import { describe, test, expect } from "bun:test";
import {
  isGenesisReady,
  getGenesisWallet,
  getGenesisAddress,
  waitUntilReady,
  waitForRewardUnlock,
  walletHoldsSpendableFunds,
  isGenesisFunded,
  initGenesisWallet,
  __setGenesisStateForTest,
  __setGenesisWalletForTest,
  __resetGenesisStateForTest,
  type RewardLockStorage,
  type FundQueryWallet,
} from "../../src/genesis.service";

// initGenesisWallet() connects to a real fullnode, so it is exercised by the
// integration harness (a later PR), not here. These unit tests pin the
// synchronous contract the routes depend on: before initialization the
// service reports "not ready" and the accessors fail loudly rather than
// handing back a half-built wallet.
describe("genesis.service accessors before initialization", () => {
  test("isGenesisReady is false before init", () => {
    expect(isGenesisReady()).toBe(false);
  });

  test("getGenesisWallet throws before init", () => {
    expect(() => getGenesisWallet()).toThrow(/not initialized/i);
  });

  test("getGenesisAddress throws before init", () => {
    expect(() => getGenesisAddress()).toThrow(/not initialized/i);
  });
});

// Extracted poll-until-ready seam so the timeout/degrade path is unit-testable
// without a real fullnode. Small interval/timeout values keep these fast.
describe("waitUntilReady", () => {
  test("resolves immediately when already ready", async () => {
    await expect(waitUntilReady(() => true, 50, 5)).resolves.toBeUndefined();
  });

  test("resolves once readiness flips true", async () => {
    let polls = 0;
    await expect(
      waitUntilReady(() => (polls += 1) >= 3, 200, 5),
    ).resolves.toBeUndefined();
  });

  test("rejects after the deadline when readiness never flips", async () => {
    await expect(waitUntilReady(() => false, 30, 5)).rejects.toThrow(
      /did not become ready/i,
    );
  });
});

// Reward-lock wait seam, unit-tested with a fake storage (no fullnode).
describe("waitForRewardUnlock", () => {
  function fakeStorage(over: Partial<RewardLockStorage> & { heights?: number[] }): RewardLockStorage {
    const heights = over.heights ?? [];
    let i = 0;
    return {
      version: over.version,
      getTx: over.getTx ?? (async () => ({ height: 5 })),
      getCurrentHeight:
        over.getCurrentHeight ??
        (async () => heights[Math.min(i++, heights.length - 1)] ?? 0),
    };
  }

  test("returns immediately when reward_spend_min_blocks is 0", async () => {
    const storage = fakeStorage({ version: { reward_spend_min_blocks: 0 } });
    await expect(waitForRewardUnlock(storage, "tx-1")).resolves.toBeUndefined();
  });

  test("returns immediately when the block height is unknown", async () => {
    const storage = fakeStorage({
      version: { reward_spend_min_blocks: 10 },
      getTx: async () => ({ height: null }),
    });
    await expect(waitForRewardUnlock(storage, "tx-2")).resolves.toBeUndefined();
  });

  test("returns immediately when the reward-lock version is unavailable", async () => {
    // version not populated yet — treated as an observable skip, not a lock.
    const storage = fakeStorage({ version: undefined });
    await expect(
      waitForRewardUnlock(storage, "tx-no-version"),
    ).resolves.toBeUndefined();
  });

  test("returns immediately when the tx is not found in storage", async () => {
    const storage = fakeStorage({
      version: { reward_spend_min_blocks: 10 },
      getTx: async () => null,
    });
    await expect(
      waitForRewardUnlock(storage, "tx-missing"),
    ).resolves.toBeUndefined();
  });

  test("returns immediately when already unlocked", async () => {
    const storage = fakeStorage({
      version: { reward_spend_min_blocks: 10 },
      getTx: async () => ({ height: 5 }),
      getCurrentHeight: async () => 100, // >> 5 + 10 + 1
    });
    await expect(waitForRewardUnlock(storage, "tx-3")).resolves.toBeUndefined();
  });

  test("polls until the current height reaches the unlock height", async () => {
    // unlockHeight = 5 + 3 + 1 = 9; heights climb 6 -> 8 -> 9.
    const storage = fakeStorage({
      version: { reward_spend_min_blocks: 3 },
      getTx: async () => ({ height: 5 }),
      heights: [6, 8, 9],
    });
    await expect(
      waitForRewardUnlock(storage, "tx-4", { pollIntervalMs: 1 }),
    ).resolves.toBeUndefined();
  });

  test("throws after the timeout when the lock never clears", async () => {
    const storage = fakeStorage({
      version: { reward_spend_min_blocks: 10 },
      getTx: async () => ({ height: 5 }),
      getCurrentHeight: async () => 6, // never reaches 16
    });
    await expect(
      waitForRewardUnlock(storage, "tx-5", { pollIntervalMs: 1, timeoutMs: 20 }),
    ).rejects.toThrow(/Timeout waiting for reward unlock/i);
  });
});

// The real funded verdict, exercised against a fake wallet so the `> 0n`
// boundary (not just the test override) is covered.
describe("walletHoldsSpendableFunds", () => {
  function fakeWallet(available: bigint): FundQueryWallet {
    return { getUtxos: async () => ({ total_utxos_available: available }) };
  }

  test("false when the wallet has no spendable UTXOs (0n)", async () => {
    expect(await walletHoldsSpendableFunds(fakeWallet(0n))).toBe(false);
  });

  test("true when the wallet has at least one spendable UTXO (1n)", async () => {
    expect(await walletHoldsSpendableFunds(fakeWallet(1n))).toBe(true);
  });
});

describe("isGenesisFunded override", () => {
  test("returns the injected funded override without touching the wallet", async () => {
    __setGenesisStateForTest({ funded: true });
    try {
      expect(await isGenesisFunded()).toBe(true);
    } finally {
      __resetGenesisStateForTest();
    }
  });
});

// The idempotency guard short-circuits before any fullnode connection, so it is
// unit-testable by injecting an already-present wallet singleton.
describe("initGenesisWallet idempotency", () => {
  test("no-ops when a wallet is already initialized (no rebuild)", async () => {
    const sentinel = { sentinel: "genesis-wallet" };
    __setGenesisWalletForTest(sentinel);
    try {
      await initGenesisWallet();
      expect(getGenesisWallet() as unknown).toBe(sentinel);
    } finally {
      __resetGenesisStateForTest();
    }
  });
});
