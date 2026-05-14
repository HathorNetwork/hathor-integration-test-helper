import { config } from "./config";
import { logger } from "./logger";

// Bun.serve is heavily overloaded; the discriminated union of options
// types collapses on spread, so we accept an opaque options object and
// let the caller (test harness) own its precise shape.
type ServeOptions = object;
type ServeFn = (options: ServeOptions) => ReturnType<typeof Bun.serve>;

/**
 * Detect the parallel worker index from `JEST_WORKER_ID` or
 * `CI_NODE_INDEX`. When a candidate env var is set but malformed, the
 * caller is warned (silent normalisation collapses every worker onto
 * port range 0, which defeats the whole point of a per-worker fallback).
 */
function inferWorkerId(): number {
  const fromNode = process.env.JEST_WORKER_ID;
  const fromCi = process.env.CI_NODE_INDEX;

  const raw = (fromNode ?? fromCi)?.trim();
  if (raw === undefined || raw === "") return 0;

  // parseInt would silently accept "1x" / "01foo" as 1 — collapsing every
  // worker onto the same port range. Require the entire string to be a
  // run of digits before parsing.
  if (!/^\d+$/.test(raw)) {
    logger.warn({
      event: "test_server.invalid_worker_id",
      meta: { raw, fallbackWorkerId: 0 },
    });
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  logger.warn({
    event: "test_server.invalid_worker_id",
    meta: { raw, fallbackWorkerId: 0, reason: "unsafe_integer" },
  });
  return 0;
}

/**
 * Preferred ports for test servers:
 * 1) ephemeral random port (0), then
 * 2) deterministic per-worker fallback ports that avoid production port 3020.
 */
export function buildTestPortCandidates(
  workerId = inferWorkerId(),
  maxFallbacks = 10,
): number[] {
  const candidates = [0];
  const range = config.TEST_PORT_FALLBACK_SPAN;
  const baseOffset = workerId % range;

  // Cap to `range` so we never emit duplicates: the modulo wraps at
  // `range`, and asking for more iterations than that would just retry
  // the same ports (extra log noise + slower startup).
  const effectiveMax = Math.min(maxFallbacks, range);
  for (let i = 0; i < effectiveMax; i++) {
    const candidate = config.TEST_PORT_FALLBACK_START + ((baseOffset + i) % range);
    if (candidate === config.PORT) continue;
    candidates.push(candidate);
  }

  return candidates;
}

function isAddressInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "EADDRINUSE"
  );
}

/**
 * Start a Bun.serve() instance for tests, trying an ephemeral port first
 * then falling back to deterministic per-worker ports. Only EADDRINUSE
 * errors are swallowed across iterations; any other error is rethrown
 * immediately so a malformed `options` (missing fetch handler, bad TLS
 * config, etc.) surfaces with its true cause instead of being masked
 * as "address in use" noise on a later candidate.
 *
 * The optional `serveFn` parameter lets tests inject a stubbed factory
 * without monkey-patching the Bun global.
 *
 * @throws The original EADDRINUSE error from the last candidate when
 *   every port is in use, with `{tried: [...]}` recorded on the error
 *   for diagnosis. Throws other errors unchanged.
 */
export function startTestServer(
  options: ServeOptions,
  serveFn: ServeFn = Bun.serve as ServeFn,
): ReturnType<typeof Bun.serve> {
  const candidates = buildTestPortCandidates();
  let lastError: unknown = null;
  const tried: number[] = [];

  for (const port of candidates) {
    try {
      return serveFn({ ...options, port });
    } catch (err) {
      if (!isAddressInUse(err)) {
        throw err;
      }
      tried.push(port);
      lastError = err;
      logger.warn({
        event: "test_server.port_in_use",
        meta: { port },
      });
    }
  }

  if (lastError instanceof Error) {
    (lastError as Error & { tried?: number[] }).tried = tried;
    throw lastError;
  }
  const exhausted = new Error(
    `Failed to start test server; every fallback port was EADDRINUSE: ${tried.join(", ")}`,
  ) as Error & { tried: number[] };
  exhausted.tried = tried;
  throw exhausted;
}
