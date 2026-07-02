/**
 * Runtime configuration for the Hathor Integration Test Helper.
 *
 * We validate all inputs at startup and fail fast with actionable errors
 * so CI jobs don't fail later with hard-to-debug runtime exceptions.
 *
 * Values that have safe local-development defaults (network endpoints
 * and test-only wallet credentials) are not required, but a structured
 * warning is emitted via `onWarning` whenever a default is taken so an
 * operator running this in CI can spot a missing override before the
 * first request goes out.
 */
import { logger } from "./logger";
export interface AppConfig {
  readonly SIMPLE_WALLET_CACHE_SIZE: number;
  readonly PORT: number;
  readonly NETWORK: "testnet";
  readonly ADDRESS_COUNT: number;
  /**
   * Genesis wallet seed. Defaults to hathor-wallet-lib's integration genesis
   * seed so the dockerized helper is plug-and-play for the Lib CI. Source of
   * truth: hathor-wallet-lib
   * `__tests__/integration/configuration/test-constants.ts` →
   * `WALLET_CONSTANTS.genesis`. Not consumed at runtime yet (funding is a
   * later milestone); defaulted now for forward-aligned deployment.
   */
  readonly GENESIS_SEED_WORDS: string;
  /**
   * Gates the funding subsystem: when `true` (the default), startup
   * initializes the genesis wallet and the service offers on-chain
   * funding. When `false`, genesis is never touched — the service runs
   * in wallet-generation-only mode (no fullnode required), which is how
   * the PrecalculatedWallets drop-in is deployed. Defaulting to `true`
   * targets the primary consumer: the hathor-wallet-lib integration
   * stack, which always has a fullnode available.
   */
  readonly FUNDING_ENABLED: boolean;
  /**
   * Upper bound (ms) on how long the genesis wallet may take to finish
   * syncing before the bootstrap gives up and transitions to `degraded`.
   * Guards against a fullnode that accepts the connection but never lets
   * the wallet reach `isReady()` (stalled sync, wrong network), which
   * would otherwise hang startup at `initializing` forever.
   */
  readonly GENESIS_SYNC_TIMEOUT_MS: number;
  readonly HATHOR_NODE_URL: string;
  readonly TX_MINING_URL: string;
  readonly TX_MIN_WEIGHT?: number;
  readonly UTXO_SPLIT_AMOUNT: bigint;
  readonly UTXO_SPLIT_COUNT: number;
  readonly REFILL_THRESHOLD: number;
  readonly FUND_TIMEOUT_MS: number;
  readonly OBSERVATION_TIMEOUT_MS: number;
  readonly MAX_REQUEST_BODY_BYTES: number;
  readonly WALLET_PASSWORD: string;
  readonly WALLET_PIN_CODE: string;
  readonly TEST_PORT_FALLBACK_START: number;
  readonly TEST_PORT_FALLBACK_SPAN: number;
}

export interface ConfigWarning {
  readonly event: "config.using_default_url" | "config.using_default_secret";
  readonly key: string;
  /**
   * Carried for `config.using_default_url` so operators see which URL
   * the service fell back to. Omitted for `config.using_default_secret`
   * — even test-only credentials shouldn't appear in CI logs.
   */
  readonly defaultValue?: string;
}

export interface LoadConfigOptions {
  readonly onWarning?: (warning: ConfigWarning) => void;
}

export class ConfigError extends Error {
  public readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

interface IntConstraint {
  min?: number;
  max?: number;
}

interface BigIntConstraint {
  min?: bigint;
  max?: bigint;
}

function parseIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
  issues: string[],
  constraints: IntConstraint = {},
): number {
  const raw = (env[key] ?? fallback).trim();
  if (!/^-?\d+$/.test(raw)) {
    issues.push(`${key} must be an integer, got "${raw}"`);
    return Number.NaN;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    issues.push(`${key} must be a safe integer, got "${raw}"`);
    return Number.NaN;
  }

  if (constraints.min !== undefined && parsed < constraints.min) {
    issues.push(`${key} must be >= ${constraints.min}, got ${parsed}`);
  }
  if (constraints.max !== undefined && parsed > constraints.max) {
    issues.push(`${key} must be <= ${constraints.max}, got ${parsed}`);
  }

  return parsed;
}

function parseBigIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
  issues: string[],
  constraints: BigIntConstraint = {},
): bigint {
  const raw = (env[key] ?? fallback).trim();
  if (!/^-?\d+$/.test(raw)) {
    issues.push(`${key} must be an integer string, got "${raw}"`);
    return 0n;
  }

  const parsed = BigInt(raw);
  if (constraints.min !== undefined && parsed < constraints.min) {
    issues.push(`${key} must be >= ${constraints.min}, got ${parsed}`);
  }
  if (constraints.max !== undefined && parsed > constraints.max) {
    issues.push(`${key} must be <= ${constraints.max}, got ${parsed}`);
  }

  return parsed;
}

function parseOptionalIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  issues: string[],
  constraints: IntConstraint = {},
): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return parseIntEnv(env, key, raw, issues, constraints);
}

/**
 * Parse a boolean env var. Accepts `true/false/1/0` (case-insensitive,
 * surrounding whitespace trimmed); an empty/unset value falls back to
 * `fallback`. Anything else is a hard config error — silently coercing a
 * typo'd `"flase"` to `true` would mask an operator's intent to disable
 * funding.
 */
function parseBoolEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
  issues: string[],
): boolean {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  issues.push(`${key} must be one of true/false/1/0, got "${raw}"`);
  return fallback;
}

function parseOptionalTrimmedString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parseOptionalUrl(
  env: NodeJS.ProcessEnv,
  key: string,
  issues: string[],
): string | undefined {
  const raw = parseOptionalTrimmedString(env, key);
  if (!raw) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.push(`${key} must be an absolute http(s) URL, got "${raw}"`);
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.push(`${key} must use http or https scheme, got "${raw}"`);
    return undefined;
  }
  return raw;
}

function defaultOnWarning(warning: ConfigWarning): void {
  const { event, ...rest } = warning;
  logger.warn({ event, meta: rest });
}

/**
 * Default genesis seed — kept byte-for-byte equal to hathor-wallet-lib's
 * integration genesis wallet so the dockerized helper boots plug-and-play
 * for the Lib CI. Canonical source: hathor-wallet-lib
 * `__tests__/integration/configuration/test-constants.ts` →
 * `WALLET_CONSTANTS.genesis`. If the Lib rotates this seed, update here.
 */
const GENESIS_SEED_WORDS_DEFAULT =
  "avocado spot town typical traffic vault danger century property shallow divorce festival spend attack anchor afford rotate green audit adjust fade wagon depart level";

