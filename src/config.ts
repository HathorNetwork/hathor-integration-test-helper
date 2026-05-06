/**
 * Runtime configuration for the Hathor Integration Test Helper.
 *
 * We validate all inputs at startup and fail fast with actionable errors
 * so CI jobs don't fail later with hard-to-debug runtime exceptions.
 */
export interface AppConfig {
  SIMPLE_WALLET_CACHE_SIZE: number;
  PORT: number;
  NETWORK: "testnet";
  ADDRESS_COUNT: number;
  GENESIS_SEED_WORDS?: string;
  HATHOR_NODE_URL: string;
  TX_MINING_URL: string;
  TX_MIN_WEIGHT?: number;
  UTXO_SPLIT_AMOUNT: bigint;
  UTXO_SPLIT_COUNT: number;
  REFILL_THRESHOLD: number;
  FUND_TIMEOUT_MS: number;
  OBSERVATION_TIMEOUT_MS: number;
  MAX_REQUEST_BODY_BYTES: number;
  WALLET_PASSWORD: string;
  WALLET_PIN_CODE: string;
  TEST_PORT_FALLBACK_START: number;
  TEST_PORT_FALLBACK_SPAN: number;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`
    );
    this.name = "ConfigError";
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
  const raw = env[key] ?? fallback;
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
  const raw = env[key] ?? fallback;
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
  if (env[key] === undefined || env[key] === "") {
    return undefined;
  }
  return parseIntEnv(env, key, env[key]!, issues, constraints);
}

function parseOptionalTrimmedString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const issues: string[] = [];

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

  const HATHOR_NODE_URL = (env.HATHOR_NODE_URL || "http://localhost:8083/v1a/").trim();
  const TX_MINING_URL = (env.TX_MINING_URL || "http://localhost:8035/").trim();

  if (!HATHOR_NODE_URL) {
    issues.push("HATHOR_NODE_URL must not be empty");
  }
  if (!TX_MINING_URL) {
    issues.push("TX_MINING_URL must not be empty");
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    SIMPLE_WALLET_CACHE_SIZE,
    PORT,
    NETWORK: "testnet",
    ADDRESS_COUNT: 22,
    GENESIS_SEED_WORDS: parseOptionalTrimmedString(env, "GENESIS_SEED_WORDS"),
    HATHOR_NODE_URL,
    TX_MINING_URL,
    TX_MIN_WEIGHT,
    UTXO_SPLIT_AMOUNT,
    UTXO_SPLIT_COUNT,
    REFILL_THRESHOLD,
    FUND_TIMEOUT_MS,
    OBSERVATION_TIMEOUT_MS,
    MAX_REQUEST_BODY_BYTES,
    WALLET_PASSWORD: env.WALLET_PASSWORD || "test-password",
    WALLET_PIN_CODE: env.WALLET_PIN_CODE || "123456",
    TEST_PORT_FALLBACK_START,
    TEST_PORT_FALLBACK_SPAN,
  };
}

export const config: Readonly<AppConfig> = Object.freeze(loadConfig(process.env));
