/**
 * Per-route HTTP metrics plus funding-subsystem counters (fund, split,
 * rescan).
 *
 * The snapshot is exposed via `getMetricsSnapshot` so the `/metrics` route
 * handler and tests can read counters without reaching into module state
 * directly.
 */

interface RouteMetric {
  requests: number;
  errors: number;
  totalLatencyMs: number;
}

let routeMetrics = new Map<string, RouteMetric>();

// Funding-subsystem counters. Kept as module-level primitives (not a map)
// because the set is fixed and small; the /metrics snapshot exposes them
// alongside the per-route table.
let fundCount = 0;
let staleUtxoRescans = 0;
let splitCount = 0;
let splitFailures = 0;
let refillFailures = 0;

function getRouteMetric(route: string): RouteMetric {
  const existing = routeMetrics.get(route);
  if (existing) return existing;
  const fresh: RouteMetric = { requests: 0, errors: 0, totalLatencyMs: 0 };
  routeMetrics.set(route, fresh);
  return fresh;
}

/** Record one HTTP request: bumps the count, adds latency, flags errors. */
export function recordHttpRequest(
  route: string,
  status: number,
  latencyMs: number,
): void {
  const m = getRouteMetric(route);
  m.requests += 1;
  m.totalLatencyMs += latencyMs;
  if (status >= 400) m.errors += 1;
}

export interface RouteSnapshot {
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

/** Increment the successful fund transaction counter. */
export function recordFundSuccess(): void {
  fundCount += 1;
}

/** Record a UTXO split attempt, incrementing successes or failures. */
export function recordSplit(success: boolean): void {
  if (success) {
    splitCount += 1;
    return;
  }
  splitFailures += 1;
}

/**
 * Increment the pool-rescan counter.
 *
 * Counts every completed {@link rescanUtxoPool}, whatever triggered it. The
 * snapshot field is named `staleUtxoRescans` because a stale UTXO is currently
 * the only trigger; a second caller would make the name wrong, not the counter.
 */
export function recordRescan(): void {
  staleUtxoRescans += 1;
}

/**
 * Increment the background-refill failure counter.
 *
 * A refill can fail before `splitUtxo` is ever reached (the wallet query in
 * `reserveLargeFromWallet` throws), which `recordSplit(false)` would not see —
 * so the refill path counts its own failures rather than relying on the split's.
 */
export function recordRefillFailure(): void {
  refillFailures += 1;
}

export interface MetricsSnapshot {
  routes: Record<string, RouteSnapshot>;
  fundCount: number;
  staleUtxoRescans: number;
  splitCount: number;
  splitFailures: number;
  refillFailures: number;
}

/** Point-in-time view of the per-route counters and funding operations. */
export function getMetricsSnapshot(): MetricsSnapshot {
  const routes: MetricsSnapshot["routes"] = {};
  for (const [route, m] of routeMetrics.entries()) {
    routes[route] = {
      requests: m.requests,
      errors: m.errors,
      avgLatencyMs:
        m.requests === 0
          ? 0
          : Number((m.totalLatencyMs / m.requests).toFixed(2)),
    };
  }
  return {
    routes,
    fundCount,
    staleUtxoRescans,
    splitCount,
    splitFailures,
    refillFailures,
  };
}

/** Test-only: clear all per-route counters and funding counters. */
export function __resetMetricsForTest(): void {
  routeMetrics = new Map();
  fundCount = 0;
  staleUtxoRescans = 0;
  splitCount = 0;
  splitFailures = 0;
  refillFailures = 0;
}
