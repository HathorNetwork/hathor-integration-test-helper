import { describe, test, expect } from "bun:test";
import { handleStatus, handleReady, handleLive } from "../../src/routes";

/**
 * Wiring tests for the readiness/status/live handlers against the REAL
 * modules — no mocking. In the unit-test environment funding defaults on
 * (FUNDING_ENABLED) but the genesis wallet is never initialized, so the
 * service sits at `genesis_wallet_not_ready`. That exercises the full
 * handler path (status code, body shape, JSONBigInt serialization) without a
 * fullnode. Branch coverage for the other readiness states lives in the pure
 * computeReadiness tests.
 */
describe("readiness/status/live handlers (real modules)", () => {
  test("GET /ready is 503 genesis_wallet_not_ready before genesis syncs", async () => {
    const res = handleReady(new Request("http://localhost/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; readyReason: string };
    expect(body.ready).toBe(false);
    expect(body.readyReason).toBe("genesis_wallet_not_ready");
  });

  test("GET /status is 200 with the full envelope and null genesisAddress", async () => {
    const res = handleStatus(new Request("http://localhost/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("ready", false);
    expect(body).toHaveProperty("readyReason", "genesis_wallet_not_ready");
    expect(body).toHaveProperty("testUtxos", 0);
    expect(body).toHaveProperty("leftoverUtxos", 0);
    expect(body).toHaveProperty("largeUtxoAmount", null);
    expect(body.genesisAddress).toBeNull();
    const startup = body.startup as { phase: string };
    expect(typeof startup.phase).toBe("string");
  });

  test("GET /live is always 200 live:true", async () => {
    const res = handleLive(new Request("http://localhost/live"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: boolean };
    expect(body.live).toBe(true);
  });
});
