import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import {
  initializeCache,
  getSimpleWalletFromCache,
  getCacheSize,
  __setGeneratorForTest,
  __resetCacheForTest,
} from "../../src/wallet.cache";
import { logger, type LogPayload } from "../../src/logger";
import type { SimpleWallet } from "../../src/wallet.service";
import { config } from "../../src/config";

function fakeWallet(idx: number): SimpleWallet {
  return {
    words: `seed-${idx} ${"x ".repeat(23).trim()}`,
    addresses: Array.from({ length: 22 }, (_, i) => `addr-${idx}-${i}`),
  };
}

beforeEach(() => {
  __resetCacheForTest();
});

afterEach(() => {
  __setGeneratorForTest(null);
  __resetCacheForTest();
});

describe("wallet.cache happy path", () => {
  test("initializeCache fills up to SIMPLE_WALLET_CACHE_SIZE", () => {
    let count = 0;
    __setGeneratorForTest(() => fakeWallet(count++));
    initializeCache();
    expect(getCacheSize()).toBe(config.SIMPLE_WALLET_CACHE_SIZE);
  });

  test("getSimpleWalletFromCache pops FIFO and triggers async refill", async () => {
    let count = 0;
    __setGeneratorForTest(() => fakeWallet(count++));
    initializeCache();
    const sizeBefore = getCacheSize();

    const first = getSimpleWalletFromCache();
    expect(first.words.startsWith("seed-0")).toBe(true);
    expect(getCacheSize()).toBe(sizeBefore - 1);

    // Wait one tick so refillOne's setImmediate chain has time to run.
    await new Promise((r) => setImmediate(r));
    expect(getCacheSize()).toBe(sizeBefore);
  });

  test("falls back to synchronous generation when cache is empty", () => {
    let count = 0;
    __setGeneratorForTest(() => fakeWallet(count++));
    // Skip initializeCache — cache starts empty.
    const w = getSimpleWalletFromCache();
    expect(w.words.startsWith("seed-0")).toBe(true);
  });
});

describe("wallet.cache refill failure path", () => {
  test("on generator throw: logs structured error, clears flag, retries once", async () => {
    // Pre-seed the cache with a benign generator so initializeCache
    // succeeds. Then swap in a generator whose first call throws — that
    // throw must hit the refill-loop try/catch, not a sync fallback in
    // getSimpleWalletFromCache.
    __setGeneratorForTest(() => fakeWallet(0));
    initializeCache();

    let refillCalls = 0;
    __setGeneratorForTest(() => {
      refillCalls++;
      if (refillCalls === 1) throw new Error("boom");
      return fakeWallet(refillCalls);
    });

    const errorSpy = mock((_p: LogPayload) => {});
    const originalError = logger.error;
    logger.error = errorSpy;

    try {
      // Drain one wallet (from the pre-seeded cache) to trigger refill.
      getSimpleWalletFromCache();
      // Two setImmediate iterations: the failing first attempt + the
      // retry that succeeds.
      await new Promise((r) => setTimeout(r, 50));

      const events = errorSpy.mock.calls.map((args) => args[0].event);
      expect(events).toContain("wallet_cache.refill_failed");
      expect(refillCalls).toBeGreaterThan(1);
    } finally {
      logger.error = originalError;
    }
  });

  test("a single cycle of persistent failures caps at one retry", async () => {
    __setGeneratorForTest(() => fakeWallet(0));
    initializeCache();

    let refillCalls = 0;
    __setGeneratorForTest(() => {
      refillCalls++;
      throw new Error("always");
    });

    const originalError = logger.error;
    logger.error = mock((_p: LogPayload) => {});

    try {
      // Triggers refillCacheAsync → setImmediate(refillOne) chain.
      getSimpleWalletFromCache();
      await new Promise((r) => setTimeout(r, 50));
      // Exactly two attempts: initial + one retry. No hot loop.
      expect(refillCalls).toBe(2);
    } finally {
      logger.error = originalError;
    }
  });

  test("after a failed cycle, a fresh consumer call starts a new cycle", async () => {
    __setGeneratorForTest(() => fakeWallet(0));
    initializeCache();

    let refillCalls = 0;
    __setGeneratorForTest(() => {
      refillCalls++;
      throw new Error("always");
    });

    const originalError = logger.error;
    logger.error = mock((_p: LogPayload) => {});

    try {
      getSimpleWalletFromCache();
      await new Promise((r) => setTimeout(r, 50));
      const afterFirstCycle = refillCalls;
      expect(afterFirstCycle).toBe(2);

      // Second consumer call must be able to launch a brand-new cycle
      // (isRefilling cleared after the retry exhausted).
      getSimpleWalletFromCache();
      await new Promise((r) => setTimeout(r, 50));
      expect(refillCalls).toBe(afterFirstCycle + 2);
    } finally {
      logger.error = originalError;
    }
  });
});
