import { describe, test, expect } from "bun:test";
import { ConfigError, loadConfig, type ConfigWarning } from "../../src/config";

const noWarn = { onWarning: () => {} };

describe("loadConfig", () => {
  test("loads defaults from empty env", () => {
    const cfg = loadConfig({}, noWarn);
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

  test("aggregates multiple issues before throwing", () => {
    let caught: ConfigError | undefined;
    try {
      loadConfig({
        PORT: "abc",
        UTXO_SPLIT_AMOUNT: "1.5",
        UTXO_SPLIT_COUNT: "3",
        REFILL_THRESHOLD: "5",
      });
    } catch (err) {
      caught = err as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const issues = caught!.issues;
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.some((i) => i.includes("PORT"))).toBe(true);
    expect(issues.some((i) => i.includes("UTXO_SPLIT_AMOUNT"))).toBe(true);
    expect(issues.some((i) => i.includes("REFILL_THRESHOLD"))).toBe(true);
  });

  test("treats empty/whitespace optional env as absent", () => {
    const cfg = loadConfig({ TX_MIN_WEIGHT: "" }, noWarn);
    expect(cfg.TX_MIN_WEIGHT).toBeUndefined();

    const cfg2 = loadConfig({ TX_MIN_WEIGHT: "   " }, noWarn);
    expect(cfg2.TX_MIN_WEIGHT).toBeUndefined();

    const cfg3 = loadConfig({ GENESIS_SEED_WORDS: "   " }, noWarn);
    expect(cfg3.GENESIS_SEED_WORDS).toBeUndefined();
  });

  test("garbage in optional env still surfaces as a parse failure", () => {
    expect(() => loadConfig({ TX_MIN_WEIGHT: "abc" })).toThrow(ConfigError);
  });

  test("emits a warning when HATHOR_NODE_URL falls back to default", () => {
    const captured: ConfigWarning[] = [];
    const cfg = loadConfig({}, { onWarning: (w) => captured.push(w) });
    expect(cfg.HATHOR_NODE_URL).toBe("http://localhost:8083/v1a/");
    expect(
      captured.some(
        (w) =>
          w.event === "config.using_default_url" && w.key === "HATHOR_NODE_URL",
      ),
    ).toBe(true);
  });

  test("does not warn when URLs are supplied", () => {
    const captured: ConfigWarning[] = [];
    loadConfig(
      {
        HATHOR_NODE_URL: "http://node.example/v1a/",
        TX_MINING_URL: "http://miner.example/",
        WALLET_PASSWORD: "explicit",
        WALLET_PIN_CODE: "explicit",
      },
      { onWarning: (w) => captured.push(w) },
    );
    expect(captured).toHaveLength(0);
  });

  test("warns when wallet credentials fall back to test defaults", () => {
    const captured: ConfigWarning[] = [];
    loadConfig({}, { onWarning: (w) => captured.push(w) });
    expect(
      captured.some(
        (w) =>
          w.event === "config.using_default_secret" &&
          w.key === "WALLET_PASSWORD",
      ),
    ).toBe(true);
    expect(
      captured.some(
        (w) =>
          w.event === "config.using_default_secret" &&
          w.key === "WALLET_PIN_CODE",
      ),
    ).toBe(true);
  });

  test("treats whitespace-only wallet credentials as fallback", () => {
    const captured: ConfigWarning[] = [];
    const cfg = loadConfig(
      { WALLET_PASSWORD: "   ", WALLET_PIN_CODE: "  " },
      { onWarning: (w) => captured.push(w) },
    );
    expect(cfg.WALLET_PASSWORD).toBe("test-password");
    expect(cfg.WALLET_PIN_CODE).toBe("123456");
    expect(
      captured.filter((w) => w.event === "config.using_default_secret").length,
    ).toBe(2);
  });
});

