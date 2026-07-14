import { describe, test, expect } from "bun:test";
import { computeReadiness } from "../../src/routes";
import type { PoolStats } from "../../src/utxo-pool.service";

const EMPTY_POOL: PoolStats = {
  testUtxos: 0,
};

const FUNDED_POOL: PoolStats = {
  testUtxos: 5,
};

// Pure readiness branch logic — the heart of /ready and /status. Tested by
// passing inputs directly, which keeps it free of fullnode/config coupling.
describe("computeReadiness", () => {
  test("funding disabled is healthy regardless of genesis/pool", () => {
    expect(computeReadiness(false, false, EMPTY_POOL)).toEqual({
      ready: true,
      readyReason: "funding_disabled",
    });
  });

  test("funding enabled but genesis not ready → not ready", () => {
    expect(computeReadiness(true, false, FUNDED_POOL)).toEqual({
      ready: false,
      readyReason: "genesis_wallet_not_ready",
    });
  });

  test("genesis ready but pool empty → not ready", () => {
    expect(computeReadiness(true, true, EMPTY_POOL)).toEqual({
      ready: false,
      readyReason: "utxo_pool_empty",
    });
  });

  test("genesis ready and test pool funded → ready", () => {
    expect(computeReadiness(true, true, FUNDED_POOL)).toEqual({
      ready: true,
      readyReason: "ready",
    });
  });
});
