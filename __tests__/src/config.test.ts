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

  // Plug-and-play guarantee for the dockerized helper: an image started with
  // NO env set must resolve the full set of hathor-wallet-lib-aligned network
  // defaults, so it Just Works against the Lib's integration stack.
  test("empty env yields the wallet-lib-aligned network defaults", () => {
    const cfg = loadConfig({}, noWarn);
    expect(cfg.NETWORK).toBe("testnet");
    expect(cfg.HATHOR_NODE_URL).toBe("http://localhost:8083/v1a/");
    expect(cfg.TX_MINING_URL).toBe("http://localhost:8035/");
    expect(cfg.GENESIS_SEED_WORDS.split(" ")).toHaveLength(24);
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
  });

  // Canonical value mirrors hathor-wallet-lib
  // __tests__/integration/configuration/test-constants.ts → WALLET_CONSTANTS.genesis.
  // Pinned independently here so a drift in the config default fails loudly.
  const LIB_GENESIS_SEED =
    "avocado spot town typical traffic vault danger century property shallow divorce festival spend attack anchor afford rotate green audit adjust fade wagon depart level";

  test("GENESIS_SEED_WORDS defaults to the wallet-lib genesis seed", () => {
    const cfg = loadConfig({}, noWarn);
    expect(cfg.GENESIS_SEED_WORDS).toBe(LIB_GENESIS_SEED);
    expect(cfg.GENESIS_SEED_WORDS.split(" ")).toHaveLength(24);
  });

  test("blank GENESIS_SEED_WORDS falls back to the default", () => {
    const cfg = loadConfig({ GENESIS_SEED_WORDS: "   " }, noWarn);
    expect(cfg.GENESIS_SEED_WORDS).toBe(LIB_GENESIS_SEED);
  });

  test("an explicit GENESIS_SEED_WORDS overrides the default", () => {
    const custom = "my own seed phrase";
    const cfg = loadConfig({ GENESIS_SEED_WORDS: custom }, noWarn);
    expect(cfg.GENESIS_SEED_WORDS).toBe(custom);
  });

  test("emits a using_default_secret warning when GENESIS_SEED_WORDS falls back", () => {
    const captured: ConfigWarning[] = [];
    loadConfig({}, { onWarning: (w) => captured.push(w) });
    expect(
      captured.some(
        (w) =>
          w.event === "config.using_default_secret" &&
          w.key === "GENESIS_SEED_WORDS",
      ),
    ).toBe(true);
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
        GENESIS_SEED_WORDS: "explicit seed",
      },
      { onWarning: (w) => captured.push(w) },
    );
    expect(captured).toHaveLength(0);
  });

  test("rejects unparseable HATHOR_NODE_URL at startup", () => {
    expect(() => loadConfig({ HATHOR_NODE_URL: "not a url" })).toThrow(
      ConfigError,
    );
  });

  test("rejects HATHOR_NODE_URL without an http(s) scheme", () => {
    // WHATWG URL parses "localhost:8083" with `localhost:` as scheme;
    // the http/https guard is what catches the missing protocol.
    expect(() => loadConfig({ HATHOR_NODE_URL: "localhost:8083" })).toThrow(
      ConfigError,
    );
  });

  test("rejects TX_MINING_URL with a non-http scheme", () => {
    expect(() =>
      loadConfig({ TX_MINING_URL: "ftp://miner.example/" }),
    ).toThrow(ConfigError);
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

  test("trims whitespace from numeric env values before validation", () => {
    const cfg = loadConfig({ PORT: "  3030  ", UTXO_SPLIT_AMOUNT: "  500\n" }, noWarn);
    expect(cfg.PORT).toBe(3030);
    expect(cfg.UTXO_SPLIT_AMOUNT).toBe(500n);
  });

  test("redacts default values for secret warnings", () => {
    const captured: ConfigWarning[] = [];
    loadConfig({}, { onWarning: (w) => captured.push(w) });
    const secrets = captured.filter(
      (w) => w.event === "config.using_default_secret",
    );
    expect(secrets.length).toBeGreaterThan(0);
    for (const w of secrets) {
      expect(w.defaultValue).toBeUndefined();
    }
  });

  test("keeps default values on URL warnings (informative, not secret)", () => {
    const captured: ConfigWarning[] = [];
    loadConfig({}, { onWarning: (w) => captured.push(w) });
    const urls = captured.filter((w) => w.event === "config.using_default_url");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((w) => typeof w.defaultValue === "string")).toBe(true);
  });

  // FUNDING_ENABLED gates whether the service initializes the genesis wallet
  // and attempts on-chain funding. It defaults to `true` because the primary
  // deployment is the hathor-wallet-lib integration stack (which has a
  // fullnode). The no-fullnode "wallet provider drop-in" opts out explicitly.
  test("FUNDING_ENABLED defaults to true on empty env", () => {
    const cfg = loadConfig({}, noWarn);
    expect(cfg.FUNDING_ENABLED).toBe(true);
  });

  test("FUNDING_ENABLED parses an explicit false", () => {
    expect(loadConfig({ FUNDING_ENABLED: "false" }, noWarn).FUNDING_ENABLED).toBe(
      false,
    );
    expect(loadConfig({ FUNDING_ENABLED: "0" }, noWarn).FUNDING_ENABLED).toBe(
      false,
    );
  });

  test("FUNDING_ENABLED parses an explicit true", () => {
    expect(loadConfig({ FUNDING_ENABLED: "true" }, noWarn).FUNDING_ENABLED).toBe(
      true,
    );
    expect(loadConfig({ FUNDING_ENABLED: "1" }, noWarn).FUNDING_ENABLED).toBe(
      true,
    );
  });

  test("FUNDING_ENABLED is case-insensitive and trims whitespace", () => {
    expect(loadConfig({ FUNDING_ENABLED: "  FALSE  " }, noWarn).FUNDING_ENABLED).toBe(
      false,
    );
    expect(loadConfig({ FUNDING_ENABLED: "True" }, noWarn).FUNDING_ENABLED).toBe(
      true,
    );
  });

  test("FUNDING_ENABLED rejects an unparseable value", () => {
    expect(() => loadConfig({ FUNDING_ENABLED: "maybe" })).toThrow(ConfigError);
  });

  test("GENESIS_SYNC_TIMEOUT_MS defaults to 120000", () => {
    expect(loadConfig({}, noWarn).GENESIS_SYNC_TIMEOUT_MS).toBe(120_000);
  });

  test("GENESIS_SYNC_TIMEOUT_MS parses an override", () => {
    expect(
      loadConfig({ GENESIS_SYNC_TIMEOUT_MS: "5000" }, noWarn).GENESIS_SYNC_TIMEOUT_MS,
    ).toBe(5000);
  });

  test("GENESIS_SYNC_TIMEOUT_MS rejects a sub-second value", () => {
    expect(() => loadConfig({ GENESIS_SYNC_TIMEOUT_MS: "500" })).toThrow(ConfigError);
  });

  // Wallet-generation-only mode (FUNDING_ENABLED=false) must not fail on
  // funding-only config — the fullnode endpoints are never used there.
  test("funding disabled skips fullnode URL validation", () => {
    expect(() =>
      loadConfig(
        {
          FUNDING_ENABLED: "false",
          HATHOR_NODE_URL: "not a url",
          TX_MINING_URL: "also bad",
        },
        noWarn,
      ),
    ).not.toThrow();
  });

  test("funding disabled emits no fullnode-URL default warnings", () => {
    const captured: ConfigWarning[] = [];
    loadConfig({ FUNDING_ENABLED: "false" }, { onWarning: (w) => captured.push(w) });
    expect(captured.some((w) => w.event === "config.using_default_url")).toBe(false);
  });

  test("funding enabled still validates fullnode URLs", () => {
    expect(() =>
      loadConfig({ FUNDING_ENABLED: "true", HATHOR_NODE_URL: "not a url" }),
    ).toThrow(ConfigError);
  });

  test("treats whitespace-only wallet credentials as fallback", () => {
    const captured: ConfigWarning[] = [];
    const cfg = loadConfig(
      {
        WALLET_PASSWORD: "   ",
        WALLET_PIN_CODE: "  ",
        GENESIS_SEED_WORDS: "explicit seed",
      },
      { onWarning: (w) => captured.push(w) },
    );
    expect(cfg.WALLET_PASSWORD).toBe("test-password");
    expect(cfg.WALLET_PIN_CODE).toBe("123456");
    expect(
      captured.filter((w) => w.event === "config.using_default_secret").length,
    ).toBe(2);
  });
});

