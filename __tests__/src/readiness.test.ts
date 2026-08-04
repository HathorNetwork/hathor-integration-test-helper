import { describe, test, expect } from "bun:test";
import { computeReadiness } from "../../src/routes";

// Pure readiness branch logic — the heart of /ready and /status. Readiness is
// decoupled from the pool: the third input is whether the genesis *wallet*
// holds funds, and the fourth is the bootstrap phase. Tested by passing inputs
// directly, which keeps it free of fullnode/config coupling.
describe("computeReadiness", () => {
  test("funding disabled is healthy regardless of genesis/funds/phase", () => {
    // Degraded phase deliberately passed: the kill switch outranks everything
    // — a disabled service is intentionally healthy even if a previous funding
    // bootstrap degraded before the flag was flipped.
    expect(computeReadiness(false, false, false, "degraded")).toEqual({
      ready: true,
      readyReason: "funding_disabled",
    });
  });

  test("funding enabled but genesis not ready → not ready", () => {
    expect(computeReadiness(true, false, true, "ready")).toEqual({
      ready: false,
      readyReason: "genesis_wallet_not_ready",
    });
  });

  test("degraded bootstrap → not ready even when the wallet is funded", () => {
    // The trap: a degraded split leaves the pool empty, but the genesis reward
    // can unlock on its own and flip walletFunded true. Without the degraded
    // gate this would report ready over an un-refillable empty pool.
    // Also pins ordering: `degraded` is a non-ready phase, so it would be
    // swallowed by the generic `!== "ready"` arm if that arm came first —
    // reporting a transient reason for a state that never self-heals.
    expect(computeReadiness(true, true, true, "degraded")).toEqual({
      ready: false,
      readyReason: "funding_degraded",
    });
  });

  test("genesis-not-ready wins over degraded (more specific)", () => {
    expect(computeReadiness(true, false, false, "degraded")).toEqual({
      ready: false,
      readyReason: "genesis_wallet_not_ready",
    });
  });

  // The window this whole verdict exists to close: the genesis wallet syncs
  // (genesisReady true) and its reward is spendable (walletFunded true) well
  // before the initial split seeds the pool. Reporting ready here sends a
  // correct client into /fund, where it races the bootstrap's own split.
  test("bootstrap still initializing → not ready even when funded", () => {
    expect(computeReadiness(true, true, true, "initializing")).toEqual({
      ready: false,
      readyReason: "funding_initializing",
    });
  });

  test("bootstrap not started (idle) → not ready even when funded", () => {
    expect(computeReadiness(true, true, true, "idle")).toEqual({
      ready: false,
      readyReason: "funding_initializing",
    });
  });

  test("genesis ready but wallet unfunded → not ready", () => {
    expect(computeReadiness(true, true, false, "ready")).toEqual({
      ready: false,
      readyReason: "wallet_unfunded",
    });
  });

  test("genesis ready, bootstrap complete, wallet funded → ready", () => {
    expect(computeReadiness(true, true, true, "ready")).toEqual({
      ready: true,
      readyReason: "ready",
    });
  });
});
