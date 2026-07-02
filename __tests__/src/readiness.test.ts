import { describe, test, expect } from "bun:test";
import { computeReadiness } from "../../src/routes";
import type { PoolStats } from "../../src/utxo-pool.service";

const EMPTY_POOL: PoolStats = {
  testUtxos: 0,
  leftoverUtxos: 0,
  largeUtxoAmount: null,
};

const FUNDED_POOL: PoolStats = {
  testUtxos: 5,
  leftoverUtxos: 0,
  largeUtxoAmount: null,
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

  test("genesis ready and pool funded → ready", () => {
    expect(computeReadiness(true, true, FUNDED_POOL)).toEqual({
      ready: true,
      readyReason: "ready",
    });
  });

  test("a large UTXO alone (no split yet) still counts as ready", () => {
    const largeOnly: PoolStats = {
      testUtxos: 0,
      leftoverUtxos: 0,
      largeUtxoAmount: 1_000_000n,
    };
    expect(computeReadiness(true, true, largeOnly)).toEqual({
      ready: true,
      readyReason: "ready",
    });
  });
});
