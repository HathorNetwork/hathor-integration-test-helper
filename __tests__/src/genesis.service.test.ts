import { describe, test, expect } from "bun:test";
import {
  isGenesisReady,
  getGenesisWallet,
  getGenesisAddress,
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
