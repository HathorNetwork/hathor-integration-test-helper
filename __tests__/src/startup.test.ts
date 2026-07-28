import { describe, test, expect, beforeEach } from "bun:test";
import {
  bootstrapFunding,
  getStartupState,
  __resetStartupForTest,
  type BootstrapDeps,
} from "../../src/startup";

/**
 * The funding bootstrap is driven through injected collaborators (no
 * fullnode, no module mocking — Bun's mock.module is process-global and
 * leaks across files). Each scenario builds its own deps and resets the
 * module-level boot promise back to `idle`.
 */
let initCalls = 0;
let splitCalls = 0;

function deps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    fundingEnabled: true,
    initGenesisWallet: async () => {
      initCalls += 1;
    },
    isGenesisReady: () => true,
    // Default: pool already has test-sized UTXOs, so no initial split fires.
    populatePoolFromWallet: async () => {},
    getPoolStats: () => ({ testUtxos: 5 }),
    runInitialSplit: async () => {
      splitCalls += 1;
    },
    ...overrides,
  };
}

beforeEach(() => {
  initCalls = 0;
  splitCalls = 0;
  __resetStartupForTest();
});

describe("getStartupState contract", () => {
  test("returns the expected shape with a known phase", () => {
    const state = getStartupState();
    expect(state).toHaveProperty("phase");
    expect(state).toHaveProperty("lastError");
    expect(state).toHaveProperty("lastUpdatedAt");
    const validPhases = ["idle", "initializing", "ready", "disabled", "degraded"];
    expect(validPhases).toContain(state.phase);
  });

  test("returns a copy, not the internal reference", () => {
    const a = getStartupState();
    const b = getStartupState();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("bootstrapFunding transitions", () => {
  test("fundingEnabled=false short-circuits to 'disabled' without init", async () => {
    await bootstrapFunding(deps({ fundingEnabled: false }));
    expect(getStartupState().phase).toBe("disabled");
    expect(initCalls).toBe(0);
  });

  test("a clean genesis init reaches 'ready'", async () => {
    await bootstrapFunding(deps());
    const state = getStartupState();
    expect(state.phase).toBe("ready");
    expect(state.lastError).toBeNull();
    expect(initCalls).toBe(1);
  });

  test("a thrown init degrades gracefully with the error recorded", async () => {
    await bootstrapFunding(
      deps({
        initGenesisWallet: async () => {
          throw new Error("boom: bad seed");
        },
      }),
    );
    const state = getStartupState();
    expect(state.phase).toBe("degraded");
    expect(state.lastError).toContain("bad seed");
  });

  test("init resolving without readiness is treated as degraded", async () => {
    await bootstrapFunding(deps({ isGenesisReady: () => false }));
    expect(getStartupState().phase).toBe("degraded");
  });

  test("is idempotent — a second call does not re-initialize", async () => {
    await bootstrapFunding(deps());
    await bootstrapFunding(deps());
    expect(initCalls).toBe(1);
  });
});

describe("bootstrapFunding pool population", () => {
  test("skips the initial split when the pool already has test UTXOs", async () => {
    await bootstrapFunding(
      deps({
        getPoolStats: () => ({ testUtxos: 3 }),
      }),
    );
    expect(getStartupState().phase).toBe("ready");
    expect(splitCalls).toBe(0);
  });

  test("delegates the initial split when the pool has no test UTXOs", async () => {
    // Pool stats expose only `testUtxos`; whether a large output exists to
    // split is discovered inside runInitialSplit (via a live wallet query), so
    // the bootstrap delegates whenever testUtxos === 0.
    await bootstrapFunding(
      deps({
        getPoolStats: () => ({ testUtxos: 0 }),
      }),
    );
    expect(getStartupState().phase).toBe("ready");
    expect(splitCalls).toBe(1);
  });

  test("a failed initial split degrades with the error recorded", async () => {
    await bootstrapFunding(
      deps({
        getPoolStats: () => ({ testUtxos: 0 }),
        runInitialSplit: async () => {
          throw new Error("split failed after 3 attempts");
        },
      }),
    );
    const state = getStartupState();
    expect(state.phase).toBe("degraded");
    expect(state.lastError).toContain("split failed");
  });
});
