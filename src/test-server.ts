import { config } from "./config";

/** Detect the parallel worker index from Bun, Jest, or CI environment variables. */
function inferWorkerId(): number {
  const fromBun = process.env.BUN_WORKER_ID;
  const fromNode = process.env.JEST_WORKER_ID;
  const fromCi = process.env.CI_NODE_INDEX;

  const raw = fromBun ?? fromNode ?? fromCi;
  if (!raw) return 0;

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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

  for (let i = 0; i < maxFallbacks; i++) {
    const candidate = config.TEST_PORT_FALLBACK_START + ((baseOffset + i) % range);
    if (candidate === config.PORT) continue;
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Start a Bun.serve() instance for tests, trying an ephemeral port first
 * then falling back to deterministic per-worker ports.
 */
export function startTestServer(
  options: Record<string, unknown>,
): ReturnType<typeof Bun.serve> {
  const candidates = buildTestPortCandidates();
  let lastError: unknown = null;

  for (const port of candidates) {
    try {
      return Bun.serve({ ...(options as Record<string, unknown>), port } as any);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("Failed to start test server on fallback ports");
}
