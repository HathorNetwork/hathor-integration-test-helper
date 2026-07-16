import { describe, test, expect } from "bun:test";
import { computeReadiness } from "../../src/routes";

// Pure readiness branch logic — the heart of /ready and /status. Readiness is
// decoupled from the pool: the third input is whether the genesis *wallet*
// holds funds. Tested by passing inputs directly, which keeps it free of
// fullnode/config coupling.
describe("computeReadiness", () => {
  test("funding disabled is healthy regardless of genesis/funds", () => {
    expect(computeReadiness(false, false, false)).toEqual({
      ready: true,
      readyReason: "funding_disabled",
    });
  });

  test("funding enabled but genesis not ready → not ready", () => {
    expect(computeReadiness(true, false, true)).toEqual({
      ready: false,
      readyReason: "genesis_wallet_not_ready",
    });
  });

  test("genesis ready but wallet unfunded → not ready", () => {
    expect(computeReadiness(true, true, false)).toEqual({
      ready: false,
      readyReason: "wallet_unfunded",
    });
  });

  test("genesis ready and wallet funded → ready", () => {
    expect(computeReadiness(true, true, true)).toEqual({
      ready: true,
      readyReason: "ready",
    });
  });
});