export function loadConfig(
  env: NodeJS.ProcessEnv,
  options: LoadConfigOptions = {},
): AppConfig {
  const issues: string[] = [];
  const onWarning = options.onWarning ?? defaultOnWarning;

  const SIMPLE_WALLET_CACHE_SIZE = parseIntEnv(
    env,
    "SIMPLE_WALLET_CACHE_SIZE",
    "10",
    issues,
    { min: 1, max: 10_000 },
  );
  const PORT = parseIntEnv(env, "PORT", "3020", issues, {
    min: 1,
    max: 65_535,
  });
  const UTXO_SPLIT_AMOUNT = parseBigIntEnv(
    env,
    "UTXO_SPLIT_AMOUNT",
    "1000",
    issues,
    { min: 1n },
  );
  const UTXO_SPLIT_COUNT = parseIntEnv(
    env,
    "UTXO_SPLIT_COUNT",
    "100",
    issues,
    { min: 1, max: 254 },
  );
  const REFILL_THRESHOLD = parseIntEnv(
    env,
    "REFILL_THRESHOLD",
    "10",
    issues,
    { min: 0 },
  );
  const FUND_TIMEOUT_MS = parseIntEnv(
    env,
    "FUND_TIMEOUT_MS",
    "30000",
    issues,
    { min: 1000, max: 300_000 },
  );
  const OBSERVATION_TIMEOUT_MS = parseIntEnv(
    env,
    "OBSERVATION_TIMEOUT_MS",
    "30000",
    issues,
    { min: 1000, max: 300_000 },
  );
  const MAX_REQUEST_BODY_BYTES = parseIntEnv(
    env,
    "MAX_REQUEST_BODY_BYTES",
    "16384",
    issues,
    { min: 1024, max: 1_048_576 },
  );
  const TX_MIN_WEIGHT = parseOptionalIntEnv(env, "TX_MIN_WEIGHT", issues, {
    min: 1,
    max: 20,
  });
  const TEST_PORT_FALLBACK_START = parseIntEnv(
    env,
    "TEST_PORT_FALLBACK_START",
    "13020",
    issues,
    { min: 1025, max: 65_535 },
  );
  const TEST_PORT_FALLBACK_SPAN = parseIntEnv(
    env,
    "TEST_PORT_FALLBACK_SPAN",
    "1000",
    issues,
    { min: 1, max: 20_000 },
  );

  const portRangeEnd = TEST_PORT_FALLBACK_START + TEST_PORT_FALLBACK_SPAN - 1;
  if (portRangeEnd > 65_535) {
    issues.push(
      `TEST_PORT_FALLBACK_START + TEST_PORT_FALLBACK_SPAN - 1 must be <= 65535, got ${portRangeEnd}`,
    );
  }

  if (REFILL_THRESHOLD >= UTXO_SPLIT_COUNT) {
    issues.push(
      `REFILL_THRESHOLD (${REFILL_THRESHOLD}) must be < UTXO_SPLIT_COUNT (${UTXO_SPLIT_COUNT})`,
    );
  }

  const FUNDING_ENABLED = parseBoolEnv(env, "FUNDING_ENABLED", true, issues);

  const HATHOR_NODE_URL_DEFAULT = "http://localhost:8083/v1a/";
  const TX_MINING_URL_DEFAULT = "http://localhost:8035/";
  // The fullnode + tx-mining endpoints are funding-only. With funding
  // disabled they are never used, so we neither validate them (a malformed
  // leftover value must not block wallet-generation-only mode) nor warn about
  // defaults — `*_RAW` stays undefined and the warning block below is skipped.
  let HATHOR_NODE_URL_RAW: string | undefined;
  let TX_MINING_URL_RAW: string | undefined;
  if (FUNDING_ENABLED) {
    HATHOR_NODE_URL_RAW = parseOptionalUrl(env, "HATHOR_NODE_URL", issues);
    TX_MINING_URL_RAW = parseOptionalUrl(env, "TX_MINING_URL", issues);
  }
  const HATHOR_NODE_URL = HATHOR_NODE_URL_RAW || HATHOR_NODE_URL_DEFAULT;
  const TX_MINING_URL = TX_MINING_URL_RAW || TX_MINING_URL_DEFAULT;

  const WALLET_PASSWORD_RAW = parseOptionalTrimmedString(env, "WALLET_PASSWORD");
  const WALLET_PIN_CODE_RAW = parseOptionalTrimmedString(env, "WALLET_PIN_CODE");
  const WALLET_PASSWORD_DEFAULT = "test-password";
  const WALLET_PIN_CODE_DEFAULT = "123456";
  const WALLET_PASSWORD = WALLET_PASSWORD_RAW || WALLET_PASSWORD_DEFAULT;
  const WALLET_PIN_CODE = WALLET_PIN_CODE_RAW || WALLET_PIN_CODE_DEFAULT;

  const GENESIS_SEED_WORDS_RAW = parseOptionalTrimmedString(
    env,
    "GENESIS_SEED_WORDS",
  );
  const GENESIS_SEED_WORDS =
    GENESIS_SEED_WORDS_RAW || GENESIS_SEED_WORDS_DEFAULT;

  const GENESIS_SYNC_TIMEOUT_MS_DEFAULT = "120000";
  const GENESIS_SYNC_TIMEOUT_MS = parseIntEnv(
    env,
    "GENESIS_SYNC_TIMEOUT_MS",
    GENESIS_SYNC_TIMEOUT_MS_DEFAULT,
    issues,
    { min: 1000, max: 600_000 },
  );

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  if (FUNDING_ENABLED) {
    if (!HATHOR_NODE_URL_RAW) {
      onWarning({
        event: "config.using_default_url",
        key: "HATHOR_NODE_URL",
        defaultValue: HATHOR_NODE_URL_DEFAULT,
      });
    }
    if (!TX_MINING_URL_RAW) {
      onWarning({
        event: "config.using_default_url",
        key: "TX_MINING_URL",
        defaultValue: TX_MINING_URL_DEFAULT,
      });
    }
  }
  if (!WALLET_PASSWORD_RAW) {
    onWarning({
      event: "config.using_default_secret",
      key: "WALLET_PASSWORD",
    });
  }
  if (!WALLET_PIN_CODE_RAW) {
    onWarning({
      event: "config.using_default_secret",
      key: "WALLET_PIN_CODE",
    });
  }
  if (!GENESIS_SEED_WORDS_RAW) {
    onWarning({
      event: "config.using_default_secret",
      key: "GENESIS_SEED_WORDS",
    });
  }

  return {
    SIMPLE_WALLET_CACHE_SIZE,
    PORT,
    NETWORK: "testnet",
    ADDRESS_COUNT: 22,
    GENESIS_SEED_WORDS,
    FUNDING_ENABLED,
    GENESIS_SYNC_TIMEOUT_MS,
    HATHOR_NODE_URL,
    TX_MINING_URL,
    TX_MIN_WEIGHT,
    UTXO_SPLIT_AMOUNT,
    UTXO_SPLIT_COUNT,
    REFILL_THRESHOLD,
    FUND_TIMEOUT_MS,
    OBSERVATION_TIMEOUT_MS,
    MAX_REQUEST_BODY_BYTES,
    WALLET_PASSWORD,
    WALLET_PIN_CODE,
    TEST_PORT_FALLBACK_START,
    TEST_PORT_FALLBACK_SPAN,
  };
}

export const config: Readonly<AppConfig> = Object.freeze(loadConfig(process.env));
