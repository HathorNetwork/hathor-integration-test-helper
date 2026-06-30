import { describe, test, expect } from "bun:test";
import {
  isGenesisReady,
  getGenesisWallet,
  getGenesisAddress,
  waitUntilReady,
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
