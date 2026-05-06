import { describe, test, expect } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config";

describe("loadConfig", () => {
  test("loads defaults from empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.PORT).toBe(3020);
    expect(cfg.UTXO_SPLIT_AMOUNT).toBe(1000n);
    expect(cfg.UTXO_SPLIT_COUNT).toBe(100);
    expect(cfg.REFILL_THRESHOLD).toBe(10);
  });

  test("fails fast on invalid integer env", () => {
    expect(() =>
      loadConfig({
        PORT: "not-a-number",
      }),
    ).toThrow(ConfigError);
  });

  test("fails when refill threshold is not below split count", () => {
    expect(() =>
      loadConfig({
        UTXO_SPLIT_COUNT: "5",
        REFILL_THRESHOLD: "5",
      }),
    ).toThrow(ConfigError);
  });

  test("fails on invalid split amount format", () => {
    expect(() =>
      loadConfig({
        UTXO_SPLIT_AMOUNT: "10.5",
      }),
    ).toThrow(ConfigError);
  });
});

