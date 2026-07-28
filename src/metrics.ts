/**
 * Per-route HTTP metrics plus UTXO-split counters. The fund and rescan
 * counters land alongside the /fund endpoint.
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
let splitCount = 0;
let splitFailures = 0;

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

/** Record a UTXO split attempt, incrementing successes or failures. */
export function recordSplit(success: boolean): void {
  if (success) {
    splitCount += 1;
    return;
  }
  splitFailures += 1;
}

export interface RouteSnapshot {
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface MetricsSnapshot {
  routes: Record<string, RouteSnapshot>;
  splitCount: number;
  splitFailures: number;
}

/** Point-in-time view of the per-route counters and split operations. */
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
  return { routes, splitCount, splitFailures };
}

/** Test-only: clear all per-route counters and split counters. */
export function __resetMetricsForTest(): void {
  routeMetrics = new Map();
  splitCount = 0;
  splitFailures = 0;
}
