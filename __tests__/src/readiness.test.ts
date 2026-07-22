import { describe, test, expect } from "bun:test";
import { computeReadiness } from "../../src/routes";

// Pure readiness branch logic — the heart of /ready and /status. Readiness is
// decoupled from the pool: the third input is whether the genesis *wallet*
// holds funds. Tested by passing inputs directly, which keeps it free of
// fullnode/config coupling.
describe("computeReadiness", () => {
  test("funding disabled is healthy regardless of genesis/funds/degraded", () => {
    // Degraded flag deliberately true: the kill switch outranks everything —
    // a disabled service is intentionally healthy even if a previous funding
    // bootstrap degraded before the flag was flipped.
    expect(computeReadiness(false, false, false, true)).toEqual({
      ready: true,
      readyReason: "funding_disabled",
    });
  });

  test("funding enabled but genesis not ready → not ready", () => {
    expect(computeReadiness(true, false, true, false)).toEqual({
      ready: false,
      readyReason: "genesis_wallet_not_ready",
    });
  });

  test("degraded bootstrap → not ready even when the wallet is funded", () => {
    // The trap: a degraded split leaves the pool empty, but the genesis reward
    // can unlock on its own and flip walletFunded true. Without the degraded
    // gate this would report ready over an un-refillable empty pool.
    expect(computeReadiness(true, true, true, true)).toEqual({
      ready: false,
      readyReason: "funding_degraded",
    });
  });

  test("genesis-not-ready wins over degraded (more specific)", () => {
    expect(computeReadiness(true, false, false, true)).toEqual({
      ready: false,
      readyReason: "genesis_wallet_not_ready",
    });
  });

  test("genesis ready but wallet unfunded → not ready", () => {
    expect(computeReadiness(true, true, false, false)).toEqual({
      ready: false,
      readyReason: "wallet_unfunded",
    });
  });

  test("genesis ready and wallet funded → ready", () => {
    expect(computeReadiness(true, true, true, false)).toEqual({
      ready: true,
      readyReason: "ready",
    });
  });
});
